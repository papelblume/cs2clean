// Keeps the lobby rows (roster + class) up to date. Looks up only Steam IDs it hasn't seen recently, so a
// roster update (kills, team switch) doesn't cause a new request.
//
// At most MAX_LOOKUPS lobby players (plus the few added by hand) are ever looked up, so all of them go out in one call;
// the Leetify client limits how many run at once.

import { MAX_LOOKUPS } from "../shared/lobby-size";
import { isSameMatch } from "../shared/match-identity";
import type { PlayerReputation } from "../shared/reputation-types";
import type { EvidenceClass, LobbyRow, MatchState, PlayerDetail, RosterPlayer } from "../shared/types";
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

/**
 * Answers for the given players. `onEarly` may be called once, before the lookup is finished, with the answers that are
 * already settled: the rest (the csst.at fallback can take a minute or more) is still out, and those players wait for
 * the returned list, which holds everyone's answer again.
 */
export type Lookup = (steamIds: string[], onEarly?: (answers: LobbyAnswer[]) => void) => Promise<LobbyAnswer[]>;

/**
 * What a Lookup throws when asking again can't help until something outside the lobby changes (the Leetify key is
 * missing or was rejected, say). Any other error is a hiccup the lobby retries by itself. The message is shown.
 * A new key (clear()) or a new match lets the lobby ask again.
 */
export class LookupBlocked extends Error {}

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

/**
 * Friendship grouping that Steam couldn't answer in full (a rate limit, a network blip) is tried again after this long,
 * at most FRIENDSHIP_RETRIES times for one roster: a hiccup must not leave the lobby ungrouped for the whole match.
 */
const FRIENDSHIP_RETRY_MS = 30_000;
const FRIENDSHIP_RETRIES = 3;

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
  /**
   * Called when friendship grouping is still short of answers (rate limit, network) after its retries, with how many
   * players Steam couldn't answer for; absent in tests.
   */
  onFriendshipError?: (count: number) => void;
  /** Called when the Steam API key is invalid (403); absent in tests. */
  onFriendshipKeyError?: (message: string) => void;
  /** Try friendship grouping again after this long when Steam couldn't answer for everybody (ms). */
  friendshipRetryMs?: number;
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
  /** Why lookups are on hold (see LookupBlocked); null when they aren't. Nothing is retried while this is set. */
  private blocked: string | null = null;
  /** Counts clear()s: a "blocked" answer that was out while the key changed is about the old key, and is dropped. */
  private clears = 0;
  private inFlight = false;
  private failed = new Map<string, string | null>();
  /** Epoch of the match in which the local player has already been looked up. */
  private localPlayerDoneFor: number | null = null;
  error: string | null = null;
  updatedAt: string | null = null;
  /** Friendship groups for the current match, keyed by player SteamID. */
  private friendshipGroups = new Map<string, { groupId: string | null; groupName: string | null }>();
  /** The roster (sorted Steam IDs) friendship grouping last ran for; grouping runs again when a player joins. */
  private friendshipComputedFor: string | null = null;
  /** Bumped whenever a grouping that is still out should be ignored: a newer pass, a new match, a new key, clear, dispose. */
  private friendshipPass = 0;
  /** The roster the retries below are counted for; another roster, a new match or a new key starts the count again. */
  private friendshipRetryRoster: string | null = null;
  private friendshipRetriesLeft = 0;
  private friendshipRetryTimer: NodeJS.Timeout | null = null;
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
      this.localPlayerDoneFor = null;
      this.blocked = null; // one more try per match: the key may have been fixed at the source
      this.resetFriendships(); // the previous match's groups must not show on this one's players while the new pass runs
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
    return this.lookedUp(m).map((p) => p.steamId ?? "").sort().join(",");
  }

  /** The players that get looked up: the first `limit` of the lobby, plus any added by hand, which come on top. */
  private lookedUp(m: MatchState | null): RosterPlayer[] {
    return (m?.players ?? []).filter((p, i) => i < this.limit || p.via === "manual");
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
    this.resetFriendships();
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
    this.localPlayerDoneFor = null;
    this.resetFriendships();
    this.backingOff = false;
    this.blocked = null;
    this.clears++;
    this.schedule();
    this.onChange();
  }

  /**
   * Forgets the friendship groups, and with them any grouping still out or waiting to be retried, so the next
   * computeFriendshipGroups starts from nothing (with a full set of retries).
   */
  private resetFriendships(): void {
    this.friendshipGroups.clear();
    this.friendshipComputedFor = null;
    this.friendshipPass++;
    this.friendshipRetryRoster = null;
    this.friendshipRetriesLeft = 0;
    if (this.friendshipRetryTimer) clearTimeout(this.friendshipRetryTimer);
    this.friendshipRetryTimer = null;
  }

  private get limit(): number {
    return this.opts.maxPlayers ?? MAX_LOOKUPS;
  }

  rows(): LobbyRow[] {
    return (this.match?.players ?? []).map((p, i) => {
      if (i >= this.limit && p.via !== "manual")
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
      // On hold: nobody is looked up, so players who came after the hold began show the reason too, not "loading".
      const failed = this.failed.has(p.steamId) || this.blocked !== null;
      return { ...p, classification: null, totalMatches: 0, status: failed ? "error" : "loading", detail: null, reputation: null, note: failed ? this.failed.get(p.steamId) ?? this.blocked : null,
               groupId: null, groupName: null };
    });
  }

  /** Steam IDs that still need lookups: the players of the current roster that are not cached (or whose entry is stale). */
  private pendingIds(): string[] {
    const ttl = this.opts.ttlMs ?? 6 * 60 * 60 * 1000; // 6 hours default
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const p of this.lookedUp(this.match)) {
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
    return ids;
  }

  private schedule(delay = this.opts.debounceMs ?? 800): void {
    if (this.disposed || this.backingOff || this.blocked !== null) return; // a retry is waiting (a roster change or a new match must not shorten it), or lookups are on hold
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
    const clears = this.clears;

    const batch = ids;

    let retryIn: number | null = null;
    try {
      const answers = await this.lookup(batch, (early) => this.absorbEarly(early, epoch));
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
        this.cache.set(a.steamId, this.toCached(a, at));
        this.failed.delete(a.steamId);
        if (a.steamId === this.opts.localSteamId) localAnswered = true;
      }
      this.error = problem;
      this.updatedAt = new Date(at).toISOString();
      // The local player is looked up once per match, but only an answer counts: a refused lookup is asked again.
      if (localAnswered) this.localPlayerDoneFor = epoch;
    } catch (e) {
      if (this.disposed) { this.inFlight = false; return; }
      const reason = e instanceof Error ? e.message : String(e);
      const hold = e instanceof LookupBlocked;
      if (hold && clears !== this.clears) { // refused for the key that clear() has just replaced: ask again with the new one
        this.inFlight = false;
        this.schedule();
        return;
      }
      for (const id of batch) this.failed.set(id, hold ? reason : null);
      this.error = reason;
      this.inFlight = false;
      if (hold) this.blocked = reason; // asking every 15 seconds would get the same answer; clear() or a new match asks again
      this.onChange();
      if (!hold) this.scheduleRetry(this.opts.retryMs ?? 15_000);
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

  private toCached(a: LobbyAnswer, at: number): Cached {
    return { classification: a.classification, totalMatches: a.totalMatches,
             name: a.name ?? null, detail: a.detail ?? null, reputation: a.reputation ?? null, note: a.note ?? null, at,
             recheckAfterMs: a.recheckAfterMs ?? null };
  }

  /**
   * Shows the settled answers of a lookup that is still running (see Lookup), so players Leetify has answered for don't
   * wait for the slower ones. Transient answers are left alone: the lookup's final list has them too, and run() decides
   * what to retry and when. Whoever is still out keeps the "loading" row.
   */
  private absorbEarly(answers: LobbyAnswer[], epoch: number): void {
    if (this.disposed) return;
    const at = this.now;
    let any = false;
    for (const a of answers) {
      if (!a.steamId || a.transient) continue;
      this.cache.set(a.steamId, this.toCached(a, at));
      this.failed.delete(a.steamId);
      if (a.steamId === this.opts.localSteamId) this.localPlayerDoneFor = epoch;
      any = true;
    }
    if (!any) return;
    this.updatedAt = new Date(at).toISOString();
    this.onChange();
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
    if (this.friendshipRetryTimer) clearTimeout(this.friendshipRetryTimer); // one still waiting was for an older roster
    this.friendshipRetryTimer = null;
    if (roster !== this.friendshipRetryRoster) {
      this.friendshipRetryRoster = roster;
      this.friendshipRetriesLeft = FRIENDSHIP_RETRIES;
    }

    // How many players Steam couldn't answer for; null when this pass is complete.
    let unanswered: number | null = null;
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
      if (result.errors.length > 0) unanswered = result.errors.length;
    } catch (e) {
      if (pass !== this.friendshipPass) return;
      const msg = e instanceof Error ? e.message : String(e);
      // A rejected key stays rejected until it is changed (setSteamApiKey starts over), so that is reported and not
      // retried. Anything else that was thrown is treated like Steam being out of reach.
      if (msg.includes("Steam API key invalid")) this.opts.onFriendshipKeyError?.(msg);
      else unanswered = idList.length;
    }
    if (unanswered !== null) this.retryFriendshipsOrGiveUp(pass, unanswered);
    this.onChange();
  }

  /**
   * Grouping came up short of answers: ask Steam again after a while, a few times. Only when that doesn't help is it
   * reported, so a blip that clears up leaves no notice behind.
   */
  private retryFriendshipsOrGiveUp(pass: number, unanswered: number): void {
    if (this.friendshipRetriesLeft <= 0) {
      this.opts.onFriendshipError?.(unanswered);
      return;
    }
    this.friendshipRetriesLeft--;
    this.friendshipRetryTimer = setTimeout(() => {
      this.friendshipRetryTimer = null;
      if (this.disposed || pass !== this.friendshipPass) return; // the match, the roster or the key moved on meanwhile
      this.friendshipComputedFor = null; // or computeFriendshipGroups would take this roster for one it has already done
      void this.computeFriendshipGroups();
    }, this.opts.friendshipRetryMs ?? FRIENDSHIP_RETRY_MS);
  }

  /** Stops for good: nothing is scheduled again, and a lookup or grouping still out is answered into the void. */
  dispose(): void {
    this.disposed = true;
    this.friendshipPass++;
    if (this.friendshipRetryTimer) clearTimeout(this.friendshipRetryTimer);
    this.friendshipRetryTimer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}