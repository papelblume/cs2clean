import { describe, expect, it } from "vitest";
import { assessProfile, ratingScale, THRESHOLDS } from "../src/main/assess";
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
    expect(avg).toMatchObject({ aim: 45, levels: { rating: "LOW", aim: "LOW", clutch: "LOW" } });
    expect(avg.score).toBeLessThan(25);
    expect(assessProfile(profile(around(8, 1, 5), { aim: 97, clutch: 30 })).detail).toBeNull(); // too few matches
    const d = assessProfile(HIGH()).detail!;
    expect(d.score).toBeGreaterThan(62);
    expect(d.levels).toMatchObject({ rating: "HIGH", aim: "HIGH" });
    expect(d.aim).toBe(88);
    expect(d.avgRating).toBeGreaterThan(4.5);
    expect(d.recent).toHaveLength(3);
    expect(d.recent[0].rating).toBeGreaterThan(0); // website units, not fractions
  });

  it("reads fractions and website units the same way", () => {
    const fractions = profile(around(5, 3), { aim: 88, clutch: 20 });
    const website = profile(around(5, 3), { aim: 88, clutch: 20, fractions: false });
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

  it("says 'not enough data' for few matches, missing numbers and private profiles", () => {
    const few = assessProfile(profile(around(8, 1, 5), { aim: 97, clutch: 30 }));
    expect(few).toMatchObject({ classification: "INSUFFICIENT_DATA", matchesAnalyzed: 5 });
    expect(few.note).toMatch(/Only 5/);

    const noAim = HIGH();
    noAim.rating = { clutch: 0.2 };
    expect(cls(noAim)).toBe("INSUFFICIENT_DATA");

    const priv = assessProfile({ ...HIGH(), privacy_mode: "private", recent_matches: [] });
    expect(priv).toMatchObject({ classification: "INSUFFICIENT_DATA", matchesAnalyzed: 0, note: "Private Leetify profile" });
    expect(assessProfile({})).toMatchObject({ classification: "INSUFFICIENT_DATA" });
  });

  it("ignores matches without a usable rating", () => {
    const p = HIGH();
    p.recent_matches!.push({ id: "x", leetify_rating: null }, { id: "y" }, { id: "z", leetify_rating: Number.NaN });
    expect(assessProfile(p)).toMatchObject({ classification: "HIGH", matchesAnalyzed: 30 });
  });

  it("detects the rating scale from the matches", () => {
    expect(ratingScale([0.03, -0.04, 0.12])).toBe(100);
    expect(ratingScale([3.1, -4.2, 0.4])).toBe(1);
  });
});
