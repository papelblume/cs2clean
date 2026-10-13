// The csst.at fallback: scrapes a player's Leetify stats from csst.at with Ulixee Hero when Leetify's public
// API has no profile for them.
//
// Hero can't run inside the app. It needs better-sqlite3 (a native module) built for the Node it runs under, and
// electron-builder rebuilds native modules for Electron's own ABI. So Hero lives in a sidecar folder, hero-runtime/,
// with its own package.json, installed with Node 22, and the app starts it as a child process with a Node 22 of
// its own:
//
//   packaged app   <resources>/hero/        cli.js, node_modules/, bin/node(.exe)  (electron-builder extraResources)
//   source build   <repo>/hero-runtime/     the same, from `npm run hero:install` and `npm run build`
//
// Everything in that folder is outside app.asar on purpose: a Node that isn't Electron can't read inside an asar.
//
// Nothing here may fail silently. Every way the fallback can break ends as a HeroStatus with a problem kind and a
// reason in plain words. It is logged (console, and hero.log in the app's data folder) and handed back to the
// caller, which shows it in the window. See classifyHeroFailure().
//
// Overrides (mostly for source builds and tests):
//   CS2CLEAN_HERO_DIR   the sidecar folder
//   CS2CLEAN_NODE22     the Node 22 binary to run it with
//   CS2CLEAN_DATA_DIR   where hero.log, the Chrome download and the cat shim go when the app didn't say (configureHero)

import { execFile, spawn, type ChildProcess } from "child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import type { LeetifyProfile } from "./leetify";
import { debug, warn } from "./logger";

export { parseCsstAtHtml } from "./csst-parse";

// ------------------------------------------------------------------ status

export type HeroProblem =
  /** The sidecar folder isn't there (not installed with this build, or `npm run hero:install` wasn't run). */
  | "no-runtime"
  /** No Node 22 to run it with. */
  | "no-node"
  /** The OS refused to start Node (ENOENT, EACCES...). */
  | "spawn-failed"
  /** A folder the app writes to for it (data dir, shim) couldn't be used (ENOTDIR, EACCES...). */
  | "setup-failed"
  /** A native module was built for another Node version (NODE_MODULE_VERSION mismatch). */
  | "abi-mismatch"
  /** A native module wouldn't load for another reason (wrong platform, missing system library). */
  | "native-load"
  /** A JavaScript module is missing. */
  | "module-missing"
  /** Chrome, which Hero drives, isn't installed and couldn't be downloaded. */
  | "browser-missing"
  /** csst.at didn't answer. */
  | "site-unreachable"
  | "timeout"
  | "crashed"
  /** The CLI ended without a result. */
  | "bad-output";

export interface HeroStatus {
  state: "ready" | "unavailable";
  problem: HeroProblem | null;
  /** What happened, in plain words, for the window. Null when ready. */
  reason: string | null;
  /** The raw error text behind it, for the log. */
  detail: string | null;
}

export const HERO_READY: HeroStatus = { state: "ready", problem: null, reason: null, detail: null };

function unavailable(problem: HeroProblem, reason: string, detail: string | null = null): HeroStatus {
  return { state: "unavailable", problem, reason, detail };
}

/** What a lobby lookup gets back: the profiles that were found, and whether the fallback itself worked. */
export interface HeroScrape {
  profiles: Map<string, LeetifyProfile>;
  status: HeroStatus;
  /**
   * Players csst.at failed to answer for (a request that threw, or an HTTP error other than "not found") while it did
   * answer for others, with what went wrong. Not the same as having no data on them: they are worth asking again.
   */
  failed?: ReadonlyMap<string, string>;
}

/** The fallback failed in a way nobody planned for (a bug here). Still a status, never an exception. */
export function unexpectedHeroFailure(e: unknown): HeroStatus {
  const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
  return reported(unavailable("crashed", `The csst.at fallback hit an unexpected error: ${firstLine(text)}`, text));
}

// ------------------------------------------------------------------ configuration

let dataDirOverride: string | null = null;

/** The app's data folder (userData). hero.log, the Chrome download and the cat shim go under it. */
export function configureHero(o: { dataDir: string }): void {
  dataDirOverride = o.dataDir;
}

function dataDir(): string {
  return dataDirOverride ?? process.env.CS2CLEAN_DATA_DIR ?? join(tmpdir(), "cs2clean-hero");
}

const NODE_EXE = process.platform === "win32" ? "node.exe" : "node";

/** The sidecar folder: the one named by CS2CLEAN_HERO_DIR, the packaged one, or the one in a source checkout. */
export function findHeroDir(): string | null {
  // An override is the only candidate: falling back to another folder would hide that it points at the wrong place.
  const forced = process.env.CS2CLEAN_HERO_DIR;
  if (forced) return existsSync(join(forced, "cli.js")) ? forced : null;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resources ? join(resources, "hero") : undefined,
    join(__dirname, "..", "..", "hero-runtime"), // dist/main -> the repo root (inside app.asar when packaged, so never matches there)
  ];
  for (const c of candidates) if (c && existsSync(join(c, "cli.js"))) return c;
  return null;
}

/** The newest `v22.*` folder in `dir` that has `bin` inside, e.g. nvm's ~/.nvm/versions/node. */
function newestV22(dir: string, binPath: string[]): string | null {
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .filter((v) => v.startsWith("v22."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse();
  for (const v of versions) {
    const bin = join(dir, v, ...binPath);
    if (existsSync(bin)) return bin;
  }
  return null;
}

function nvmNode22(): string | null {
  if (process.platform === "win32") {
    // nvm-windows: %NVM_HOME%\v22.x.y\node.exe
    return process.env.NVM_HOME ? newestV22(process.env.NVM_HOME, ["node.exe"]) : null;
  }
  const home = process.env.HOME || "";
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  return newestV22(join(nvmDir, "versions", "node"), ["bin", "node"]);
}

/** "node" from PATH, if it is Node 22. */
function pathNode22(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("node", ["-p", "process.versions.node"], { timeout: 5000, windowsHide: true }, (err, out) => {
      resolve(!err && String(out).trim().startsWith("22.") ? "node" : null);
    });
  });
}

const NO_NODE_HELP =
  "Node 22 wasn't found. Released builds carry their own; for a source build install Node 22 (nvm install 22) " +
  "or point CS2CLEAN_NODE22 at its node binary.";

async function resolveNode(heroDir: string): Promise<{ node: string } | { status: HeroStatus }> {
  const forced = process.env.CS2CLEAN_NODE22;
  if (forced) {
    return existsSync(forced)
      ? { node: forced }
      : { status: unavailable("no-node", `CS2CLEAN_NODE22 points at a file that doesn't exist: ${forced}`) };
  }
  const bundled = join(heroDir, "bin", NODE_EXE);
  if (existsSync(bundled)) return { node: bundled };
  const found = nvmNode22() ?? (await pathNode22());
  return found ? { node: found } : { status: unavailable("no-node", NO_NODE_HELP) };
}

/**
 * The environment the CLI runs in. Hero's Chrome goes under the app's data folder, so nothing is written next to
 * the program. On Mint, Hero crashes on `cat /etc/upstream-release` (a folder there), so `cat` gets a shim that
 * always succeeds; it calls the real cat by absolute path (a shim that calls `cat` by name would call itself).
 */
function prepareEnv(): { env: NodeJS.ProcessEnv } | { status: HeroStatus } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.BROWSERS_DIR ??= join(dataDir(), "hero-browsers");
  try {
    if (process.platform === "linux" && existsSync("/etc/upstream-release") && statSync("/etc/upstream-release").isDirectory()) {
      const shimDir = join(dataDir(), "hero-shim");
      mkdirSync(shimDir, { recursive: true });
      const cat = join(shimDir, "cat");
      writeFileSync(cat, '#!/bin/sh\n/bin/cat "$@" 2>/dev/null\nexit 0\n');
      chmodSync(cat, 0o755);
      env.PATH = `${shimDir}${delimiter}${env.PATH ?? ""}`;
      debug("hero", "cat shim ready in", shimDir);
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { status: unavailable("setup-failed", `Couldn't prepare the fallback's folder under ${dataDir()} (${err.code ?? "error"}).`, String(e)) };
  }
  return { env };
}

// ------------------------------------------------------------------ running the CLI

/** stdout is not clean: Hero Core prints its own lines. The result is one JSON line, so scan from the end. */
function extractResponse(stdout: string): CliResponse | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object" && ("type" in parsed || "error" in parsed)) return parsed as CliResponse;
    } catch {
      // Not our JSON line, keep looking.
    }
  }
  return null;
}

interface ScrapeResponse {
  type: "scrape";
  data: Record<string, LeetifyProfile | null>;
  /** Set when csst.at itself couldn't be opened. */
  navigationError?: string | null;
  /** Players whose request threw (as opposed to csst.at having no data for them). */
  errors?: Record<string, string>;
}
interface SelftestResponse {
  type: "selftest";
  ok: boolean;
  node: string;
  abi: string;
  sqlite: string;
  browser: "installed" | "installed-now" | "missing";
}
interface ErrorResponse {
  error: string;
  /** Which part of the CLI's setup failed: "sqlite", "hero" or "browser". */
  stage?: string;
}
type CliResponse = ScrapeResponse | SelftestResponse | ErrorResponse;

interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

const KEEP = 256 * 1024; // the tail of each stream is enough to classify and to log

/**
 * Stops the CLI and the Chrome it started. The CLI closes Chrome itself on SIGTERM; if it hasn't finished after
 * a few seconds the whole process group gets SIGKILL (the CLI is started as a group leader for this). Windows has
 * no process groups, so taskkill takes the tree.
 */
function stopTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  }, 5000).unref();
}

function runCli(node: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<CliRun> {
  return new Promise((resolve) => {
    debug("hero", "Spawn:", node, args, "timeout:", timeoutMs);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const run: CliRun = { code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: null };
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...run, stdout, stderr, timedOut });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(node, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    } catch (e) {
      // spawn() throws for a bad argument; a missing or unrunnable file arrives as an "error" event instead.
      run.spawnError = e as NodeJS.ErrnoException;
      return finish();
    }
    timer = setTimeout(() => {
      timedOut = true;
      stopTree(child);
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      stdout = (stdout + text).slice(-KEEP);
      debug("hero", "▶", text.trim());
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-KEEP);
      debug("hero", "stderr:", text.trim());
    });
    child.on("error", (e) => {
      run.spawnError = e as NodeJS.ErrnoException;
      finish();
    });
    child.on("close", (code, signal) => {
      run.code = code;
      run.signal = signal;
      finish();
    });
  });
}

// ------------------------------------------------------------------ failures

export interface HeroFailureInput {
  code: number | null;
  signal?: string | null;
  timedOut?: boolean;
  spawnError?: { code?: string; message: string } | null;
  stdout?: string;
  stderr?: string;
  /** The Node binary that was started, for the message. */
  node?: string;
}

const firstLine = (s: string): string => (s.split(/\r?\n/).find((l) => l.trim()) ?? s).trim().slice(0, 200);
const tail = (s: string, n: number): string => (s.length > n ? "…" + s.slice(-n) : s);

/**
 * Turns "the sidecar didn't produce a result" into one of the HeroProblem kinds, from whatever evidence there is:
 * the OS's error for starting Node, a timeout, the CLI's own JSON error, or the raw text of Node's crash.
 */
export function classifyHeroFailure(i: HeroFailureInput): HeroStatus {
  const stdout = i.stdout ?? "";
  const stderr = i.stderr ?? "";
  const json = extractResponse(stdout);
  const cliError = json && "error" in json ? json : null;
  const text = [cliError?.error, stderr, stdout].filter(Boolean).join("\n").trim();
  const detail = tail(text || i.spawnError?.message || "", 2000) || null;

  if (i.spawnError) {
    const code = i.spawnError.code ?? "error";
    const what = i.node ? ` (${i.node})` : "";
    if (code === "ENOENT") return unavailable("spawn-failed", `Couldn't start Node 22${what}: the file isn't there (ENOENT).`, i.spawnError.message);
    if (code === "EACCES" || code === "EPERM") return unavailable("spawn-failed", `Couldn't start Node 22${what}: not allowed to run it (${code}).`, i.spawnError.message);
    return unavailable("spawn-failed", `Couldn't start Node 22${what}: ${code}.`, i.spawnError.message);
  }
  if (i.timedOut) return unavailable("timeout", "The csst.at fallback took too long and was stopped.", detail);

  // better-sqlite3 built for another Node: "…was compiled against a different Node.js version using
  // NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137."
  const abi = /NODE_MODULE_VERSION\s+(\d+)[\s\S]*?NODE_MODULE_VERSION\s+(\d+)/.exec(text);
  if (abi)
    return unavailable("abi-mismatch",
      `A native module was built for a different Node version (module ABI ${abi[1]}; the Node that runs it needs ${abi[2]}). ` +
      "Reinstall the sidecar with Node 22 (npm run hero:install).", detail);
  if (/ERR_DLOPEN_FAILED|invalid ELF header|not a valid Win32 application|cannot open shared object file|GLIBC[A-Z_]*_[\d.]+['`]? not found/i.test(text))
    return unavailable("native-load", `A native module couldn't be loaded on this system: ${firstLine(text)}`, detail);
  const missing = /Cannot find module '([^']+)'/.exec(text);
  if (missing)
    return unavailable("module-missing",
      `A file the fallback needs is missing: ${missing[1]}. Released builds include it; in a source checkout run npm run hero:install.`, detail);
  // Only the CLI's own "browser" stage counts: chrome-app prints "Chrome … is already installed" in healthy runs,
  // so matching on the word Chrome in a crash log would blame the wrong thing.
  if (cliError?.stage === "browser")
    return unavailable("browser-missing", `Chrome, which the fallback drives, isn't installed and couldn't be downloaded: ${firstLine(cliError.error)}`, detail);
  const fsErr = /\b(ENOTDIR|EACCES|EPERM|EROFS|ENOSPC|EEXIST|ENOENT)\b/.exec(text);
  if (fsErr) return unavailable("setup-failed", `The fallback couldn't use a file or folder it needs (${fsErr[1]}).`, detail);
  if (i.code === 0) return unavailable("bad-output", "The csst.at fallback ended without giving a result.", detail);
  const how = i.signal ? `signal ${i.signal}` : `exit code ${i.code}`;
  return unavailable("crashed", `The csst.at fallback stopped unexpectedly (${how}).`, detail);
}

// ------------------------------------------------------------------ reporting

const LOG_LIMIT = 200_000;
let lastReported = "";
const listeners = new Set<(status: HeroStatus) => void>();

/**
 * Calls `fn` whenever the fallback's status changes: after the start-up check, a lookup, or the Chrome download
 * that finishes in the background. The window follows it. Returns a function that stops listening.
 */
export function onHeroStatus(fn: (status: HeroStatus) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function writeLog(text: string): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    const file = join(dataDir(), "hero.log");
    if (existsSync(file) && statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`);
    appendFileSync(file, text + "\n");
  } catch {
    // Nowhere to report a failure to write the log; the console line below still happened.
  }
}

/** Logs a status the first time it changes (console, and hero.log in the data folder) and returns it unchanged. */
function reported(status: HeroStatus): HeroStatus {
  const key = `${status.state}:${status.problem}:${status.reason}`;
  if (key === lastReported) return status;
  const recovered = status.state === "ready" && lastReported.startsWith("unavailable:");
  lastReported = key;
  if (status.state === "unavailable") {
    warn("hero", `${status.problem}: ${status.reason}`);
    if (status.detail) warn("hero", status.detail);
    writeLog(`${new Date().toISOString()} [${status.problem}] ${status.reason}` +
      (status.detail ? "\n" + status.detail.split("\n").map((l) => "    " + l).join("\n") : ""));
  } else if (recovered) {
    writeLog(`${new Date().toISOString()} [ok] the csst.at fallback is working`);
  }
  for (const fn of listeners) {
    try {
      fn(status);
    } catch (e) {
      warn("hero", "a status listener threw:", e);
    }
  }
  return status;
}

// ------------------------------------------------------------------ the sidecar's lifecycle

interface Runtime {
  dir: string;
  node: string;
  env: NodeJS.ProcessEnv;
  /** Chrome is known to be installed (the first scrape downloads it when it isn't). */
  browserReady: boolean;
}

const RETRY_AFTER_MS = 60_000;
let runtime: Runtime | null = null;
let failure: { status: HeroStatus; at: number } | null = null;
let chain: Promise<unknown> = Promise.resolve();
/** The first-use Chrome download, while it runs in the background. */
let preparing: Promise<void> | null = null;

/** For tests: forget everything learned about the sidecar. */
export function resetHeroState(): void {
  runtime = null;
  failure = null;
  lastReported = "";
  chain = Promise.resolve();
  preparing = null;
}

/**
 * The first-use Chrome download is still running. Judged by Chrome itself, not only by the `preparing` promise:
 * that one is cleared a few microtasks after the download is reported finished, and a lookup landing in that gap
 * would be told to wait for something that is already done.
 */
const downloading = (): boolean => preparing !== null && !runtime?.browserReady;

const settingUp = (): HeroStatus =>
  unavailable("browser-missing", "Setting up the csst.at fallback: downloading Chrome, this one time. It works from the next lookup on.");

/**
 * Downloads Chrome (370 MB on disk for Chrome 139, minutes on a slow line) without holding up a lobby lookup: the lookup that
 * needs it gets "setting up" and carries on, and the status changes to ready (or to the reason it failed) when
 * the download ends.
 */
function prepareBrowser(): void {
  if (preparing) return;
  preparing = ensureRuntime(true)
    .then(() => undefined)
    .catch((e) => void unexpectedHeroFailure(e))
    .finally(() => {
      preparing = null;
    });
}

/** One at a time, so a lobby lookup and the start-up check don't both start the same setup. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * Finds the sidecar and Node 22, and runs the CLI's selftest (Hero and better-sqlite3 load, Chrome is there; with
 * `browser`, Chrome is downloaded when it isn't). Success is remembered; a failure is remembered for a minute, so
 * a lobby that keeps asking doesn't start Node every time.
 */
function ensureRuntime(browser: boolean): Promise<{ rt: Runtime } | { status: HeroStatus }> {
  return serial(async () => {
    if (runtime && (!browser || runtime.browserReady)) return { rt: runtime };
    if (failure && Date.now() - failure.at < RETRY_AFTER_MS) return { status: failure.status };

    const fail = (status: HeroStatus) => {
      runtime = null;
      failure = { status: reported(status), at: Date.now() };
      return { status: failure.status };
    };

    const dir = findHeroDir();
    if (!dir)
      return fail(unavailable("no-runtime",
        "The csst.at fallback isn't part of this build (its hero-runtime folder is missing). From a source checkout, run npm run hero:install and npm run build."));
    const n = await resolveNode(dir);
    if ("status" in n) return fail(n.status);
    const e = prepareEnv();
    if ("status" in e) return fail(e.status);

    const args = [join(dir, "cli.js"), "selftest", ...(browser ? ["--ensure-browser"] : [])];
    // Downloading Chrome can take minutes on a slow line.
    const run = await runCli(n.node, args, e.env, dir, browser ? 10 * 60_000 : 60_000);
    const res = extractResponse(run.stdout);
    if (!run.spawnError && !run.timedOut && run.code === 0 && res && "type" in res && res.type === "selftest" && res.ok) {
      debug("hero", "selftest ok:", res);
      failure = null;
      runtime = { dir, node: n.node, env: e.env, browserReady: res.browser !== "missing" };
      // "Ready" means it can scrape. With Chrome still to download it can't yet: say nothing now, so the window
      // doesn't flip from OK to "setting up" a moment later. The first lookup that needs it reports the download.
      if (runtime.browserReady) reported(HERO_READY);
      return { rt: runtime };
    }
    return fail(classifyHeroFailure({ ...run, node: n.node }));
  });
}

/**
 * Start-up check, with no scraping and no download: is the sidecar there, does Node 22 start it, do Hero and
 * better-sqlite3 load? Lets the window say "fallback unavailable" before a lookup needs it.
 */
export async function checkHeroRuntime(): Promise<HeroStatus> {
  try {
    if (downloading()) return settingUp();
    const r = await ensureRuntime(false);
    return "rt" in r ? HERO_READY : r.status;
  } catch (e) {
    return unexpectedHeroFailure(e);
  }
}

/**
 * Scrapes csst.at for the given players. Always resolves: `profiles` holds the players it found, `status` says
 * whether the fallback itself worked, and when it didn't, why.
 */
export async function scrapeCsstAtProfiles(steamIds: string[], delayMs = 1000): Promise<HeroScrape> {
  const profiles = new Map<string, LeetifyProfile>();
  if (steamIds.length === 0) return { profiles, status: HERO_READY };
  try {
    // Never queue behind a Chrome download: that would hold the whole lobby for as long as it takes.
    if (downloading()) return { profiles, status: settingUp() };
    const r = await ensureRuntime(false);
    if (!("rt" in r)) return { profiles, status: r.status };
    if (!r.rt.browserReady) {
      prepareBrowser();
      return { profiles, status: reported(settingUp()) };
    }
    const rt = r.rt;

    const args = [join(rt.dir, "cli.js"), "scrape", `--delay=${delayMs}`, ...steamIds];
    // Time for Hero's start-up and navigation, plus a fetch and the delay per player.
    const timeoutMs = 120_000 + steamIds.length * (delayMs + 5_000);
    const run = await runCli(rt.node, args, rt.env, rt.dir, timeoutMs);
    const res = extractResponse(run.stdout);

    if (!run.spawnError && !run.timedOut && run.code === 0 && res && "type" in res && res.type === "scrape") {
      for (const [id, profile] of Object.entries(res.data)) if (profile) profiles.set(id, profile);
      debug("hero", "Parsed", profiles.size, "of", Object.keys(res.data).length, "profiles");
      const errors = Object.entries(res.errors ?? {});
      if (res.navigationError)
        return { profiles, status: reported(unavailable("site-unreachable", `The fallback couldn't load csst.at: ${firstLine(res.navigationError)}`, res.navigationError)) };
      if (errors.length > 0 && errors.length === steamIds.length)
        return { profiles, status: reported(unavailable("site-unreachable", `csst.at didn't answer: ${firstLine(errors[0][1])}`, errors.map(([id, m]) => `${id}: ${m}`).join("\n"))) };
      // Some players failed while others got through: the fallback works, but those players have no answer yet.
      const failed = new Map(errors.filter(([id]) => !profiles.has(id)));
      return { profiles, status: reported(HERO_READY), failed };
    }

    // The selftest passed earlier, so something changed (or this run hit its own problem): check again next time.
    runtime = null;
    const status = reported(classifyHeroFailure({ ...run, node: rt.node }));
    failure = { status, at: Date.now() };
    return { profiles, status };
  } catch (e) {
    return { profiles, status: unexpectedHeroFailure(e) };
  }
}
