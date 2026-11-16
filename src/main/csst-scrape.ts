// The csst.at fallback: fetches a player's Leetify stats from csst.at when Leetify's public API has no profile for
// them.
//
// csst.at is a website behind Cloudflare, so a plain HTTP client gets turned away. wreq-js (a Rust HTTP client with
// Node bindings) sends requests with the TLS and HTTP/2 handshake of a real Chrome, which is all csst.at asks for:
// no browser, no cookie and no helper process. It runs inside the app, in the main process.
//
// The request is the one csst.at's own page makes (an HTMX call: GET /<steamid>/leetify-extra with the HX-* headers).
// The answer is HTML that parseCsstAtHtml() turns into a LeetifyProfile.
//
// Nothing here may fail silently. Every way the fallback can break ends as a CsstStatus with a problem kind and a
// reason in plain words. It is logged (console, and csst.log in the app's data folder) and handed back to the
// caller, which shows it in the window.
//
// Overrides (mostly for tests):
//   CS2CLEAN_CSST_ORIGIN   where csst.at is (a local server stands in for it in tests)
//   CS2CLEAN_DATA_DIR      where csst.log goes when the app didn't say (configureCsst)

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type * as Wreq from "wreq-js";
import { parseCsstAtHtml } from "./csst-parse";
import type { LeetifyProfile } from "./leetify";
import { debug, warn } from "./logger";

export { parseCsstAtHtml } from "./csst-parse";

// ------------------------------------------------------------------ status

export type CsstProblem =
  /** wreq-js's native library wouldn't load (wrong platform, missing system library, a file left out of the package). */
  | "native-load"
  /** csst.at couldn't be reached: DNS, connection, TLS. */
  | "site-unreachable"
  /** csst.at turned the request away: a Cloudflare browser check, a rate limit (429), or a plain refusal (403, 503). */
  | "blocked"
  | "timeout"
  /** A bug here. */
  | "crashed";

export interface CsstStatus {
  state: "ready" | "unavailable";
  problem: CsstProblem | null;
  /** What happened, in plain words, for the window. Null when ready. */
  reason: string | null;
  /** The raw error text behind it, for the log. */
  detail: string | null;
}

export const CSST_READY: CsstStatus = { state: "ready", problem: null, reason: null, detail: null };

function unavailable(problem: CsstProblem, reason: string, detail: string | null = null): CsstStatus {
  return { state: "unavailable", problem, reason, detail };
}

/** What a lobby lookup gets back: the profiles that were found, and whether the fallback itself worked. */
export interface CsstScrape {
  profiles: Map<string, LeetifyProfile>;
  status: CsstStatus;
  /**
   * Players csst.at failed to answer for (a request that threw, or an HTTP error other than "not found"), or that were
   * not asked because csst.at had turned a request away, with what went wrong. Not the same as having no data on them:
   * they are worth asking again.
   */
  failed?: ReadonlyMap<string, string>;
}

/** The fallback failed in a way nobody planned for (a bug here). Still a status, never an exception. */
export function unexpectedCsstFailure(e: unknown): CsstStatus {
  const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
  return reported(unavailable("crashed", `The csst.at fallback hit an unexpected error: ${firstLine(text)}`, text));
}

const firstLine = (s: string): string => (s.split(/\r?\n/).find((l) => l.trim()) ?? s).trim().slice(0, 200);
const errText = (e: unknown): string => (e instanceof Error ? e.message || String(e) : String(e));

// ------------------------------------------------------------------ configuration

let dataDirOverride: string | null = null;

/** The app's data folder (userData). csst.log goes under it. */
export function configureCsst(o: { dataDir: string }): void {
  dataDirOverride = o.dataDir;
}

function dataDir(): string {
  return dataDirOverride ?? process.env.CS2CLEAN_DATA_DIR ?? join(tmpdir(), "cs2clean-csst");
}

/** csst.at, or a stand-in for it. Read on every use, so a test can point it somewhere else. */
const origin = (): string => (process.env.CS2CLEAN_CSST_ORIGIN || "https://csst.at").replace(/\/+$/, "");

/**
 * The browser wreq-js impersonates (its TLS and HTTP/2 handshake, header order and defaults). Newer profiles exist
 * (getProfiles()); this one is known to work against csst.at.
 */
const BROWSER: Wreq.BrowserProfile = "chrome_142";
const REQUEST_TIMEOUT_MS = 20_000;

// ------------------------------------------------------------------ failures

interface Failure {
  problem: CsstProblem;
  message: string;
  /** The whole site is the problem (blocked, unreachable, timing out): asking about the next player would only repeat it. */
  siteWide: boolean;
  /** The raw text behind it, for the log. */
  detail?: string;
}

/** The network library's error text is a chain of Rust errors with the URL in it; the window gets the cause in a few words. */
function networkCause(text: string): string {
  if (/dns|resolve|no such host|name or service|lookup/i.test(text)) return "DNS lookup failed";
  if (/refused/i.test(text)) return "connection refused";
  if (/reset|broken pipe|aborted/i.test(text)) return "connection reset";
  if (/tls|ssl|certificate|handshake/i.test(text)) return "TLS handshake failed";
  if (/unreachable|no route|network is down/i.test(text)) return "network unreachable";
  return "connection failed";
}

/**
 * Turns an exception from a request into a Failure. `known` is true for wreq-js's own RequestError (the network
 * said no); anything else thrown by a request is a bug.
 */
export function classifyRequestError(e: unknown, known: boolean): Failure {
  const text = errText(e);
  if (/time(?:d)?[ -]?out|deadline/i.test(text))
    return { problem: "timeout", message: "csst.at didn't answer in time.", siteWide: true, detail: text };
  if (known)
    return { problem: "site-unreachable", message: `csst.at couldn't be reached (${networkCause(text)}).`, siteWide: true, detail: text };
  return { problem: "crashed", message: `The csst.at request failed unexpectedly: ${firstLine(text)}`, siteWide: false, detail: e instanceof Error ? (e.stack ?? text) : text };
}

/**
 * What a response other than 200 and 404 means. A Cloudflare check (the cf-mitigated header, or its page), a rate
 * limit and a refusal are the site turning us away, for every player alike. Any other status is that player's
 * request failing.
 */
export function classifyHttp(status: number, headers: { get(name: string): string | null }, body = ""): Failure {
  const challenged = headers.get("cf-mitigated")?.toLowerCase() === "challenge" || /just a moment|cf-chl|challenge-platform/i.test(body);
  const detail = body.trim().slice(0, 500) || undefined;
  if (status === 429) return { problem: "blocked", message: "csst.at is rate-limiting requests (HTTP 429).", siteWide: true, detail };
  if (challenged) return { problem: "blocked", message: `csst.at asked for a browser check (Cloudflare, HTTP ${status}).`, siteWide: true, detail };
  if (status === 403 || status === 503) return { problem: "blocked", message: `csst.at refused the request (HTTP ${status}).`, siteWide: true, detail };
  return { problem: "site-unreachable", message: `HTTP ${status}`, siteWide: false, detail };
}

// ------------------------------------------------------------------ reporting

const LOG_LIMIT = 200_000;
let lastReported = "";
const listeners = new Set<(status: CsstStatus) => void>();

/**
 * Calls `fn` whenever the fallback's status changes: after the start-up check or a lookup. The window follows it.
 * Returns a function that stops listening.
 */
export function onCsstStatus(fn: (status: CsstStatus) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function writeLog(text: string): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    const file = join(dataDir(), "csst.log");
    if (existsSync(file) && statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`);
    appendFileSync(file, text + "\n");
  } catch {
    // Nowhere to report a failure to write the log; the console line below still happened.
  }
}

/** Logs a status the first time it changes (console, and csst.log in the data folder) and returns it unchanged. */
function reported(status: CsstStatus): CsstStatus {
  const key = `${status.state}:${status.problem}:${status.reason}`;
  if (key === lastReported) return status;
  const recovered = status.state === "ready" && lastReported.startsWith("unavailable:");
  lastReported = key;
  if (status.state === "unavailable") {
    warn("csst", `${status.problem}: ${status.reason}`);
    if (status.detail) warn("csst", status.detail);
    writeLog(`${new Date().toISOString()} [${status.problem}] ${status.reason}` +
      (status.detail ? "\n" + status.detail.split("\n").map((l) => "    " + l).join("\n") : ""));
  } else if (recovered) {
    writeLog(`${new Date().toISOString()} [ok] the csst.at fallback is working`);
  }
  for (const fn of listeners) {
    try {
      fn(status);
    } catch (e) {
      warn("csst", "a status listener threw:", e);
    }
  }
  return status;
}

// ------------------------------------------------------------------ loading wreq-js

type WreqModule = typeof Wreq;

const RETRY_AFTER_MS = 60_000;
let wreq: WreqModule | null = null;
let loadFailure: { status: CsstStatus; at: number } | null = null;

/** For tests: forget everything learned so far. */
export function resetCsstState(): void {
  wreq = null;
  loadFailure = null;
  lastReported = "";
}

/**
 * Loads wreq-js on first use, not at start-up and not as a top-level import: its native library is the one part of
 * this that can fail to load, and that must end as a status in the window, not as an app that won't start. A failure
 * is remembered for a minute, so a lobby that keeps asking doesn't retry the load every time.
 */
function loadWreq(): { w: WreqModule } | { status: CsstStatus } {
  if (wreq) return { w: wreq };
  if (loadFailure && Date.now() - loadFailure.at < RETRY_AFTER_MS) return { status: loadFailure.status };
  try {
    const w = require("wreq-js") as WreqModule;
    w.getProfiles(); // a module whose native half didn't load fails here, not at the first lookup
    wreq = w;
    loadFailure = null;
    return { w };
  } catch (e) {
    const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
    const status = reported(unavailable("native-load",
      `The csst.at fallback's network library (wreq-js) couldn't be loaded on this system: ${firstLine(errText(e))}`, text));
    loadFailure = { status, at: Date.now() };
    return { status };
  }
}

/**
 * Start-up check, with no network: does wreq-js (and its native library) load? Lets the window say "fallback
 * unavailable" before a lookup needs it.
 */
export function checkCsst(): CsstStatus {
  try {
    const r = loadWreq();
    return "status" in r ? r.status : reported(CSST_READY);
  } catch (e) {
    return unexpectedCsstFailure(e);
  }
}

// ------------------------------------------------------------------ scraping

/** The pause between one player's request to csst.at and the next, in ms. csst.at is a website, not an API: go easy on it. */
export const SCRAPE_DELAY_MS = 4000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What one player's request came to: a profile, nothing (csst.at has no data on them), or a failure. */
type PlayerResult = { profile: LeetifyProfile | null; failure?: undefined } | { profile?: undefined; failure: Failure };

async function fetchProfile(w: WreqModule, steamId: string): Promise<PlayerResult> {
  const base = origin();
  const profileUrl = `${base}/profile/${steamId}`;
  const elementId = `leetify-extra-meta-${steamId}`;
  try {
    debug("csst", "Fetching", steamId);
    const res = await w.fetch(`${base}/${steamId}/leetify-extra`, {
      browser: BROWSER,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "HX-Request": "true",
        "HX-Trigger": elementId,
        "HX-Target": elementId,
        "HX-Current-URL": profileUrl,
        Referer: profileUrl,
      },
    });
    debug("csst", steamId, "→ status", res.status);
    if (res.status === 200) {
      const profile = parseCsstAtHtml(await res.text(), steamId);
      debug("csst", steamId, "→ parsed:", profile ? "profile" : "null");
      return { profile };
    }
    // Read the body of an answer we can't use (it also releases the connection): a Cloudflare page says so there.
    const body = await res.text().catch(() => "");
    // 404 is csst.at saying it has nothing on this player. Anything else is the site failing us.
    if (res.status === 404) return { profile: null };
    return { failure: classifyHttp(res.status, res.headers, body) };
  } catch (e) {
    debug("csst", steamId, "→ request error:", errText(e));
    return { failure: classifyRequestError(e, e instanceof w.RequestError) };
  }
}

/**
 * Fetches the given players from csst.at, one at a time with `delayMs` between two players. Always resolves:
 * `profiles` holds the players it found, `status` says whether the fallback itself worked, and when it didn't, why.
 */
export async function scrapeCsstAtProfiles(steamIds: string[], delayMs = SCRAPE_DELAY_MS): Promise<CsstScrape> {
  const profiles = new Map<string, LeetifyProfile>();
  if (steamIds.length === 0) return { profiles, status: CSST_READY };
  try {
    const loaded = loadWreq();
    if ("status" in loaded) return { profiles, status: loaded.status };

    const failures = new Map<string, Failure>();
    let siteDown: Failure | null = null;
    for (let i = 0; i < steamIds.length; i++) {
      const id = steamIds[i];
      // The site has turned us away (or isn't there): the next player would get the same answer. Don't keep knocking.
      if (siteDown) {
        failures.set(id, siteDown);
        continue;
      }
      const r = await fetchProfile(loaded.w, id);
      if (r.failure) {
        failures.set(id, r.failure);
        if (r.failure.siteWide) siteDown = r.failure;
      } else if (r.profile) {
        profiles.set(id, r.profile);
      }
      if (i < steamIds.length - 1 && delayMs > 0 && !siteDown) await sleep(delayMs);
    }
    debug("csst", "Parsed", profiles.size, "of", steamIds.length, "profiles");

    // Nobody got an answer: the fallback can't be used right now, and the reason is the first failure's.
    if (failures.size === steamIds.length) {
      const f = siteDown ?? failures.values().next().value!;
      const detail = [...failures].map(([id, x]) => `${id}: ${x.message}${x.detail ? `\n    ${firstLine(x.detail)}` : ""}`).join("\n");
      return { profiles, status: reported(unavailable(f.problem, f.message, detail || null)) };
    }
    // Some players failed while others got through: the fallback works, but those players have no answer yet.
    return { profiles, status: reported(CSST_READY), failed: new Map([...failures].map(([id, f]) => [id, f.message])) };
  } catch (e) {
    return { profiles, status: unexpectedCsstFailure(e) };
  }
}
