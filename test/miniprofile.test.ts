import { describe, expect, it } from "vitest";
import type { FriendInGame } from "../src/main/steam/coplay";
import {
  MiniprofileStatus, accountId, matchProfileFriends, modeCompatible, normalizeMap, parseMiniprofile, parseStatus, type MiniFetch,
} from "../src/main/steam/miniprofile";

const PAGE = `<div class="miniprofile_gamesection"><span class="miniprofile_game_name">Counter-Strike 2</span>
  <span class="rich_presence">Premier - Inferno [ 0 : 2 ]</span></div>`;

describe("the mini-profile page", () => {
  it("turns a SteamID64 into the account ID in its address", () => {
    expect(accountId("76561198005725470")).toBe("45459742");
    expect(accountId("76561199003266924")).toBe("1043001196");
    expect(accountId("123")).toBeNull();
    expect(accountId("76561197960265728")).toBeNull();
  });

  it("gives the game and the rich-presence line out of the page", () => {
    expect(parseMiniprofile(PAGE)).toEqual({ game: "Counter-Strike 2", status: "Premier - Inferno [ 0 : 2 ]" });
    expect(parseMiniprofile("<div>Currently Offline</div>")).toEqual({ game: null, status: null });
    expect(parseMiniprofile('<span class="rich_presence">Casual - Dust II &amp; more</span>').status).toBe("Casual - Dust II & more");
  });

  it("splits a line into mode, map and score", () => {
    expect(parseStatus("Premier - Inferno [ 0 : 2 ]")).toEqual({ mode: "Premier", map: "Inferno", score: [0, 2] });
    expect(parseStatus("Retakes - Cache [ 5 : 0 ]")).toEqual({ mode: "Retakes", map: "Cache", score: [5, 0] });
    expect(parseStatus("Casual - Dust II")).toEqual({ mode: "Casual", map: "Dust II", score: null });
    expect(parseStatus("Main Menu")).toEqual({ mode: null, map: null, score: null });
  });

  it("matches the game's map names to the page's", () => {
    expect(normalizeMap("de_inferno")).toBe(normalizeMap("Inferno"));
    expect(normalizeMap("de_dust2")).toBe(normalizeMap("Dust II"));
    expect(normalizeMap("cs_italy")).toBe(normalizeMap("Italy"));
    expect(normalizeMap("de_mirage")).not.toBe(normalizeMap("Nuke"));
  });

  it("rules out only modes that can't be ours", () => {
    expect(modeCompatible("Premier", "competitive")).toBe(true);
    expect(modeCompatible("Competitive", "competitive")).toBe(true);
    expect(modeCompatible("Wingman", "scrimcomp2v2")).toBe(true);
    expect(modeCompatible("Retakes", "competitive")).toBe(false);
    expect(modeCompatible("Wingman", "competitive")).toBe(false);
    expect(modeCompatible("Retakes", null)).toBe(true);       // our mode unknown: nothing to contradict
    expect(modeCompatible(null, "competitive")).toBe(true);   // the friend's line has no mode
  });
});

describe("picking friends from their lines", () => {
  const F = (n: number, status: string | null): FriendInGame => ({ steamId: String(76561198000000000n + BigInt(n)), name: `f${n}`, presence: {}, status });
  const opts = { map: "de_inferno", mode: "competitive", exclude: new Set<string>(), max: 3 };
  const names = (fs: FriendInGame[]) => fs.map((f) => f.name);

  it("picks friends on our map in a mode that can be ours", () => {
    const friends = [
      F(1, "Premier - Inferno [ 0 : 2 ]"),
      F(2, "Retakes - Inferno [ 5 : 0 ]"),   // a mode we aren't in
      F(3, "Premier - Mirage [ 8 : 7 ]"),    // another map
      F(4, "Main Menu"),
      F(5, null),
      F(6, "Competitive - Inferno [ 12 : 3 ]"),
    ];
    expect(names(matchProfileFriends(friends, opts))).toEqual(["f1", "f6"]);
    expect(names(matchProfileFriends(friends, { ...opts, mode: null }))).toEqual(["f1", "f2", "f6"]);
  });

  it("never picks the excluded, and picks nothing without a map or a slot", () => {
    const friends = [F(1, "Premier - Inferno [ 0 : 2 ]")];
    expect(matchProfileFriends(friends, { ...opts, exclude: new Set([friends[0].steamId]) })).toEqual([]);
    expect(matchProfileFriends(friends, { ...opts, map: null })).toEqual([]);
    expect(matchProfileFriends(friends, { ...opts, max: 0 })).toEqual([]);
  });

  it("picks none when more friends fit than there are slots, since the lines are too old to tell who is in", () => {
    const friends = [1, 2, 3].map((n) => F(n, "Premier - Inferno [ 0 : 2 ]"));
    expect(names(matchProfileFriends(friends, { ...opts, max: 3 }))).toEqual(["f1", "f2", "f3"]);
    expect(matchProfileFriends(friends, { ...opts, max: 2 })).toEqual([]);
  });
});

describe("looking lines up", () => {
  const ME = "76561198005725470";
  function setup(respond: (url: string) => { status: number; body?: string } | Error) {
    let t = 1_000_000;
    const urls: string[] = [];
    const fetch: MiniFetch = async (url) => {
      urls.push(url);
      const r = respond(url);
      if (r instanceof Error) throw r;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "" };
    };
    const mini = new MiniprofileStatus({ fetch, now: () => t, ttlMs: 60_000, backoffMs: 300_000 });
    return { mini, urls, advance: (ms: number) => { t += ms; } };
  }

  it("reads the page once per friend for the length of the cache, and shares a request in flight", async () => {
    const { mini, urls, advance } = setup(() => ({ status: 200, body: PAGE }));
    const [a, b] = await Promise.all([mini.get(ME), mini.get(ME)]);
    expect([a, b]).toEqual(["Premier - Inferno [ 0 : 2 ]", "Premier - Inferno [ 0 : 2 ]"]);
    expect(urls).toEqual(["https://steamcommunity.com/miniprofile/45459742"]);
    advance(59_000);
    await mini.get(ME);
    expect(urls).toHaveLength(1);
    advance(2_000);
    await mini.get(ME);
    expect(urls).toHaveLength(2);
  });

  it("gives null for an unknown ID, a failed request or a page without a line", async () => {
    const ok = setup(() => ({ status: 200, body: "<div>Offline</div>" }));
    expect(await ok.mini.get(ME)).toBeNull();
    expect(await ok.mini.get("nope")).toBeNull();
    expect(ok.urls).toHaveLength(1);
    expect(await setup(() => new Error("offline")).mini.get(ME)).toBeNull();
    expect(await setup(() => ({ status: 404 })).mini.get(ME)).toBeNull();
  });

  it("stops asking for a while after Steam says too many requests", async () => {
    const { mini, urls, advance } = setup(() => ({ status: 429 }));
    expect(await mini.get(ME)).toBeNull();
    expect(await mini.get("76561199003266924")).toBeNull();     // another friend, still backing off
    expect(urls).toHaveLength(1);
    advance(301_000);
    await mini.get("76561199003266924");
    expect(urls).toHaveLength(2);
  });
});
