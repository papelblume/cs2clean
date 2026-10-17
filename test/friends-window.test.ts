import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SteamSource } from "../src/main/game/steam";
import type { CoplayEntry, CoplayResult, FriendInGame } from "../src/main/steam/coplay";
import { FRIENDS_WINDOW_URL, FriendsWindowOpener, type EnsureResult, type FriendsWindow, type WindowState } from "../src/main/steam/friends-window";
import type { GameState } from "../src/main/steam/gsi";
import type { UiResult } from "../src/main/steam/steam-ui";

describe("FriendsWindowOpener", () => {
  function setup(opts: { states?: WindowState[]; enabled?: boolean; openFails?: boolean } = {}) {
    let t = 1_000_000;
    const queue = [...(opts.states ?? [])];
    let last: WindowState = "closed";
    const opened: string[] = [];
    const o = new FriendsWindowOpener({
      open: async (url) => { if (opts.openFails) throw new Error("no handler"); opened.push(url); },
      windowState: async () => (last = queue.shift() ?? last),
      enabled: () => opts.enabled ?? true,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      minGapMs: 60_000, maxPerMatch: 3, waitMs: 2_000, pollMs: 500,
    });
    return { o, opened, advance: (ms: number) => { t += ms; }, set: (s: WindowState) => { queue.length = 0; last = s; } };
  }

  it("does nothing when the setting is off", async () => {
    const { o, opened } = setup({ enabled: false });
    expect(await o.ensure("start")).toBe("disabled");
    expect(opened).toEqual([]);
  });

  it("does nothing when the debug port can't be reached, or the window is already open", async () => {
    const a = setup({ states: ["unreachable"] });
    expect(await a.o.ensure("warmup")).toBe("unreachable");
    expect(a.opened).toEqual([]);
    const b = setup({ states: ["open"] });
    expect(await b.o.ensure("warmup")).toBe("open");
    expect(b.opened).toEqual([]);
  });

  it("opens steam://open/friends, and nothing else, then waits for the window", async () => {
    const { o, opened } = setup({ states: ["closed", "closed", "closed", "open"] });
    expect(await o.ensure("start")).toBe("opened");
    expect(opened).toEqual([FRIENDS_WINDOW_URL]);
    expect(FRIENDS_WINDOW_URL).toBe("steam://open/friends");
  });

  it("reports a window that never shows up, then keeps its distance, then gives up for the match", async () => {
    const { o, opened, advance } = setup();
    expect(await o.ensure("start")).toBe("no-show");
    expect(await o.ensure("warmup")).toBe("wait");              // asked a moment ago
    advance(61_000);
    expect(await o.ensure("warmup")).toBe("no-show");
    advance(61_000);
    expect(await o.ensure("warmup")).toBe("no-show");
    advance(61_000);
    expect(await o.ensure("warmup")).toBe("limit");              // three tries used
    expect(opened).toHaveLength(3);
    o.newMatch();
    expect(await o.ensure("warmup")).toBe("no-show");            // a new match, a new budget
    expect(opened).toHaveLength(4);
  });

  it("reports a refused address as failed, and a port that closes while waiting as unreachable", async () => {
    expect(await setup({ openFails: true }).o.ensure("start")).toBe("failed");
    expect(await setup({ states: ["closed", "unreachable"] }).o.ensure("start")).toBe("unreachable");
  });

  it("runs one try at a time", async () => {
    const { o, opened } = setup({ states: ["closed", "closed", "open"] });
    const [a, b] = await Promise.all([o.ensure("start"), o.ensure("warmup")]);
    expect([a, b].sort()).toEqual(["busy", "opened"]);
    expect(opened).toHaveLength(1);
  });
});

describe("SteamSource opening the friends window", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    vi.spyOn(console, "warn").mockImplementation(() => {}); // the generic "can't be read" line when no hint is given
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const ME = "76561198000000000";
  const id = (n: number) => String(76561198000000000n + BigInt(n));
  const t = () => Math.floor(Date.now() / 1000);
  const E = (n: number): CoplayEntry => ({ steamId: id(n), name: `p${n}`, appId: 730, time: t() - 5 });
  const friend = (n: number): FriendInGame => ({ steamId: id(n), name: `f${n}`, presence: {} });

  function make(o: { coplay?: number; friends?: FriendInGame[]; results?: EnsureResult[]; ui?: UiResult; hint?: () => Promise<string | null> } = {}) {
    let push: (s: GameState) => void = () => {};
    const results = [...(o.results ?? [])];
    const calls: string[] = [];
    let newMatches = 0;
    const friendsWindow: FriendsWindow = {
      ensure: async (reason) => (calls.push(reason), results.shift() ?? "open"),
      newMatch: () => { newMatches++; },
    };
    const src = new SteamSource({
      scan: async (): Promise<CoplayResult> => ({ localName: "Nova", entries: Array.from({ length: o.coplay ?? 0 }, (_, i) => E(i + 1)), friends: o.friends ?? [] }),
      listen: (on) => ((push = on), () => {}),
      uiStatus: async () => o.ui ?? { ok: false, reason: "no-friends-window" },
      friendsWindow,
      friendsListHint: o.hint,
      fastMs: 1000, slowMs: 10_000,
    });
    const state = (phase: GameState["phase"], map: string | null = "de_mirage"): GameState => ({ map, mode: "competitive", phase, localSteamId: ME });
    return { src, calls, push: (s: GameState) => push(s), state, newMatches: () => newMatches };
  }

  it("opens it once when the app has started and nothing is going on, and stops once it is open", async () => {
    const { src, calls } = make({ results: ["unreachable", "open"] });
    src.start();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(calls).toEqual([]);                                    // not before CS2 has had a heartbeat to say what it does
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(["start"]);                              // Steam wasn't reachable yet...
    await vi.advanceTimersByTimeAsync(16_000);
    expect(calls).toEqual(["start", "start"]);                     // ...so it tried again, and found the window open
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(2);
    src.stop();
  });

  it("gives up after eight tries at start", async () => {
    const { src, calls } = make({ results: Array(20).fill("unreachable") });
    src.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(8);
    src.stop();
  });

  it("leaves a live round alone at start, and goes ahead in warm-up", async () => {
    const live = make();
    live.src.start();
    live.push(live.state("live"));
    await vi.advanceTimersByTimeAsync(13_000);
    expect(live.calls).toEqual([]);
    live.push(live.state("warmup"));                               // the next heartbeat says warm-up
    await vi.advanceTimersByTimeAsync(16_000);
    expect(live.calls).toContain("start");
    live.src.stop();
  });

  it("opens it in warm-up while a friend is in CS2 and a slot is empty", async () => {
    const { src, calls, push, state } = make({ coplay: 8, friends: [friend(50)] });
    src.start();
    push(state("warmup"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toContain("warmup");
    src.stop();
  });

  it("does not open it in warm-up when no friend is in CS2, the lobby is full, or the round is live", async () => {
    const none = make({ coplay: 8, friends: [] });
    none.src.start(); none.push(none.state("warmup"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(none.calls.filter((c) => c === "warmup")).toEqual([]);
    none.src.stop();

    const full = make({ coplay: 9, friends: [friend(50)] });
    full.src.start(); full.push(full.state("warmup"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(full.calls.filter((c) => c === "warmup")).toEqual([]);
    full.src.stop();

    const live = make({ coplay: 8, friends: [friend(50)] });
    live.src.start(); live.push(live.state("live"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(live.calls.filter((c) => c === "warmup")).toEqual([]);
    live.src.stop();
  });

  it("starts the opener's budget again when a map loads", async () => {
    const { src, push, state, newMatches } = make();
    src.start();
    push(state("warmup"));
    expect(newMatches()).toBe(1);
    push(state("live"));                                           // same map: not a new match
    expect(newMatches()).toBe(1);
    push(state(null, null));                                       // back to the menu: nothing to reset
    expect(newMatches()).toBe(1);
    push(state("warmup", "de_nuke"));
    expect(newMatches()).toBe(2);
    src.stop();
  });

  it("says why the friends list can't be read, once, when a hint is available", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { src, push, state } = make({ coplay: 8, friends: [friend(50)], ui: { ok: false, reason: "unreachable" }, hint: async () => "Steam's debug port is off." });
    src.start();
    push(state("warmup"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("Steam's debug port is off.");
    src.stop();
  });

  it("stays quiet when there is nothing to say", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { src, push, state } = make({ coplay: 8, friends: [friend(50)], ui: { ok: false, reason: "no-friends-window" }, hint: async () => null });
    src.start();
    push(state("warmup"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warn).not.toHaveBeenCalled();
    src.stop();
  });
});
