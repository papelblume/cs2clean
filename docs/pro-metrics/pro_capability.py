#!/usr/bin/env python3
"""
pro_capability.py - what do professional CS2 players actually reach?

Reads the all-players.json written by the pro-metrics fetch (Leetify API, csst.at as
fallback) and measures, for every metric that assess.ts and reputation.ts look at, how
far real professionals get. The output is meant to be used LATER to set the
ELEVATED/HIGH/VERY_HIGH ranges (assess.ts) and the odd -> extreme ranges
(reputation.ts). This script does not suggest or set any threshold itself.

Usage
    python3 pro_capability.py [all-players.json]
        [--out-dir DIR] [--prefix NAME] [--list valve-top20 ...]
        [--min-matches N] [--window N] [--include-banned] [--top N]

Output (default: next to the input file)
    pro-capability.json          every metric: n, mean, std, percentiles, tail marks,
                                 the players/matches at the extreme end, and which
                                 TypeScript constant the metric informs
    pro-capability-players.csv   one row per player with all per-player metrics
    pro-capability-report.txt    the same summary as the table printed to the terminal

Only the Python standard library is used.

How the numbers are made (kept in step with the TypeScript on purpose)
  * Units are decided PER PROFILE exactly like reputation.ts does it: match ratings
    that are all below 1 in magnitude are fractions (x100 -> website units), percent
    stats with no value above 1 are fractions (x100), reaction times that are all
    between 0 and 10 are seconds (x1000). Every such decision is counted in the
    output ("unit_decisions") so a wrong guess shows up.
    NOTE: assess.ts calls ratingScale() from matches.ts, which was not available when
    this was written; rating_scale() below is a stand-in with the same intent.
  * Per-player mechanics use the lifetime stats, and fall back to the mean of the
    recent matches (at least 3 values, and at least MIN_MATCHES matches) like
    reputation.ts does.
  * Trajectory metrics (step, floor, spread, divergence) use the newest WINDOW rated
    matches (30, as in reputation.ts), with the same minimum group sizes.
  * "player" metrics have one value per player. "match" metrics pool every recent
    match of every player, so players with many matches weigh more there; they show
    what a pro can do in a SINGLE match.
  * Players with a ban on record are left out by default: their numbers are not
    evidence of what an honest player can do. --include-banned keeps them.
  * Percentiles use linear interpolation. The "tail" values are measured from the
    metric's extreme end (high for accuracy, low for preaim and reaction time):
    top_75pct is the value 75% of players are beyond (the bar the top three quarters
    clear), top_10pct is the value 10% of players are beyond, most_extreme is the single
    most extreme value. With few players, the 1% mark is practically the most extreme value.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# ----------------------------------------------------------------------------------
# Settings that mirror the TypeScript. If you change them there, change them here.
# ----------------------------------------------------------------------------------
WINDOW = 30                 # REPUTATION.window: newest rated matches that count
MIN_MATCHES = 5             # REPUTATION.minMatches / THRESHOLDS.minRecent
NEWEST = 10                 # REPUTATION.trajectory.newest
MIN_GROUP = 8               # REPUTATION.trajectory.minGroup
MIN_FLOOR_MATCHES = 15      # REPUTATION.trajectory.minFloorMatches
MIN_SPREAD_MATCHES = 15     # REPUTATION.trajectory.minSpreadMatches
FLOOR_MEAN_GATE = 2.0       # REPUTATION.trajectory.floorMean[0]: "floor" only counts above this mean rating
STRONG_CUTS = (2.0, 3.0, 4.0, 5.0)   # 3.0 is THRESHOLDS.rating.strongMatch; the others are for comparison

PERCENTILES = (0, 1, 5, 10, 25, 50, 75, 90, 95, 99, 100)
SMALL_N = 50                # below this many values the report marks n with a "*"


# ----------------------------------------------------------------------------------
# Metric catalogue
# ----------------------------------------------------------------------------------
@dataclass(frozen=True)
class Metric:
    key: str
    scope: str      # "player" (one value per player) or "match" (all recent matches pooled)
    family: str
    unit: str
    extreme: str    # "high" or "low": the end where a value is more capable / more suspicious
    informs: str    # the TypeScript constant this is meant to calibrate
    what: str


def _metrics() -> list[Metric]:
    m: list[Metric] = []
    A = m.append
    # Mechanics (reputation.ts) - lifetime stats, else mean of recent matches
    A(Metric("preaim", "player", "mechanics", "deg", "low", "REPUTATION.mechanics.preaim", "Crosshair placement error"))
    A(Metric("reaction_ms", "player", "mechanics", "ms", "low", "REPUTATION.mechanics.reaction", "Reaction time"))
    A(Metric("head_acc", "player", "mechanics", "%", "high", "REPUTATION.mechanics.headAcc, coherence.movingHeadAcc", "Share of shots that hit the head"))
    A(Metric("head_kills", "player", "mechanics", "%", "high", "REPUTATION.mechanics.headKills", "Share of kills that were headshots (csst.at only)"))
    A(Metric("spray_acc", "player", "mechanics", "%", "high", "REPUTATION.mechanics.sprayAcc", "Spray accuracy"))
    A(Metric("spotted_acc", "player", "mechanics", "%", "high", "REPUTATION.mechanics.spottedAcc", "Accuracy on spotted enemies"))
    A(Metric("opening_min", "player", "mechanics", "%", "high", "REPUTATION.mechanics.opening", "Lower of CT and T opening-duel win rate"))
    A(Metric("stopping", "player", "mechanics", "%", "high", "REPUTATION.mechanics.stopping", "Share of shots taken with good counter-strafing"))
    # Coherence (reputation.ts) and the aim/clutch signals (assess.ts)
    A(Metric("aim_rating", "player", "coherence", "0-100", "high", "THRESHOLDS.aim, REPUTATION.coherence.aimGate", "Leetify aim rating"))
    A(Metric("positioning_rating", "player", "coherence", "0-100", "high", "(context for aim_lead)", "Leetify positioning rating"))
    A(Metric("utility_rating", "player", "coherence", "0-100", "high", "(context for aim_lead)", "Leetify utility rating"))
    A(Metric("aim_lead", "player", "coherence", "points", "high", "REPUTATION.coherence.aimLead", "Aim rating minus mean of positioning and utility"))
    A(Metric("not_stopped", "player", "coherence", "%", "high", "REPUTATION.coherence.notStopped", "100 - stopping: share of shots NOT taken standing still"))
    A(Metric("clutch_rating", "player", "coherence", "API units", "high", "THRESHOLDS.clutch", "Leetify clutch rating as the API sends it"))
    # Rating (assess.ts)
    A(Metric("leetify_overall", "player", "rating", "website units", "high", "THRESHOLDS.rating.mean (no match history)", "Overall Leetify rating (ranks.leetify, else (CT+T)/2*100)"))
    A(Metric("recent_mean_rating", "player", "rating", "website units", "high", "THRESHOLDS.rating.mean, REPUTATION.trajectory.floorMean", "Mean rating of the recent matches"))
    for cut in STRONG_CUTS:
        tag = f"{cut:g}"
        extra = " (current strongMatch)" if cut == 3.0 else ""
        A(Metric(f"strong_share_ge_{tag}", "player", "rating", "share 0-1", "high", "THRESHOLDS.rating.strongShare", f"Share of recent matches rated >= {tag}{extra}"))
    # Trajectory (reputation.ts)
    A(Metric("step_effect", "player", "trajectory", "std devs", "high", "REPUTATION.trajectory.step", "Newest 10 matches vs. the older ones, pooled std devs"))
    A(Metric("floor_share", "player", "trajectory", "share 0-1", "high", "REPUTATION.trajectory.floor", "Share of recent matches at or above rating 0"))
    A(Metric("floor_share_in_form", "player", "trajectory", "share 0-1", "high", "REPUTATION.trajectory.floor", f"floor_share, only for players with mean rating >= {FLOOR_MEAN_GATE:g}"))
    A(Metric("reaction_cv", "player", "trajectory", "ratio", "low", "REPUTATION.trajectory.spread", "Match-to-match variation of reaction time (sd / mean)"))
    A(Metric("divergence", "player", "trajectory", "std devs", "high", "REPUTATION.trajectory.divergence", "Non-FACEIT matches vs. FACEIT matches, pooled std devs"))
    # Single matches, pooled
    A(Metric("match_rating", "match", "single match", "website units", "high", "THRESHOLDS.rating.strongMatch", "Leetify rating of one match"))
    A(Metric("match_preaim", "match", "single match", "deg", "low", "REPUTATION.mechanics.preaim", "Preaim in one match"))
    A(Metric("match_reaction_ms", "match", "single match", "ms", "low", "REPUTATION.mechanics.reaction", "Reaction time in one match"))
    A(Metric("match_head_acc", "match", "single match", "%", "high", "REPUTATION.mechanics.headAcc", "Head accuracy in one match"))
    A(Metric("match_spray_acc", "match", "single match", "%", "high", "REPUTATION.mechanics.sprayAcc", "Spray accuracy in one match"))
    A(Metric("match_spotted_acc", "match", "single match", "%", "high", "REPUTATION.mechanics.spottedAcc", "Spotted accuracy in one match"))
    return m


METRICS = _metrics()
METRIC_BY_KEY = {m.key: m for m in METRICS}
FAMILY_ORDER = ["mechanics", "coherence", "rating", "trajectory", "single match"]

# match field -> pooled metric key
MATCH_POOL = {
    "rating": "match_rating",
    "preaim": "match_preaim",
    "reaction": "match_reaction_ms",
    "head": "match_head_acc",
    "spray": "match_spray_acc",
    "spotted": "match_spotted_acc",
}


# ----------------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------------
def num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def opt(v: Any) -> Optional[float]:
    return float(v) if num(v) else None


def mean(xs: list[float]) -> float:
    return sum(xs) / len(xs)


def variance(xs: list[float]) -> float:
    """Sample variance (n - 1), like the TypeScript."""
    m = mean(xs)
    return sum((x - m) ** 2 for x in xs) / (len(xs) - 1)


def parse_ts(s: Any) -> Optional[float]:
    if not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def sig(x: float, digits: int = 6) -> float:
    """Round to significant digits so JSON stays short but small values keep precision."""
    return float(f"{x:.{digits}g}")


def percentile(sorted_vals: list[float], q: float) -> float:
    """Linear interpolation between closest ranks (q in 0..100)."""
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    pos = (n - 1) * q / 100.0
    lo = int(math.floor(pos))
    hi = min(lo + 1, n - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def fmt(v: Optional[float]) -> str:
    return "-" if v is None else f"{v:.4g}"


# ----------------------------------------------------------------------------------
# Unit decisions (mirrors reputation.ts)
# ----------------------------------------------------------------------------------
def rating_scale(vals: list[float]) -> Optional[int]:
    """Stand-in for ratingScale() in matches.ts: ratings that all sit inside (-1, 1) are fractions."""
    if not vals:
        return None
    return 100 if all(abs(v) < 1 for v in vals) else 1


def pct_scale(vals: list[Any]) -> Optional[int]:
    """A real percentage of these stats is far above 1, so any value above 1 means percent."""
    nums = [v for v in vals if num(v)]
    if not nums:
        return None
    return 1 if any(v > 1 for v in nums) else 100


def ms_scale(vals: list[Any]) -> Optional[int]:
    nums = [v for v in vals if num(v)]
    if not nums:
        return None
    return 1000 if all(0 < v < 10 for v in nums) else 1


# ----------------------------------------------------------------------------------
# Match handling
# ----------------------------------------------------------------------------------
def collect_matches(profile: dict, window: int) -> list[dict]:
    """Rated recent matches, newest first, at most `window` (same rules as reputation.ts)."""
    rows = []
    for i, m in enumerate(profile.get("recent_matches") or []):
        if not isinstance(m, dict) or not num(m.get("leetify_rating")):
            continue
        ts = parse_ts(m.get("finished_at"))
        rows.append(((-ts if ts is not None else math.inf), i, m))
    rows.sort(key=lambda r: (r[0], r[1]))
    return [r[2] for r in rows[:window]]


METRICS_FOR_SHIFT = (("rating", 1), ("preaim", -1), ("reaction", -1), ("head", 1))


def shift_effect(a: list[dict], b: list[dict]) -> Optional[float]:
    """How much better group a is than group b, in pooled std devs, averaged over the metrics with
    enough values in both (lower preaim / reaction count as better). None with fewer than two metrics."""
    ds = []
    for field, direction in METRICS_FOR_SHIFT:
        x = [m[field] for m in a if m[field] is not None]
        y = [m[field] for m in b if m[field] is not None]
        if len(x) < 5 or len(y) < 5:
            continue
        sd = math.sqrt(((len(x) - 1) * variance(x) + (len(y) - 1) * variance(y)) / (len(x) + len(y) - 2))
        if not sd > 0:
            continue
        ds.append(max(-4.0, min(4.0, direction * (mean(x) - mean(y)) / sd)))
    return mean(ds) if len(ds) >= 2 else None


# ----------------------------------------------------------------------------------
# One player
# ----------------------------------------------------------------------------------
def analyze_player(profile: dict, window: int) -> dict:
    st = profile.get("stats") or {}
    rt = profile.get("rating") or {}
    rk = profile.get("ranks") or {}

    raw = collect_matches(profile, window)
    sc = {
        "rating": rating_scale([m["leetify_rating"] for m in raw]),
        "head": pct_scale([st.get("accuracy_head")] + [m.get("accuracy_head") for m in raw]),
        "spray": pct_scale([st.get("spray_accuracy")] + [m.get("spray_accuracy") for m in raw]),
        "spotted": pct_scale([st.get("accuracy_enemy_spotted")] + [m.get("accuracy_enemy_spotted") for m in raw]),
        "stopping": pct_scale([st.get("counter_strafing_good_shots_ratio")]),
        "opening": pct_scale([st.get("ct_opening_duel_success_percentage"), st.get("t_opening_duel_success_percentage")]),
        "ms": ms_scale([st.get("reaction_time_ms")] + [m.get("reaction_time_ms") for m in raw]),
    }

    def scaled(v: Any, key: str) -> Optional[float]:
        return v * (sc[key] or 1) if num(v) else None

    ms = [{
        "id": m.get("id"),
        "finished_at": m.get("finished_at"),
        "rating": m["leetify_rating"] * (sc["rating"] or 1),
        "preaim": opt(m.get("preaim")),
        "reaction": scaled(m.get("reaction_time_ms"), "ms"),
        "head": scaled(m.get("accuracy_head"), "head"),
        "spray": scaled(m.get("spray_accuracy"), "spray"),
        "spotted": scaled(m.get("accuracy_enemy_spotted"), "spotted"),
        "faceit": str(m.get("data_source") or "").lower() == "faceit",
    } for m in raw]

    aggregate_only = len(ms) < MIN_MATCHES
    fallback = [] if aggregate_only else ms

    def stat(profile_val: Any, per_match: list[Optional[float]], scale_key: Optional[str] = None) -> Optional[float]:
        # Lifetime stats win; the recent matches fill in when they are missing (at least 3 values).
        if num(profile_val):
            return profile_val * ((sc[scale_key] or 1) if scale_key else 1)
        vals = [v for v in per_match if v is not None]
        return mean(vals) if len(vals) >= 3 else None

    v: dict[str, float] = {}

    def put(key: str, value: Optional[float]) -> None:
        if value is not None and math.isfinite(value):
            v[key] = value

    # --- mechanics
    preaim = stat(st.get("preaim"), [m["preaim"] for m in fallback])
    reaction = stat(st.get("reaction_time_ms"), [m["reaction"] for m in fallback], "ms")
    head = stat(st.get("accuracy_head"), [m["head"] for m in fallback], "head")
    spray = stat(st.get("spray_accuracy"), [m["spray"] for m in fallback], "spray")
    spotted = stat(st.get("accuracy_enemy_spotted"), [m["spotted"] for m in fallback], "spotted")
    head_kills = opt(st.get("headshot_kill_percentage"))
    stopping = scaled(st.get("counter_strafing_good_shots_ratio"), "stopping")
    open_ct = scaled(st.get("ct_opening_duel_success_percentage"), "opening")
    open_t = scaled(st.get("t_opening_duel_success_percentage"), "opening")
    put("preaim", preaim)
    put("reaction_ms", reaction)
    put("head_acc", head)
    put("head_kills", head_kills)
    put("spray_acc", spray)
    put("spotted_acc", spotted)
    put("stopping", stopping)
    if open_ct is not None and open_t is not None:
        put("opening_min", min(open_ct, open_t))

    # --- coherence
    aim, pos, util = opt(rt.get("aim")), opt(rt.get("positioning")), opt(rt.get("utility"))
    put("aim_rating", aim)
    put("positioning_rating", pos)
    put("utility_rating", util)
    if aim is not None and pos is not None and util is not None:
        put("aim_lead", aim - (pos + util) / 2)
    if stopping is not None:
        put("not_stopped", 100 - stopping)
    put("clutch_rating", opt(rt.get("clutch")))

    # --- rating (assess.ts)
    if num(rk.get("leetify")):
        leetify = float(rk["leetify"])
    else:
        ct, t = rt.get("ct_leetify"), rt.get("t_leetify")
        leetify = ((ct + t) / 2) * 100 if num(ct) and num(t) else None
    put("leetify_overall", leetify)
    if len(ms) >= MIN_MATCHES:
        ratings = [m["rating"] for m in ms]
        put("recent_mean_rating", mean(ratings))
        for cut in STRONG_CUTS:
            put(f"strong_share_ge_{cut:g}", sum(1 for r in ratings if r >= cut) / len(ratings))

    # --- trajectory (ms is newest first)
    newest, older = ms[:NEWEST], ms[NEWEST:]
    if len(older) >= MIN_GROUP:
        put("step_effect", shift_effect(newest, older))
    if len(ms) >= MIN_FLOOR_MATCHES:
        ratings = [m["rating"] for m in ms]
        share = 1 - sum(1 for r in ratings if r < 0) / len(ratings)
        put("floor_share", share)
        if mean(ratings) >= FLOOR_MEAN_GATE:
            put("floor_share_in_form", share)
    reactions = [m["reaction"] for m in ms if m["reaction"] is not None]
    if len(reactions) >= MIN_SPREAD_MATCHES and mean(reactions) > 0:
        put("reaction_cv", math.sqrt(variance(reactions)) / mean(reactions))
    off = [m for m in ms if not m["faceit"]]
    on = [m for m in ms if m["faceit"]]
    if len(off) >= MIN_GROUP and len(on) >= MIN_GROUP:
        put("divergence", shift_effect(off, on))

    return {"values": v, "matches": ms, "scales": sc, "aggregate_only": aggregate_only}


# ----------------------------------------------------------------------------------
# Summaries
# ----------------------------------------------------------------------------------
def summarize(items: list[tuple[float, dict]], extreme: str, top: int) -> dict:
    vals = sorted(x for x, _ in items)
    n = len(vals)
    pct = {f"p{q}": sig(percentile(vals, q)) for q in PERCENTILES}
    if extreme == "high":
        marks = (("top_85pct", 15), ("top_75pct", 25), ("top_10pct", 90), ("top_5pct", 95), ("top_1pct", 99), ("most_extreme", 100))
    else:
        marks = (("top_85pct", 85), ("top_75pct", 75), ("top_10pct", 10), ("top_5pct", 5), ("top_1pct", 1), ("most_extreme", 0))
    tail = {name: sig(percentile(vals, q)) for name, q in marks}
    ordered = sorted(items, key=lambda it: it[0], reverse=(extreme == "high"))
    return {
        "n": n,
        "small_sample": n < SMALL_N,
        "mean": sig(mean(vals)),
        "std": sig(math.sqrt(variance(vals))) if n > 1 else 0.0,
        "min": sig(vals[0]),
        "max": sig(vals[-1]),
        "median": pct["p50"],
        "percentiles": pct,
        "tail": tail,
        "extreme_players": [{"value": sig(x), **label} for x, label in ordered[:top]],
    }


def who_text(entry: dict) -> str:
    name = entry.get("player") or entry.get("steam64_id") or "?"
    if "finished_at" in entry and entry.get("finished_at"):
        return f"{name} ({str(entry['finished_at'])[:10]})"
    return str(name)


def render_report(meta: dict, summaries: dict[str, dict]) -> str:
    L: list[str] = []
    cov = meta["coverage"]
    L.append("PRO CAPABILITY REPORT")
    L.append("=" * 21)
    L.append(f"input: {meta['input']}   generated: {meta['generated_at']}")
    L.append(f"players analyzed: {cov['players_analyzed']} of {cov['entries_in_file']} entries"
             f"   (with match history: {cov['with_match_history']}, recent matches pooled: {cov['matches_pooled']})")
    if cov["skipped"]:
        L.append("skipped: " + ", ".join(f"{k}={n}" for k, n in sorted(cov["skipped"].items())))
    if cov["excluded_bans"]:
        L.append("left out (ban on record): " + ", ".join(cov["excluded_bans"]))
    L.append("by source: " + ", ".join(f"{k}={n}" for k, n in sorted(cov["by_source"].items())) +
             "   by list: " + ", ".join(f"{k}={n}" for k, n in sorted(cov["by_pro_list"].items())))
    ud = meta["unit_decisions"]
    L.append("unit decisions: " + ", ".join(f"{k}={n}" for k, n in sorted(ud["counts"].items())) if ud["counts"] else "unit decisions: none")
    for w in ud["warnings"]:
        L.append("  WARNING: " + w)
    L.append("")
    L.append("Tail columns are measured from each metric's extreme end (end = high or low):")
    L.append("85% / 75% / 10% / 5% / 1% = the value that share of players is beyond (75% = the top three quarters of players);")
    L.append("extreme = the single most extreme value.")
    L.append("n marked * has fewer than %d values: the tail marks are rough there." % SMALL_N)
    for fam in FAMILY_ORDER:
        rows = [(m, summaries[m.key]) for m in METRICS if m.family == fam and m.key in summaries]
        if not rows:
            continue
        L.append("")
        L.append(f"[{fam}]")
        L.append(f"{'metric':<22}{'n':>6} {'end':<5}{'median':>9}{'85%':>9}{'75%':>9}{'10%':>9}{'5%':>9}{'1%':>9}{'extreme':>9}   {'unit':<14}who")
        for m, s in rows:
            n = f"{s['n']}{'*' if s['small_sample'] else ''}"
            t = s["tail"]
            who = who_text(s["extreme_players"][0]) if s["extreme_players"] else ""
            L.append(f"{m.key:<22}{n:>6} {m.extreme:<5}{fmt(s['median']):>9}{fmt(t['top_85pct']):>9}{fmt(t['top_75pct']):>9}{fmt(t['top_10pct']):>9}"
                     f"{fmt(t['top_5pct']):>9}{fmt(t['top_1pct']):>9}{fmt(t['most_extreme']):>9}   {m.unit:<14}{who}")
    missing = [m.key for m in METRICS if m.key not in summaries]
    if missing:
        L.append("")
        L.append("no data for: " + ", ".join(missing))
    L.append("")
    L.append("Full percentiles, mean/std and the most extreme players per metric are in the JSON.")
    return "\n".join(L) + "\n"


# ----------------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------------
def load_entries(path: Path) -> list:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        for key in ("players", "results", "entries"):
            if isinstance(data.get(key), list):
                return data[key]
        sys.exit(f"{path}: expected a JSON array of players (or an object holding one)")
    if not isinstance(data, list):
        sys.exit(f"{path}: expected a JSON array of players")
    return data


def main() -> None:
    ap = argparse.ArgumentParser(description="Measure what professional CS2 players reach, per metric.")
    ap.add_argument("input", nargs="?", default="all-players.json", help="all-players.json (default: ./all-players.json)")
    ap.add_argument("--out-dir", help="where to write the results (default: the input file's folder)")
    ap.add_argument("--prefix", default="pro-capability", help="output file name prefix")
    ap.add_argument("--list", action="append", metavar="NAME", help="only players whose pro.list is NAME (repeatable), e.g. valve-top20")
    ap.add_argument("--min-matches", type=int, default=0, metavar="N",
                    help="skip profiles whose total_matches is below N (csst.at profiles may report only their stats window)")
    ap.add_argument("--window", type=int, default=WINDOW, metavar="N", help=f"newest rated matches per player (default {WINDOW})")
    ap.add_argument("--include-banned", action="store_true", help="keep players with a ban on record")
    ap.add_argument("--top", type=int, default=5, metavar="N", help="extreme players/matches listed per metric in the JSON (default 5)")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.is_file():
        sys.exit(f"input not found: {src}")
    out_dir = Path(args.out_dir) if args.out_dir else src.resolve().parent
    out_dir.mkdir(parents=True, exist_ok=True)

    entries = load_entries(src)

    items: dict[str, list[tuple[float, dict]]] = defaultdict(list)
    rows: list[dict] = []
    skipped: Counter = Counter()
    banned_names: list[str] = []
    by_source: Counter = Counter()
    by_list: Counter = Counter()
    privacy: Counter = Counter()
    unit_counts: Counter = Counter()
    odd_units: dict[str, list[str]] = defaultdict(list)
    with_history = 0
    with_premier = 0
    matches_pooled = 0

    for e in entries:
        if not isinstance(e, dict):
            skipped["not_an_object"] += 1
            continue
        if e.get("status") != "ok":
            skipped[f"status_{e.get('status')}"] += 1
            continue
        profile = e.get("profile")
        if not isinstance(profile, dict):
            skipped["no_profile"] += 1
            continue
        pro = e.get("pro") if isinstance(e.get("pro"), dict) else {}
        name = pro.get("player") or profile.get("name") or str(e.get("steam64_id") or "?")
        sid = str(e.get("steam64_id") or profile.get("steam64_id") or "")

        if args.list and pro.get("list") not in args.list:
            skipped["list_filter"] += 1
            continue
        if [b for b in (profile.get("bans") or []) if b] and not args.include_banned:
            skipped["banned"] += 1
            banned_names.append(str(name))
            continue
        total = profile.get("total_matches")
        if args.min_matches and not (num(total) and total >= args.min_matches):
            skipped["below_min_matches"] += 1
            continue

        res = analyze_player(profile, args.window)
        label = {"player": name, "steam64_id": sid}
        for key, value in res["values"].items():
            items[key].append((value, label))
        for m in res["matches"]:
            for field, key in MATCH_POOL.items():
                if m[field] is not None:
                    items[key].append((m[field], {**label, "match_id": m["id"], "finished_at": m["finished_at"]}))
        matches_pooled += len(res["matches"])

        # bookkeeping
        by_source[str(e.get("source"))] += 1
        by_list[str(pro.get("list"))] += 1
        privacy[str(profile.get("privacy_mode"))] += 1
        if not res["aggregate_only"]:
            with_history += 1
        prem = (profile.get("ranks") or {}).get("premier")
        if num(prem) and prem > 0:
            with_premier += 1
        sc = res["scales"]
        if sc["rating"] is not None:
            unit_counts[f"match_rating_x{sc['rating']}"] += 1
        for k in ("head", "spray", "spotted", "stopping", "opening"):
            if sc[k] == 100:
                unit_counts[f"{k}_x100(fraction)"] += 1
                odd_units[str(name)].append(f"{k}_x100")
        if sc["ms"] == 1000:
            unit_counts["reaction_x1000(seconds)"] += 1
            odd_units[str(name)].append("reaction_x1000")

        rows.append({
            "steam64_id": sid, "name": name, "team": pro.get("team"), "list": pro.get("list"),
            "source": e.get("source"), "privacy_mode": profile.get("privacy_mode"),
            "total_matches": total if num(total) else None,
            "matches_used": len(res["matches"]),
            **res["values"],
        })

    if not rows:
        sys.exit("no usable players after filtering; nothing to compute")

    warnings = []
    if unit_counts.get("match_rating_x100") and unit_counts.get("match_rating_x1"):
        warnings.append("match ratings were read as fractions for some players and as website units for others; check rating_scale()")
    if odd_units:
        warnings.append(f"{len(odd_units)} player(s) had a stat read as a fraction/seconds (x100 / x1000); "
                        "see unit_decisions.players in the JSON and check their raw values")

    summaries = {m.key: summarize(items[m.key], m.extreme, args.top) for m in METRICS if items.get(m.key)}

    meta = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "input": str(src),
        "settings": {
            "window": args.window, "min_matches_per_player_filter": args.min_matches,
            "lists": args.list or "all", "include_banned": args.include_banned,
            "min_recent_matches_for_match_signals": MIN_MATCHES, "newest_group": NEWEST,
            "min_group": MIN_GROUP, "floor_mean_gate": FLOOR_MEAN_GATE, "strong_cuts": list(STRONG_CUTS),
        },
        "coverage": {
            "entries_in_file": len(entries), "players_analyzed": len(rows), "skipped": dict(skipped),
            "excluded_bans": banned_names, "by_source": dict(by_source), "by_pro_list": dict(by_list),
            "privacy_mode": dict(privacy), "with_match_history": with_history,
            "with_premier_rating": with_premier, "matches_pooled": matches_pooled,
        },
        "unit_decisions": {"counts": dict(unit_counts), "warnings": warnings, "players": dict(odd_units)},
    }

    report = render_report(meta, summaries)

    out_json = out_dir / f"{args.prefix}.json"
    out_csv = out_dir / f"{args.prefix}-players.csv"
    out_txt = out_dir / f"{args.prefix}-report.txt"

    payload = {
        **meta,
        "metrics": {
            key: {
                "family": METRIC_BY_KEY[key].family, "scope": METRIC_BY_KEY[key].scope,
                "unit": METRIC_BY_KEY[key].unit, "extreme_end": METRIC_BY_KEY[key].extreme,
                "informs": METRIC_BY_KEY[key].informs, "what": METRIC_BY_KEY[key].what,
                **s,
            } for key, s in summaries.items()
        },
    }
    with out_json.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")

    player_keys = [m.key for m in METRICS if m.scope == "player"]
    fields = ["steam64_id", "name", "team", "list", "source", "privacy_mode", "total_matches", "matches_used"] + player_keys
    with out_csv.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: (sig(x) if isinstance(x, float) else x) for k, x in r.items()})

    out_txt.write_text(report, encoding="utf-8")

    sys.stdout.write(report)
    print(f"wrote {out_json}\nwrote {out_csv}\nwrote {out_txt}")


if __name__ == "__main__":
    main()
