import type { LobbyRow } from "../shared/types";
import { ClassBadge } from "./brand";

/** A player's class and recent-match count, or why there is none. */
export function PlayerClass({ r, compact }: { r: LobbyRow; compact?: boolean }) {
  if (r.status === "no-steam-id") return <span className="muted small" title="The game didn't report this player's Steam ID">No Steam ID</span>;
  if (r.status === "loading") return <span className="skeleton" aria-label="Looking up" />;
  if (r.status === "error" || !r.classification)
    return <span className="muted small" title={r.note ?? "No answer from Leetify yet, trying again"}>–</span>;
  return (
    <span className="class" title={r.classification === "INSUFFICIENT_DATA" ? r.note ?? undefined : undefined}>
      <ClassBadge value={r.classification} compact={compact} />
      {r.matchesAnalyzed > 0 && (
        <span className="matches" title={`Based on ${r.matchesAnalyzed} recent Leetify matches`}>{r.matchesAnalyzed}</span>
      )}
    </span>
  );
}

const RANK = { VERY_HIGH: 0, HIGH: 1, ELEVATED: 2 } as Record<string, number>;

/** Players with an extended card, highest class first, then highest score (the F7 view). */
export function flagged(rows: LobbyRow[]): LobbyRow[] {
  return rows
    .filter((r) => r.detail && !r.isLocal && r.classification && r.classification in RANK)
    .sort((a, b) => (RANK[a.classification!] - RANK[b.classification!]) || b.detail!.score - a.detail!.score);
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

