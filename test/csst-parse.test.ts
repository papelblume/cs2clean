import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsstAtHtml } from "../src/main/csst-parse";

const ID = "76561198005725470";

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
      ranks: { leetify: -0.1 },
      rating: { aim: 49.2, utility: 51.1 },
      stats: {
        preaim: 8.58,
        reaction_time_ms: 585,
        headshot_kill_percentage: 41.4,
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

  it("leaves a blank element empty and keeps the others", () => {
    const profile = parseCsstAtHtml(`${p("aim", "  ")}\n<span id="leetify-games-${ID}">30</span>`, ID)!;
    expect(profile.rating?.aim).toBeNull();
    expect(profile.total_matches).toBe(30);
  });

  it("is null when no stat has a value", () => {
    expect(parseCsstAtHtml(p("aim", "<svg stroke-width=\"1.75\"></svg>"), ID)).toBeNull();
  });
});
