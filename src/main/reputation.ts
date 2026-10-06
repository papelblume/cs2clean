// Turns a Leetify profile into a 0-100 reputation score (100 = nothing unusual) and a tier, with reasons.
//
// assess.ts asks "how far above average does this player perform?". This file asks a different question:
// "how implausible do the numbers look, given the player's skill and rank?". Skill alone never lowers the score;
// the evidence is mechanics that sit in the extreme tail for the rank band, stats that contradict each other,
// and sudden or unnaturally steady changes over the last matches.
//
// What this is NOT: proof of anything. A ban on record is the only hard evidence; everything else is statistics
// over public aggregates, which cannot see a careful cheater. The constants below are PLACEHOLDERS, not
// calibrated against known cheaters; fix them with `npm run leetify:probe` output and, better, with profiles
// that later turned out to carry a ban (compare their matches before `banned_since` with everyone else's).
//
// Shape of the computation:
//   1. A ban on record decides everything (tier BANNED, score 0).
//   2. Each signal turns one observation into 0..1 "implausibility" (0 = ordinary, 1 = extreme tail).
//   3. Signals are grouped into families (mechanics, coherence, trajectory). A family's score is the mean of its
//      strongest signals, so one odd number does little but two agreeing ones count.
//   4. Families are combined noisy-OR style, each with a cap, so no single family can condemn a player alone.
//   5. Thin profiles (few matches) add a little, too little data in the window takes some back, and the tier is
//      gated: the worst tiers need at least two active families.

import type { PlayerReputation, ReputationTier } from "../shared/reputation-types";
import type { EvidenceClass } from "../shared/types";
import { ratingScale } from "./assess";
import type { LeetifyBan, LeetifyProfile, LeetifyRecentMatch } from "./leetify";

export const REPUTATION = {
  /** Newest matches that count, same as assess.ts. */
  window: 30,
  /** Fewer scored matches than this is UNKNOWN. */
  minMatches: 0,
  /** Matches for full confidence; confidence ramps from minMatches to here. */
  fullSample: 20,
  /** TRUSTED (as opposed to NORMAL) needs at least this much confidence. */
  trustedConfidence: 0.7,
  /** A family below this (0..1) contributes nothing, so many faint signals don't add up to an accusation. */
  deadZone: 0.25,
  /** Largest share of suspicion a family can produce on its own. */
  familyCap: { mechanics: 0.6, coherence: 0.4, trajectory: 0.5 },
  /** How many of a family's strongest signals are averaged (missing ones count as 0). */
  familyTop: { mechanics: 2, coherence: 1, trajectory: 2 },
  /** Adjusted family score from which a family counts as active in the tier gates. */
  activeAt: { veryTier: 0.5, suspiciousTier: 0.35 },
  /** Fewer lifetime matches than matches[0] (full effect at matches[1]) boosts suspicion by up to `boost`. */
  thinProfile: { matches: [150, 30], boost: 0.25 },
  /** Lowest score of each tier. */
  tiers: { trusted: 85, normal: 65, watch: 45, suspicious: 25 },
  /**
   * Absolute mechanics improve with rank, so a "tight" value means more in a low band. Premier rating maps to
   * -0.5..+0.5 around mid-band (none known: 0); the endpoints below move by that much times these amounts.
   */
  band: { premierMax: 30000, preaimDeg: 3, reactionMs: 60, accuracyPts: 6, openingPts: 5 },
  /** [starts to look odd, extreme]. Preaim in degrees, reaction in ms, the rest in percent. */
  mechanics: {
    preaim: [8, 4], reaction: [480, 330], headAcc: [25, 45], sprayAcc: [45, 65],
    opening: [55, 70], stopping: [90, 99],
  },
  coherence: {
    /** Only a high aim rating can be lopsided in a way that matters... */
    aimGate: [65, 85],
    /** ...and aim minus the mean of positioning and utility, in rating points. */
    aimLead: [25, 50],
    /** High headshot accuracy while this many percent of shots are NOT taken standing still. */
    movingHeadAcc: [25, 40], notStopped: [30, 50],
  },
  trajectory: {
    /** Window of "newest" matches compared with the rest, and the smallest group worth comparing. */
    newest: 10, minGroup: 8,
    /** Mean effect size (standard deviations) of newest-vs-older and non-FACEIT-vs-FACEIT form. */
    step: [0.6, 1.8], divergence: [0.6, 1.8],
    /** Share of matches at or above average: [odd, extreme], only counted at a mean rating in floorMean. */
    floor: [0.85, 1], floorMean: [2, 5], minFloorMatches: 15,
    /** Match-to-match variation of reaction time (sd / mean); low is odd. */
    spread: [0.1, 0.04], minSpreadMatches: 15,
  },
  /** How much each signal's value counts inside its family (0..1). */
  weights: {
    preaim: 1, reaction: 1, headAcc: 1, sprayAcc: 0.7, opening: 0.5, stopping: 0.5,
    lopsided: 1, moving: 1,
    step: 0.8, floor: 1, spread: 0.6, divergence: 0.8,
  },
} as const;

export type { ReputationTier };
export type Family = "mechanics" | "coherence" | "trajectory";
type SignalId = keyof typeof REPUTATION.weights;

export interface ReputationSignal {
  id: SignalId;
  family: Family;
  /** 0 = ordinary, 1 = extreme tail. */
  value: number;
  weight: number;
  /** Human-readable, with the numbers in it. */
  text: string;
}

export interface Reputation {
  /** 0..100, 100 = nothing unusual found. null when there is no usable data. */
  score: number | null;
  tier: ReputationTier;
  /** 0..1: how much data stands behind the score. Not how sure the app is that someone cheats. */
  confidence: number;
  matchesAnalyzed: number;
  /** The strongest findings, only for WATCH and worse. */
  reasons: string[];
  /** Why there is no score, e.g. a private profile. */
  note: string | null;
  /** The working, for `npm run leetify:probe`; null when there was no usable data. */
  trace: ReputationTrace | null;
}

export interface ReputationTrace {
  /** What each value was multiplied by to get the units used here. Percent-type stats are decided one by one. */
  scales: { rating: 1 | 100; percent: { head: 1 | 100; spray: 1 | 100; stopping: 1 | 100; opening: 1 | 100 }; ms: 1 | 1000 };
  /** Rank band, -0.5..+0.5 (0 when the Premier rating is unknown). */
  band: number;
  /** Family scores before and after the dead zone. */
  families: Record<Family, number>;
  adjusted: Record<Family, number>;
  signals: ReputationSignal[];
  /** 0..1, how thin the lifetime history is. */
  thin: number;
  suspicion: number;
}

const FAMILIES: readonly Family[] = ["mechanics", "coherence", "trajectory"];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** Works for descending ranges too: ramp(5, [8, 4]) is 0.75 ("lower is more extreme"). */
const ramp = (x: number, [lo, hi]: readonly [number, number]) => clamp01((x - lo) / (hi - lo));
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const opt = (v: unknown): number | null => (num(v) ? v : null);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: number[]) => { const m = mean(xs); return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1); };
const move = ([lo, hi]: readonly [number, number], d: number): [number, number] => [lo + d, hi + d];
const f1 = (x: number) => (Math.round(x * 10) / 10).toString();

interface M {
  t: number;
  rating: number;
  preaim: number | null;
  reaction: number | null;
  head: number | null;
  spray: number | null;
  faceit: boolean;
}

const METRICS: { pick: (m: M) => number | null; dir: 1 | -1 }[] = [
  { pick: (m) => m.rating, dir: 1 },
  { pick: (m) => m.preaim, dir: -1 },
  { pick: (m) => m.reaction, dir: -1 },
  { pick: (m) => m.head, dir: 1 },
];

/**
 * How much better group `a` is than group `b`, in pooled standard deviations, averaged over the metrics that
 * have enough values in both (lower preaim and reaction time count as better). null with fewer than two metrics:
 * one metric alone is too noisy to call a shift.
 */
function shiftEffect(a: M[], b: M[]): number | null {
  const ds: number[] = [];
  for (const { pick, dir } of METRICS) {
    const x = a.map(pick).filter(num);
    const y = b.map(pick).filter(num);
    if (x.length < 5 || y.length < 5) continue;
    const sd = Math.sqrt(((x.length - 1) * variance(x) + (y.length - 1) * variance(y)) / (x.length + y.length - 2));
    if (!(sd > 0)) continue;
    ds.push(Math.max(-4, Math.min(4, (dir * (mean(x) - mean(y))) / sd)));
  }
  return ds.length >= 2 ? mean(ds) : null;
}

function banned(bans: LeetifyBan[]): Reputation {
  const since = bans.map((b) => Date.parse(b.banned_since ?? "")).filter(num);
  const platforms = Array.from(new Set(bans.map((b) => b.platform).filter((x): x is string => !!x)));
  const text = "Ban on record" + (platforms.length ? ` (${platforms.join(", ")})` : "") +
    (since.length ? ` since ${new Date(Math.min(...since)).toISOString().slice(0, 10)}` : "");
  return { score: 0, tier: "BANNED", confidence: 1, matchesAnalyzed: 0, reasons: [text], note: null, trace: null };
}

function unknown(note: string, matchesAnalyzed: number): Reputation {
  return { score: null, tier: "UNKNOWN", confidence: 0, matchesAnalyzed, reasons: [], note, trace: null };
}

export function assessReputation(p: LeetifyProfile): Reputation {
  const T = REPUTATION;

  // A ban is checked first: it needs no match data, and a private profile can still carry one.
  const bans = (p.bans ?? []).filter((b): b is LeetifyBan => !!b);
  if (bans.length > 0) return banned(bans);
  if (p.privacy_mode === "private") return unknown("Private Leetify profile", 0);

  const rated = (p.recent_matches ?? [])
    .filter((m): m is LeetifyRecentMatch & { leetify_rating: number } => !!m && num(m.leetify_rating))
    .sort((a, b) => Date.parse(b.finished_at ?? "") - Date.parse(a.finished_at ?? "") || 0)
    .slice(0, T.window);
  if (rated.length < T.minMatches) return unknown(`Only ${rated.length} recent Leetify matches`, rated.length);

  // Units. The API's scales are unverified (see assess.ts): rating-type values may be fractions or website units,
  // percent-type values fractions or percentages, reaction time milliseconds or seconds. Each is decided from the
  // magnitudes, the way assess.ts does it. `npm run leetify:probe` shows the raw values to check this.
  // Percent-type stats are decided field by field, never together: if the API mixed the two styles (accuracy as
  // 33.0 but counter-strafing as 0.8), one shared decision would misread one of them. A real percentage of these
  // stats is always far above 1, so any value above 1 in a field means that field is in percent.
  const st = p.stats ?? {};
  const ratingS = ratingScale(rated.map((m) => m.leetify_rating));
  const pctScale = (vals: unknown[]): 1 | 100 => (vals.filter(num).some((v) => v > 1) ? 1 : 100);
  const headS = pctScale([st.accuracy_head, ...rated.map((m) => m.accuracy_head)]);
  const sprayS = pctScale([st.spray_accuracy, ...rated.map((m) => m.spray_accuracy)]);
  const stopS = pctScale([st.counter_strafing_good_shots_ratio]);
  const openS = pctScale([st.ct_opening_duel_success_percentage, st.t_opening_duel_success_percentage]);
  const reactionVals = [st.reaction_time_ms, ...rated.map((m) => m.reaction_time_ms)].filter(num);
  const msS: 1 | 1000 = reactionVals.length > 0 && reactionVals.every((v) => v > 0 && v < 10) ? 1000 : 1;

  const ms: M[] = rated.map((m) => ({
    t: Date.parse(m.finished_at ?? ""),
    rating: m.leetify_rating * ratingS,
    preaim: opt(m.preaim),
    reaction: num(m.reaction_time_ms) ? m.reaction_time_ms * msS : null,
    head: num(m.accuracy_head) ? m.accuracy_head * headS : null,
    spray: num(m.spray_accuracy) ? m.spray_accuracy * sprayS : null,
    faceit: (m.data_source ?? "").toLowerCase() === "faceit",
  }));

  // Lifetime stats are steadier than 30 matches, so they win; the recent matches fill in when they are missing.
  const stat = (profileVal: unknown, perMatch: (number | null)[], scale = 1): number | null => {
    if (num(profileVal)) return profileVal * scale;
    const vals = perMatch.filter(num);
    return vals.length >= 3 ? mean(vals) : null;
  };
  const preaim = stat(st.preaim, ms.map((m) => m.preaim));
  const reaction = stat(st.reaction_time_ms, ms.map((m) => m.reaction), msS);
  const head = stat(st.accuracy_head, ms.map((m) => m.head), headS);
  const spray = stat(st.spray_accuracy, ms.map((m) => m.spray), sprayS);
  const stopping = num(st.counter_strafing_good_shots_ratio) ? st.counter_strafing_good_shots_ratio * stopS : null;
  const openCt = num(st.ct_opening_duel_success_percentage) ? st.ct_opening_duel_success_percentage * openS : null;
  const openT = num(st.t_opening_duel_success_percentage) ? st.t_opening_duel_success_percentage * openS : null;

  const premier = p.ranks?.premier;
  const band = num(premier) && premier > 0 ? clamp01(premier / T.band.premierMax) - 0.5 : 0;
  const forBand = num(premier) && premier > 0 ? " for this rank" : "";

  const signals: ReputationSignal[] = [];
  const add = (id: SignalId, family: Family, value: number | null, text: string) => {
    if (value === null || !Number.isFinite(value)) return;
    signals.push({ id, family, value: clamp01(value), weight: T.weights[id], text });
  };

  // Mechanics: values in the extreme tail of what a human does at this rank.
  const M_ = T.mechanics;
  if (preaim !== null)
    add("preaim", "mechanics", ramp(preaim, move(M_.preaim, -band * T.band.preaimDeg)), `Crosshair placement (preaim ${f1(preaim)}°) is unusually tight${forBand}`);
  if (reaction !== null)
    add("reaction", "mechanics", ramp(reaction, move(M_.reaction, -band * T.band.reactionMs)), `Reaction time of ${Math.round(reaction)} ms is unusually fast${forBand}`);
  if (head !== null)
    add("headAcc", "mechanics", ramp(head, move(M_.headAcc, band * T.band.accuracyPts)), `Headshot accuracy of ${f1(head)}% is unusually high${forBand}`);
  if (spray !== null)
    add("sprayAcc", "mechanics", ramp(spray, move(M_.sprayAcc, band * T.band.accuracyPts)), `Spray accuracy of ${f1(spray)}% is unusually high${forBand}`);
  if (openCt !== null && openT !== null)
    add("opening", "mechanics", ramp(Math.min(openCt, openT), move(M_.opening, band * T.band.openingPts)),
      `Wins ${f1(Math.min(openCt, openT))}% of opening duels or more on both sides${forBand}`);
  if (stopping !== null)
    add("stopping", "mechanics", ramp(stopping, M_.stopping), `${f1(stopping)}% of shots are taken perfectly stopped`);

  // Coherence: numbers that don't fit together the way a human's do.
  const C = T.coherence;
  const aim = opt(p.rating?.aim), pos = opt(p.rating?.positioning), util = opt(p.rating?.utility);
  if (aim !== null && pos !== null && util !== null)
    add("lopsided", "coherence", ramp(aim - (pos + util) / 2, C.aimLead) * ramp(aim, C.aimGate),
      `Aim rating ${f1(aim)} but positioning ${f1(pos)} and utility ${f1(util)}`);
  if (head !== null && stopping !== null)
    add("moving", "coherence", ramp(head, move(C.movingHeadAcc, band * T.band.accuracyPts)) * ramp(100 - stopping, C.notStopped),
      `Headshot accuracy ${f1(head)}% although only ${f1(stopping)}% of shots are taken standing still`);

  // Trajectory: what the recent matches do over time. `ms` is newest first.
  const Tr = T.trajectory;
  const newest = ms.slice(0, Tr.newest);
  const older = ms.slice(Tr.newest);
  const step = older.length >= Tr.minGroup ? shiftEffect(newest, older) : null;
  if (step !== null)
    add("step", "trajectory", ramp(step, Tr.step), `The newest ${newest.length} matches are ${f1(step)} standard deviations better than the ${older.length} before`);

  if (ms.length >= Tr.minFloorMatches) {
    const meanRating = mean(ms.map((m) => m.rating));
    const below = ms.filter((m) => m.rating < 0).length / ms.length;
    add("floor", "trajectory", ramp(1 - below, Tr.floor) * ramp(meanRating, Tr.floorMean),
      `Only ${Math.round(below * 100)}% of the last ${ms.length} matches were below average, at a mean rating of ${f1(meanRating)}`);
  }

  const reactions = ms.map((m) => m.reaction).filter(num);
  if (reactions.length >= Tr.minSpreadMatches) {
    const cv = Math.sqrt(variance(reactions)) / mean(reactions);
    add("spread", "trajectory", ramp(cv, Tr.spread), `Reaction time varies only ${f1(cv * 100)}% from match to match`);
  }

  const offFaceit = ms.filter((m) => !m.faceit);
  const onFaceit = ms.filter((m) => m.faceit);
  const gap = offFaceit.length >= Tr.minGroup && onFaceit.length >= Tr.minGroup ? shiftEffect(offFaceit, onFaceit) : null;
  if (gap !== null)
    add("divergence", "trajectory", ramp(gap, Tr.divergence), `Far better outside FACEIT than in FACEIT matches (${f1(gap)} standard deviations)`);

  // Families, then the combined score.
  const families = {} as Record<Family, number>;
  const adjusted = {} as Record<Family, number>;
  let keep = 1;
  for (const f of FAMILIES) {
    const eff = signals.filter((s) => s.family === f).map((s) => s.value * s.weight).sort((a, b) => b - a);
    const k = T.familyTop[f];
    families[f] = Array.from({ length: k }, (_, i) => eff[i] ?? 0).reduce((a, b) => a + b, 0) / k;
    adjusted[f] = Math.max(0, (families[f] - T.deadZone) / (1 - T.deadZone));
    keep *= 1 - T.familyCap[f] * adjusted[f];
  }

  const confidence = ramp(ms.length, [T.minMatches, T.fullSample]);
  const thin = num(p.total_matches) ? ramp(p.total_matches, T.thinProfile.matches) : 0;
  const suspicion = clamp01((1 - keep) * (0.5 + 0.5 * confidence) * (1 + T.thinProfile.boost * thin));

  // Tier from the score, then the gates: the worst tiers need two active families, TRUSTED needs enough data.
  const cuts = T.tiers;
  let score = Math.round(100 * (1 - suspicion));
  let tier: ReputationTier =
    score >= cuts.trusted ? "TRUSTED" : score >= cuts.normal ? "NORMAL" : score >= cuts.watch ? "WATCH"
      : score >= cuts.suspicious ? "SUSPICIOUS" : "VERY_SUSPICIOUS";
  const active = (at: number) => FAMILIES.filter((f) => adjusted[f] >= at).length;
  if (tier === "VERY_SUSPICIOUS" && active(T.activeAt.veryTier) < 2) { tier = "SUSPICIOUS"; score = Math.max(score, cuts.suspicious); }
  if (tier === "SUSPICIOUS" && active(T.activeAt.suspiciousTier) < 2) { tier = "WATCH"; score = Math.max(score, cuts.watch); }
  if (tier === "TRUSTED" && confidence < T.trustedConfidence) { tier = "NORMAL"; score = Math.min(score, cuts.trusted - 1); }

  const flagged = tier === "WATCH" || tier === "SUSPICIOUS" || tier === "VERY_SUSPICIOUS";
  const reasons = !flagged ? [] : signals
    .filter((s) => s.value >= 0.4)
    .sort((a, b) => b.value * b.weight - a.value * a.weight)
    .slice(0, 3)
    .map((s) => s.text);

  const trace: ReputationTrace = { scales: { rating: ratingS, percent: { head: headS, spray: sprayS, stopping: stopS, opening: openS }, ms: msS }, band, families, adjusted, signals, thin, suspicion };
  return { score, tier, confidence, matchesAnalyzed: ms.length, reasons, note: null, trace };
}

/** Maps a reputation onto the app's existing class so lobby answers and the overlay work unchanged. */
export function toEvidenceClass(r: Reputation): EvidenceClass {
  switch (r.tier) {
    case "BANNED":
    case "VERY_SUSPICIOUS": return "VERY_HIGH";
    case "SUSPICIOUS": return "HIGH";
    case "WATCH": return "ELEVATED";
    case "UNKNOWN": return "INSUFFICIENT_DATA";
    default: return "NORMAL";
  }
}

/** The part of a reputation that goes into lobby rows (no trace, no note). */
export function toPlayerReputation(r: Reputation): PlayerReputation {
  return { score: r.score, tier: r.tier, confidence: Math.round(r.confidence * 100) / 100, reasons: r.reasons };
}
