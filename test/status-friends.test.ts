import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SteamSource } from "../src/main/game/steam";
import type { StatusBlock } from "../src/main/steam/console-log";
import type { CoplayEntry, CoplayResult, FriendInGame } from "../src/main/steam/coplay";
import type { FriendNames } from "../src/main/steam/friend-names";
import type { GameState } from "../src/main/steam/gsi";
import type { UiResult } from "../src/main/steam/steam-ui";
import type { MatchState } from "../src/shared/types";

const ME = "76561198000000000";
const id = (n: number) => String(76561198000000000n + BigInt(n));
const t = () => Math.floor(Date.now() / 1000);
const entry = (n: number, name = `p${n}`): CoplayEntry => ({ steamId: id(n), name, appId: 730, time: t() - 5 });
const friend = (n: number, name: string | null = `f${n}`): FriendInGame => ({ steamId: id(n), name, presence: {} });
/** A `status` list with these names, slots from 0. Names are as the lobby shows them. */
const block = (...names: string[]): StatusBlock & { at: number } => ({ players: names.map((name, slot) => ({ slot, name })), loggedAt: null, at: Date.now() });

describe("friends found by `status`, and the hint", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  interface Setup {
    entries?: () => CoplayEntry[];
    friends?: () => FriendInGame[];
    names?: () => FriendNames;
    ui?: UiResult;
    hint?: (ctx: { statusSeen: boolean; sessionStartMs: number | null }) => string | null;
  }

  function make(o: Setup = {}) {
    let push: (s: GameState) => void = () => {};
    let onBlock: (b: StatusBlock) => void = () => {};
    const matches: MatchState[] = [];
    const hints: (string | null)[] = [];
    const hintCtx: { statusSeen: boolean; sessionStartMs: number | null }[] = [];
    const src = new SteamSource({
      scan: async (): Promise<CoplayResult> => ({ localName: "Nova", entries: o.entries?.() ?? [], friends: o.friends?.() ?? [] }),
      listen: (on) => ((push = on), () => {}),
      listenStatus: (on) => ((onBlock = on), () => {}),
      friendNames: o.names ? async () => o.names!() : undefined,
      friendsHint: async (ctx) => (hintCtx.push(ctx), o.hint ? o.hint(ctx) : null),
      uiStatus: o.ui ? async () => o.ui! : undefined,
      fastMs: 1000, slowMs: 10_000,
    });
    src.on("match", (m) => matches.push(m));
    src.on("hint", (h) => hints.push(h));
    const state = (map: string | null, phase: GameState["phase"] = "warmup"): GameState => ({ map, mode: "competitive", phase, localSteamId: ME });
    return {
      src, matches, hints, hintCtx,
      push: (s: GameState) => push(s),
      status: (b: StatusBlock) => onBlock(b),
      state,
      names: () => matches.at(-1)!.players.map((p) => p.name),
    };
  }

  /** Steam's list has eight players, `Nova` is us, and Bob (a friend) is the ninth player in the lobby. */
  const eight = () => [1, 2, 3, 4, 5, 6, 7, 8].map((n) => entry(n));
  const lobby = () => block("Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "Bob");

  it("adds a friend whose name is in the list, right after `status` is run", async () => {
    const m = make({ entries: eight, friends: () => [friend(50, "Bob")] });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.names()).toEqual(["Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);       // Steam leaves friends out
    m.status(lobby());
    await vi.advanceTimersByTimeAsync(50);                                                      // not a scan interval later
    expect(m.names()).toEqual(["Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "Bob"]);
    expect(m.matches.at(-1)!.players.at(-1)).toMatchObject({ steamId: id(50), name: "Bob", isLocal: false });
    m.src.stop();
  });

  it("scans again after a list that arrived in the middle of a scan", async () => {
    let release: () => void = () => {};
    let first = true;
    const m = make({ entries: eight, friends: () => [friend(50, "Bob")] });
    const slow = new SteamSource({
      scan: async () => {
        if (first) { first = false; await new Promise<void>((r) => (release = r)); }
        return { localName: "Nova", entries: eight(), friends: [friend(50, "Bob")] };
      },
      listen: (on) => (on(m.state("de_mirage")), () => {}),
      listenStatus: (on) => (setTimeout(() => on(lobby()), 100), () => {}),
      fastMs: 60_000, slowMs: 60_000,
    });
    const seen: MatchState[] = [];
    slow.on("match", (x) => seen.push(x));
    slow.start();
    await vi.advanceTimersByTimeAsync(200);                  // the list arrives while the first scan is waiting
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(seen.at(-1)!.players.map((p) => p.name)).toContain("Bob");
    slow.stop();
  });

  it("ignores a list while not in a match, and an empty one", async () => {
    const m = make({ entries: eight, friends: () => [friend(50, "Bob")] });
    m.src.start();
    m.push(m.state(null, null));                              // the menu
    m.status(lobby());
    await vi.advanceTimersByTimeAsync(2_000);
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.names()).not.toContain("Bob");
    m.status(block());                                        // `status` while not connected: no players
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.names()).not.toContain("Bob");
    m.src.stop();
  });

  it("doesn't take a friend for a stranger who has the same name", async () => {
    // A stranger called Bob is in the match and in Steam's list; a friend called Bob plays CS2 somewhere else.
    const m = make({ entries: () => [...[1, 2, 3, 4, 5, 6, 7].map((n) => entry(n)), entry(8, "Bob")], friends: () => [friend(50, "Bob")] });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    m.status(block("Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "Bob"));
    await vi.advanceTimersByTimeAsync(50);
    expect(m.matches.at(-1)!.players.filter((p) => p.steamId === id(50))).toEqual([]);
    expect(m.names()).toContain("Bob");                                                         // the stranger, from Steam's list
    m.src.stop();
  });

  it("leaves out names that fit two players", async () => {
    const m = make({ entries: eight, friends: () => [friend(50, "Bob")] });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    m.status(block("Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "Bob", "Bob"));
    await vi.advanceTimersByTimeAsync(50);
    expect(m.matches.at(-1)!.players.filter((p) => p.steamId === id(50))).toEqual([]);
    m.src.stop();
  });

  it("keeps a friend for the match even after he leaves the friends in CS2, and forgets him on a new map", async () => {
    let inCs2 = [friend(50, "Bob")];
    const m = make({ entries: eight, friends: () => inCs2 });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    m.status(lobby());
    await vi.advanceTimersByTimeAsync(50);
    inCs2 = [];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(m.names()).toContain("Bob");
    m.push(m.state("de_nuke"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.names()).not.toContain("Bob");
    m.src.stop();
  });

  it("finds a friend who appears offline through the Web API's names", async () => {
    const m = make({ entries: eight, friends: () => [], names: () => ({ friends: [{ steamId: id(60), name: "Ghost" }, { steamId: id(61), name: "Nobody" }], error: null }) });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    m.status(block("Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "Ghost"));
    await vi.advanceTimersByTimeAsync(50);
    expect(m.matches.at(-1)!.players.at(-1)).toMatchObject({ steamId: id(60), name: "Ghost" });
    m.src.stop();
  });

  it("says once why the Web API's names can't be used", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = make({ entries: eight, friends: () => [friend(50, "Bob")], names: () => ({ friends: [], error: "private" }) });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    m.status(lobby());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("isn't public");
    expect(m.names()).toContain("Bob");                                                         // the Steam client's list still worked
    m.src.stop();
  });

  it("puts friends in order: Steam's players, then `status` friends, then friends-list friends, each friend once", async () => {
    // Friends 50 (named in `status`), 51 (only the friends list knows) and 52 (both) are in CS2; six players from Steam.
    const six = () => [1, 2, 3, 4, 5, 6].map((n) => entry(n));
    const ui: UiResult = {
      ok: true,
      snapshot: {
        own: "Competitive - Mirage [ 3 : 2 ]",
        rows: [51, 52].map((n) => ({ group: "Counter-Strike 2", nickname: `f${n}`, persona: "", status: "Competitive - Mirage [ 3 : 2 ]" })),
      },
    };
    const m = make({ entries: six, friends: () => [friend(50, "Bob"), friend(51), friend(52)], ui });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.names()).toEqual(["Nova", "p1", "p2", "p3", "p4", "p5", "p6", "f51", "f52"]);       // the friends list alone
    m.status(block("Nova", "p1", "p2", "p3", "p4", "p5", "p6", "Bob", "f52"));
    await vi.advanceTimersByTimeAsync(50);
    expect(m.names()).toEqual(["Nova", "p1", "p2", "p3", "p4", "p5", "p6", "Bob", "f52", "f51"]); // `status` friends first, f52 once
    m.src.stop();
  });

  it("never grows the roster past the mode's size", async () => {
    const m = make({ entries: eight, friends: () => [friend(50, "Bob"), friend(51, "Zed")] });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    m.status(block("Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "Bob", "Zed"));
    await vi.advanceTimersByTimeAsync(50);
    expect(m.matches.at(-1)!.players).toHaveLength(10);                                         // us + 9
    expect(m.names()).toContain("Bob");
    expect(m.names()).not.toContain("Zed");
    m.src.stop();
  });

  describe("the hint", () => {
    const text = (ctx: { statusSeen: boolean }) => (ctx.statusSeen ? null : "Run status.");

    it("is shown while friends are in CS2 and a slot is empty, and goes once `status` has been run", async () => {
      const m = make({ entries: eight, friends: () => [friend(50, "Bob")], hint: text });
      m.src.start();
      m.push(m.state("de_mirage"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(m.hints).toEqual(["Run status."]);
      expect(m.hintCtx[0].statusSeen).toBe(false);
      m.status(lobby());
      await vi.advanceTimersByTimeAsync(50);
      expect(m.hintCtx.at(-1)!.statusSeen).toBe(false);          // the lobby fills up with Bob...
      expect(m.hints.at(-1)).toBeNull();                          // ...so there is nothing left to hint at
    });

    it("is asked for again, right away, once `status` has been run and a slot is still empty", async () => {
      const seven = () => [1, 2, 3, 4, 5, 6, 7].map((n) => entry(n));
      const m = make({ entries: seven, friends: () => [friend(50, "Bob"), friend(51, "Zed")], hint: text });
      m.src.start();
      m.push(m.state("de_mirage"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(m.hints).toEqual(["Run status."]);
      m.status(block("Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "Bob"));
      await vi.advanceTimersByTimeAsync(50);
      expect(m.hintCtx.at(-1)!.statusSeen).toBe(true);
      expect(m.hints.at(-1)).toBeNull();                          // Zed is playing CS2 but `status` didn't list him
      m.src.stop();
    });

    it("isn't shown when the match is full, when no friend is in CS2, or with nothing to say", async () => {
      const full = make({ entries: () => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => entry(n)), friends: () => [friend(50, "Bob")], hint: text });
      full.src.start(); full.push(full.state("de_mirage"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(full.hintCtx).toEqual([]);
      full.src.stop();

      const none = make({ entries: eight, friends: () => [], hint: text });
      none.src.start(); none.push(none.state("de_mirage"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(none.hintCtx).toEqual([]);
      none.src.stop();

      const quiet = make({ entries: eight, friends: () => [friend(50, "Bob")], hint: () => null });
      quiet.src.start(); quiet.push(quiet.state("de_mirage"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(quiet.hints).toEqual([]);
      quiet.src.stop();
    });

    it("is worked out at most every 15 seconds", async () => {
      const m = make({ entries: eight, friends: () => [friend(50, "Bob")], hint: text });
      m.src.start();
      m.push(m.state("de_mirage"));
      await vi.advanceTimersByTimeAsync(14_000);                 // scans every second or so, nobody found
      expect(m.hintCtx).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(m.hintCtx).toHaveLength(2);
      m.src.stop();
    });

    it("goes when the map changes", async () => {
      const m = make({ entries: eight, friends: () => [friend(50, "Bob")], hint: text });
      m.src.start();
      m.push(m.state("de_mirage"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(m.hints).toEqual(["Run status."]);
      m.push(m.state(null, null));
      expect(m.hints.at(-1)).toBeNull();
      m.src.stop();
    });

    it("tells the hint when CS2's session began", async () => {
      const m = make({ entries: eight, friends: () => [friend(50, "Bob")], hint: text });
      m.src.start();
      m.push(m.state("de_mirage"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(m.hintCtx[0].sessionStartMs).toBe(1_800_000_000_000);
      m.src.stop();
    });
  });
});
