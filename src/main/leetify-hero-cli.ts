// CLI entry point for the Hero sidecar: hero-runtime/cli.js, bundled from this file by tools/build-hero-runtime.mjs
// and started by main/leetify-hero.ts with the sidecar's own Node 22. It never runs inside Electron: Hero needs
// better-sqlite3, a native module that has to be built for the Node that loads it.
//
// Usage:
//   node cli.js scrape [--delay=<ms>] <steamid1> [steamid2 ...]
//   node cli.js selftest [--ensure-browser]     Hero and better-sqlite3 load; Chrome is there (or gets downloaded)
//
// OUTPUT CONTRACT: the result is a single JSON line on stdout, and the process exits right after it. All logging
// goes to stderr. The parent still picks the last JSON line, because Hero Core prints its own lines to stdout.
//
//   {"type":"scrape","data":{<id>:profile|null},"navigationError"?:string,"errors"?:{<id>:string}}   exit 0
//   {"type":"selftest","ok":true,"node":"v22.x","abi":"127","sqlite":"3.x","browser":"installed"|"installed-now"|"missing"}   exit 0
//   {"error":string,"stage"?:"sqlite"|"hero"|"browser"}   exit 1 (2 for a bad command line)
//
// Nothing is swallowed here: a module that won't load, a Chrome that can't be downloaded and a Hero that can't
// start all end as an {"error"} line with the original message, which the app shows and logs.

import { createRequire } from "module";
import { accessSync, constants, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import type { LeetifyProfile } from "./leetify";
import { parseCsstAtHtml } from "./csst-parse";
import { debug } from "./logger";

// Minimal Hero interface; its types aren't imported so the bundle has no build-time dependency on Hero.
// NOTE: Hero's Response properties are async (awaited-dom), so `status` is a Promise<number>.
interface HeroInstance {
  readonly sessionId: Promise<string>;
  goto(url: string, opts?: { timeoutMs?: number }): Promise<unknown>;
  waitForPaintingStable(): Promise<void>;
  fetch(
    url: string,
    opts?: { referrer?: string; headers?: Record<string, string> },
  ): Promise<{ status: Promise<number>; text: () => Promise<string> }>;
  close(): Promise<void>;
}
interface HeroModule {
  Hero: new () => HeroInstance;
  Core: { shutdown(): Promise<unknown> };
}
interface ChromeBuild {
  fullVersion: string;
  executablePath: string;
  /** Where the builds are kept: BROWSERS_DIR when the app set it. */
  browsersDir: string;
  isInstalled: boolean;
}

type Stage = "sqlite" | "hero" | "browser";

/** A failure of the sidecar's own setup, as opposed to csst.at misbehaving. */
class StageError extends Error {
  constructor(message: string, readonly stage: Stage) {
    super(message);
  }
}

// csst.at, or a stand-in for it (tests point this at a local server).
const ORIGIN = (process.env.CS2CLEAN_CSST_ORIGIN || "https://csst.at").replace(/\/+$/, "");

// Keep stdout reserved for the JSON result: send console.log (which debug() and Hero use) to stderr.
console.log = (...args: unknown[]): void => console.error(...args);

const errText = (e: unknown): string => (e instanceof Error ? e.message || String(e) : String(e));

// ensureBrowser() swaps process.exit for a throwing stand-in while Chrome's installer runs, so everything that has
// to end the process (finish, the SIGTERM handler) uses this one, taken before that can happen.
const exit = process.exit.bind(process);

/** Writes the result line, lets it flush, and exits: Hero Core would otherwise keep the process alive for a while. */
function finish(result: unknown, code: number): void {
  process.stdout.write(JSON.stringify(result) + "\n", () => exit(code));
}

// Everything the sidecar needs is installed next to cli.js.
const sidecarRequire = createRequire(join(__dirname, "package.json"));

let hero: HeroModule | null = null;

function loadHero(): HeroModule {
  if (hero) return hero;
  try {
    const mod = sidecarRequire("@ulixee/hero-playground");
    hero = { Hero: mod.default ?? mod, Core: mod.Core };
    return hero;
  } catch (e) {
    throw new StageError(errText(e), "hero");
  }
}

/** Opens an in-memory database with the very better-sqlite3 that Hero loads (the one next to hero-core). */
function checkSqlite(): string {
  let heroCore: string;
  try {
    heroCore = sidecarRequire.resolve("@ulixee/hero-core");
  } catch (e) {
    throw new StageError(errText(e), "hero");
  }
  try {
    const Database = createRequire(heroCore)("better-sqlite3");
    const db = new Database(":memory:");
    try {
      return String(db.prepare("select sqlite_version() as v").get().v);
    } finally {
      db.close();
    }
  } catch (e) {
    // The usual cause is NODE_MODULE_VERSION: built by another Node than this one. The message says both.
    throw new StageError(errText(e), "sqlite");
  }
}

/** The Chrome builds Hero can drive: the @ulixee/chrome-<version> packages (not chrome-app, the helper). */
function chromeBuilds(): ChromeBuild[] {
  const dir = join(__dirname, "node_modules", "@ulixee");
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => /^chrome-\d/.test(n)) : [];
  return names.map((n) => {
    const Chrome = sidecarRequire(`@ulixee/${n}`);
    return new (Chrome.default ?? Chrome)() as ChromeBuild;
  });
}

/**
 * Makes sure Chrome is installed (it lives under BROWSERS_DIR, which the app points into its data folder).
 * Without `download`, a missing Chrome is only reported.
 */
async function ensureBrowser(download: boolean): Promise<"installed" | "installed-now" | "missing"> {
  const builds = chromeBuilds();
  if (builds.length === 0) throw new StageError("The sidecar has no Chrome package (@ulixee/chrome-*).", "browser");
  const missing = builds.filter((b) => !b.isInstalled);
  if (missing.length === 0) return "installed";
  if (!download) return "missing";

  const { installChrome } = sidecarRequire("@ulixee/chrome-app/lib/installChrome");
  for (const b of missing) {
    // Look at the folder before a download of a few hundred MB: a folder that can't be written would otherwise only show up
    // as the installer's own hang or crash at the end of it (ENOTDIR, EACCES, EROFS...).
    try {
      mkdirSync(b.browsersDir, { recursive: true });
      accessSync(b.browsersDir, constants.W_OK);
    } catch (e) {
      throw new StageError(`Can't write to the folder for Chrome (${b.browsersDir}): ${errText(e)}`, "browser");
    }
    debug("hero", `Downloading Chrome ${b.fullVersion} to ${b.executablePath}`);
    // chrome-app's installer reports a failed download by printing the error and calling process.exit(1).
    // Turn that into an exception, or the process would die before it could say why.
    const realExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`Chrome ${b.fullVersion} couldn't be downloaded (the installer exited with code ${code}; its message is above).`);
    }) as typeof process.exit;
    try {
      await installChrome(b);
    } catch (e) {
      throw new StageError(errText(e), "browser");
    } finally {
      process.exit = realExit;
    }
    if (!b.isInstalled)
      throw new StageError(`Chrome ${b.fullVersion} is still missing after the download (expected ${b.executablePath}).`, "browser");
  }
  return "installed-now";
}

interface ScrapeResult {
  data: Record<string, LeetifyProfile | null>;
  navigationError: string | null;
  errors: Record<string, string>;
}

async function doScrape(steamIds: string[], delayMs: number): Promise<ScrapeResult> {
  const { Hero, Core } = loadHero();
  // Chrome first: left to Hero, a missing Chrome fails deep inside its start-up with a message about some file.
  await ensureBrowser(true);

  const result: ScrapeResult = { data: {}, navigationError: null, errors: {} };
  for (const id of steamIds) result.data[id] = null;

  const h = new Hero();
  try {
    try {
      // Starts Hero Core and Chrome. A failure here is the sidecar's (a native module, a missing library), so it
      // must not be reported as "csst.at didn't answer".
      await h.sessionId;
    } catch (e) {
      throw new StageError(errText(e), "hero");
    }
    debug("hero", "Hero started");

    try {
      debug("hero", "Navigating to", ORIGIN);
      await h.goto(`${ORIGIN}/`, { timeoutMs: 60000 });
      await h.waitForPaintingStable();
    } catch (e) {
      result.navigationError = errText(e);
      return result;
    }

    for (let i = 0; i < steamIds.length; i++) {
      const sid = steamIds[i];
      const profileUrl = `${ORIGIN}/profile/${sid}`;
      const elementId = `leetify-extra-meta-${sid}`;
      try {
        debug("hero", "Fetching", sid);
        const res = await h.fetch(`${ORIGIN}/${sid}/leetify-extra`, {
          referrer: profileUrl,
          headers: {
            "HX-Request": "true",
            "HX-Trigger": elementId,
            "HX-Target": elementId,
            "HX-Current-URL": profileUrl,
            Accept: "*/*",
          },
        });
        const status = await res.status;
        debug("hero", sid, "→ status", status);
        if (status === 200) {
          const profile = parseCsstAtHtml(await res.text(), sid);
          debug("hero", sid, "→ parsed:", profile ? "profile" : "null");
          result.data[sid] = profile;
        } else if (status !== 404) {
          // 404 is csst.at saying it has nothing on this player. Anything else is the site failing us.
          result.errors[sid] = `HTTP ${status}`;
        }
      } catch (e) {
        debug("hero", sid, "→ fetch error:", errText(e));
        result.errors[sid] = errText(e);
      }
      if (i < steamIds.length - 1 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
    return result;
  } finally {
    // Closing is cleanup: its own failure must not hide the result or the error that got us here.
    await h.close().catch((e) => debug("hero", "close failed:", errText(e)));
    await Core.shutdown().catch((e) => debug("hero", "shutdown failed:", errText(e)));
    debug("hero", "Hero closed");
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "selftest") {
    const sqlite = checkSqlite();
    loadHero();
    const browser = await ensureBrowser(rest.includes("--ensure-browser"));
    return finish({ type: "selftest", ok: true, node: process.version, abi: process.versions.modules, sqlite, browser }, 0);
  }

  if (command === "scrape") {
    const steamIds = rest.filter((a) => /^\d{17}$/.test(a));
    if (steamIds.length === 0) return finish({ error: "No valid SteamIDs provided" }, 2);
    // Optional --delay=<ms> (delay between profile fetches)
    const delayArg = rest.find((a) => a.startsWith("--delay="));
    const parsedDelay = delayArg ? parseInt(delayArg.slice("--delay=".length), 10) : NaN;
    const delayMs = Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : 5000;

    const r = await doScrape(steamIds, delayMs);
    debug("hero", "Scraped", Object.values(r.data).filter(Boolean).length, "/", steamIds.length, "profiles");
    const out: Record<string, unknown> = { type: "scrape", data: r.data };
    if (r.navigationError) out.navigationError = r.navigationError;
    if (Object.keys(r.errors).length > 0) out.errors = r.errors;
    return finish(out, 0);
  }

  return finish({ error: `Unknown command: ${command ?? "(none)"}` }, 2);
}

const fail = (e: unknown): void => finish({ error: errText(e), stage: e instanceof StageError ? e.stage : undefined }, 1);

// The app stops us with SIGTERM on a timeout: close Chrome first, or it would be left running.
process.on("SIGTERM", () => {
  const done = () => exit(143);
  setTimeout(done, 3000);
  (hero ? hero.Core.shutdown() : Promise.resolve()).then(done, done);
});
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

main().catch(fail);
