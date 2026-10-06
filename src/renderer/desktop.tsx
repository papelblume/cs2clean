import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_HOTKEYS, hotkeyFromEvent, type HotkeyName } from "../shared/hotkeys";
import type { AppState, LobbyRow } from "../shared/types";
import { bridge } from "./bridge";
import { DISCLAIMER, Logo, mapName, SideEmblem, Wordmark } from "./brand";
import { PlayerClass } from "./parts";
import { useAppState } from "./useAppState";
import "./style.css";

function App() {
  const s = useAppState();
  if (!s) return null;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><Logo size={26} /><Wordmark /></div>
        <LeetifyDot s={s} />
      </header>
      <main className="content">
        {s.notice && <p className="notice">{s.notice}</p>}
        <KeyCard s={s} />
        <MatchCard s={s} />
      </main>
      <footer className="footer">
        <p>{DISCLAIMER}</p>
        <SettingsPanel s={s} />
      </footer>
    </div>
  );
}

function LeetifyDot({ s }: { s: AppState }) {
  const [tone, label] = s.leetify.reachable === null ? ["pending", "Leetify"]
    : s.leetify.reachable ? ["ok", "Leetify online"] : ["bad", "Leetify unreachable"];
  return (
    <span className={`server-dot server-${tone}`} title="Player data comes from Leetify's public API">
      <span className="dot" />{label}
    </span>
  );
}

// ------------------------------------------------------------------ API key

function KeyCard({ s }: { s: AppState }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (await bridge.setApiKey(key)) setKey("");
    } finally {
      setBusy(false);
    }
  };
  if (s.leetify.hasKey)
    return (
      <section className="card account">
        <div className="account-text">
          <strong>Leetify API key</strong>
          <span className="muted small">Saved. Used for every player lookup.</span>
        </div>
        <button className="button quiet small-button" onClick={() => bridge.clearApiKey()}>Remove</button>
      </section>
    );
  return (
    <section className="card">
      <h2>Leetify API key</h2>
      <p className="small">
        Player classes come from Leetify's public API. It works without a key at stricter rate limits; a free key
        from <b>leetify.com/app/developer</b> makes lookups reliable.
      </p>
      <div className="row">
        <input
          className="key-input" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your API key"
          value={key} onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && key.trim() && !busy && void save()}
        />
        <button className="button primary" disabled={!key.trim() || busy} onClick={() => void save()}>
          {busy ? "Checking…" : "Save key"}
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ match

function MatchCard({ s }: { s: AppState }) {
  const rows = s.lobby.rows;
  const title = s.match ? [mapName(s.match.map), modeName(s.match.mode)].filter(Boolean).join(" · ") || "Your match" : "Your match";
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {s.game.source === "replay" && <span className="tag" title="Playing a recorded session, not live data">Replay</span>}
      </div>
      {s.game.problem && <p className="problem small">{s.game.problem}</p>}
      {rows.length > 0 ? (
        <>
          {s.lobby.error && <p className="error small">{s.lobby.error}</p>}
          <LobbyTable rows={rows} />
          <p className="muted small hint">
            {s.overlay.mode === "none" ? null : (
              <>In game, <kbd>{s.overlay.hotkey}</kbd> shows this list, <kbd>{s.overlay.detailHotkey}</kbd> the details
                of flagged players and <kbd>{s.overlay.cycleHotkey}</kbd> steps through every player's details.
                The overlay hides itself when the match goes live.</>
            )}
            {s.overlay.mode === "window" && (
              <button className="linkish" onClick={() => bridge.toggleOverlay()}>
                {s.overlay.visible ? "Hide overlay" : "Show overlay"}
              </button>
            )}
          </p>
          {s.game.source === "steam" && (
            <p className="muted small">
              Players come from Steam's list of people you recently played with, so teams aren't known.
            </p>
          )}
        </>
      ) : !s.game.problem ? (
        <div className="empty">
          <span className={s.game.running ? "pulse" : "idle"} />
          <p className="muted">
            {s.game.running ? "CS2 is running. The players appear here when a match loads." : "Waiting for CS2 to start."}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function LobbyTable({ rows }: { rows: LobbyRow[] }) {
  const teams: [string, LobbyRow[]][] = [
    ["Counter-Terrorists", rows.filter((r) => r.side === "CT")],
    ["Terrorists", rows.filter((r) => r.side === "T")],
    [rows.some((r) => r.side) ? "Other" : "Players", rows.filter((r) => !r.side)],
  ];
  return (
    <div className="lobby">
      {teams.filter(([, list]) => list.length).map(([label, list]) => (
        <div key={label} className="team">
          <div className="team-label">{label}</div>
          {list.map((r) => <LobbyLine key={r.slot} r={r} />)}
        </div>
      ))}
    </div>
  );
}

function LobbyLine({ r }: { r: LobbyRow }) {
  return (
    <div className={`player${r.isLocal ? " is-local" : ""}`}>
      <SideEmblem side={r.side} />
      <button className="player-name" disabled={!r.steamId} title={r.steamId ? "Open on Leetify" : undefined}
        onClick={() => r.steamId && bridge.openPlayer(r.steamId)}>
        {r.name}{r.isLocal && <span className="you">you</span>}
      </button>
      <PlayerClass r={r} />
    </div>
  );
}

const modeName = (m: string | null) => (m ? m.charAt(0).toUpperCase() + m.slice(1).replace(/_/g, " ") : null);

// ------------------------------------------------------------------ settings

function SettingsPanel({ s }: { s: AppState }) {
  const isDefault = s.overlay.hotkey === DEFAULT_HOTKEYS.lobby && s.overlay.detailHotkey === DEFAULT_HOTKEYS.detail
    && s.overlay.cycleHotkey === DEFAULT_HOTKEYS.cycle;
  return (
    <details className="settings">
      <summary>Settings</summary>
      {s.hotkeysEditable && (
        <>
          <div className="hotkeys small">
            <HotkeyField label="Show the player list" which="lobby" value={s.overlay.hotkey} />
            <HotkeyField label="Show details of flagged players" which="detail" value={s.overlay.detailHotkey} />
            <HotkeyField label="Cycle through all players' details" which="cycle" value={s.overlay.cycleHotkey} />
          </div>
          <div className="row small">
            <span className="muted">Click a key, then press the new one. While the app runs, CS2 doesn't get these keys.</span>
            {!isDefault && <button className="button quiet small-button" onClick={() => bridge.resetHotkeys()}>Reset</button>}
          </div>
        </>
      )}
      {s.startWithWindows !== null && (
        <label className="check small">
          <input type="checkbox" checked={s.startWithWindows} onChange={(e) => bridge.setStartWithWindows(e.target.checked)} />
          Start automatically with Windows, minimized
        </label>
      )}
      <div className="row small">
        <label className="check">
          <input type="checkbox" checked={s.overlay.siren} onChange={(e) => bridge.setSiren(e.target.checked)} />
          Siren when a High or Very high player is in my match
        </label>
        <button className="button quiet small-button" onClick={() => bridge.testSiren()}>Test</button>
      </div>
      {s.overlay.mode === "window" && (
        <p className="muted small">
          The overlay sits on top of CS2 when the game's display mode is <b>Fullscreen Windowed</b> (Settings, Video).
          In plain Fullscreen, Windows draws the game over it.
        </p>
      )}
      <p className="muted small">Version {s.version}.</p>
    </details>
  );
}

/** A hotkey button: click it, then press the new key combination (Esc cancels). */
function HotkeyField({ label, which, value }: { label: string; which: HotkeyName; value: string }) {
  const [listening, setListening] = useState(false);
  const stop = () => {
    setListening(false);
    void bridge.pauseHotkeys(false);
  };
  return (
    <div className="hotkey-row">
      <span>{label}</span>
      <button
        className={`hotkey-button${listening ? " listening" : ""}`}
        onClick={() => {
          if (listening) return stop();
          setListening(true);
          void bridge.pauseHotkeys(true);
        }}
        onBlur={() => listening && stop()}
        onKeyDown={(e) => {
          if (!listening) return;
          e.preventDefault();
          if (e.key === "Escape") return stop();
          const hotkey = hotkeyFromEvent(e);
          if (!hotkey) return; // only modifiers so far, or a key we don't offer
          setListening(false);
          // Re-registers the hotkeys: the new pair if it's usable, the old pair if not.
          void bridge.setHotkey(which, hotkey);
        }}
      >
        {listening ? "Press a key…" : <kbd>{value}</kbd>}
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
