// Turns a Leetify profile into a 0-100 reputation score (100 = nothing unusual) and a tier, with reasons.
//
// assess.ts asks "how far above average does this player perform?". This file asks a different question:
// "how implausible do the numbers look, given the player's skill and rank?". Skill alone never lowers the score;
// the evidence is mechanics that sit in the extreme tail for the rank band, stats that contradict each other,
// and sudden or unnaturally steady changes over the last matches.
//
// What this is NOT: proof of anything. A ban on record is the only hard evidence; everything else is statistics
// over public aggregates, which cannot see a careful cheater. The constants below are anchored to the stats of
// ~620 professional players (the pro capability report), NOT calibrated against known cheaters; refine them with
// `npm run leetify:probe` output and, better, with profiles that later turned out to carry a ban (compare their
// matches before `banned_since` with everyone else's).
//
// How the pro numbers are used. The point is plausibility: where a human's stats stop being believable.
//   - Absolute skill stats (aim rating, preaim, reaction, head/spray/spotted accuracy, counter-strafing): 0 at the
//     median pro, 1 at the value only the top 5% of pros reach. Leetify's own FACEIT Level 10 averages (headshot
//     accuracy 22%, spray 38%, spotted 35%, counter-strafing 83%, preaim 10.0 degrees, time to damage 575 ms, aim
//     rating 81) sit at or below the median pro on every one of these (crosshair placement, where the average
//     Level 10 player is better than the median pro, starts at that average), so an ordinary top-tier player is 0
//     here and only the very best humans in the world reach 1. Those numbers describe the top of the ladder (the
//     FACEIT Level 10 average, which is also what a Premier rating of 20k or more counts as, since Premier from
//     20k up is skewed by cheating accounts). A lower rank slides both ends down by part of the gap between its
//     own average player and that top one (rank-means.ts), so the same stats are odder on a lower-ranked account.
//     An account with no known rank is measured against the top as it is.
//   - Stats measured against the lobby (opening duels, ratings) or against the player's own history (trajectory)
//     don't measure skill, so the pros show what chance alone produces: 0 at about the top 5% (opening) or 1%
//     (trajectory) of pros, 1 beyond the most extreme pro.
//   - Within the mechanics family, the aim rating and the reaction time count most (weights below): the aim
//     rating sums six stats, so it is the steadiest one, and a reaction time has a physical floor (the best pro
//     averages 347 ms), which cheats go through.
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
import { ratingScale } from "./matches";
import { expectedMeans, rankGap, TOP_MEANS, type MeanKey } from "./rank-means";
import type { LeetifyBan, LeetifyProfile, LeetifyRecentMatch } from "./leetify";

export const REPUTATION = {
  /** Newest matches that count, same as assess.ts. */
  window: 30,
  /** Fewer scored matches than this is UNKNOWN. */
  minMatches: 5,
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
   * Absolute mechanics improve with rank, so a "tight" value means more on a low rank. For the six stats of
   * rank-means.ts each range below slides by `slide` times the gap between the account's rank average and the top
   * one (FACEIT Level 10). Half, not all of it: the averages say nothing about how far apart the players of one rank
   * are, and the pros' spread (which the ranges come from) is narrower than that of an ordinary rank, so sliding all
   * the way would flag ordinary strong players of a low rank. Data on the spread per rank would settle this.
   * The aim rating sums those six stats: across the ranks of Leetify's published averages it falls about `aimSpan`
   * points from Level 10 down to Level 1 (the average Level 10 aim rating is 81, 5-10k Premier 47, 10-15k 58,
   * 15-20k 69), in step with the average gap of the six stats, so it slides by `slide * aimSpan * rankGap`.
   * Opening duels are against the lobby and have no rank to slide with.
   */
  rank: { slide: 0.5, aimSpan: 48 },
  /**
   * [starts to look odd, extreme] at the top of the ladder (see the rank above). Preaim in degrees, reaction in ms,
   * the rest in percent (the aim rating in points of 0-100). The first number is the median pro, the second the
   * top-5% pro mark. Pro median / top 5% (the average FACEIT Level 10 player in brackets, Sept 2026): aim rating
   * 92.5 / 98.3 (81), preaim 9.25 / 6.6 (8.84), reaction 470 / 405 (524), headAcc 23.4 / 29.9 (21.4), sprayAcc 43.1 /
   * 49.8 (39.2), spottedAcc 39.7 / 44.7 (36.7), stopping 83.2 / 89.9 (79.9). Preaim starts at the Level 10 average,
   * which is better than the median pro's.
   */
  mechanics: {
    aim: [92.5, 98.5], preaim: [8.8, 6.6], reaction: [470, 405], headAcc: [23, 30], sprayAcc: [43, 50],
    spottedAcc: [40, 45], stopping: [83, 90],
    /** Opening duels (the lower of CT and T) are measured against the lobby: pro top 5% is 52, top 1% is 58, the best pro 65.5. */
    opening: [52, 65],
    /**
     * Headshot KILLS (the share of kills that were headshots, csst.at's "HS kills"): a different metric from headAcc
     * (the share of shots that hit the head). Starts at the card's HIGH cut like the rest. Pro report: only 30 pros
     * have it (median 44.9, top 10% 59, top 1% 66, best 66.8), too few to move the range, so it is unchanged.
     * csst.at data has no rank band, so there is nothing to shift it by.
     */
    headKills: [58, 70],
  },
  coherence: {
    /** Only a high aim rating can be lopsided in a way that matters (pro median 92.5, 85% of pros are above 85.5)... */
    aimGate: [65, 85],
    /** ...and aim minus the mean of positioning and utility, in rating points. Pros are lopsided by nature (median 26, top 10% 34, top 1% 42, most 54). */
    aimLead: [34, 54],
    /**
     * High headshot accuracy (same range as headAcc) while this many percent of shots are NOT taken standing still.
     * Pros: median 17, top 1% 29, the most 37, so beyond 28 even the best pros' own numbers don't explain it.
     */
    movingHeadAcc: [23, 30], notStopped: [28, 38],
  },
  trajectory: {
    /** Window of "newest" matches compared with the rest, and the smallest group worth comparing. */
    newest: 10, minGroup: 8,
    /**
     * Mean effect size (standard deviations) of newest-vs-older and non-FACEIT-vs-FACEIT form. Among pros, chance
     * alone gives step 0.67 (top 1%) and 0.85 (most of 591); divergence 0.78 (top 1%) and 0.79 (most of 90).
     */
    step: [0.7, 1.4], divergence: [0.8, 1.6],
    /** Share of matches at or above average: [odd, extreme], only counted at a mean rating in floorMean. */
    floor: [0.85, 1], floorMean: [2, 5], minFloorMatches: 15,
    /** Match-to-match variation of reaction time (sd / mean); low is odd. Pros: median 0.185, steadiest 1% 0.116, steadiest 0.103. */
    spread: [0.12, 0.06], minSpreadMatches: 15,
  },
  /** How much each signal's value counts inside its family (0..1). */
  weights: {
    aim: 1, reaction: 1, preaim: 0.8, headAcc: 0.8, headKills: 0.6, sprayAcc: 0.6, spottedAcc: 0.6, opening: 0.4, stopping: 0.4,
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
  /** How far below the top of the ladder the account's rank is, 0 (top, or no rank known) to 1 (FACEIT Level 1). */
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
  spotted: number | null;
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

  const ratedAll = (p.recent_matches ?? [])
    .filter((m): m is LeetifyRecentMatch & { leetify_rating: number } => !!m && num(m.leetify_rating))
    .sort((a, b) => Date.parse(b.finished_at ?? "") - Date.parse(a.finished_at ?? "") || 0)
    .slice(0, T.window);

  // Aggregate-only mode: no usable match history (private profile, csst.at data, or fewer than minMatches
  // recent matches). The lifetime stats (preaim, reaction, accuracy, counter-strafing, ratings) still say a lot,
  // so the mechanics and coherence families are scored from them; the trajectory family needs matches and stays
  // silent. `sample` is then the profile's own match count instead of the number of recent matches.
  const aggregateOnly = ratedAll.length < T.minMatches;
  const rated = aggregateOnly ? [] : ratedAll;
  const sample = aggregateOnly ? (num(p.total_matches) ? p.total_matches : 0) : rated.length;
  if (aggregateOnly && sample < T.minMatches) return unknown(`Only ${sample} matches on this profile`, ratedAll.length);

  // Units. The API's scales are unverified (see assess.ts): rating-type values may be fractions or website units,
  // percent-type values fractions or percentages, reaction time milliseconds or seconds. Each is decided from the
  // magnitudes, the way assess.ts does it. `npm run leetify:probe` shows the raw values to check this.
  // Percent-type stats are decided field by field, never together: if the API mixed the two styles (accuracy as
  // 33.0 but counter-strafing as 0.8), one shared decision would misread one of them. A real percentage of these
  // stats is always far above 1, so any value above 1 in a field means that field is in percent.
  const st = p.stats ?? {};
  const ratingS = rated.length > 0 ? ratingScale(rated.map((m) => m.leetify_rating)) : 1;
  const pctScale = (vals: unknown[]): 1 | 100 => (vals.filter(num).some((v) => v > 1) ? 1 : 100);
  const headS = pctScale([st.accuracy_head, ...rated.map((m) => m.accuracy_head)]);
  const sprayS = pctScale([st.spray_accuracy, ...rated.map((m) => m.spray_accuracy)]);
  const spottedS = pctScale([st.accuracy_enemy_spotted, ...rated.map((m) => m.accuracy_enemy_spotted)]);
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
    spotted: num(m.accuracy_enemy_spotted) ? m.accuracy_enemy_spotted * spottedS : null,
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
  // Always a percentage (csst.at only, parsed from "52.4%"), so no scale to guess; there are no per-match values.
  const headKills = num(st.headshot_kill_percentage) ? st.headshot_kill_percentage : null;
  const spray = stat(st.spray_accuracy, ms.map((m) => m.spray), sprayS);
  const spotted = stat(st.accuracy_enemy_spotted, ms.map((m) => m.spotted), spottedS);
  const stopping = num(st.counter_strafing_good_shots_ratio) ? st.counter_strafing_good_shots_ratio * stopS : null;
  const openCt = num(st.ct_opening_duel_success_percentage) ? st.ct_opening_duel_success_percentage * openS : null;
  const openT = num(st.t_opening_duel_success_percentage) ? st.t_opening_duel_success_percentage * openS : null;

  // The rank's average player (null: no rank known, so the ranges apply as they are) and how far each range slides.
  const rank = expectedMeans(p.ranks);
  const band = rank ? rankGap(rank) : 0;
  const forBand = rank ? " for this rank" : "";
  const slide = (k: MeanKey) => (rank ? T.rank.slide * (rank[k] - TOP_MEANS[k]) : 0);

  const aim = opt(p.rating?.aim), pos = opt(p.rating?.positioning), util = opt(p.rating?.utility);

  const signals: ReputationSignal[] = [];
  const add = (id: SignalId, family: Family, value: number | null, text: string) => {
    if (value === null || !Number.isFinite(value)) return;
    signals.push({ id, family, value: clamp01(value), weight: T.weights[id], text });
  };

  // Mechanics: values in the extreme tail of what a human does at this rank.
  const M_ = T.mechanics;
  if (aim !== null)
    add("aim", "mechanics", ramp(aim, move(M_.aim, -T.rank.slide * T.rank.aimSpan * band)), `Aim rating of ${f1(aim)} is unusually high${forBand}`);
  if (preaim !== null)
    add("preaim", "mechanics", ramp(preaim, move(M_.preaim, slide("preaim"))), `Crosshair placement (preaim ${f1(preaim)}°) is unusually tight${forBand}`);
  if (reaction !== null)
    add("reaction", "mechanics", ramp(reaction, move(M_.reaction, slide("reaction"))), `Reaction time of ${Math.round(reaction)} ms is unusually fast${forBand}`);
  if (head !== null)
    add("headAcc", "mechanics", ramp(head, move(M_.headAcc, slide("headAcc"))), `Headshot accuracy of ${f1(head)}% is unusually high${forBand}`);
  if (headKills !== null)
    add("headKills", "mechanics", ramp(headKills, M_.headKills), `Headshot kills of ${f1(headKills)}% is unusually high`);
  if (spray !== null)
    add("sprayAcc", "mechanics", ramp(spray, move(M_.sprayAcc, slide("sprayAcc"))), `Spray accuracy of ${f1(spray)}% is unusually high${forBand}`);
  if (spotted !== null)
    add("spottedAcc", "mechanics", ramp(spotted, move(M_.spottedAcc, slide("spottedAcc"))), `Spotted accuracy of ${f1(spotted)}% is unusually high${forBand}`);
  if (openCt !== null && openT !== null)
    add("opening", "mechanics", ramp(Math.min(openCt, openT), M_.opening),
      `Wins ${f1(Math.min(openCt, openT))}% of opening duels or more on both sides`);
  if (stopping !== null)
    add("stopping", "mechanics", ramp(stopping, move(M_.stopping, slide("stopping"))), `${f1(stopping)}% of shots are taken perfectly stopped${forBand}`);

  // Coherence: numbers that don't fit together the way a human's do.
  const C = T.coherence;
  if (aim !== null && pos !== null && util !== null)
    add("lopsided", "coherence", ramp(aim - (pos + util) / 2, C.aimLead) * ramp(aim, C.aimGate),
      `Aim rating ${f1(aim)} but positioning ${f1(pos)} and utility ${f1(util)}`);
  if (head !== null && stopping !== null)
    add("moving", "coherence", ramp(head, move(C.movingHeadAcc, slide("headAcc"))) * ramp(100 - stopping, C.notStopped),
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

  if (aggregateOnly && signals.length === 0) return unknown("Leetify sent no usable stats for this player", sample);

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

  const confidence = ramp(sample, [T.minMatches, T.fullSample]);
  // With a match history, total_matches is the lifetime count. Without one (csst.at, private) it can be just the
  // size of the stats window (at most 30), which would read as "thin" for everybody, so there is no boost then.
  const thin = !aggregateOnly && num(p.total_matches) ? ramp(p.total_matches, T.thinProfile.matches) : 0;
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
  // Without a match history one whole family (trajectory) can't speak, so "nothing unusual" never reaches TRUSTED.
  if (tier === "TRUSTED" && (confidence < T.trustedConfidence || aggregateOnly)) { tier = "NORMAL"; score = Math.min(score, cuts.trusted - 1); }

  const flagged = tier === "WATCH" || tier === "SUSPICIOUS" || tier === "VERY_SUSPICIOUS";
  const reasons = !flagged ? [] : signals
    .filter((s) => s.value >= 0.4)
    .sort((a, b) => b.value * b.weight - a.value * a.weight)
    .slice(0, 3)
    .map((s) => s.text);

  const trace: ReputationTrace = { scales: { rating: ratingS, percent: { head: headS, spray: sprayS, stopping: stopS, opening: openS }, ms: msS }, band, families, adjusted, signals, thin, suspicion };
  return { score, tier, confidence, matchesAnalyzed: ms.length, reasons, note: aggregateOnly ? "Scored from lifetime stats only (no match history)" : null, trace };
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
