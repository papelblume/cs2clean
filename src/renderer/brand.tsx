// CS2Clean brand pieces.

import type { ReputationTier } from "../shared/reputation-types";
import type { EvidenceClass, Side } from "../shared/types";

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <circle cx="14" cy="14" r="9.5" fill="none" stroke="currentColor" strokeWidth="2.6" />
      <path d="M21 21l7 7" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M14 7.5v4M14 16.5v4M7.5 14h4M16.5 14h4" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="14" cy="14" r="1.3" fill="var(--accent)" />
    </svg>
  );
}

/** A trash can, for taking something off a list. Draws in the current text colour. */
export function TrashIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
      <path d="M5.5 6l1 13.5A2 2 0 0 0 8.5 21.4h7a2 2 0 0 0 2-1.9L18.5 6" />
      <path d="M10 10.5v6M14 10.5v6" />
    </svg>
  );
}

/** A disclosure arrow: points down when `open`, right when closed. Draws in the current text colour. */
export function ChevronIcon({ open, size = 18 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" className={`chevron${open ? "" : " closed"}`}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** The brand wordmark: "CS2" in accent colour, "Clean" in the default colour. */
export function Wordmark({ domain }: { domain?: string | null }) {
  if (domain && domain.trim()) {
    const [name, tld] = splitDomain(domain);
    return (
      <span className="wordmark">
        {name}
        {tld && <span className="wordmark-tld">.{tld}</span>}
      </span>
    );
  }
  return (
    <span className="wordmark">
      <span className="wordmark-accent">CS2</span>Clean
    </span>
  );
}

function splitDomain(domain?: string | null): [string, string | null] {
  const d = (domain || "").trim();
  const i = d.lastIndexOf(".");
  return i > 0 ? [d.slice(0, i), d.slice(i + 1)] : [d, null];
}

const LABELS: Record<EvidenceClass, string> = {
  NORMAL: "Normal",
  ELEVATED: "Elevated",
  HIGH: "High",
  VERY_HIGH: "Very high",
  INSUFFICIENT_DATA: "Not enough data",
};

const HINTS: Record<EvidenceClass, string> = {
  NORMAL: "Nothing unusual in the Leetify ratings or stats.",
  ELEVATED: "Ratings above average or a few unusual stats. Good players produce these.",
  HIGH: "Ratings well above average, or stats that look unlikely for the rank. Top players and smurfs look like this too.",
  VERY_HIGH: "Exceptional ratings, stats that look implausible together, or a ban on record. Statistics, not proof of cheating.",
  INSUFFICIENT_DATA: "No public Leetify profile, or too few recent matches.",
};

/** Names for the reputation tiers shown on the player cards. */
export const TIER_LABELS: Record<ReputationTier, string> = {
  TRUSTED: "Trusted",
  NORMAL: "Normal",
  WATCH: "Watch",
  SUSPICIOUS: "Suspicious",
  VERY_SUSPICIOUS: "Very suspicious",
  BANNED: "Banned",
  UNKNOWN: "Unknown",
};

export function ClassBadge({ value, compact }: { value: EvidenceClass; compact?: boolean }) {
  const label = compact && value === "INSUFFICIENT_DATA" ? "No data" : LABELS[value];
  return (
    <span className={`badge badge-${value.toLowerCase()}`} title={`${LABELS[value]}. ${HINTS[value]}`}>
      <span className="badge-dot" />
      {label}
    </span>
  );
}

export function SideEmblem({ side, size = 18 }: { side: Side | null; size?: number }) {
  if (side === "T")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="T" className="emblem">
        <path d="M12 1.5l9.5 10.5L12 22.5 2.5 12z" fill="var(--t)" />
        <path d="M12 6.5c1.8 2.4 3.6 4 3.6 6.4A3.6 3.6 0 0112 16.5a3.6 3.6 0 01-3.6-3.6c0-1.2.6-2.2 1.4-3 .1 1.2.8 2 1.7 2.2-.3-2 .1-4 .5-5.6z" fill="#1a1206" />
      </svg>
    );
  if (side === "CT")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="CT" className="emblem">
        <path d="M12 1.5l9 3.2v6.8c0 5.4-3.8 9.4-9 11-5.2-1.6-9-5.6-9-11V4.7z" fill="var(--ct)" />
        <path d="M7 9.5l5 3.5 5-3.5M7 13.5l5 3.5 5-3.5" fill="none" stroke="#08131f" strokeWidth="1.9" strokeLinejoin="round" />
      </svg>
    );
  return <span className="emblem-none" style={{ width: size, height: size }} />;
}

const MAPS: Record<string, string> = {
  de_mirage: "Mirage", de_dust2: "Dust II", de_inferno: "Inferno", de_nuke: "Nuke", de_ancient: "Ancient",
  de_anubis: "Anubis", de_vertigo: "Vertigo", de_overpass: "Overpass", de_train: "Train",
};

export const mapName = (m: string | null | undefined) =>
  m ? (MAPS[m] ?? m.replace(/^de_|^cs_/, "").replace(/(^|_)\w/g, (c) => c.replace("_", " ").toUpperCase())) : null;

export const DISCLAIMER =
  "Player data is retrieved from Leetify’s public API, or from csst.at when Leetify has no profile for a player. The app rates each stat Low, Medium or High using Leetify’s Data Library and the stats of professional players: High is the level of a median pro (3670 elo) or better, and Medium roughly the level of an average FACEIT Level 7 player or better. Players with a private profile are shown from their lifetime stats only, and players with no data on Leetify or csst.at can’t be shown.";
