// The app's state and flows (API key, lobby lookups, overlay), without any Electron code so it can be
// tested directly. main.ts connects it to windows, IPC and Overwolf.

import { EventEmitter } from "node:events";
import { cleanHotkeys, DEFAULT_HOTKEYS, hotkeyProblem, type HotkeyName, type Hotkeys } from "../shared/hotkeys";
import type { AppState, MatchState } from "../shared/types";
import type { GameSource } from "./game/source";
import { LeetifyClient, lookupLobby } from "./leetify";
import { LobbyService, type LobbyOptions } from "./lobby";

export interface Settings {
  /** The user's Leetify API key (https://leetify.com/app/developer). */
  leetifyKey?: string | null;
  /** Siren when a HIGH player is found (default on). */
  siren?: boolean;
  /** Overlay hotkeys chosen in Settings (default Shift+F2 and F7). */
  hotkeys?: Partial<Hotkeys>;
}

export interface SettingsStore {
  load(): Settings;
  save(s: Settings): void;
}

export interface ControllerDeps {
  version: string;
  source: GameSource;
  store: SettingsStore;
  /** A key from the environment (LEETIFY_API_KEY), used when none is saved. */
  envKey?: string | null;
  overlay: AppState["overlay"];
  fetchImpl?: typeof fetch;
  lobby?: LobbyOptions;
  /** Requests to Leetify in flight at once. */
  leetifyConcurrency?: number;
  /** Registers the overlay hotkeys with the system; returns why it failed (e.g. taken by another program). */
  applyHotkeys?: (h: Hotkeys) => string | null;
  /** Starting with Windows (a login item); absent where it isn't offered. */
  startup?: { get(): boolean; set(on: boolean): void };
}

export class Controller extends EventEmitter<{ state: [AppState] }> {
  readonly leetify: LeetifyClient;
  private lobby: LobbyService;
  private settings: Settings;
  /** Players the siren already went off for, in the current match. */
  private alerted = new Set<string>();
  private matchKey: string | null = null;
  state: AppState;

  constructor(private deps: ControllerDeps) {
    super();
    this.settings = { ...deps.store.load() };
    const key = this.settings.leetifyKey || deps.envKey || null;
    this.leetify = new LeetifyClient(key, deps.fetchImpl);
    this.lobby = new LobbyService((ids) => this.lookup(ids), () => this.publish(), deps.lobby);
    this.state = {
      version: deps.version,
      leetify: { hasKey: !!key, reachable: null },
      notice: null,
      game: { source: deps.source.kind, running: false, problem: null },
      match: null,
      lobby: { rows: [], updatedAt: null, error: null },
      overlay: { ...deps.overlay, siren: this.settings.siren ?? true },
      hotkeysEditable: !!deps.applyHotkeys,
      startWithWindows: deps.startup ? deps.startup.get() : null,
      alert: { seq: 0, names: [] },
    };
  }

  start(): void {
    this.startHotkeys();
    const src = this.deps.source;
    src.on("running", (running) => this.update({ game: { ...this.state.game, running } }));
    src.on("problem", (problem) => this.update({ game: { ...this.state.game, problem } }));
    src.on("match", (m: MatchState) => this.onMatch(m));
    src.start();
  }

  stop(): void {
    this.deps.source.stop();
    this.lobby.dispose();
  }

  // ------------------------------------------------------------------ API key

  /** Checks the key with Leetify and saves it when Leetify accepts it. */
  async setApiKey(raw: string): Promise<boolean> {
    const key = raw.trim();
    if (!key) return false;
    const probe = new LeetifyClient(key, this.deps.fetchImpl);
    try {
      if (!(await probe.validateKey())) {
        this.update({ notice: "Leetify rejected that API key." });
        return false;
      }
    } catch (e) {
      this.update({ notice: `Couldn't check the key with Leetify: ${message(e)}` });
      return false;
    }
    this.useKey(key);
    this.update({ notice: null });
    return true;
  }

  clearApiKey(): void {
    this.useKey(null);
  }

  private useKey(key: string | null): void {
    this.settings = { ...this.settings, leetifyKey: key };
    this.deps.store.save(this.settings);
    this.leetify.apiKey = key || this.deps.envKey || null;
    this.state.leetify = { ...this.state.leetify, hasKey: !!this.leetify.apiKey };
    this.lobby.clear(); // asks again with the new key
  }

  // ------------------------------------------------------------------ settings

  /** The saved hotkeys; if the system refuses them (another program took one), the defaults. */
  private startHotkeys(): void {
    const saved = cleanHotkeys(this.settings.hotkeys);
    if (!this.deps.applyHotkeys) return;
    let err = this.deps.applyHotkeys(saved);
    let h = saved;
    if (err && (saved.lobby !== DEFAULT_HOTKEYS.lobby || saved.detail !== DEFAULT_HOTKEYS.detail)) {
      h = { ...DEFAULT_HOTKEYS };
      err = this.deps.applyHotkeys(h) ? err : `${err} Using the default hotkeys instead.`;
    }
    this.state.overlay = { ...this.state.overlay, hotkey: h.lobby, detailHotkey: h.detail };
    if (err) this.state.notice = err;
  }

  private get hotkeys(): Hotkeys {
    return { lobby: this.state.overlay.hotkey, detail: this.state.overlay.detailHotkey };
  }

  /** Changes one overlay hotkey; returns false (with a notice) when it can't be used. */
  setHotkey(which: HotkeyName, hotkey: string): boolean {
    return this.setHotkeys({ ...this.hotkeys, [which]: hotkey });
  }

  resetHotkeys(): boolean {
    return this.setHotkeys({ ...DEFAULT_HOTKEYS });
  }

  private setHotkeys(next: Hotkeys): boolean {
    const problem = hotkeyProblem(next.lobby) ?? hotkeyProblem(next.detail)
      ?? (next.lobby === next.detail ? `${next.lobby} is already the other overlay hotkey.` : null)
      ?? this.deps.applyHotkeys?.(next)
      ?? null;
    if (problem) {
      this.deps.applyHotkeys?.(this.hotkeys);
      this.update({ notice: problem });
      return false;
    }
    this.settings = { ...this.settings, hotkeys: next };
    this.deps.store.save(this.settings);
    this.update({ notice: null, overlay: { ...this.state.overlay, hotkey: next.lobby, detailHotkey: next.detail } });
    return true;
  }

  setOverlayVisible(visible: boolean): void {
    this.update({ overlay: { ...this.state.overlay, visible } });
  }

  /** Lobby hotkey: show the lobby list, or hide the overlay if the list is already showing. */
  toggleOverlay(): void {
    const o = this.state.overlay;
    const hide = o.visible && o.view === "lobby";
    this.update({ overlay: { ...o, visible: !hide, view: "lobby" } });
    if (!hide) this.deps.source.refresh();
  }

  /** Detail hotkey (F7): show the extended card of the flagged players, or hide it again. */
  toggleDetail(): void {
    const o = this.state.overlay;
    const hide = o.visible && o.view === "detail";
    this.update({ overlay: { ...o, visible: !hide, view: "detail" } });
  }

  setStartWithWindows(on: boolean): void {
    if (!this.deps.startup) return;
    this.deps.startup.set(on);
    this.update({ startWithWindows: this.deps.startup.get() });
  }

  setSiren(on: boolean): void {
    this.settings = { ...this.settings, siren: on };
    this.deps.store.save(this.settings);
    this.update({ overlay: { ...this.state.overlay, siren: on } });
  }

  testSiren(): void {
    this.update({ alert: { seq: this.state.alert.seq + 1, names: [] } });
  }

  // ------------------------------------------------------------------ match

  private onMatch(m: MatchState): void {
    const inMatch = m.players.length > 0;
    const prev = this.state.match;
    const key = inMatch ? `${m.map ?? ""}` : null;
    if (key !== this.matchKey) {
      // Another match (or none): the siren may go off again for the new lobby.
      this.matchKey = key;
      this.alerted.clear();
    }
    this.state.match = inMatch ? { map: m.map, mode: m.mode, phase: m.phase } : null;
    const o = this.state.overlay;
    if (inMatch && !prev && m.phase !== "live") {
      // The lobby just appeared in warm-up: show it without a key press.
      this.state.overlay = { ...o, visible: true, view: "lobby" };
    } else if (inMatch && m.phase === "live" && prev?.phase !== "live") {
      // The match started: out of the way until a hotkey brings it back.
      this.state.overlay = { ...o, visible: false };
    }
    this.lobby.setMatch(inMatch ? m : null);
  }

  /** Siren once per HIGH player per match (the overlay plays it when alert.seq changes). */
  private checkAlerts(): void {
    if (!this.state.match) return;
    const fresh = this.state.lobby.rows.filter((r) => (r.classification === "HIGH" || r.classification === "VERY_HIGH") && r.steamId && !r.isLocal && !this.alerted.has(r.steamId));
    if (fresh.length === 0) return;
    for (const r of fresh) this.alerted.add(r.steamId!);
    if (this.state.overlay.siren) this.state.alert = { seq: this.state.alert.seq + 1, names: fresh.map((r) => r.name) };
  }

  /** The player's Leetify profile; only for a real SteamID64, so nothing else ends up in a URL. */
  playerUrl(steamId: string): string | null {
    return /^\d{17}$/.test(steamId) ? `https://leetify.com/app/profile/${steamId}` : null;
  }

  // ------------------------------------------------------------------ lobby

  private async lookup(steamIds: string[]) {
    try {
      return await lookupLobby(this.leetify, steamIds, {
        concurrency: this.deps.leetifyConcurrency,
        onReach: (ok) => {
          if (this.state.leetify.reachable !== ok) this.state.leetify = { ...this.state.leetify, reachable: ok };
        },
      });
    } catch (e) {
      throw new Error(message(e));
    }
  }

  // ------------------------------------------------------------------ state

  private update(patch: Partial<AppState>): void {
    Object.assign(this.state, patch);
    this.publish();
  }

  private publish(): void {
    this.state.lobby = { rows: this.lobby.rows(), updatedAt: this.lobby.updatedAt, error: this.lobby.error };
    this.checkAlerts();
    this.emit("state", this.state);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
