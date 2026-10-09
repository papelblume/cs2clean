// The app's API as the windows see it. Inside the app it comes from the preload script; in a plain
// browser (`npm run dev:ui`) a simulation stands in, so every screen can be looked at without the app.
// Pick a screen with ?screen=nokey | lobby | detail | player | waiting | problem (default: lobby).

import { DEFAULT_HOTKEYS, hotkeyProblem } from "../shared/hotkeys";
import { listOrder } from "../shared/lobby-order";
import type { PlayerReputation } from "../shared/reputation-types";
import type { AppState, Bridge, LobbyRow, MatchSummary, PlayerDetail, PlayerMetrics } from "../shared/types";

declare global {
  interface Window {
    cheatscanner?: Bridge;
  }
}

const ROSTER: [string, "T" | "CT", LobbyRow["classification"], number, LobbyRow["status"]][] = [
  ["Nova", "CT", "NORMAL", 30, "ok"],
  ["Kestrel", "CT", "NORMAL", 18, "ok"],
  ["mintleaf", "CT", "INSUFFICIENT_DATA", 3, "ok"],
  ["Oberon_7", "CT", "ELEVATED", 28, "ok"],
  ["pixelwolf", "CT", "NORMAL", 27, "ok"],
  ["Brakk", "T", "VERY_HIGH", 30, "ok"],
  ["n0va", "T", "VERY_HIGH", 0, "ok"],
  ["sundial", "T", null, 0, "loading"],
  ["Tamsin", "T", null, 0, "no-steam-id"],
  ["quietfox", "T", "NORMAL", 33, "ok"],
  ["late_joiner", "CT", null, 0, "skipped"],   // beyond the first 10 players: not looked up
  ["late_joiner2", "T", null, 0, "skipped"],
];

/** A typical player's Leetify numbers (as the API sends them), with overrides. */
const metrics = (o: Partial<PlayerMetrics> = {}): PlayerMetrics => ({
  leetify: 0.4, aim: 48.2, positioning: 47.9, utility: 45.1, clutch: 0.02, opening: -0.01,
  preaim: 11.8, reactionMs: 612, headAccuracy: 15.2, sprayAccuracy: 34.7,
  spottedAccuracy: 38.5, counterStrafing: 68.4,
  ctOpeningDuel: 47, tOpeningDuel: 46, premier: 14800, totalMatches: 420, winrate: 0.55, ...o,
});

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const matchesOf = (avgRating: number, strongShare: number, ratings: number[]): MatchSummary => ({
  count: 30, avgRating, strongShare,
  recent: ratings.map((rating, i) => ({ map: ["de_mirage", "de_ancient", "de_inferno", "de_nuke", "de_dust2"][i % 5], rating, playedAt: daysAgo(1 + i * 2) })),
});

const DETAIL: Record<string, PlayerDetail> = {
  Brakk: {
    score: 91, levels: { rating: "HIGH", aim: "HIGH", clutch: "MEDIUM" },
    metrics: metrics({ leetify: 7.1, aim: 98.3, positioning: 31.2, utility: 12.5, clutch: 0.24, opening: 0.09, preaim: 3.1, reactionMs: 290,
                       headAccuracy: 54.8, sprayAccuracy: 69.2, counterStrafing: 41.3, ctOpeningDuel: 71, tOpeningDuel: 70, premier: 9000, totalMatches: 61 }),
    matches: matchesOf(7.8, 0.87, [9.4, 6.1, 8.2, 7.7, 8.9]),
  },
  Oberon_7: {
    score: 44, levels: { rating: "MEDIUM", aim: "MEDIUM", clutch: "LOW" },
    metrics: metrics({ leetify: 3.1, aim: 71.2, positioning: 62.5, utility: 55.4, clutch: 0.1, preaim: 6.9, reactionMs: 520, headAccuracy: 41.2, totalMatches: 380 }),
    matches: matchesOf(3.1, 0.4, [4.4, 1.2, 3.9]),
  },
  // A private profile: the card is built from the aggregates alone, with no match rows.
  Kestrel: {
    score: 31, levels: { rating: "MEDIUM", aim: "MEDIUM", clutch: "LOW" },
    metrics: metrics({ leetify: 2.4, aim: 66.3, clutch: 0.09, totalMatches: 912 }),
    matches: null,
  },
};

/** What an unremarkable player's card looks like; everyone without their own entry above gets it. */
const ordinary = (): PlayerDetail => ({
  score: 12, levels: { rating: "LOW", aim: "LOW", clutch: "LOW" }, metrics: metrics(), matches: matchesOf(0.4, 0.1, [-1.2, 2, 0.4]),
});

const REPUTATION: Record<string, PlayerReputation> = {
  Brakk: {
    score: 14, tier: "VERY_SUSPICIOUS", confidence: 1,
    reasons: ["Crosshair placement (3.1°) is unusually tight for this rank", "Time to damage (290 ms) is unusually fast for this rank",
              "Aim rating 98 but positioning 31 and utility 13"],
  },
  Oberon_7: { score: 58, tier: "WATCH", confidence: 0.9, reasons: ["Head accuracy (41.2%) is unusually high for this rank"] },
  n0va: { score: 0, tier: "BANNED", confidence: 1, reasons: ["Ban on record (faceit) since 2026-08-14"] },
};
const TRUSTED: PlayerReputation = { score: 100, tier: "TRUSTED", confidence: 1, reasons: [] };

function simulated(): Bridge {
  const screen = new URLSearchParams(location.search).get("screen") ?? "lobby";
  const inGame = screen === "lobby" || screen === "detail" || screen === "player";
  let state: AppState = {
    version: "0.1.0",
    leetify: { hasKey: screen !== "nokey", reachable: true },
    notice: null,
    game: {
      source: "steam",
      running: inGame || screen === "waiting",
      problem: screen === "problem"
        ? "Steam isn't running (or isn't signed in). Start Steam and try again."
        : null,
    },
    match: inGame ? { map: "de_mirage", mode: "premier", phase: "warmup" } : null,
    lobby: {
      rows: inGame ? ROSTER.map(([name, side, classification, totalMatches, status], slot) => ({
        slot, name, side, classification, totalMatches, status, isLocal: slot === 0,
        detail: DETAIL[name] ?? (totalMatches >= 20 ? ordinary() : null),
        reputation: REPUTATION[name] ?? (totalMatches >= 20 ? TRUSTED : null),
        note: status === "skipped" ? "Not checked: only the first 10 players of a lobby are looked up"
          : classification === "INSUFFICIENT_DATA" ? "Only 3 Leetify matches" : name === "n0va" ? "Ban on record (faceit) since 2026-08-14" : null,
        steamId: status === "no-steam-id" ? null : String(76561198000000001n + BigInt(slot)),
      })) : [],
      updatedAt: inGame ? new Date().toISOString() : null,
      error: null,
    },
    overlay: {
      hotkey: DEFAULT_HOTKEYS.lobby, detailHotkey: DEFAULT_HOTKEYS.detail, cycleHotkey: DEFAULT_HOTKEYS.cycle, previousHotkey: DEFAULT_HOTKEYS.previous, mode: "window", visible: false,
      view: screen === "detail" ? "detail" : screen === "player" ? "player" : "lobby", focusSlot: screen === "player" ? 1 : null, siren: true,
    },
    hotkeysEditable: true,
    startWithWindows: false,
    alert: { seq: 0, names: [] },
  };
  const listeners = new Set<(s: AppState) => void>();
  const set = (patch: Partial<AppState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state));
  };
  /** The same walk through the players as the real controller's F6 / F5. */
  const step = (dir: 1 | -1) => {
    const o = state.overlay, order = listOrder(state.lobby.rows);
    const running = o.visible && o.view === "player";
    const at = running && o.focusSlot !== null ? order.findIndex((r) => r.slot === o.focusSlot) : -1;
    const next = at < 0 ? (dir === 1 ? 0 : order.length - 1) : at + dir;
    if (running && (next < 0 || next >= order.length) && (at >= 0 || order.length === 0)) set({ overlay: { ...o, visible: false, focusSlot: null } });
    else set({ overlay: { ...o, visible: true, view: "player", focusSlot: order[next]?.slot ?? null } });
  };
  return {
    getState: async () => state,
    onState: (l) => (listeners.add(l), () => listeners.delete(l)),
    setApiKey: async (key) => (set({ leetify: { ...state.leetify, hasKey: key.trim() !== "" } }), key.trim() !== ""),
    clearApiKey: async () => set({ leetify: { ...state.leetify, hasKey: false } }),
    setHotkey: async (which, hotkey) => {
      const problem = hotkeyProblem(hotkey);
      const field = { lobby: "hotkey", detail: "detailHotkey", cycle: "cycleHotkey", previous: "previousHotkey" }[which];
      set(problem ? { notice: problem } : { notice: null, overlay: { ...state.overlay, [field]: hotkey } });
      return !problem;
    },
    resetHotkeys: async () => (set({ overlay: { ...state.overlay, hotkey: DEFAULT_HOTKEYS.lobby, detailHotkey: DEFAULT_HOTKEYS.detail, cycleHotkey: DEFAULT_HOTKEYS.cycle, previousHotkey: DEFAULT_HOTKEYS.previous } }), true),
    pauseHotkeys: async () => {},
    setStartWithWindows: async (on) => set({ startWithWindows: on }),
    toggleOverlay: async () => set({ overlay: { ...state.overlay, visible: !state.overlay.visible, view: "lobby" } }),
    toggleDetail: async () => set({ overlay: { ...state.overlay, visible: true, view: state.overlay.view === "detail" ? "lobby" : "detail" } }),
    cyclePlayer: async () => step(1),
    previousPlayer: async () => step(-1),
    setSiren: async (siren) => set({ overlay: { ...state.overlay, siren } }),
    testSiren: async () => set({ alert: { seq: state.alert.seq + 1, names: [] } }),
    openPlayer: async () => {},
    openLeetify: async () => {},
    openDeveloperPage: async () => {},
  };
}

export const bridge: Bridge = window.cheatscanner ?? simulated();
