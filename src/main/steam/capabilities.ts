// What the app can use right now to find friends in the match, and why not when it can't.
//
//   - Steam's debug port: Steam's web helper serves Chrome's DevTools protocol on localhost when Steam was started
//     with -cef-enable-debugging or with an empty ".cef-enable-remote-debugging" file in its folder (steam-ui.ts reads
//     the friends list through it). Steam's command line says whether the flag is on and which port it uses: on
//     Linux that is readable from /proc (steamwebhelper ... --remote-debugging-port=8080); on Windows only the port
//     itself can be probed.
//   - CS2's console.log: CS2 writes it when launched with -condebug. It is "active" when it has been written to since
//     this CS2 session began.
//
// Everything that touches the system goes through an `io` object, so the decisions are testable.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { findCs2CfgDir, steamPath } from "./gsi";
import { DEFAULT_DEBUG_PORT, findFriendsTarget, listDebugTargets } from "./steam-ui";

/** The empty file that turns the debug port on when Steam starts. */
export const CEF_FLAG_FILE = ".cef-enable-remote-debugging";

// ------------------------------------------------------------------ Steam's debug port

/** The port in Steam's web helper command line ("--remote-debugging-port=8080"), or null. */
export function debugPortFromArgs(args: readonly string[]): number | null {
  for (const a of args) {
    const m = /^--remote-debugging-port=(\d{1,5})$/.exec(a);
    if (m && Number(m[1]) > 0 && Number(m[1]) < 65536) return Number(m[1]);
  }
  return null;
}

export interface SteamProcesses {
  /** Steam's web helper is running, which means Steam is. */
  steamRunning: boolean;
  /** The debug port its command line asks for; null when it doesn't ask for one. */
  debugPort: number | null;
}

/** Looks through /proc for Steam's web helper processes. Null where /proc isn't available (not Linux). */
export function scanSteamProcesses(procDir = "/proc"): SteamProcesses | null {
  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return null;
  }
  let steamRunning = false;
  let debugPort: number | null = null;
  for (const pid of entries) {
    if (!/^\d+$/.test(pid)) continue;
    let args: string[];
    try {
      args = readFileSync(join(procDir, pid, "cmdline"), "utf8").split("\0").filter(Boolean);
    } catch {
      continue; // gone, or not ours to read
    }
    if (basename(args[0] ?? "") !== "steamwebhelper") continue;
    steamRunning = true;
    debugPort ??= debugPortFromArgs(args);
  }
  return { steamRunning, debugPort };
}

export type CefState =
  /** The port answers: the friends list can be read once its window is open. */
  | "reachable"
  /** Steam runs without the flag, but the flag file is there: Steam only reads it at start-up. */
  | "restart-steam"
  /** Steam runs without the flag and there is no flag file. */
  | "off"
  | "steam-not-running"
  /** The port is closed and Steam's command line can't tell why (Windows), or it asks for a port that doesn't answer. */
  | "unknown";

export interface CefCapability {
  state: CefState;
  port: number;
  /** Whether the friends list window is open; null when the port isn't reachable. */
  friendsWindow: boolean | null;
}

export interface CefIo {
  /** Asks the debug port which pages it lists. */
  probe: (port: number) => Promise<{ reachable: boolean; friendsWindow: boolean }>;
  processes: () => SteamProcesses | null;
  flagFile: () => boolean;
  /** CS2CLEAN_DEBUG_PORT, when set. */
  envPort?: number | null;
}

export async function detectCef(io: CefIo): Promise<CefCapability> {
  const procs = io.processes();
  const port = procs?.debugPort ?? io.envPort ?? DEFAULT_DEBUG_PORT;
  const probed = await io.probe(port);
  if (probed.reachable) return { state: "reachable", port, friendsWindow: probed.friendsWindow };
  const closed = { port, friendsWindow: null };
  if (!procs) return { state: "unknown", ...closed };
  if (!procs.steamRunning) return { state: "steam-not-running", ...closed };
  if (procs.debugPort != null) return { state: "unknown", ...closed };
  return { state: io.flagFile() ? "restart-steam" : "off", ...closed };
}

/** The real thing: /proc and the debug port on this PC. */
export function systemCefIo(): CefIo {
  return {
    probe: async (port) => {
      const r = await listDebugTargets(port);
      return r.ok ? { reachable: true, friendsWindow: findFriendsTarget(r.targets) != null } : { reachable: false, friendsWindow: false };
    },
    processes: () => (process.platform === "linux" ? scanSteamProcesses() : null),
    flagFile: () => {
      const dir = steamPath();
      return !!dir && existsSync(join(dir, CEF_FLAG_FILE));
    },
    envPort: Number(process.env.CS2CLEAN_DEBUG_PORT) || null,
  };
}

// ------------------------------------------------------------------ CS2's console.log

export type ConsoleLogState =
  /** Written to since this CS2 session began: CS2 runs with -condebug. */
  | "active"
  /** There, but not written to this session (CS2 isn't running, or runs without -condebug). */
  | "inactive"
  /** CS2's folder has no console.log: -condebug was never used. */
  | "missing"
  | "not-found";

export interface ConsoleLogCapability {
  state: ConsoleLogState;
  path: string | null;
}

/** CS2's console.log: next to its cfg folder, in game/csgo. Null when CS2's folder isn't found. */
export function findCs2ConsoleLog(cfgDir: string | null = findCs2CfgDir()): string | null {
  return cfgDir ? join(dirname(cfgDir), "console.log") : null;
}

export function detectConsoleLog(o: { path: string | null; mtimeMs: number | null; sessionStartMs: number | null }): ConsoleLogCapability {
  if (!o.path) return { state: "not-found", path: null };
  if (o.mtimeMs == null) return { state: "missing", path: o.path };
  return { state: o.sessionStartMs != null && o.mtimeMs >= o.sessionStartMs ? "active" : "inactive", path: o.path };
}

/** Looks at the real console.log. `sessionStartMs` is when CS2's current session began (null when it isn't running). */
export function systemConsoleLog(sessionStartMs: number | null, path = findCs2ConsoleLog()): ConsoleLogCapability {
  let mtimeMs: number | null = null;
  if (path) {
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      /* no such file */
    }
  }
  return detectConsoleLog({ path, mtimeMs, sessionStartMs });
}

// ------------------------------------------------------------------ wording

/** One line about the friends list, or null when nothing needs saying. `autoOpen` is the "open it for me" setting. */
export function cefHint(c: CefCapability, autoOpen: boolean): string | null {
  switch (c.state) {
    case "reachable":
      return c.friendsWindow === false && !autoOpen
        ? "Steam's friends list window is closed. Open it (Shift+Tab or View > Friends) so the app can read your friends' status."
        : null;
    case "restart-steam":
      return `Steam is running without the debug port, but the ${CEF_FLAG_FILE} file is there. Quit Steam fully and start it again.`;
    case "off":
      return `Steam's debug port is off. Create an empty file named ${CEF_FLAG_FILE} in Steam's folder (or start Steam with -cef-enable-debugging), then restart Steam.`;
    case "steam-not-running":
      return "Steam isn't running.";
    case "unknown":
      return `Nothing answers on Steam's debug port (127.0.0.1:${c.port}). Start Steam with -cef-enable-debugging, or create an empty ${CEF_FLAG_FILE} file in Steam's folder and restart it.`;
  }
}

export interface HintInput {
  cef: CefCapability;
  log: ConsoleLogCapability;
  /** The user has run `status` in this match. */
  statusSeen: boolean;
  /** The "open Steam's friends list for me" setting. */
  autoOpen: boolean;
}

/**
 * The line shown while friends are playing CS2 and a slot of the match is empty: what would find them. Nothing when
 * the friends list will do it by itself (the debug port answers and its window is, or will be, open) and once
 * `status` has been run. Otherwise it points at `status`, with what it needs when that isn't set up yet.
 */
export function friendsHint(i: HintInput): string | null {
  const automatic = i.cef.state === "reachable" && (i.cef.friendsWindow === true || i.autoOpen);
  if (automatic || i.statusSeen) return null;
  if (i.log.state === "active")
    return "Friends of yours are playing CS2. Run `status` in the CS2 console to find the ones in your match (tip: `bind <key> status` once, then press that key).";
  const cef = cefHint(i.cef, i.autoOpen);
  return `Friends of yours are playing CS2, but can't be found automatically. ${cef ? `${cef} ` : ""}Or launch CS2 with -condebug and run \`status\` in its console.`;
}

/** The capabilities as lines for `npm run friends-ui`. */
export function describeCapabilities(cef: CefCapability, log: ConsoleLogCapability, autoOpen: boolean): string[] {
  const lines = [
    `Steam debug port (127.0.0.1:${cef.port}): ${cef.state}${cef.state === "reachable" ? `, friends list window ${cef.friendsWindow ? "open" : "closed"}` : ""}`,
  ];
  const hint = cefHint(cef, autoOpen);
  if (hint) lines.push(`  ${hint}`);
  lines.push(`CS2 console.log (${log.path ?? "CS2's folder not found"}): ${log.state}`);
  if (log.state === "missing") lines.push("  Launch CS2 with -condebug to have it written.");
  return lines;
}
