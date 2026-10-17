import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SteamSource } from "../src/main/game/steam";
import type { StatusBlock } from "../src/main/steam/console-log";
import type { CoplayEntry, CoplayResult, FriendInGame } from "../src/main/steam/coplay";
import type { GameState } from "../src/main/steam/gsi";
import type { MatchState } from "../src/shared/types";

const ME = "76561198000000000";
const id = (n: number) => String(76561198000000000n + BigInt(n));
const t = () => Math.floor(Date.now() / 1000);
const entry = (n: number): CoplayEntry => ({ steamId: id(n), name: `p${n}`, appId: 730, time: t() - 5 });
const friend = (n: number, name: string | null = `f${n}`): FriendInGame => ({ steamId: id(n), name, presence: {} });
const eight = () => [1, 2, 3, 4, 5, 6, 7, 8].map(entry);

describe("the mini-profile fallback in a match", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function make(o: {
    entries?: () => CoplayEntry[];
    friends?: () => FriendInGame[];
    lines?: Record<string, string | null>;
    wanted?: boolean | (() => boolean);
    fallback?: boolean;      // false: the source isn't given the fallback at all
    mode?: string;
  } = {}) {
    let push: (s: GameState) => void = () => {};
    let onBlock: (b: StatusBlock) => void = () => {};
    const matches: MatchState[] = [];
    const asked: string[] = [];
    let wantedCalls = 0;
    const src = new SteamSource({
      scan: async (): Promise<CoplayResult> => ({ localName: "Nova", entries: (o.entries ?? eight)(), friends: o.friends?.() ?? [] }),
      listen: (on) => ((push = on), () => {}),
      listenStatus: (on) => ((onBlock = on), () => {}),
      ...(o.fallback === false ? {} : {
        friendStatus: async (sid: string) => (asked.push(sid), o.lines?.[sid] ?? null),
        profileFallback: async () => (wantedCalls++, typeof o.wanted === "function" ? o.wanted() : o.wanted ?? true),
      }),
      fastMs: 1000, slowMs: 10_000,
    });
    src.on("match", (m) => matches.push(m));
    const state = (map: string | null, phase: GameState["phase"] = "warmup"): GameState => ({ map, mode: o.mode ?? "competitive", phase, localSteamId: ME });
    return {
      src, matches, asked, wantedCalls: () => wantedCalls,
      push: (s: GameState) => push(s), status: (b: StatusBlock) => onBlock(b), state,
      players: () => matches.at(-1)!.players,
    };
  }

  it("adds a friend whose profile says our map, marked as a guess", async () => {
    const m = make({ friends: () => [friend(50)], lines: { [id(50)]: "Premier - Mirage [ 3 : 6 ]" } });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.players().at(-1)).toMatchObject({ steamId: id(50), name: "f50", via: "profile", isLocal: false });
    expect(m.players().filter((p) => p.via === "profile")).toHaveLength(1);
    expect(m.players().filter((p) => p.via === undefined)).toHaveLength(9);        // us and Steam's eight: no mark
    m.src.stop();
  });

  it("leaves out friends on another map, in a mode that can't be ours, or with no line", async () => {
    const m = make({
      friends: () => [friend(50), friend(51), friend(52)],
      lines: { [id(50)]: "Premier - Nuke [ 3 : 6 ]", [id(51)]: "Retakes - Mirage [ 5 : 0 ]", [id(52)]: null },
    });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.players().filter((p) => p.via === "profile")).toEqual([]);
    m.src.stop();
  });

  it("adds none when more friends fit than there are empty slots", async () => {
    const m = make({ friends: () => [friend(50), friend(51)], lines: { [id(50)]: "Premier - Mirage [ 3 : 6 ]", [id(51)]: "Premier - Mirage [ 3 : 6 ]" } });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.players().filter((p) => p.via === "profile")).toEqual([]);            // one slot, two candidates
    m.src.stop();
  });

  it("does nothing when the fallback isn't wanted, or the source has none", async () => {
    const off = make({ friends: () => [friend(50)], lines: { [id(50)]: "Premier - Mirage [ 3 : 6 ]" }, wanted: false });
    off.src.start(); off.push(off.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(off.asked).toEqual([]);                                                  // no profile page is even read
    expect(off.players().some((p) => p.via)).toBe(false);
    off.src.stop();

    const none = make({ friends: () => [friend(50)], fallback: false });
    none.src.start(); none.push(none.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(none.players().some((p) => p.via)).toBe(false);
    none.src.stop();
  });

  it("reads nothing while the match is full, no friend is in CS2, or the game hasn't said the map", async () => {
    const full = make({ entries: () => [1, 2, 3, 4, 5, 6, 7, 8, 9].map(entry), friends: () => [friend(50)], lines: { [id(50)]: "Premier - Mirage [ 3 : 6 ]" } });
    full.src.start(); full.push(full.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(full.asked).toEqual([]);
    full.src.stop();

    const none = make({ friends: () => [] });
    none.src.start(); none.push(none.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(none.wantedCalls()).toBe(0);                                             // not even the capability check
    none.src.stop();
  });

  it("asks whether the fallback is wanted at most every 15 seconds, and follows the answer", async () => {
    let wanted = false;
    const m = make({ friends: () => [friend(50)], lines: { [id(50)]: "Premier - Mirage [ 3 : 6 ]" }, wanted: () => wanted });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(m.wantedCalls()).toBe(1);
    expect(m.players().some((p) => p.via)).toBe(false);
    wanted = true;                                                                  // e.g. the user turned the debug port off
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.wantedCalls()).toBe(2);
    expect(m.players().some((p) => p.via === "profile")).toBe(true);
    m.src.stop();
  });

  it("drops a guess when the friend's line changes, and on a new map", async () => {
    const lines: Record<string, string | null> = { [id(50)]: "Premier - Mirage [ 3 : 6 ]" };
    const m = make({ friends: () => [friend(50)], lines, wanted: true });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.players().some((p) => p.via === "profile")).toBe(true);
    m.push(m.state("de_nuke"));                                                     // a new match: the guess is worked out again
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.matches.at(-1)!.players.some((p) => p.via === "profile")).toBe(false);
    m.src.stop();
  });

  it("doesn't let its guesses take the place of the exact sources", async () => {
    // Two free slots; Zed fits on the map by his profile. `status` then names Bob, who takes the first of them.
    const m = make({
      entries: () => [1, 2, 3, 4, 5, 6, 7].map(entry),
      friends: () => [friend(50, "Bob"), friend(51, "Zed")],
      lines: { [id(51)]: "Premier - Mirage [ 3 : 6 ]" },
    });
    m.src.start();
    m.push(m.state("de_mirage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.players().at(-1)).toMatchObject({ name: "Zed", via: "profile" });
    m.status({ players: ["Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "Bob", "Zed"].map((name, slot) => ({ slot, name })), loggedAt: null, at: Date.now() });
    await vi.advanceTimersByTimeAsync(50);
    const names = m.players().map((p) => p.name);
    expect(names.slice(-2)).toEqual(["Bob", "Zed"]);                               // both exact now
    expect(m.players().some((p) => p.via)).toBe(false);
    m.src.stop();
  });
});
