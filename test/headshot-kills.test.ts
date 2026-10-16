import { describe, expect, it } from "vitest";
import { metricsOf } from "../src/main/assess";
import { parseCsstAtHtml } from "../src/main/leetify-hero";
import { assessReputation } from "../src/main/reputation";
import { headshotFact, hsKillsLevel } from "../src/renderer/parts";

// "Headshot kills" (the share of kills that were headshots, csst.at's "HS kills") and "Headshot accuracy" (the share
// of shots that hit the head, Leetify's accuracy_head) are two different metrics, with different values and tiers.

const ID = "76561198715645651";
/** The csst.at answer for an ordinary player (aim numbers that raise no suspicion) with the given share of headshot kills. */
const csst = (hsKills: number) => `
<p id="leetify-aim-${ID}" hx-swap_oob="true">70.0</p>
<span id="leetify-rating-${ID}" hx-swap_oob="true">4.2</span>
<p id="leetify-preaim-${ID}" hx-swap_oob="true">9.5</p>
<p id="leetify-reaction-time-${ID}" hx-swap_oob="true">620</p>
<div id="leetify-headshots-${ID}" hx-swap_oob="outerHTML"><p>HS kills</p><p>${hsKills}%</p></div>
<div id="leetify-accuracy-${ID}" hx-swap_oob="outerHTML"><p>Accuracy</p><p>30%</p></div>
<div id="leetify-counter-strafing-${ID}" hx-swap_oob="outerHTML"><p>Counter-strafe</p><p>60%</p></div>
<p id="leetify-games-${ID}" hx-swap_oob="true">400</p>`;
const fromCsst = (hsKills: number) => parseCsstAtHtml(csst(hsKills), ID)!;
/** The same ordinary player as the Leetify API describes them, with the given headshot accuracy. */
const fromApi = (accuracyHead: number) =>
  ({ ranks: { leetify: 4.2 }, total_matches: 400, stats: { preaim: 9.5, reaction_time_ms: 620, accuracy_head: accuracyHead, spray_accuracy: 30, counter_strafing_good_shots_ratio: 60 } });

/** One signal of the working: 0 = ordinary, 1 = extreme tail; undefined when the signal wasn't raised at all. */
const signal = (r: ReturnType<typeof assessReputation>, id: string) => r.trace?.signals.find((s) => s.id === id);

describe("csst.at's headshot kills", () => {
  it("are kept apart from headshot accuracy in the metrics", () => {
    const m = metricsOf(fromCsst(52.4));
    expect(m.headshotKills).toBe(52.4);
    expect(m.headAccuracy).toBeNull();
    const api = metricsOf({ stats: { accuracy_head: 22 } });
    expect(api.headAccuracy).toBe(22);
    expect(api.headshotKills).toBeNull();
  });

  it("are not scored as headshot accuracy", () => {
    for (const hs of [31.8, 55, 75]) {
      const r = assessReputation(fromCsst(hs));
      expect(signal(r, "headAcc")).toBeUndefined();
      expect(r.reasons.join(" ")).not.toMatch(/Headshot accuracy/);
    }
    expect(assessReputation(fromCsst(31.8)).tier).toBe("NORMAL"); // an ordinary player stays one
  });

  it("are scored on their own range: odd from 58% (the card's HIGH cut), extreme from 70%", () => {
    const value = (hs: number) => signal(assessReputation(fromCsst(hs)), "headKills")?.value ?? 0;
    expect(value(40)).toBe(0);
    expect(value(58)).toBe(0); // the HIGH cut is where it starts
    expect(value(64)).toBeCloseTo(0.5);
    expect(value(70)).toBe(1); // the extreme end
    expect(value(80)).toBe(1);
  });

  it("show up as headshot kills in the working and in the mechanics score", () => {
    const high = assessReputation(fromCsst(75));
    expect(signal(high, "headKills")?.text).toMatch(/^Headshot kills of 75% is unusually high/);
    // A lone signal never changes the tier, so the family score is what shows it.
    expect(high.trace!.families.mechanics).toBeGreaterThan(assessReputation(fromCsst(40)).trace!.families.mechanics);
  });
});

describe("headshot accuracy", () => {
  it("is scored from 23% (odd, the median pro) to 30% (extreme, the top 5% of pros); an average FACEIT Level 10 player (22%) is at 0", () => {
    const value = (head: number) => signal(assessReputation(fromApi(head)), "headAcc")?.value ?? 0;
    expect(value(10)).toBe(0);
    expect(value(22)).toBe(0);
    expect(value(23)).toBe(0);
    expect(value(26.5)).toBeCloseTo(0.5);
    expect(value(30)).toBe(1);
    expect(value(45)).toBe(1);
  });

  it("keeps its own wording, and the API's data is not read as headshot kills", () => {
    const r = assessReputation(fromApi(55));
    expect(signal(r, "headAcc")?.text).toMatch(/^Headshot accuracy of 55% is unusually high/);
    expect(signal(r, "headKills")).toBeUndefined();
  });
});

describe("the headshot row of a card", () => {
  it("uses these tiers for headshot kills: below 50 LOW, 50 to 58 MEDIUM, 58 or above HIGH", () => {
    const at = (pct: number | null | undefined) => hsKillsLevel(pct);
    expect([at(0), at(49.9)]).toEqual(["LOW", "LOW"]);
    expect([at(50), at(57.9)]).toEqual(["MEDIUM", "MEDIUM"]);
    expect([at(58), at(80)]).toEqual(["HIGH", "HIGH"]);
    expect([at(null), at(undefined)]).toEqual(["", ""]);
  });

  it("is labeled Headshot kills, with its own tier, on a card with csst.at data", () => {
    expect(headshotFact(metricsOf(fromCsst(52.4)))).toEqual({ label: "Headshot kills", value: "52.4%", level: "MEDIUM" });
    expect(headshotFact(metricsOf(fromCsst(61)))).toEqual({ label: "Headshot kills", value: "61.0%", level: "HIGH" });
  });

  it("stays Headshot accuracy, with its own tier, on a card with Leetify data", () => {
    // The card's tiers: HIGH from the median pro (23%), MEDIUM from the average FACEIT Level 10 player (22%).
    expect(headshotFact(metricsOf({ stats: { accuracy_head: 17 } }))).toEqual({ label: "Headshot accuracy", value: "17.0%", level: "LOW" });
    expect(headshotFact(metricsOf({ stats: { accuracy_head: 22 } }))).toEqual({ label: "Headshot accuracy", value: "22.0%", level: "MEDIUM" });
    expect(headshotFact(metricsOf({ stats: { accuracy_head: 23 } }))).toEqual({ label: "Headshot accuracy", value: "23.0%", level: "HIGH" });
  });

  it("shows an empty Headshot accuracy when there is neither", () => {
    expect(headshotFact(metricsOf({}))).toEqual({ label: "Headshot accuracy", value: "–", level: "" });
  });
});
