import { describe, expect, it } from "vitest";
import { assessProfile, THRESHOLDS } from "../src/main/assess";
import { ratingScale } from "../src/main/matches";
import { around, AVERAGE, ELEVATED, GOOD, HIGH, profile, VERY_HIGH } from "./profiles";

const cls = (p: Parameters<typeof assessProfile>[0]) => assessProfile(p).classification;

describe("assessProfile", () => {
  it("puts each kind of player in its class", () => {
    expect(cls(AVERAGE())).toBe("NORMAL");
    expect(cls(GOOD())).toBe("NORMAL");
    expect(cls(ELEVATED())).toBe("ELEVATED");
    expect(cls(HIGH())).toBe("HIGH");
    expect(cls(VERY_HIGH())).toBe("VERY_HIGH");
  });

  it("gives every player with enough data a card, flagged or not", () => {
    const avg = assessProfile(AVERAGE()).detail!;
    expect(avg.metrics.aim).toBe(45);
    expect(avg.levels).toMatchObject({ rating: "LOW", aim: "LOW", clutch: "LOW" });
    expect(avg.score).toBeLessThan(25);
    const thin = assessProfile(profile(around(8, 1, 5), { aim: 97, clutch: 30 }));
    expect(thin.detail).not.toBeNull(); // 5 matches is enough for a signal
    expect(thin.confidence).toBeLessThan(1);
    const d = assessProfile(HIGH()).detail!;
    expect(d.score).toBeGreaterThan(62);
    expect(d.levels).toMatchObject({ rating: "HIGH", aim: "HIGH" });
    expect(d.metrics.aim).toBe(88);
    expect(d.matches?.avgRating).toBeGreaterThan(4.5);
    expect(d.matches?.recent).toHaveLength(5);
    expect(d.matches?.recent[0].rating).toBeGreaterThan(0); // website units, not fractions
  });

  it("reads fractions and website units the same way", () => {
    const fractions = profile(around(5, 3), { aim: 88, clutch: 20 });
    const website = profile(around(5, 3), { aim: 88, clutch: 0.20, fractions: false });
    expect(fractions.recent_matches![0].leetify_rating!).toBeLessThan(1);
    expect(website.recent_matches![0].leetify_rating!).toBeGreaterThan(1);
    expect(assessProfile(fractions).trace!.scale).toBe(100);
    expect(assessProfile(website).trace!.scale).toBe(1);
    expect(cls(fractions)).toBe(cls(website));
    expect(assessProfile(fractions).trace!.score).toBeCloseTo(assessProfile(website).trace!.score, 6);
  });

  it("never flags on one strong number alone", () => {
    // Top aim, ordinary results: a good aimer, not an outlier.
    expect(cls(profile(around(0.5, 2), { aim: 99, clutch: 2 }))).toBe("NORMAL");
    // A hot clutch rating on its own.
    expect(cls(profile(around(0, 2), { aim: 40, clutch: 60 }))).toBe("NORMAL");
    // Great match ratings but ordinary aim and clutch.
    expect(cls(profile(around(8, 1), { aim: 40, clutch: 2 }))).not.toBe("VERY_HIGH");
  });

  it("needs both rating and aim for VERY_HIGH", () => {
    expect(cls(profile(around(7.5, 1), { aim: 60, clutch: 30 }))).not.toBe("VERY_HIGH");
    expect(cls(profile(around(7.5, 1), { aim: 97, clutch: 30 }))).toBe("VERY_HIGH");
  });

  it("only looks at the newest matches", () => {
    const old = around(9, 1, 20);
    const recent = around(0, 2, THRESHOLDS.window);
    expect(cls(profile([...recent, ...old], { aim: 45, clutch: 1 }))).toBe("NORMAL");
    // The same matches in the other order (great ones newest) change the answer.
    expect(cls(profile([...old, ...recent], { aim: 97, clutch: 30 }))).not.toBe("NORMAL");
  });

  it("sorts matches by date itself, whatever order the API sends", () => {
    const p = HIGH();
    p.recent_matches!.reverse();
    expect(cls(p)).toBe("HIGH");
  });

  it("says 'not enough data' for missing numbers and private profiles", () => {
    const noAim = HIGH();
    noAim.rating = { clutch: 0.2 };
    // Missing aim still leaves rating + clutch signals, so we get a classification (not INSUFFICIENT_DATA)
    expect(cls(noAim)).not.toBe("INSUFFICIENT_DATA");

    expect(assessProfile({})).toMatchObject({ classification: "INSUFFICIENT_DATA" });
  });

  it("ignores matches without a usable rating", () => {
    const p = HIGH();
    p.recent_matches!.push({ id: "x", leetify_rating: null }, { id: "y" }, { id: "z", leetify_rating: Number.NaN });
    expect(assessProfile(p)).toMatchObject({ classification: "HIGH", totalMatches: 30 });
  });

  it("detects the rating scale from the matches", () => {
    expect(ratingScale([0.03, -0.04, 0.12])).toBe(100);
    expect(ratingScale([3.1, -4.2, 0.4])).toBe(1);
  });
});
