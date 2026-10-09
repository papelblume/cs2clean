// CLI entry point for the Hero subprocess.
//
// Run with Node 22 (required by @ulixee/hero-playground).
// Reads SteamIDs from command line, performs the scrape, outputs JSON to stdout.
//
// Usage: node leetify-hero-cli.js scrape [--delay=<ms>] <steamid1> [steamid2 ...]
//
// The companion app spawns this script using a Node 22 binary.
//
// OUTPUT CONTRACT: the result is a single JSON line on stdout
// ({"type":"scrape",...} or {"error":...}). All logging goes to stderr.
// The parent still picks the last JSON line from stdout, because Hero Core
// can print its own messages to stdout.

import type { LeetifyProfile } from "./leetify";
import { parseCsstAtHtml } from "./leetify-hero";
import { debug } from "./logger";

interface ScrapeRequest {
  command: "scrape";
  steamIds: string[];
  delayMs?: number;
}

// Minimal Hero interface — we don't import types to avoid resolution issues.
// NOTE: Hero's Response properties are async (awaited-dom), so `status` is a
// Promise<number>, not a number. It must be awaited before comparing.
interface HeroInstance {
  goto(url: string, opts?: { timeoutMs?: number }): Promise<unknown>;
  waitForPaintingStable(): Promise<void>;
  fetch(
    url: string,
    opts?: { referrer?: string; headers?: Record<string, string> },
  ): Promise<{ status: Promise<number>; text: () => Promise<string> }>;
  close(): Promise<void>;
}

// Keep stdout reserved for the JSON result: send console.log (which debug()
// may use) to stderr, and write the result through emit().
const emit = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};
console.log = (...args: unknown[]): void => console.error(...args);

async function getHero(): Promise<any> {
  try {
    const Hero = require("@ulixee/hero-playground");
    return Hero.default ?? Hero;
  } catch {
    return null;
  }
}

async function doScrape(steamIds: string[], delayMs = 5000): Promise<Map<string, LeetifyProfile | null>> {
  const Hero = await getHero();
  if (!Hero) {
    debug("hero", "Hero not available");
    const result = new Map<string, LeetifyProfile | null>();
    for (const id of steamIds) result.set(id, null);
    return result;
  }

  debug("hero", "Hero loaded");
  const hero: HeroInstance = new Hero();
  debug("hero", "Hero instance created");
  const results = new Map<string, LeetifyProfile | null>();

  try {
    debug("hero", "Navigating to csst.at");
    await hero.goto("https://csst.at/", { timeoutMs: 60000 });
    await hero.waitForPaintingStable();

    for (let i = 0; i < steamIds.length; i++) {
      const sid = steamIds[i];
      const profileUrl = `https://csst.at/profile/${sid}`;
      const elementId = `leetify-extra-meta-${sid}`;

      try {
        debug("hero", "Fetching", sid);
        const res = await hero.fetch(`https://csst.at/${sid}/leetify-extra`, {
          referrer: profileUrl,
          headers: {
            "HX-Request": "true",
            "HX-Trigger": elementId,
            "HX-Target": elementId,
            "HX-Current-URL": profileUrl,
            Accept: "*/*",
          },
        });

        // Hero's Response.status is a Promise<number> — await it.
        const status = await res.status;
        debug("hero", sid, "→ status", status);
        if (status === 200) {
          const html = await res.text();
          const profile = parseCsstAtHtml(html, sid);
          debug("hero", sid, "→ parsed:", profile ? "profile" : "null");
          results.set(sid, profile);
        } else {
          results.set(sid, null);
        }
      } catch (e) {
        debug("hero", sid, "→ fetch error:", String(e));
        results.set(sid, null);
      }

      if (i < steamIds.length - 1 && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  } catch (e) {
    debug("hero", "Scrape error:", String(e));
    for (const id of steamIds) {
      if (!results.has(id)) results.set(id, null);
    }
  } finally {
    debug("hero", "Hero closed");
    await hero.close();
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.exit(1);
  }

  const command = args[0];

  if (command === "scrape") {
    const rest = args.slice(1);
    const steamIds = rest.filter((a) => /^\d{17}$/.test(a));

    // Optional --delay=<ms> (delay between profile fetches)
    const delayArg = rest.find((a) => a.startsWith("--delay="));
    const parsedDelay = delayArg ? parseInt(delayArg.slice("--delay=".length), 10) : NaN;
    const delayMs = Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : 5000;

    if (steamIds.length === 0) {
      emit({ error: "No valid SteamIDs provided" });
      process.exit(1);
    }
    try {
      const results = await doScrape(steamIds, delayMs);
      debug("hero", "Scraped", results.size, "/", steamIds.length, "profiles");
      const output: Record<string, LeetifyProfile | null> = {};
      for (const [id, profile] of results) {
        output[id] = profile;
      }
      emit({ type: "scrape", data: output });
    } catch (e) {
      emit({ error: String(e) });
      process.exit(1);
    }
  } else {
    emit({ error: `Unknown command: ${command}` });
    process.exit(1);
  }
}

void main();
