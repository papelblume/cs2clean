// Finds the friends who are in OUR match by comparing the status text Steam's friends list shows.
//
// Why: Steam's players list leaves friends out, and the Steam client interface the app reads (coplay.ts) gives
// no rich presence for CS2 (tried 2026-10-16, also after RequestFriendRichPresence). The friends list window
// does show it: "Competitive - Office [ 5 : 0 ]" is mode, map and score. A friend whose line is identical to
// ours, score included, is playing on our server.
//
// How: Steam started with -cef-enable-debugging (or a ".cef-enable-remote-debugging" file in Steam's folder)
// serves Chrome's DevTools protocol on localhost:8080. We read the "Friends List" page through it and only
// read: nothing is clicked or changed. The friends' Steam IDs come from the Steam client (coplay.ts); the
// two are joined by persona name. Without the debug port nothing here runs and the app works as before.

import { COLLECT_FRIENDS_JS } from "./steam-ui-page";

export const DEFAULT_DEBUG_PORT = 8080;

/**
 * The title of Steam's friends list window in every language Steam has. The window's title is localized, so a plain
 * "Friends List" would only find it on an English Steam.
 */
export const FRIENDS_WINDOW_TITLES: readonly string[] = [
  "Friends List", "Lista de amigos", "好友列表", "好友名單", "フレンドリスト", "친구 목록", "รายชื่อเพื่อน",
  "Daftar Teman", "Senarai Rakan", "Списък с приятели", "Seznam přátel", "Venneliste", "Freundesliste",
  "Λίστα φίλων", "Liste de contacts", "Lista amici", "Barátlista", "Vriendenlijst", "Lista znajomych",
  "Lista de prieteni", "Список друзей", "Kaverilista", "Vänlista", "Arkadaş Listesi", "Danh sách bạn bè",
  "Список друзів",
];

const titleKey = (t: string): string => t.normalize("NFC").trim().toLowerCase();
const FRIENDS_TITLE_KEYS: ReadonlySet<string> = new Set(FRIENDS_WINDOW_TITLES.map(titleKey));

/** True for the title of the friends list window in any of Steam's languages. */
export function isFriendsWindowTitle(title: unknown): boolean {
  return typeof title === "string" && FRIENDS_TITLE_KEYS.has(titleKey(title));
}

export interface UiRow {
  group: string | null;
  /** The name shown: our nickname for the friend when we set one, else their persona name. */
  nickname: string;
  /** Their persona name when a nickname is shown (the "(...)" part); empty otherwise. */
  persona: string;
  status: string;
}

export interface UiSnapshot {
  /** Our own match status line, or null when we aren't in a match (or Steam doesn't show one). */
  own: string | null;
  rows: UiRow[];
}

export type UiResult =
  | { ok: true; snapshot: UiSnapshot }
  | { ok: false; reason: "unreachable" | "no-friends-window" | "error"; detail?: string };

export interface NativeFriend {
  steamId: string;
  name: string | null;
}

export interface FriendMatch {
  steamId: string;
  name: string | null;
  /** The status line the friend showed when matched (it changes every round). */
  status: string;
}

const SCORE = /\[\s*(\d+)\s*:\s*(\d+)\s*\]/;

export function normalizeStatus(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

export interface MatchStatus {
  mode: string;
  map: string;
  score: [number, number];
}

/** "Competitive - Office [ 5 : 0 ]" -> mode, map, score. Anything without a score ("Main Menu", "Online") is not a match. */
export function parseMatchStatus(s: string): MatchStatus | null {
  const t = normalizeStatus(s);
  const m = SCORE.exec(t);
  if (!m) return null;
  const head = t.slice(0, m.index).trim();
  const dash = head.indexOf(" - ");
  return {
    mode: dash >= 0 ? head.slice(0, dash).trim() : head,
    map: dash >= 0 ? head.slice(dash + 3).trim() : "",
    score: [Number(m[1]), Number(m[2])],
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Validates what the page script returned. */
export function snapshotFromPage(raw: unknown): UiSnapshot {
  const o = (raw && typeof raw === "object" ? raw : {}) as { own?: { parts?: unknown } | null; rows?: unknown };
  const parts = Array.isArray(o.own?.parts) ? (o.own.parts as unknown[]).map(str) : [];
  const own = parts.map(normalizeStatus).find((p) => parseMatchStatus(p)) ?? null;
  const rows: UiRow[] = (Array.isArray(o.rows) ? (o.rows as unknown[]) : []).map((r) => {
    const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    return { group: typeof x.group === "string" ? x.group : null, nickname: str(x.nickname), persona: str(x.persona), status: str(x.status) };
  });
  return { own, rows };
}

/** The persona name to join on: the "(...)" part when a nickname is shown, else the shown name. */
export function rowName(r: UiRow): string {
  return normalizeStatus(r.persona || r.nickname);
}

/** Runs one Runtime.evaluate over the DevTools protocol. */
function evaluate(wsUrl: string, expression: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const ws = new WebSocket(wsUrl);
    const done = (err: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(value);
    };
    timer = setTimeout(() => done(new Error("timed out")), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    ws.onmessage = (ev) => {
      let msg: { id?: number; error?: { message?: string }; result?: { exceptionDetails?: { text?: string }; result?: { value?: unknown } } };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id !== 1) return;
      if (msg.error) return done(new Error(msg.error.message ?? "DevTools error"));
      if (msg.result?.exceptionDetails) return done(new Error(msg.result.exceptionDetails.text ?? "script error"));
      done(null, msg.result?.result?.value);
    };
    ws.onerror = () => done(new Error("WebSocket error"));
    ws.onclose = () => done(new Error("connection closed before an answer"));
  });
}

/** One page the debug port lists (Steam's windows are pages). */
export interface DebugTarget {
  title?: unknown;
  webSocketDebuggerUrl?: unknown;
}

export type TargetList = { ok: true; targets: DebugTarget[] } | { ok: false; detail: string };

/** The pages the debug port lists, or why it can't be reached. Never throws. */
export async function listDebugTargets(port = DEFAULT_DEBUG_PORT, timeoutMs = 1500): Promise<TargetList> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(timeoutMs) });
    const targets: unknown = await res.json();
    return { ok: true, targets: Array.isArray(targets) ? (targets as DebugTarget[]) : [] };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** The friends list window among the listed pages, if it is open. */
export function findFriendsTarget(targets: readonly DebugTarget[]): (DebugTarget & { webSocketDebuggerUrl: string }) | null {
  return (targets.find((t) => isFriendsWindowTitle(t?.title) && typeof t.webSocketDebuggerUrl === "string") as
    (DebugTarget & { webSocketDebuggerUrl: string }) | undefined) ?? null;
}

/** Reads Steam's friends list window over the debug port. Never throws. */
export async function readFriendUi(port = DEFAULT_DEBUG_PORT, timeoutMs = 4000): Promise<UiResult> {
  const listed = await listDebugTargets(port);
  if (!listed.ok) return { ok: false, reason: "unreachable", detail: listed.detail };
  const target = findFriendsTarget(listed.targets);
  // The friends window only exists while it is open; Steam's own pages are not scanned for it.
  if (!target) return { ok: false, reason: "no-friends-window" };
  // localhost can resolve to ::1 first while Steam listens on IPv4 only.
  const wsUrl = String(target.webSocketDebuggerUrl).replace(/^ws:\/\/localhost:/, "ws://127.0.0.1:");
  try {
    return { ok: true, snapshot: snapshotFromPage(await evaluate(wsUrl, COLLECT_FRIENDS_JS, timeoutMs)) };
  } catch (e) {
    return { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

export interface MatchOptions {
  /** Steam IDs never returned (the players list's players, and ourselves). */
  exclude?: ReadonlySet<string>;
  /** Friends matched by an earlier scan: kept while they stay in the same mode and map (see below). */
  previous?: readonly FriendMatch[];
}

/**
 * The friends (from `native`, the Steam client's list of friends playing CS2) whose status line equals ours.
 * Joined by persona name: a name that appears twice among the friends, or twice in the window, is skipped.
 *
 * A friend found earlier stays while we can't tell they left: the score text of two players can differ for a
 * moment around a round end, so only a change of mode or map, a status without a score (menu, queue), or
 * leaving CS2 removes them. A friend whose row we can't find (a collapsed group) is kept too.
 */
export function matchFriends(native: readonly NativeFriend[], snap: UiSnapshot, o: MatchOptions = {}): FriendMatch[] {
  const exclude = o.exclude ?? new Set<string>();
  const own = snap.own ? normalizeStatus(snap.own) : null;
  const ownParsed = own ? parseMatchStatus(own) : null;

  const nativeByName = new Map<string, NativeFriend[]>();
  for (const f of native) {
    if (!f.name) continue;
    const k = normalizeStatus(f.name);
    nativeByName.set(k, [...(nativeByName.get(k) ?? []), f]);
  }
  const rowsByName = new Map<string, UiRow[]>();
  for (const r of snap.rows) {
    const k = rowName(r);
    if (k) rowsByName.set(k, [...(rowsByName.get(k) ?? []), r]);
  }
  const rowOf = (f: NativeFriend): UiRow | null => {
    if (!f.name) return null;
    const k = normalizeStatus(f.name);
    const fs = nativeByName.get(k), rs = rowsByName.get(k);
    return fs?.length === 1 && rs?.length === 1 ? rs[0] : null;
  };

  const out = new Map<string, FriendMatch>();
  if (own && ownParsed) {
    for (const f of native) {
      if (exclude.has(f.steamId)) continue;
      const r = rowOf(f);
      if (r && normalizeStatus(r.status) === own) out.set(f.steamId, { steamId: f.steamId, name: f.name, status: own });
    }
  }
  for (const p of o.previous ?? []) {
    if (out.has(p.steamId) || exclude.has(p.steamId)) continue;
    const f = native.find((n) => n.steamId === p.steamId);
    if (!f) continue; // not playing CS2 any more
    const r = rowOf(f);
    if (r && own && ownParsed) {
      const st = parseMatchStatus(r.status);
      if (!st || st.mode !== ownParsed.mode || st.map !== ownParsed.map) continue; // left, or somewhere else now
    } else if (r && !own) {
      if (!parseMatchStatus(r.status)) continue; // no longer in any match
    }
    out.set(p.steamId, { steamId: p.steamId, name: f.name ?? p.name, status: r ? normalizeStatus(r.status) : p.status });
  }
  return [...out.values()];
}
