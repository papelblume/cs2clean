// The app's API as the windows see it. Inside the app it comes from the preload script; in a plain
// browser (`npm run dev:ui`) a simulation stands in, so every screen can be looked at without the app.
// Pick a screen with ?screen=nokey | lobby | detail | player | waiting | problem (default: lobby).

import { DEFAULT_HOTKEYS, hotkeyProblem } from "../shared/hotkeys";
import { cycleOrder } from "../shared/lobby-order";
import type { PlayerReputation } from "../shared/reputation-types";
import type { AppState, Bridge, LobbyRow, PlayerDetail } from "../shared/types";

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
];

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const DETAIL: Record<string, PlayerDetail> = {
  Brakk: {
    score: 91, avgRating: 7.8, strongShare: 0.87, aim: 93.5, clutch: 24.1,
    levels: { rating: "HIGH", aim: "HIGH", clutch: "MEDIUM" },
    recent: [
      { map: "de_mirage", rating: 9.4, playedAt: daysAgo(3) },
      { map: "de_ancient", rating: 6.1, playedAt: daysAgo(5) },
      { map: "de_inferno", rating: 8.2, playedAt: daysAgo(7) },
    ],
  },
  Oberon_7: {
    score: 44, avgRating: 3.1, strongShare: 0.4, aim: 71.2, clutch: 9.8,
    levels: { rating: "MEDIUM", aim: "MEDIUM", clutch: "LOW" },
    recent: [{ map: "de_nuke", rating: 4.4, playedAt: daysAgo(12) }],
  },
};

/** What an unremarkable player's card looks like; everyone without their own entry above gets it. */
const ordinary = (): PlayerDetail => ({
  score: 12, avgRating: 0.4, strongShare: 0.1, aim: 48.2, clutch: 1.3,
  levels: { rating: "LOW", aim: "LOW", clutch: "LOW" },
  recent: [
    { map: "de_inferno", rating: -1.2, playedAt: daysAgo(1) },
    { map: "de_mirage", rating: 2, playedAt: daysAgo(2) },
    { map: "de_dust2", rating: 0.4, playedAt: daysAgo(4) },
  ],
});

const REPUTATION: Record<string, PlayerReputation> = {
  Brakk: {
    score: 14, tier: "VERY_SUSPICIOUS", confidence: 1,
    reasons: ["Crosshair placement (preaim 3.1°) is unusually tight for this rank", "Reaction time of 290 ms is unusually fast for this rank",
              "The newest 10 matches are 2.1 standard deviations better than the 20 before"],
  },
  Oberon_7: { score: 58, tier: "WATCH", confidence: 0.9, reasons: ["Headshot accuracy of 41.2% is unusually high for this rank"] },
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
      rows: inGame ? ROSTER.map(([name, side, classification, matchesAnalyzed, status], slot) => ({
        slot, name, side, classification, matchesAnalyzed, status, isLocal: slot === 0,
        detail: DETAIL[name] ?? (matchesAnalyzed >= 10 ? ordinary() : null),
        reputation: REPUTATION[name] ?? (matchesAnalyzed >= 10 ? TRUSTED : null),
        note: classification === "INSUFFICIENT_DATA" ? "Private Leetify profile" : name === "n0va" ? "Ban on record (faceit) since 2026-08-14" : null,
        steamId: status === "no-steam-id" ? null : String(76561198000000001n + BigInt(slot)),
      })) : [],
      updatedAt: inGame ? new Date().toISOString() : null,
      error: null,
    },
    overlay: {
      hotkey: DEFAULT_HOTKEYS.lobby, detailHotkey: DEFAULT_HOTKEYS.detail, cycleHotkey: DEFAULT_HOTKEYS.cycle, mode: "window", visible: false,
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
  return {
    getState: async () => state,
    onState: (l) => (listeners.add(l), () => listeners.delete(l)),
    setApiKey: async (key) => (set({ leetify: { ...state.leetify, hasKey: key.trim() !== "" } }), key.trim() !== ""),
    clearApiKey: async () => set({ leetify: { ...state.leetify, hasKey: false } }),
    setHotkey: async (which, hotkey) => {
      const problem = hotkeyProblem(hotkey);
      const field = { lobby: "hotkey", detail: "detailHotkey", cycle: "cycleHotkey" }[which];
      set(problem ? { notice: problem } : { notice: null, overlay: { ...state.overlay, [field]: hotkey } });
      return !problem;
    },
    resetHotkeys: async () => (set({ overlay: { ...state.overlay, hotkey: DEFAULT_HOTKEYS.lobby, detailHotkey: DEFAULT_HOTKEYS.detail, cycleHotkey: DEFAULT_HOTKEYS.cycle } }), true),
    pauseHotkeys: async () => {},
    setStartWithWindows: async (on) => set({ startWithWindows: on }),
    toggleOverlay: async () => set({ overlay: { ...state.overlay, visible: !state.overlay.visible, view: "lobby" } }),
    toggleDetail: async () => set({ overlay: { ...state.overlay, visible: true, view: state.overlay.view === "detail" ? "lobby" : "detail" } }),
    cyclePlayer: async () => {
      const o = state.overlay, order = cycleOrder(state.lobby.rows);
      const at = o.visible && o.view === "player" ? order.findIndex((r) => r.slot === o.focusSlot) : -1;
      if (o.visible && o.view === "player" && at + 1 >= order.length) set({ overlay: { ...o, visible: false, focusSlot: null } });
      else set({ overlay: { ...o, visible: true, view: "player", focusSlot: order[at + 1]?.slot ?? null } });
    },
    setSiren: async (siren) => set({ overlay: { ...state.overlay, siren } }),
    testSiren: async () => set({ alert: { seq: state.alert.seq + 1, names: [] } }),
    openPlayer: async () => {},
  };
}

export const bridge: Bridge = window.cheatscanner ?? simulated();
