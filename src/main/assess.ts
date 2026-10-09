// Turns a Leetify profile into NORMAL / ELEVATED / HIGH / VERY_HIGH.
//
// What this is: a performance-outlier score built from three things Leetify's public API gives per player:
//   - the Leetify rating: the average of the newest matches' ratings and the share of strong matches when the
//     profile is public (recent_matches), else the overall rating (ranks.leetify), which private profiles have too,
//   - the aim rating (rating.aim),
//   - the clutch rating (rating.clutch).
// What it is NOT: evidence of cheating. These numbers measure how well someone plays, so top-rank players, pros and
// smurfs score high too. Nothing here looks at demos, so there is no wall-hack or aim-lock signal.
//
// Whatever the API sends is used: a missing signal is left out and the others are re-weighted, and a thin history
// (few matches) is discounted, never refused. Only a profile with no ratings at all has nothing to score.
//
// The cut-offs below are starting points, not calibrated against known cheaters. Run `npm run leetify:probe
// <steamid64>` to see a real profile's raw numbers next to what this computes, and tune THRESHOLDS.

import type { AxisLevel, EvidenceClass, MatchSummary, PlayerDetail, PlayerMetrics } from "../shared/types";
import type { LeetifyProfile } from "./leetify";
import { matchSeries } from "./matches";

export const THRESHOLDS = {
  /** Recent matches needed before they stand in for the overall Leetify rating. */
  minRecent: 5,
  /** Match rating in website units (+5.0 is a very strong match; the overall ranks.leetify uses the same scale). */
  rating: { mean: [0, 6], strongMatch: 3, strongShare: [0.2, 0.9], mix: { mean: 0.7, share: 0.3 } },
  /** Aim rating, 0-100. */
  aim: [55, 95],
  /** Clutch rating, as the API sends it (0.1 is a good clutcher). Noisy, so it carries little weight. */
  clutch: [0.08, 0.3],
  /** Share of the combined score each signal carries (a missing signal's share goes to the others). */
  weights: { rating: 0.5, aim: 0.35, clutch: 0.15 },
  /** Matches (the profile's total, else the recent ones) for full confidence; fewer discount the score. */
  fullSample: 50,
  /** A signal (0..1) counts as ELEVATED / HIGH / VERY_HIGH from these values... */
  signalTier: [0.45, 0.7, 0.88],
  /** ...and the combined score (0..1) from these. */
  scoreTier: [0.4, 0.62, 0.8],
} as const;

export interface Assessment {
  classification: EvidenceClass;
  /** The matches the profile covers (the recent ones when the total is unknown; 0 when unknown). */
  totalMatches: number;
  /** 0..1: how much data stands behind the score. */
  confidence: number;
  name: string | null;
  /** Why there's no class, e.g. the API sent no ratings. */
  note: string | null;
  /** The numbers behind the class; null only when there is nothing to score. */
  detail: PlayerDetail | null;
  /** The working, for `npm run leetify:probe`; null when there was nothing to score. */
  trace: Trace | null;
}

export interface Trace {
  /** Where the rating signal came from: the newest matches, the overall rating, or nowhere. */
  ratingFrom: "recent" | "overall" | null;
  /** Each signal 0..1 (null: the API sent nothing for it), the weighted score, and the score after discounting thin data. */
  signals: { rating: number | null; aim: number | null; clutch: number | null };
  score: number;
  discounted: number;
  tiers: { rating: number; aim: number; clutch: number };
  /** 1 or 100: what the match ratings were multiplied by to get website units. */
  scale: 1 | 100;
  /** Mean of the newest matches' ratings in website units. */
  meanRating: number;
  /** Share (0-1) of strong matches (rating >= THRESHOLDS.rating.strongMatch). */
  strongShare: number;
  /** The clutch rating from the profile, or null. */
  clutch: number | null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ramp = (x: number, [lo, hi]: readonly [number, number]) => clamp01((x - lo) / (hi - lo));
export const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const opt = (v: unknown): number | null => (num(v) ? v : null);
const tierOf = (v: number, cuts: readonly number[]) => cuts.filter((c) => v >= c).length;
const level = (tier: number): AxisLevel => (tier >= 2 ? "HIGH" : tier === 1 ? "MEDIUM" : "LOW");
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The overall Leetify rating: ranks.leetify. When a response lacks it, the mean of the CT and T ratings times 100,
 * which is what ranks.leetify turned out to be in real responses (6.55 against 0.0562 and 0.0743).
 */
function leetifyRating(p: LeetifyProfile): number | null {
  if (num(p.ranks?.leetify)) return p.ranks.leetify;
  const ct = p.rating?.ct_leetify, t = p.rating?.t_leetify;
  return num(ct) && num(t) ? ((ct + t) / 2) * 100 : null;
}

/** Leetify's numbers for the card, exactly as the API sent them. */
export function metricsOf(p: LeetifyProfile): PlayerMetrics {
  const st = p.stats ?? {};
  return {
    leetify: leetifyRating(p),
    aim: opt(p.rating?.aim), positioning: opt(p.rating?.positioning), utility: opt(p.rating?.utility),
    clutch: opt(p.rating?.clutch), opening: opt(p.rating?.opening),
    preaim: opt(st.preaim), reactionMs: opt(st.reaction_time_ms),
    headAccuracy: opt(st.accuracy_head), sprayAccuracy: opt(st.spray_accuracy),
    spottedAccuracy: opt(st.accuracy_enemy_spotted),
    counterStrafing: opt(st.counter_strafing_good_shots_ratio),
    ctOpeningDuel: opt(st.ct_opening_duel_success_percentage), tOpeningDuel: opt(st.t_opening_duel_success_percentage),
    premier: opt(p.ranks?.premier), totalMatches: opt(p.total_matches),
    winrate: opt(p.winrate),
  };
}

export function assessProfile(p: LeetifyProfile): Assessment {
  const T = THRESHOLDS;
  const name = typeof p.name === "string" && p.name ? p.name : null;
  // A private profile (or csst.at data) has no recent_matches but still carries the aggregates: the overall
  // rating (ranks.leetify) and the aim/clutch ratings. Those are scored; only a profile with no ratings at all
  // is refused (below). The missing match history just means the rating signal comes from ranks.leetify.
  const series = matchSeries(p);
  const recent = series.matches;
  const total = num(p.total_matches) ? p.total_matches : recent.length;
  const confidence = clamp01(total / T.fullSample);
  const noneWithTotal = (note: string): Assessment => ({ classification: "INSUFFICIENT_DATA", totalMatches: total, confidence: 0, name, note, detail: null, trace: null });

  const metrics = metricsOf(p);

  // What the newest matches say, for the card (any number of them) and for the rating signal (enough of them).
  let matches: MatchSummary | null = null;
  let recentSignal: number | null = null;
  if (recent.length > 0) {
    const ratings = recent.map((m) => m.rating);
    const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    const strongShare = ratings.filter((r) => r >= T.rating.strongMatch).length / ratings.length;
    matches = {
      count: recent.length, avgRating: round(avg, 1), strongShare: round(strongShare, 2),
      recent: recent.slice(0, 5).map((m) => ({ map: m.map, rating: round(m.rating, 1), playedAt: m.playedAt })),
    };
    if (recent.length >= T.minRecent)
      recentSignal = T.rating.mix.mean * ramp(avg, T.rating.mean) + T.rating.mix.share * ramp(strongShare, T.rating.strongShare);
  }

  const signals = {
    rating: recentSignal ?? (metrics.leetify !== null ? ramp(metrics.leetify, T.rating.mean) : null),
    aim: metrics.aim !== null ? ramp(metrics.aim, T.aim) : null,
    clutch: metrics.clutch !== null ? ramp(metrics.clutch, T.clutch) : null,
  };
  const present = (["rating", "aim", "clutch"] as const).filter((k) => signals[k] !== null);
  if (present.length === 0) return noneWithTotal("Leetify sent no ratings for this player");

  const weightSum = present.reduce((a, k) => a + T.weights[k], 0);
  const score = present.reduce((a, k) => a + T.weights[k] * signals[k]!, 0) / weightSum;
  // Few matches mean noisy numbers: discount the score rather than refuse to give one.
  const discounted = score * (0.5 + 0.5 * confidence);

  const tiers = {
    rating: signals.rating === null ? 0 : tierOf(signals.rating, T.signalTier),
    aim: signals.aim === null ? 0 : tierOf(signals.aim, T.signalTier),
    clutch: signals.clutch === null ? 0 : tierOf(signals.clutch, T.signalTier),
  };
  const atLeast = (t: number) => Object.values(tiers).filter((x) => x >= t).length;

  // The score proposes a class; the signals have to agree with it. One strong number alone never flags a
  // player (a great aimer with an ordinary rating stays NORMAL), and VERY_HIGH needs both rating and aim.
  let cls = tierOf(discounted, T.scoreTier);
  if (cls >= 3 && !(tiers.rating >= 3 && tiers.aim >= 2)) cls = 2;
  if (cls >= 2 && atLeast(2) < 2) cls = 1;
  if (cls >= 1 && atLeast(1) < 2) cls = 0;
  const classification = (["NORMAL", "ELEVATED", "HIGH", "VERY_HIGH"] as const)[cls];

  // Every player with ratings gets a card (F6 shows any player, F7 the flagged ones).
  const detail: PlayerDetail = {
    score: Math.round(discounted * 100),
    levels: { rating: level(tiers.rating), aim: level(tiers.aim), clutch: level(tiers.clutch) },
    metrics,
    matches,
  };
  return {
    classification, totalMatches: total, confidence, name, note: null, detail,
    trace: { ratingFrom: recentSignal !== null ? "recent" : signals.rating !== null ? "overall" : null, signals, score, discounted, tiers, scale: series.scales.rating, meanRating: matches?.avgRating ?? 0, strongShare: matches?.strongShare ?? 0, clutch: metrics.clutch },
  };
}
