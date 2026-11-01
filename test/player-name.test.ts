import { describe, expect, it } from "vitest";
import { lookupPlayerName } from "../src/main/steam/player-name";

const ID = "76561198000000001"; // account 39734273
const API = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/";
const MINI = "https://steamcommunity.com/miniprofile/39734273";

const page = (name: string) => `<div class="miniprofile_playersection"><div class="playersection_content"><span class="persona offline">${name}</span></div></div>`;
const summaries = (...players: { steamid: string; personaname?: unknown }[]) => JSON.stringify({ response: { players } });

type Answer = Response | Error;
/** A fake Steam: the answer per address (the part before any query), and every request that was made. */
function fakeSteam(answers: Record<string, Answer>) {
  const asked: { url: string; headers: Headers }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    asked.push({ url, headers: new Headers(init?.headers) });
    const a = answers[url.split("?")[0]];
    if (a instanceof Error) throw a;
    return a ?? new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, asked };
}
const ok = (body: string) => new Response(body, { status: 200 });

describe("the name of a player added by hand", () => {
  it("comes from the Steam Web API when there is a key", async () => {
    const { fetchImpl, asked } = fakeSteam({ [API]: ok(summaries({ steamid: ID, personaname: "Some Name" })) });
    expect(await lookupPlayerName(ID, "the-key", fetchImpl)).toBe("Some Name");
    expect(asked).toHaveLength(1);
    const url = new URL(asked[0].url);
    expect(url.origin + url.pathname).toBe(API);
    expect(Object.fromEntries(url.searchParams)).toEqual({ key: "the-key", steamids: ID });
  });

  it("is the one for this player, whatever else Steam sends", async () => {
    const { fetchImpl } = fakeSteam({ [API]: ok(summaries({ steamid: "76561198000000002", personaname: "Someone else" }, { steamid: ID, personaname: "Right One" })) });
    expect(await lookupPlayerName(ID, "k", fetchImpl)).toBe("Right One");
  });

  it("comes from the mini-profile page when there is no key", async () => {
    const { fetchImpl, asked } = fakeSteam({ [MINI]: ok(page("Mini Name")) });
    expect(await lookupPlayerName(ID, null, fetchImpl)).toBe("Mini Name");
    expect(asked.map((a) => a.url)).toEqual([MINI]); // the API isn't asked
    expect(asked[0].headers.get("user-agent")).toBe("CS2Clean");
  });

  it("is not looked for twice when the API says Steam has no such player", async () => {
    const { fetchImpl, asked } = fakeSteam({ [API]: ok(summaries()), [MINI]: ok(page("Mini Name")) });
    expect(await lookupPlayerName(ID, "k", fetchImpl)).toBeNull();
    expect(asked.map((a) => a.url.split("?")[0])).toEqual([API]);
  });

  it.each([
    ["turns the key down", new Response("Forbidden", { status: 403 })],
    ["has a server error", new Response("", { status: 503 })],
    ["can't be reached", new TypeError("fetch failed")],
    ["sends something that isn't JSON", ok("<html>maintenance</html>")],
  ])("falls back to the mini-profile page when the API %s", async (_why, answer) => {
    const { fetchImpl, asked } = fakeSteam({ [API]: answer, [MINI]: ok(page("Mini Name")) });
    expect(await lookupPlayerName(ID, "k", fetchImpl)).toBe("Mini Name");
    expect(asked.map((a) => a.url.split("?")[0])).toEqual([API, MINI]);
  });

  it("is null, not an error, when nothing can say", async () => {
    expect(await lookupPlayerName(ID, null, fakeSteam({ [MINI]: new Response("", { status: 429 }) }).fetchImpl)).toBeNull();
    expect(await lookupPlayerName(ID, null, fakeSteam({ [MINI]: new TypeError("fetch failed") }).fetchImpl)).toBeNull();
    expect(await lookupPlayerName(ID, null, fakeSteam({ [MINI]: ok("<p>no name on this page</p>") }).fetchImpl)).toBeNull();
    expect(await lookupPlayerName(ID, "k", fakeSteam({ [API]: new TypeError("down"), [MINI]: new TypeError("down") }).fetchImpl)).toBeNull();
  });

  it("is null without a request when it isn't a SteamID64 of a person", async () => {
    const { fetchImpl, asked } = fakeSteam({ [MINI]: ok(page("Mini Name")) });
    expect(await lookupPlayerName("123", null, fetchImpl)).toBeNull();
    expect(asked).toEqual([]);
  });

  it("is trimmed, and is nothing when it is empty or too long to be a name", async () => {
    const via = (name: unknown) => lookupPlayerName(ID, "k", fakeSteam({ [API]: ok(summaries({ steamid: ID, personaname: name })) }).fetchImpl);
    expect(await via("  Padded  ")).toBe("Padded");
    expect(await via("   ")).toBeNull();
    expect(await via(42)).toBeNull();
    expect(await via("x".repeat(65))).toBeNull();
    expect(await via("x".repeat(32))).toBe("x".repeat(32));
  });
});
