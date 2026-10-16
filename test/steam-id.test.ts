import { describe, expect, it } from "vitest";
import { parseSteamInput } from "../src/shared/steam-id";

const ID = "76561198000000001";

describe("reading a pasted player", () => {
  it("takes a SteamID64, with stray spaces or angle brackets", () => {
    expect(parseSteamInput(ID)).toEqual({ kind: "id", steamId: ID });
    expect(parseSteamInput(`  ${ID}\n`)).toEqual({ kind: "id", steamId: ID });
    expect(parseSteamInput(`<${ID}>`)).toEqual({ kind: "id", steamId: ID });
  });

  it("converts SteamID2 and SteamID3 (what `status` and server tools print)", () => {
    // account 39734273 = 2 * 19867136 + 1
    expect(parseSteamInput("STEAM_0:1:19867136")).toEqual({ kind: "id", steamId: "76561198000000001" });
    expect(parseSteamInput("STEAM_1:1:19867136")).toEqual({ kind: "id", steamId: "76561198000000001" });
    expect(parseSteamInput("[U:1:39734273]")).toEqual({ kind: "id", steamId: "76561198000000001" });
    expect(parseSteamInput("U:1:39734273")).toEqual({ kind: "id", steamId: "76561198000000001" });
    expect(parseSteamInput("STEAM_0:0:0")).toBeNull(); // account 0 is nobody
  });

  it("takes Steam and Leetify profile links, with or without the scheme", () => {
    expect(parseSteamInput(`https://steamcommunity.com/profiles/${ID}`)).toEqual({ kind: "id", steamId: ID });
    expect(parseSteamInput(`steamcommunity.com/profiles/${ID}/`)).toEqual({ kind: "id", steamId: ID });
    expect(parseSteamInput(`https://www.steamcommunity.com/profiles/${ID}?foo=1`)).toEqual({ kind: "id", steamId: ID });
    expect(parseSteamInput(`https://leetify.com/app/profile/${ID}`)).toEqual({ kind: "id", steamId: ID });
  });

  it("leaves a custom profile name to be looked up at Steam", () => {
    expect(parseSteamInput("https://steamcommunity.com/id/some_name")).toEqual({ kind: "vanity", name: "some_name" });
    expect(parseSteamInput("steamcommunity.com/id/some-name/")).toEqual({ kind: "vanity", name: "some-name" });
  });

  it("rejects everything else", () => {
    for (const bad of ["", "   ", "hello", "12345", "7656119800000000", "76561198000000001x", "https://example.com/profiles/" + ID,
      "https://steamcommunity.com/groups/foo", "https://steamcommunity.com/id/", "https://leetify.com/app/profile/not-an-id", "STEAM_0:2:5"])
      expect(parseSteamInput(bad), bad).toBeNull();
  });
});
