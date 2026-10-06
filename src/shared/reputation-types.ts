// What the rest of the app (lobby rows, overlay) gets to know about a player's reputation.
// The scoring itself lives in main/reputation.ts; this file is only types, so the renderer can import it.

export type ReputationTier = "TRUSTED" | "NORMAL" | "WATCH" | "SUSPICIOUS" | "VERY_SUSPICIOUS" | "BANNED" | "UNKNOWN";

export interface PlayerReputation {
  /** 0..100, 100 = nothing unusual found; null when there is no usable data. */
  score: number | null;
  tier: ReputationTier;
  /** 0..1: how much data stands behind the score. */
  confidence: number;
  /** The strongest findings, only for WATCH and worse (and the ban, for BANNED). */
  reasons: string[];
}
