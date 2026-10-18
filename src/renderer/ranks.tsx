// A player's competitive ranks, shown next to their name: the CS2 Premier rating drawn the way Leetify draws it
// (same path and tier colours as leetify.com's cs-rating component, see the ".cs-rating" rules in style.css), and the
// FACEIT level as its icon followed by the FACEIT Elo.

import type { PlayerMetrics } from "../shared/types";

/**
 * The FACEIT level icons, assets/faceit-ranks/faceit1.svg .. faceit10.svg. Vite bundles whichever of them exist, so
 * the app builds and runs without them (a level then shows as a small "L7" text badge instead of its icon).
 */
const FACEIT_ICONS = import.meta.glob("../../assets/faceit-ranks/faceit*.svg", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

const faceitIcon = (level: number): string | null => FACEIT_ICONS[`../../assets/faceit-ranks/faceit${level}.svg`] ?? null;

/** Leetify's tier for a Premier rating: 0 below 5,000 (grey) up to 6 at 30,000 and more (gold), in 5,000-point steps. */
export const premierTier = (rating: number): number => Math.min(6, Math.max(0, Math.floor(rating / 5000)));

const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** Leetify's two vertical bars, the path of its cs-rating svg (viewBox 0 0 17 32). */
const BARS =
  "M5.44 2.13A2.6 2.6 0 0 1 7.99 0h1.86a.6.6 0 0 1 .6.7L4.83 31.5a.6.6 0 0 1-.6.5h-2.3c-1 0-1.76-.9-1.58-1.89l5.1-27.98ZM11.82.99c.1-.57.6-.99 1.18-.99h2.93a.6.6 0 0 1 .59.7l-5.4 30.31c-.1.57-.6.99-1.18.99H7a.6.6 0 0 1-.59-.7L11.82.98Z";

/** The Premier rating as Leetify shows it: "23," large and "532" small, in the colour of its 5,000-point tier. */
export function PremierRating({ rating }: { rating: number }) {
  const n = Math.round(rating);
  const thousands = Math.floor(n / 1000);
  return (
    <span className={`cs-rating tier-${premierTier(n)}`} title={`Premier rating ${n.toLocaleString("en-US")}`}>
      <svg viewBox="0 0 17 32" className="vertical-lines" aria-hidden="true"><path d={BARS} /></svg>
      <span className="label-outer">
        <span className="label-wrapper">
          {thousands > 0 ? (
            <>
              <span className="label-large">{thousands},</span>
              <span className="label-small">{String(n % 1000).padStart(3, "0")}</span>
            </>
          ) : (
            <span className="label-large">{n}</span>
          )}
        </span>
      </span>
    </span>
  );
}

/** The FACEIT level as its icon (or a text badge when the icon file isn't there), then the Elo. Either may be missing. */
export function FaceitRank({ level, elo }: { level: number | null; elo: number | null }) {
  const icon = level !== null ? faceitIcon(level) : null;
  const title = [level !== null && `FACEIT level ${level}`, elo !== null && `${elo.toLocaleString("en-US")} Elo`].filter(Boolean).join(" · ");
  return (
    <span className="faceit" title={title}>
      {level !== null && (icon ? <img className="faceit-icon" src={icon} alt={`FACEIT level ${level}`} draggable={false} />
                              : <span className="faceit-level">L{level}</span>)}
      {elo !== null && <span className="faceit-elo">{elo.toLocaleString("en-US")}</span>}
    </span>
  );
}

/**
 * Premier rating, FACEIT level and FACEIT Elo on one line, with no space between the Premier badge and the FACEIT
 * group. Nothing at all for a player who has none of the three. `compact` is the smaller size of the overlay.
 */
export function PlayerRanks({ m, compact }: { m: PlayerMetrics | null | undefined; compact?: boolean }) {
  const premier = num(m?.premier) && m.premier > 0 ? m.premier : null;
  const level = num(m?.faceit) && m.faceit >= 1 && m.faceit < 11 ? Math.floor(m.faceit) : null;
  const elo = num(m?.faceitElo) && m.faceitElo > 0 ? Math.round(m.faceitElo) : null;
  if (premier === null && level === null && elo === null) return null;
  return (
    <span className={`ranks${compact ? " ranks-compact" : ""}`}>
      {premier !== null && <PremierRating rating={premier} />}
      {(level !== null || elo !== null) && <FaceitRank level={level} elo={elo} />}
    </span>
  );
}
