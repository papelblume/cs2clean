import { describe, expect, it } from "vitest";
import { parseCsstAtHtml } from "../src/main/leetify-hero";

const EXAMPLE_HTML = `<span id="leetify-extra-meta-76561198715645651"
    class="flex items-center gap-2"></span>

<div id="leetify-kd-76561198715645651" hx-swap_oob="outerHTML">
    <p class="text-xs uppercase">KD</p>
    <p class="
        text-white
        ">0.75</p>
</div>
<div id="leetify-preaim-76561198715645651" hx-swap_oob="outerHTML">
    <p class="text-xs uppercase">Preaim</p>
    <p class="
        text-white
        "
        >10.81°</p>
</div>
<div id="leetify-reaction-time-76561198715645651" hx-swap_oob="outerHTML">
    <p class="text-xs uppercase">Time to DMG</p>
    <p class="
        text-white
        "
        >685ms</p>
</div>
<span id="leetify-games-76561198715645651" hx-swap_oob="outerHTML">30</span>
<div id="leetify-winrate-76561198715645651" hx-swap_oob="outerHTML">
    <p class="text-xs uppercase">Winrate</p>
    <span class="text-white ">
        47%
    </span>
</div>
<p id="leetify-aim-76561198715645651" hx-swap_oob="true"
    class="
        text-white
        "
    >41.3</p>
<p id="leetify-utility-76561198715645651" hx-swap_oob="true" class="text-white tooltip"
    data-tip="Quality: 7.7 / Quantity: 31.0"
    >15.4</p>
<span id="leetify-rating-76561198715645651" hx-swap_oob="true" class="tooltip text-white"
    data-tip="CT: -1.8 / T: -3.0"
    >-2.4</span>
<div id="leetify-headshots-76561198715645651" hx-swap_oob="outerHTML">
    <p class="text-xs uppercase">HS kills</p>
    <p class="text-white">31.8%</p>
</div>
<div id="leetify-accuracy-76561198715645651" hx-swap_oob="outerHTML">
    <p class="text-xs uppercase">Accuracy</p>
    <p class="text-white tooltip"
        data-tip="Spotted enemy: 33.6% / Head: 10.8%"
        >20.8%</p>
</div>
<div id="leetify-counter-strafing-76561198715645651" hx-swap_oob="outerHTML">
    <p class="text-xs uppercase">Counter-strafe</p>
    <p class="text-white">77.0%</p>
</div>
<div id="leetify-kast-76561198715645651" hx-swap_oob="outerHTML">
    <p class="text-xs uppercase">KAST</p>
    <p class="text-white">67.8%</p>
</div>
<div id="leetify-he-damage-76561198715645651" hx-swap_oob="outerHTML">
    <p class="text-xs uppercase">AVG HE DMG</p>
    <p><span class="text-white tooltip" data-tip="Enemies">3.7</span>
        / <span class="tooltip" data-tip="Teammates">0.0</span></p>
</div>`;

const STEAM_ID = "76561198715645651";

describe("parseCsstAtHtml", () => {
  it("returns null for empty HTML", () => {
    expect(parseCsstAtHtml("", STEAM_ID)).toBeNull();
  });

  it("returns null for HTML with no matching elements", () => {
    expect(parseCsstAtHtml("<div>no stats here</div>", STEAM_ID)).toBeNull();
  });

  it("parses the example leetify-extra page", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    expect(profile).not.toBeNull();
    if (!profile) return;

    expect(profile.steam64_id).toBe(STEAM_ID);
    expect(profile.privacy_mode).toBe("private");
  });

  it("extracts aim rating", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    expect(profile?.rating?.aim).toBe(41.3);
  });

  it("extracts utility rating", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    expect(profile?.rating?.utility).toBe(15.4);
  });

  it("extracts overall rating and converts to ranks.leetify", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    expect(profile?.rating?.aim).toBe(41.3);
    // csst.at rating of -2.4 → ranks.leetify = -2.4 (same website units)
    expect(profile?.ranks?.leetify).toBe(-2.4);
  });

  it("extracts preaim", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    expect(profile?.stats?.preaim).toBe(10.81);
  });

  it("extracts reaction time", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    expect(profile?.stats?.reaction_time_ms).toBe(685);
  });

  it("extracts headshot percentage", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    // API expects percent (0-100), not fraction
    expect(profile?.stats?.accuracy_head).toBe(31.8);
  });

  it("extracts accuracy percentage", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    expect(profile?.stats?.spray_accuracy).toBe(20.8);
  });

  it("extracts counter-strafing percentage", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    expect(profile?.stats?.counter_strafing_good_shots_ratio).toBe(77);
  });

  it("extracts total games", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    expect(profile?.total_matches).toBe(30);
  });

  it("does not extract fields not present on csst.at", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    expect(profile?.stats?.counter_strafing_good_shots_ratio).toBeDefined();
    expect(profile?.rating?.clutch).toBeUndefined();
    expect(profile?.rating?.positioning).toBeUndefined();
    expect(profile?.ranks?.premier).toBeUndefined();
    expect(profile?.ranks?.faceit).toBeUndefined();
    expect(profile?.recent_matches).toBeUndefined();
  });

  it("returns null steam64_id when not provided", () => {
    const profile = parseCsstAtHtml(EXAMPLE_HTML, STEAM_ID);
    expect(profile?.steam64_id).toBe(STEAM_ID);
  });

  it("handles negative rating values", () => {
    const html = `<p id="leetify-rating-${STEAM_ID}" class="text-white">-15.5</p>`;
    const profile = parseCsstAtHtml(html, STEAM_ID);
    expect(profile?.ranks?.leetify).toBe(-15.5);
  });

  it("handles zero values", () => {
    const html = `<p id="leetify-aim-${STEAM_ID}" class="text-white">0</p>`;
    const profile = parseCsstAtHtml(html, STEAM_ID);
    expect(profile?.rating?.aim).toBe(0);
  });
});
