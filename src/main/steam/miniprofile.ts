// The fallback for finding friends in the match when neither Steam's debug port nor CS2's console.log is available: a
// friend's rich presence ("Premier - Inferno [ 0 : 2 ]") from Steam's public mini-profile, the hover card on a profile:
// https://steamcommunity.com/miniprofile/<account id>. The Steam client's own interface leaves it empty for a process
// that isn't CS2 (checked on Windows and Linux), but the Steam client's friends list shows it, and so does this page,
// which any tool can read without logging in.
//
// Catch: the page only refreshes about every 10 minutes (seen on :00, :10, :20...), so the text can be minutes behind.
// The map and mode say who is probably in our match; the score would be wrong, so it is never used. Friends found this
// way are marked as uncertain ("maybe") in the roster. This is an unofficial page: if Steam changes it, nothing here may
// match and friends just aren't added.

import type { FriendInGame } from "./coplay";

export const STEAM_ID64_BASE = 76561197960265728n;

/** The account ID in a mini-profile URL: SteamID64 minus 76561197960265728. Null if it isn't an individual's SteamID64. */
export function accountId(steamId64: string): string | null {
  if (!/^7656\d{13}$/.test(steamId64)) return null;
  const n = BigInt(steamId64) - STEAM_ID64_BASE;
  return n > 0n ? n.toString() : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The game name and the rich-presence line out of a mini-profile page; null for what isn't there. */
export function parseMiniprofile(html: string): { game: string | null; status: string | null } {
  const pick = (cls: string): string | null => {
    const m = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*">([^<]*)<`).exec(html);
    const t = m ? decodeEntities(m[1]).trim() : "";
    return t || null;
  };
  return { game: pick("miniprofile_game_name"), status: pick("rich_presence") };
}

export interface ParsedStatus {
  /** "Premier", "Competitive", "Wingman", "Retakes"... Null when the line has no mode ("Main Menu"). */
  mode: string | null;
  /** The map's display name ("Inferno", "Dust II"). Null when the line has none. */
  map: string | null;
  score: [number, number] | null;
}

/** "Premier - Inferno [ 0 : 2 ]" -> mode Premier, map Inferno, score 0:2. */
export function parseStatus(text: string): ParsedStatus {
  const sc = /^(.*?)\s*\[\s*(\d+)\s*:\s*(\d+)\s*\]\s*$/.exec(text.trim());
  const head = (sc ? sc[1] : text).trim();
  const score: [number, number] | null = sc ? [Number(sc[2]), Number(sc[3])] : null;
  const i = head.indexOf(" - ");
  if (i <= 0) return { mode: null, map: null, score };
  return { mode: head.slice(0, i).trim() || null, map: head.slice(i + 3).trim() || null, score };
}

/** A map name in a form that "de_dust2" (the game's) and "Dust II" (the mini-profile's) share. */
export function normalizeMap(name: string): string {
  let n = name.toLowerCase().replace(/^(de|cs|ar|dz)_/, "").replace(/[^a-z0-9]/g, "");
  if (n.length > 2 && n.endsWith("ii")) n = `${n.slice(0, -2)}2`;
  return n;
}

/** The mini-profile's mode name as a group. Anything it doesn't know ("Retakes", "Danger Zone") is its own group. */
function displayModeGroup(mode: string | null): string | null {
  if (!mode) return null;
  const m = mode.toLowerCase();
  if (m === "premier" || m === "competitive") return "competitive";
  if (m === "wingman") return "wingman";
  if (m === "casual") return "casual";
  if (m === "deathmatch") return "deathmatch";
  if (m === "arms race") return "armsrace";
  return `other:${m}`;
}

/** The game-state feed's map.mode as the same groups. Null when unknown. */
function gsiModeGroup(mode: string | null | undefined): string | null {
  const m = (mode ?? "").toLowerCase();
  if (!m) return null;
  if (m.includes("scrimcomp2v2") || m.includes("wingman")) return "wingman";
  if (m.includes("casual")) return "casual";
  if (m.includes("deathmatch")) return "deathmatch";
  if (m.includes("armsrace")) return "armsrace";
  if (m.includes("competitive") || m.includes("premier")) return "competitive";
  return null;
}

/** False only when both sides name a mode and they can't be the same match (Retakes next to Premier). */
export function modeCompatible(friendMode: string | null, gsiMode: string | null | undefined): boolean {
  const a = displayModeGroup(friendMode), b = gsiModeGroup(gsiMode);
  return a == null || b == null || a === b;
}

export interface MiniFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type MiniFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<MiniFetchResponse>;

export interface MiniprofileOptions {
  fetch?: MiniFetch;
  now?: () => number;
  /** How long an answer is reused (ms). The page itself only changes every ~10 minutes. */
  ttlMs?: number;
  /** After Steam says "too many requests" (or fails), no new requests for this long (ms). */
  backoffMs?: number;
}

/** Looks friends' rich-presence lines up, a few at a time, with a cache, one request per friend in flight, and a backoff. */
export class MiniprofileStatus {
  private cache = new Map<string, { at: number; status: string | null }>();
  private inflight = new Map<string, Promise<string | null>>();
  private blockedUntil = 0;

  constructor(private o: MiniprofileOptions = {}) {}

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The friend's rich-presence line, or null when there is none, the page can't be read, or we are backing off. */
  async get(steamId: string): Promise<string | null> {
    const acc = accountId(steamId);
    if (!acc) return null;
    const hit = this.cache.get(steamId);
    if (hit && this.now - hit.at < (this.o.ttlMs ?? 120_000)) return hit.status;
    if (this.now < this.blockedUntil) return hit?.status ?? null;
    let p = this.inflight.get(steamId);
    if (!p) {
      p = this.load(steamId, acc).finally(() => this.inflight.delete(steamId));
      this.inflight.set(steamId, p);
    }
    return p;
  }

  private async load(steamId: string, acc: string): Promise<string | null> {
    const doFetch: MiniFetch = this.o.fetch ?? ((url, init) => fetch(url, init));
    try {
      const res = await doFetch(`https://steamcommunity.com/miniprofile/${acc}`, {
        headers: { "User-Agent": "CS2Clean", "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 429 || res.status >= 500) {
        this.blockedUntil = this.now + (this.o.backoffMs ?? 300_000);
        return this.cache.get(steamId)?.status ?? null;
      }
      if (!res.ok) {
        this.cache.set(steamId, { at: this.now, status: null });
        return null;
      }
      const status = parseMiniprofile(await res.text()).status;
      this.cache.set(steamId, { at: this.now, status });
      return status;
    } catch {
      this.cache.set(steamId, { at: this.now, status: null });
      return null;
    }
  }
}

export interface ProfilePickOptions {
  /** The map the game reports ("de_inferno"). Without it nothing can be matched. */
  map: string | null;
  /** The mode the game reports ("competitive"). */
  mode: string | null | undefined;
  /** Steam IDs never picked: players already in the match, and ourselves. */
  exclude: ReadonlySet<string>;
  /** The empty slots. */
  max: number;
}

/**
 * The friends (with their mini-profile line in `status`) who are on our map in a mode that can be ours. The lines are up
 * to ten minutes old, so when more friends fit than there are empty slots there is no telling which of them are in this
 * match, and none are picked.
 */
export function matchProfileFriends(friends: readonly FriendInGame[], o: ProfilePickOptions): FriendInGame[] {
  const map = o.map ? normalizeMap(o.map) : "";
  if (!map || o.max <= 0) return [];
  const hits = friends.filter((f) => {
    if (o.exclude.has(f.steamId) || !f.status) return false;
    const st = parseStatus(f.status);
    return st.map != null && normalizeMap(st.map) === map && modeCompatible(st.mode, o.mode);
  });
  return hits.length <= o.max ? hits : [];
}
