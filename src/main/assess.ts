// Turns a Leetify profile into NORMAL / ELEVATED / HIGH / VERY_HIGH.
//
// What this is: a performance-outlier score built from three things Leetify's public API gives per player:
//   - leetify_rating of the player's recent matches (how big and how steady the impact is),
//   - the profile's aim rating,
//   - the profile's clutch rating.
// What it is NOT: evidence of cheating. Leetify ratings measure how well someone plays, so top-rank players,
// pros and smurfs score high too. Nothing here looks at demos, so there is no wall-hack or aim-lock signal.
//
// The thresholds below are starting points, not calibrated against known cheaters. Run `npm run leetify:probe
// <steamid64>` to see a real profile's raw numbers next to what this computes, and tune THRESHOLDS.

import type { AxisLevel, EvidenceClass, PlayerDetail } from "../shared/types";
import type { LeetifyProfile, LeetifyRecentMatch } from "./leetify";

export const THRESHOLDS = {
  /** Newest matches that count; Leetify's own profile ratings cover about the last 30. */
  window: 30,
  /** Fewer scored matches than this is "not enough data". */
  minMatches: 10,
  /** Leetify rating per match, in the units Leetify's website shows (+5.0 is a very strong match). */
  rating: { mean: [0, 6], strongMatch: 3, strongShare: [0.2, 0.9] },
  /** Aim rating, 0-100. */
  aim: [55, 95],
  /** Clutch rating, website units. Noisy (few clutch situations per match), so it carries little weight. */
  clutch: [8, 30],
  /** Share of the combined score each signal carries. */
  weights: { rating: 0.5, aim: 0.35, clutch: 0.15 },
  /** Within the rating signal: weight of the average vs. how many matches were strong. */
  ratingMix: { mean: 0.7, share: 0.3 },
  /** A signal (0..1) counts as ELEVATED / HIGH / VERY_HIGH from these values... */
  signalTier: [0.45, 0.7, 0.88],
  /** ...and the combined score (0..1) from these. */
  scoreTier: [0.4, 0.62, 0.8],
} as const;

export interface Assessment {
  classification: EvidenceClass;
  /** Matches that went into the score (0 when there's no usable data). */
  matchesAnalyzed: number;
  name: string | null;
  /** Why there's no class, e.g. a private profile. */
  note: string | null;
  detail: PlayerDetail | null;
  /** The working, for `npm run leetify:probe`; null when there was no usable data. */
  trace: Trace | null;
}

export interface Trace {
  /** 100: the API sent fractions and they were turned into website units; 1: already website units. */
  scale: 1 | 100;
  meanRating: number;
  strongShare: number;
  clutch: number;
  /** Each signal 0..1, then the combined score 0..1. */
  signals: { rating: number; aim: number; clutch: number };
  score: number;
  tiers: { rating: number; aim: number; clutch: number };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ramp = (x: number, [lo, hi]: readonly [number, number]) => clamp01((x - lo) / (hi - lo));
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const tierOf = (v: number, cuts: readonly number[]) => cuts.filter((c) => v >= c).length;
const level = (tier: number): AxisLevel => (tier >= 2 ? "HIGH" : tier === 1 ? "MEDIUM" : "LOW");

/**
 * Leetify's website shows match ratings and the clutch rating as "+5.32"; the API may send that as 0.0532 (a
 * fraction) or as 5.32. Real matches span about -15..+15 in website units, so if any value is larger than 1 in
 * size the numbers are already in website units; fractions never get that large. Returns what to multiply by.
 * Not verified against the live API: `npm run leetify:probe` prints the raw values.
 */
export function ratingScale(values: number[]): 1 | 100 {
  return values.some((v) => Math.abs(v) > 1) ? 1 : 100;
}

export function assessProfile(p: LeetifyProfile): Assessment {
  const name = typeof p.name === "string" && p.name ? p.name : null;
  const none = (note: string): Assessment => ({ classification: "INSUFFICIENT_DATA", matchesAnalyzed: 0, name, note, detail: null, trace: null });

  if (p.privacy_mode === "private") return none("Private Leetify profile");

  const scored = (p.recent_matches ?? [])
    .filter((m): m is LeetifyRecentMatch & { leetify_rating: number } => !!m && num(m.leetify_rating))
    .sort((a, b) => Date.parse(b.finished_at ?? "") - Date.parse(a.finished_at ?? "") || 0)
    .slice(0, THRESHOLDS.window);
  const aim = p.rating?.aim;
  const clutchRaw = p.rating?.clutch;

  if (scored.length < THRESHOLDS.minMatches || !num(aim) || !num(clutchRaw))
    return { ...none(`Only ${scored.length} recent Leetify matches`), matchesAnalyzed: scored.length };

  const scale = ratingScale(scored.map((m) => m.leetify_rating));
  const ratings = scored.map((m) => m.leetify_rating * scale);
  const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  const strongShare = ratings.filter((r) => r >= THRESHOLDS.rating.strongMatch).length / ratings.length;
  const clutch = clutchRaw * scale;

  const T = THRESHOLDS;
  const signals = {
    rating: T.ratingMix.mean * ramp(mean, T.rating.mean) + T.ratingMix.share * ramp(strongShare, T.rating.strongShare),
    aim: ramp(aim, T.aim),
    clutch: ramp(clutch, T.clutch),
  };
  const score = T.weights.rating * signals.rating + T.weights.aim * signals.aim + T.weights.clutch * signals.clutch;

  const tiers = {
    rating: tierOf(signals.rating, T.signalTier),
    aim: tierOf(signals.aim, T.signalTier),
    clutch: tierOf(signals.clutch, T.signalTier),
  };
  const atLeast = (t: number) => Object.values(tiers).filter((x) => x >= t).length;

  // The score proposes a class; the signals have to agree with it. One strong number alone never flags a
  // player (a great aimer with an ordinary rating stays NORMAL), and VERY_HIGH needs both rating and aim.
  let cls = tierOf(score, T.scoreTier);
  if (cls >= 3 && !(tiers.rating >= 3 && tiers.aim >= 2)) cls = 2;
  if (cls >= 2 && atLeast(2) < 2) cls = 1;
  if (cls >= 1 && atLeast(1) < 2) cls = 0;
  const classification = (["NORMAL", "ELEVATED", "HIGH", "VERY_HIGH"] as const)[cls];

  const detail: PlayerDetail | null = cls === 0 ? null : {
    score: Math.round(score * 100),
    avgRating: round1(mean),
    strongShare: Math.round(strongShare * 100) / 100,
    aim: round1(aim),
    clutch: round1(clutch),
    levels: { rating: level(tiers.rating), aim: level(tiers.aim), clutch: level(tiers.clutch) },
    recent: scored.slice(0, 3).map((m) => ({ map: m.map_name ?? null, rating: round1(m.leetify_rating! * scale), playedAt: m.finished_at ?? null })),
  };
  const trace: Trace = { scale, meanRating: mean, strongShare, clutch, signals, score, tiers };
  return { classification, matchesAnalyzed: scored.length, name, note: null, detail, trace };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
