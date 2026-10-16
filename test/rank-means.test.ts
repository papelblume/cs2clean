import { describe, expect, it } from "vitest";
import { BOTTOM_MEANS, expectedMeans, FACEIT_MEANS, LOWER_IS_BETTER, MEAN_KEYS, PREMIER_MEANS, rankGap, TOP_MEANS } from "../src/main/rank-means";

describe("rank averages", () => {
  it("get better with every FACEIT level, on every stat", () => {
    for (const k of MEAN_KEYS)
      for (let i = 1; i < FACEIT_MEANS.length; i++) {
        const [lower, higher] = [FACEIT_MEANS[i - 1][k], FACEIT_MEANS[i][k]];
        expect(LOWER_IS_BETTER[k] ? higher < lower : higher > lower, `${k} level ${i} to ${i + 1}`).toBe(true);
      }
  });

  it("never beat FACEIT Level 10, the best average there is", () => {
    for (const row of PREMIER_MEANS)
      for (const k of MEAN_KEYS) expect(LOWER_IS_BETTER[k] ? row[k] >= TOP_MEANS[k] : row[k] <= TOP_MEANS[k], k).toBe(true);
  });

  it("count a Premier rating of 20k or more as the top of the ladder (that range is skewed by cheating accounts)", () => {
    for (const premier of [20000, 25400, 30000]) expect(expectedMeans({ premier })).toEqual(TOP_MEANS);
  });

  it("read a Premier rating as its thousands, and a FACEIT level as itself", () => {
    expect(expectedMeans({ premier: 5999 })).toEqual(PREMIER_MEANS[4]);
    expect(expectedMeans({ premier: 400 })).toEqual(PREMIER_MEANS[0]);
    expect(expectedMeans({ faceit: 7 })).toEqual(FACEIT_MEANS[6]);
  });

  it("have none for an account without a usable rank", () => {
    expect(expectedMeans(null)).toBeNull();
    expect(expectedMeans({})).toBeNull();
    expect(expectedMeans({ premier: 0, faceit: 0 })).toBeNull();
    expect(expectedMeans({ premier: null, faceit: 2518 })).toBeNull(); // an ELO, not a level
  });

  it("take the better average of the two when an account has a Premier rating and a FACEIT level", () => {
    const m = expectedMeans({ premier: 3000, faceit: 8 })!;
    expect(m).toEqual(FACEIT_MEANS[7]);
    const mixed = expectedMeans({ premier: 19000, faceit: 4 })!;
    expect(mixed.reaction).toBe(PREMIER_MEANS[18].reaction);
    expect(mixed.headAcc).toBe(PREMIER_MEANS[18].headAcc);
  });

  it("measure the gap to the top as 0 at the top and 1 at FACEIT Level 1", () => {
    expect(rankGap(TOP_MEANS)).toBe(0);
    expect(rankGap(BOTTOM_MEANS)).toBe(1);
    const mid = rankGap(FACEIT_MEANS[4]);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.5);
    expect(rankGap(PREMIER_MEANS[0])).toBe(1); // Premier 1k is below Level 1 on most stats: capped
  });
});
