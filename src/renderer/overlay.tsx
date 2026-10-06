// The in-game overlay: a compact, display-only window over CS2. Mouse and keyboard go straight through to
// the game. Shift+F2 shows the lobby list, F7 the cards of flagged players, F6 steps through every player's
// card, one at a time. It shows itself in warm-up, hides when the match goes live, and plays a siren when a
// HIGH or VERY_HIGH player is found.

import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { cycleOrder } from "../shared/lobby-order";
import type { AppState, AxisLevel, LobbyRow } from "../shared/types";
import { ClassBadge, Logo, mapName, SideEmblem, TIER_LABELS, Wordmark } from "./brand";
import { ago, flagged, PlayerClass } from "./parts";
import { playSiren } from "./siren";
import { useAppState } from "./useAppState";
import "./style.css";

function Overlay() {
  const s = useAppState();
  useSiren(s);
  if (!s) return null;
  const o = s.overlay;
  const order = cycleOrder(s.lobby.rows);
  const at = order.findIndex((r) => r.slot === o.focusSlot);
  return (
    <div className="ov">
      <header className="ov-head">
        <Logo size={18} />
        <strong>{mapName(s.match?.map) ?? "Lobby"}</strong>
        <span className="ov-count">
          {o.view === "detail" ? "Flagged players" : o.view === "player" ? (at >= 0 ? `Player ${at + 1} of ${order.length}` : "Players") : countLine(s)}
        </span>
      </header>
      {o.view === "detail" ? <Detail s={s} /> : o.view === "player" ? <PlayerView s={s} /> : <Body s={s} />}
      <footer className="ov-foot">
        <span>
          {o.view === "detail"
            ? <><kbd>{o.detailHotkey}</kbd> hide · <kbd>{o.hotkey}</kbd> list · <kbd>{o.cycleHotkey}</kbd> players</>
            : o.view === "player"
              ? <><kbd>{o.cycleHotkey}</kbd> {at >= 0 && at < order.length - 1 ? "next" : "hide"} · <kbd>{o.hotkey}</kbd> list</>
              : <><kbd>{o.hotkey}</kbd> hide · <kbd>{o.detailHotkey}</kbd> flagged · <kbd>{o.cycleHotkey}</kbd> players</>}
        </span>
        <Wordmark />
      </footer>
    </div>
  );
}

/** Plays the siren each time the app raises a new alert (a HIGH player found in this match). */
function useSiren(s: AppState | null) {
  const seen = useRef<number | null>(null);
  const seq = s?.alert.seq ?? null;
  useEffect(() => {
    if (seq === null) return;
    if (seen.current !== null && seq > seen.current) playSiren();
    seen.current = seq;
  }, [seq]);
}

function Body({ s }: { s: AppState }) {
  if (s.lobby.rows.length === 0) return <p className="ov-msg">The players appear here when the match loads.</p>;
  const ct = s.lobby.rows.filter((r) => r.side === "CT");
  const t = s.lobby.rows.filter((r) => r.side === "T");
  const other = s.lobby.rows.filter((r) => !r.side);
  return (
    <div className="ov-list">
      {[ct, t, other].filter((l) => l.length).map((list, i) => (
        <div key={i} className="ov-team">{list.map((r) => <Line key={r.slot} r={r} />)}</div>
      ))}
      {s.lobby.error && <p className="ov-msg ov-error">{s.lobby.error}</p>}
      {s.game.problem && <p className="ov-msg ov-note">{s.game.problem}</p>}
    </div>
  );
}

function Line({ r }: { r: LobbyRow }) {
  return (
    <div className={`ov-row${r.isLocal ? " is-local" : ""}`}>
      <SideEmblem side={r.side} size={14} />
      <span className="ov-name">{r.name}</span>
      <PlayerClass r={r} compact />
    </div>
  );
}

// ------------------------------------------------------------------ F7 and F6: player cards

/** F7: the flagged players. */
function Detail({ s }: { s: AppState }) {
  const list = flagged(s.lobby.rows);
  if (list.length === 0)
    return <p className="ov-msg">{s.lobby.rows.length ? "No flagged players in this match." : "The players appear here when the match loads."}</p>;
  return (
    <div className="ov-cards">
      {list.slice(0, 2).map((r) => <Card key={r.slot} r={r} compact />)}
      {list.length > 2 && <p className="ov-msg">+{list.length - 2} more flagged player{list.length > 3 ? "s" : ""}</p>}
    </div>
  );
}

/** F6: one player at a time, flagged or not. */
function PlayerView({ s }: { s: AppState }) {
  const order = cycleOrder(s.lobby.rows);
  if (order.length === 0) return <p className="ov-msg">The players appear here when the match loads.</p>;
  const r = order.find((p) => p.slot === s.overlay.focusSlot);
  return r ? <div className="ov-cards"><Card r={r} /></div> : <p className="ov-msg">Press the key again to start with the first player.</p>;
}

const AXES: [keyof NonNullable<LobbyRow["detail"]>["levels"], string][] = [
  ["rating", "Match rating"],
  ["aim", "Aim"],
  ["clutch", "Clutch"],
];

/** Why a player has no numbers. */
function missingText(r: LobbyRow): string {
  if (r.status === "no-steam-id") return "The game didn't report this player's Steam ID.";
  if (r.status === "loading") return "Looking this player up on Leetify…";
  return r.note ?? (r.status === "error" ? "No answer from Leetify yet, trying again." : "Not enough Leetify data.");
}

/** A player's card. `compact` leaves out the latest matches (the F7 view can show two cards at once). */
function Card({ r, compact }: { r: LobbyRow; compact?: boolean }) {
  const d = r.detail;
  const rep = r.reputation && r.reputation.score !== null ? r.reputation : null;
  return (
    <section className={`ov-card${r.classification ? ` tone-${r.classification.toLowerCase()}` : ""}`}>
      <div className="ov-card-head">
        <span className="ov-name">{r.name}</span>
        {r.classification && r.classification !== "INSUFFICIENT_DATA" && <ClassBadge value={r.classification} compact />}
      </div>
      {!d && !rep && <p className="ov-card-note">{missingText(r)}</p>}
      {(rep || d) && (
        <dl className="ov-scores">
          {rep && (
            <>
              <dt title={`How plausible the stats look for this player's rank (100 = nothing unusual). Confidence ${Math.round(rep.confidence * 100)}%. Statistics, not a probability of cheating.`}>Reputation</dt>
              <dd><b>{rep.score}</b> / 100 <span className="muted">{TIER_LABELS[rep.tier]}</span></dd>
            </>
          )}
          {d && (
            <>
              <dt title="How far above average the Leetify ratings are. Not a probability of cheating.">Performance</dt>
              <dd><b>{d.score}</b> / 100</dd>
            </>
          )}
        </dl>
      )}
      {rep && rep.reasons.length > 0 && (
        <ul className="ov-reasons">{rep.reasons.map((t, i) => <li key={i}>{t}</li>)}</ul>
      )}
      {d && (
        <dl className="ov-facts">
          <dt>Recent matches</dt><dd>{r.matchesAnalyzed}</dd>
          <dt>Avg match rating</dt><dd>{fmtSigned(d.avgRating)}</dd>
          <dt>Strong matches</dt><dd>{Math.round(d.strongShare * 100)}%</dd>
          <dt>Aim / clutch</dt><dd>{d.aim} / {fmtSigned(d.clutch)}</dd>
          {AXES.map(([k, label]) => (
            <FactLevel key={k} label={label} level={d.levels[k]} />
          ))}
        </dl>
      )}
      {d && !compact && d.recent.length > 0 && (
        <>
          <div className="ov-sub">Latest matches</div>
          <div className="ov-recent">
            {d.recent.map((m, i) => (
              <div key={i} className="ov-recent-row">
                <span>{mapName(m.map) ?? "Unknown map"}</span>
                <span>{fmtSigned(m.rating)}</span>
                <span className="muted">{ago(m.playedAt)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function FactLevel({ label, level }: { label: string; level: AxisLevel }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={`lvl lvl-${level.toLowerCase()}`}>{level}</dd>
    </>
  );
}

const fmtSigned = (n: number) => (n > 0 ? `+${n}` : String(n));

function countLine(s: AppState): string {
  const known = s.lobby.rows.filter((r) => r.status === "ok" && r.classification && r.classification !== "INSUFFICIENT_DATA").length;
  return s.lobby.rows.length ? `${known} of ${s.lobby.rows.length} known` : "";
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Overlay />
    </StrictMode>,
  );
