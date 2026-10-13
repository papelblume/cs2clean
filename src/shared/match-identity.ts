// Whether two announcements of the lobby are the same match. The game source announces the match again on every
// game-state post and every scan, and what it knows grows as it goes: the roster can be found before the game
// reports the map, a player is found late. Per-match state (the siren's "already alerted" list, the card the overlay
// shows, the lobby's per-match lookups) must reset when another match begins, and only then.
//
// Pure, so the controller and the lobby service apply the same rule.

import type { MatchState } from "./types";

/** The Steam IDs of a match's other players: not the local player, not players the game gave no Steam ID. */
function opponents(m: MatchState, localSteamId?: string | null): Set<string> {
  return new Set(
    m.players.flatMap((p) =>
      p.steamId && !p.isLocal && p.steamId !== m.localSteamId && p.steamId !== localSteamId ? [p.steamId] : []),
  );
}

/**
 * True when `next` is the match `prev` already described, announced again with newer data; false when another
 * match began (or one began, or ended, since `prev`). Both null is "still no match".
 *
 * - A map or mode that is known on both sides and differs is another match. One that is unknown on either side says
 *   nothing: the map name can arrive after the roster (or the other way round) within the same match.
 * - On the same map and mode, two games in a row are told apart by their players: another match when both lobbies
 *   have other players and none of them is in both. With nobody to compare there is nothing that says otherwise.
 *
 * `localSteamId`: our own Steam ID when the caller knows it better than the match does.
 */
export function isSameMatch(prev: MatchState | null, next: MatchState | null, localSteamId?: string | null): boolean {
  if (!prev || !next) return !prev && !next;
  if (prev.map && next.map && prev.map !== next.map) return false;
  if (prev.mode && next.mode && prev.mode !== next.mode) return false;
  const before = opponents(prev, localSteamId), after = opponents(next, localSteamId);
  if (before.size === 0 || after.size === 0) return true;
  return [...after].some((id) => before.has(id));
}
