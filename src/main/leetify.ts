// Client for Leetify's Public CS API (https://api-public-docs.cs-prod.leetify.com/). Runs in the main
// process, so the API key never reaches a web page and no CORS setup is needed.
//
// One request per player (GET /v3/profile has no batch form), so a lobby lookup is up to 10 requests.
// Leetify's public API only answers for players with a (public) Leetify profile.

import type { EvidenceClass } from "../shared/types";
import { assessProfile } from "./assess";
import type { LobbyAnswer } from "./lobby";
import { assessReputation, toEvidenceClass, toPlayerReputation, type Reputation } from "./reputation";
import { scrapeCsstAtProfiles } from "./leetify-hero";
import { debug } from "./logger";

export const LEETIFY_BASE = "https://api-public.cs-prod.leetify.com";

/**
 * The fields of a /v3/profile response that the app reads. Everything is optional: the API's shape isn't ours.
 * The aggregates (ranks, rating, stats, bans) are always sent, private profiles included, and their units are
 * checked against real responses: the ratings have none, percentages are 0-100, preaim is degrees, reaction time
 * is milliseconds, winrate is a fraction. `recent_matches` (up to 100 per-match entries) comes only with a public
 * profile, and its field names and units are NOT verified against live responses (they come from a third-party
 * client), so main/matches.ts reads them defensively and everything that uses them has a fallback without.
 */
export interface LeetifyRecentMatch {
  finished_at?: string | null;
  map_name?: string | null;
  data_source?: string | null;
  outcome?: string | null;
  /** The player's Leetify rating in that match. */
  leetify_rating?: number | null;
  preaim?: number | null;
  reaction_time_ms?: number | null;
  accuracy_head?: number | null;
  spray_accuracy?: number | null;
}

export interface LeetifyBan {
  platform?: string | null;
  platform_nickname?: string | null;
  banned_since?: string | null;
}

export interface LeetifyStats {
  accuracy_enemy_spotted?: number | null;
  accuracy_head?: number | null;
  counter_strafing_good_shots_ratio?: number | null;
  ct_opening_aggression_success_rate?: number | null;
  ct_opening_duel_success_percentage?: number | null;
  t_opening_aggression_success_rate?: number | null;
  t_opening_duel_success_percentage?: number | null;
  flashbang_hit_foe_avg_duration?: number | null;
  flashbang_hit_foe_per_flashbang?: number | null;
  flashbang_hit_friend_per_flashbang?: number | null;
  flashbang_leading_to_kill?: number | null;
  flashbang_thrown?: number | null;
  he_foes_damage_avg?: number | null;
  he_friends_damage_avg?: number | null;
  preaim?: number | null;
  reaction_time_ms?: number | null;
  spray_accuracy?: number | null;
  traded_deaths_success_percentage?: number | null;
  trade_kill_opportunities_per_round?: number | null;
  trade_kills_success_percentage?: number | null;
  utility_on_death_avg?: number | null;
}

export interface LeetifyProfile {
  steam64_id?: string;
  name?: string | null;
  /** "public" or "private". A private profile still carries the aggregate ratings and stats below. */
  privacy_mode?: string | null;
  total_matches?: number | null;
  winrate?: number | null;
  first_match_date?: string | null;
  bans?: LeetifyBan[] | null;
  ranks?: { leetify?: number | null; premier?: number | null; faceit?: number | null; faceit_elo?: number | null } | null;
  rating?: {
    aim?: number | null; positioning?: number | null; utility?: number | null;
    clutch?: number | null; opening?: number | null; ct_leetify?: number | null; t_leetify?: number | null;
  } | null;
  stats?: LeetifyStats | null;
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

const SEVERITY: Record<EvidenceClass, number> = { INSUFFICIENT_DATA: -1, NORMAL: 0, ELEVATED: 1, HIGH: 2, VERY_HIGH: 3 };

/**
 * The class the overlay and the siren act on: the more severe of assess.ts (how far above average) and the
 * reputation (how implausible, bans included). Neither can lower the other, so a player the performance score
 * flags stays flagged. To let the reputation alone decide, return toEvidenceClass(rep) here.
 */
export function combineClass(performance: EvidenceClass, rep: Reputation): EvidenceClass {
  const fromRep = toEvidenceClass(rep);
  return SEVERITY[fromRep] > SEVERITY[performance] ? fromRep : performance;
}

/**
 * Turns a profile into the lobby answer: the performance score (assess.ts) combined with the reputation. Used for
 * API profiles and for profiles scraped from csst.at, so both are judged the same way. `fallbackNote` is shown when
 * assess.ts has no note of its own (e.g. to say where scraped data came from).
 */
function answerFromProfile(steamId: string, profile: LeetifyProfile, fallbackNote?: string): LobbyAnswer {
  const a = assessProfile(profile);
  const r = assessReputation(profile);
  return {
    steamId,
    classification: combineClass(a.classification, r),
    totalMatches: Math.max(a.totalMatches, r.matchesAnalyzed),
    name: a.name,
    detail: a.detail,
    note: r.tier === "BANNED" ? r.reasons[0] ?? a.note : a.note ?? fallbackNote,
    reputation: toPlayerReputation(r),
  };
}

/** Where a player's data came from: Leetify's API, or scraped from csst.at when the API had no profile. */
export type DataSource = "api" | "scrape";

export interface LookupOptions {
  /** Requests in flight at once. */
  concurrency?: number;
  /**
   * Called when a player's data source is settled: "api" or "scrape", or null when neither has data for them.
   * Not called for a transient failure (rate limit, network), so the caller keeps what it knew before.
   */
  onSource?: (steamId: string, source: DataSource | null) => void;
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
  const notFound: number[] = [];

  debug("leetify", "lookupLobby:", steamIds.join(", "));

  const one = async (steamId: string): Promise<LobbyAnswer> => {
    try {
      debug("leetify", "Fetching profile:", steamId);
      const profile = await client.profile(steamId);
      o.onReach?.(true);
      o.onSource?.(steamId, "api");
      return answerFromProfile(steamId, profile);
    } catch (e) {
      if (!(e instanceof LeetifyError)) throw e;
      o.onReach?.(e.kind !== "network" && e.kind !== "timeout");
      if (e.kind === "invalid-key") {
        fatal = e;
        return { steamId, classification: null, totalMatches: 0, note: e.message, transient: true };
      }
      if (e.kind === "not-found") {
        debug("leetify", "Not found on Leetify:", steamId);
        const idx = steamIds.indexOf(steamId);
        if (idx !== -1) notFound.push(idx);
        return { steamId, classification: null, totalMatches: 0, note: "Not on Leetify, or the profile isn't public" };
      }
      if (e.kind === "rate-limited")
        return { steamId, classification: null, totalMatches: 0, note: e.message, transient: true, retryAfterMs: e.retryAfterMs ?? undefined };
      return { steamId, classification: null, totalMatches: 0, note: e.message, transient: true, retryAfterMs: e.retryAfterMs ?? undefined };
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

  // Fallback: scrape not-found players from csst.at using Hero.
  if (notFound.length > 0) {
    const idsToScrape = notFound.map((i) => steamIds[i]);
    debug("leetify", "Hero fallback for:", idsToScrape.join(", "));
    const heroProfiles = await scrapeCsstAtProfiles(idsToScrape, 500);
    debug("leetify", "Hero returned:", heroProfiles.size, "profiles");
    for (const idx of notFound) {
      const steamId = steamIds[idx];
      const profile = heroProfiles.get(steamId);
      if (profile) {
        o.onSource?.(steamId, "scrape");
        out[idx] = answerFromProfile(steamId, profile, "Data from csst.at (Leetify API returned not found)");
        debug("leetify", "Hero profile for", steamId, "→", out[idx].classification, "(", out[idx].totalMatches, "matches)",
          "reputation:", out[idx].reputation?.tier, out[idx].reputation?.score);
      } else {
        debug("leetify", "Hero failed for", steamId);
        o.onSource?.(steamId, null);
        out[idx] = {
          steamId,
          classification: "INSUFFICIENT_DATA",
          totalMatches: 0,
          note: "Not on Leetify, or the profile isn't public",
        };
      }
    }
  }

  return out;
}
