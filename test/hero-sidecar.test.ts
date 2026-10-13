import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HERO_READY,
  checkHeroRuntime,
  classifyHeroFailure,
  configureHero,
  findHeroDir,
  onHeroStatus,
  resetHeroState,
  scrapeCsstAtProfiles,
  unexpectedHeroFailure,
  type HeroStatus,
} from "../src/main/leetify-hero";

const ID = "76561198000000001";

// What Node prints when a native module was built for another Node (the failure this sidecar exists to prevent).
const ABI_ERROR =
  "Error: The module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
  "was compiled against a different Node.js version using\n" +
  "NODE_MODULE_VERSION 127. This version of Node.js requires\n" +
  "NODE_MODULE_VERSION 137. Please try re-compiling or re-installing\n" +
  "the module (for instance, using `npm rebuild` or `npm install`).";

describe("classifyHeroFailure", () => {
  it("recognises a native module built for another Node, and names both versions", () => {
    const s = classifyHeroFailure({ code: 1, stderr: ABI_ERROR });
    expect(s).toMatchObject({ state: "unavailable", problem: "abi-mismatch" });
    expect(s.reason).toContain("127");
    expect(s.reason).toContain("137");
    expect(s.reason).toContain("npm run hero:install");
    expect(s.detail).toContain("NODE_MODULE_VERSION");
  });

  it("finds it in the CLI's own JSON error too", () => {
    const stdout = JSON.stringify({ error: ABI_ERROR, stage: "sqlite" }) + "\n";
    expect(classifyHeroFailure({ code: 1, stdout }).problem).toBe("abi-mismatch");
  });

  it.each([
    ["ENOENT", "spawn-failed", /file isn't there \(ENOENT\)/],
    ["EACCES", "spawn-failed", /not allowed to run it \(EACCES\)/],
    ["EMFILE", "spawn-failed", /EMFILE/],
  ])("explains a Node that wouldn't start (%s)", (code, problem, reason) => {
    const s = classifyHeroFailure({ code: null, spawnError: { code, message: `spawn x ${code}` }, node: "/n/node" });
    expect(s.problem).toBe(problem);
    expect(s.reason).toMatch(reason);
    expect(s.reason).toContain("/n/node");
  });

  it("reports a timeout before anything it may have printed", () => {
    expect(classifyHeroFailure({ code: null, signal: "SIGTERM", timedOut: true, stderr: ABI_ERROR }).problem).toBe("timeout");
  });

  it("names a missing JavaScript module", () => {
    const s = classifyHeroFailure({ code: 1, stderr: "Error: Cannot find module '@ulixee/hero-playground'\nRequire stack:\n- /x/cli.js" });
    expect(s).toMatchObject({ problem: "module-missing" });
    expect(s.reason).toContain("@ulixee/hero-playground");
  });

  it("recognises a native module that won't load for another reason", () => {
    const s = classifyHeroFailure({ code: 1, stderr: "Error: /x/better_sqlite3.node: invalid ELF header\n  code: 'ERR_DLOPEN_FAILED'" });
    expect(s.problem).toBe("native-load");
  });

  it("blames Chrome only when the CLI's browser stage said so", () => {
    const stage = JSON.stringify({ error: "Can't write to the folder for Chrome (/x): EACCES", stage: "browser" });
    expect(classifyHeroFailure({ code: 1, stdout: stage }).problem).toBe("browser-missing");
    // A healthy run mentions Chrome too ("Chrome 139 is already installed"); a crash after that isn't Chrome's fault.
    const s = classifyHeroFailure({ code: 1, stderr: "Chrome 139.0.7258.155 is already installed; skipping download.\nboom" });
    expect(s.problem).toBe("crashed");
  });

  it.each(["ENOTDIR", "EACCES", "EROFS", "ENOSPC"])("reports a folder it couldn't use (%s)", (code) => {
    const s = classifyHeroFailure({ code: 1, stderr: `Error: ${code}: nope, mkdir '/x/y'` });
    expect(s).toMatchObject({ problem: "setup-failed" });
    expect(s.reason).toContain(code);
  });

  it("tells a clean exit without a result from a crash", () => {
    expect(classifyHeroFailure({ code: 0, stdout: "Automatically shutting down Hero Core\n" }).problem).toBe("bad-output");
    expect(classifyHeroFailure({ code: 3, stderr: "boom" })).toMatchObject({ problem: "crashed", reason: expect.stringContaining("exit code 3") });
    expect(classifyHeroFailure({ code: null, signal: "SIGKILL" }).reason).toContain("signal SIGKILL");
  });

  it("always has a reason and the raw text, so nothing fails silently", () => {
    for (const input of [{ code: 1, stderr: "x" }, { code: 0 }, { code: null, timedOut: true }, { code: null, spawnError: { message: "m" } }]) {
      const s = classifyHeroFailure(input);
      expect(s.state).toBe("unavailable");
      expect(s.reason).toBeTruthy();
    }
  });

  it("keeps only the tail of a very long crash log", () => {
    const s = classifyHeroFailure({ code: 1, stderr: "x".repeat(50_000) + "THE END" });
    expect(s.detail!.length).toBeLessThan(2100);
    expect(s.detail).toContain("THE END");
  });
});

describe("unexpectedHeroFailure", () => {
  beforeEach(() => configureHero({ dataDir: mkdtempSync(join(tmpdir(), "cs2c-hero-")) }));
  it("turns a bug into a status instead of an exception", () => {
    const s = unexpectedHeroFailure(new Error("kaboom"));
    expect(s).toMatchObject({ state: "unavailable", problem: "crashed" });
    expect(s.reason).toContain("kaboom");
  });
});

// ------------------------------------------------------------------ the sidecar, with a stub for cli.js

/** A cli.js that answers like the real one. STUB_MODE picks the behaviour; the rest of the app code is the real thing. */
const STUB = String.raw`
const mode = process.env.STUB_MODE || "ok";
const [command, ...rest] = process.argv.slice(2);
const out = (o, code = 0) => process.stdout.write(JSON.stringify(o) + "\n", () => process.exit(code));
const ABI = ${JSON.stringify(ABI_ERROR)};
if (mode === "abi" && command === "selftest") { process.stderr.write(ABI + "\n"); out({ error: ABI, stage: "sqlite" }, 1); }
else if (mode === "crash") { process.stderr.write("something exploded\n"); process.exit(3); }
else if (command === "selftest") {
  const wantsBrowser = rest.includes("--ensure-browser");
  if (mode === "no-browser" && !wantsBrowser) out({ type: "selftest", ok: true, node: process.version, abi: process.versions.modules, sqlite: "3", browser: "missing" });
  else if (mode === "no-browser") setTimeout(() => out({ type: "selftest", ok: true, node: process.version, abi: process.versions.modules, sqlite: "3", browser: "installed-now" }), 50);
  else out({ type: "selftest", ok: true, node: process.version, abi: process.versions.modules, sqlite: "3", browser: "installed" });
}
else if (command === "scrape") {
  const ids = rest.filter((a) => /^\d{17}$/.test(a));
  // Hero Core prints its own lines to stdout before the result; the app must cope.
  console.log("Automatically shutting down Hero Core");
  if (mode === "nav-error") out({ type: "scrape", data: Object.fromEntries(ids.map((i) => [i, null])), navigationError: "net::ERR_NAME_NOT_RESOLVED at https://csst.at/" });
  else if (mode === "all-errors") out({ type: "scrape", data: Object.fromEntries(ids.map((i) => [i, null])), errors: Object.fromEntries(ids.map((i) => [i, "HTTP 503"])) });
  else if (mode === "some-errors") out({ type: "scrape", data: Object.fromEntries(ids.map((i, n) => [i, n === 0 ? { steam64_id: i, name: null, privacy_mode: "private", total_matches: 12, winrate: null, ranks: { leetify: 1 }, rating: {}, stats: {} } : null])), errors: { [ids[1]]: "HTTP 503" } });
  else out({ type: "scrape", data: Object.fromEntries(ids.map((i, n) => [i, n === 0 ? { steam64_id: i, name: null, privacy_mode: "private", total_matches: 12, winrate: null, ranks: { leetify: 1 }, rating: {}, stats: {} } : null])) });
}
else out({ error: "Unknown command: " + command }, 2);
`;

describe("the sidecar", () => {
  let root: string;
  let heroDir: string;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs2c-sidecar-"));
    heroDir = join(root, "hero");
    mkdirSync(heroDir);
    writeFileSync(join(heroDir, "cli.js"), STUB);
    resetHeroState();
    configureHero({ dataDir: join(root, "data") });
    setEnv("CS2CLEAN_HERO_DIR", heroDir);
    setEnv("CS2CLEAN_NODE22", process.execPath); // any Node will do for a stub
    setEnv("STUB_MODE", "ok");
    vi.spyOn(console, "warn").mockImplementation(() => undefined); // the failures below are logged on purpose
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const hero = () => readFileSync(join(root, "data", "hero.log"), "utf8");

  it("returns the profiles it found, and says it is working", async () => {
    const r = await scrapeCsstAtProfiles([ID, "76561198000000002"], 0);
    expect(r.status).toEqual(HERO_READY);
    expect([...r.profiles.keys()]).toEqual([ID]);
    expect(r.profiles.get(ID)?.total_matches).toBe(12);
    expect(r.failed?.size).toBe(0);
  });

  it("names the players csst.at failed for while it works for the rest, and not the ones it has nothing on", async () => {
    setEnv("STUB_MODE", "some-errors");
    const failing = "76561198000000002", empty = "76561198000000003";
    const r = await scrapeCsstAtProfiles([ID, failing, empty], 0);
    expect(r.status).toEqual(HERO_READY); // the fallback works; it is one player's request that failed
    expect([...r.profiles.keys()]).toEqual([ID]);
    expect([...(r.failed ?? [])]).toEqual([[failing, "HTTP 503"]]);
  });

  it("finds the result among the lines Hero Core prints itself", async () => {
    // The stub prints "Automatically shutting down Hero Core" before the JSON; the run above only passes if that is skipped.
    expect((await scrapeCsstAtProfiles([ID], 0)).profiles.size).toBe(1);
  });

  it("asks for nothing and starts nothing for an empty lobby", async () => {
    setEnv("CS2CLEAN_HERO_DIR", "/nonexistent");
    expect(await scrapeCsstAtProfiles([], 0)).toMatchObject({ status: HERO_READY });
  });

  it("reports a missing sidecar folder with what to do about it", async () => {
    setEnv("CS2CLEAN_HERO_DIR", join(root, "nowhere"));
    const r = await scrapeCsstAtProfiles([ID], 0);
    expect(r.profiles.size).toBe(0);
    expect(r.status).toMatchObject({ state: "unavailable", problem: "no-runtime" });
    expect(r.status.reason).toContain("npm run hero:install");
  });

  it("reports a Node 22 that isn't there, naming the path", async () => {
    setEnv("CS2CLEAN_NODE22", join(root, "no-such-node"));
    const r = await scrapeCsstAtProfiles([ID], 0);
    expect(r.status).toMatchObject({ problem: "no-node" });
    expect(r.status.reason).toContain("no-such-node");
  });

  it.skipIf(process.platform === "win32")("reports a Node it isn't allowed to run (EACCES)", async () => {
    const notExecutable = join(root, "node-not-executable");
    writeFileSync(notExecutable, "#!/bin/sh\n");
    chmodSync(notExecutable, 0o644);
    setEnv("CS2CLEAN_NODE22", notExecutable);
    const r = await scrapeCsstAtProfiles([ID], 0);
    expect(r.status).toMatchObject({ state: "unavailable", problem: "spawn-failed" });
    expect(r.status.reason).toContain("EACCES");
  });

  it("catches the ABI mismatch at the selftest, with the real message, and logs it", async () => {
    setEnv("STUB_MODE", "abi");
    const r = await scrapeCsstAtProfiles([ID], 0);
    expect(r.status).toMatchObject({ state: "unavailable", problem: "abi-mismatch" });
    expect(r.status.reason).toMatch(/ABI 127.*needs 137/);
    // Logged where a packaged app's owner can find it, and on the console:
    expect(hero()).toContain("[abi-mismatch]");
    expect(hero()).toContain("NODE_MODULE_VERSION 127");
    expect(console.warn).toHaveBeenCalled();
  });

  it("doesn't restart Node for every lookup while it is broken, but looks again after a reset", async () => {
    setEnv("STUB_MODE", "abi");
    const first = await scrapeCsstAtProfiles([ID], 0);
    setEnv("STUB_MODE", "ok"); // fixed meanwhile; the failure is remembered for a minute anyway
    const second = await scrapeCsstAtProfiles([ID], 0);
    expect(second.status).toEqual(first.status);
    resetHeroState();
    expect((await scrapeCsstAtProfiles([ID], 0)).status).toEqual(HERO_READY);
  });

  it("reports a crash with its exit code, not as an empty answer", async () => {
    setEnv("STUB_MODE", "crash");
    const r = await scrapeCsstAtProfiles([ID], 0);
    expect(r.status).toMatchObject({ problem: "crashed" });
    expect(r.status.reason).toContain("exit code 3");
    expect(r.status.detail).toContain("something exploded");
  });

  it("tells csst.at being unreachable apart from the sidecar being broken", async () => {
    setEnv("STUB_MODE", "nav-error");
    const nav = await scrapeCsstAtProfiles([ID], 0);
    expect(nav.status).toMatchObject({ problem: "site-unreachable" });
    expect(nav.status.reason).toContain("ERR_NAME_NOT_RESOLVED");

    resetHeroState();
    setEnv("STUB_MODE", "all-errors");
    const errs = await scrapeCsstAtProfiles([ID], 0);
    expect(errs.status).toMatchObject({ problem: "site-unreachable" });
    expect(errs.status.reason).toContain("HTTP 503");
  });

  it("downloads Chrome in the background on first use: the lookup isn't held up, the window hears when it's done", async () => {
    setEnv("STUB_MODE", "no-browser");
    const seen: HeroStatus[] = [];
    const done = new Promise<void>((resolve) =>
      onHeroStatus((s) => {
        seen.push(s);
        if (s.state === "ready") resolve();
      }));

    const first = await scrapeCsstAtProfiles([ID], 0);
    expect(first.profiles.size).toBe(0);
    expect(first.status).toMatchObject({ state: "unavailable", problem: "browser-missing" });
    expect(first.status.reason).toMatch(/downloading Chrome/i);
    // A second lookup during the download doesn't queue behind it either.
    expect((await scrapeCsstAtProfiles([ID], 0)).status.problem).toBe("browser-missing");

    await done;
    expect(seen.map((s) => s.state)).toEqual(["unavailable", "ready"]);
    const later = await scrapeCsstAtProfiles([ID], 0);
    expect(later.status).toEqual(HERO_READY);
    expect(later.profiles.size).toBe(1);
  });

  it("checks at start-up, without scraping or downloading", async () => {
    expect(await checkHeroRuntime()).toEqual(HERO_READY);
    resetHeroState();
    setEnv("STUB_MODE", "abi");
    expect(await checkHeroRuntime()).toMatchObject({ state: "unavailable", problem: "abi-mismatch" });
  });

  it("tells a listener only when the status changes", async () => {
    const seen: string[] = [];
    const off = onHeroStatus((s) => seen.push(s.state));
    await scrapeCsstAtProfiles([ID], 0);
    await scrapeCsstAtProfiles([ID], 0);
    off();
    expect(seen).toEqual(["ready"]);
  });
});

describe("findHeroDir", () => {
  const prev = process.env.CS2CLEAN_HERO_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.CS2CLEAN_HERO_DIR;
    else process.env.CS2CLEAN_HERO_DIR = prev;
  });

  it("uses the override when it has a cli.js", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs2c-find-"));
    writeFileSync(join(dir, "cli.js"), "");
    process.env.CS2CLEAN_HERO_DIR = dir;
    expect(findHeroDir()).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("doesn't quietly pick another folder when the override is wrong", () => {
    process.env.CS2CLEAN_HERO_DIR = join(tmpdir(), "cs2c-no-such-dir");
    expect(findHeroDir()).toBeNull();
  });
});
