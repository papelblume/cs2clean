// Keeps the lobby rows (roster + class) up to date. Looks up only Steam IDs it hasn't seen recently, so a
// roster update (kills, team switch) doesn't cause a new request.

import type { PlayerReputation } from "../shared/reputation-types";
import type { EvidenceClass, LobbyRow, MatchState, PlayerDetail } from "../shared/types";

/** What a lookup says about one player. */
export interface LobbyAnswer {
  steamId: string | null;
  classification: EvidenceClass | null;
  matchesAnalyzed: number;
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
  matchesAnalyzed: number;
  name: string | null;
  detail: PlayerDetail | null;
  reputation: PlayerReputation | null;
  note: string | null;
  at: number;
}

const UNKNOWN_NAME = "Unknown player";

export interface LobbyOptions {
  /** Wait this long after a roster change before asking, so a filling lobby costs one request (ms). */
  debounceMs?: number;
  /** Ask again for a player after this long (ms). */
  ttlMs?: number;
  /** After a failed lookup, try again after this long (ms). */
  retryMs?: number;
  now?: () => number;
}

export class LobbyService {
  private cache = new Map<string, Cached>();
  private match: MatchState | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private failed = new Map<string, string | null>();
  error: string | null = null;
  updatedAt: string | null = null;

  constructor(private lookup: Lookup, private onChange: () => void, private opts: LobbyOptions = {}) {}

  private get now() {
    return (this.opts.now ?? Date.now)();
  }

  setMatch(match: MatchState | null): void {
    this.match = match;
    this.schedule();
    this.onChange();
  }

  /** Forget everything (e.g. after unlinking or a server change). */
  clear(): void {
    this.cache.clear();
    this.failed.clear();
    this.error = null;
    this.updatedAt = null;
    this.schedule();
    this.onChange();
  }

  rows(): LobbyRow[] {
    return (this.match?.players ?? []).map((p) => {
      if (!p.steamId) return { ...p, classification: null, matchesAnalyzed: 0, status: "no-steam-id", detail: null, reputation: null, note: null };
      const c = this.cache.get(p.steamId);
      if (c)
        return {
          ...p,
          // Steam sometimes doesn't know a stranger's name yet; the server's last known name fills in.
          name: p.name === UNKNOWN_NAME && c.name ? c.name : p.name,
          classification: c.classification, matchesAnalyzed: c.matchesAnalyzed, status: "ok", detail: c.detail, reputation: c.reputation, note: c.note,
        };
      const failed = this.failed.has(p.steamId);
      return { ...p, classification: null, matchesAnalyzed: 0, status: failed ? "error" : "loading", detail: null, reputation: null, note: failed ? this.failed.get(p.steamId) ?? null : null };
    });
  }

  private missing(): string[] {
    const ttl = this.opts.ttlMs ?? 15 * 60_000;
    const ids = new Set<string>();
    for (const p of this.match?.players ?? []) {
      if (!p.steamId) continue;
      const c = this.cache.get(p.steamId);
      if (!c || this.now - c.at > ttl) ids.add(p.steamId);
    }
    return [...ids];
  }

  private schedule(delay = this.opts.debounceMs ?? 800): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.missing().length === 0) return;
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async run(): Promise<void> {
    this.timer = null;
    if (this.inFlight) return this.schedule();
    const ids = this.missing();
    if (ids.length === 0) return;
    this.inFlight = true;
    let retryIn: number | null = null;
    try {
      const answers = await this.lookup(ids);
      const at = this.now;
      let problem: string | null = null;
      for (const a of answers) {
        if (!a.steamId) continue;
        if (a.transient) {
          // Not remembered: the player is asked for again after the pause.
          this.failed.set(a.steamId, a.note ?? null);
          problem ??= a.note ?? null;
          retryIn = Math.max(retryIn ?? 0, a.retryAfterMs ?? this.opts.retryMs ?? 15_000);
          continue;
        }
        this.cache.set(a.steamId, { classification: a.classification, matchesAnalyzed: a.matchesAnalyzed,
                                    name: a.name ?? null, detail: a.detail ?? null, reputation: a.reputation ?? null, note: a.note ?? null, at });
        this.failed.delete(a.steamId);
      }
      this.error = problem;
      this.updatedAt = new Date(at).toISOString();
    } catch (e) {
      for (const id of ids) this.failed.set(id, null);
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
