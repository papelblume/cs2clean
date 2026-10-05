// Leetify profiles for tests: ratings that land in each class under the default THRESHOLDS.

import type { LeetifyProfile } from "../src/main/leetify";

/** `values` are match ratings in website units, newest first. They are written as fractions (5.0 -> 0.05) unless `fractions: false`. */
export function profile(values: number[], o: { aim: number; clutch: number; fractions?: boolean; privacy?: string; name?: string }): LeetifyProfile {
  const k = o.fractions === false ? 1 : 0.01;
  return {
    steam64_id: "76561198000000001",
    name: o.name ?? "player",
    privacy_mode: o.privacy ?? "public",
    total_matches: values.length,
    rating: { aim: o.aim, clutch: o.clutch * k },
    recent_matches: values.map((v, i) => ({
      id: `m${i}`,
      finished_at: new Date(Date.UTC(2026, 8, 30) - i * 86_400_000).toISOString(),
      map_name: "de_mirage",
      data_source: "matchmaking",
      outcome: "win",
      leetify_rating: v * k,
    })),
  };
}

/** n ratings (n a multiple of 5) with exactly this mean and a spread of +/- `spread` (website units). */
export function around(mean: number, spread: number, n = 30): number[] {
  const z = [-1, 0.5, 0, -0.5, 1];
  return Array.from({ length: n }, (_, i) => mean + spread * z[i % 5]);
}

export const AVERAGE = () => profile(around(0, 3), { aim: 45, clutch: 1 });
export const GOOD = () => profile(around(2.5, 2), { aim: 70, clutch: 12 });
export const ELEVATED = () => profile(around(3.5, 2.5), { aim: 80, clutch: 14 });
export const HIGH = () => profile(around(5, 3), { aim: 88, clutch: 20 });
export const VERY_HIGH = () => profile(around(7.5, 1), { aim: 97, clutch: 30 });
