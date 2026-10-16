// What an average player does at each rank, from Leetify's Performance Metric Tool: all regions, all maps,
// September 2026, 3,838,569 players (FACEIT Level 1-10 and Premier 1k-30k buckets).
//
// Only the top of the ladder is treated specially. Premier from 20k up is skewed by cheating accounts (those
// buckets' averages turn into 360 ms and 44% headshot accuracy at 30k), so it is not used: a Premier rating of 20k or
// more counts as the top of the ladder, and the top of the ladder is the FACEIT Level 10 average, the best average
// of any bracket that can be trusted. No bracket below it is ever better than it, so it is also the cap.
//
// These are averages of players, not spreads: they say where a rank's players sit, not how far from that a
// plausible player can go. reputation.ts slides its ranges with them, but only part of the way.

export type MeanKey = "reaction" | "preaim" | "headAcc" | "sprayAcc" | "spottedAcc" | "stopping";
export type RankMeans = Record<MeanKey, number>;

/** Reaction (time to damage) in ms and preaim (crosshair placement) in degrees: lower is better. The rest are percent: higher is better. */
export const LOWER_IS_BETTER: Record<MeanKey, boolean> = {
  reaction: true, preaim: true, headAcc: false, sprayAcc: false, spottedAcc: false, stopping: false,
};
export const MEAN_KEYS = Object.keys(LOWER_IS_BETTER) as MeanKey[];

const row = (reaction: number, preaim: number, headAcc: number, sprayAcc: number, spottedAcc: number, stopping: number): RankMeans =>
  ({ reaction, preaim, headAcc, sprayAcc, spottedAcc, stopping });

/** FACEIT Level 1 to 10 (index = level - 1). */
export const FACEIT_MEANS: readonly RankMeans[] = [
  row(676.76, 11.46, 13.51, 30.16, 30.53, 66.35),
  row(639.66, 10.80, 14.68, 32.26, 32.18, 69.50),
  row(616.86, 10.36, 15.69, 33.55, 32.93, 72.23),
  row(598.20, 10.00, 16.74, 34.75, 33.71, 74.47),
  row(583.46, 9.78, 17.60, 35.62, 34.34, 76.05),
  row(571.80, 9.55, 18.29, 36.25, 34.74, 77.04),
  row(562.81, 9.41, 18.86, 36.83, 35.09, 77.81),
  row(552.50, 9.24, 19.45, 37.35, 35.43, 78.43),
  row(542.22, 9.10, 20.03, 38.05, 35.81, 78.91),
  row(523.97, 8.84, 21.40, 39.20, 36.69, 79.85),
];

/** Premier 1k to 19k (index = thousands - 1). 20k and up is not used, see above. */
export const PREMIER_MEANS: readonly RankMeans[] = [
  row(720.81, 11.95, 13.23, 28.41, 30.23, 62.49),
  row(682.93, 11.33, 13.87, 29.74, 31.30, 64.78),
  row(664.80, 11.02, 14.36, 30.71, 32.03, 66.54),
  row(647.89, 10.69, 14.92, 31.43, 32.56, 68.02),
  row(638.92, 10.55, 15.04, 31.75, 32.68, 68.95),
  row(632.93, 10.42, 15.41, 31.90, 32.86, 69.62),
  row(626.51, 10.29, 15.67, 32.20, 33.05, 70.24),
  row(620.58, 10.18, 16.04, 32.51, 33.25, 70.94),
  row(613.18, 10.03, 16.43, 32.97, 33.64, 71.95),
  row(607.52, 9.93, 16.60, 33.11, 33.63, 72.47),
  row(602.75, 9.80, 16.95, 33.47, 33.83, 73.17),
  row(596.92, 9.70, 17.33, 33.75, 34.07, 73.80),
  row(590.57, 9.55, 17.65, 33.97, 34.27, 74.34),
  row(583.08, 9.43, 18.11, 34.38, 34.63, 75.14),
  row(577.69, 9.30, 18.42, 34.50, 34.68, 75.55),
  row(573.08, 9.25, 18.74, 34.80, 34.94, 75.97),
  row(566.80, 9.13, 19.17, 34.99, 35.18, 76.32),
  row(560.21, 9.02, 19.62, 35.04, 35.46, 76.57),
  row(551.37, 8.89, 20.20, 35.20, 35.93, 76.70),
];

/** The best average a bracket can have: FACEIT Level 10. */
export const TOP_MEANS: RankMeans = FACEIT_MEANS[9];
/** The other end of the scale, for measuring how far down a rank is: FACEIT Level 1. */
export const BOTTOM_MEANS: RankMeans = FACEIT_MEANS[0];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The averages for an account's rank, or null when it has none. With both a Premier rating and a FACEIT level the
 * better average of the two wins per stat (the rank that explains the stats best, so the fewest false flags).
 */
export function expectedMeans(ranks: { premier?: number | null; faceit?: number | null } | null | undefined): RankMeans | null {
  const found: RankMeans[] = [];
  const premier = ranks?.premier;
  if (isNum(premier) && premier > 0) found.push(premier >= 20000 ? TOP_MEANS : PREMIER_MEANS[Math.max(1, Math.floor(premier / 1000)) - 1]);
  const level = ranks?.faceit;
  if (isNum(level) && level >= 1 && level < 11) found.push(FACEIT_MEANS[Math.min(10, Math.floor(level)) - 1]);
  if (found.length === 0) return null;
  const out = { ...found[0] };
  for (const m of found.slice(1))
    for (const k of MEAN_KEYS) out[k] = LOWER_IS_BETTER[k] ? Math.min(out[k], m[k]) : Math.max(out[k], m[k]);
  return out;
}

/** How far below the top of the ladder a rank sits, 0 (the top) to 1 (FACEIT Level 1), averaged over the stats. */
export function rankGap(means: RankMeans): number {
  const parts = MEAN_KEYS.map((k) => (means[k] - TOP_MEANS[k]) / (BOTTOM_MEANS[k] - TOP_MEANS[k]));
  return Math.min(1, Math.max(0, parts.reduce((a, b) => a + b, 0) / parts.length));
}
