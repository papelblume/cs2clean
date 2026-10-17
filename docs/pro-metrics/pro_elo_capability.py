#!/usr/bin/env python3
"""
pro_elo_capability.py - what is a player capable of at a given FACEIT elo?

Companion to pro_capability.py. It reads the same all-players.json, takes every
professional's FACEIT elo (profile.ranks.faceit_elo as fetched) and measures how the
metrics that assess.ts and reputation.ts look at depend on it. The output is meant to be
used LATER to make the ELEVATED/HIGH/VERY_HIGH ranges (assess.ts) and the odd -> extreme
ranges (reputation.ts) depend on elo. This script does not suggest or set any threshold.

Usage
    python3 pro_elo_capability.py [all-players.json]
        [--bands N | --band-edges 3000,3500,4000]
        [--elo 3200 --elo 4000 ...] [--k N]
        [--out-dir DIR] [--prefix NAME] [--list valve-top20 ...]
        [--min-matches N] [--window N] [--include-banned]

Output (default: next to the input file)
    pro-elo-capability.json          per metric: how strongly elo moves it, the numbers per
                                     elo band, and the numbers around every --elo asked for
    pro-elo-capability-players.csv   one row per player: faceit_elo, band and all metrics
    pro-elo-capability-report.txt    the same summary as the tables printed to the terminal

Only the Python standard library is used. The metrics (same names, units and "extreme end"
as pro_capability.py), the unit decisions and the minimum sample sizes are the same as in
that script, so the numbers can be compared. The metric code is copied, not imported, so
this file works on its own.

Three views of the same data
  1. relationship  Does a higher elo change the metric at all? Spearman rank correlation
                   (rho, with its t-statistic) and a straight-line fit: the change per
                   +1000 elo, and how far that moves the metric between the 10th and the
                   90th percentile elo, in the metric's unit and in its own std devs.
                   |t| >= 3 is labelled "yes", >= 2 "weak", otherwise "no". The straight
                   line is the empirical counterpart of REPUTATION.band in reputation.ts,
                   which shifts the thresholds linearly with the Premier rating. Only for
                   "player" metrics (one value per player); the pooled single-match
                   metrics are clustered by player, so no significance is claimed there.
  2. bands         Players split by elo (default 4 equal-count bands, or --band-edges).
                   Per band: n, median, percentiles and the extreme end of the metric.
  3. --elo X       The K players whose elo is closest to X (--k, default 40; players tied
                   at the boundary distance are kept) and the same numbers for them. This
                   answers "what do players around this elo reach". Nothing is
                   extrapolated: an elo outside the observed range gets the players
                   closest to it, and a warning.

Read this before using the numbers
  * The sample is professionals, so the elo range is narrow and high. Do not read the
    numbers for lower elo. With few players per band the tail marks are rough (n < 20 is
    marked "*"); the single most extreme value is one player or one match.
  * faceit_elo is the value at fetch time. Recent matches may have been played at another
    elo, and the stats are lifetime figures. Players without a faceit_elo are skipped
    (counted in the report).
  * Players with a ban on record are left out by default (--include-banned keeps them).
  * "Extreme end" is as in pro_capability.py: low for preaim, reaction time and reaction
    variation, high for the rest. The "10% / 5% / 1%" columns are the values that share of
    the group is beyond, measured from that end.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from bisect import bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# ----------------------------------------------------------------------------------
# Settings that mirror the TypeScript (same as pro_capability.py)
# ----------------------------------------------------------------------------------
WINDOW = 30                 # REPUTATION.window: newest rated matches that count
MIN_MATCHES = 5             # REPUTATION.minMatches / THRESHOLDS.minRecent
NEWEST = 10                 # REPUTATION.trajectory.newest
MIN_GROUP = 8               # REPUTATION.trajectory.minGroup
MIN_FLOOR_MATCHES = 15      # REPUTATION.trajectory.minFloorMatches
MIN_SPREAD_MATCHES = 15     # REPUTATION.trajectory.minSpreadMatches
FLOOR_MEAN_GATE = 2.0       # REPUTATION.trajectory.floorMean[0]
STRONG_CUTS = (2.0, 3.0, 4.0, 5.0)   # 3.0 is THRESHOLDS.rating.strongMatch

# ----------------------------------------------------------------------------------
# Settings of this script
# ----------------------------------------------------------------------------------
DEFAULT_BANDS = 4
DEFAULT_K = 40              # players per --elo window
SMALL_N = 20                # a band / window with fewer values than this is marked "*"
MIN_PLAYERS = 8             # fewer players with an elo than this: nothing worth computing
MIN_FIT_N = 8               # fewer values than this: no relationship is fitted
T_CLEAR = 3.0               # |t| of the rank correlation: "yes"
T_WEAK = 2.0                # ... "weak"
LOPSIDED = 0.2              # a window is one-sided when the asked elo sits in its outer 20%


# ----------------------------------------------------------------------------------
# Metric catalogue (same as pro_capability.py)
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

# The constants in REPUTATION.band that already move a threshold with rank (per Premier band).
BAND_CONSTANT = {
    "preaim": "REPUTATION.band.preaimDeg",
    "reaction_ms": "REPUTATION.band.reactionMs",
    "head_acc": "REPUTATION.band.accuracyPts",
    "spray_acc": "REPUTATION.band.accuracyPts",
    "spotted_acc": "REPUTATION.band.accuracyPts",
    "opening_min": "REPUTATION.band.openingPts",
}

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
# Unit decisions (mirrors reputation.ts; same as pro_capability.py)
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
# Match handling (same as pro_capability.py)
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
# One player (same as pro_capability.py)
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
# FACEIT elo
# ----------------------------------------------------------------------------------
def get_elo(entry: dict, profile: dict) -> Optional[float]:
    """profile.ranks.faceit_elo; a few other places are tried in case a fallback source files it elsewhere.
    Zero or negative means "no FACEIT account linked", not an elo of zero."""
    candidates = ((profile.get("ranks") or {}).get("faceit_elo"), profile.get("faceit_elo"), entry.get("faceit_elo"))
    for c in candidates:
        if num(c) and c > 0:
            return float(c)
    return None


# ----------------------------------------------------------------------------------
# Statistics
# ----------------------------------------------------------------------------------
def avg_ranks(vals: list[float]) -> list[float]:
    """1-based ranks; tied values share the average of their ranks."""
    order = sorted(range(len(vals)), key=lambda i: vals[i])
    ranks = [0.0] * len(vals)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = r
        i = j + 1
    return ranks


def pearson(x: list[float], y: list[float]) -> Optional[float]:
    mx, my = mean(x), mean(y)
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    if not (sxx > 0 and syy > 0):
        return None
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / math.sqrt(sxx * syy)


def ols(xs: list[float], ys: list[float]) -> Optional[tuple[float, float, float, float, float]]:
    """slope, intercept, r2, residual std, slope standard error; None without any spread in x."""
    n = len(xs)
    mx, my = mean(xs), mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if not sxx > 0:
        return None
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    intercept = my - slope * mx
    sse = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(xs, ys))
    syy = sum((y - my) ** 2 for y in ys)
    r2 = 1 - sse / syy if syy > 0 else 0.0
    s2 = sse / (n - 2)
    return slope, intercept, r2, math.sqrt(s2), math.sqrt(s2 / sxx)


def relationship(points: list[tuple[float, float]], extreme: str, elo_p10: float, elo_p90: float) -> Optional[dict]:
    """How a metric moves with elo. points: (elo, value), one per player."""
    n = len(points)
    if n < MIN_FIT_N:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    rho = pearson(avg_ranks(xs), avg_ranks(ys))
    fit = ols(xs, ys)
    if rho is None or fit is None:
        return None
    slope, intercept, r2, resid_sd, se = fit
    t = rho * math.sqrt((n - 2) / (1 - rho * rho)) if abs(rho) < 1 else math.copysign(999.0, rho)
    t = max(-999.0, min(999.0, t))
    y_sd = math.sqrt(variance(ys))
    shift = slope * (elo_p90 - elo_p10)
    effect = "yes" if abs(t) >= T_CLEAR else "weak" if abs(t) >= T_WEAK else "no"
    return {
        "n": n,
        "spearman_rho": sig(rho, 4),
        "t": sig(t, 4),
        "effect": effect,
        "slope_per_elo": slope,                 # value = intercept + slope_per_elo * faceit_elo
        "intercept": intercept,
        "slope_per_1000": sig(slope * 1000),
        "slope_se_per_1000": sig(se * 1000),
        "r2": sig(r2, 4),
        "residual_std": sig(resid_sd),
        "metric_std": sig(y_sd),
        "shift_p10_to_p90_elo": sig(shift),
        "shift_in_metric_std": sig(shift / y_sd, 4) if y_sd > 0 else 0.0,
        "moves_toward_extreme": bool((slope > 0) == (extreme == "high")),
    }


def summarize_group(items: list[tuple[float, dict]], extreme: str) -> Optional[dict]:
    """items: (value, label). The numbers of one group (a band, or the players around an elo)."""
    n = len(items)
    if n == 0:
        return None
    vals = sorted(x for x, _ in items)
    pct = {f"p{q}": sig(percentile(vals, q)) for q in (5, 10, 25, 50, 75, 90, 95)}
    if extreme == "high":
        marks = (("top_10pct", 90), ("top_5pct", 95), ("top_1pct", 99), ("most_extreme", 100))
        best = max(items, key=lambda it: it[0])
    else:
        marks = (("top_10pct", 10), ("top_5pct", 5), ("top_1pct", 1), ("most_extreme", 0))
        best = min(items, key=lambda it: it[0])
    return {
        "n": n,
        "small_sample": n < SMALL_N,
        "mean": sig(mean(vals)),
        "std": sig(math.sqrt(variance(vals))) if n > 1 else 0.0,
        "min": sig(vals[0]),
        "max": sig(vals[-1]),
        "median": pct["p50"],
        "percentiles": pct,
        "tail": {name: sig(percentile(vals, q)) for name, q in marks},
        "most_extreme_by": {"value": sig(best[0]), **best[1]},
    }


# ----------------------------------------------------------------------------------
# Bands and windows
# ----------------------------------------------------------------------------------
def make_edges(elos_sorted: list[float], n_bands: int, custom: Optional[list[float]]) -> list[float]:
    """Band edges: a player belongs to the band whose lower edge is the highest one <= elo."""
    if custom is not None:
        return list(custom)
    # Equal-count edges at the elo percentiles. With many tied elos an edge can land on the lowest elo or in a
    # gap, which would give an empty band: such edges are dropped, so there may be fewer bands than asked for.
    edges: list[float] = []
    for i in range(1, n_bands):
        e = percentile(elos_sorted, 100.0 * i / n_bands)
        if elos_sorted[0] < e <= elos_sorted[-1] and (not edges or e > edges[-1]):
            edges.append(e)
    while True:
        bounds = [-math.inf] + edges + [math.inf]
        empty = next((b for b in range(len(bounds) - 1)
                      if not any(bounds[b] <= x < bounds[b + 1] for x in elos_sorted)), None)
        if empty is None:
            return edges
        del edges[empty if empty < len(edges) else empty - 1]


def nearest_players(elos: list[float], x: float, k: int) -> list[int]:
    """The k players closest in elo to x, plus any tied with the k-th at the same distance."""
    k = max(1, min(k, len(elos)))
    order = sorted(range(len(elos)), key=lambda i: (abs(elos[i] - x), i))
    cut = abs(elos[order[k - 1]] - x)
    return [i for i in order if abs(elos[i] - x) <= cut]


def window_warnings(x: float, chosen_elos: list[float], elo_min: float, elo_max: float) -> list[str]:
    lo, hi = min(chosen_elos), max(chosen_elos)
    out: list[str] = []
    if x < elo_min or x > elo_max:
        out.append(f"elo {x:g} is outside the observed range {elo_min:g}-{elo_max:g}; these are the players closest to it, nothing is extrapolated")
    elif hi > lo:
        span = hi - lo
        if (x - lo) < LOPSIDED * span:
            out.append(f"one-sided window: nearly all of these players are above elo {x:g}, so values lean toward higher elo")
        elif (hi - x) < LOPSIDED * span:
            out.append(f"one-sided window: nearly all of these players are below elo {x:g}, so values lean toward lower elo")
    if len(chosen_elos) < SMALL_N:
        out.append(f"only {len(chosen_elos)} players in the window; tail marks are rough")
    return out


def who_text(entry: dict) -> str:
    name = entry.get("player") or entry.get("steam64_id") or "?"
    parts = []
    if entry.get("finished_at"):
        parts.append(str(entry["finished_at"])[:10])
    if num(entry.get("faceit_elo")):
        parts.append(f"elo {entry['faceit_elo']:g}")
    return f"{name} ({', '.join(parts)})" if parts else str(name)


# ----------------------------------------------------------------------------------
# Report
# ----------------------------------------------------------------------------------
def render_report(meta: dict, elo_stats: dict, band_info: list[dict], metrics_out: dict, queries: list[dict]) -> str:
    L: list[str] = []
    cov = meta["coverage"]
    L.append("FACEIT ELO CAPABILITY REPORT")
    L.append("=" * 28)
    L.append(f"input: {meta['input']}   generated: {meta['generated_at']}")
    L.append(f"usable profiles: {cov['usable_profiles']}   with faceit_elo: {cov['players_with_elo']}   "
             f"without faceit_elo (skipped): {cov['players_without_elo']}   of {cov['entries_in_file']} entries")
    if cov["skipped"]:
        L.append("skipped: " + ", ".join(f"{k}={n}" for k, n in sorted(cov["skipped"].items())))
    if cov["excluded_bans"]:
        L.append("left out (ban on record): " + ", ".join(cov["excluded_bans"]))
    L.append("by source: " + ", ".join(f"{k}={n}" for k, n in sorted(cov["by_source"].items())) +
             "   by list: " + ", ".join(f"{k}={n}" for k, n in sorted(cov["by_pro_list"].items())))
    L.append("faceit_elo of these players: " + "  ".join(
        f"{k} {elo_stats[k]:.0f}" for k in ("min", "p10", "p25", "median", "p75", "p90", "max")))
    ud = meta["unit_decisions"]
    L.append("unit decisions: " + ", ".join(f"{k}={n}" for k, n in sorted(ud["counts"].items())) if ud["counts"] else "unit decisions: none")
    for w in ud["warnings"]:
        L.append("  WARNING: " + w)
    kind = "custom edges" if meta["settings"]["band_edges_custom"] else "equal-count"
    L.append(f"bands ({kind}): " + ",  ".join(f"{b['label']} ({b['n_players']} players)" for b in band_info))

    # 1. relationship
    L.append("")
    L.append("1. DOES ELO CHANGE WHAT PLAYERS REACH?   (one value per player)")
    L.append("rho = Spearman rank correlation with faceit_elo, t = its t-statistic (|t| >= %g yes, >= %g weak, else no)." % (T_CLEAR, T_WEAK))
    L.append("slope = straight-line change per +1000 elo; shift = slope x (p90 elo - p10 elo), in the metric's unit and in its own std devs.")
    L.append("moves = whether a higher elo pushes the value toward the metric's extreme end (low for preaim/reaction, high for the rest).")
    for fam in FAMILY_ORDER:
        rows = [(k, mo) for k, mo in metrics_out.items() if mo["family"] == fam and mo["scope"] == "player"]
        if not rows:
            continue
        L.append("")
        L.append(f"[{fam}]")
        L.append(f"{'metric':<22}{'n':>5}{'rho':>7}{'t':>7}{'slope/1000':>13}{'shift':>12}{'in sd':>8}  {'moves':<8}{'effect':<8}unit")
        for k, mo in rows:
            r = mo["relationship"]
            if r is None:
                L.append(f"{k:<22}{'-':>5}  (too few values or no spread)")
                continue
            n = f"{r['n']}{'*' if r['n'] < 30 else ''}"
            moves = "-" if r["effect"] == "no" else ("toward" if r["moves_toward_extreme"] else "away")
            L.append(f"{k:<22}{n:>5}{r['spearman_rho']:>7.2f}{r['t']:>7.1f}{fmt(r['slope_per_1000']):>13}"
                     f"{fmt(r['shift_p10_to_p90_elo']):>12}{r['shift_in_metric_std']:>8.2f}  {moves:<8}{r['effect']:<8}{mo['unit']}")

    # 2. bands
    labels = [b["label"] for b in band_info]
    w = max(10, max(len(x) for x in labels) + 2)
    L.append("")
    L.append("2. BY ELO BAND")
    L.append("Values of the players in the band (single-match rows: of their pooled recent matches). * = fewer than %d values." % SMALL_N)

    def band_block(title: str, pick) -> None:
        L.append("")
        L.append(title)
        for fam in FAMILY_ORDER:
            rows = [(k, mo) for k, mo in metrics_out.items() if mo["family"] == fam]
            if not rows:
                continue
            L.append(f"[{fam}]".ljust(22) + "".join(x.rjust(w) for x in labels))
            for k, mo in rows:
                cells = []
                for b in mo["by_band"]:
                    v = pick(b) if b.get("n") else None
                    cells.append(("-" if v is None else fmt(v) + ("*" if b.get("small_sample") else "")).rjust(w))
                L.append(f"  {k:<20}" + "".join(cells))

    band_block("Median", lambda s: s["median"])
    band_block("Extreme end, 10% mark: the value 10% of the band is beyond", lambda s: s["tail"]["top_10pct"])
    band_block("Extreme end, most extreme value in the band", lambda s: s["tail"]["most_extreme"])

    # 3. requested elos
    if queries:
        L.append("")
        L.append("3. AROUND THE ELO YOU ASKED FOR")
        for qi, q in enumerate(queries):
            L.append("")
            L.append(f"-- elo {q['elo']:g}: {q['n_players']} closest players (their elo {q['window'][0]:g}-{q['window'][1]:g}) --")
            for wmsg in q["warnings"]:
                L.append("  WARNING: " + wmsg)
            for fam in FAMILY_ORDER:
                rows = [(k, mo) for k, mo in metrics_out.items() if mo["family"] == fam]
                got = []
                for k, mo in rows:
                    s = next((r for r in mo["at_elo"] if r["query_index"] == qi), None)
                    if s is not None:
                        got.append((k, mo, s))
                if not got:
                    continue
                L.append(f"[{fam}]")
                L.append(f"{'metric':<22}{'n':>6} {'end':<5}{'median':>9}{'10%':>9}{'5%':>9}{'extreme':>9}   {'unit':<14}who")
                for k, mo, s in got:
                    t = s["tail"]
                    n = f"{s['n']}{'*' if s['small_sample'] else ''}"
                    L.append(f"{k:<22}{n:>6} {mo['extreme_end']:<5}{fmt(s['median']):>9}{fmt(t['top_10pct']):>9}"
                             f"{fmt(t['top_5pct']):>9}{fmt(t['most_extreme']):>9}   {mo['unit']:<14}{who_text(s['most_extreme_by'])}")

    L.append("")
    L.append("Notes: professionals only, so the elo range is narrow and high; nothing is valid below it. faceit_elo is the value at fetch time.")
    L.append("The JSON has all percentiles, the straight-line formula per metric (intercept + slope_per_elo * elo) and the most extreme player or match everywhere.")
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


def parse_edges(text: str) -> list[float]:
    try:
        vals = sorted({float(t) for t in text.split(",") if t.strip()})
    except ValueError:
        raise argparse.ArgumentTypeError("expected comma-separated numbers, e.g. 3000,3500,4000")
    if not vals:
        raise argparse.ArgumentTypeError("expected at least one number, e.g. 3000,3500,4000")
    return vals


def main() -> None:
    ap = argparse.ArgumentParser(description="Measure what CS2 professionals reach at a given FACEIT elo.")
    ap.add_argument("input", nargs="?", default="all-players.json", help="all-players.json (default: ./all-players.json)")
    ap.add_argument("--bands", type=int, default=DEFAULT_BANDS, metavar="N",
                    help=f"number of equal-count elo bands (default {DEFAULT_BANDS})")
    ap.add_argument("--band-edges", type=parse_edges, metavar="E1,E2,...",
                    help="your own band edges instead of --bands, e.g. 3000,3500,4000 gives <3000, 3000-3500, 3500-4000, 4000+")
    ap.add_argument("--elo", type=float, action="append", metavar="ELO",
                    help="also show what the players closest to this faceit_elo reach (repeatable)")
    ap.add_argument("--k", type=int, default=DEFAULT_K, metavar="N",
                    help=f"players in each --elo window (default {DEFAULT_K}; players tied at the edge are kept)")
    ap.add_argument("--out-dir", help="where to write the results (default: the input file's folder)")
    ap.add_argument("--prefix", default="pro-elo-capability", help="output file name prefix")
    ap.add_argument("--list", action="append", metavar="NAME", help="only players whose pro.list is NAME (repeatable), e.g. valve-top20")
    ap.add_argument("--min-matches", type=int, default=0, metavar="N",
                    help="skip profiles whose total_matches is below N (csst.at profiles may report only their stats window)")
    ap.add_argument("--window", type=int, default=WINDOW, metavar="N", help=f"newest rated matches per player (default {WINDOW})")
    ap.add_argument("--include-banned", action="store_true", help="keep players with a ban on record")
    args = ap.parse_args()
    if args.bands < 1:
        ap.error("--bands must be at least 1")
    if args.k < 1:
        ap.error("--k must be at least 1")

    src = Path(args.input)
    if not src.is_file():
        sys.exit(f"input not found: {src}")
    out_dir = Path(args.out_dir) if args.out_dir else src.resolve().parent
    out_dir.mkdir(parents=True, exist_ok=True)

    entries = load_entries(src)

    players: list[dict] = []                                   # one per player with an elo; index = player id
    rows: list[dict] = []
    items: dict[str, list[tuple[float, int, dict]]] = defaultdict(list)   # key -> (value, player id, label)
    skipped: Counter = Counter()
    banned_names: list[str] = []
    no_elo_names: list[str] = []
    by_source: Counter = Counter()
    by_list: Counter = Counter()
    privacy: Counter = Counter()
    unit_counts: Counter = Counter()
    odd_units: dict[str, list[str]] = defaultdict(list)
    usable = 0
    with_history = 0
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

        usable += 1
        elo = get_elo(e, profile)
        if elo is None:
            no_elo_names.append(str(name))
            continue

        res = analyze_player(profile, args.window)
        pid = len(players)
        players.append({"name": name, "steam64_id": sid, "elo": elo})
        label = {"player": name, "steam64_id": sid, "faceit_elo": elo}
        for key, value in res["values"].items():
            items[key].append((value, pid, label))
        for m in res["matches"]:
            for field, key in MATCH_POOL.items():
                if m[field] is not None:
                    items[key].append((m[field], pid, {**label, "match_id": m["id"], "finished_at": m["finished_at"]}))
        matches_pooled += len(res["matches"])

        # bookkeeping
        by_source[str(e.get("source"))] += 1
        by_list[str(pro.get("list"))] += 1
        privacy[str(profile.get("privacy_mode"))] += 1
        if not res["aggregate_only"]:
            with_history += 1
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
            "pid": pid, "steam64_id": sid, "name": name, "team": pro.get("team"), "list": pro.get("list"),
            "source": e.get("source"), "privacy_mode": profile.get("privacy_mode"),
            "faceit_elo": elo, "faceit_level": opt((profile.get("ranks") or {}).get("faceit")),
            "total_matches": total if num(total) else None,
            "matches_used": len(res["matches"]),
            **res["values"],
        })

    if usable == 0:
        sys.exit("no usable players after filtering; nothing to compute")
    if not players:
        sys.exit(f"none of the {usable} usable profiles has a faceit_elo (looked at profile.ranks.faceit_elo); nothing to compute")
    if len(players) < MIN_PLAYERS:
        sys.exit(f"only {len(players)} players have a faceit_elo (at least {MIN_PLAYERS} needed); nothing worth computing")

    # ---- elo distribution and bands
    elos = [p["elo"] for p in players]
    elos_sorted = sorted(elos)
    elo_stats = {
        "n": len(elos), "min": elos_sorted[0], "p10": percentile(elos_sorted, 10), "p25": percentile(elos_sorted, 25),
        "median": percentile(elos_sorted, 50), "p75": percentile(elos_sorted, 75), "p90": percentile(elos_sorted, 90),
        "max": elos_sorted[-1], "mean": mean(elos), "std": math.sqrt(variance(elos)) if len(elos) > 1 else 0.0,
    }
    edges = make_edges(elos_sorted, args.bands, args.band_edges)
    band_of = [bisect_right(edges, x) for x in elos]
    band_info: list[dict] = []
    for b in range(len(edges) + 1):
        member_elos = [elos[i] for i in range(len(elos)) if band_of[i] == b]
        if member_elos:
            label = f"{min(member_elos):.0f}-{max(member_elos):.0f}"
        else:
            label = f"(empty {b + 1})"
        band_info.append({"index": b, "label": label, "n_players": len(member_elos),
                          "elo_min": min(member_elos) if member_elos else None,
                          "elo_max": max(member_elos) if member_elos else None})
    for r in rows:
        r["band"] = band_info[band_of[r["pid"]]]["label"]

    # ---- per metric: relationship and bands
    metrics_out: dict[str, dict] = {}
    for m in METRICS:
        entries_m = items.get(m.key)
        if not entries_m:
            continue
        rel = None
        if m.scope == "player":
            rel = relationship([(players[pid]["elo"], v) for v, pid, _ in entries_m], m.extreme, elo_stats["p10"], elo_stats["p90"])
        by_band = []
        for b, info in enumerate(band_info):
            s = summarize_group([(v, lab) for v, pid, lab in entries_m if band_of[pid] == b], m.extreme)
            by_band.append({"band": info["label"], **(s if s else {"n": 0})})
        metrics_out[m.key] = {
            "family": m.family, "scope": m.scope, "unit": m.unit, "extreme_end": m.extreme,
            "informs": m.informs, "what": m.what, "band_constant": BAND_CONSTANT.get(m.key),
            "relationship": rel, "by_band": by_band, "at_elo": [],
        }

    # ---- windows around requested elos
    queries: list[dict] = []
    for qi, x in enumerate(args.elo or []):
        chosen = nearest_players(elos, x, args.k)
        chosen_set = set(chosen)
        chosen_elos = [elos[i] for i in chosen]
        queries.append({
            "query_index": qi, "elo": x, "k_requested": args.k, "n_players": len(chosen),
            "window": [min(chosen_elos), max(chosen_elos)],
            "warnings": window_warnings(x, chosen_elos, elo_stats["min"], elo_stats["max"]),
        })
        for key, mo in metrics_out.items():
            s = summarize_group([(v, lab) for v, pid, lab in items[key] if pid in chosen_set], METRIC_BY_KEY[key].extreme)
            if s is None:
                continue
            row = {"query_index": qi, "elo": x, **s}
            rel = mo["relationship"]
            if rel:
                row["linear_expected"] = sig(rel["intercept"] + rel["slope_per_elo"] * x)
            mo["at_elo"].append(row)

    # ---- bookkeeping and output
    warnings = []
    if unit_counts.get("match_rating_x100") and unit_counts.get("match_rating_x1"):
        warnings.append("match ratings were read as fractions for some players and as website units for others; check rating_scale()")
    if odd_units:
        warnings.append(f"{len(odd_units)} player(s) had a stat read as a fraction/seconds (x100 / x1000); "
                        "see unit_decisions.players in the JSON and check their raw values")

    meta = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "input": str(src),
        "settings": {
            "window": args.window, "min_matches_per_player_filter": args.min_matches,
            "lists": args.list or "all", "include_banned": args.include_banned,
            "bands": len(edges) + 1, "band_edges": edges, "band_edges_custom": args.band_edges is not None,
            "k": args.k, "elo_queries": args.elo or [],
            "elo_source": "profile.ranks.faceit_elo (profile.faceit_elo and entry.faceit_elo as fallbacks), > 0",
            "min_recent_matches_for_match_signals": MIN_MATCHES, "newest_group": NEWEST,
            "min_group": MIN_GROUP, "floor_mean_gate": FLOOR_MEAN_GATE, "strong_cuts": list(STRONG_CUTS),
        },
        "coverage": {
            "entries_in_file": len(entries), "usable_profiles": usable, "players_with_elo": len(players),
            "players_without_elo": len(no_elo_names), "names_without_elo": no_elo_names[:30],
            "skipped": dict(skipped), "excluded_bans": banned_names,
            "by_source": dict(by_source), "by_pro_list": dict(by_list), "privacy_mode": dict(privacy),
            "with_match_history": with_history, "matches_pooled": matches_pooled,
        },
        "unit_decisions": {"counts": dict(unit_counts), "warnings": warnings, "players": dict(odd_units)},
    }

    report = render_report(meta, elo_stats, band_info, metrics_out, queries)

    out_json = out_dir / f"{args.prefix}.json"
    out_csv = out_dir / f"{args.prefix}-players.csv"
    out_txt = out_dir / f"{args.prefix}-report.txt"

    payload = {**meta, "elo": {k: (sig(v, 8) if isinstance(v, float) else v) for k, v in elo_stats.items()},
               "bands": band_info, "queries": queries, "metrics": metrics_out}
    with out_json.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")

    player_keys = [m.key for m in METRICS if m.scope == "player"]
    fields = ["steam64_id", "name", "team", "list", "source", "privacy_mode", "faceit_elo", "faceit_level", "band",
              "total_matches", "matches_used"] + player_keys
    with out_csv.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r["faceit_elo"], r["pid"])):
            w.writerow({k: (sig(x) if isinstance(x, float) and k != "faceit_elo" else x) for k, x in r.items()})

    out_txt.write_text(report, encoding="utf-8")

    sys.stdout.write(report)
    print(f"wrote {out_json}\nwrote {out_csv}\nwrote {out_txt}")


if __name__ == "__main__":
    main()
