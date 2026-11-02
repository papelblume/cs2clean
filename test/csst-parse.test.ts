import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { metricsOf } from "../src/main/assess";
import { parseCsstAtHtml } from "../src/main/csst-parse";
import { assessReputation } from "../src/main/reputation";
import { headshotFact } from "../src/renderer/parts";

const ID = "76561198000000001";

/**
 * csst.at's answer for one player (2026-10-31). Aim, preaim and time to damage are "compare with pros" buttons: each
 * holds an icon (stroke-width="1.75") and a data-pro-distribution attribute full of numbers. The lists of pros inside
 * those attributes are cut to two entries; the rest is as received.
 */
const PAGE = readFileSync(join(__dirname, "..", "fixtures", "csst-leetify-extra.html"), "utf8");

describe("parseCsstAtHtml: the current csst.at page", () => {
  it("reads every stat", () => {
    expect(parseCsstAtHtml(PAGE, ID)).toMatchObject({
      steam64_id: ID,
      source: "csst.at",
      total_matches: 30,
      winrate: 0.43,
      ranks: { leetify: -0.1 },
      rating: { aim: 49.2, utility: 51.1 },
      stats: {
        preaim: 8.58,
        reaction_time_ms: 585,
        headshot_kill_percentage: 41.4,
        accuracy_head: 15.6,
        accuracy_enemy_spotted: 29.9,
        spray_accuracy: 17.7,
        counter_strafing_good_shots_ratio: 69.6,
      },
    });
  });

  it("doesn't read the buttons' icon or data attribute as a stat (aim, preaim and time to damage all came back as 1.75)", () => {
    const p = parseCsstAtHtml(PAGE, ID)!;
    for (const v of [p.rating?.aim, p.stats?.preaim, p.stats?.reaction_time_ms]) expect(v).not.toBe(1.75);
  });

  it("finds nothing for a different player's id", () => {
    expect(parseCsstAtHtml(PAGE, "76561198715645651")).toBeNull();
  });
});

describe("a csst.at profile in the app", () => {
  const profile = () => parseCsstAtHtml(PAGE, ID)!;

  it("has head and spotted accuracy for the card, and still its headshot kills", () => {
    expect(metricsOf(profile())).toMatchObject({ headAccuracy: 15.6, spottedAccuracy: 29.9, headshotKills: 41.4 });
  });

  it("shows headshot accuracy on the card, and keeps headshot kills for the scoring", () => {
    expect(headshotFact(metricsOf(profile()))).toEqual({ label: "Headshot accuracy", value: "15.6%", level: "LOW" });
  });

  it("gives the reputation the checks that need them: head accuracy, spotted accuracy and moving", () => {
    const ids = assessReputation(profile()).trace?.signals.map((s) => s.id) ?? [];
    for (const id of ["headAcc", "spottedAcc", "moving", "headKills"]) expect(ids).toContain(id);
  });
});

describe("parseCsstAtHtml: reading an element's text", () => {
  const p = (key: string, inner: string) => `<p id="leetify-${key}-${ID}">${inner}</p>`;

  it("ignores numbers in tags and attributes", () => {
    const html = p("aim", `<button data-pro-distribution="{&#34;value&#34;:12.5,&#34;steamid&#34;:76561198386265483}"><span>49.2</span><svg stroke-width="1.75"></svg></button>`);
    expect(parseCsstAtHtml(html, ID)?.rating?.aim).toBe(49.2);
  });

  it("isn't thrown by a '>' inside an attribute value", () => {
    const html = p("aim", `<span>49.2</span><i data-tip="a>77"></i>`);
    expect(parseCsstAtHtml(html, ID)?.rating?.aim).toBe(49.2);
  });

  it("skips elements of the same name inside the one it reads", () => {
    const html = `<div id="leetify-headshots-${ID}"><div>HS kills</div><div>41.4%</div></div>`;
    expect(parseCsstAtHtml(html, ID)?.stats?.headshot_kill_percentage).toBe(41.4);
  });

  it("takes the last number of the text, with its unit dropped", () => {
    const html = [p("reaction-time", "Time to DMG <b>585ms</b>"), p("preaim", "8.58°"), p("rating", "-0.1")].join("\n");
    const stats = parseCsstAtHtml(html, ID)!;
    expect(stats.stats?.reaction_time_ms).toBe(585);
    expect(stats.stats?.preaim).toBe(8.58);
    expect(stats.ranks?.leetify).toBe(-0.1);
  });

  it("takes the last percentage of the text", () => {
    expect(parseCsstAtHtml(p("accuracy", "Accuracy <span>17.7%</span>"), ID)?.stats?.spray_accuracy).toBe(17.7);
  });

  describe("the win rate", () => {
    const winrate = (inner: string) => parseCsstAtHtml(`<div id="leetify-winrate-${ID}"><p>Winrate</p>${inner}</div><span id="leetify-games-${ID}">30</span>`, ID)!.winrate;

    it("is a 0-1 fraction, like the API's, not the percentage csst.at shows", () => {
      expect(winrate(`<span class="text-white ">43%</span>`)).toBe(0.43);
      expect(winrate(`<span>29.9%</span>`)).toBe(0.299);
      expect(winrate(`<span>100%</span>`)).toBe(1);
    });

    it("is null when csst.at shows none", () => {
      expect(winrate(`<span>–</span>`)).toBeNull();
      expect(parseCsstAtHtml(`<span id="leetify-games-${ID}">30</span>`, ID)!.winrate).toBeNull();
    });

    it("counts as a value on its own", () => {
      expect(parseCsstAtHtml(`<div id="leetify-winrate-${ID}"><span>43%</span></div>`, ID)).toMatchObject({ winrate: 0.43, total_matches: null });
    });
  });

  describe("the accuracy tooltip", () => {
    const accuracy = (tip: string) => `<div id="leetify-accuracy-${ID}"><p>Accuracy</p><p class="tooltip" data-tip="${tip}">17.7%</p></div>`;
    const stats = (tip: string) => parseCsstAtHtml(accuracy(tip), ID)!.stats!;

    it("gives head and spotted accuracy as their own stats, apart from the main accuracy figure", () => {
      expect(stats("Spotted enemy: 29.9% / Head: 15.6%")).toMatchObject({ accuracy_enemy_spotted: 29.9, accuracy_head: 15.6, spray_accuracy: 17.7 });
    });

    it("finds each by its label, in whatever order", () => {
      expect(stats("Head: 15.6% / Spotted enemy: 29.9%")).toMatchObject({ accuracy_enemy_spotted: 29.9, accuracy_head: 15.6 });
    });

    it("takes one when the other is missing, and neither without a tooltip", () => {
      expect(stats("Head: 15.6%")).toMatchObject({ accuracy_head: 15.6, accuracy_enemy_spotted: null });
      expect(stats("Spotted enemy: 29.9%")).toMatchObject({ accuracy_head: null, accuracy_enemy_spotted: 29.9 });
      const bare = parseCsstAtHtml(`<div id="leetify-accuracy-${ID}"><p>Accuracy</p><p>17.7%</p></div>`, ID)!.stats!;
      expect(bare).toMatchObject({ accuracy_head: null, accuracy_enemy_spotted: null, spray_accuracy: 17.7 });
    });

    it("doesn't mistake a longer label for Head", () => {
      expect(stats("Headshot: 41.4% / Spotted enemy: 29.9%")).toMatchObject({ accuracy_head: null, accuracy_enemy_spotted: 29.9 });
    });
  });

  it("leaves a blank element empty and keeps the others", () => {
    const profile = parseCsstAtHtml(`${p("aim", "  ")}\n<span id="leetify-games-${ID}">30</span>`, ID)!;
    expect(profile.rating?.aim).toBeNull();
    expect(profile.total_matches).toBe(30);
  });

  it("is null when no stat has a value", () => {
    expect(parseCsstAtHtml(p("aim", "<svg stroke-width=\"1.75\"></svg>"), ID)).toBeNull();
  });
});
