import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SteamSource } from "../src/main/game/steam";
import type { CoplayEntry, CoplayResult, FriendInGame } from "../src/main/steam/coplay";
import type { GameState } from "../src/main/steam/gsi";
import {
  matchFriends, normalizeStatus, parseMatchStatus, readFriendUi, rowName, snapshotFromPage,
  type FriendMatch, type NativeFriend, type UiResult, type UiRow, type UiSnapshot,
} from "../src/main/steam/steam-ui";
import { COLLECT_FRIENDS_JS } from "../src/main/steam/steam-ui-page";
import type { MatchState } from "../src/shared/types";

const ME = "76561198000000000";
const id = (n: number) => String(76561198000000000n + BigInt(n));
const row = (name: string, status: string, extra: Partial<UiRow> = {}): UiRow => ({ group: "Counter-Strike 2", nickname: name, persona: "", status, ...extra });
const nf = (n: number, name: string): NativeFriend => ({ steamId: id(n), name });
const snap = (own: string | null, rows: UiRow[]): UiSnapshot => ({ own, rows });
const MIRAGE = "Competitive - Mirage [ 3 : 2 ] ";

describe("status lines", () => {
  it("normalizes spacing", () => {
    expect(normalizeStatus("  Competitive - Office [ 5 : 0 ] ")).toBe("Competitive - Office [ 5 : 0 ]");
    expect(normalizeStatus("a \u00a0 b")).toBe("a b");
  });

  it("reads mode, map and score, and treats lines without a score as no match", () => {
    expect(parseMatchStatus("Competitive - Office [ 5 : 0 ] ")).toEqual({ mode: "Competitive", map: "Office", score: [5, 0] });
    expect(parseMatchStatus("Premier - Anubis [ 12 : 9 ]")).toEqual({ mode: "Premier", map: "Anubis", score: [12, 9] });
    expect(parseMatchStatus("Main Menu")).toBeNull();
    expect(parseMatchStatus("Invisible")).toBeNull();
    expect(parseMatchStatus("")).toBeNull();
  });
});

describe("what the page script returns", () => {
  it("takes our match line from the header, whatever comes before it", () => {
    expect(snapshotFromPage({ own: { parts: ["Invisible", "Casual - Mirage [ 0 : 1 ] "] }, rows: [] }).own).toBe("Casual - Mirage [ 0 : 1 ]");
    expect(snapshotFromPage({ own: { parts: ["Online"] }, rows: [] }).own).toBeNull();
    expect(snapshotFromPage({ own: null, rows: [] }).own).toBeNull();
  });

  it("survives junk", () => {
    expect(snapshotFromPage(undefined)).toEqual({ own: null, rows: [] });
    expect(snapshotFromPage({ rows: [null, 5, { nickname: 7, status: "x" }] }).rows).toHaveLength(3);
  });

  it("joins on the persona name when a nickname is shown", () => {
    expect(rowName(row("Ally", "x", { persona: "Alice" }))).toBe("Alice");
    expect(rowName(row("Bob", "x"))).toBe("Bob");
  });
});

describe("friends in our match", () => {
  const friends = [nf(1, "Alice"), nf(2, "Bob"), nf(3, "Carol")];

  it("takes the friends whose line equals ours, score included", () => {
    const s = snap(MIRAGE, [row("Ally", "Competitive - Mirage [ 3 : 2 ]", { persona: "Alice" }), row("Bob", "Competitive - Mirage [ 4 : 2 ]"), row("Carol", "Competitive - Mirage [ 3 : 2 ] ")]);
    expect(matchFriends(friends, s).map((m) => m.name)).toEqual(["Alice", "Carol"]);
  });

  it("needs a score: two people at the main menu are not a match", () => {
    expect(matchFriends(friends, snap("Main Menu", [row("Alice", "Main Menu")]))).toEqual([]);
    expect(matchFriends(friends, snap(null, [row("Alice", "Competitive - Mirage [ 3 : 2 ]")]))).toEqual([]);
  });

  it("leaves out excluded players and anyone not in the Steam client's CS2 list", () => {
    const s = snap(MIRAGE, [row("Alice", MIRAGE), row("Bob", MIRAGE), row("Dave", MIRAGE)]);
    expect(matchFriends(friends, s, { exclude: new Set([id(1)]) }).map((m) => m.name)).toEqual(["Bob"]);
  });

  it("skips a name that is ambiguous, among friends or in the window", () => {
    const twin = [nf(1, "Sam"), nf(2, "Sam"), nf(3, "Eve")];
    expect(matchFriends(twin, snap(MIRAGE, [row("Sam", MIRAGE), row("Eve", MIRAGE)])).map((m) => m.name)).toEqual(["Eve"]);
    expect(matchFriends([nf(3, "Eve")], snap(MIRAGE, [row("Eve", MIRAGE), row("Eve", MIRAGE)]))).toEqual([]);
  });

  describe("keeping a friend found earlier", () => {
    const prev: FriendMatch[] = [{ steamId: id(1), name: "Alice", status: "Competitive - Mirage [ 3 : 2 ]" }];

    it("keeps them when the score drifts around a round end", () => {
      const s = snap(MIRAGE, [row("Alice", "Competitive - Mirage [ 4 : 2 ]")]);
      expect(matchFriends(friends, s, { previous: prev }).map((m) => m.name)).toEqual(["Alice"]);
    });

    it("drops them when they go to the menu, change map or mode, or leave CS2", () => {
      expect(matchFriends(friends, snap(MIRAGE, [row("Alice", "Main Menu")]), { previous: prev })).toEqual([]);
      expect(matchFriends(friends, snap(MIRAGE, [row("Alice", "Competitive - Dust II [ 3 : 2 ]")]), { previous: prev })).toEqual([]);
      expect(matchFriends(friends, snap(MIRAGE, [row("Alice", "Premier - Mirage [ 3 : 2 ]")]), { previous: prev })).toEqual([]);
      expect(matchFriends([nf(2, "Bob")], snap(MIRAGE, [row("Alice", MIRAGE)]), { previous: prev })).toEqual([]);
    });

    it("keeps them when their row can't be found, or when our own line is missing but theirs is a match", () => {
      expect(matchFriends(friends, snap(MIRAGE, []), { previous: prev }).map((m) => m.name)).toEqual(["Alice"]);
      expect(matchFriends(friends, snap(null, [row("Alice", "Competitive - Mirage [ 4 : 2 ]")]), { previous: prev }).map((m) => m.name)).toEqual(["Alice"]);
      expect(matchFriends(friends, snap(null, [row("Alice", "Online")]), { previous: prev })).toEqual([]);
    });
  });
});

// A stand-in for Steam's debug port: /json lists the pages and one WebSocket answers Runtime.evaluate.
function readClientFrame(b: Buffer): string | null {
  if (b.length < 2) return null;
  let len = b[1] & 0x7f, off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  if (b.length < off + 4 + len) return null;
  const mask = b.subarray(off, off + 4);
  return Buffer.from(b.subarray(off + 4, off + 4 + len)).map((x, i) => x ^ mask[i % 4]).toString("utf8");
}
function serverFrame(text: string): Buffer {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, p]);
}
async function fakeSteam(title: string, page: unknown) {
  const sent: { method?: string; expression?: string }[] = [];
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    if (req.url !== "/json") { res.statusCode = 404; return res.end(); }
    res.end(JSON.stringify([
      { title: "Steam", webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/STEAM` },
      { title, webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/FRIENDS` },
    ]));
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if ((buf[0] & 0x0f) === 8) return socket.end(); // the client's close frame
      const text = readClientFrame(buf);
      if (text == null) return;
      buf = Buffer.alloc(0);
      const msg = JSON.parse(text);
      sent.push({ method: msg.method, expression: msg.params?.expression });
      socket.write(serverFrame(JSON.stringify({ id: msg.id, result: { result: { value: page } } })));
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, sent, close: () => { server.closeAllConnections(); server.close(); } };
}

describe("reading the friends list over the debug port", () => {
  it("reports a closed port as unreachable", async () => {
    const s = await fakeSteam("Friends List", {});
    const port = s.port;
    s.close();
    expect(await readFriendUi(port, 500)).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("says when the friends window isn't open", async () => {
    const s = await fakeSteam("Something Else", {});
    expect(await readFriendUi(s.port, 1000)).toEqual({ ok: false, reason: "no-friends-window" });
    s.close();
  });

  it("evaluates the page script in the Friends List page and returns a snapshot", async () => {
    const page = { own: { parts: ["Invisible", "Casual - Mirage [ 0 : 1 ]"] }, rows: [{ group: "Counter-Strike 2", nickname: "Bob", persona: "", status: "Premier - Anubis [ 5 : 2 ]" }] };
    const s = await fakeSteam("Friends List", page);
    const r = await readFriendUi(s.port, 2000);
    s.close();
    expect(r).toEqual({ ok: true, snapshot: { own: "Casual - Mirage [ 0 : 1 ]", rows: [{ group: "Counter-Strike 2", nickname: "Bob", persona: "", status: "Premier - Anubis [ 5 : 2 ]" }] } });
    expect(s.sent).toEqual([{ method: "Runtime.evaluate", expression: COLLECT_FRIENDS_JS }]);
  });
});

// The page script against Steam's real markup (fixtures/ holds two pasted snippets, names replaced). It needs a
// DOM, so it runs only when jsdom is installed (npm i -D jsdom); drop a new snippet into fixtures/ when Steam's UI changes.
const jsdomName = "jsdom";
const jsdom: any = await import(/* @vite-ignore */ jsdomName).catch(() => null);
describe.skipIf(!jsdom)("the page script on Steam's markup", () => {
  it("reads our header and the friend rows", () => {
    const read = (f: string) => readFileSync(join(__dirname, "..", "fixtures", f), "utf8");
    const dom = new jsdom.JSDOM(`<body>${read("steam-own-header.html")}${read("steam-friends-list.html")}</body>`, { runScripts: "outside-only" });
    const s = snapshotFromPage(dom.window.eval(COLLECT_FRIENDS_JS));
    expect(s.own).toBe("Casual - Mirage [ 0 : 1 ]");
    expect(s.rows).toEqual([
      { group: "Counter-Strike 2", nickname: "Ally", persona: "Alice", status: "Competitive - Office [ 5 : 0 ]" },
      { group: "Counter-Strike 2", nickname: "Bob", persona: "", status: "Premier - Anubis [ 5 : 2 ]" },
    ]);
  });
});

describe("SteamSource with the friends list", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  const t = () => Math.floor(Date.now() / 1000);
  const E = (n: number, time: number): CoplayEntry => ({ steamId: id(n), name: `p${n}`, appId: 730, time });
  const inGame = (n: number, name: string): FriendInGame => ({ steamId: id(n), name, presence: {} });

  function make(opts: { coplay: number; friends: FriendInGame[]; ui: () => UiResult | Promise<UiResult> }) {
    let push: (s: GameState) => void = () => {};
    const ui = vi.fn(async () => opts.ui());
    const src = new SteamSource({
      scan: async (): Promise<CoplayResult> => ({
        localName: "Nova",
        entries: Array.from({ length: opts.coplay }, (_, i) => E(i + 1, t() - 5)),
        friends: opts.friends,
      }),
      listen: (on) => ((push = on), () => {}),
      uiStatus: ui,
      fastMs: 1000,
      slowMs: 10_000,
    });
    const matches: MatchState[] = [];
    src.on("match", (m) => matches.push(m));
    const warmup = () => push({ map: "de_mirage", mode: "competitive", phase: "warmup", localSteamId: ME });
    return { src, ui, matches, warmup };
  }
  const names = (m: MatchState | undefined) => m?.players.map((p) => p.name);
  const ok = (own: string | null, rows: UiRow[]): UiResult => ({ ok: true, snapshot: snap(own, rows) });

  it("adds a friend whose status equals ours, after the players list's players", async () => {
    const { src, warmup, matches } = make({
      coplay: 7,
      friends: [inGame(50, "Alice"), inGame(51, "Bob"), inGame(52, "Carol")],
      ui: () => ok(MIRAGE, [row("Alice", MIRAGE), row("Bob", "Competitive - Mirage [ 4 : 2 ]"), row("Carol", MIRAGE)]),
    });
    src.start();
    warmup();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(names(matches.at(-1))).toEqual(["Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "Alice", "Carol"]);
    expect(matches.at(-1)!.players.map((p) => p.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    src.stop();
  });

  it("never pushes a player from the players list out, and fills only the free slots", async () => {
    const { src, warmup, matches } = make({
      coplay: 8,
      friends: [inGame(50, "Alice"), inGame(52, "Carol")],
      ui: () => ok(MIRAGE, [row("Alice", MIRAGE), row("Carol", MIRAGE)]),
    });
    src.start();
    warmup();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(names(matches.at(-1))).toEqual(["Nova", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "Alice"]);
    src.stop();
  });

  it("doesn't read the friends list when no friend is playing CS2", async () => {
    const { src, warmup, ui } = make({ coplay: 3, friends: [], ui: () => ok(MIRAGE, []) });
    src.start();
    warmup();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ui).not.toHaveBeenCalled();
    src.stop();
  });

  it("keeps a friend through a failed read, and drops them when they leave for the menu", async () => {
    let result: UiResult = ok(MIRAGE, [row("Alice", MIRAGE)]);
    const { src, warmup, matches } = make({ coplay: 3, friends: [inGame(50, "Alice")], ui: () => result });
    src.start();
    warmup();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(names(matches.at(-1))).toContain("Alice");

    result = { ok: false, reason: "unreachable" };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(names(matches.at(-1))).toContain("Alice");

    result = ok(MIRAGE, [row("Alice", "Main Menu")]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(names(matches.at(-1))).not.toContain("Alice");
    src.stop();
  });

  it("forgets the friends with the match", async () => {
    const { src, warmup, matches } = make({ coplay: 3, friends: [inGame(50, "Alice")], ui: () => ok(MIRAGE, [row("Alice", MIRAGE)]) });
    src.start();
    warmup();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(names(matches.at(-1))).toContain("Alice");
    src.refresh();
    (src as unknown as { onGameState(s: GameState): void }).onGameState({ map: null, mode: null, phase: null, localSteamId: ME });
    await vi.advanceTimersByTimeAsync(10);
    expect(matches.at(-1)!.players).toEqual([]);
    src.stop();
  });
});
