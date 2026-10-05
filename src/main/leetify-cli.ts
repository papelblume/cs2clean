// `npm run leetify:probe -- <steamid64> [...]`: prints what Leetify's API sends for a player (raw numbers) and
// what the app makes of it. Use it to check the units and to tune THRESHOLDS in assess.ts.
// The API key is read from LEETIFY_API_KEY (optional).

import { assessProfile, THRESHOLDS } from "./assess";
import { LeetifyClient, LeetifyError } from "./leetify";

async function main() {
  const ids = process.argv.slice(2).filter((a) => /^\d{17}$/.test(a));
  if (ids.length === 0) {
    console.error("Usage: npm run leetify:probe -- <steamid64> [<steamid64> ...]   (key: LEETIFY_API_KEY)");
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
      console.log(`raw leetify_rating, newest 8: ${raw.slice(0, 8).join(", ") || "(none)"}`);
      if (raw.length) console.log(`raw min/max: ${Math.min(...raw)} / ${Math.max(...raw)}`);
      const a = assessProfile(p);
      console.log(`class: ${a.classification}   matches scored: ${a.matchesAnalyzed}${a.note ? `   note: ${a.note}` : ""}`);
      if (a.trace) {
        const t = a.trace, f = (n: number) => n.toFixed(2);
        console.log(`units: ${t.scale === 100 ? "fractions, multiplied by 100" : "already website units"}`);
        console.log(`avg match rating: ${f(t.meanRating)}   strong matches (>= ${THRESHOLDS.rating.strongMatch}): ${Math.round(t.strongShare * 100)}%   clutch: ${f(t.clutch)}`);
        console.log(`signals 0..1  rating ${f(t.signals.rating)}  aim ${f(t.signals.aim)}  clutch ${f(t.signals.clutch)}   combined ${f(t.score)}`);
      }
    } catch (e) {
      console.log(e instanceof LeetifyError ? `${e.kind}: ${e.message}` : e);
    }
  }
}

void main();
