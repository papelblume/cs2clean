import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchState } from "../src/shared/types";
import { LobbyService } from "../src/main/lobby";

// The Steam Web API call behind the friendship groups; the tests count and steer it.
const groupPlayers = vi.hoisted(() =>
  vi.fn(async (ids: string[], _key: string) => ({ groups: ids.map((id) => [id]), private: [] as string[], errors: [] as string[] })));
vi.mock("../src/main/steam/friends", () => ({ groupPlayers }));

type Grouping = { groups: string[][]; private: string[]; errors: string[] };
/** The next `n` calls of groupPlayers stay open until the test settles them. */
function holdGrouping(n: number) {
  const open: { resolve: (r: Grouping) => void; reject: (e: Error) => void }[] = [];
  for (let i = 0; i < n; i++)
    groupPlayers.mockImplementationOnce(() => new Promise<Grouping>((resolve, reject) => { open.push({ resolve, reject }); }));
  return open;
}

const player = (slot: number, steamId: string | null) => ({ slot, name: `p${slot}`, steamId, side: "CT" as const, isLocal: false });
const match = (...ids: (string | null)[]): MatchState => ({ map: null, mode: null, localSteamId: null, players: ids.map((id, i) => player(i, id)) });
const matchOn = (map: string, ...ids: string[]): MatchState => ({ ...match(...ids), map, mode: "competitive" });

const A = "76561198000000001", B = "76561198000000002", C = "76561198000000003", D = "76561198000000004", E = "76561198000000005";
const ok = (steamId: string) => ({ steamId, classification: "NORMAL" as const, totalMatches: 3 });
const limited = (steamId: string, retryAfterMs: number) =>
  ({ steamId, classification: null, totalMatches: 0, transient: true, retryAfterMs, note: "Leetify's request limit was hit" });

describe("LobbyService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks once for a filling lobby, and not again for known players", async () => {
    const lookup = vi.fn(async (ids: string[]) => ids.map((steamId) => ({ steamId, classification: "NORMAL" as const, totalMatches: 3 })));
    const lobby = new LobbyService(lookup, () => {}, { debounceMs: 100 });
    lobby.setMatch(match("76561198000000001"));
    lobby.setMatch(match("76561198000000001", "76561198000000002", null));
    expect(lobby.rows().map((r) => r.status)).toEqual(["loading", "loading", "no-steam-id"]);
    await vi.advanceTimersByTimeAsync(150);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0]).toEqual(["76561198000000001", "76561198000000002"]);
    expect(lobby.rows()[0]).toMatchObject({ status: "ok", classification: "NORMAL", totalMatches: 3 });

    // Same players again (e.g. a kills update): no new request.
    lobby.setMatch(match("76561198000000002", "76561198000000001"));
    await vi.advanceTimersByTimeAsync(500);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("shows the error and retries", async () => {
    let fail = true;
    const lookup = vi.fn(async (ids: string[]) => {
      if (fail) throw new Error("the server can't be reached");
      return ids.map((steamId) => ({ steamId, classification: "HIGH" as const, totalMatches: 9 }));
    });
    const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10, retryMs: 1000 });
    lobby.setMatch(match("76561198000000001"));
    await vi.advanceTimersByTimeAsync(20);
    expect(lobby.error).toBe("the server can't be reached");
    expect(lobby.rows()[0].status).toBe("error");
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(lobby.error).toBeNull();
    expect(lobby.rows()[0]).toMatchObject({ status: "ok", classification: "HIGH" });
  });

  it("asks again later for a player Leetify rate-limited, and not for the others", async () => {
    let limited = true;
    const lookup = vi.fn(async (ids: string[]) =>
      ids.map((steamId) => steamId === "76561198000000002" && limited
        ? { steamId, classification: null, totalMatches: 0, transient: true, retryAfterMs: 5000, note: "Leetify's request limit was hit" }
        : { steamId, classification: "NORMAL" as const, totalMatches: 30 }));
    const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10, retryMs: 1000 });
    lobby.setMatch(match("76561198000000001", "76561198000000002"));
    await vi.advanceTimersByTimeAsync(20);
    expect(lobby.rows().map((r) => r.status)).toEqual(["ok", "error"]);
    expect(lobby.rows()[1].note).toMatch(/request limit/);
    expect(lobby.error).toMatch(/request limit/);

    await vi.advanceTimersByTimeAsync(4000); // inside Retry-After: nothing yet
    expect(lookup).toHaveBeenCalledTimes(1);
    limited = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[1][0]).toEqual(["76561198000000002"]); // only the one that failed
    expect(lobby.rows().map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(lobby.error).toBeNull();
  });
  // SteamSource re-announces the match on every GSI post and every scan (every 10 s or less). The tests below pass
  // `localSteamId`, as the app does; without it the per-match state that used to be reset on each call stays hidden.
  describe("a match that is announced again", () => {
    beforeEach(() => { groupPlayers.mockClear(); }); // braces: a returned function would run as a teardown

    it("looks the local player up once per match, even if they have no Leetify profile", async () => {
      const lookup = vi.fn(async (ids: string[]) => ids.map((steamId) =>
        steamId === A ? { steamId, classification: null, totalMatches: 0, note: "No Leetify profile" } : ok(steamId)));
      const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10, localSteamId: A });
      for (let i = 0; i < 5; i++) {
        lobby.setMatch(matchOn("de_dust2", A, B));
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup.mock.calls[0][0]).toEqual([A, B]);
    });

    it("groups friends once for an unchanged roster, and again when a player joins", async () => {
      const lookup = vi.fn(async (ids: string[]) => ids.map(ok));
      const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10, localSteamId: A, steamApiKey: "key" });
      lobby.setMatch(matchOn("de_dust2", A, B));
      await vi.advanceTimersByTimeAsync(50);
      expect(groupPlayers).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 4; i++) {
        lobby.setMatch(matchOn("de_dust2", A, B));
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(groupPlayers).toHaveBeenCalledTimes(1);

      // A late joiner must still end up in the groups, although the match itself is the same.
      lobby.setMatch(matchOn("de_dust2", A, B, C));
      await vi.advanceTimersByTimeAsync(50);
      expect(groupPlayers).toHaveBeenCalledTimes(2);
      expect(groupPlayers.mock.calls[1][0]).toEqual([A, B, C]);
    });

    it("keeps a Retry-After backoff, also when the roster changes meanwhile", async () => {
      let limit = true;
      const lookup = vi.fn(async (ids: string[]) => ids.map((id) => (id === B && limit ? limited(id, 60_000) : ok(id))));
      const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10, retryMs: 1000, localSteamId: A });
      lobby.setMatch(matchOn("de_dust2", A, B));
      await vi.advanceTimersByTimeAsync(20);
      expect(lookup).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 5; i++) { // 50 s of heartbeats; C joins from the third on
        lobby.setMatch(i >= 2 ? matchOn("de_dust2", A, B, C) : matchOn("de_dust2", A, B));
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(lookup).toHaveBeenCalledTimes(1);

      limit = false;
      await vi.advanceTimersByTimeAsync(11_000); // past the 60 s
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(lookup.mock.calls[1][0]).toEqual([B, C]);
    });

    it("keeps the retry after a failed lookup, too", async () => {
      let fail = true;
      const lookup = vi.fn(async (ids: string[]) => { if (fail) throw new Error("offline"); return ids.map(ok); });
      const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10, retryMs: 30_000, localSteamId: A });
      lobby.setMatch(matchOn("de_dust2", A, B));
      await vi.advanceTimersByTimeAsync(20);
      for (let i = 0; i < 2; i++) { lobby.setMatch(matchOn("de_dust2", A, B)); await vi.advanceTimersByTimeAsync(10_000); }
      expect(lookup).toHaveBeenCalledTimes(1);
      fail = false;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it("starts fresh for another match: after a gap, on another map, and for a new lobby on the same map", async () => {
      const lookup = vi.fn(async (ids: string[]) => ids.map(ok));
      const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10, localSteamId: A, steamApiKey: "key" });
      const settle = () => vi.advanceTimersByTimeAsync(50);

      lobby.setMatch(matchOn("de_dust2", A, B));
      await settle();
      expect(lookup).toHaveBeenCalledTimes(1);

      lobby.setMatch(null); // the game left the lobby in between
      lobby.setMatch(matchOn("de_dust2", A, B));
      await settle();
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(lookup.mock.calls[1][0]).toEqual([A]); // the local player again; B is still known

      lobby.setMatch(matchOn("de_mirage", A, B));
      await settle();
      expect(lookup).toHaveBeenCalledTimes(3);

      lobby.setMatch(matchOn("de_mirage", A, D, E)); // back to back, same map: none of the old opponents is left
      await settle();
      expect(lookup).toHaveBeenCalledTimes(4);
      expect(lookup.mock.calls[3][0]).toEqual([A, D, E]);
      expect(groupPlayers).toHaveBeenCalledTimes(4);
    });

    it("looks the local player up again when the first attempt in a match was rate-limited", async () => {
      let limit = false;
      const lookup = vi.fn(async (ids: string[]) => ids.map((id) => (id === A && limit ? limited(id, 5000) : ok(id))));
      const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10, localSteamId: A });
      lobby.setMatch(matchOn("de_dust2", A, B));
      await vi.advanceTimersByTimeAsync(20);
      lobby.setMatch(null);

      limit = true; // next match: A is cached from before, but the fresh lookup is refused
      lobby.setMatch(matchOn("de_dust2", A, B));
      await vi.advanceTimersByTimeAsync(20);
      expect(lookup).toHaveBeenCalledTimes(2);
      limit = false;
      await vi.advanceTimersByTimeAsync(6000);
      expect(lookup).toHaveBeenCalledTimes(3);
      expect(lookup.mock.calls[2][0]).toEqual([A]);
    });

    it("drops a friendship result that arrives after the roster has moved on", async () => {
      const lookup = vi.fn(async (ids: string[]) => ids.map(ok));
      const open = holdGrouping(2);
      const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10, localSteamId: A, steamApiKey: "key" });
      lobby.setMatch(matchOn("de_dust2", A, B));
      await vi.advanceTimersByTimeAsync(50); // pass 1 for [A, B] is in flight
      lobby.setMatch(matchOn("de_dust2", A, B, C));
      await vi.advanceTimersByTimeAsync(50); // pass 2 for [A, B, C]
      expect(open).toHaveLength(2);

      open[1].resolve({ groups: [[A, B, C]], private: [], errors: [] });
      await vi.advanceTimersByTimeAsync(0);
      open[0].resolve({ groups: [[A], [B]], private: [], errors: [] }); // the old, partial answer comes last
      await vi.advanceTimersByTimeAsync(0);
      expect(lobby.rows().map((r) => r.groupName)).toEqual(["3 friends", "3 friends", "3 friends"]);
    });
  });
  describe("the Steam key changes while a match is on", () => {
    beforeEach(() => { groupPlayers.mockClear(); });
    const grouped = (ids: string[]) => ({ groups: [ids], private: [] as string[], errors: [] as string[] });

    it("groups the current lobby right away with a new key, and drops the groups when the key is removed", async () => {
      const lookup = vi.fn(async (ids: string[]) => ids.map(ok));
      const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10, localSteamId: A });
      lobby.setMatch(matchOn("de_dust2", A, B));
      await vi.advanceTimersByTimeAsync(50);
      expect(groupPlayers).not.toHaveBeenCalled();

      groupPlayers.mockImplementationOnce(async (ids) => grouped(ids));
      lobby.setSteamApiKey("key");
      await vi.advanceTimersByTimeAsync(0);
      expect(groupPlayers).toHaveBeenCalledTimes(1);
      expect(lobby.rows().map((r) => r.groupName)).toEqual(["2 friends", "2 friends"]);

      lobby.setSteamApiKey(null);
      expect(lobby.rows().map((r) => r.groupName)).toEqual([null, null]);
      expect(lobby.rows().map((r) => r.status)).toEqual(["ok", "ok"]); // the lookups are kept
      await vi.advanceTimersByTimeAsync(10_000);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(groupPlayers).toHaveBeenCalledTimes(1);
    });

    it("ignores a pass that started with the old key, and its complaint about it", async () => {
      const lookup = vi.fn(async (ids: string[]) => ids.map(ok));
      const open = holdGrouping(2);
      const onFriendshipKeyError = vi.fn();
      const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10, localSteamId: A, steamApiKey: "old", onFriendshipKeyError });
      lobby.setMatch(matchOn("de_dust2", A, B));
      await vi.advanceTimersByTimeAsync(50); // pass 1, old key, in flight
      lobby.setSteamApiKey("new");
      await vi.advanceTimersByTimeAsync(0); // pass 2, new key
      expect(open).toHaveLength(2);
      expect(groupPlayers.mock.calls.map((c) => c[1])).toEqual(["old", "new"]);

      open[1].resolve(grouped([A, B]));
      await vi.advanceTimersByTimeAsync(0);
      open[0].reject(new Error("Steam API key invalid or missing: forbidden"));
      await vi.advanceTimersByTimeAsync(0);
      expect(onFriendshipKeyError).not.toHaveBeenCalled();
      expect(lobby.rows().map((r) => r.groupName)).toEqual(["2 friends", "2 friends"]);
    });
  });

  describe("an answer that may change soon", () => {
    it("is asked again after its own, shorter time; settled answers keep the usual one", async () => {
      let broken = true;
      const lookup = vi.fn(async (ids: string[]) => ids.map((steamId) => steamId === B && broken
        ? { steamId, classification: "INSUFFICIENT_DATA" as const, totalMatches: 0, note: "the fallback was broken", recheckAfterMs: 5 * 60_000 }
        : ok(steamId)));
      const lobby = new LobbyService(lookup, () => {}, { debounceMs: 10 });
      lobby.setMatch(matchOn("de_dust2", A, B));
      await vi.advanceTimersByTimeAsync(20);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lobby.rows()[1]).toMatchObject({ status: "ok", classification: "INSUFFICIENT_DATA" });

      broken = false;
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      lobby.setMatch(matchOn("de_dust2", A, B)); // the game announces the same match again, inside the five minutes
      await vi.advanceTimersByTimeAsync(1000);
      expect(lookup).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(61_000);
      lobby.setMatch(matchOn("de_dust2", A, B)); // ...and again after them
      await vi.advanceTimersByTimeAsync(1000);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(lookup.mock.calls[1][0]).toEqual([B]); // only the provisional answer is asked again
      expect(lobby.rows()[1]).toMatchObject({ classification: "NORMAL" });

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      lobby.setMatch(matchOn("de_dust2", A, B));
      await vi.advanceTimersByTimeAsync(1000);
      expect(lookup).toHaveBeenCalledTimes(2); // B's new answer is a settled one: the usual six hours apply
    });
  });

  describe("a disposed service", () => {
    it("does nothing more: no timers, no lookups, no changes, also for a lookup that was already out", async () => {
      type Answers = ReturnType<typeof limited>[];
      let release: (a: Answers) => void = () => {};
      let held = true;
      const lookup = vi.fn((ids: string[]) =>
        held ? new Promise<Answers>((resolve) => { release = resolve; }) : Promise.resolve(ids.map((id) => limited(id, 100))));
      const onChange = vi.fn();
      const lobby = new LobbyService(lookup, onChange, { debounceMs: 10, retryMs: 100, localSteamId: A });
      lobby.setMatch(matchOn("de_dust2", A, B));
      await vi.advanceTimersByTimeAsync(20);
      expect(lookup).toHaveBeenCalledTimes(1); // in flight

      lobby.dispose();
      held = false;
      const changes = onChange.mock.calls.length;
      release([A, B].map((id) => limited(id, 100))); // it answers "ask again in 100 ms" after the dispose
      await vi.advanceTimersByTimeAsync(10_000);
      lobby.setMatch(matchOn("de_dust2", A, B, C));
      lobby.clear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(changes);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
