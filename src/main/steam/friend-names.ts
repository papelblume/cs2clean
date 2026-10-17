// The names of all your Steam friends, from the Steam Web API: GetFriendList gives their Steam IDs (and nothing
// else), GetPlayerSummaries (at most 100 IDs a call) gives their persona names. Together they are name + Steam ID
// pairs to match a `status` player list against (name-match.ts). Unlike the Steam client's list of friends playing
// CS2, this includes friends who appear offline. It needs a Steam Web API key and a public friends list.
//
// The answer is cached, and a failure is remembered for as long, so a broken key or a rate limit isn't hit again on
// every `status`.

import type { NameCandidate } from "./name-match";

const BASE = "https://api.steampowered.com";
const FRIENDS = "/ISteamUser/GetFriendList/v0001/";
const SUMMARIES = "/ISteamUser/GetPlayerSummaries/v0002/";

export type NamesError =
  | "no-key"       // no Steam Web API key, or no SteamID64 to ask about
  | "private"      // Steam refused the friends list (401): it isn't public
  | "bad-key"      // Steam turned the key down (403)
  | "unavailable"; // network trouble, a rate limit, or a Steam error

export interface FriendNames {
  friends: NameCandidate[];
  error: NamesError | null;
}

export interface FetchedResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type NamesFetch = (url: string, init: { signal: AbortSignal }) => Promise<FetchedResponse>;

export interface FriendNamesOptions {
  fetch?: NamesFetch;
  now?: () => number;
  /** How long an answer, or a failure, is reused (ms). */
  ttlMs?: number;
}

class ApiError extends Error {
  constructor(readonly kind: NamesError) {
    super(kind);
  }
}

export class FriendNameDirectory {
  private cached: { at: number; value: FriendNames } | null = null;
  private inflight: Promise<FriendNames> | null = null;

  constructor(private apiKey: () => string | null, private steamId: () => string | null, private o: FriendNamesOptions = {}) {}

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  async get(): Promise<FriendNames> {
    const key = this.apiKey(), me = this.steamId();
    if (!key || !me) return { friends: [], error: "no-key" };
    if (this.cached && this.now - this.cached.at < (this.o.ttlMs ?? 300_000)) return this.cached.value;
    this.inflight ??= this.load(key, me).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async getJson(path: string, params: Record<string, string>): Promise<unknown> {
    const doFetch: NamesFetch = this.o.fetch ?? ((url, init) => fetch(url, init));
    let res: FetchedResponse;
    try {
      res = await doFetch(`${BASE}${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new ApiError("unavailable");
    }
    if (res.status === 401) throw new ApiError("private");
    if (res.status === 403) throw new ApiError("bad-key");
    if (!res.ok) throw new ApiError("unavailable");
    try {
      return await res.json();
    } catch {
      throw new ApiError("unavailable");
    }
  }

  private async load(key: string, me: string): Promise<FriendNames> {
    let value: FriendNames;
    try {
      const list = (await this.getJson(FRIENDS, { key, steamid: me, relationship: "friend" })) as { friendslist?: { friends?: { steamid?: unknown }[] } };
      const ids = (list.friendslist?.friends ?? []).map((f) => f.steamid).filter((s): s is string => typeof s === "string");
      const friends: NameCandidate[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        const r = (await this.getJson(SUMMARIES, { key, steamids: ids.slice(i, i + 100).join(",") })) as { response?: { players?: { steamid?: unknown; personaname?: unknown }[] } };
        for (const p of r.response?.players ?? [])
          if (typeof p.steamid === "string" && typeof p.personaname === "string" && p.personaname) friends.push({ steamId: p.steamid, name: p.personaname });
      }
      value = { friends, error: null };
    } catch (e) {
      value = { friends: [], error: e instanceof ApiError ? e.kind : "unavailable" };
    }
    this.cached = { at: this.now, value };
    return value;
  }
}
