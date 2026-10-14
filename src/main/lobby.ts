// Keeps the lobby rows (roster + class) up to date. Looks up only Steam IDs it hasn't seen recently, so a
// roster update (kills, team switch) doesn't cause a new request.
//
// For small lobbies (Competitive/Premier: 10, Wingman: 4): all lookups happen in one burst.
// For large lobbies (Casual/Deathmatch/Arms Race/Retakes: up to 20): lookups are queued —
// a burst of ~10, then ~1 request every 1–2 seconds — so the Leetify rate limit isn't hit.

import { MAX_LOOKUPS } from "../shared/lobby-size";
import { isSameMatch } from "../shared/match-identity";
import type { PlayerReputation } from "../shared/reputation-types";
import type { EvidenceClass, LobbyRow, MatchState, PlayerDetail } from "../shared/types";
import { groupPlayers } from "./steam/friends";

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
  /**
   * For a settled answer that may well change soon (a data source that was broken when it was asked): ask again after
   * this long instead of after the usual cache time (ms). Ignored for a transient answer.
   */
  recheckAfterMs?: number;
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
  /** Replaces the cache time for this entry; see LobbyAnswer.recheckAfterMs. */
  recheckAfterMs: number | null;
}

const UNKNOWN_NAME = "Unknown player";

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
  /** Steam Web API key for fetching friends lists (optional). Change it later with setSteamApiKey. */
  steamApiKey?: string | null;
  /** Called when friendship grouping encounters transient errors (rate limit, network); absent in tests. */
  onFriendshipError?: (count: number) => void;
  /** Called when the Steam API key is invalid (403); absent in tests. */
  onFriendshipKeyError?: (message: string) => void;
  now?: () => number;
}

export class LobbyService {
  private cache = new Map<string, Cached>();
  private match: MatchState | null = null;
  /** Counts the matches seen. A new match is told apart from the same match announced again (see isNewMatch). */
  private matchEpoch = 0;
  /** Lobby roster (the IDs that get looked up) as of the last setMatch; a change re-arms the debounce. */
  private lastRoster: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** True while a Retry-After or failure retry is waiting. Nothing may pull that timer forward. */
  private backingOff = false;
  private inFlight = false;
  private failed = new Map<string, string | null>();
  /** Queue of Steam IDs waiting to be looked up (for large lobbies). */
  private queue: string[] = [];
  /** How many items from the queue have been sent to Leetify. */
  private queueSent = 0;
  /** Epoch of the match in which the local player has already been looked up. */
  private localPlayerDoneFor: number | null = null;
  error: string | null = null;
  updatedAt: string | null = null;
  /** Friendship groups for the current match, keyed by player SteamID. */
  private friendshipGroups = new Map<string, { groupId: string | null; groupName: string | null }>();
  /** Steam IDs that are private in the current match. */
  private privatePlayers = new Set<string>();
  /** The roster (sorted Steam IDs) friendship grouping last ran for; grouping runs again when a player joins. */
  private friendshipComputedFor: string | null = null;
  /** Bumped whenever a grouping that is still out should be ignored: a newer pass, a new match, a new key, clear, dispose. */
  private friendshipPass = 0;
  private disposed = false;

  constructor(private lookup: Lookup, private onChange: () => void, private opts: LobbyOptions = {}) {}

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * The source announces the match again on every game-state post and every scan, so this is called every few
   * seconds with the same lobby. Per-match state is reset only when a new match begins, and the scheduler is only
   * woken when the roster changed or nothing is armed (so an expired cache entry is still picked up).
   */
  setMatch(match: MatchState | null): void {
    if (this.disposed) return;
    const prev = this.match;
    this.match = match;
    const fresh = match !== null && this.isNewMatch(prev, match);
    if (fresh) {
      this.matchEpoch++;
      this.queue = [];
      this.queueSent = 0;
      this.localPlayerDoneFor = null;
      this.friendshipComputedFor = null;
      this.friendshipPass++;
    }
    const roster = match ? this.rosterSig(match) : null;
    const rosterChanged = roster !== this.lastRoster;
    this.lastRoster = roster;
    if (fresh || rosterChanged || (!this.timer && !this.inFlight)) this.schedule();
    this.onChange();
  }

  /**
   * The same match announced again is not a new match, but another map or mode, or a different lobby, is (see
   * isSameMatch: a map name that arrives after the roster does not make a new match). No previous match: the first
   * one, or the game left the lobby in between.
   */
  private isNewMatch(prev: MatchState | null, next: MatchState): boolean {
    return !prev || !isSameMatch(prev, next, this.opts.localSteamId);
  }

  /** The IDs that get looked up, order-insensitive: a team switch or a reorder is not a roster change. */
  private rosterSig(m: MatchState): string {
    return m.players.slice(0, this.limit).map((p) => p.steamId ?? "").sort().join(",");
  }

  /** Update the local player's Steam ID (called when a match starts). */
  setLocalSteamId(steamId: string | null): void {
    this.opts.localSteamId = steamId;
  }

  /** A new Steam Web API key (null: none). The lobby and its lookups stay; only the friendship groups are redone. */
  setSteamApiKey(key: string | null): void {
    if (this.disposed || key === (this.opts.steamApiKey ?? null)) return;
    this.opts.steamApiKey = key;
    // Whatever an earlier pass found, or is still finding, was found with the old key.
    this.friendshipPass++;
    this.friendshipComputedFor = null;
    this.friendshipGroups.clear();
    this.privatePlayers.clear();
    void this.computeFriendshipGroups(); // does nothing without a key, a match or two players
    this.onChange();
  }

  /** Forget everything (e.g. after unlinking or a server change). */
  clear(): void {
    if (this.disposed) return;
    this.cache.clear();
    this.failed.clear();
    this.error = null;
    this.updatedAt = null;
    this.queue = [];
    this.queueSent = 0;
    this.localPlayerDoneFor = null;
    this.friendshipGroups.clear();
    this.privatePlayers.clear();
    this.friendshipComputedFor = null;
    this.friendshipPass++;
    this.backingOff = false;
    this.schedule();
    this.onChange();
  }

  private get limit(): number {
    return this.opts.maxPlayers ?? MAX_LOOKUPS;
  }

  rows(): LobbyRow[] {
    return (this.match?.players ?? []).map((p, i) => {
      if (i >= this.limit)
        return { ...p, classification: null, totalMatches: 0, status: "skipped", detail: null, reputation: null,
                 note: `Not checked: only the first ${this.limit} players of a lobby are looked up`, groupId: null, groupName: null };
      if (!p.steamId) return { ...p, classification: null, totalMatches: 0, status: "no-steam-id", detail: null, reputation: null, note: null, groupId: null, groupName: null };
      const c = this.cache.get(p.steamId);
      if (c)
        return {
          ...p,
          // Steam sometimes doesn't know a stranger's name yet; the server's last known name fills in.
          name: p.name === UNKNOWN_NAME && c.name ? c.name : p.name,
          classification: c.classification, totalMatches: c.totalMatches, status: "ok", detail: c.detail, reputation: c.reputation, note: c.note,
          groupId: this.friendshipGroups.get(p.steamId!)?.groupId ?? null,
          groupName: this.friendshipGroups.get(p.steamId!)?.groupName ?? null,
        };
      const failed = this.failed.has(p.steamId);
      return { ...p, classification: null, totalMatches: 0, status: failed ? "error" : "loading", detail: null, reputation: null, note: failed ? this.failed.get(p.steamId) ?? null : null,
               groupId: null, groupName: null };
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
      if (p.steamId === this.opts.localSteamId && this.localPlayerDoneFor !== this.matchEpoch) {
        ids.push(p.steamId);
        continue;
      }
      const c = this.cache.get(p.steamId);
      if (!c || this.now - c.at > (c.recheckAfterMs ?? ttl)) {
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

  private schedule(delay = this.opts.debounceMs ?? 800): void {
    if (this.disposed || this.backingOff) return; // a retry is waiting; a roster change or a new match must not shorten it
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pendingIds().length === 0) return;
    this.timer = setTimeout(() => void this.run(), delay);
  }

  /** Ask again after a Leetify Retry-After or a failed lookup; schedule() leaves this timer alone until it fires. */
  private scheduleRetry(delayMs: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.backingOff = false;
    if (this.pendingIds().length === 0) return;
    this.backingOff = true;
    this.timer = setTimeout(() => void this.run(), delayMs);
  }

  private async run(): Promise<void> {
    this.timer = null;
    this.backingOff = false;
    if (this.disposed) return;
    if (this.inFlight) return this.schedule();
    const ids = this.pendingIds();
    if (ids.length === 0) return;
    this.inFlight = true;
    const epoch = this.matchEpoch; // a match that begins while this lookup is out must not count as done

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
      if (this.disposed) { this.inFlight = false; return; } // stopped while the lookup was out: its answer is dropped
      const at = this.now;
      let problem: string | null = null;
      let localAnswered = false;
      for (const a of answers) {
        if (!a.steamId) continue;
        if (a.transient) {
          this.failed.set(a.steamId, a.note ?? null);
          problem ??= a.note ?? null;
          retryIn = Math.max(retryIn ?? 0, a.retryAfterMs ?? this.opts.retryMs ?? 15_000);
          continue;
        }
        this.cache.set(a.steamId, { classification: a.classification, totalMatches: a.totalMatches,
                                    name: a.name ?? null, detail: a.detail ?? null, reputation: a.reputation ?? null, note: a.note ?? null, at,
                                    recheckAfterMs: a.recheckAfterMs ?? null });
        this.failed.delete(a.steamId);
        if (a.steamId === this.opts.localSteamId) localAnswered = true;
      }
      this.error = problem;
      this.updatedAt = new Date(at).toISOString();
      // The local player is looked up once per match, but only an answer counts: a refused lookup is asked again.
      if (localAnswered) this.localPlayerDoneFor = epoch;
    } catch (e) {
      if (this.disposed) { this.inFlight = false; return; }
      for (const id of batch) this.failed.set(id, null);
      this.error = e instanceof Error ? e.message : String(e);
      this.inFlight = false;
      this.onChange();
      this.scheduleRetry(this.opts.retryMs ?? 15_000);
      return;
    }
    this.inFlight = false;
    this.onChange();
    // Compute friendship groups after successful lookups (once for each roster).
    if (retryIn === null) {
      void this.computeFriendshipGroups();
    }
    if (retryIn !== null) this.scheduleRetry(retryIn);
    else this.schedule();
  }

  /** Fetch friends lists for all lobby players and compute connected components. */
  private async computeFriendshipGroups(): Promise<void> {
    const key = this.opts.steamApiKey;
    if (!key || this.disposed) return;

    // Gather unique Steam IDs from the current match.
    const ids = new Set<string>();
    for (const p of (this.match?.players ?? [])) {
      if (p.steamId) ids.add(p.steamId);
    }
    const idList = [...ids];
    if (idList.length < 2) {
      // Nothing to group with a single player.
      return;
    }
    // Once for each roster: a repeated announcement costs nothing, a player who joins late is grouped too.
    const roster = [...idList].sort().join(",");
    if (roster === this.friendshipComputedFor) return;
    this.friendshipComputedFor = roster;
    const pass = ++this.friendshipPass;

    try {
      const result = await groupPlayers(idList, key);
      // The roster, the match or the key changed while Steam was answering: a newer pass owns the groups.
      if (pass !== this.friendshipPass) return;
      // Map each player to their group.
      for (const group of result.groups) {
        const groupId = group.length > 1 ? group.join(":") : null;
        const groupName = group.length > 1 ? `${group.length} friends` : null;
        for (const steamId of group) {
          this.friendshipGroups.set(steamId, { groupId, groupName });
        }
      }
      for (const sid of result.private) {
        this.privatePlayers.add(sid);
      }
      if (result.errors.length > 0 && this.opts.onFriendshipError) {
        this.opts.onFriendshipError(result.errors.length);
      }
    } catch (e) {
      if (pass !== this.friendshipPass) return;
      // A thrown error (e.g. 403 invalid key) is surfaced if a callback is registered.
      if (this.opts.onFriendshipKeyError) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Steam API key invalid")) {
          this.opts.onFriendshipKeyError(msg);
        }
      }
    }
    this.onChange();
  }

  /** Stops for good: nothing is scheduled again, and a lookup or grouping still out is answered into the void. */
  dispose(): void {
    this.disposed = true;
    this.friendshipPass++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}