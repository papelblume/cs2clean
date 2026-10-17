import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SteamSource } from "../src/main/game/steam";
import type { CoplayEntry, CoplayResult, FriendInGame } from "../src/main/steam/coplay";
import { gsiConfig, libraryPaths, parseGsi, parseLoginUsers, startGsiServer, type GameState } from "../src/main/steam/gsi";
import { isCs2Running } from "../src/main/steam/process";
import { expectedOthers, othersToFind, pickFriends, pickMatchPlayers } from "../src/main/steam/pick";
import type { MatchState } from "../src/shared/types";
import { ago, flagged } from "../src/renderer/parts";

const ME = "76561198000000000";
const id = (n: number) => String(76561198000000000n + BigInt(n));
const E = (n: number, time: number, appId = 730): CoplayEntry => ({ steamId: id(n), name: `p${n}`, appId, time });

describe("picking the match from Steam's players list", () => {
  const now = 1_800_000_000;

  it("takes the group reported together, not the newest entries (a real Dust II match)", () => {
    const entries = [
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => E(n, now - 62)), // the 9 on the scoreboard, "1 minute ago"
      E(20, now - 3), E(21, now - 2),                             // "Now", not in the match
      ...[30, 31, 32].map((n) => E(n, now - 18 * 60)),            // the previous match
    ];
    const r = pickMatchPlayers(entries, { now, localSteamId: ME, matchStart: now - 90 });
    expect(r.players.map((p) => p.steamId).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(id).sort());
    expect(r.others.map((p) => p.name)).toEqual(["p20", "p21"]);
  });

  it("keeps players reported a few seconds apart together, and skips other games, old entries and me", () => {
    const entries = [E(1, now - 40), E(2, now - 35), E(3, now - 30), E(4, now - 400, 440), { ...E(0, now - 30), steamId: ME }, E(5, now - 3 * 3600)];
    const r = pickMatchPlayers(entries, { now, localSteamId: ME });
    expect(r.players.map((p) => p.name)).toEqual(["p1", "p2", "p3"]);
  });

  it("fills a short group with a player Steam re-reported a bit later, but not with the previous match", () => {
    const entries = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => E(n, now - 300)),  // 8 reported together
      E(9, now - 200),                                          // the 9th, re-reported later
      ...[30, 31, 32].map((n) => E(n, now - 8 * 60)),           // the previous match
    ];
    const r = pickMatchPlayers(entries, { now, localSteamId: ME });
    expect(r.players.map((p) => p.name).sort()).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]);
    expect(r.others.map((p) => p.name)).toEqual(["p30", "p31", "p32"]);
  });

  it("caps a group at the players a match can have", () => {
    const entries = Array.from({ length: 12 }, (_, i) => E(i + 1, now - 60 + i));
    expect(pickMatchPlayers(entries, { now, expectedOthers: 9 }).players).toHaveLength(9);
    expect(expectedOthers("scrimcomp2v2")).toBe(3);
    expect(expectedOthers("competitive")).toBe(9);
    expect(pickMatchPlayers([], { now }).players).toEqual([]);
  });

  it("looks for a mode's other players, but never more than the lobby looks up", () => {
    expect(othersToFind("competitive")).toBe(9);   // also Premier
    expect(othersToFind("scrimcomp2v2")).toBe(3);  // Wingman
    expect(othersToFind("casual")).toBe(9);        // 19 others, but only 10 players are looked up
    expect(othersToFind("deathmatch")).toBe(9);
    expect(othersToFind(null)).toBe(9);            // until the game says which mode it is
    expect(othersToFind(undefined)).toBe(9);
  });
});

describe("topping up with Steam friends", () => {
  const F = (n: number, presence: Record<string, string>): FriendInGame => ({ steamId: id(n), name: `f${n}`, presence });

  it("adds friends in our party first, then friends on the same map, up to the missing count", () => {
    const friends = [
      F(1, { "game:map": "de_mirage" }),
      F(2, { "game:map": "de_nuke", steam_player_group: "77" }),   // our party (map key differs or stale)
      F(3, { "game:map": "de_dust2" }),                            // another match
      F(4, { "game:map": "DE_MIRAGE" }),
    ];
    const opts = { map: "de_mirage", localPresence: { steam_player_group: "77" }, exclude: new Set<string>(), max: 2 };
    expect(pickFriends(friends, opts).map((f) => f.name)).toEqual(["f2", "f1"]);
    expect(pickFriends(friends, { ...opts, max: 9 }).map((f) => f.name)).toEqual(["f2", "f1", "f4"]);
    expect(pickFriends(friends, { ...opts, exclude: new Set([id(2)]) }).map((f) => f.name)).toEqual(["f1", "f4"]);
    expect(pickFriends(friends, { ...opts, max: 0 })).toEqual([]);
  });

  it("ignores an empty party id and needs a map to match on", () => {
    const friends = [F(1, { steam_player_group: "0", "game:map": "de_mirage" }), F(2, {})];
    expect(pickFriends(friends, { map: null, localPresence: { steam_player_group: "0" }, exclude: new Set(), max: 9 })).toEqual([]);
    expect(pickFriends(friends, { map: "de_mirage", exclude: new Set(), max: 9 }).map((f) => f.name)).toEqual(["f1"]);
  });
});

describe("CS2 game state feed", () => {
  it("reads map, mode, phase and our Steam ID", () => {
    expect(parseGsi({ provider: { steamid: ME }, map: { name: "de_dust2", mode: "competitive", phase: "warmup" } }))
      .toEqual({ map: "de_dust2", mode: "competitive", phase: "warmup", localSteamId: ME });
    expect(parseGsi({ provider: { steamid: "123" } })).toEqual({ map: null, mode: null, phase: null, localSteamId: null });
    expect(parseGsi(null).map).toBeNull();
  });

  it("writes a cfg with our token and finds Steam libraries", () => {
    expect(gsiConfig("abc", 1234)).toContain('"uri"        "http://127.0.0.1:1234/gsi"');
    expect(gsiConfig("abc")).toContain('"token" "abc"');
    const vdf = `"libraryfolders" { "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" } "1" { "path" "D:\\\\SteamLibrary" } }`;
    expect(libraryPaths(vdf)).toEqual(["C:\\Program Files (x86)\\Steam", "D:\\SteamLibrary"]);
  });

  it("accepts only payloads with our token", async () => {
    const got: GameState[] = [];
    const port = 37000 + Math.floor(Math.random() * 1000);
    const server = startGsiServer("secret-token", (s) => got.push(s), port);
    await new Promise((r) => server.once("listening", r));
    const post = (body: unknown) => new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/gsi", method: "POST" }, (res) => { res.resume(); res.on("end", resolve); });
      req.end(JSON.stringify(body));
    });
    await post({ auth: { token: "wrong" }, map: { name: "de_nuke" } });
    await post({ auth: { token: "secret-token" }, map: { name: "de_mirage", phase: "live" } });
    server.close();
    expect(got.map((g) => g.map)).toEqual(["de_mirage"]);
  });
});

describe("SteamSource", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  function make(entries: () => CoplayEntry[], friends: () => FriendInGame[] = () => []) {
    let push: (s: GameState) => void = () => {};
    const scans: number[] = [];
    const src = new SteamSource({
      scan: async (): Promise<CoplayResult> => {
        scans.push(Date.now());
        return { localName: "Nova", entries: entries(), friends: friends() };
      },
      listen: (on) => ((push = on), () => {}),
      fastMs: 1000,
      slowMs: 10_000,
    });
    const matches: MatchState[] = [];
    const problems: (string | null)[] = [];
    src.on("match", (m) => matches.push(m));
    src.on("problem", (p) => problems.push(p));
    return { src, push: (s: Partial<GameState>) => push({ map: null, mode: null, phase: null, localSteamId: ME, ...s }), scans, matches, problems };
  }

  it("lists me and the match's players once a map loads, and forgets them back in the menu", async () => {
    const t = () => Math.floor(Date.now() / 1000);
    const { src, push, matches } = make(() => [1, 2, 3].map((n) => E(n, t() - 5)));
    src.start();
    push({});                                   // CS2 at the main menu
    await vi.advanceTimersByTimeAsync(100);
    expect(matches.at(-1)?.players).toEqual([]);

    push({ map: "de_dust2", mode: "competitive", phase: "warmup" });
    await vi.advanceTimersByTimeAsync(2_000);
    const m = matches.at(-1)!;
    expect(m).toMatchObject({ map: "de_dust2", phase: "warmup", localSteamId: ME });
    expect(m.players.map((p) => p.name)).toEqual(["Nova", "p1", "p2", "p3"]);
    expect(m.players[0].isLocal).toBe(true);

    push({ map: "de_dust2", mode: "competitive", phase: "live" });
    await vi.advanceTimersByTimeAsync(10);
    expect(matches.at(-1)?.phase).toBe("live");

    push({});
    await vi.advanceTimersByTimeAsync(10);
    expect(matches.at(-1)?.players).toEqual([]);
    src.stop();
  });

  it("keeps a player found earlier in the match when a later scan misses them", async () => {
    const t = () => Math.floor(Date.now() / 1000);
    let list = [1, 2, 3].map((n) => E(n, t() - 5));
    const { src, push, matches } = make(() => list);
    src.start();
    push({ map: "de_dust2", mode: "competitive", phase: "warmup" });
    await vi.advanceTimersByTimeAsync(2_000);
    list = [1, 2].map((n) => E(n, t() - 1)).concat(E(3, t() - 30 * 60));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(matches.at(-1)!.players.map((p) => p.name)).toEqual(["Nova", "p1", "p2", "p3"]);
    src.stop();
  });

  it("keeps the players it found before the feed's first post, which already names a map", async () => {
    // The app started in the middle of a match: Steam's list was read before CS2's first heartbeat arrived.
    const t = () => Math.floor(Date.now() / 1000);
    const { src, push, matches } = make(() => [1, 2, 3].map((n) => E(n, t() - 400))); // reported almost seven minutes ago
    src.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(matches.at(-1)!.players.map((p) => p.name)).toEqual(["Nova", "p1", "p2", "p3"]);

    push({ map: "de_dust2", mode: "competitive", phase: "live" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(matches.at(-1)!.players.map((p) => p.name)).toEqual(["Nova", "p1", "p2", "p3"]);

    // A later change of map is still a fresh start.
    push({ map: "de_nuke", mode: "competitive", phase: "warmup" });
    await vi.advanceTimersByTimeAsync(10);
    expect(matches.at(-1)!.players).toEqual([]);
    src.stop();
  });

  it("adds a friend in the match that Steam's players list leaves out", async () => {
    const t = () => Math.floor(Date.now() / 1000);
    const { src, push, matches } = make(
      () => [1, 2, 3, 4, 5, 6, 7, 8].map((n) => E(n, t() - 5)),
      () => [{ steamId: id(50), name: "buddy", presence: { "game:map": "de_mirage" } },
             { steamId: id(51), name: "elsewhere", presence: { "game:map": "de_inferno" } },
             { steamId: id(3), name: "p3", presence: { "game:map": "de_mirage" } }],
    );
    src.start();
    push({ map: "de_mirage", mode: "competitive", phase: "warmup" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(matches.at(-1)!.players.map((p) => p.name)).toEqual(["Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "buddy"]);
    src.stop();
  });

  describe("in a mode with fewer than 10 players", () => {
    const WINGMAN = { map: "de_inferno", mode: "scrimcomp2v2", phase: "warmup" } as const;
    const secs = () => Math.floor(Date.now() / 1000); // read inside a test, after the fake clock is set

    it("lists a Wingman match's three other players, not recent entries that aren't in it", async () => {
      const t0 = secs();
      const { src, push, matches } = make(() => [
        ...[1, 2, 3].map((n) => E(n, t0 - 60)),   // the 4 on the scoreboard (me and these 3), reported together
        E(20, t0 - 5), E(21, t0 - 4),             // "Now", not in the match
      ]);
      src.start();
      push(WINGMAN);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(matches.at(-1)!.players.map((p) => p.name)).toEqual(["Nova", "p1", "p2", "p3"]);
      src.stop();
    });

    it("doesn't top a full Wingman lobby up with friends who are on the same map in another match", async () => {
      const t0 = secs();
      const { src, push, matches } = make(
        () => [1, 2, 3].map((n) => E(n, t0 - 60)),
        () => [{ steamId: id(50), name: "buddy", presence: { "game:map": "de_inferno" } }],
      );
      src.start();
      push(WINGMAN);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(matches.at(-1)!.players.map((p) => p.name)).toEqual(["Nova", "p1", "p2", "p3"]);
      src.stop();
    });

    it("still tops a short Wingman lobby up with a friend in the match", async () => {
      const t0 = secs();
      const { src, push, matches } = make(
        () => [1, 2].map((n) => E(n, t0 - 60)),
        () => [{ steamId: id(50), name: "buddy", presence: { "game:map": "de_inferno" } }],
      );
      src.start();
      push(WINGMAN);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(matches.at(-1)!.players.map((p) => p.name)).toEqual(["Nova", "p1", "p2", "buddy"]);
      src.stop();
    });

    it("stops scanning often once the Wingman lobby is complete", async () => {
      const t0 = secs();
      const { src, push, scans } = make(() => [1, 2, 3].map((n) => E(n, t0 - 60)));
      src.start();
      push(WINGMAN);
      await vi.advanceTimersByTimeAsync(2_000);
      const n = scans.length;
      await vi.advanceTimersByTimeAsync(5_000);   // the slow interval (10 s in this test) applies, not the fast one (1 s)
      expect(scans.length).toBe(n);
      src.stop();
    });
  });

  it("still lists at most 9 other players in a mode with more, since only 10 players are looked up", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    const { src, push, matches } = make(() => Array.from({ length: 14 }, (_, i) => E(i + 1, t0 - 30)));
    src.start();
    push({ map: "de_dust2", mode: "casual", phase: "warmup" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(matches.at(-1)!.players.map((p) => p.name)).toEqual(["Nova", ...Array.from({ length: 9 }, (_, i) => `p${i + 1}`)]);
    src.stop();
  });

  it("scans often until the lobby is complete, and reports Steam problems", async () => {
    const t = () => Math.floor(Date.now() / 1000);
    let fail = true;
    const { src, push, scans, problems } = make(() => {
      if (fail) throw new Error("Steam isn't running");
      return Array.from({ length: 9 }, (_, i) => E(i + 1, t() - 5));
    });
    src.start();
    push({ map: "de_dust2", mode: "competitive", phase: "warmup" });
    await vi.advanceTimersByTimeAsync(1_600);
    expect(problems.at(-1)).toMatch(/Steam isn't running/);
    fail = false;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(problems.at(-1)).toBeNull();
    const n = scans.length;
    await vi.advanceTimersByTimeAsync(5_000);   // complete: slow interval now
    expect(scans.length).toBe(n);
    src.stop();
  });
});

describe("SteamSource before CS2's game-state feed has said anything", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
  afterEach(() => vi.useRealTimers());
  const now = () => Math.floor(Date.now() / 1000);

  function make(entries: () => CoplayEntry[], o: { running?: () => boolean | Promise<boolean>; local?: string | null } = {}) {
    let scans = 0;
    const src = new SteamSource({
      scan: async (): Promise<CoplayResult> => (scans++, { localName: "Nova", entries: entries(), friends: [] }),
      listen: () => () => {},
      cs2Running: o.running ? async () => o.running!() : undefined,
      localSteamId: () => (o.local === undefined ? ME : o.local),
      fastMs: 1000,
      slowMs: 10_000,
    });
    const matches: MatchState[] = [];
    const problems: (string | null)[] = [];
    src.on("match", (m) => matches.push(m));
    src.on("problem", (p) => problems.push(p));
    return { src, matches, problems, scans: () => scans };
  }
  /** What Steam's list still holds six minutes after the last match: its players, and ourselves. */
  const lastMatch = () => [0, 1, 2, 3].map((n) => E(n, now() - 360));

  it("shows no match, and nothing left of the last one, while CS2 isn't running", async () => {
    const { src, matches, problems, scans } = make(lastMatch, { running: () => false });
    src.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(matches.at(-1)!.players).toEqual([]);
    expect(problems.at(-1)).toBeNull(); // not "CS2 isn't sending game state": there is no CS2
    expect(scans()).toBe(0);            // Steam's list isn't even read
    src.stop();
  });

  it("lists the match of a CS2 that is running but sends no game state, with our own Steam ID and without a second copy of us", async () => {
    const { src, matches, problems } = make(lastMatch, { running: () => true });
    src.start();
    await vi.advanceTimersByTimeAsync(2_000);
    const m = matches.at(-1)!;
    expect(m.localSteamId).toBe(ME);
    expect(m.players.map((p) => [p.name, p.steamId, p.isLocal])).toEqual([["Nova", ME, true], ["p1", id(1), false], ["p2", id(2), false], ["p3", id(3), false]]);
    expect(problems.at(-1)).toMatch(/isn't sending game state/); // this one is true
    src.stop();
  });

  it("leaves out the previous match when CS2 starts while the app watches, and takes the new one", async () => {
    let up = false;
    let list = lastMatch();
    const { src, matches } = make(() => list, { running: () => up });
    src.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(matches.at(-1)!.players).toEqual([]);

    up = true;
    await vi.advanceTimersByTimeAsync(1_500); // noticed within a poll
    expect(matches.at(-1)!.players).toEqual([]); // the old players are not this game's
    list = [...lastMatch(), ...[11, 12, 13].map((n) => E(n, now()))];
    await vi.advanceTimersByTimeAsync(21_000); // without game state the list is read every 20 s
    expect(matches.at(-1)!.players.map((p) => p.name)).toEqual(["Nova", "p11", "p12", "p13"]);
    src.stop();
  });

  it("forgets the match when CS2 closes", async () => {
    let up = true;
    const { src, matches } = make(lastMatch, { running: () => up });
    src.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(matches.at(-1)!.players.length).toBeGreaterThan(1);
    up = false;
    await vi.advanceTimersByTimeAsync(21_000); // noticed on the next read of the list, within 20 s
    expect(matches.at(-1)!.players).toEqual([]);
    src.stop();
  });

  it("acts as before when it can't tell whether CS2 runs", async () => {
    const { src, matches } = make(lastMatch, { running: () => { throw new Error("pgrep not found"); } });
    src.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(matches.at(-1)!.players.map((p) => p.name)).toEqual(["Nova", "p1", "p2", "p3"]);
    src.stop();
  });

  it("is no Steam ID only when Steam's account can't be read either", async () => {
    const { src, matches } = make(lastMatch, { running: () => true, local: null });
    src.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(matches.at(-1)!.players[0]).toMatchObject({ isLocal: true, steamId: null });
    src.stop();
  });
});

describe("our own Steam ID and whether CS2 runs", () => {
  const vdf = `"users"
{
	"76561198000000001"
	{
		"AccountName"		"old"
		"PersonaName"		"Old"
		"MostRecent"		"0"
		"Timestamp"		"1600000000"
	}
	"76561198000000002"
	{
		"AccountName"		"me"
		"PersonaName"		"[-jesus-]"
		"MostRecent"		"1"
		"Timestamp"		"1700000000"
	}
}`;

  it("reads the account Steam signed in last from loginusers.vdf", () => {
    expect(parseLoginUsers(vdf)).toBe("76561198000000002");
    expect(parseLoginUsers(vdf.replace('"MostRecent"\t\t"1"', '"MostRecent"\t\t"0"'))).toBeNull();
    expect(parseLoginUsers("")).toBeNull();
  });

  it("asks tasklist on Windows and pgrep elsewhere", async () => {
    const fake = (stdout: string, code?: number | string) => (_c: string, _a: string[], _o: unknown, cb: (e: any, out: string) => void) =>
      cb(code === undefined ? null : Object.assign(new Error("x"), { code }), stdout);
    await expect(isCs2Running(fake('"cs2.exe","4242","Console","1","1,000 K"\r\n'), "win32")).resolves.toBe(true);
    await expect(isCs2Running(fake("INFO: No tasks are running which match the specified criteria.\r\n"), "win32")).resolves.toBe(false);
    await expect(isCs2Running(fake("", "ENOENT"), "win32")).rejects.toThrow();
    await expect(isCs2Running(fake("4242\n"), "linux")).resolves.toBe(true);
    await expect(isCs2Running(fake("", 1), "linux")).resolves.toBe(false);   // pgrep: no match
    await expect(isCs2Running(fake("", "ENOENT"), "linux")).rejects.toThrow(); // no pgrep: can't tell
  });
});

describe("SteamSource: a map Steam lists no players for, and players added by hand", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  function make(entries: () => CoplayEntry[]) {
    let push: (s: GameState) => void = () => {};
    const src = new SteamSource({
      scan: async (): Promise<CoplayResult> => ({ localName: "Nova", entries: entries(), friends: [] }),
      listen: (on) => ((push = on), () => {}),
      fastMs: 1000,
      slowMs: 10_000,
    });
    const matches: MatchState[] = [];
    src.on("match", (m) => matches.push(m));
    const post = (s: Partial<GameState>) => push({ map: null, mode: null, phase: null, localSteamId: ME, ...s });
    /** Time passes with CS2 running: its heartbeat arrives every 10 s (without it the source takes CS2 for closed). */
    const hold = async (s: Partial<GameState>, ms: number) => {
      for (let t = 0; t < ms; t += 10_000) {
        post(s);
        await vi.advanceTimersByTimeAsync(Math.min(10_000, ms - t));
      }
    };
    return { src, post, hold, matches };
  }
  const community = { map: "de_dust2", mode: "casual", phase: "live" } as const;

  it("says the roster is unavailable once the map has had time and Steam still lists nobody", async () => {
    const { src, hold, matches } = make(() => []);
    src.start();
    await hold(community, 20_000);
    expect(matches.at(-1)).toMatchObject({ map: "de_dust2", players: [], rosterUnavailable: false }); // too early to say
    await hold(community, 40_000);
    expect(matches.at(-1)).toMatchObject({ players: [], rosterUnavailable: true });
    src.stop();
  });

  it("doesn't say it in the menu, for a matchmaking match, or while Steam can't be read", async () => {
    const t = () => Math.floor(Date.now() / 1000);
    const a = make(() => []);
    a.src.start();
    await a.hold({}, 60_000); // main menu
    expect(a.matches.at(-1)!.rosterUnavailable).toBe(false);
    a.src.stop();

    const b = make(() => [1, 2, 3].map((n) => E(n, t() - 5)));
    b.src.start();
    await b.hold({ map: "de_dust2", mode: "competitive", phase: "warmup" }, 60_000);
    expect(b.matches.at(-1)!.players.length).toBeGreaterThan(1);
    expect(b.matches.at(-1)!.rosterUnavailable).toBe(false);
    b.src.stop();

    const c = make(() => { throw new Error("Steam isn't running"); });
    c.src.start();
    await c.hold(community, 60_000);
    expect(c.matches.at(-1)!.rosterUnavailable).toBe(false); // that's a problem to report, not a community server
    c.src.stop();
  });

  it("clears the notice when Steam lists players after all, and when the map changes", async () => {
    let list: CoplayEntry[] = [];
    const { src, hold, matches } = make(() => list);
    src.start();
    await hold(community, 60_000);
    expect(matches.at(-1)!.rosterUnavailable).toBe(true);

    const t = Math.floor(Date.now() / 1000);
    list = [1, 2, 3].map((n) => E(n, t - 5));
    await hold(community, 10_000);
    expect(matches.at(-1)!.rosterUnavailable).toBe(false);

    list = [];
    await hold({ map: "de_nuke", mode: "casual", phase: "live" }, 10_000);
    expect(matches.at(-1)!.rosterUnavailable).toBe(false); // a new map starts the wait again
    src.stop();
  });

  it("lists players added by hand, keeps them for the map, and forgets them with it", async () => {
    const { src, post, hold, matches } = make(() => []);
    src.start();
    await hold({}, 10_000);
    expect(src.addPlayer(id(5))).toBe("no-match"); // the feed says we're in the menu

    await hold(community, 10_000);
    expect(src.addPlayer(id(5))).toBe("added");
    expect(src.addPlayer(id(5))).toBe("duplicate");
    expect(src.addPlayer(ME)).toBe("duplicate"); // that's us
    await vi.advanceTimersByTimeAsync(10);
    expect(matches.at(-1)!.players.map((p) => [p.name, p.steamId])).toEqual([["Nova", ME], ["Unknown player", id(5)]]);

    await hold(community, 60_000);
    expect(matches.at(-1)).toMatchObject({ rosterUnavailable: true }); // adding someone doesn't hide the notice
    expect(matches.at(-1)!.players).toHaveLength(2);

    post({ map: "de_nuke", mode: "casual", phase: "live" });
    await vi.advanceTimersByTimeAsync(10);
    expect(matches.at(-1)!.players).toEqual([]);
    src.stop();
  });

  it("stops at the number of other players a lobby looks up", async () => {
    const { src, hold } = make(() => []);
    src.start();
    await hold(community, 10_000);
    for (let n = 1; n <= 9; n++) expect(src.addPlayer(id(n))).toBe("added");
    expect(src.addPlayer(id(10))).toBe("full");
    src.stop();
  });
});

describe("overlay helpers", () => {
  it("lists flagged players by class (VERY_HIGH first), then by how flagged they are, whatever raised the class", () => {
    const d = (score: number) => ({ score, avgRating: 0, strongShare: 0, aim: 0, clutch: 0, levels: { rating: "LOW", aim: "LOW", clutch: "LOW" } as const, recent: [] });
    const rep = (score: number | null, tier = "WATCH" as const) => ({ score, tier, confidence: 1, reasons: [] });
    const row = (name: string, classification: "VERY_HIGH" | "HIGH" | "ELEVATED" | "NORMAL" | "INSUFFICIENT_DATA",
                 detail: ReturnType<typeof d> | null, reputation: ReturnType<typeof rep> | null = null, isLocal = false) =>
      ({ slot: 0, name, steamId: name, side: null, isLocal, classification, totalMatches: 3, status: "ok" as const, detail, reputation, note: null });
    const list = flagged([
      row("a", "ELEVATED", d(50)),
      row("b", "HIGH", d(70)),
      row("c", "HIGH", d(75)),
      row("d", "NORMAL", d(10)),
      row("e", "VERY_HIGH", d(85)),
      row("f", "INSUFFICIENT_DATA", null),
      row("banned", "VERY_HIGH", null, rep(0, "BANNED" as never)),   // no performance numbers, still flagged
      row("odd-stats", "HIGH", d(20), rep(15, "SUSPICIOUS" as never)), // raised by reputation: 100 - 15 beats the score of 20
      row("me", "VERY_HIGH", d(99), null, true),                      // never yourself
    ]).map((r) => r.name);
    expect(list).toEqual(["banned", "e", "odd-stats", "c", "b", "a"]);
  });

  it("writes dates like the mock-up", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    expect(ago("2026-09-26T10:00:00Z", now)).toBe("3 days ago");
    expect(ago("2026-09-28T10:00:00Z", now)).toBe("yesterday");
    expect(ago(null, now)).toBe("date unknown");
  });
});
