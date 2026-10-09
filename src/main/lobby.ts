// Keeps the lobby rows (roster + class) up to date. Looks up only Steam IDs it hasn't seen recently, so a
// roster update (kills, team switch) doesn't cause a new request.
//
// For small lobbies (Competitive/Premier: 10, Wingman: 4): all lookups happen in one burst.
// For large lobbies (Casual/Deathmatch/Arms Race/Retakes: up to 20): lookups are queued —
// a burst of ~10, then ~1 request every 1–2 seconds — so the Leetify rate limit isn't hit.

import type { PlayerReputation } from "../shared/reputation-types";
import type { EvidenceClass, LobbyRow, MatchState, PlayerDetail } from "../shared/types";
import { expectedOthers } from "./steam/pick";

/** What a lookup says about one player. */
export interface LobbyAnswer {
  steamId: string | null;
  classification: EvidenceClass | null;
  totalMatches: number;
  /** The player's name on the data source; fills in when Steam doesn't know it. */
  name?: string | null;
  /** The F7 card, for flagged players only. */
  detail?: PlayerDetail | null;
  /** The 0-100 reputation score, tier and reasons. */
  reputation?: PlayerReputation | null;
  /** Why there's no class, or a problem to show. */
  note?: string | null;
  /** A temporary failure (rate limit, network): not remembered, asked again later. */
  transient?: boolean;
  /** For a transient answer: don't ask again before this long (ms). */
  retryAfterMs?: number;
}

export type Lookup = (steamIds: string[]) => Promise<LobbyAnswer[]>;

interface Cached {
  classification: EvidenceClass | null;
  totalMatches: number;
  name: string | null;
  detail: PlayerDetail | null;
  reputation: PlayerReputation | null;
  note: string | null;
  at: number;
}

const UNKNOWN_NAME = "Unknown player";

/** Only the first this-many players of a lobby are looked up; the rest are shown as not checked. */
export const MAX_LOOKUPS = 10;

/** Default max players for unknown modes (Competitive/Premier). */
const DEFAULT_MAX_PLAYERS = 10;

/** How many lookups to send in the initial burst for large lobbies. */
const BURST_SIZE = 10;

/** Interval between individual lookups after the initial burst (ms). */
const QUEUE_INTERVAL_MIN = 1000;
const QUEUE_INTERVAL_MAX = 2000;

export interface LobbyOptions {
  /** Wait this long after a roster change before asking, so a filling lobby costs one request (ms). */
  debounceMs?: number;
  /** Ask again for a player after this long (ms). */
  ttlMs?: number;
  /** After a failed lookup, try again after this long (ms). */
  retryMs?: number;
  /** How many players of the roster (in the order the game lists them) are looked up. */
  maxPlayers?: number;
  /** The local player's Steam ID; always re-looked up when a new match starts. */
  localSteamId?: string | null;
  now?: () => number;
}

export class LobbyService {
  private cache = new Map<string, Cached>();
  private match: MatchState | null = null;
  private matchKey: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private failed = new Map<string, string | null>();
  /** Queue of Steam IDs waiting to be looked up (for large lobbies). */
  private queue: string[] = [];
  /** How many items from the queue have been sent to Leetify. */
  private queueSent = 0;
  /** Match key for which the local player has already been looked up. */
  private localPlayerDoneFor: string | null = null;
  error: string | null = null;
  updatedAt: string | null = null;

  constructor(private lookup: Lookup, private onChange: () => void, private opts: LobbyOptions = {}) {}

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  setMatch(match: MatchState | null): void {
    const prevKey = this.matchKey;
    this.match = match;
    this.matchKey = match ? this.matchSig(match) : null;
    // New match: reset the queue.
    if (prevKey !== this.matchKey) {
      this.queue = [];
      this.queueSent = 0;
      this.localPlayerDoneFor = null;
    }
    this.schedule();
    this.onChange();
  }

  /** Update the local player's Steam ID (called when a match starts). */
  setLocalSteamId(steamId: string | null): void {
    this.opts.localSteamId = steamId;
  }

  /** Forget everything (e.g. after unlinking or a server change). */
  clear(): void {
    this.cache.clear();
    this.failed.clear();
    this.error = null;
    this.updatedAt = null;
    this.queue = [];
    this.queueSent = 0;
    this.localPlayerDoneFor = null;
    this.schedule();
    this.onChange();
  }

  private get limit(): number {
    if (this.opts.maxPlayers !== undefined) return this.opts.maxPlayers;
    // Cap at 10 players in all modes.
    return Math.min(10, DEFAULT_MAX_PLAYERS);
  }

  rows(): LobbyRow[] {
    return (this.match?.players ?? []).map((p, i) => {
      if (i >= this.limit)
        return { ...p, classification: null, totalMatches: 0, status: "skipped", detail: null, reputation: null,
                 note: `Not checked: only the first ${this.limit} players of a lobby are looked up` };
      if (!p.steamId) return { ...p, classification: null, totalMatches: 0, status: "no-steam-id", detail: null, reputation: null, note: null };
      const c = this.cache.get(p.steamId);
      if (c)
        return {
          ...p,
          // Steam sometimes doesn't know a stranger's name yet; the server's last known name fills in.
          name: p.name === UNKNOWN_NAME && c.name ? c.name : p.name,
          classification: c.classification, totalMatches: c.totalMatches, status: "ok", detail: c.detail, reputation: c.reputation, note: c.note,
        };
      const failed = this.failed.has(p.steamId);
      return { ...p, classification: null, totalMatches: 0, status: failed ? "error" : "loading", detail: null, reputation: null, note: failed ? this.failed.get(p.steamId) ?? null : null };
    });
  }

  /** Steam IDs that still need lookups: cache misses plus any remaining queue items. */
  private pendingIds(): string[] {
    const ttl = this.opts.ttlMs ?? 6 * 60 * 60 * 1000; // 6 hours default
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const p of (this.match?.players ?? []).slice(0, this.limit)) {
      if (!p.steamId) continue;
      if (seen.has(p.steamId)) continue;
      seen.add(p.steamId);
      // Always re-lookup the local player when a new match starts.
      if (p.steamId === this.opts.localSteamId && this.matchKey !== this.localPlayerDoneFor) {
        ids.push(p.steamId);
        continue;
      }
      const c = this.cache.get(p.steamId);
      if (!c || this.now - c.at > ttl) {
        ids.push(p.steamId);
      }
    }
    // Append any remaining queue items not yet sent.
    for (let i = this.queueSent; i < this.queue.length; i++) {
      if (!seen.has(this.queue[i])) {
        ids.push(this.queue[i]);
        seen.add(this.queue[i]);
      }
    }
    return ids;
  }

  private matchSig(m: MatchState): string {
    return `${m.map ?? ""}:${m.mode ?? ""}`;
  }

  private schedule(delay = this.opts.debounceMs ?? 800): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pendingIds().length === 0) return;
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async run(): Promise<void> {
    this.timer = null;
    if (this.inFlight) return this.schedule();
    const ids = this.pendingIds();
    if (ids.length === 0) return;
    this.inFlight = true;

    // For large queues, process in batches.
    const isQueued = this.queue.length > BURST_SIZE;
    let batch: string[];
    if (isQueued && this.queueSent < this.queue.length) {
      // Take up to BURST_SIZE from the queue, or all remaining.
      const take = Math.min(BURST_SIZE, this.queue.length - this.queueSent);
      batch = this.queue.slice(this.queueSent, this.queueSent + take);
      this.queueSent += take;
    } else {
      batch = ids.slice(0, isQueued ? 1 : ids.length);
      // If not queued, add all remaining to the queue for future processing.
      if (!isQueued && ids.length > BURST_SIZE) {
        const remaining = ids.slice(BURST_SIZE);
        this.queue.push(...remaining);
        batch = ids.slice(0, BURST_SIZE);
      }
    }

    let retryIn: number | null = null;
    try {
      const answers = await this.lookup(batch);
      const at = this.now;
      let problem: string | null = null;
      for (const a of answers) {
        if (!a.steamId) continue;
        if (a.transient) {
          this.failed.set(a.steamId, a.note ?? null);
          problem ??= a.note ?? null;
          retryIn = Math.max(retryIn ?? 0, a.retryAfterMs ?? this.opts.retryMs ?? 15_000);
          continue;
        }
        this.cache.set(a.steamId, { classification: a.classification, totalMatches: a.totalMatches,
                                    name: a.name ?? null, detail: a.detail ?? null, reputation: a.reputation ?? null, note: a.note ?? null, at });
        this.failed.delete(a.steamId);
      }
      this.error = problem;
      this.updatedAt = new Date(at).toISOString();
      // Mark local player as done for this match.
      if (this.opts.localSteamId) {
        this.localPlayerDoneFor = this.matchKey;
      }
    } catch (e) {
      for (const id of batch) this.failed.set(id, null);
      this.error = e instanceof Error ? e.message : String(e);
      this.inFlight = false;
      this.onChange();
      this.schedule(this.opts.retryMs ?? 15_000);
      return;
    }
    this.inFlight = false;
    this.onChange();
    this.schedule(retryIn ?? undefined);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}