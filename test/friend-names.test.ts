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
