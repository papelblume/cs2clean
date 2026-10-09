// The in-game overlay: a compact, display-only window over CS2. Mouse and keyboard go straight through to
// the game. Shift+F2 shows the lobby list, F7 the cards of flagged players, F6 steps through every player's
// card (yours too), one at a time; Shift+F6 steps backward. It shows itself in warm-up, hides when the match
// goes live, and plays a siren when a HIGH or VERY_HIGH player is found.

import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { listOrder, visibleOrder } from "../shared/lobby-order";
import type { AppState, AxisLevel, LobbyRow } from "../shared/types";
import { ClassBadge, Logo, mapName, SideEmblem, TIER_LABELS, Wordmark } from "./brand";
import { ago, clutchDisplay, cspLevel, flagged, hsAccuracyLevel, PlayerClass, ratingDisplay, show, sprayAccuracyLevel, spottedAccuracyLevel, ttdLevel, winrateDisplay } from "./parts";
import { playSiren } from "./siren";
import { useAppState } from "./useAppState";
import "./style.css";

function Overlay() {
  const s = useAppState();
  useSiren(s);
  if (!s) return null;
  const o = s.overlay;
  const order = listOrder(s.lobby.rows);
  const cycle = visibleOrder(s.lobby.rows);
  const at = cycle.findIndex((r) => r.slot === o.focusSlot);
  return (
    <div className="ov">
      <header className="ov-head">
        <Logo size={18} />
        <strong>{mapName(s.match?.map) ?? "Lobby"}</strong>
        <span className="ov-count">
          {o.view === "detail" ? "Flagged players" : o.view === "player" ? (at >= 0 ? `Player ${at + 1} of ${cycle.length}` : "Players") : countLine(s)}
        </span>
      </header>
      {o.view === "detail" ? <Detail s={s} /> : o.view === "player" ? <PlayerView s={s} /> : <Body s={s} />}
      <footer className="ov-foot">
        <span>
          {o.view === "detail"
            ? <><kbd>{o.detailHotkey}</kbd> hide · <kbd>{o.hotkey}</kbd> list · <kbd>{o.cycleHotkey}</kbd> players</>
            : o.view === "player"
              ? <><kbd>{o.previousHotkey}</kbd> {at > 0 ? "back" : "hide"} · <kbd>{o.cycleHotkey}</kbd> {at >= 0 && at < order.length - 1 ? "next" : "hide"} · <kbd>{o.hotkey}</kbd> list</>
              : <><kbd>{o.hotkey}</kbd> hide · <kbd>{o.detailHotkey}</kbd> flagged · <kbd>{o.cycleHotkey}</kbd> players</>}
        </span>
        <Wordmark />
        <span className="ov-credit">Data Provided by Leetify</span>
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
  const cycle = visibleOrder(s.lobby.rows);
  if (cycle.length === 0) return <p className="ov-msg">The players appear here when the match loads.</p>;
  const r = cycle.find((p) => p.slot === s.overlay.focusSlot);
  return r ? <div className="ov-cards"><Card r={r} /></div> : <p className="ov-msg">Press the key again to start with the first player.</p>;
}

/** Why a player has no numbers. */
function missingText(r: LobbyRow): string {
  if (r.status === "no-steam-id") return "The game didn't report this player's Steam ID.";
  if (r.status === "skipped") return r.note ?? "Not checked.";
  if (r.status === "loading") return "Looking this player up on Leetify…";
  return r.note ?? (r.status === "error" ? "No answer from Leetify yet, trying again." : "Not enough Leetify data.");
}

/** One line of the facts: a label, a value, and for the three performance signals a colour-coded level. */
function Fact({ label, value, level, muted }: { label: string; value: string; level?: AxisLevel; muted?: boolean }) {
  // Don't show the "Low" tier label; only show for Medium and above.
  const showLevel = level && level !== "LOW";
  return (
    <>
      <dt>{label}</dt>
      <dd className={muted ? "muted" : undefined}>
        {value}{showLevel && <> <span className={`lvl lvl-${level!.toLowerCase()}`}>{level}</span></>}
      </dd>
    </>
  );
}

/**
 * A player's card. The Leetify numbers are shown as the API sends them, under Leetify's own names; the two scores
 * at the top, the match summary (average, strong matches, latest) and the LOW / MEDIUM / HIGH levels are this app's.
 * The match rows appear when the profile is public; without them the card is built from the aggregates alone.
 * `compact` shows fewer rows (the F7 view can show two cards at once).
 */
function Card({ r, compact }: { r: LobbyRow; compact?: boolean }) {
  const d = r.detail, m = d?.metrics ?? null, matches = d?.matches ?? null;
  const rep = r.reputation && r.reputation.score !== null ? r.reputation : null;
  return (
    <section className={`ov-card${r.classification ? ` tone-${r.classification.toLowerCase()}` : ""}`}>
      <div className="ov-card-head">
        <span className="ov-name">{r.name}{r.isLocal && <span className="you"> (you)</span>}</span>
        {r.classification && r.classification !== "INSUFFICIENT_DATA" && <ClassBadge value={r.classification} compact />}
      </div>
      {!d && !rep && <p className="ov-card-note">{missingText(r)}</p>}
      {(rep || d) && (
        <dl className="ov-scores">
          {rep && (
            <>
              <dt title={`How plausible the stats look for this player's rank (100 = nothing unusual). Confidence ${Math.round(rep.confidence * 100)}%. Statistics, not a probability of cheating.`}>Reputation</dt>
              <dd>
                <b>{rep.score}</b> / 100 <span className="muted">{TIER_LABELS[rep.tier]}{rep.confidence < 0.5 ? " · little data" : ""}</span>
              </dd>
            </>
          )}
          {d && (
            <>
              <dt title="How far above average the Leetify rating, aim and clutch are. Not a probability of cheating.">Performance</dt>
              <dd><b>{d.score}</b> / 100</dd>
            </>
          )}
        </dl>
      )}
      {rep && rep.reasons.length > 0 && (
        <ul className="ov-reasons">{rep.reasons.slice(0, compact ? 2 : 3).map((t, i) => <li key={i}>{t}</li>)}</ul>
      )}
      {d && m && (
        <dl className="ov-facts">
          {matches && (
            <>
              <Fact label="Avg match rating" value={show(matches.avgRating, 1)} />
              <Fact label="Strong matches (5.0+ rating)" value={`${Math.round(matches.strongShare * 100)}%`} />
            </>
          )}
          <Fact label="Leetify rating" value={ratingDisplay(m.leetify)} level={d.levels.rating} />
          <Fact label="Aim" value={show(m.aim)} level={d.levels.aim} />
          <Fact label="Clutch" value={clutchDisplay(m.clutch)} level={d.levels.clutch} />
          {!compact && <><Fact label="Positioning" value={show(m.positioning)} /><Fact label="Utility" value={show(m.utility)} /></>}
          <Fact label="Headshot accuracy" value={show(m.headAccuracy, 1, "%")} level={hsAccuracyLevel(m.headAccuracy) as any} />
          <Fact label="Spray accuracy" value={show(m.sprayAccuracy, 1, "%")} level={sprayAccuracyLevel(m.sprayAccuracy) as any} />
          <Fact label="Spotted accuracy" value={show(m.spottedAccuracy, 1, "%")} level={spottedAccuracyLevel(m.spottedAccuracy) as any} />
          <Fact label="Time to damage" value={show(m.reactionMs, 0, " ms")} level={ttdLevel(m.reactionMs) as any} />
          <Fact label="Preaim" value={show(m.preaim, 1, "°")} level={cspLevel(m.preaim) as any} />
          {!compact && <Fact label="Leetify matches" value={show(m.totalMatches)} />}
        </dl>
      )}
      {m && matches && matches.recent.length > 0 && (
        <>
          <div className="ov-sub">Latest matches <span className="ov-winrate">{winrateDisplay(m.winrate)}</span></div>
          <div className="ov-recent">
            {matches.recent.slice(0, compact ? 2 : 5).map((x, i) => (
              <div key={i} className="ov-recent-row">
                <span>{mapName(x.map) ?? "Unknown map"}</span>
                <span>{show(x.rating, 1)}</span>
                <span className="muted">{ago(x.playedAt)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

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
