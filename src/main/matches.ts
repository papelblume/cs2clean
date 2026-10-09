// The per-match data of a public Leetify profile (`recent_matches`), turned into a tidy series. This is the
// optional layer: the aggregates in the profile are always there and are enough for a score, and everything that
// uses this series has a fallback for when it is empty (private profile, no matches).
//
// The field names and units of recent_matches have NOT been checked against live responses (the aggregates have),
// so they are read defensively: a rating-type value may be a fraction (0.0532) or website units (5.32), a
// percent-type value a fraction or a percentage, reaction time milliseconds or seconds. Each is decided from the
// magnitudes. `npm run leetify:probe -- <id> --raw` shows what the API really sends.

import type { LeetifyProfile } from "./leetify";

/** Newest matches that count. */
export const WINDOW = 30;

export interface MatchPoint {
  /** Milliseconds since the epoch, NaN when the API sent no date. */
  t: number;
  playedAt: string | null;
  map: string | null;
  /** Leetify rating, in website units (+5.0 is a very strong match). */
  rating: number;
  preaim: number | null;
  /** Milliseconds. */
  reaction: number | null;
  /** Percent. */
  head: number | null;
  spray: number | null;
  faceit: boolean;
}

export interface MatchSeries {
  /** Newest first, at most WINDOW; only matches with a usable rating. */
  matches: MatchPoint[];
  /** What each kind of value was multiplied by to get the units above. */
  scales: { rating: 1 | 100; head: 1 | 100; spray: 1 | 100; ms: 1 | 1000 };
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const opt = (v: unknown): number | null => (num(v) ? v : null);

/**
 * Match ratings span about -15..+15 in website units, so any value larger than 1 in size means they are already
 * in website units; fractions never get that large. Returns what to multiply by.
 */
export function ratingScale(values: number[]): 1 | 100 {
  return values.some((v) => Math.abs(v) > 1) ? 1 : 100;
}

/** A real percentage of accuracy is always far above 1, so any value above 1 means the field is in percent. */
const pctScale = (vals: unknown[]): 1 | 100 => (vals.filter(num).some((v) => v > 1) ? 1 : 100);

export function matchSeries(p: LeetifyProfile): MatchSeries {
  const rated = (p.recent_matches ?? [])
    .filter((m): m is NonNullable<typeof m> & { leetify_rating: number } => !!m && num(m.leetify_rating))
    .sort((a, b) => Date.parse(b.finished_at ?? "") - Date.parse(a.finished_at ?? "") || 0)
    .slice(0, WINDOW);

  const ratingS = ratingScale(rated.map((m) => m.leetify_rating));
  const headS = pctScale(rated.map((m) => m.accuracy_head));
  const sprayS = pctScale(rated.map((m) => m.spray_accuracy));
  const reactions = rated.map((m) => m.reaction_time_ms).filter(num);
  const msS: 1 | 1000 = reactions.length > 0 && reactions.every((v) => v > 0 && v < 10) ? 1000 : 1;

  return {
    scales: { rating: ratingS, head: headS, spray: sprayS, ms: msS },
    matches: rated.map((m) => ({
      t: Date.parse(m.finished_at ?? ""),
      playedAt: m.finished_at ?? null,
      map: m.map_name ?? null,
      rating: m.leetify_rating * ratingS,
      preaim: opt(m.preaim),
      reaction: num(m.reaction_time_ms) ? m.reaction_time_ms * msS : null,
      head: num(m.accuracy_head) ? m.accuracy_head * headS : null,
      spray: num(m.spray_accuracy) ? m.spray_accuracy * sprayS : null,
      faceit: (m.data_source ?? "").toLowerCase() === "faceit",
    })),
  };
}
