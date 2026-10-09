// The order the players are listed in on screen (CT, then T, then players whose side isn't known). The cycle
// hotkey (F6/Shift+F6) steps through the same order, yourself included. Pure, so the main process and the
// overlay agree.

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
