// The order the players are listed in on screen (CT, then T, then players whose side isn't known), and the order
// the cycle hotkey steps through them: the same, without the local player. Pure, so the main process and the
// overlay agree on it.

import type { LobbyRow } from "./types";

export function listOrder(rows: LobbyRow[]): LobbyRow[] {
  return [
    ...rows.filter((r) => r.side === "CT"),
    ...rows.filter((r) => r.side === "T"),
    ...rows.filter((r) => !r.side),
  ];
}

/** Every player but yourself, in list order. */
export function cycleOrder(rows: LobbyRow[]): LobbyRow[] {
  return listOrder(rows).filter((r) => !r.isLocal);
}
