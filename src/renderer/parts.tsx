import type { LobbyRow } from "../shared/types";
import { ClassBadge } from "./brand";

/** A player's class and reputation score, or why there is none. */
export function PlayerClass({ r, compact }: { r: LobbyRow; compact?: boolean }) {
  if (r.status === "no-steam-id") return <span className="muted small" title="The game didn't report this player's Steam ID">No Steam ID</span>;
  if (r.status === "skipped") return <span className="muted small" title={r.note ?? undefined}>Not checked</span>;
  if (r.status === "loading") return <span className="skeleton" aria-label="Looking up" />;
  if (r.status === "error" || !r.classification)
    return <span className="muted small" title={r.note ?? "No answer from Leetify yet, trying again"}>–</span>;
  const score = r.reputation?.score;
  const thin = (r.reputation?.confidence ?? 1) < 0.5;
  return (
    <span className="class" title={r.note ?? undefined}>
      <ClassBadge value={r.classification} compact={compact} />
      {score != null && (
        <span className={`matches${thin ? " low" : ""}`}
          title={`Reputation ${score} / 100: how plausible the stats look for this player (100 = nothing unusual).${thin ? " Little data behind it." : ""} Statistics, not proof of anything.`}>{score}</span>
      )}
    </span>
  );
}

const RANK = { VERY_HIGH: 0, HIGH: 1, ELEVATED: 2 } as Record<string, number>;

/** How flagged a player is, 0-100: the higher of the performance score and how low the reputation is. */
function strength(r: LobbyRow): number {
  return Math.max(r.detail?.score ?? 0, r.reputation?.score != null ? 100 - r.reputation.score : 0);
}

/**
 * Players the F7 view lists: everyone whose class is ELEVATED or above (whatever raised it, ratings or
 * reputation, a ban included), highest class first, then the most flagged. Excludes yourself.
 */
export function flagged(rows: LobbyRow[]): LobbyRow[] {
  return rows
    .filter((r) => !r.isLocal && r.classification && r.classification in RANK)
    .sort((a, b) => (RANK[a.classification!] - RANK[b.classification!]) || strength(b) - strength(a));
}

/** "3 days ago" for a match date. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "date unknown";
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}


/** A Leetify number for display: as the API sent it, only rounded; "–" when the API sent none. */
export function show(v: number | null | undefined, digits = 0, unit = ""): string {
  return v == null ? "–" : `${v.toFixed(digits)}${unit}`;
}

/** Clutch rating for display: multiply by 100, show as "+N.N". */
export function clutchDisplay(v: number | null | undefined): string {
  if (v == null) return "–";
  return `+${(v * 100).toFixed(1)}`;
}

/** Leetify rating for display: show with +/- prefix, e.g. "+3.54" or "-1.55". */
export function ratingDisplay(v: number | null | undefined, digits = 2): string {
  if (v == null) return "–";
  const abs = Math.abs(v).toFixed(digits);
  return v >= 0 ? `+${abs}` : `-${abs}`;
}

/** Axis level for Time to Damage (ms, lower is better). */
export function ttdLevel(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms <= 380) return "HIGH";
  if (ms <= 420) return "MEDIUM";
  return "LOW";
}

/** Axis level for Crosshair Placement (degrees, lower is tighter). */
export function cspLevel(deg: number | null | undefined): string {
  if (deg == null) return "";
  if (deg <= 3.0) return "HIGH";
  if (deg <= 4.5) return "MEDIUM";
  return "LOW";
}

/** Axis level for Headshot Accuracy (%). */
export function hsAccuracyLevel(pct: number | null | undefined): string {
  if (pct == null) return "";
  if (pct >= 25) return "HIGH";
  if (pct >= 20) return "MEDIUM";
  return "LOW";
}

/** Axis level for Spray Accuracy (%). */
export function sprayAccuracyLevel(pct: number | null | undefined): string {
  if (pct == null) return "";
  if (pct >= 43) return "HIGH";
  if (pct >= 38) return "MEDIUM";
  return "LOW";
}

/** Axis level for Spotted Accuracy (%). */
export function spottedAccuracyLevel(pct: number | null | undefined): string {
  if (pct == null) return "";
  if (pct >= 42) return "HIGH";
  if (pct >= 35) return "MEDIUM";
  return "LOW";
}

/** Win rate for display: multiply by 100, round to nearest integer, show as "XX%". */
export function winrateDisplay(v: number | null | undefined): string {
  if (v == null) return "–";
  return `${Math.round(v * 100)}%`;
}
