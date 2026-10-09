import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Controller, type ControllerDeps, type Settings } from "../src/main/controller";
import { ReplaySource } from "../src/main/game/replay";
import { GameSource, type RecordedLine } from "../src/main/game/source";
import type { LeetifyProfile } from "../src/main/leetify";
import type { MatchState } from "../src/shared/types";
import { AVERAGE, ELEVATED, HIGH, VERY_HIGH } from "./profiles";

/** A fake Leetify public API: profiles by SteamID64 (default: an average player), and the one key it accepts. */
function fakeLeetify() {
  const s = { lookups: [] as string[], keys: [] as (string | null)[], goodKey: "good-key" as string | null, requireKey: false,
              profiles: {} as Record<string, LeetifyProfile>, down: false };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (s.down) throw new TypeError("fetch failed");
    const u = new URL(url);
    const key = new Headers(init?.headers).get("_leetify_key");
    if (u.pathname === "/api-key/validate") return key && key === s.goodKey ? json(200, {}) : json(401, { error: "bad key" });
    if (s.requireKey && key !== s.goodKey) return json(401, { error: "bad key" });
    const id = u.searchParams.get("steam64_id") ?? "";
    s.lookups.push(id);
    s.keys.push(key);
    return json(200, s.profiles[id] ?? AVERAGE());
  }) as typeof fetch;
  return { s, fetchImpl };
}

const LINES: RecordedLine[] = [
  { t: 0, kind: "running", value: true },
  { t: 10, kind: "info", category: "match_info", key: "roster_0", value: JSON.stringify({ nickname: "a", steamid: "76561198000000001", team: "CT", is_local: "1" }) },
  { t: 10, kind: "info", category: "match_info", key: "roster_1", value: JSON.stringify({ nickname: "b", steamid: "76561198000000002", team: "T" }) },
];

/** A source the test drives directly. */
class FakeSource extends GameSource {
  readonly kind = "steam" as const;
  refreshed = 0;
  start() {}
  stop() {}
  refresh() {
    this.refreshed++;
  }
  send(m: Partial<MatchState>) {
    this.emit("match", { map: "de_dust2", mode: "competitive", phase: "warmup", localSteamId: null, players: [], ...m });
  }
}

const P = (n: number, name = `p${n}`) => ({ slot: n, name, steamId: String(76561198000000000n + BigInt(n)), side: null, isLocal: n === 0 });

function setup(settings: Settings = {}, source: GameSource = new ReplaySource(LINES), extra: Partial<ControllerDeps> = {}) {
  const server = fakeLeetify();
  let saved: Settings = settings;
  const c = new Controller({
    version: "test",
    source,
    store: { load: () => saved, save: (x) => (saved = x) },
    overlay: { hotkey: "Shift+F2", detailHotkey: "F7", cycleHotkey: "F6", previousHotkey: "Shift+F6", mode: "window", visible: false, view: "lobby", focusSlot: null, siren: true },
    fetchImpl: server.fetchImpl,
    lobby: { debounceMs: 5 },
    ...extra,
  });
  return { c, server, saved: () => saved };
}

describe("Controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("looks up every player of the match on Leetify and classifies them", async () => {
    const { c, server } = setup();
    server.s.profiles["76561198000000002"] = VERY_HIGH();
    c.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(c.state.lobby.rows).toHaveLength(2);
    expect(server.s.lookups.sort()).toEqual(["76561198000000001", "76561198000000002"]);
    expect(c.state.lobby.rows.map((r) => r.classification)).toEqual(["NORMAL", "VERY_HIGH"]);
    expect(c.state.lobby.rows[1].detail?.score).toBeGreaterThanOrEqual(80);
    expect(c.state.leetify.reachable).toBe(true);
    c.stop();
  });

  it("works without an API key, and uses the one from the environment when none is saved", async () => {
    const a = setup();
    expect(a.c.state.leetify.hasKey).toBe(false);
    a.c.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(a.server.s.keys.every((k) => k === null)).toBe(true);
    expect(a.c.state.lobby.rows[0].classification).toBe("NORMAL");
    a.c.stop();

    const b = setup({}, undefined, { envKey: "env-key" });
    expect(b.c.state.leetify.hasKey).toBe(true);
    b.c.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(new Set(b.server.s.keys)).toEqual(new Set(["env-key"]));
    b.c.stop();

    // A saved key wins over the environment.
    const d = setup({ leetifyKey: "saved-key" }, undefined, { envKey: "env-key" });
    d.c.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(new Set(d.server.s.keys)).toEqual(new Set(["saved-key"]));
    d.c.stop();
  });

  it("checks an API key with Leetify before saving it, then asks again with it", async () => {
    const { c, server, saved } = setup();
    server.s.requireKey = true;
    c.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(c.state.lobby.error).toMatch(/wants an API key/);
    expect(c.state.lobby.rows.every((r) => r.classification === null)).toBe(true);

    expect(await c.setApiKey("wrong")).toBe(false);
    expect(c.state.notice).toMatch(/rejected that API key/);
    expect(saved().leetifyKey).toBeUndefined();
    expect(c.state.leetify.hasKey).toBe(false);

    expect(await c.setApiKey("  good-key ")).toBe(true);
    expect(saved().leetifyKey).toBe("good-key");
    expect(c.state.leetify.hasKey).toBe(true);
    expect(c.state.notice).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(c.state.lobby.error).toBeNull();
    expect(c.state.lobby.rows.map((r) => r.classification)).toEqual(["NORMAL", "NORMAL"]);

    c.clearApiKey();
    expect(saved().leetifyKey).toBeNull();
    expect(c.state.leetify.hasKey).toBe(false);
    c.stop();
  });

  it("doesn't save a key when Leetify can't be reached to check it", async () => {
    const { c, server, saved } = setup();
    server.s.down = true;
    expect(await c.setApiKey("good-key")).toBe(false);
    expect(c.state.notice).toMatch(/Couldn't check the key/);
    expect(saved().leetifyKey).toBeUndefined();
  });

  it("shows when Leetify can't be reached, and recovers", async () => {
    const { c, server } = setup({}, undefined, { lobby: { debounceMs: 5, retryMs: 1000 } });
    server.s.down = true;
    c.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(c.state.leetify.reachable).toBe(false);
    expect(c.state.lobby.rows[0].status).toBe("error");
    server.s.down = false;
    await vi.advanceTimersByTimeAsync(1100);
    expect(c.state.leetify.reachable).toBe(true);
    expect(c.state.lobby.rows[0].classification).toBe("NORMAL");
    c.stop();
  });

  it("builds Leetify profile links only for Steam IDs", async () => {
    const { c } = setup();
    expect(c.playerUrl("76561198000000002")).toBe("https://leetify.com/app/profile/76561198000000002");
    expect(c.playerUrl("../evil")).toBeNull();
  });

  it("shows the overlay in warm-up, hides it when the match goes live, and hotkeys bring it back", async () => {
    const src = new FakeSource();
    const { c } = setup({}, src);
    c.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(c.state.overlay.visible).toBe(false);

    src.send({ players: [P(0), P(1), P(2)] });
    expect(c.state.overlay).toMatchObject({ visible: true, view: "lobby" });

    src.send({ phase: "live", players: [P(0), P(1), P(2)] });
    expect(c.state.overlay.visible).toBe(false);
    src.send({ phase: "live", players: [P(0), P(1), P(2)] }); // stays hidden on later updates
    expect(c.state.overlay.visible).toBe(false);

    c.toggleDetail();
    expect(c.state.overlay).toMatchObject({ visible: true, view: "detail" });
    c.toggleOverlay(); // switches to the list instead of hiding
    expect(c.state.overlay).toMatchObject({ visible: true, view: "lobby" });
    expect(src.refreshed).toBe(1);
    c.toggleOverlay();
    expect(c.state.overlay.visible).toBe(false);
    c.stop();
  });

  it("raises the siren once per HIGH or VERY_HIGH player per match, unless turned off", async () => {
    const src = new FakeSource();
    const { c, server, saved } = setup({}, src);
    server.s.profiles[P(2).steamId] = HIGH();
    c.start();
    await vi.advanceTimersByTimeAsync(20);

    src.send({ players: [P(0), P(1), P(2)] });
    await vi.advanceTimersByTimeAsync(900);
    expect(c.state.alert).toEqual({ seq: 1, names: ["p2"] });

    src.send({ players: [P(0), P(1), P(2), P(3)] }); // more players found: no second siren for p2
    await vi.advanceTimersByTimeAsync(900);
    expect(c.state.alert.seq).toBe(1);

    src.send({ map: null, players: [] }); // back to the menu, then a new match with the same player
    src.send({ map: "de_nuke", players: [P(0), P(2)] });
    await vi.advanceTimersByTimeAsync(20);
    expect(c.state.alert.seq).toBe(2);

    c.setSiren(false);
    expect(saved().siren).toBe(false);
    src.send({ map: null, players: [] });
    src.send({ map: "de_inferno", players: [P(0), P(2)] });
    await vi.advanceTimersByTimeAsync(20);
    expect(c.state.alert.seq).toBe(2);
    c.testSiren();
    expect(c.state.alert.seq).toBe(3);
    c.stop();
  });

  it("changes the overlay hotkeys, and keeps the old ones when a new one can't be used", () => {
    const applied: string[] = [];
    const taken = new Set(["Ctrl+F9"]);
    const applyHotkeys = (h: { lobby: string; detail: string; cycle: string; previous: string }) => {
      applied.push(`${h.lobby} ${h.detail} ${h.cycle} ${h.previous}`);
      return [h.lobby, h.detail, h.cycle, h.previous].some((k) => taken.has(k)) ? "Ctrl+F9 is already used by another program." : null;
    };
    const { c, saved } = setup({}, undefined, { applyHotkeys });
    c.start();
    expect(applied).toEqual(["Shift+F2 F7 F6 Shift+F6"]);
    expect(c.state.hotkeysEditable).toBe(true);

    expect(c.setHotkey("lobby", "F8")).toBe(true);
    expect(c.state.overlay.hotkey).toBe("F8");
    expect(saved().hotkeys).toEqual({ lobby: "F8", detail: "F7", cycle: "F6", previous: "Shift+F6" });

    // A plain letter would stop the user typing it anywhere.
    expect(c.setHotkey("detail", "K")).toBe(false);
    expect(c.state.notice).toMatch(/Ctrl or Alt/);
    expect(c.setHotkey("detail", "F8")).toBe(false);
    expect(c.state.notice).toMatch(/other overlay hotkey/);
    expect(c.setHotkey("detail", "Ctrl+F9")).toBe(false);
    expect(c.state.notice).toMatch(/another program/);
    expect(applied.at(-1)).toBe("F8 F7 F6 Shift+F6"); // the old keys are registered again
    expect(c.state.overlay.detailHotkey).toBe("F7");

    expect(c.setHotkey("detail", "Ctrl+Alt+K")).toBe(true);

    // The cycle key follows the same rules as the other two.
    expect(c.setHotkey("cycle", "F8")).toBe(false);               // the list's key
    expect(c.state.notice).toMatch(/another overlay hotkey/);
    expect(c.setHotkey("cycle", "Ctrl+F9")).toBe(false);          // taken by another program
    expect(c.state.overlay.cycleHotkey).toBe("F6");
    expect(c.setHotkey("cycle", "Insert")).toBe(true);
    expect(c.state.overlay.cycleHotkey).toBe("Insert");
    expect(c.setHotkey("previous", "Insert")).toBe(false);        // the next-player key
    expect(c.setHotkey("previous", "Delete")).toBe(true);
    expect(c.state.overlay.previousHotkey).toBe("Delete");
    expect(saved().hotkeys).toEqual({ lobby: "F8", detail: "Ctrl+Alt+K", cycle: "Insert", previous: "Delete" });

    expect(c.resetHotkeys()).toBe(true);
    expect(c.state.overlay).toMatchObject({ hotkey: "Shift+F2", detailHotkey: "F7", cycleHotkey: "F6", previousHotkey: "Shift+F6" });
    c.stop();
  });

  it("F6 steps through every player, yourself included (CT, then T), and hides after the last", async () => {
    const src = new FakeSource();
    const { c, server } = setup({}, src);
    server.s.profiles[P(3).steamId] = VERY_HIGH(); // one flagged player: F6 doesn't care
    c.start();
    await vi.advanceTimersByTimeAsync(20);
    // Slots 0 (me, CT), 1 (T), 2 (CT), 3 (side unknown), 4 (T): the cycle goes 0, 2, 1, 4, 3.
    src.send({ phase: "live", players: [{ ...P(0), side: "CT" }, { ...P(1), side: "T" }, { ...P(2), side: "CT" }, P(3), { ...P(4), side: "T" }] });
    await vi.advanceTimersByTimeAsync(900);
    expect(c.state.overlay.visible).toBe(false);

    const shown = () => (c.state.overlay.visible ? `${c.state.overlay.view}:${c.state.overlay.focusSlot}` : "hidden");
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      c.cyclePlayer();
      seen.push(shown());
    }
    expect(seen).toEqual(["player:0", "player:2", "player:1", "player:4", "player:3", "hidden"]);

    // Other keys switch views, and F6 then starts again from the first player.
    c.toggleOverlay();
    expect(c.state.overlay).toMatchObject({ visible: true, view: "lobby" });
    c.cyclePlayer();
    expect(shown()).toBe("player:0");
    c.toggleDetail();
    c.cyclePlayer();
    expect(shown()).toBe("player:0");

    // A new match forgets who was shown.
    c.cyclePlayer();
    expect(shown()).toBe("player:2");
    src.send({ map: "de_nuke", phase: "live", players: [{ ...P(0), side: "CT" }, { ...P(1), side: "T" }] });
    expect(c.state.overlay.focusSlot).toBeNull();
    c.stop();
  });

  it("Shift+F6 walks the same list backwards: the last player first, and it hides before the first", async () => {
    const src = new FakeSource();
    const { c } = setup({}, src);
    c.start();
    await vi.advanceTimersByTimeAsync(20);
    // Same lobby as the F6 test: the list is 0 (me, CT), 2 (CT), 1 (T), 4 (T), 3 (side unknown).
    src.send({ phase: "live", players: [{ ...P(0), side: "CT" }, { ...P(1), side: "T" }, { ...P(2), side: "CT" }, P(3), { ...P(4), side: "T" }] });
    await vi.advanceTimersByTimeAsync(900);

    const shown = () => (c.state.overlay.visible ? `${c.state.overlay.view}:${c.state.overlay.focusSlot}` : "hidden");
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      c.previousPlayer();
      seen.push(shown());
    }
    expect(seen).toEqual(["player:3", "player:4", "player:1", "player:2", "player:0", "hidden", "player:3"]);

    // F6 and Shift+F6 move along the same walk.
    c.previousPlayer();                       // player:4
    c.cyclePlayer();                          // back to 3
    expect(shown()).toBe("player:3");
    c.cyclePlayer();                          // after the last: hides
    expect(shown()).toBe("hidden");
    c.cyclePlayer();                          // F6 starts at the first player...
    expect(shown()).toBe("player:0");
    c.previousPlayer();                       // ...and Shift+F6 before the first hides
    expect(shown()).toBe("hidden");

    // Another key switches views, and Shift+F6 then starts again from the last player.
    c.toggleOverlay();
    c.previousPlayer();
    expect(shown()).toBe("player:3");
    c.stop();
  });

  it("Shift+F6 with nobody in the lobby shows the overlay once and hides it on the next press", async () => {
    const src = new FakeSource();
    const { c } = setup({}, src);
    c.start();
    c.previousPlayer();
    expect(c.state.overlay).toMatchObject({ visible: true, view: "player", focusSlot: null });
    c.previousPlayer();
    expect(c.state.overlay.visible).toBe(false);
    c.stop();
  });

  it("looks up only the first 10 players of a 12-player lobby", async () => {
    const src = new FakeSource();
    const { c, server } = setup({}, src);
    c.start();
    await vi.advanceTimersByTimeAsync(20);
    src.send({ players: Array.from({ length: 12 }, (_, i) => P(i)) });
    await vi.advanceTimersByTimeAsync(900);
    expect(server.s.lookups).toHaveLength(10);
    expect(new Set(server.s.lookups)).toEqual(new Set(Array.from({ length: 10 }, (_, i) => P(i).steamId)));
    const rows = c.state.lobby.rows;
    expect(rows.slice(10).map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(rows.slice(0, 10).every((r) => r.classification === "NORMAL")).toBe(true);
    c.stop();
  });

  it("F6 with nobody in the lobby shows the overlay once and hides it on the next press", async () => {
    const src = new FakeSource();
    const { c } = setup({}, src);
    c.start();
    c.cyclePlayer();
    expect(c.state.overlay).toMatchObject({ visible: true, view: "player", focusSlot: null });
    c.cyclePlayer();
    expect(c.state.overlay.visible).toBe(false);
    c.stop();
  });

  it("falls back to the default hotkeys when a saved one is taken at start-up", () => {
    const applyHotkeys = (h: { lobby: string }) => (h.lobby === "F8" ? "F8 is already used by another program." : null);
    const { c } = setup({ hotkeys: { lobby: "F8", detail: "F7" } }, undefined, { applyHotkeys });
    c.start();
    expect(c.state.overlay.hotkey).toBe("Shift+F2");
    expect(c.state.overlay.cycleHotkey).toBe("F6");
    expect(c.state.notice).toMatch(/F8 is already used/);
    c.stop();
  });

  it("turns starting with Windows on and off where it's offered", () => {
    expect(setup().c.state.startWithWindows).toBeNull();
    let on = false;
    const { c } = setup({}, undefined, { startup: { get: () => on, set: (v) => (on = v) } });
    expect(c.state.startWithWindows).toBe(false);
    c.setStartWithWindows(true);
    expect(on).toBe(true);
    expect(c.state.startWithWindows).toBe(true);
  });
});
