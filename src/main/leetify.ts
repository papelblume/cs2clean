// Client for Leetify's Public CS API (https://api-public-docs.cs-prod.leetify.com/). Runs in the main
// process, so the API key never reaches a web page and no CORS setup is needed.
//
// One request per player (GET /v3/profile has no batch form), so a lobby lookup is up to 10 requests.
// Leetify's public API only answers for players with a (public) Leetify profile.

import { assessProfile } from "./assess";
import type { LobbyAnswer } from "./lobby";

export const LEETIFY_BASE = "https://api-public.cs-prod.leetify.com";

/** The fields of a /v3/profile response that the app reads. Everything is optional: the API's shape isn't ours. */
export interface LeetifyRecentMatch {
  id?: string;
  finished_at?: string | null;
  map_name?: string | null;
  data_source?: string | null;
  outcome?: string | null;
  /** The player's Leetify rating in that match. */
  leetify_rating?: number | null;
}

export interface LeetifyProfile {
  steam64_id?: string;
  name?: string | null;
  /** "public" or "private"; recent_matches is empty for private profiles. */
  privacy_mode?: string | null;
  total_matches?: number | null;
  rating?: { aim?: number | null; clutch?: number | null } | null;
  recent_matches?: LeetifyRecentMatch[] | null;
}

export type LeetifyErrorKind = "invalid-key" | "not-found" | "rate-limited" | "server" | "network" | "timeout" | "bad-response";

export class LeetifyError extends Error {
  constructor(public kind: LeetifyErrorKind, message: string, public status = 0, public retryAfterMs: number | null = null) {
    super(message);
  }
}

type Fetch = typeof fetch;

export class LeetifyClient {
  constructor(public apiKey: string | null = null, private fetchImpl: Fetch = fetch,
              private opts: { baseUrl?: string; timeoutMs?: number } = {}) {}

  /** The profile for a SteamID64: ratings, lifetime stats and the last ~30-50 matches. */
  async profile(steamId: string): Promise<LeetifyProfile> {
    const res = await this.raw(`/v3/profile?steam64_id=${encodeURIComponent(steamId)}`);
    try {
      const body = await res.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
      return body as LeetifyProfile;
    } catch {
      throw new LeetifyError("bad-response", "Leetify sent an answer the app couldn't read", res.status);
    }
  }

  /** True if Leetify accepts the key; false if it rejects it. Other problems throw. */
  async validateKey(): Promise<boolean> {
    try {
      await this.raw("/api-key/validate");
      return true;
    } catch (e) {
      if (e instanceof LeetifyError && e.kind === "invalid-key") return false;
      throw e;
    }
  }

  private async raw(path: string): Promise<Response> {
    // Leetify's two published client libraries disagree on the header (Authorization: Bearer vs _leetify_key),
    // so both are sent; a server that knows one ignores the other.
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
      headers._leetify_key = this.apiKey;
    }
    let res: Response;
    try {
      res = await this.fetchImpl((this.opts.baseUrl ?? LEETIFY_BASE).replace(/\/+$/, "") + path, {
        method: "GET", headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))
        throw new LeetifyError("timeout", "Leetify didn't answer");
      throw new LeetifyError("network", "Leetify can't be reached");
    }
    if (res.ok) return res;
    if (res.status === 401) throw new LeetifyError("invalid-key", this.apiKey ? "Leetify rejected the API key. Check it under Settings." : "Leetify wants an API key. Add one under Settings.", 401);
    if (res.status === 403 || res.status === 404) throw new LeetifyError("not-found", "No public Leetify profile", res.status);
    if (res.status === 429) throw new LeetifyError("rate-limited", "Leetify's request limit was hit", 429, retryAfterMs(res));
    throw new LeetifyError("server", `Leetify answered HTTP ${res.status}`, res.status);
  }
}

/** Retry-After in seconds (the date form isn't used by this API); null when absent or unreadable. */
function retryAfterMs(res: Response): number | null {
  const s = Number(res.headers.get("Retry-After"));
  return Number.isFinite(s) && s > 0 ? Math.min(s, 300) * 1000 : null;
}

export interface LookupOptions {
  /** Requests in flight at once. */
  concurrency?: number;
  /** Called with false when Leetify couldn't be reached at all, true when it answered (even with an error). */
  onReach?: (ok: boolean) => void;
}

/**
 * Looks up every player and turns each profile into an answer for the lobby. A player without a public
 * profile is an answer ("no data"); a rate limit or a network problem is a transient one the lobby retries.
 * A rejected API key stops the whole lookup, since every later request would fail the same way.
 */
export async function lookupLobby(client: LeetifyClient, steamIds: string[], o: LookupOptions = {}): Promise<LobbyAnswer[]> {
  const out: LobbyAnswer[] = new Array(steamIds.length);
  let next = 0;
  let fatal: LeetifyError | null = null;

  const one = async (steamId: string): Promise<LobbyAnswer> => {
    try {
      const a = assessProfile(await client.profile(steamId));
      o.onReach?.(true);
      return { steamId, classification: a.classification, matchesAnalyzed: a.matchesAnalyzed, name: a.name, detail: a.detail, note: a.note };
    } catch (e) {
      if (!(e instanceof LeetifyError)) throw e;
      o.onReach?.(e.kind !== "network" && e.kind !== "timeout");
      if (e.kind === "invalid-key") {
        fatal = e;
        return { steamId, classification: null, matchesAnalyzed: 0, note: e.message, transient: true };
      }
      if (e.kind === "not-found")
        return { steamId, classification: "INSUFFICIENT_DATA", matchesAnalyzed: 0, note: "Not on Leetify, or the profile isn't public" };
      return { steamId, classification: null, matchesAnalyzed: 0, note: e.message, transient: true, retryAfterMs: e.retryAfterMs ?? undefined };
    }
  };

  const worker = async () => {
    while (next < steamIds.length && !fatal) {
      const i = next++;
      out[i] = await one(steamIds[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 3, steamIds.length)) }, worker));
  if (fatal) throw fatal;
  return out;
}
