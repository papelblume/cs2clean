// Parses the csst.at HTMX answer for one player into a LeetifyProfile.
//
// Pure JS with no native or Electron dependencies: it runs in the app and inside the Hero sidecar
// (hero-runtime/, started with its own Node 22), so keep it free of imports other than types.

import type { LeetifyProfile } from "./leetify";

/** The inside of a tag, up to its closing ">" (a ">" inside a quoted attribute value doesn't end it). */
const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Everything between the opening and closing tag of the element with this id, markup included. Elements of the same
 * name inside it are skipped when looking for where it ends. null when there is no such element.
 */
function innerHtmlOf(html: string, id: string): string | null {
  const open = new RegExp(`<([A-Za-z][\\w-]*)\\b${TAG_BODY}\\bid="${escapeRegExp(id)}"${TAG_BODY}>`).exec(html);
  if (!open) return null;
  const tag = open[1];
  const start = open.index + open[0].length;
  const sameTag = new RegExp(`<(/?)${tag}\\b${TAG_BODY}>`, "gi");
  sameTag.lastIndex = start;
  let depth = 1;
  for (let m = sameTag.exec(html); m; m = sameTag.exec(html)) {
    if (m[1]) depth--;
    else if (!m[0].endsWith("/>")) depth++;
    if (depth === 0) return html.slice(start, m.index);
  }
  return null;
}

/**
 * The visible text of the element with this id: its tags and their attributes are dropped, so a number that is markup
 * rather than a stat is never read as one (csst.at wraps some stats in a "compare with pros" button that holds an icon
 * with `stroke-width="1.75"` and a data-pro-distribution attribute full of numbers).
 */
function textOf(html: string, id: string): string | null {
  const inner = innerHtmlOf(html, id);
  return inner === null ? null : inner.replace(new RegExp(`<${TAG_BODY}>`, "g"), " ").replace(/\s+/g, " ").trim();
}

/**
 * Parse csst.at HTMX HTML response into a LeetifyProfile.
 * Pure JS function — no native dependencies, works in any Node version.
 */
export function parseCsstAtHtml(html: string, steamId: string): LeetifyProfile | null {
  if (!html || !steamId) return null;

  const textFor = (key: string) => textOf(html, `leetify-${key}-${steamId}`);

  /** The last number of the element's text ("585ms" is 585, "8.58°" is 8.58). */
  const getValue = (key: string): number | null => {
    const numbers = textFor(key)?.match(/[-+]?\d*\.?\d+/g);
    return numbers?.length ? parseFloat(numbers[numbers.length - 1]) : null;
  };

  /** The last percentage of the element's text ("HS kills 41.4%" is 41.4). */
  const getPercent = (key: string): number | null => {
    const pcts = textFor(key)?.match(/[\d.]+%/g);
    return pcts?.length ? parseFloat(pcts[pcts.length - 1]) : null;
  };

  /**
   * A percentage from the tooltip inside the element, found by its label so the order doesn't matter:
   * `data-tip="Spotted enemy: 29.9% / Head: 15.6%"`. null when the label isn't there.
   */
  const getLabelled = (key: string, label: string): number | null => {
    const inner = innerHtmlOf(html, `leetify-${key}-${steamId}`);
    const m = inner && new RegExp(`(?:^|[^\\w])${escapeRegExp(label)}:\\s*([\\d.]+)\\s*%`, "i").exec(inner);
    return m ? parseFloat(m[1]) : null;
  };

  const getGames = (): number | null => {
    const n = parseInt(textFor("games") ?? "", 10);
    return Number.isFinite(n) ? n : null;
  };

  const aim = getValue("aim");
  const utility = getValue("utility");
  const rating = getValue("rating");
  const preaim = getValue("preaim");
  const reactionTime = getValue("reaction-time");
  const headshots = getPercent("headshots");
  const accuracy = getPercent("accuracy");
  // The accuracy element's tooltip carries the other two accuracy stats under Leetify's own names.
  const spottedAccuracy = getLabelled("accuracy", "Spotted enemy");
  const headAccuracy = getLabelled("accuracy", "Head");
  const counterStrafing = getPercent("counter-strafing");
  const games = getGames();

  const anyValue = [aim, utility, rating, preaim, reactionTime, headshots, accuracy, spottedAccuracy, headAccuracy, counterStrafing, games]
    .some((v) => v !== null);
  if (!anyValue) return null;

  // ranks.leetify is in website units (assess.ts: ~6.55 is a very strong player), the same units csst.at shows,
  // so it is passed through unchanged. Only ct_leetify / t_leetify and per-match ratings are fractions.
  const ranksLeetify = rating;

  return {
    steam64_id: steamId,
    name: null,
    privacy_mode: "private",
    source: "csst.at",
    total_matches: games,
    winrate: null,
    ranks: { leetify: ranksLeetify },
    rating: { aim, utility },
    stats: {
      preaim,
      reaction_time_ms: reactionTime,
      // csst.at's "HS kills" is the share of kills that were headshots, not Leetify's accuracy_head (the share of
      // shots that hit the head, which is the tooltip's "Head"). Stored apart, so HS kills is never shown or scored
      // as headshot accuracy.
      headshot_kill_percentage: headshots,
      accuracy_head: headAccuracy,
      accuracy_enemy_spotted: spottedAccuracy,
      spray_accuracy: accuracy,
      counter_strafing_good_shots_ratio: counterStrafing,
    },
  };
}
