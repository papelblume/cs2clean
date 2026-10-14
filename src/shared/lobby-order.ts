// The order the players are listed in on screen (CT, then T, then players whose side isn't known), and the walk the
// cycle hotkeys (F6/Shift+F6) make through them, yourself included. The walk is the list without the players who have
// nothing to show, and the controller regroups it by where each player's data came from, which only the main process
// knows: it publishes the result as `lobby.cycle`. What a key does from a given place, and what the overlay tells
// about it, are decided here, so the overlay's hints can't differ from what the keys do. Pure, so the main process
// and the overlay agree.

import type { EvidenceClass, LobbyRow, RowStatus } from "./types";

/** All players, ordered CT → T → unknown side. */
export function listOrder(rows: LobbyRow[]): LobbyRow[] {
  return [
    ...rows.filter((r) => r.side === "CT"),
    ...rows.filter((r) => r.side === "T"),
    ...rows.filter((r) => !r.side),
  ];
}

/** Players eligible for the F6/Shift+F6 cycle: resolved lookup with usable data. */
const CYCLE_OK: Set<RowStatus> = new Set(["ok"]);
const HAS_DATA: Set<EvidenceClass> = new Set(["NORMAL", "ELEVATED", "HIGH", "VERY_HIGH"]);

export function visibleOrder(rows: LobbyRow[]): LobbyRow[] {
  return listOrder(rows).filter((r) => {
    if (!CYCLE_OK.has(r.status)) return false;
    // Exclude players with no usable data: INSUFFICIENT_DATA and no detail metrics.
    if (r.classification === "INSUFFICIENT_DATA" && !r.detail) return false;
    return true;
  });
}

/** What a press of a cycle key does: hide the overlay, or show a player's card (slot null: there is nobody to show). */
export type CycleStep = { hide: true } | { hide: false; slot: number | null };

/**
 * One press of F6 (`dir` 1) or Shift+F6 (-1) on the walk `slots`, which is showing `focusSlot`. `running`: the overlay
 * is showing the player cards now. Otherwise, or when the player shown isn't in the walk (they left, or have nothing
 * to show any more), the press starts at the first player (F6) or the last (Shift+F6). Past either end of the walk it
 * hides the overlay, and so does any press that has nobody to show once the cards are up.
 */
export function cycleStep(slots: readonly number[], focusSlot: number | null, dir: 1 | -1, running = true): CycleStep {
  const at = running && focusSlot !== null ? slots.indexOf(focusSlot) : -1;
  const next = at < 0 ? (dir === 1 ? 0 : slots.length - 1) : at + dir;
  if (running && (next < 0 || next >= slots.length) && (at >= 0 || slots.length === 0)) return { hide: true };
  return { hide: false, slot: slots[next] ?? null };
}

/** What the overlay tells about the cycle while the player cards are up. */
export interface CycleHints {
  /** Where the card shown is in the walk, counting from 1; null when it isn't one of the walk's players. */
  position: number | null;
  /** How many players the walk has. */
  total: number;
  /** What Shift+F6 does: step "back", jump to the "last" player (from a place that isn't on the walk), or "hide". */
  previous: "back" | "last" | "hide";
  /** What F6 does: step to the "next" player, jump to the "first" one, or "hide". */
  next: "next" | "first" | "hide";
}

export function cycleHints(slots: readonly number[], focusSlot: number | null): CycleHints {
  const at = focusSlot !== null ? slots.indexOf(focusSlot) : -1;
  const previous = cycleStep(slots, focusSlot, -1), next = cycleStep(slots, focusSlot, 1);
  return {
    position: at >= 0 ? at + 1 : null,
    total: slots.length,
    previous: previous.hide ? "hide" : at >= 0 ? "back" : "last",
    next: next.hide ? "hide" : at >= 0 ? "next" : "first",
  };
}
