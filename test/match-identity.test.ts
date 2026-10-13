import { describe, expect, it } from "vitest";
import { isSameMatch } from "../src/shared/match-identity";
import type { MatchState, RosterPlayer } from "../src/shared/types";

const ME = "76561198000000000";
const id = (n: number) => String(76561198000000000n + BigInt(n));
const player = (steamId: string | null, o: Partial<RosterPlayer> = {}): RosterPlayer => ({ slot: 0, name: "p", steamId, side: null, isLocal: false, ...o });
/** A lobby: me, and the players with these numbers. */
const lobby = (map: string | null, mode: string | null, ...others: number[]): MatchState => ({
  map, mode, phase: "warmup", localSteamId: ME, players: [player(ME, { isLocal: true }), ...others.map((n) => player(id(n)))],
});

describe("isSameMatch", () => {
  it("knows no match from no match, and a beginning or an end from a match", () => {
    expect(isSameMatch(null, null)).toBe(true);
    expect(isSameMatch(null, lobby("de_dust2", "competitive", 1, 2))).toBe(false);
    expect(isSameMatch(lobby("de_dust2", "competitive", 1, 2), null)).toBe(false);
  });

  it("is the same match when it is announced again, also with more players found", () => {
    expect(isSameMatch(lobby("de_dust2", "competitive", 1, 2), lobby("de_dust2", "competitive", 1, 2))).toBe(true);
    expect(isSameMatch(lobby("de_dust2", "competitive", 1, 2), lobby("de_dust2", "competitive", 1, 2, 3, 4))).toBe(true);
    expect(isSameMatch(lobby("de_dust2", "competitive", 1, 2, 3), lobby("de_dust2", "competitive", 3))).toBe(true); // others left
  });

  it("is the same match when the map or mode name arrives after the roster, or goes missing for a moment", () => {
    expect(isSameMatch(lobby(null, null, 1, 2), lobby("de_mirage", "premier", 1, 2))).toBe(true);
    expect(isSameMatch(lobby("de_mirage", null, 1, 2), lobby("de_mirage", "premier", 1, 2))).toBe(true);
    expect(isSameMatch(lobby("de_mirage", "premier", 1, 2), lobby(null, null, 1, 2))).toBe(true);
  });

  it("is another match on another map or mode, whoever is in it", () => {
    expect(isSameMatch(lobby("de_dust2", "competitive", 1, 2), lobby("de_nuke", "competitive", 1, 2))).toBe(false);
    expect(isSameMatch(lobby("de_dust2", "competitive", 1, 2), lobby("de_dust2", "wingman", 1, 2))).toBe(false);
  });

  it("tells two games in a row on the same map apart by their players", () => {
    expect(isSameMatch(lobby("de_dust2", "competitive", 1, 2, 3), lobby("de_dust2", "competitive", 4, 5, 6))).toBe(false);
    // Also when the map name was unknown on one side.
    expect(isSameMatch(lobby(null, null, 1, 2, 3), lobby("de_dust2", "competitive", 4, 5, 6))).toBe(false);
  });

  it("doesn't count yourself as a shared player", () => {
    // Both lobbies hold me, and nobody else in common.
    expect(isSameMatch(lobby("de_dust2", "competitive", 1, 2), lobby("de_dust2", "competitive", 3, 4))).toBe(false);
    // The caller may know our Steam ID better than the match: a player marked neither way still isn't "another player".
    const prev: MatchState = { ...lobby("de_dust2", "competitive", 1), localSteamId: null, players: [player(ME), player(id(1))] };
    const next: MatchState = { ...lobby("de_dust2", "competitive", 2), localSteamId: null, players: [player(ME), player(id(2))] };
    expect(isSameMatch(prev, next)).toBe(true);        // ME looks like an opponent both lobbies share
    expect(isSameMatch(prev, next, ME)).toBe(false);
  });

  it("has nothing to say against a match while one side has no other players or no Steam IDs", () => {
    expect(isSameMatch(lobby("de_dust2", "competitive"), lobby("de_dust2", "competitive", 1, 2))).toBe(true);
    const unknown: MatchState = { ...lobby("de_dust2", "competitive"), players: [player(ME, { isLocal: true }), player(null), player(null)] };
    expect(isSameMatch(unknown, lobby("de_dust2", "competitive", 1, 2))).toBe(true);
  });
});
