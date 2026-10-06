// State shared by the main process and the windows (desktop window and in-game overlay).

import type { PlayerReputation } from "./reputation-types";

/**
 * Classes from a player's public Leetify data: the more severe of how far above average they perform
 * (main/assess.ts) and how implausible their stats look (main/reputation.ts, bans included). They are never
 * "cheater" and never a probability.
 */
export type EvidenceClass = "NORMAL" | "ELEVATED" | "HIGH" | "VERY_HIGH" | "INSUFFICIENT_DATA";

export type Side = "T" | "CT";

/** One player in the current match, as the game reports it. */
export interface RosterPlayer {
  /** Position in Overwolf's roster (roster_0 .. roster_N). */
  slot: number;
  name: string;
  /** SteamID64 as a string. Null when the game didn't give one (bots, or a roster Overwolf couldn't fill). */
  steamId: string | null;
  side: Side | null;
  isLocal: boolean;
}

/** Map phase from the game: warm-up, then live once the match starts. */
export type MatchPhase = "warmup" | "live" | "intermission" | "gameover";

export interface MatchState {
  map: string | null;
  mode: string | null;
  phase: MatchPhase | null;
  localSteamId: string | null;
  players: RosterPlayer[];
}

export type RowStatus = "loading" | "ok" | "no-steam-id" | "error";

export type AxisLevel = "LOW" | "MEDIUM" | "HIGH";

/** The overlay's extended card (F6 and F7): the performance numbers of any player with enough recent matches. */
export interface PlayerDetail {
  /** Combined performance score, 0-100. How far above average, not a probability of anything. */
  score: number;
  /** Average Leetify rating of the recent matches, in the units Leetify's website shows (+5.0 is a strong match). */
  avgRating: number;
  /** Share (0-1) of the recent matches with a strong rating. */
  strongShare: number;
  /** Leetify aim rating, 0-100. */
  aim: number;
  /** Leetify clutch rating, website units. */
  clutch: number;
  levels: { rating: AxisLevel; aim: AxisLevel; clutch: AxisLevel };
  /** Latest matches, newest first. */
  recent: { map: string | null; rating: number; playedAt: string | null }[];
}

export interface LobbyRow extends RosterPlayer {
  classification: EvidenceClass | null;
  /** Recent Leetify matches the class is based on. */
  matchesAnalyzed: number;
  status: RowStatus;
  detail: PlayerDetail | null;
  /** The 0-100 reputation score, tier and reasons (main/reputation.ts); null when there was no lookup. */
  reputation: PlayerReputation | null;
  /** Why there is no class (private profile, not on Leetify, rate limit...), for a tooltip. */
  note: string | null;
}

export type GameSourceKind = "steam" | "overwolf" | "replay";

export interface AppState {
  version: string;
  leetify: {
    /** An API key is saved (or set in LEETIFY_API_KEY). Lookups also work without one, at stricter rate limits. */
    hasKey: boolean;
    /** null until the first lookup; false when Leetify couldn't be reached. */
    reachable: boolean | null;
  };
  /** Shown once, e.g. "Leetify rejected the API key". */
  notice: string | null;
  game: {
    source: GameSourceKind;
    running: boolean;
    /** Why live data isn't available, in plain words (e.g. no Overwolf developer approval yet). */
    problem: string | null;
  };
  match: { map: string | null; mode: string | null; phase: MatchPhase | null } | null;
  lobby: {
    rows: LobbyRow[];
    updatedAt: string | null;
    error: string | null;
  };
  overlay: {
    hotkey: string;
    /** Shows the extended card of the flagged players. */
    detailHotkey: string;
    /** Steps through the players one card at a time, flagged or not. */
    cycleHotkey: string;
    /** "overwolf": drawn in the game by Overwolf; "window": a see-through, click-through window on top of
     *  the game (needs CS2 in "Fullscreen Windowed"). */
    mode: "overwolf" | "window" | "none";
    visible: boolean;
    view: "lobby" | "detail" | "player";
    /** The slot of the player the "player" view shows; null when none (yet). */
    focusSlot: number | null;
    /** Play a siren when a HIGH player is found in the match. */
    siren: boolean;
  };
  /** The overlay hotkeys can be changed in Settings (the app's own overlay window; not with Overwolf). */
  hotkeysEditable: boolean;
  /** Start with Windows, minimized to the taskbar; null where it isn't offered (not an installed app). */
  startWithWindows: boolean | null;
  /** Bumped when a HIGH player is found in the current match; the overlay plays the siren on a change. */
  alert: { seq: number; names: string[] };
}

/** What the windows may ask the main process to do (exposed by the preload script). */
export interface Bridge {
  getState(): Promise<AppState>;
  onState(listener: (state: AppState) => void): () => void;
  /** Checks the key with Leetify and saves it when accepted; false (with a notice) when not. */
  setApiKey(key: string): Promise<boolean>;
  clearApiKey(): Promise<void>;
  /** Changes one overlay hotkey (an Electron accelerator such as "Shift+F2"); false if it can't be used. */
  setHotkey(which: "lobby" | "detail" | "cycle", hotkey: string): Promise<boolean>;
  resetHotkeys(): Promise<boolean>;
  setStartWithWindows(on: boolean): Promise<void>;
  /** Turns the hotkeys off while Settings waits for a key press, so the press reaches the page. */
  pauseHotkeys(paused: boolean): Promise<void>;
  toggleOverlay(): Promise<void>;
  toggleDetail(): Promise<void>;
  /** Shows the next player's card; after the last player, hides the overlay. */
  cyclePlayer(): Promise<void>;
  setSiren(on: boolean): Promise<void>;
  testSiren(): Promise<void>;
  openPlayer(steamId: string): Promise<void>;
}
