import { describe, expect, it } from "vitest";
import { matchLobbyNames, normalizeName } from "../src/main/steam/name-match";

const L = (...names: string[]) => names.map((name, i) => ({ slot: i, name }));
const F = (n: number, name: string | null) => ({ steamId: `7656119800000000${n}`, name });
const ids = (r: ReturnType<typeof matchLobbyNames>) => r.matches.map((m) => m.steamId);

describe("comparing names", () => {
  it("ignores case, outer spacing and Unicode form", () => {
    expect(normalizeName("  BoB ")).toBe("bob");
    expect(normalizeName("Zoe\u0301".normalize("NFD"))).toBe(normalizeName("Zoé"));
  });
});

describe("matching a status list to friends", () => {
  it("matches a name that fits exactly one friend and one lobby entry", () => {
    const r = matchLobbyNames(L("Alice", "bob", "Carol"), [F(1, "Bob"), F(2, "Dave"), F(3, null)]);
    expect(r.matches).toEqual([{ steamId: F(1, "").steamId, name: "bob", slot: 1 }]);   // the name as the lobby shows it
    expect(r.ambiguous).toEqual([]);
  });

  it("leaves out a name that appears twice in the lobby, or on two friends", () => {
    const twice = matchLobbyNames(L("Bob", "Bob", "Eve"), [F(1, "Bob"), F(2, "Eve")]);
    expect(ids(twice)).toEqual([F(2, "").steamId]);
    expect(twice.ambiguous).toEqual(["Bob"]);
    const twoFriends = matchLobbyNames(L("Bob"), [F(1, "Bob"), F(2, "bob")]);
    expect(twoFriends.matches).toEqual([]);
    expect(twoFriends.ambiguous).toEqual(["Bob"]);
  });

  it("uses a lobby entry up for each player we already know, so a namesake friend elsewhere isn't added", () => {
    // A stranger called Bob is in the match (Steam's players list has him); a friend called Bob plays somewhere else.
    expect(matchLobbyNames(L("Bob", "Eve"), [F(1, "Bob")], { knownNames: ["Bob"] }).matches).toEqual([]);
    // Two Bobs in the lobby, one of them known: the other one is the friend.
    expect(ids(matchLobbyNames(L("Bob", "Bob"), [F(1, "Bob")], { knownNames: ["Bob"] }))).toEqual([F(1, "").steamId]);
    // Names the list has that the lobby doesn't (he changed his name): nothing is taken away.
    expect(ids(matchLobbyNames(L("Bob"), [F(1, "Bob")], { knownNames: ["Alice", null] }))).toEqual([F(1, "").steamId]);
  });

  it("counts our own entry too", () => {
    expect(ids(matchLobbyNames(L("Nova", "Nova"), [F(1, "Nova")], { localName: "Nova" }))).toEqual([F(1, "").steamId]);
    expect(matchLobbyNames(L("Nova"), [F(1, "Nova")], { localName: "nova" }).matches).toEqual([]);   // that entry is us
  });

  it("never matches excluded Steam IDs, and counts each friend once however many sources name them", () => {
    expect(matchLobbyNames(L("Bob"), [F(1, "Bob")], { exclude: new Set([F(1, "").steamId]) }).matches).toEqual([]);
    const fromTwoSources = matchLobbyNames(L("Bob"), [F(1, "Bob"), F(1, "Bob"), F(1, "Robert")]);
    expect(ids(fromTwoSources)).toEqual([F(1, "").steamId]);          // not "two friends called Bob"
  });

  it("lists the matches in lobby order and ignores lobby names that no friend has", () => {
    const r = matchLobbyNames(L("Zed", "Ann", "Stranger", "Bob"), [F(1, "Bob"), F(2, "Zed"), F(3, "Ann")]);
    expect(r.matches.map((m) => m.slot)).toEqual([0, 1, 3]);
  });

  it("copes with nothing to match", () => {
    expect(matchLobbyNames([], [F(1, "Bob")])).toEqual({ matches: [], ambiguous: [] });
    expect(matchLobbyNames(L("Bob"), [])).toEqual({ matches: [], ambiguous: [] });
    expect(matchLobbyNames(L("", "  "), [F(1, "")]).matches).toEqual([]);
  });
});
