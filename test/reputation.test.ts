// Tests for reputation.ts and its wiring through lookupLobby and LobbyService. Fixtures are deterministic (no
// random numbers).

import { describe, expect, it } from "vitest";
import { combineClass, LeetifyClient, lookupLobby, type LeetifyProfile, type LeetifyRecentMatch } from "../src/main/leetify";
import { LobbyService, type LobbyAnswer } from "../src/main/lobby";
import { assessReputation, toEvidenceClass } from "../src/main/reputation";

/** A steady wobble in -1..1, so fixtures vary from match to match without a random generator. */
const wobble = (i: number, k: number) => Math.sin((i + 1) * 12.9898 + k * 78.233);

interface Spec {
  n?: number; rating: number; newRating?: number; ratingSd?: number;
  preaim: number; reaction: number; head: number; spray: number; fractions?: boolean;
}

function matches(s: Spec): LeetifyRecentMatch[] {
  const k = s.fractions ? 0.01 : 1;
  return Array.from({ length: s.n ?? 30 }, (_, i) => ({
    id: `m${i}`,
    finished_at: new Date(Date.UTC(2026, 9, 1) - i * 86_400_000).toISOString(),
    data_source: "matchmaking",
    leetify_rating: ((i < 10 && s.newRating !== undefined ? s.newRating : s.rating) + wobble(i, 1) * (s.ratingSd ?? 2)) * k,
    preaim: s.preaim * (1 + 0.05 * wobble(i, 2)),
    reaction_time_ms: s.reaction * (1 + 0.15 * wobble(i, 3)),
    accuracy_head: s.head * (1 + 0.1 * wobble(i, 4)) * k,
    spray_accuracy: s.spray * (1 + 0.05 * wobble(i, 5)) * k,
  }));
}

function profile(s: Spec, o: { aim: number; pos: number; util: number; cs: number; open: number; premier?: number; total?: number }): LeetifyProfile {
  const k = s.fractions ? 0.01 : 1;
  return {
    steam64_id: "76561198000000001", name: "p", privacy_mode: "public", total_matches: o.total ?? 400,
    ranks: { premier: o.premier ?? 15000 },
    rating: { aim: o.aim, positioning: o.pos, utility: o.util, clutch: 2 * k },
    stats: {
      preaim: s.preaim, reaction_time_ms: s.reaction, accuracy_head: s.head * k, spray_accuracy: s.spray * k,
      counter_strafing_good_shots_ratio: o.cs * k, ct_opening_duel_success_percentage: o.open * k, t_opening_duel_success_percentage: o.open * k,
    },
    recent_matches: matches(s),
  };
}

const ORDINARY = profile({ rating: 0, ratingSd: 3, preaim: 12, reaction: 620, head: 15, spray: 35 }, { aim: 50, pos: 50, util: 50, cs: 70, open: 47 });
const RAGER_SPEC: Spec = { rating: 1, newRating: 9, ratingSd: 1, preaim: 3, reaction: 280, head: 55, spray: 70 };
const RAGER = profile(RAGER_SPEC, { aim: 99, pos: 30, util: 10, cs: 40, open: 71, premier: 9000, total: 60 });
const BANNED: LeetifyProfile = { privacy_mode: "private", recent_matches: [], bans: [{ platform: "steam", banned_since: "2026-08-14T00:00:00Z" }] };

describe("assessReputation", () => {
  it("leaves an ordinary player alone", () => {
    const r = assessReputation(ORDINARY);
    expect(r.tier).toBe("TRUSTED");
    expect(r.score).toBe(100);
    expect(r.reasons).toEqual([]);
    expect(toEvidenceClass(r)).toBe("NORMAL");
  });

  it("does not punish skill by itself: strong, balanced, human-looking numbers stay unflagged", () => {
    const r = assessReputation(profile({ rating: 3, ratingSd: 3.5, preaim: 7, reaction: 500, head: 30, spray: 52 },
      { aim: 90, pos: 85, util: 80, cs: 85, open: 55, premier: 24000 }));
    expect(r.score).toBeGreaterThanOrEqual(65);
  });

  it("puts a blatant, incoherent profile in the worst tier and explains why", () => {
    const r = assessReputation(RAGER);
    expect(r.tier).toBe("VERY_SUSPICIOUS");
    expect(r.score).toBeLessThan(25);
    expect(r.reasons.length).toBe(3);
    expect(r.reasons.join(" ")).toMatch(/preaim|Reaction|Headshot/);
  });

  it("caps a single odd family at WATCH", () => {
    const r = assessReputation(profile({ rating: 3, ratingSd: 3, preaim: 3.5, reaction: 350, head: 24, spray: 40 },
      { aim: 70, pos: 80, util: 60, cs: 78, open: 56 }));
    expect(r.tier).toBe("WATCH");
  });

  it("reads fractions and percentages the same way", () => {
    const pct = assessReputation(RAGER);
    const frac = assessReputation(profile({ ...RAGER_SPEC, fractions: true }, { aim: 99, pos: 30, util: 10, cs: 40, open: 71, premier: 9000, total: 60 }));
    expect(frac.trace?.scales.percent).toEqual({ head: 100, spray: 100, stopping: 100, opening: 100 });
    expect(pct.trace?.scales.percent).toEqual({ head: 1, spray: 1, stopping: 1, opening: 1 });
    expect(frac.tier).toBe(pct.tier);
    expect(Math.abs((frac.score ?? 0) - (pct.score ?? 0))).toBeLessThanOrEqual(3);
  });

  it("decides each percent stat's units on its own, so a mix of styles is read correctly", () => {
    // Same player three ways: all percentages, all fractions, and accuracy as percentages with counter-strafing
    // and opening duels as fractions (what a mixed-style API would send).
    const spec: Spec = { rating: 2, ratingSd: 3, preaim: 9, reaction: 520, head: 33, spray: 45 };
    const asPercent = profile(spec, { aim: 70, pos: 60, util: 55, cs: 80, open: 52 });
    const allFractions = profile({ ...spec, fractions: true }, { aim: 70, pos: 60, util: 55, cs: 80, open: 52 });
    const mixed = profile(spec, { aim: 70, pos: 60, util: 55, cs: 80, open: 52 });
    mixed.stats!.counter_strafing_good_shots_ratio = 0.8;
    mixed.stats!.ct_opening_duel_success_percentage = 0.52;
    mixed.stats!.t_opening_duel_success_percentage = 0.52;

    const a = assessReputation(asPercent), b = assessReputation(allFractions), m = assessReputation(mixed);
    expect(m.trace?.scales.percent).toEqual({ head: 1, spray: 1, stopping: 100, opening: 100 });
    expect(m.trace?.signals.map((s) => `${s.id}:${s.value.toFixed(2)}`)).toEqual(a.trace?.signals.map((s) => `${s.id}:${s.value.toFixed(2)}`));
    expect(m.score).toBe(a.score);
    expect(Math.abs((b.score ?? 0) - (a.score ?? 0))).toBeLessThanOrEqual(3);
    // The failure this guards against: counter-strafing read as 0.8% invents a "headshots while moving" finding.
    expect(m.trace?.signals.find((s) => s.id === "moving")?.value ?? 0).toBeLessThan(0.3);
  });

  it("never calls a thin sample TRUSTED, and gives UNKNOWN below the minimum", () => {
    const few = { ...ORDINARY, recent_matches: matches({ n: 8, rating: 0, ratingSd: 3, preaim: 12, reaction: 620, head: 15, spray: 35 }) };
    expect(assessReputation(few).tier).toBe("NORMAL");
    const tiny = { ...ORDINARY, recent_matches: matches({ n: 3, rating: 0, preaim: 12, reaction: 620, head: 15, spray: 35 }), total_matches: 3 };
    const r = assessReputation(tiny);
    expect(r.tier).toBe("UNKNOWN");
    expect(r.score).toBe(null);
  });

  it("treats a private profile as UNKNOWN, but a ban as decisive even on one", () => {
    expect(assessReputation({ privacy_mode: "private", recent_matches: [] }).tier).toBe("UNKNOWN");
    const r = assessReputation(BANNED);
    expect(r.tier).toBe("BANNED");
    expect(r.score).toBe(0);
    expect(r.reasons[0]).toMatch(/Ban on record \(steam\) since 2026-08-14/);
  });
});

describe("combineClass", () => {
  it("takes the more severe class and never lowers one", () => {
    expect(combineClass("NORMAL", assessReputation(RAGER))).toBe("VERY_HIGH");
    expect(combineClass("HIGH", assessReputation(ORDINARY))).toBe("HIGH");
    expect(combineClass("INSUFFICIENT_DATA", assessReputation(BANNED))).toBe("VERY_HIGH");
    expect(combineClass("INSUFFICIENT_DATA", assessReputation({ privacy_mode: "private" }))).toBe("INSUFFICIENT_DATA");
  });
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("lookupLobby and LobbyService", () => {
  const profiles: Record<string, LeetifyProfile> = { "76561198000000001": ORDINARY, "76561198000000002": RAGER, "76561198000000003": BANNED };
  const fake = (async (url: string | URL | Request) => json(profiles[new URL(String(url)).searchParams.get("steam64_id") ?? ""] ?? {})) as typeof fetch;

  it("answers with the combined class and the reputation", async () => {
    const answers = await lookupLobby(new LeetifyClient("key", fake), Object.keys(profiles));
    const [ok, rager, banned] = answers;
    expect(ok.classification).toBe("NORMAL");
    expect(ok.reputation?.tier).toBe("TRUSTED");
    expect(rager.classification).toBe("VERY_HIGH");
    expect(rager.reputation?.tier).toBe("VERY_SUSPICIOUS");
    expect(banned.classification).toBe("VERY_HIGH");
    expect(banned.reputation?.tier).toBe("BANNED");
    expect(banned.note).toMatch(/Ban on record/);
  });

  it("gives a player flagged by reputation the performance card too, but a banned private profile only the ban", async () => {
    const [ok, rager, banned] = await lookupLobby(new LeetifyClient("key", fake), Object.keys(profiles));
    expect(ok.detail).not.toBeNull();     // everyone with enough matches has a card (F6 shows any player)
    expect(rager.detail).not.toBeNull();
    expect(banned.detail).toBeNull();     // nothing to show but the ban
    expect(banned.reputation?.reasons[0]).toMatch(/Ban on record/);
  });

  it("carries the reputation into the lobby rows", async () => {
    const answers: LobbyAnswer[] = await lookupLobby(new LeetifyClient("key", fake), Object.keys(profiles));
    let changes = 0;
    const lobby = new LobbyService(async () => answers, () => changes++, { debounceMs: 0 });
    lobby.setMatch({ map: "de_mirage", mode: "premier", phase: "warmup",
      players: Object.keys(profiles).map((steamId, i) => ({ steamId, name: `P${i}` })) } as never);
    await new Promise((r) => setTimeout(r, 50));
    const rows = lobby.rows();
    expect(rows.map((r) => r.reputation?.tier)).toEqual(["TRUSTED", "VERY_SUSPICIOUS", "BANNED"]);
    lobby.dispose();
  });
});
