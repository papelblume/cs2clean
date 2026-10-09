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

/** "skipped": beyond the first players of a big lobby, which are the only ones looked up (see main/lobby.ts). */
export type RowStatus = "loading" | "ok" | "no-steam-id" | "error" | "skipped";

export type AxisLevel = "LOW" | "MEDIUM" | "HIGH";

/**
 * Leetify's own numbers for a player, exactly as the Public API sends them (never rescaled or renamed, as
 * Leetify's developer guidelines ask), or null where the API sent none. The units are the API's: the ratings
 * have none, percentages are 0-100, preaim is degrees, reaction time is milliseconds.
 */
export interface PlayerMetrics {
  /** ranks.leetify: the overall Leetify rating. */
  leetify: number | null;
  aim: number | null;
  positioning: number | null;
  utility: number | null;
  clutch: number | null;
  opening: number | null;
  /** stats.preaim, shown as "Crosshair placement". */
  preaim: number | null;
  /** stats.reaction_time_ms, shown as "Time to damage". */
  reactionMs: number | null;
  headAccuracy: number | null;
  sprayAccuracy: number | null;
  spottedAccuracy: number | null;
  counterStrafing: number | null;
  ctOpeningDuel: number | null;
  tOpeningDuel: number | null;
  premier: number | null;
  /** The matches the profile covers. */
  totalMatches: number | null;
  /** Win rate (0-1 fraction, e.g. 0.55 = 55%). */
  winrate: number | null;
}

/** What the newest matches say, from the per-match data of a public profile. Ours, computed from Leetify's numbers. */
export interface MatchSummary {
  /** Matches that went into it (the newest 30 at most). */
  count: number;
  /** Their average Leetify rating, in the units Leetify's website shows (+5.0 is a strong match). */
  avgRating: number;
  /** Share (0-1) of them with a strong rating. */
  strongShare: number;
  /** The newest few, newest first. */
  recent: { map: string | null; rating: number; playedAt: string | null }[];
}

/** The overlay's extended card (F6 and F7): any player with some rating data. */
export interface PlayerDetail {
  /** Combined performance score, 0-100: how far above average the Leetify rating, aim and clutch are. Ours, not Leetify's. */
  score: number;
  levels: { rating: AxisLevel; aim: AxisLevel; clutch: AxisLevel };
  metrics: PlayerMetrics;
  /** From the per-match data; null when the API sent none (a private profile, or no matches yet). */
  matches: MatchSummary | null;
}

export interface LobbyRow extends RosterPlayer {
  classification: EvidenceClass | null;
  /** The Leetify matches the profile covers (0 when unknown). */
  totalMatches: number;
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
    /** Steps forward through the players one card at a time, flagged or not. */
    cycleHotkey: string;
    /** Steps back through the players the same way. */
    previousHotkey: string;
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
  setHotkey(which: "lobby" | "detail" | "cycle" | "previous", hotkey: string): Promise<boolean>;
  resetHotkeys(): Promise<boolean>;
  setStartWithWindows(on: boolean): Promise<void>;
  /** Turns the hotkeys off while Settings waits for a key press, so the press reaches the page. */
  pauseHotkeys(paused: boolean): Promise<void>;
  toggleOverlay(): Promise<void>;
  toggleDetail(): Promise<void>;
  /** Shows the next player's card; after the last player, hides the overlay. */
  cyclePlayer(): Promise<void>;
  /** Shows the previous player's card (the last one to start with); before the first player, hides the overlay. */
  previousPlayer(): Promise<void>;
  setSiren(on: boolean): Promise<void>;
  testSiren(): Promise<void>;
  openPlayer(steamId: string): Promise<void>;
  /** Opens leetify.com (the "Data Provided by Leetify" link). */
  openLeetify(): Promise<void>;
  /** Opens leetify.com/app/developer (the API key page). */
  openDeveloperPage(): Promise<void>;
}
