// Opens Steam's friends list window when it is closed, so steam-ui.ts has something to read.
//
// The window only exists while it is open, and without it the friends in the match can't be found. This asks Steam
// to open it ("steam://open/friends", the same thing Steam's own menu does) and then waits a few seconds for it to
// show up. It never closes or changes anything. It is polite about it: a minimum gap between tries, a budget per
// match, one try at a time, and nothing at all when the debug port isn't reachable or the setting is off.

/** The only address this module ever opens. */
export const FRIENDS_WINDOW_URL = "steam://open/friends";

export type WindowState = "open" | "closed" | "unreachable";

export type EnsureResult =
  | "open"        // it was already open
  | "opened"      // we opened it and it showed up
  | "no-show"     // we asked, and it didn't show up in time
  | "failed"      // the system refused to open the address
  | "disabled"    // the setting is off
  | "unreachable" // no debug port, so we couldn't tell (or read it afterwards)
  | "wait"        // tried too recently
  | "limit"       // tried enough for this match
  | "busy";       // another try is running

export interface FriendsWindowDeps {
  /** Opens an address with the system (Electron's shell.openExternal). */
  open: (url: string) => void | Promise<void>;
  /** Whether Steam's friends list window is open, from the debug port. */
  windowState: () => Promise<WindowState>;
  /** The "open it for me" setting. */
  enabled: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Least time between two tries (ms). */
  minGapMs?: number;
  /** Tries allowed per match. */
  maxPerMatch?: number;
  /** How long to wait for the window to appear after asking (ms), and how often to look. */
  waitMs?: number;
  pollMs?: number;
}

/** What the game source needs from the opener (and what tests replace). */
export interface FriendsWindow {
  ensure(reason: "start" | "warmup"): Promise<EnsureResult>;
  /** A new match began: the budget starts again. */
  newMatch(): void;
}

export class FriendsWindowOpener implements FriendsWindow {
  private lastTry: number | null = null;
  private tries = 0;
  private busy = false;

  constructor(private d: FriendsWindowDeps) {}

  private get now(): number {
    return (this.d.now ?? Date.now)();
  }

  newMatch(): void {
    this.tries = 0;
  }

  async ensure(_reason: "start" | "warmup"): Promise<EnsureResult> {
    if (!this.d.enabled()) return "disabled";
    if (this.busy) return "busy";
    this.busy = true;
    try {
      const state = await this.d.windowState();
      if (state === "unreachable") return "unreachable";
      if (state === "open") return "open";
      if (this.lastTry != null && this.now - this.lastTry < (this.d.minGapMs ?? 60_000)) return "wait";
      if (this.tries >= (this.d.maxPerMatch ?? 3)) return "limit";
      this.lastTry = this.now;
      this.tries++;
      try {
        await this.d.open(FRIENDS_WINDOW_URL);
      } catch {
        return "failed";
      }
      const sleep = this.d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
      const pollMs = this.d.pollMs ?? 500;
      for (let waited = 0; waited < (this.d.waitMs ?? 5_000); waited += pollMs) {
        await sleep(pollMs);
        const s = await this.d.windowState();
        if (s === "open") return "opened";
        if (s === "unreachable") return "unreachable";
      }
      return "no-show";
    } finally {
      this.busy = false;
    }
  }
}
