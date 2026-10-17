// Live match data without Overwolf:
//   - CS2's Game State Integration feed (gsi.ts) says when a map loads, the mode, warm-up vs live, and
//     our own Steam ID;
//   - Steam's "recently played with" list (coplay.ts, read in a separate process) gives the other
//     players' Steam IDs, reported by CS2 when the match loads. It has no teams.
// Nothing here opens, reads or changes the CS2 process.

import type { MatchState, RosterPlayer } from "../../shared/types";
import type { LobbyPlayer, StatusBlock } from "../steam/console-log";
import type { CoplayResult, FriendInGame } from "../steam/coplay";
import type { FriendNames } from "../steam/friend-names";
import { matchProfileFriends } from "../steam/miniprofile";
import { matchLobbyNames, type NameCandidate } from "../steam/name-match";
import type { GameState } from "../steam/gsi";
import type { FriendsWindow } from "../steam/friends-window";
import { othersToFind, pickFriends, pickMatchPlayers } from "../steam/pick";
import { matchFriends, type FriendMatch, type UiResult } from "../steam/steam-ui";
import { GameSource } from "./source";

export interface SteamSourceDeps {
  /** Reads Steam's players list and friends in CS2 (in a separate process in the app). */
  scan: (localSteamId: string | null) => Promise<CoplayResult>;
  /** Starts the game-state listener; returns a stop function. */
  listen: (onState: (s: GameState) => void) => () => void;
  /** Reads Steam's friends list window over the debug port (steam/steam-ui.ts). Optional: without it, or when Steam
   * wasn't started with -cef-enable-debugging, friends are only added by the presence rules in pickFriends. */
  uiStatus?: () => Promise<UiResult>;
  /** Opens Steam's friends list window when it is closed (steam/friends-window.ts): once when the app starts, and in a
   * match's warm-up while a friend in CS2 could fill an empty slot. Optional: without it the window is left alone. */
  friendsWindow?: FriendsWindow;
  /** One line on why Steam's friends list can't be read, from the capabilities (steam/capabilities.ts); null when
   * nothing needs saying. Optional: without it a generic line is logged. */
  friendsListHint?: () => Promise<string | null>;
  /** Starts watching CS2's console.log for `status` player lists (steam/console-log.ts); returns a stop function.
   * Optional: without it `status` isn't read. */
  listenStatus?: (onBlock: (b: StatusBlock) => void) => () => void;
  /** The names and Steam IDs of all the user's Steam friends from the Web API (steam/friend-names.ts), matched against
   * a `status` list besides the friends the Steam client says are playing CS2. They include friends who appear
   * offline. Optional. */
  friendNames?: (localSteamId: string | null) => Promise<FriendNames>;
  /** A friend's rich-presence line ("Premier - Inferno [ 0 : 2 ]") from Steam's public mini-profile, up to ~10 minutes old
   * (steam/miniprofile.ts). Only used as the fallback when `profileFallback` says so. Optional: without it there is no fallback. */
  friendStatus?: (steamId: string) => Promise<string | null>;
  /** Whether the mini-profile fallback is wanted now: neither Steam's debug port nor CS2's console.log is in use
   * (steam/capabilities.ts). Optional: without it there is no fallback. */
  profileFallback?: (ctx: { sessionStartMs: number | null }) => Promise<boolean>;
  /** The line to show while friends are playing CS2 and a slot is empty: what would find them (steam/capabilities.ts);
   * null when nothing needs saying. Optional: without it no hint is shown. */
  friendsHint?: (ctx: { statusSeen: boolean; sessionStartMs: number | null }) => Promise<string | null>;
  /** Why game-state data may be missing (e.g. CS2's folder wasn't found), or null. */
  gsiProblem?: string | null;
  /** Our Steam ID from the linked account, used until the game reports it. */
  localSteamId?: () => string | null;
  now?: () => number;
  /** Scan intervals (ms). */
  fastMs?: number;
  slowMs?: number;
}

const GSI_SILENT_MS = 35_000; // CS2 sends a heartbeat every 10 s while running.
// Opening the friends list when the app starts: first after one heartbeat period (so a running CS2 has said what it
// is doing), then every 15 s until it is open or the tries run out. Steam may still be starting.
const START_OPEN_FIRST_MS = 12_000;
const START_OPEN_RETRY_MS = 15_000;
const START_OPEN_TRIES = 8;
const HINT_EVERY_MS = 15_000; // how often the hint is worked out while it is needed
const PROFILE_CHECK_MS = 15_000; // how often it is worked out whether the mini-profile fallback is wanted
const MAX_PROFILE_LOOKUPS = 12; // friends whose mini-profile is read per scan

export class SteamSource extends GameSource {
  readonly kind = "steam" as const;
  private game: GameState | null = null;
  private gsiAt = 0;
  private matchStart: number | null = null;
  private players: RosterPlayer[] = [];
  /** Friends whose friends-list status equals ours (steam-ui.ts). Kept apart from `players`: the players list is the
   * match, these are topped up into the free slots and re-checked on every scan. */
  private uiFriends: FriendMatch[] = [];
  private uiWarned = false;
  /** The last `status` player list of this match (steam/console-log.ts); null until the user runs `status`. */
  private lobby: LobbyPlayer[] | null = null;
  /** Friends matched to names in that list (steam/name-match.ts). Kept apart from `players` like `uiFriends`: they stay
   * for the whole match, and come first among the friends because a name in the list is exact. */
  private statusFriends = new Map<string, { steamId: string; name: string }>();
  private stopStatus: (() => void) | null = null;
  private namesWarned = false;
  /** A `status` list arrived while a scan was running: scan again as soon as it ends, not after the usual wait. */
  private statusRescan = false;
  /** When CS2's current session began, as far as we know (the first game-state post since it wasn't running). */
  private sessionStart: number | null = null;
  private lastHint: string | null = null;
  /** Friends found through the mini-profile fallback: a guess, so they come last and are worked out afresh each scan. */
  private profileFriends: { steamId: string; name: string | null }[] = [];
  private profileWanted = false;
  private profileWantedAt: number | null = null;
  private hintAt: number | null = null;
  private startOpenTimer: NodeJS.Timeout | null = null;
  private startOpenTries = 0;
  /** Coplay time (s) of the current match's group; null until found. */
  private groupStart: number | null = null;
  private localName: string | null = null;
  private stopListening: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private scanning = false;
  private running = false;
  private lastProblem: string | null | undefined = undefined;

  constructor(private deps: SteamSourceDeps) {
    super();
  }

  private get now() {
    return (this.deps.now ?? Date.now)();
  }

  start(): void {
    this.stopListening = this.deps.listen((s) => this.onGameState(s));
    this.stopStatus = this.deps.listenStatus?.((b) => this.onStatusBlock(b)) ?? null;
    this.watchdog = setInterval(() => this.checkRunning(), 5_000);
    this.setProblem(this.deps.gsiProblem ?? null);
    if (this.deps.friendsWindow) this.startOpenTimer = setTimeout(() => void this.openFriendsWindowAtStart(), START_OPEN_FIRST_MS);
    this.schedule(0);
  }

  stop(): void {
    this.stopListening?.();
    this.stopStatus?.();
    this.stopStatus = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.startOpenTimer) clearTimeout(this.startOpenTimer);
    this.timer = this.watchdog = this.startOpenTimer = null;
  }

  refresh(): void {
    this.schedule(0);
  }

  private get gsiLive(): boolean {
    return this.gsiAt > 0 && this.now - this.gsiAt < GSI_SILENT_MS;
  }

  private onGameState(s: GameState): void {
    const prevMap = this.game?.map ?? null;
    const firstPost = this.gsiAt === 0;
    if (!this.running) this.sessionStart = this.now;
    this.gsiAt = this.now;
    this.game = s;
    if (!this.running) this.setGameRunning(true);
    if (s.map !== prevMap) {
      if (s.map) this.deps.friendsWindow?.newMatch();
      if (firstPost && s.map && this.players.length > 0) {
        // The first post of the feed already names a map: the app started in the middle of a match, and its players
        // were read from Steam before the game said anything. They are this match's, so keep them. Forgetting them
        // would also look for them again from "now" (matchStart), which leaves out everyone Steam reported more than
        // three minutes ago; the start of this match is unknown, so the plain recency window stays in charge.
        this.matchStart = null;
      } else {
        // A new map (or back to the menu): forget the previous match's players.
        this.matchStart = s.map ? this.now : null;
        this.clearRoster();
        this.groupStart = null;
      }
      if (s.map) this.schedule(1_500);
    }
    this.scheduleMatch();
  }

  /** A window popping up over a live round is a nuisance: only when CS2 isn't running, is in its menu, or is warming up. */
  private get safeToOpenWindow(): boolean {
    if (!this.gsiLive || !this.game?.map) return true;
    return this.game.phase == null || this.game.phase === "warmup";
  }

  /** The app just started: open Steam's friends list if it is closed (once it is reachable and it is safe to). */
  private async openFriendsWindowAtStart(): Promise<void> {
    this.startOpenTimer = null;
    const w = this.deps.friendsWindow;
    if (!w) return;
    this.startOpenTries++;
    let result: string = "wait";
    if (this.safeToOpenWindow) {
      try { result = await w.ensure("start"); } catch { result = "failed"; }
    }
    const settled = result === "open" || result === "opened" || result === "disabled" || result === "limit";
    if (!settled && this.startOpenTries < START_OPEN_TRIES && this.deps.friendsWindow)
      this.startOpenTimer = setTimeout(() => void this.openFriendsWindowAtStart(), START_OPEN_RETRY_MS);
  }

  /** Warm-up, a friend is playing CS2 and a slot is empty: the friends list is needed now, so open it if it is closed. */
  private openFriendsWindowInWarmup(friends: FriendInGame[], others: number): void {
    const w = this.deps.friendsWindow;
    if (!w || this.game?.phase !== "warmup" || friends.length === 0 || this.players.length >= others) return;
    void w.ensure("warmup").catch(() => {});
  }

  private clearRoster(): void {
    this.players = [];
    this.uiFriends = [];
    this.statusFriends.clear();
    this.profileFriends = [];
    this.lobby = null;
    this.hintAt = null;
    this.setHint(null);
  }

  /**
   * The players we are sure of: the players list first, then friends found by name in a `status` list, then friends
   * found through the friends list's status lines, each friend once, up to the mode's size.
   */
  private get baseRoster(): RosterPlayer[] {
    const seen = new Set(this.players.map((p) => p.steamId));
    const friends: RosterPlayer[] = [];
    for (const f of [...this.statusFriends.values(), ...this.uiFriends]) {
      if (seen.has(f.steamId)) continue;
      seen.add(f.steamId);
      friends.push({ slot: 0, name: f.name ?? "Unknown player", steamId: f.steamId, side: null, isLocal: false });
    }
    return [...this.players, ...friends].slice(0, this.others).map((p, i) => ({ ...p, slot: i + 1 }));
  }

  /** The match's players: the ones we are sure of, then the mini-profile fallback's guesses (marked `via: "profile"`). */
  private get roster(): RosterPlayer[] {
    const base = this.baseRoster;
    const seen = new Set(base.map((p) => p.steamId));
    const guesses: RosterPlayer[] = this.profileFriends
      .filter((f) => !seen.has(f.steamId))
      .map((f) => ({ slot: 0, name: f.name ?? "Unknown player", steamId: f.steamId, side: null, isLocal: false, via: "profile" as const }));
    return [...base, ...guesses].slice(0, this.others).map((p, i) => ({ ...p, slot: i + 1 }));
  }

  /** The user ran `status`: remember who it lists and look again now, so the friends in it show up straight away. */
  private onStatusBlock(b: StatusBlock): void {
    if (!this.inMap || b.players.length === 0) return; // not in a match, or not connected to a server
    this.lobby = b.players;
    this.hintAt = null;
    if (this.scanning) this.statusRescan = true; // the scan in progress may have read the friends before this list
    else this.schedule(0);
  }

  private checkRunning(): void {
    if (this.running && this.gsiAt > 0 && !this.gsiLive) {
      // CS2 closed.
      this.game = null;
      this.matchStart = null;
      this.sessionStart = null;
      this.clearRoster();
      this.setGameRunning(false);
    }
  }

  private setGameRunning(running: boolean): void {
    this.running = running;
    this.emit("running", running);
    this.scheduleMatch();
  }

  private setHint(h: string | null): void {
    if (h === this.lastHint) return;
    this.lastHint = h;
    this.emit("hint", h);
  }

  private setProblem(p: string | null): void {
    if (p === this.lastProblem) return;
    this.lastProblem = p;
    this.emit("problem", p);
  }

  /** How many other players to look for: the mode's (from the game-state feed; Competitive's until it says), up to the cap. */
  private get others(): number {
    return othersToFind(this.game?.mode);
  }

  /** In a map by the game's own report; without the game-state feed, assume yes and rely on recency. */
  private get inMap(): boolean {
    return this.gsiLive ? !!this.game?.map : this.gsiAt === 0;
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.scan(), delay);
  }

  private nextDelay(): number {
    const fast = this.deps.fastMs ?? 8_000, slow = this.deps.slowMs ?? 60_000;
    if (!this.inMap) return slow;
    const complete = this.baseRoster.length >= this.others; // guesses don't count
    if (!this.gsiLive) return 20_000;
    return complete ? slow : fast;
  }

  private async scan(): Promise<void> {
    this.timer = null;
    if (this.scanning) return;
    if (!this.inMap) return this.schedule(this.nextDelay());
    this.scanning = true;
    try {
      const others = this.others; // the mode could change while Steam is read; one answer for the whole scan
      const local = this.game?.localSteamId ?? this.deps.localSteamId?.() ?? null;
      const res = await this.deps.scan(local);
      this.localName = res.localName;
      const picked = pickMatchPlayers(res.entries, {
        now: Math.floor(this.now / 1000),
        localSteamId: local,
        matchStart: this.matchStart != null ? Math.floor(this.matchStart / 1000) : null,
        expectedOthers: others,
      });
      if (this.inMap) {
        // Detect a new match group: significant time gap from the previous group, or all current players
        // have disappeared from the coplay list (a new server on the same map).
        const groupStart = picked.players.length > 0 ? Math.min(...picked.players.map((e) => e.time)) : 0;
        if (picked.players.length > 0 && this.groupStart != null && groupStart - this.groupStart > 60) {
          // New match: time gap indicates a fresh game session.
          this.clearRoster();
        } else if (picked.players.length > 0 && this.players.length > 0) {
          // Check if all current players have left (no overlap in Steam IDs).
          const currentIds = new Set(picked.players.map((e) => e.steamId));
          const allGone = this.players.every((p) => !p.steamId || !currentIds.has(p.steamId));
          if (allGone) this.clearRoster();
        }
        if (picked.players.length) this.groupStart = groupStart;
        // Players stay for the whole match once seen, so a later scan can't drop one.
        const byId = new Map(this.players.map((p) => [p.steamId, p]));
        for (const e of picked.players)
          byId.set(e.steamId, { slot: 0, name: e.name ?? byId.get(e.steamId)?.name ?? "Unknown player", steamId: e.steamId, side: null, isLocal: false });
        // Steam leaves friends out of its players list: top up a short list with friends in this match.
        const friends = pickFriends(res.friends ?? [], {
          map: this.game?.map ?? null, localPresence: res.localPresence,
          exclude: new Set([...byId.keys(), local].filter((x): x is string => !!x)), max: others - byId.size,
        });
        for (const f of friends)
          byId.set(f.steamId, { slot: 0, name: f.name ?? "Unknown player", steamId: f.steamId, side: null, isLocal: false });
        this.players = [...byId.values()].slice(0, others).map((p, i) => ({ ...p, slot: i + 1 }));
        await this.updateStatusFriends(res.friends ?? [], local, others);
        this.openFriendsWindowInWarmup(res.friends ?? [], others);
        await this.updateUiFriends(res.friends ?? [], local);
        await this.updateProfileFriends(res.friends ?? [], local, others);
        await this.updateHint(res.friends ?? [], others);
      }
      // Players found but CS2 never sent game state: it was most likely started before the cfg existed.
      const noGsi = this.gsiAt === 0 && this.players.length > 0
        ? "CS2 isn't sending game state, so the overlay can't hide itself when the match goes live. Restart CS2 once."
        : null;
      this.setProblem(this.gsiAt === 0 ? this.deps.gsiProblem ?? noGsi : null);
      this.scheduleMatch();
    } catch (e) {
      this.setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      this.scanning = false;
      const again = this.statusRescan;
      this.statusRescan = false;
      this.schedule(again ? 0 : this.nextDelay());
    }
  }

  /** Friends in our match by their status line (see steam-ui.ts). A failed read keeps what was found before. */
  private async updateUiFriends(friends: FriendInGame[], local: string | null): Promise<void> {
    const read = this.deps.uiStatus;
    if (!read) return;
    if (friends.length === 0) {
      this.uiFriends = [];
      return;
    }
    let r: UiResult;
    try {
      r = await read();
    } catch {
      return;
    }
    if (!r.ok) {
      if (!this.uiWarned && r.reason !== "error") {
        this.uiWarned = true;
        void this.warnFriendsListUnreadable(r.reason);
      }
      return;
    }
    this.uiWarned = false;
    const exclude = new Set([...this.players.map((p) => p.steamId), ...this.statusFriends.keys(), local].filter((x): x is string => !!x));
    this.uiFriends = matchFriends(friends, r.snapshot, { exclude, previous: this.uiFriends });
  }

  /**
   * Friends in our match by name: the players the last `status` listed, matched to friends (steam/name-match.ts).
   * The names come from the Steam client (friends playing CS2) and, when there is a key, the Web API (all friends).
   * A friend found stays for the match, and every name in the list that belongs to a player we already know is used up
   * first, so a stranger and a friend with the same name can't be mixed up.
   */
  private async updateStatusFriends(inCs2: FriendInGame[], local: string | null, others: number): Promise<void> {
    if (!this.lobby || this.baseRoster.length >= others) return;
    const candidates: NameCandidate[] = [...inCs2.map((f) => ({ steamId: f.steamId, name: f.name })), ...(await this.webFriendNames(local))];
    // Friends the friends list found are not "known" here: a name in the list confirms them (and moves them up).
    const have = [...this.players, ...this.statusFriends.values()];
    const { matches } = matchLobbyNames(this.lobby, candidates, {
      exclude: new Set([...have.map((p) => p.steamId), local].filter((x): x is string => !!x)),
      knownNames: have.map((p) => p.name),
      localName: this.localName,
    });
    for (const m of matches) this.statusFriends.set(m.steamId, { steamId: m.steamId, name: m.name });
  }

  private async webFriendNames(local: string | null): Promise<NameCandidate[]> {
    const get = this.deps.friendNames;
    if (!get) return [];
    try {
      const r = await get(local);
      if ((r.error === "private" || r.error === "bad-key") && !this.namesWarned) {
        this.namesWarned = true;
        console.warn(`[cs2clean] Friends can't be matched by name through the Steam Web API: ${r.error === "private" ? "your Steam friends list isn't public" : "Steam turned the API key down"}.`);
      }
      return r.friends;
    } catch {
      return [];
    }
  }

  /**
   * The fallback, when neither Steam's debug port nor CS2's console.log is in use: friends playing CS2 whose mini-profile
   * line (up to ~10 minutes old) names our map in a mode that can be ours, only while a slot is empty and only if they
   * all fit. They are guesses: marked in the roster, worked out afresh each scan, and never in the way of the exact sources.
   */
  private async updateProfileFriends(inCs2: FriendInGame[], local: string | null, others: number): Promise<void> {
    const ask = this.deps.friendStatus;
    const base = this.baseRoster;
    const known = new Set([...base.map((p) => p.steamId), local].filter((x): x is string => !!x));
    const free = others - base.length;
    const candidates = inCs2.filter((f) => !known.has(f.steamId));
    if (!ask || !this.game?.map || free <= 0 || candidates.length === 0 || !(await this.profileFallbackOn())) {
      this.profileFriends = [];
      return;
    }
    const withStatus = await Promise.all(candidates.slice(0, MAX_PROFILE_LOOKUPS).map(async (f) => {
      try { return { ...f, status: await ask(f.steamId) }; } catch { return { ...f, status: null }; }
    }));
    this.profileFriends = matchProfileFriends(withStatus, { map: this.game.map, mode: this.game.mode, exclude: known, max: free })
      .map((f) => ({ steamId: f.steamId, name: f.name }));
  }

  /** Whether the fallback is wanted, asked at most every 15 s. */
  private async profileFallbackOn(): Promise<boolean> {
    const ask = this.deps.profileFallback;
    if (!ask) return false;
    if (this.profileWantedAt != null && this.now - this.profileWantedAt < PROFILE_CHECK_MS) return this.profileWanted;
    this.profileWantedAt = this.now;
    try { this.profileWanted = await ask({ sessionStartMs: this.sessionStart }); } catch { this.profileWanted = false; }
    return this.profileWanted;
  }

  /** The hint about finding friends: while friends are playing CS2 and a slot is empty, and not more than every 15 s. */
  private async updateHint(inCs2: FriendInGame[], others: number): Promise<void> {
    const make = this.deps.friendsHint;
    if (!make) return;
    const roster = this.baseRoster; // a guess doesn't settle it: the hint is how to get the exact answer
    const inRoster = new Set(roster.map((p) => p.steamId));
    if (roster.length >= others || !inCs2.some((f) => !inRoster.has(f.steamId))) {
      this.setHint(null);
      return;
    }
    if (this.hintAt != null && this.now - this.hintAt < HINT_EVERY_MS) return; // keep what is shown
    this.hintAt = this.now;
    let line: string | null = null;
    try { line = await make({ statusSeen: this.lobby != null, sessionStartMs: this.sessionStart }); } catch { /* no hint */ }
    this.setHint(line);
  }

  private async warnFriendsListUnreadable(reason: string): Promise<void> {
    const hint = this.deps.friendsListHint;
    if (!hint) {
      console.warn(`[cs2clean] Friends in CS2 found, but Steam's friends list can't be read (${reason}). Start Steam with -cef-enable-debugging and keep the friends list window open to add friends in your match.`);
      return;
    }
    let line: string | null = null;
    try { line = await hint(); } catch { /* no hint */ }
    if (line) console.warn(`[cs2clean] Friends in CS2 found, but Steam's friends list can't be read. ${line}`);
  }

  protected currentMatch(): MatchState {
    const localSteamId = this.game?.localSteamId ?? this.deps.localSteamId?.() ?? null;
    const roster = this.roster;
    if (!this.inMap || roster.length === 0)
      return { map: this.game?.map ?? null, mode: this.game?.mode ?? null, phase: this.game?.phase ?? null, localSteamId, players: [] };
    const me: RosterPlayer = { slot: 0, name: this.localName ?? "You", steamId: localSteamId, side: null, isLocal: true };
    return {
      map: this.game?.map ?? null,
      mode: this.game?.mode ?? null,
      phase: this.game?.phase ?? null,
      localSteamId,
      players: [me, ...roster],
    };
  }
}
