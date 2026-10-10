// Parses the csst.at HTMX answer for one player into a LeetifyProfile.
//
// Pure JS with no native or Electron dependencies: it runs in the app and inside the Hero sidecar
// (hero-runtime/, started with its own Node 22), so keep it free of imports other than types.

import type { LeetifyProfile } from "./leetify";

/**
 * Parse csst.at HTMX HTML response into a LeetifyProfile.
 * Pure JS function — no native dependencies, works in any Node version.
 */
export function parseCsstAtHtml(html: string, steamId: string): LeetifyProfile | null {
  if (!html || !steamId) return null;

  const getValue = (key: string): number | null => {
    const openRegex = new RegExp(`<\\w+\\b[^>]*id="leetify-${key}-${steamId}"[^>]*>`, "s");
    const openMatch = openRegex.exec(html);
    if (!openMatch) return null;
    const tagName = openMatch[0].match(/^<(\w+)/)?.[1] ?? "div";
    const closeRegex = new RegExp(`</${tagName}>`, "s");
    const afterOpen = html.slice(openMatch.index + openMatch[0].length);
    const closeMatch = closeRegex.exec(afterOpen);
    if (!closeMatch) return null;
    const content = afterOpen.slice(0, closeMatch.index);
    const numbers = content.match(/([-+]?\d*\.?\d+)/g);
    if (!numbers || numbers.length === 0) return null;
    return parseFloat(numbers[numbers.length - 1]);
  };

  const getPercent = (key: string): number | null => {
    const openRegex = new RegExp(`<\\w+\\b[^>]*id="leetify-${key}-${steamId}"[^>]*>`, "s");
    const openMatch = openRegex.exec(html);
    if (!openMatch) return null;
    const tagName = openMatch[0].match(/^<(\w+)/)?.[1] ?? "div";
    const closeRegex = new RegExp(`</${tagName}>`, "s");
    const afterOpen = html.slice(openMatch.index + openMatch[0].length);
    const closeMatch = closeRegex.exec(afterOpen);
    if (!closeMatch) return null;
    const content = afterOpen.slice(0, closeMatch.index);
    const allPcts = content.match(/([\d.]+)%/g);
    if (!allPcts || allPcts.length === 0) return null;
    const lastPct = allPcts[allPcts.length - 1];
    return parseFloat(lastPct.replace("%", ""));
  };

  const getGames = (): number | null => {
    const regex = new RegExp(`id="leetify-games-${steamId}"[^>]*>([\\s\\S]*?)</`);
    const m = regex.exec(html);
    if (!m) return null;
    const n = parseInt(m[1].trim(), 10);
    return Number.isFinite(n) ? n : null;
  };

  const aim = getValue("aim");
  const utility = getValue("utility");
  const rating = getValue("rating");
  const preaim = getValue("preaim");
  const reactionTime = getValue("reaction-time");
  const headshots = getPercent("headshots");
  const accuracy = getPercent("accuracy");
  const counterStrafing = getPercent("counter-strafing");
  const games = getGames();

  const anyValue = [aim, utility, rating, preaim, reactionTime, headshots, accuracy, counterStrafing, games]
    .some((v) => v !== null);
  if (!anyValue) return null;

  // ranks.leetify is in website units (assess.ts: ~6.55 is a very strong player), the same units csst.at shows,
  // so it is passed through unchanged. Only ct_leetify / t_leetify and per-match ratings are fractions.
  const ranksLeetify = rating;

  return {
    steam64_id: steamId,
    name: null,
    privacy_mode: "private",
    total_matches: games,
    winrate: null,
    ranks: { leetify: ranksLeetify },
    rating: { aim, utility },
    stats: {
      preaim,
      reaction_time_ms: reactionTime,
      accuracy_head: headshots,
      spray_accuracy: accuracy,
      counter_strafing_good_shots_ratio: counterStrafing,
    },
  };
}
