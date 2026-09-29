"""MODFLOW 6 groundwater model for a (synthetic) irrigation district.

Shared by the Databricks App (single runs) and the Lakeflow Job (Spark ensembles).
Inputs arrive as pandas DataFrames read from Unity Catalog tables; nothing here
talks to Databricks directly, so the same code runs locally, in the app container
and inside Spark tasks.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

MODEL = "sample"
MF6_VERSION = "6.8.1"
# Official USGS build is x86-64 and static; the aarch64 build (conda-forge) carries its Fortran runtime.
MF6_FILES = {"linux-x86_64": ["bin/mf6"],
             "linux-aarch64": ["bin/mf6", "lib/libgfortran.so.5", "lib/libgcc_s.so.1"]}
HDRY = 1e20

DEFAULT_SCENARIO = {
    "k_mult": 1.0,            # hydraulic conductivity multiplier (both layers)
    "sy": 0.08,               # specific yield of the shallow aquifer
    "rain_mult": 1.0,         # climate: rainfall multiplier
    "et_mult": 1.0,           # climate: reference ET multiplier
    "rain_recharge_frac": 0.06,
    "deep_drainage_frac": 0.12,  # share of applied irrigation water that drains below the root zone
    "pumping_mult": 1.0,
    "canal_lining_pct": 0.0,  # legacy: line the leakiest % of channel cells (kept so old scenarios still run)
    "lined_reaches": [],      # supply-channel reaches lined or piped, by reach id ("MC-03"); cuts seepage by 90%
    "land_use": [],           # painted land-use changes: [[row, col, crop], ...] over the UC land-use map
    "extra_bores": [],        # proposed bores: [{"row":, "col":, "layer":, "ML_per_year":}]
    "drain_lines": [],        # proposed sub-surface (interceptor) drains: [{"name":, "cells": [[r, c], ...], "depth_m":, "cond":}]
}
DRAIN_DEPTH_M = 2.0           # an interceptor drain holds the water table near its invert, below the root zone
DRAIN_COND = 500.0            # m2/d per 250 m of drain, as the district's existing sub-surface drains

# Irrigation water applied (x the crop-water deficit) and the share that drains below the root zone
# (x the district deep-drainage fraction). Row crops are the reference.
CROPS = {
    "rice":         {"label": "Rice",         "water": 1.6, "drain": 2.2},
    "pasture":      {"label": "Pasture",      "water": 1.1, "drain": 1.4},
    "broadacre":    {"label": "Row crops",    "water": 1.0, "drain": 1.0},
    "horticulture": {"label": "Horticulture", "water": 0.8, "drain": 0.3},
    "dryland":      {"label": "Dryland",      "water": 0.0, "drain": 0.0},
}

IRRIGATION_MONTHS = {8, 9, 10, 11, 12, 1, 2, 3, 4, 5}
SALINITY_RISK_DTW_M = 2.0


@dataclass
class Inputs:
    nlay: int
    nrow: int
    ncol: int
    delr: float
    delc: float
    top: np.ndarray
    botm: np.ndarray
    k: np.ndarray
    k33: np.ndarray
    ss: np.ndarray
    irrigated: np.ndarray
    land_use: np.ndarray
    boundaries: pd.DataFrame
    bores: pd.DataFrame
    extractions: pd.DataFrame
    weather: pd.DataFrame
    months: list = field(default_factory=list)
    convertible: list | None = None  # per-layer ICELLTYPE; default: top layer convertible, the rest confined
    refine: int = 1  # cells per native cell along each side
    sublayers: int = 1  # model layers per native aquifer layer


# ---------------------------------------------------------------- fidelity: how finely MODFLOW discretises the model
# The inputs stay what Unity Catalog holds (250 m cells, two aquifers, monthly forcing). Fidelity changes how finely
# MODFLOW solves them: smaller cells (channels become lines, not 250 m strips), aquifers split into sub-layers (vertical
# gradients), more time steps per month, and tighter solver convergence. Outputs are block-averaged back to the native
# grid for comparison with the baseline; the full-resolution arrays are kept too.
DEFAULT_FIDELITY = {"refine": 1, "sublayers": 1, "nstp": 2, "solver": "standard"}
SOLVERS = {
    "fast": dict(complexity="SIMPLE", outer_dvclose=1e-2, inner_dvclose=1e-3, outer_maximum=100, inner_maximum=100),
    "standard": dict(complexity="MODERATE", outer_dvclose=1e-3, inner_dvclose=1e-4, outer_maximum=200),
    "tight": dict(complexity="COMPLEX", outer_dvclose=1e-5, inner_dvclose=1e-6, outer_maximum=500, inner_maximum=500),
}
REFINE_CHOICES = (1, 2, 3, 4, 5, 6, 8, 10)


def fidelity_of(scenario: dict | None) -> dict:
    f = {**DEFAULT_FIDELITY, **((scenario or {}).get("fidelity") or {})}
    f["refine"] = int(f["refine"]) if int(f["refine"]) in REFINE_CHOICES else 1
    f["sublayers"] = max(1, min(6, int(f["sublayers"])))
    f["nstp"] = max(1, min(31, int(f["nstp"])))
    f["solver"] = f["solver"] if f["solver"] in SOLVERS else "standard"
    return f


def fidelity_size(inp: "Inputs", f: dict) -> dict:
    """Cells, time steps and a rough solve-time estimate for a fidelity, from the native model's ~0.5 s solve."""
    active = int(np.isfinite(inp.top).sum())
    cells = active * inp.nlay * f["sublayers"] * f["refine"] ** 2
    steps = 1 + len(inp.months) * f["nstp"]
    native = active * inp.nlay * (1 + len(inp.months) * 2)
    work = cells * steps / native
    est = 0.6 * work ** 1.15 * {"fast": 0.6, "standard": 1.0, "tight": 2.5}[f["solver"]] + 0.00002 * cells  # + file writing
    return {"cells": cells, "time_steps": steps, "cell_m": inp.delr / f["refine"], "estimate_s": round(est, 1)}


def _up(a: np.ndarray, f: int) -> np.ndarray:
    return np.repeat(np.repeat(a, f, axis=-2), f, axis=-1)


def _line(r0, c0, r1, c1):
    n = max(abs(r1 - r0), abs(c1 - c0))
    return [(round(r0 + (r1 - r0) * t / n), round(c0 + (c1 - c0) * t / n)) for t in range(n + 1)] if n else [(r0, c0)]


def _chain(g: pd.DataFrame) -> pd.DataFrame:
    """Cells of one channel in walking order: start at an end, step to an adjacent unvisited cell (sides before
    corners), and jump to the nearest remaining cell when a branch ends."""
    pts = list(zip(g.row.astype(int), g.col.astype(int)))
    if len(pts) < 3:
        return g
    left = set(range(len(pts)))
    nb = lambda i, j: max(abs(pts[i][0] - pts[j][0]), abs(pts[i][1] - pts[j][1])) <= 1
    deg = [sum(nb(i, j) for j in left if j != i) for i in range(len(pts))]
    cur = min(left, key=lambda i: (deg[i], pts[i]))
    order = [cur]; left.discard(cur)
    while left:
        side = [j for j in left if abs(pts[j][0] - pts[cur][0]) + abs(pts[j][1] - pts[cur][1]) == 1]
        near = side or [j for j in left if nb(cur, j)]
        cur = min(near or left, key=lambda j: (abs(pts[j][0] - pts[cur][0]) + abs(pts[j][1] - pts[cur][1]), pts[j]))
        order.append(cur); left.discard(cur)
    return g.iloc[order].reset_index(drop=True)


def _refine_linear(df: pd.DataFrame, f: int, key: str) -> pd.DataFrame:
    """A channel, river or drain on the refined grid: the line through its cell centres, each native cell's
    conductance shared out along the fine cells its stretch of line crosses."""
    out = []
    ctr = lambda r, c: (int(r) * f + f // 2, int(c) * f + f // 2)
    for _, g in df.groupby(key, sort=False):
        rows = _chain(g.reset_index(drop=True))
        owned: dict[int, list] = {i: [] for i in range(len(rows))}
        taken = set()
        for i in range(len(rows)):
            a = rows.iloc[i]
            if i + 1 < len(rows) and max(abs(int(rows.iloc[i + 1].row) - int(a.row)), abs(int(rows.iloc[i + 1].col) - int(a.col))) <= 1:
                b = rows.iloc[i + 1]
                pts = _line(*ctr(a.row, a.col), *ctr(b.row, b.col))
                half = len(pts) // 2
                for j, p in enumerate(pts):
                    if p not in taken:
                        taken.add(p)
                        owned[i if j < half else i + 1].append(p)
            p = ctr(a.row, a.col)
            if p not in taken:
                taken.add(p)
                owned[i].append(p)
        for i, cells in owned.items():
            src = rows.iloc[i]
            if not cells:
                continue
            for r, c in cells:
                rec = src.to_dict()
                rec.update(row=r, col=c, cond=float(src.cond) / len(cells))
                out.append(rec)
    return pd.DataFrame(out, columns=df.columns)


def refine_inputs(inp: "Inputs", refine: int, sublayers: int) -> "Inputs":
    """The same model on a finer grid: every array split into refine x refine cells and sublayers per aquifer, boundaries
    and bores placed on the fine grid. No new data is invented: fine cells inherit their native cell's properties."""
    f, n = refine, sublayers
    top = _up(inp.top, f)
    tops = [inp.top] + [inp.botm[k] for k in range(inp.nlay - 1)]
    botm, k, k33, ss, conv = [], [], [], [], []
    base_conv = inp.convertible or [1] + [0] * (inp.nlay - 1)
    for L in range(inp.nlay):
        for j in range(n):
            botm.append(_up(tops[L] - (tops[L] - inp.botm[L]) * (j + 1) / n, f))
            k.append(_up(inp.k[L], f)); k33.append(_up(inp.k33[L], f)); ss.append(_up(inp.ss[L], f))
            conv.append(base_conv[L])
    b = inp.boundaries
    parts = []
    for kind, g in b.groupby("kind", sort=False):
        if kind == "chd":
            rows = []
            for r in g.itertuples(index=False):
                for dr in range(f):
                    for dc in range(f):
                        for j in range(n):
                            rows.append({**r._asdict(), "row": int(r.row) * f + dr, "col": int(r.col) * f + dc, "layer": int(r.layer) * n + j})
            parts.append(pd.DataFrame(rows, columns=g.columns))
        else:
            key = "reach" if "reach" in g.columns and g["reach"].notna().any() else "name"
            lin = _refine_linear(g.assign(**({key: g[key].fillna("")} if key in g.columns else {})), f, key) if f > 1 else g.copy()
            lin["layer"] = lin["layer"].astype(int) * n  # surface water meets the top of its aquifer
            parts.append(lin)
    bores = inp.bores.copy()
    bores["row"] = bores["row"].astype(int) * f + f // 2
    bores["col"] = bores["col"].astype(int) * f + f // 2
    bores["layer"] = bores["layer"].astype(int) * n + n // 2
    return Inputs(nlay=inp.nlay * n, nrow=inp.nrow * f, ncol=inp.ncol * f, delr=inp.delr / f, delc=inp.delc / f,
                  top=top, botm=np.stack(botm), k=np.stack(k), k33=np.stack(k33), ss=np.stack(ss),
                  irrigated=_up(inp.irrigated, f), land_use=_up(inp.land_use, f),
                  boundaries=pd.concat(parts, ignore_index=True), bores=bores, extractions=inp.extractions,
                  weather=inp.weather, months=inp.months, convertible=conv, refine=f, sublayers=n)


def refine_scenario(scenario: dict, f: int, n: int) -> dict:
    """Scenario edits given on the native grid, placed on the fine grid."""
    s = dict(scenario)
    s["land_use"] = [[int(r) * f + dr, int(c) * f + dc, k] for r, c, k in scenario.get("land_use") or [] for dr in range(f) for dc in range(f)]
    s["extra_bores"] = [{**b, "row": int(b["row"]) * f + f // 2, "col": int(b["col"]) * f + f // 2,
                         "layer": int(b.get("layer", 1)) * n + n // 2} for b in scenario.get("extra_bores") or []]
    # a drain runs cell centre to cell centre, so on the fine grid it is the line through those centres
    s["drain_lines"] = []
    for d in scenario.get("drain_lines") or []:
        pts = [(int(r) * f + f // 2, int(c) * f + f // 2) for r, c in d["cells"]]
        fine = [pts[0]] if len(pts) == 1 else []
        for a, b in zip(pts, pts[1:]):
            fine += [x for x in _line(*a, *b) if not fine or x != fine[-1]]
        s["drain_lines"].append({**d, "cells": [list(x) for x in dict.fromkeys(fine)], "cond": float(d.get("cond", DRAIN_COND)) * len(d["cells"]) / max(1, len(set(fine)))})
    return s


def block_mean(a: np.ndarray, f: int) -> np.ndarray:
    """Fine-grid values averaged back onto native cells (last two axes)."""
    if f == 1:
        return a
    import warnings
    sh = a.shape[:-2] + (a.shape[-2] // f, f, a.shape[-1] // f, f)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmean(a.reshape(sh), axis=(-3, -1))


def platform_tag() -> str:
    import platform

    m = platform.machine().lower()
    return "linux-" + {"amd64": "x86_64", "arm64": "aarch64"}.get(m, m)


def install_mf6(fetch, dest: str) -> str:
    """Materialise the mf6 build for this CPU under dest via fetch(relative_path, local_path).

    fetch reads from the UC Volume that holds the governed executables (a FUSE copy on
    Spark, the Files API in the app). Returns the executable path; idempotent.
    """
    import stat

    tag = platform_tag()
    root = os.path.join(dest, MF6_VERSION, tag)
    exe = os.path.join(root, "bin", "mf6")
    if os.path.exists(exe):
        return exe
    tmp = f"{root}.tmp{os.getpid()}"
    for rel in MF6_FILES[tag]:
        os.makedirs(os.path.dirname(os.path.join(tmp, rel)), exist_ok=True)
        fetch(f"{MF6_VERSION}/{tag}/{rel}", os.path.join(tmp, rel))
    os.chmod(os.path.join(tmp, "bin", "mf6"), 0o755)
    os.makedirs(os.path.dirname(root), exist_ok=True)
    try:
        os.rename(tmp, root)
    except OSError:  # another process won the race
        shutil.rmtree(tmp, ignore_errors=True)
    return exe


def _grid(df: pd.DataFrame, col: str, nlay: int, nrow: int, ncol: int) -> np.ndarray:
    arr = np.full((nlay, nrow, ncol), np.nan)
    arr[df["layer"].to_numpy(), df["row"].to_numpy(), df["col"].to_numpy()] = df[col].to_numpy()
    return arr


def inputs_from_frames(cells: pd.DataFrame, boundaries: pd.DataFrame, bores: pd.DataFrame,
                       extractions: pd.DataFrame, weather: pd.DataFrame) -> Inputs:
    """Assemble model arrays from the UC input tables."""
    nlay, nrow, ncol = int(cells.layer.max()) + 1, int(cells.row.max()) + 1, int(cells.col.max()) + 1
    g = lambda c: _grid(cells, c, nlay, nrow, ncol)
    weather = weather.copy()
    weather["month"] = pd.to_datetime(weather["month"])
    weather = weather.groupby("month", as_index=False)[["rainfall_mm", "et0_mm"]].mean().sort_values("month")
    extractions = extractions.copy()
    extractions["month"] = pd.to_datetime(extractions["month"])
    return Inputs(
        nlay=nlay, nrow=nrow, ncol=ncol,
        delr=float(cells.delr.iloc[0]), delc=float(cells.delc.iloc[0]),
        top=g("top")[0], botm=g("botm"), k=g("k"), k33=g("k33"), ss=g("ss"),
        irrigated=g("irrigated")[0].astype(bool),
        land_use=_land_use(cells, nrow, ncol),
        boundaries=boundaries, bores=bores, extractions=extractions, weather=weather,
        months=list(weather["month"]),
    )


def _land_use(cells: pd.DataFrame, nrow: int, ncol: int) -> np.ndarray:
    top = cells[cells.layer == 0]
    lu = np.full((nrow, ncol), "dryland", dtype=object)
    codes = top["land_use"].where(top["land_use"].isin(list(CROPS)), np.where(top["irrigated"] == 1, "broadacre", "dryland"))
    lu[top["row"].to_numpy(), top["col"].to_numpy()] = codes.to_numpy()
    return lu


def land_use_for(inp: Inputs, scenario: dict) -> np.ndarray:
    """The UC land-use map with the scenario's painted cells applied."""
    lu = inp.land_use.copy()
    for r, c, crop in scenario.get("land_use") or []:
        if crop in CROPS and 0 <= int(r) < inp.nrow and 0 <= int(c) < inp.ncol:
            lu[int(r), int(c)] = crop
    return lu


def canal_reaches(inp: Inputs) -> pd.DataFrame:
    """Supply-channel cells with their reach id, in flow order along each channel."""
    b = inp.boundaries
    canal = b[b.kind == "canal"].reset_index(drop=True)
    if "reach" not in canal.columns:
        canal["reach"] = canal["name"]
    return canal


def _lined_mask(canal: pd.DataFrame, pct: float) -> np.ndarray:
    # Line the leakiest reaches first, the way a channel-lining program would be prioritised.
    n = int(round(len(canal) * pct / 100.0))
    order = np.argsort(-canal["cond"].to_numpy())
    mask = np.zeros(len(canal), dtype=bool)
    mask[order[:n]] = True
    return mask


def interceptor_cells(inp: Inputs, s: dict) -> list:
    """DRN rows for the scenario's proposed drains: top layer, invert depth_m below the land surface (kept inside the
    layer), one conductance per cell; a cell two drains cross is drained once, at the deeper invert."""
    out = {}
    for d in s.get("drain_lines") or []:
        depth, cond = float(d.get("depth_m", DRAIN_DEPTH_M)), float(d.get("cond", DRAIN_COND))
        for r, c in d["cells"]:
            r, c = int(r), int(c)
            if not (0 <= r < inp.nrow and 0 <= c < inp.ncol) or not np.isfinite(inp.top[r, c]):
                continue
            stage = max(float(inp.top[r, c]) - depth, float(inp.botm[0][r, c]) + 0.1)
            if (r, c) not in out or stage < out[(r, c)][1]:
                out[(r, c)] = ((0, r, c), stage, cond)
    return list(out.values())


def build_simulation(inp: Inputs, scenario: dict, ws: str, exe: str):
    import flopy

    s = {**DEFAULT_SCENARIO, **(scenario or {})}
    months = inp.months
    days = [pd.Timestamp(m).days_in_month for m in months]
    nper = len(months) + 1  # steady-state warm-up period + monthly transient periods

    sim = flopy.mf6.MFSimulation(sim_name=MODEL, sim_ws=ws, exe_name=exe, verbosity_level=0)
    fid = fidelity_of(s)
    flopy.mf6.ModflowTdis(sim, time_units="DAYS", nper=nper,
                          perioddata=[(1.0, 1, 1.0)] + [(float(d), fid["nstp"], 1.0) for d in days])
    flopy.mf6.ModflowIms(sim, linear_acceleration="BICGSTAB", **SOLVERS[fid["solver"]])
    gwf = flopy.mf6.ModflowGwf(sim, modelname=MODEL, save_flows=True,
                               newtonoptions="NEWTON UNDER_RELAXATION")
    flopy.mf6.ModflowGwfdis(gwf, nlay=inp.nlay, nrow=inp.nrow, ncol=inp.ncol,
                            delr=inp.delr, delc=inp.delc, top=inp.top, botm=inp.botm)
    conv = inp.convertible or [1] + [0] * (inp.nlay - 1)
    # optional per-aquifer multipliers on top of k_mult (upper aquifer, lower aquifer); sub-layers take their aquifer's value
    am = s.get("k_aquifer_mult") or []
    lm = np.array([float(am[min(k // max(inp.sublayers, 1), len(am) - 1)]) if am else 1.0 for k in range(inp.nlay)])[:, None, None]
    flopy.mf6.ModflowGwfnpf(gwf, icelltype=conv, k=inp.k * s["k_mult"] * lm, k33=inp.k33 * s["k_mult"] * lm)
    flopy.mf6.ModflowGwfsto(gwf, iconvert=conv, sy=s["sy"], ss=inp.ss,
                            steady_state={0: True}, transient={1: True})
    flopy.mf6.ModflowGwfic(gwf, strt=np.broadcast_to(inp.top - 3.0, inp.botm.shape).copy())
    # a proposed bore screened in aquifer L goes in the middle sub-layer of L

    b = inp.boundaries
    chd = b[b.kind == "chd"]
    flopy.mf6.ModflowGwfchd(gwf, pname="CHD", stress_period_data={
        0: [((int(r.layer), int(r.row), int(r.col)), float(r.stage)) for r in chd.itertuples()]})
    river = b[b.kind == "river"]
    flopy.mf6.ModflowGwfriv(gwf, pname="RIVER", filename=f"{MODEL}.river.riv", stress_period_data={
        0: [((int(r.layer), int(r.row), int(r.col)), float(r.stage), float(r.cond), float(r.rbot))
            for r in river.itertuples()]})
    drains = b[b.kind == "drain"]
    flopy.mf6.ModflowGwfdrn(gwf, pname="DRAINS", stress_period_data={
        0: [((int(r.layer), int(r.row), int(r.col)), float(r.stage), float(r.cond)) for r in drains.itertuples()]})
    icpt = interceptor_cells(inp, s)
    if icpt:  # proposed interceptor drains: their own package, so the budget reports what they remove
        flopy.mf6.ModflowGwfdrn(gwf, pname="INTERCEPT", filename=f"{MODEL}.intercept.drn", stress_period_data={0: icpt})

    # Supply channels only run in the irrigation season; lining cuts bed conductance by 90%.
    canal = canal_reaches(inp)
    lined = _lined_mask(canal, s["canal_lining_pct"]) | canal["reach"].isin(s["lined_reaches"]).to_numpy()
    cond = np.where(lined, canal["cond"] * 0.1, canal["cond"])
    canal_on = [((int(r.layer), int(r.row), int(r.col)), float(r.stage), float(c), float(r.rbot))
                for r, c in zip(canal.itertuples(), cond)]
    canal_spd = {0: canal_on}
    for i, m in enumerate(months, start=1):
        canal_spd[i] = canal_on if pd.Timestamp(m).month in IRRIGATION_MONTHS else []
    flopy.mf6.ModflowGwfriv(gwf, pname="CANALS", filename=f"{MODEL}.canal.riv", stress_period_data=canal_spd)

    # Recharge = rainfall infiltration + irrigation deep drainage; groundwater ET from shallow water tables.
    w = inp.weather.set_index("month")
    lu = land_use_for(inp, s)
    water = np.vectorize(lambda k: CROPS[k]["water"])(lu).astype(float)
    drain = np.vectorize(lambda k: CROPS[k]["drain"])(lu).astype(float)
    rch, evt = {}, {}
    for i, m in enumerate([None] + months):
        if m is None:
            rain, et0, d, irrig_month = w.rainfall_mm.mean(), w.et0_mm.mean(), 30.4, True
        else:
            rain, et0, d = w.loc[m, "rainfall_mm"], w.loc[m, "et0_mm"], pd.Timestamp(m).days_in_month
            irrig_month = pd.Timestamp(m).month in IRRIGATION_MONTHS
        rain, et0 = rain * s["rain_mult"], et0 * s["et_mult"]
        deficit = max(et0 * 0.85 - rain, 0.0) if irrig_month else 0.0
        applied = water * deficit
        rch[i] = (rain * s["rain_recharge_frac"] + applied * drain * s["deep_drainage_frac"]) / 1000.0 / d
        evt[i] = np.full((inp.nrow, inp.ncol), et0 * 0.5 / 1000.0 / d)
    flopy.mf6.ModflowGwfrcha(gwf, recharge=rch)
    flopy.mf6.ModflowGwfevta(gwf, surface=inp.top, rate=evt, depth=2.5)

    # Licensed extraction bores, plus any proposed bores from the scenario.
    prod = inp.bores[inp.bores.bore_type == "production"]
    ex = inp.extractions.pivot_table(index="month", columns="bore_id", values="extraction_ml", aggfunc="sum")
    wel = {}
    for i, m in enumerate([None] + months):
        rows = []
        for r in prod.itertuples():
            if r.bore_id not in ex.columns:
                continue
            ml = ex[r.bore_id].mean() if m is None else ex[r.bore_id].get(m, 0.0)
            d = 30.4 if m is None else pd.Timestamp(m).days_in_month
            q = -float(np.nan_to_num(ml)) * 1000.0 / d * s["pumping_mult"]
            rows.append(((int(r.layer), int(r.row), int(r.col)), q))
        for eb in s["extra_bores"]:
            q = -float(eb["ML_per_year"]) * 1000.0 / 365.25
            rows.append(((int(eb.get("layer", 1)), int(eb["row"]), int(eb["col"])), q))
        wel[i] = rows
    flopy.mf6.ModflowGwfwel(gwf, pname="BORES", stress_period_data=wel)

    obs = inp.bores[inp.bores.bore_type == "monitoring"]
    flopy.mf6.ModflowUtlobs(gwf, pname="OBS", digits=8, continuous={
        f"{MODEL}.head.obs.csv": [(r.bore_id, "HEAD", (int(r.layer), int(r.row), int(r.col))) for r in obs.itertuples()]})
    flopy.mf6.ModflowGwfoc(gwf, head_filerecord=f"{MODEL}.hds", budget_filerecord=f"{MODEL}.cbc",
                           saverecord=[("HEAD", "LAST"), ("BUDGET", "LAST")],
                           printrecord=[("BUDGET", "LAST")])
    return sim


def run(inp: Inputs, scenario: dict, ws: str, exe: str, progress=None, timeout: float = 6 * 3600) -> dict:
    """Write, run and post-process one simulation at the scenario's fidelity. Returns plain numpy/pandas outputs on the
    native grid (block-averaged when refined), plus the full-resolution arrays as *_fine.

    progress, if given, is called as progress(stage, done, total) while the model is written and solved."""
    import flopy

    fid = fidelity_of(scenario)
    native = inp
    if fid["refine"] > 1 or fid["sublayers"] > 1:
        inp = refine_inputs(native, fid["refine"], fid["sublayers"])
        scenario = refine_scenario(scenario or {}, fid["refine"], fid["sublayers"])
    shutil.rmtree(ws, ignore_errors=True)
    os.makedirs(ws)
    t0 = time.time()
    if progress:
        progress("writing", 0, 1)
    sim = build_simulation(inp, scenario, ws, os.path.abspath(exe))
    sim.write_simulation(silent=True)
    t_write = time.time() - t0
    nsteps = 1 + len(inp.months) * fid["nstp"]
    lines, done = [], 0
    proc = subprocess.Popen([os.path.abspath(exe), "mfsim.nam"], cwd=ws, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    try:
        for line in proc.stdout:
            lines.append(line)
            if len(lines) > 400:
                del lines[:200]
            if "Time step:" in line and progress:
                done += 1
                progress("solving", min(done, nsteps), nsteps)
            if time.time() - t0 > timeout:
                proc.kill()
                lines.append(f"\nStopped after {int(timeout)} s.\n")
                break
        proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
    stdout = "".join(lines)
    t_run = time.time() - t0 - t_write
    ok = proc.returncode == 0 and "Normal termination" in stdout
    out = {"ok": ok, "stdout_tail": stdout[-2000:], "write_s": round(t_write, 2), "run_s": round(t_run, 2), "ws": ws,
           "fidelity": fid | fidelity_size(native, fid)}
    if not ok:
        return out
    if progress:
        progress("reading", 0, 1)

    heads = flopy.utils.HeadFile(os.path.join(ws, f"{MODEL}.hds")).get_alldata()  # (nper, nlay, nrow, ncol)
    heads = np.where(np.abs(heads) > HDRY, np.nan, heads).astype("float32")
    # Water table = head in the uppermost wet layer; depth to water below land surface.
    wt = np.full(heads.shape[:1] + heads.shape[2:], np.nan, dtype="float32")
    for kk in range(heads.shape[1] - 1, -1, -1):
        h = heads[:, kk]
        wt = np.where(np.isfinite(h) & (h > inp.botm[kk][None]), h, wt)
    wt = np.where(np.isnan(wt), heads[:, -1], wt)
    dtw = (inp.top[None] - wt).astype("float32")
    f, n = fid["refine"], fid["sublayers"]
    if f > 1 or n > 1:
        out["dtw_fine"], out["heads_fine"] = dtw, heads
        out["dtw"] = block_mean(dtw, f).astype("float32")
        mid = [L * n + n // 2 for L in range(native.nlay)]
        out["heads"] = block_mean(heads[:, mid], f).astype("float32")
        out["fine_grid"] = {"nrow": inp.nrow, "ncol": inp.ncol, "nlay": inp.nlay, "cell_m": inp.delr}
    else:
        out["heads"], out["dtw"] = heads, dtw

    obs = pd.read_csv(os.path.join(ws, f"{MODEL}.head.obs.csv"))
    obs.columns = [c.upper() for c in obs.columns]
    out["obs"] = obs

    out["reach_seepage_ml"] = _reach_seepage(inp, ws, fid["nstp"])
    out["cell_budget"] = cell_budget(inp, ws, fid["nstp"], f)

    inc, _ = flopy.utils.Mf6ListBudget(os.path.join(ws, f"{MODEL}.lst")).get_dataframes()
    inc = inc.reset_index(drop=True)
    inc["kper"] = range(len(inc))
    out["budget"] = inc
    return out


def _reach_seepage(inp: Inputs, ws: str, nstp: int = 2) -> dict:
    """Channel leakage into the aquifer per reach over the transient periods, ML."""
    import flopy

    canal = canal_reaches(inp)
    node = (canal.layer * inp.nrow * inp.ncol + canal.row * inp.ncol + canal.col + 1).to_numpy()
    reach_of = dict(zip(node, canal.reach))
    days = [pd.Timestamp(m).days_in_month for m in inp.months]
    cbc = flopy.utils.CellBudgetFile(os.path.join(ws, f"{MODEL}.cbc"), precision="double")
    tot = dict.fromkeys(canal.reach.unique(), 0.0)
    for kper, d in enumerate(days, start=1):
        for rec in cbc.get_data(text="RIV", kstpkper=(nstp - 1, kper), paknam2="CANALS"):
            for n, q in zip(rec["node"], rec["q"]):
                if n in reach_of:
                    tot[reach_of[n]] += float(q) * d / 1000.0
    return {k: round(v, 1) for k, v in tot.items()}


CELL_TERMS = {  # cbc record (text, package name or None) -> cell-budget term
    ("STO-SS", None): "storage", ("STO-SY", None): "storage", ("CHD", None): "boundary", ("RIV", "RIVER"): "river",
    ("RIV", "CANALS"): "canal", ("DRN", "DRAINS"): "drains", ("DRN", "INTERCEPT"): "interceptor", ("RCHA", None): "recharge",
    ("RCH", None): "recharge", ("EVTA", None): "gw_et", ("EVT", None): "gw_et", ("WEL", None): "bores"}
CELL_TERM_LABELS = {"recharge": "Recharge (rain + deep drainage)", "canal": "Supply canal seepage", "river": "River",
                    "drains": "Sub-surface drains", "interceptor": "Interceptor drains", "bores": "Bore extraction",
                    "gw_et": "Groundwater ET", "boundary": "Regional boundary", "storage": "Storage",
                    "lateral": "Flow across the zone edge"}


def cell_budget(inp: Inputs, ws: str, nstp: int, f: int = 1) -> dict:
    """Every budget term per cell and period (end of each month), summed down the column and back onto native cells:
    {term: float32 [period, row, col]} in m3/d, positive into the aquifer. frf and fff are the flows out through each
    native cell's east and south faces, so the flow across any zone's edge can be summed."""
    import flopy

    cbc = flopy.utils.CellBudgetFile(os.path.join(ws, f"{MODEL}.cbc"), precision="double")
    shape, ncell = (inp.nlay, inp.nrow, inp.ncol), inp.nlay * inp.nrow * inp.ncol
    nper, nr, nc = 1 + len(inp.months), inp.nrow // f, inp.ncol // f
    out = {k: np.zeros((nper, nr, nc), "float32") for k in set(CELL_TERMS.values()) | {"frf", "fff"}}
    grb = os.path.join(ws, f"{MODEL}.dis.grb")
    native = (lambda a2: a2) if f == 1 else (lambda a2: a2.reshape(nr, f, nc, f).sum(axis=(1, 3)))
    last = {0: 1, **{k: nstp for k in range(1, nper)}}  # 1-based step that ends each period
    txt = lambda v: (v.decode() if isinstance(v, bytes) else str(v)).strip().upper()
    for i, h in enumerate(cbc.recordarray):
        kper = int(h["kper"]) - 1
        if kper not in last or int(h["kstp"]) != last[kper]:
            continue
        name, pkg = txt(h["text"]), txt(h["paknam2"])
        if name == "FLOW-JA-FACE":
            fja = np.asarray(cbc.get_record(i)).ravel()
            frf, fff, _ = flopy.mf6.utils.get_structured_faceflows(fja, grb_file=grb)
            frf, fff = frf.sum(axis=0), fff.sum(axis=0)  # whole columns: vertical flow stays inside
            # a native cell's east face is the last fine column of its block, summed over the block's fine rows
            out["frf"][kper] = frf if f == 1 else frf[:, f - 1::f].reshape(nr, f, nc).sum(axis=1)
            out["fff"][kper] = fff if f == 1 else fff[f - 1::f, :].reshape(nr, nc, f).sum(axis=2)
            continue
        term = CELL_TERMS.get((name, pkg)) or CELL_TERMS.get((name, None))
        if not term:
            continue
        rec = cbc.get_record(i)
        if getattr(rec, "dtype", None) is not None and rec.dtype.names and "node" in rec.dtype.names:
            q = np.zeros(ncell)
            np.add.at(q, rec["node"] - 1, rec["q"])
            arr = q.reshape(shape)
        else:
            arr = np.asarray(rec, float).reshape(shape)
        # storage is written as flow out of storage into the cell (positive = released); everything else is into the cell
        out[term][kper] += native(np.nan_to_num(arr).sum(axis=0)).astype("float32")
    return out


def period_labels(inp: Inputs) -> list[str]:
    return ["steady-state"] + [pd.Timestamp(m).strftime("%Y-%m") for m in inp.months]


def hydrographs(inp: Inputs, res: dict) -> pd.DataFrame:
    """Simulated head at each monitoring bore at the end of every month (long format)."""
    obs = res["obs"]
    t_end = np.cumsum([1.0] + [pd.Timestamp(m).days_in_month for m in inp.months])
    rows = []
    for kper, t in enumerate(t_end):
        row = obs.iloc[(obs["TIME"] - t).abs().argmin()]
        for bid in obs.columns[1:]:
            rows.append((bid, kper, float(row[bid])))
    df = pd.DataFrame(rows, columns=["bore_id", "kper", "sim_head"])
    df["month"] = [None if k == 0 else pd.Timestamp(inp.months[k - 1]) for k in df.kper]
    return df


def fit_stats(sim: pd.DataFrame, observed: pd.DataFrame) -> dict:
    """Compare simulated heads with observed water levels (monthly means)."""
    o = observed.copy()
    o["month"] = pd.to_datetime(o["obs_date"]).dt.to_period("M").dt.to_timestamp()
    o = o.groupby(["bore_id", "month"], as_index=False)["water_level_mahd"].mean()
    m = sim.dropna(subset=["month"]).merge(o, on=["bore_id", "month"])
    if m.empty:
        return {"rmse_m": None, "bias_m": None, "n_obs": 0}
    r = m.sim_head - m.water_level_mahd
    return {"rmse_m": float(np.sqrt((r ** 2).mean())), "bias_m": float(r.mean()), "n_obs": int(len(m)), "matched": m}


BUDGET_LABELS = {"RCHA": "Recharge (rain + deep drainage)", "RIV2": "Supply canal seepage", "RIV": "River",
                 "WEL": "Bore extraction", "EVTA": "Groundwater ET", "DRN": "Sub-surface drains", "DRN2": "Interceptor drains",
                 "CHD": "Regional boundary", "STO-SY": "Storage (water table)", "STO-SS": "Storage (elastic)"}


def budget_summary(res: dict, inp: Inputs) -> pd.DataFrame:
    """Monthly volumetric budget in ML (megalitres) by component, transient periods only."""
    inc = res["budget"]
    days = [1.0] + [pd.Timestamp(m).days_in_month for m in inp.months]
    rows = []
    for col in inc.columns:
        if col in ("kper", "TOTAL_IN", "TOTAL_OUT", "IN-OUT", "PERCENT_DISCREPANCY") or not (
                col.endswith("_IN") or col.endswith("_OUT")):
            continue
        comp, direction = col.rsplit("_", 1)
        for kper, v in enumerate(inc[col]):
            if kper == 0:
                continue
            rows.append((kper, BUDGET_LABELS.get(comp, comp), direction.lower(), float(v) * days[kper] / 1000.0))
    return pd.DataFrame(rows, columns=["kper", "component", "direction", "volume_ml"])
