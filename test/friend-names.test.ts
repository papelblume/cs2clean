import { describe, expect, it } from "vitest";
import { FriendNameDirectory, type FetchedResponse, type NamesFetch } from "../src/main/steam/friend-names";

const ME = "76561198000000000";
const id = (n: number) => String(76561198000000000n + BigInt(n));

function setup(opts: { friends?: number; listStatus?: number; summaryStatus?: number; reject?: boolean; key?: string | null } = {}) {
  let t = 1_000_000;
  const urls: string[] = [];
  const count = opts.friends ?? 3;
  const reply = (status: number, body: unknown): FetchedResponse => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetch: NamesFetch = async (url) => {
    urls.push(url);
    if (opts.reject) throw new Error("offline");
    const u = new URL(url);
    if (u.pathname.includes("GetFriendList"))
      return reply(opts.listStatus ?? 200, { friendslist: { friends: Array.from({ length: count }, (_, i) => ({ steamid: id(i + 1), relationship: "friend" })) } });
    const asked = (u.searchParams.get("steamids") ?? "").split(",");
    return reply(opts.summaryStatus ?? 200, { response: { players: asked.map((s) => ({ steamid: s, personaname: `Name${BigInt(s) - 76561198000000000n}` })) } });
  };
  const d = new FriendNameDirectory(() => (opts.key === undefined ? "KEY" : opts.key), () => ME, { fetch, now: () => t, ttlMs: 300_000 });
  return { d, urls, advance: (ms: number) => { t += ms; } };
}

describe("the Web API's friend names", () => {
  it("returns name + Steam ID pairs", async () => {
    const { d, urls } = setup();
    expect(await d.get()).toEqual({ friends: [{ steamId: id(1), name: "Name1" }, { steamId: id(2), name: "Name2" }, { steamId: id(3), name: "Name3" }], error: null });
    expect(urls[0]).toContain("GetFriendList");
    expect(urls[0]).toContain(`steamid=${ME}`);
    expect(urls[0]).toContain("relationship=friend");
  });

  it("asks for at most 100 names at a time", async () => {
    const { d, urls } = setup({ friends: 205 });
    const r = await d.get();
    expect(r.friends).toHaveLength(205);
    const asked = urls.filter((u) => u.includes("GetPlayerSummaries")).map((u) => new URL(u).searchParams.get("steamids")!.split(",").length);
    expect(asked).toEqual([100, 100, 5]);
  });

  it("remembers the answer for a while, then asks again", async () => {
    const { d, urls, advance } = setup();
    await Promise.all([d.get(), d.get()]);
    await d.get();
    expect(urls).toHaveLength(2);                                      // one list, one batch of names, for all three
    advance(299_000);
    await d.get();
    expect(urls).toHaveLength(2);
    advance(2_000);
    await d.get();
    expect(urls).toHaveLength(4);
  });

  it("says why it has nothing, and doesn't ask again straight away", async () => {
    expect(await setup({ key: null }).d.get()).toEqual({ friends: [], error: "no-key" });
    const priv = setup({ listStatus: 401 });
    expect(await priv.d.get()).toEqual({ friends: [], error: "private" });
    await priv.d.get();
    expect(priv.urls).toHaveLength(1);
    expect(await setup({ listStatus: 403 }).d.get()).toEqual({ friends: [], error: "bad-key" });
    expect(await setup({ listStatus: 429 }).d.get()).toEqual({ friends: [], error: "unavailable" });
    expect(await setup({ summaryStatus: 500 }).d.get()).toEqual({ friends: [], error: "unavailable" });
    expect(await setup({ reject: true }).d.get()).toEqual({ friends: [], error: "unavailable" });
  });

  it("doesn't call Steam without a key", async () => {
    const { d, urls } = setup({ key: null });
    await d.get();
    expect(urls).toEqual([]);
  });
});

describe("the Web API's friend names, when the key or the account changes", () => {
  const OTHER = "76561198000000777";
  const reply = (status: number, body: unknown): FetchedResponse => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  /** Steam that accepts only the key "GOOD", and has one friend, named after whoever is asked about. */
  const steam = () => {
    const asked: { key: string; steamid: string | null }[] = [];
    const fetch: NamesFetch = async (url) => {
      const u = new URL(url);
      const key = u.searchParams.get("key") ?? "";
      if (u.pathname.includes("GetFriendList")) {
        asked.push({ key, steamid: u.searchParams.get("steamid") });
        if (key !== "GOOD") return reply(403, {});
        return reply(200, { friendslist: { friends: [{ steamid: id(u.searchParams.get("steamid") === OTHER ? 2 : 1) }] } });
      }
      const ids = (u.searchParams.get("steamids") ?? "").split(",");
      return reply(200, { response: { players: ids.map((s) => ({ steamid: s, personaname: `Friend${BigInt(s) - 76561198000000000n}` })) } });
    };
    return { asked, fetch };
  };

  it("doesn't hold a new key back with the old key's failure", async () => {
    const { asked, fetch } = steam();
    let key = "BAD", t = 1_000_000;
    const d = new FriendNameDirectory(() => key, () => ME, { fetch, now: () => t, ttlMs: 300_000 });
    expect(await d.get()).toEqual({ friends: [], error: "bad-key" });
    t += 5_000; // far inside the time a failure is remembered
    key = "GOOD";
    expect(await d.get()).toEqual({ friends: [{ steamId: id(1), name: "Friend1" }], error: null });
    expect(asked.map((a) => a.key)).toEqual(["BAD", "GOOD"]);
    await d.get();
    expect(asked).toHaveLength(2); // and the new key's answer is cached as before
  });

  it("asks again for another account, and again when the first account is back", async () => {
    const { asked, fetch } = steam();
    let me = ME, t = 1_000_000;
    const d = new FriendNameDirectory(() => "GOOD", () => me, { fetch, now: () => t, ttlMs: 300_000 });
    expect((await d.get()).friends[0].name).toBe("Friend1");
    me = OTHER;
    expect((await d.get()).friends[0].name).toBe("Friend2"); // not the first account's friends
    expect(asked.map((a) => a.steamid)).toEqual([ME, OTHER]);
  });

  it("drops the answer of a request for the old key that ends after the new key was asked", async () => {
    const asked: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetch: NamesFetch = async (url) => {
      const u = new URL(url);
      const key = u.searchParams.get("key") ?? "";
      if (u.pathname.includes("GetFriendList")) {
        asked.push(key);
        if (key === "OLD") await gate; // the old key's request is slow
        return key === "OLD" ? reply(403, {}) : reply(200, { friendslist: { friends: [{ steamid: id(1) }] } });
      }
      return reply(200, { response: { players: [{ steamid: id(1), personaname: "Friend1" }] } });
    };
    let key = "OLD";
    const d = new FriendNameDirectory(() => key, () => ME, { fetch, now: () => 1_000_000, ttlMs: 300_000 });
    const slow = d.get();
    key = "NEW";
    const fresh = await d.get();
    expect(fresh.error).toBeNull();
    release();
    expect((await slow).error).toBe("bad-key"); // whoever asked with the old key still gets its own answer
    expect(await d.get()).toEqual(fresh);       // but the cache holds the new key's
    expect(asked).toEqual(["OLD", "NEW"]);
  });
});
