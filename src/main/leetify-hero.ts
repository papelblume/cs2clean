// Scrape Leetify player data from csst.at using Ulixee Hero.
//
// Used as a fallback when Leetify's public API returns "not found" for a player.
// The csst.at pages contain scraped Leetify stats loaded via HTMX requests.
//
// IMPORTANT: Hero requires Node 22 due to better-sqlite3 native module issues.
// This module spawns a separate Node 22 subprocess to do the actual scraping,
// because the companion app runs inside Electron which bundles Node 24.
//
// Requirements:
//   - Node 22 must be available (via nvm or system install)
//   - On Linux Mint: a cat shim is needed because Hero crashes on `cat` failures
//     for `/etc/upstream-release` (a directory on Mint). The shim is auto-created
//     in the hero-test/shim/ directory when run-hero.sh is used.
//
// Hero is an optional dependency. If unavailable, functions return null/empty gracefully.

import { spawn } from "child_process";
import { join, dirname } from "path";

//const __dirname = dirname(__filename);

import type { LeetifyProfile } from "./leetify";

import { existsSync, readdirSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { debug } from "./logger";

/**
 * Parse csst.at HTMX HTML response into a LeetifyProfile.
 * Pure JS function — no native dependencies, works in any Node version.
 */
export function parseCsstAtHtml(html: string, steamId: string): LeetifyProfile | null {
  if (!html || !steamId) return null;

  const getValue = (key: string): number | null => {
    const openRegex = new RegExp(`<\\w+\\b[^>]*id="leetify-${key}-${steamId}"[^>]*>`, "s");
    const openMatch = openRegex.exec(html);
    if (!openMatch) return null;
    const tagName = openMatch[0].match(/^<(\w+)/)?.[1] ?? "div";
    const closeRegex = new RegExp(`</${tagName}>`, "s");
    const afterOpen = html.slice(openMatch.index + openMatch[0].length);
    const closeMatch = closeRegex.exec(afterOpen);
    if (!closeMatch) return null;
    const content = afterOpen.slice(0, closeMatch.index);
    const numbers = content.match(/([-+]?\d*\.?\d+)/g);
    if (!numbers || numbers.length === 0) return null;
    return parseFloat(numbers[numbers.length - 1]);
  };

  const getPercent = (key: string): number | null => {
    const openRegex = new RegExp(`<\\w+\\b[^>]*id="leetify-${key}-${steamId}"[^>]*>`, "s");
    const openMatch = openRegex.exec(html);
    if (!openMatch) return null;
    const tagName = openMatch[0].match(/^<(\w+)/)?.[1] ?? "div";
    const closeRegex = new RegExp(`</${tagName}>`, "s");
    const afterOpen = html.slice(openMatch.index + openMatch[0].length);
    const closeMatch = closeRegex.exec(afterOpen);
    if (!closeMatch) return null;
    const content = afterOpen.slice(0, closeMatch.index);
    const allPcts = content.match(/([\d.]+)%/g);
    if (!allPcts || allPcts.length === 0) return null;
    const lastPct = allPcts[allPcts.length - 1];
    return parseFloat(lastPct.replace("%", ""));
  };

  const getGames = (): number | null => {
    const regex = new RegExp(`id="leetify-games-${steamId}"[^>]*>([\\s\\S]*?)</`);
    const m = regex.exec(html);
    if (!m) return null;
    const n = parseInt(m[1].trim(), 10);
    return Number.isFinite(n) ? n : null;
  };

  const aim = getValue("aim");
  const utility = getValue("utility");
  const rating = getValue("rating");
  const preaim = getValue("preaim");
  const reactionTime = getValue("reaction-time");
  const headshots = getPercent("headshots");
  const accuracy = getPercent("accuracy");
  const counterStrafing = getPercent("counter-strafing");
  const games = getGames();

  const anyValue = [aim, utility, rating, preaim, reactionTime, headshots, accuracy, counterStrafing, games]
    .some((v) => v !== null);
  if (!anyValue) return null;

  // ranks.leetify is in website units (assess.ts: ~6.55 is a very strong player), the same units csst.at shows,
  // so it is passed through unchanged. Only ct_leetify / t_leetify and per-match ratings are fractions.
  const ranksLeetify = rating;

  return {
    steam64_id: steamId,
    name: null,
    privacy_mode: "private",
    total_matches: games,
    winrate: null,
    ranks: { leetify: ranksLeetify },
    rating: { aim, utility },
    stats: {
      preaim,
      reaction_time_ms: reactionTime,
      accuracy_head: headshots,
      spray_accuracy: accuracy,
      counter_strafing_good_shots_ratio: counterStrafing,
    },
  };
}

/** Result from the Hero subprocess. */
interface ScrapeResponse {
  type: "scrape";
  data: Record<string, LeetifyProfile | null>;
}

interface ErrorResponse {
  error: string;
}

type Response = ScrapeResponse | ErrorResponse;

/**
 * Extract the CLI's JSON result from the subprocess stdout.
 *
 * stdout is not guaranteed to be clean: Hero Core prints its own messages
 * (e.g. "Automatically shutting down Hero Core") and debug() output can land
 * there too. The result is always a single JSON line, so scan from the end.
 */
function extractResponse(stdout: string): Response | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && ("type" in parsed || "error" in parsed)) {
        return parsed as Response;
      }
    } catch {
      // Not our JSON line — keep looking
    }
  }
  return null;
}

/**
 * Find a Node 22 binary on the system.
 */
// function findNode22(): string | null {
//   const homedir = process.env.HOME || process.env.USERPROFILE || "";
//   const nvmDir = process.env.NVM_DIR || join(homedir, ".nvm");

//   const candidates = [
//     join(nvmDir, "versions", "node", "v22.23.3", "bin", "node"),
//     join(nvmDir, "versions", "node", "v22.22.0", "bin", "node"),
//     join(nvmDir, "versions", "node", "v22.18.0", "bin", "node"),
//     join(nvmDir, "versions", "node", "v22.14.0", "bin", "node"),
//     join(nvmDir, "versions", "node", "v22.12.0", "bin", "node"),
//   ];

//   for (const candidate of candidates) {
//     // Return the first valid-looking path — we'll verify at runtime
//     if (candidate.startsWith("/")) return candidate;
//   }

//   return "node";
// }

function findNode22(): string | null {
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  const nvmDir = process.env.NVM_DIR || join(homedir, ".nvm");
  const versionsDir = join(nvmDir, "versions", "node");
  if (!existsSync(versionsDir)) return null;

  const v22 = readdirSync(versionsDir)
    .filter((v) => v.startsWith("v22."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse();

  for (const v of v22) {
    const bin = join(versionsDir, v, "bin", "node");
    if (existsSync(bin)) return bin;
  }
  return null;
}

/**
 * Spawn the Hero subprocess to scrape profiles from csst.at.
 * Returns a Map of steamId -> LeetifyProfile (or null on failure).
 */
export async function scrapeCsstAtProfiles(steamIds: string[], delayMs = 1000): Promise<Map<string, LeetifyProfile>> {
  if (steamIds.length === 0) return new Map();

  const nodeBinary = findNode22();
  debug("hero", "Node 22:", nodeBinary ?? "not found");
  if (!nodeBinary) return new Map();

  const cliScript = join(__dirname, "leetify-hero-cli.js");
  const projectRoot = join(__dirname, "..", "..");
  const shimDir = join(projectRoot, "hero-test", "shim");

  try {
    return await new Promise<Map<string, LeetifyProfile>>((resolve) => {
      const { existsSync, mkdirSync, writeFileSync, chmodSync } = require("fs");

      // Auto-create shim if missing
      const shimCat = join(shimDir, "cat");
      if (!existsSync(shimCat)) {
        if (!existsSync(shimDir)) {
          mkdirSync(shimDir, { recursive: true });
        }
        //writeFileSync(shimCat, '#!/bin/sh\nexec cat "$@" 2>/dev/null; exit 0\n');
        writeFileSync(shimCat, '#!/bin/sh\ncat "$@" 2>/dev/null\nexit 0\n');
        chmodSync(shimCat, 0o755);
      }
      debug("hero", "Shim cat ready");

      const env = { ...process.env };
      env.PATH = `${shimDir}:${env.PATH || ""}`;

      const cliArgs = [cliScript, "scrape", `--delay=${delayMs}`, ...steamIds];
      // Base time for Hero startup + navigation, plus per-profile fetch + delay
      const timeoutMs = 120_000 + steamIds.length * (delayMs + 5_000);

      debug("hero", "Spawn:", nodeBinary, cliArgs, "timeout:", timeoutMs);

      const child = spawn(nodeBinary, cliArgs, {
        env,
        timeout: timeoutMs,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      child.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        debug("hero", "▶", text.trim());
      });

      // Drain stderr (the CLI logs there); an unread pipe can eventually block the child
      child.stderr?.on("data", (data: Buffer) => {
        debug("hero", "stderr:", data.toString().trim());
      });

      child.on("close", (code) => {
        debug("hero", "Exit code:", code);
        if (code === 0 && stdout) {
          try {
            const response = extractResponse(stdout);
            if (response && "type" in response && response.type === "scrape") {
              debug("hero", "Parsed", Object.keys(response.data).length, "profiles");
              const results = new Map<string, LeetifyProfile>();
              for (const [id, profile] of Object.entries(response.data)) {
                if (profile) results.set(id, profile);
              }
              resolve(results);
            } else {
              debug("hero", "No scrape result in output:", response ?? "(no JSON line found)");
              resolve(new Map());
            }
          } catch {
            debug("hero", "Hero stdout (unparseable):", stdout);
            resolve(new Map());
          }
        } else {
          resolve(new Map());
        }
      });

      child.on("error", (err) => {
        debug("hero", "Spawn error:", err);
        resolve(new Map());
      });
    });
  } catch {
    return new Map();
  }
}
