// `npm run leetify:probe -- <steamid64> [...] [--raw]`: prints what Leetify's API sends for a player (raw numbers)
// and what the app makes of it: the performance class (assess.ts) and the reputation score (reputation.ts).
// Use it to check the units, to see which expected fields the live API really sends, and to tune THRESHOLDS in
// assess.ts and REPUTATION in reputation.ts. --raw also dumps the profile as JSON (first 2 matches only).
// The API key is read from LEETIFY_API_KEY (optional).

import { assessProfile, THRESHOLDS } from "./assess";
import { LeetifyClient, LeetifyError, type LeetifyProfile } from "./leetify";
import { assessReputation } from "./reputation";

/** Fields reputation.ts reads. The names come from a third-party client of the API, so check them against the live answer. */
const EXPECTED = {
  stats: ["preaim", "reaction_time_ms", "accuracy_head", "spray_accuracy", "counter_strafing_good_shots_ratio",
    "ct_opening_duel_success_percentage", "t_opening_duel_success_percentage"],
  rating: ["aim", "positioning", "utility", "clutch"],
  match: ["finished_at", "data_source", "leetify_rating", "preaim", "reaction_time_ms", "accuracy_head", "spray_accuracy"],
} as const;

function missingFields(p: LeetifyProfile): string[] {
  const out: string[] = [];
  const has = (o: unknown, k: string) => !!o && typeof o === "object" && (o as Record<string, unknown>)[k] != null;
  for (const k of EXPECTED.stats) if (!has(p.stats, k)) out.push(`stats.${k}`);
  for (const k of EXPECTED.rating) if (!has(p.rating, k)) out.push(`rating.${k}`);
  const ms = p.recent_matches ?? [];
  for (const k of EXPECTED.match) if (ms.length > 0 && !ms.some((m) => has(m, k))) out.push(`recent_matches[].${k}`);
  if (!Array.isArray(p.bans)) out.push("bans");
  if (p.ranks?.premier == null) out.push("ranks.premier (fine for players without a Premier rating)");
  return out;
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => /^\d{17}$/.test(a));
  const dumpRaw = process.argv.includes("--raw");
  if (ids.length === 0) {
    console.error("Usage: npm run leetify:probe -- <steamid64> [<steamid64> ...] [--raw]   (key: LEETIFY_API_KEY)");
    process.exit(2);
  }
  const client = new LeetifyClient(process.env.LEETIFY_API_KEY?.trim() || null);
  for (const id of ids) {
    console.log(`\n== ${id}`);
    try {
      const p = await client.profile(id);
      const raw = (p.recent_matches ?? []).map((m) => m.leetify_rating).filter((v): v is number => typeof v === "number");
      console.log(`name: ${p.name}   privacy: ${p.privacy_mode}   recent_matches: ${p.recent_matches?.length ?? 0}`);
      console.log(`raw rating.aim: ${p.rating?.aim}   raw rating.clutch: ${p.rating?.clutch}`);
      const st = p.stats;
      console.log(`raw stats: preaim ${st?.preaim}  reaction_time_ms ${st?.reaction_time_ms}  accuracy_head ${st?.accuracy_head}  spray_accuracy ${st?.spray_accuracy}  counter_strafing ${st?.counter_strafing_good_shots_ratio}`);
      console.log(`raw ranks.premier: ${p.ranks?.premier}   bans: ${p.bans?.length ?? "(field missing)"}   total_matches: ${p.total_matches}`);
      const missing = missingFields(p);
      console.log(missing.length ? `fields missing or null: ${missing.join(", ")}` : "all fields reputation.ts reads are present");
      if (dumpRaw) console.log(JSON.stringify({ ...p, recent_matches: (p.recent_matches ?? []).slice(0, 2) }, null, 2));
      console.log(`raw leetify_rating, newest 8: ${raw.slice(0, 8).join(", ") || "(none)"}`);
      if (raw.length) console.log(`raw min/max: ${Math.min(...raw)} / ${Math.max(...raw)}`);
      const a = assessProfile(p);
      console.log(`class: ${a.classification}   matches scored: ${a.totalMatches}${a.note ? `   note: ${a.note}` : ""}`);
      if (a.trace) {
        const t = a.trace, f = (n: number | null) => n?.toFixed(2) ?? "n/a";
        console.log(`units: ${t.scale === 100 ? "fractions, multiplied by 100" : "already website units"}`);
        console.log(`avg match rating: ${f(t.meanRating)}   strong matches (>= ${THRESHOLDS.rating.strongMatch}): ${Math.round(t.strongShare * 100)}%   clutch: ${f(t.clutch)}`);
        console.log(`signals 0..1  rating ${f(t.signals.rating)}  aim ${f(t.signals.aim)}  clutch ${f(t.signals.clutch)}   combined ${f(t.score)}`);
      }
      const r = assessReputation(p), f = (n: number) => n.toFixed(2);
      console.log(`reputation: ${r.score ?? "-"}/100   tier: ${r.tier}   confidence: ${f(r.confidence)}   matches: ${r.matchesAnalyzed}${r.note ? `   note: ${r.note}` : ""}`);
      if (r.trace) {
        const t = r.trace;
        const pc = t.scales.percent;
        console.log(`units: rating x${t.scales.rating}  percent (head x${pc.head}, spray x${pc.spray}, stopping x${pc.stopping}, opening x${pc.opening})  reaction x${t.scales.ms}   rank band ${f(t.band)}   thin history ${f(t.thin)}   suspicion ${f(t.suspicion)}`);
        console.log(`families (raw -> after dead zone): ` + (["mechanics", "coherence", "trajectory"] as const).map((k) => `${k} ${f(t.families[k])} -> ${f(t.adjusted[k])}`).join("   "));
        console.log(`signals 0..1: ` + (t.signals.map((s) => `${s.id} ${f(s.value)}`).join("  ") || "(none)"));
      }
      for (const reason of r.reasons) console.log(`  - ${reason}`);
    } catch (e) {
      console.log(e instanceof LeetifyError ? `${e.kind}: ${e.message}` : e);
    }
  }
}

void main();
