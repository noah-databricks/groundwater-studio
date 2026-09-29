"""PEST++ calibration of a MODFLOW 6 model the Studio can edit (a build document, see buildkit.py).

Parameters are multipliers on the model's own values, so the calibrated model keeps its pattern and only its level moves:
K, K33, Sy and Ss per layer (or all layers), recharge, and the conductance of each river, drain or general-head package.
Observations are measured heads at cells and times (model time units). PEST++ runs as a master with local agents, each
running forward(): apply the multipliers to the base document, write MODFLOW 6 files, solve, and read the heads at the
observation times from a continuous head-observation file. pestpp-glm (Gauss-Levenberg-Marquardt, with first-order
posterior uncertainty) is the default; pestpp-ies (an iterative ensemble smoother) gives a posterior ensemble instead.
"""
from __future__ import annotations

import copy
import csv
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

import buildkit as bk

APP_DIR = os.path.dirname(os.path.abspath(__file__))
OBS_FILE = "calib.head.obs.csv"


class CalibrationError(ValueError):
    pass


# ---------------------------------------------------------------- what can be calibrated
def candidates(doc: dict) -> list[dict]:
    """Every parameter the model offers, with sensible default bounds (multipliers on its current values)."""
    g = doc["grid"]
    transient = any(not p.get("steady") for p in doc["time"]["periods"])
    icell = bk.A(doc, "icelltype")
    out = []
    for L in range(g["nlay"]):
        out.append({"name": f"k_l{L + 1}", "property": "k", "layer": L, "label": f"K, layer {L + 1}", "lower": 0.1, "upper": 10.0, "default": True})
        out.append({"name": f"k33_l{L + 1}", "property": "k33", "layer": L, "label": f"Vertical K, layer {L + 1}", "lower": 0.1, "upper": 10.0, "default": False})
        if transient:
            conv = bool(np.any(icell[L] > 0))
            out.append({"name": f"sy_l{L + 1}", "property": "sy", "layer": L, "label": f"Sy, layer {L + 1}", "lower": 0.5, "upper": 2.0, "default": conv})
            out.append({"name": f"ss_l{L + 1}", "property": "ss", "layer": L, "label": f"Ss, layer {L + 1}", "lower": 0.1, "upper": 10.0, "default": False})
    if doc.get("recharge"):
        out.append({"name": "rch", "property": "rch", "layer": None, "label": "Recharge", "lower": 0.5, "upper": 2.0, "default": True})
    if doc.get("et"):
        out.append({"name": "evt", "property": "evt", "layer": None, "label": "ET rate", "lower": 0.5, "upper": 2.0, "default": False})
    for kind, pkg in sorted({(b["type"], b["pkg"]) for b in doc["boundaries"] if b["type"] in ("riv", "drn", "ghb")}):
        nm = re.sub(r"[^a-z0-9]", "", pkg.lower())[:12] or kind
        out.append({"name": f"{kind}cond_{nm}", "property": "cond", "kind": kind, "pkg": pkg, "layer": None,
                    "label": f"{ {'riv': 'River', 'drn': 'Drain', 'ghb': 'General-head'}[kind]} conductance ({pkg})", "lower": 0.1, "upper": 10.0, "default": kind == "riv"})
    return out


def apply(doc: dict, params: list[dict], values: dict[str, float]) -> dict:
    """The document with every parameter's multiplier applied to its base values."""
    d = copy.deepcopy(doc)
    for p in params:
        f = float(values[p["name"]])
        prop = p["property"]
        if prop in ("k", "k33", "sy", "ss"):
            a = bk.A(d, prop)
            layers = range(a.shape[0]) if p.get("layer") in (None, "all") else [int(p["layer"])]
            for L in layers:
                a[L] *= f
            bk.put(d, prop, a)
        elif prop in ("rch", "evt"):
            key = "recharge" if prop == "rch" else "et"
            d[key] = {**d[key], "rate_mm_yr": bk.enc(bk.dec(d[key]["rate_mm_yr"]) * f)}
        elif prop == "cond":
            for b in d["boundaries"]:
                if b["type"] == p["kind"] and b["pkg"] == p["pkg"]:
                    b["cond"] = [c * f for c in b["cond"]]
        else:
            raise CalibrationError(f"Unknown parameter property {prop}.")
    return d


# ---------------------------------------------------------------- observations
def read_observations(text: str) -> list[dict]:
    """Measured heads from CSV. Columns (any order, any case): name (or bore/well/site), layer, row, col (1-based, as in
    MODFLOW files), time (model time units since the start; or days), head (or value/level/obs), and optionally weight."""
    rows = list(csv.DictReader(io.StringIO(text.lstrip("﻿"))))
    if not rows:
        raise CalibrationError("The observation file has no rows.")
    keys = {k.lower().strip(): k for k in rows[0]}
    pick = lambda *names: next((keys[n] for n in names if n in keys), None)
    kn, kl, kr, kc = pick("name", "bore", "bore_id", "well", "site", "obsname"), pick("layer", "lay", "k"), pick("row", "i"), pick("col", "column", "j")
    kt, kv, kw = pick("time", "days", "t", "totim"), pick("head", "value", "level", "obs", "water_level"), pick("weight", "w")
    missing = [n for n, k in (("layer", kl), ("row", kr), ("col", kc), ("time", kt), ("head", kv)) if k is None]
    if missing:
        raise CalibrationError(f"The observation file needs columns {', '.join(missing)} (found: {', '.join(rows[0])}).")
    out = []
    for i, r in enumerate(rows):
        try:
            out.append({"name": (r.get(kn) or f"obs{i + 1}").strip() if kn else f"obs{i + 1}", "layer": int(float(r[kl])) - 1, "row": int(float(r[kr])) - 1,
                        "col": int(float(r[kc])) - 1, "time": float(r[kt]), "value": float(r[kv]), "weight": float(r[kw]) if kw and r.get(kw) else 1.0})
        except (TypeError, ValueError):
            raise CalibrationError(f"Row {i + 2} of the observation file is not numeric where it should be: {r}")
    return out


def _check_obs(doc: dict, obs: list[dict]) -> None:
    g = doc["grid"]
    act = bk.A(doc, "idomain")
    for o in obs:
        if not (0 <= o["layer"] < g["nlay"] and 0 <= o["row"] < g["nrow"] and 0 <= o["col"] < g["ncol"]):
            raise CalibrationError(f"Observation {o['name']} is outside the grid (layer {o['layer'] + 1}, row {o['row'] + 1}, col {o['col'] + 1}; "
                                   f"the model is {g['nlay']} x {g['nrow']} x {g['ncol']}).")
        if act[o["layer"], o["row"], o["col"]] <= 0:
            raise CalibrationError(f"Observation {o['name']} is in an inactive cell.")


# ---------------------------------------------------------------- the PEST++ run directory
def setup(doc: dict, obs: list[dict], params: list[dict], method: str, workdir: str, mf6: str,
          iterations: int = 8, reals: int = 40, base: bytes | None = None) -> dict:
    """The PEST++ run directory. With the original package (base), each run writes only what the multipliers change
    and keeps everything else, locked packages included, exactly as uploaded."""
    if not doc.get("editable"):
        raise CalibrationError(doc.get("why_not") or "Only models the Studio can edit (MODFLOW 6, regular grid) can be calibrated.")
    if not obs:
        raise CalibrationError("Give at least one observation.")
    if not params:
        raise CalibrationError("Choose at least one parameter to calibrate.")
    if len(obs) < len(params) and method == "glm":
        raise CalibrationError(f"{len(obs)} observations cannot constrain {len(params)} parameters: add observations or calibrate fewer parameters.")
    _check_obs(doc, obs)
    shutil.rmtree(workdir, ignore_errors=True)
    tpl = os.path.join(workdir, "template")
    os.makedirs(tpl)
    # the base model, with one continuous head observation per observed cell
    cdoc = copy.deepcopy(doc)
    cells = list(dict.fromkeys((o["layer"], o["row"], o["col"]) for o in obs))
    cdoc["obs"] = [{"name": f"c{i}", "cell": list(c)} for i, c in enumerate(cells)]
    cdoc["obs_file"] = OBS_FILE
    cdoc["files"] = {k: v for k, v in (cdoc.get("files") or {}).items() if k != "obs"}
    if base is None and doc.get("locked"):
        raise CalibrationError("This model has parts kept as uploaded; calibrating it needs the original package.")
    if base is not None:
        open(os.path.join(tpl, "base.zip"), "wb").write(base)
    else:
        cdoc["origin"] = {}
    names = []
    for i, o in enumerate(obs):
        nm = f"o{i + 1}_" + re.sub(r"[^a-z0-9]", "", str(o["name"]).lower())[:24]
        names.append(nm)
    meta = {"params": params, "obs": [{**o, "pest_name": n, "cell_obs": f"c{cells.index((o['layer'], o['row'], o['col']))}"} for o, n in zip(obs, names)],
            "mf6": mf6, "method": method}
    json.dump(cdoc, open(os.path.join(tpl, "doc.json"), "w"))
    json.dump(meta, open(os.path.join(tpl, "meta.json"), "w"))
    open(os.path.join(tpl, "forward.py"), "w").write(
        f"import sys\nsys.path.insert(0, {APP_DIR!r})\nimport calibration\nsys.exit(calibration.forward())\n")
    open(os.path.join(tpl, "forward.sh"), "w").write(f'#!/bin/sh\nexec "{sys.executable}" forward.py\n')
    open(os.path.join(tpl, "params.tpl"), "w").write("ptf ~\n" + "".join(f"{p['name']} ~{p['name']:^20s}~\n" for p in params))
    open(os.path.join(tpl, "sim.ins"), "w").write("pif ~\n" + "".join(f"l1 !{n}!\n" for n in names))
    open(os.path.join(tpl, "params.dat"), "w").write("".join(f"{p['name']} 1.0\n" for p in params))
    npar, nobs = len(params), len(obs)
    pst = [
        "pcf", "* control data", "restart estimation", f"{npar} {nobs} 1 0 1", "1 1 single point 1 0 0",
        "10.0 -3.0 0.3 0.03 10", "10.0 10.0 0.001", "0.1", f"{int(iterations)} 0.005 4 4 0.005 4", "0 0 0",
        "* singular value decomposition", "1", f"{npar} 5.0e-7", "1",
        "* parameter groups", "mults relative 0.01 0.0 switch 2.0 parabolic",
        "* parameter data",
        *[f"{p['name']} log factor 1.0 {float(p['lower']):g} {float(p['upper']):g} mults 1.0 0.0 1" for p in params],
        "* observation groups", "heads",
        "* observation data",
        *[f"{n} {o['value']:.6f} {float(o.get('weight', 1.0)):g} heads" for n, o in zip(names, obs)],
        "* model command line", "sh forward.sh",  # PEST++ drops a leading "/" from the command, so no absolute paths here
        "* model input/output", "params.tpl params.dat", "sim.ins sim.out",
        "++max_run_fail(1)", "++overdue_giveup_fac(4)", "++panther_agent_restart_on_error(true)",
    ]
    if method == "ies":
        pst += [f"++ies_num_reals({int(reals)})", "++ies_bad_phi_sigma(2.0)"]
    else:
        pst += ["++uncertainty(true)", "++lambdas(0.1,1,10,100)"]
    open(os.path.join(tpl, "case.pst"), "w").write("\n".join(pst) + "\n")
    return {"workdir": workdir, "params": params, "observations": nobs, "cells": len(cells), "method": method}


def forward() -> int:
    """One PEST++ model run, in an agent's directory: multipliers -> MODFLOW 6 files -> solve -> heads at the obs times."""
    doc, meta = json.load(open("doc.json")), json.load(open("meta.json"))
    vals = {}
    for line in open("params.dat"):
        parts = line.split()
        if len(parts) >= 2:
            vals[parts[0]] = float(parts[1])
    d = apply(doc, meta["params"], vals)
    ws = os.path.abspath("model")
    files = bk.compile_doc(d, open("base.zip", "rb").read() if os.path.exists("base.zip") else None, ws)
    for f, b in files.items():  # verbatim parts come back in memory; the run needs them on disk
        fp = os.path.join(ws, f)
        if not os.path.exists(fp) or open(fp, "rb").read() != b:
            os.makedirs(os.path.dirname(fp) or ws, exist_ok=True)
            open(fp, "wb").write(b)
    for f in os.listdir(ws):
        if f not in files:
            os.remove(os.path.join(ws, f))
    r = subprocess.run([meta["mf6"], "mfsim.nam"], cwd=ws, capture_output=True, text=True, timeout=6 * 3600)
    if "Normal termination" not in r.stdout:
        sys.stderr.write(r.stdout[-2000:])
        return 1
    sim = simulated(os.path.join(ws, OBS_FILE), meta["obs"])
    with open("sim.out", "w") as f:
        for v in sim:
            f.write(f"{v:.8e}\n")
    return 0


def simulated(obs_csv: str, obs: list[dict]) -> list[float]:
    """Each observation's simulated head, interpolated in time from MODFLOW's continuous head output."""
    rows = list(csv.reader(open(obs_csv)))
    head = [h.strip().upper() for h in rows[0]]
    data = np.array([[float(x) for x in r] for r in rows[1:] if r], float)
    t = data[:, 0]
    out = []
    for o in obs:
        col = data[:, head.index(o["cell_obs"].upper())]
        out.append(float(col[0]) if len(t) == 1 else float(np.interp(o["time"], t, col)))
    return out


# ---------------------------------------------------------------- running PEST++ with local agents
def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def run(workdir: str, exe: str, agents: int, progress=None, timeout: float = 12 * 3600) -> dict:
    tpl = os.path.join(workdir, "template")
    master = os.path.join(workdir, "master")
    shutil.copytree(tpl, master)
    port = _free_port()
    meta = json.load(open(os.path.join(tpl, "meta.json")))
    iters = int(open(os.path.join(tpl, "case.pst")).read().splitlines()[8].split()[0])
    log = open(os.path.join(workdir, "pestpp.log"), "w")
    procs = [subprocess.Popen([exe, "case.pst", "/h", f":{port}"], cwd=master, stdout=log, stderr=subprocess.STDOUT)]
    time.sleep(1.5)
    for i in range(max(1, agents)):
        a = os.path.join(workdir, f"agent{i}")
        shutil.copytree(tpl, a)
        procs.append(subprocess.Popen([exe, "case.pst", "/h", f"127.0.0.1:{port}"], cwd=a, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    t0 = time.time()
    try:
        while procs[0].poll() is None:
            if time.time() - t0 > timeout:
                raise CalibrationError(f"PEST++ was stopped after {int(timeout)} s.")
            if progress:
                it, phi = _progress(master, meta["method"])
                progress(f"iteration {it} of {iters}" + (f", objective {phi:.4g}" if phi is not None else ""), it, max(iters, 1))
            time.sleep(2)
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        log.close()
    rec = os.path.join(master, "case.rec")
    text = open(rec, errors="replace").read() if os.path.exists(rec) else ""
    if procs[0].returncode not in (0, None) and "error" in text.lower()[-3000:]:
        raise CalibrationError("PEST++ stopped with an error:\n" + text[-1500:])
    return {"master": master, "seconds": round(time.time() - t0, 1)}


def _progress(master: str, method: str) -> tuple[int, float | None]:
    try:
        if method == "ies":
            p = os.path.join(master, "case.phi.actual.csv")
            rows = list(csv.DictReader(open(p))) if os.path.exists(p) else []
            return (int(float(rows[-1]["iteration"])), float(rows[-1]["mean"])) if rows else (0, None)
        p = os.path.join(master, "case.iobj")
        rows = list(csv.DictReader(open(p))) if os.path.exists(p) else []
        return (int(float(rows[-1]["iteration"])), float(rows[-1]["total_phi"])) if rows else (0, None)
    except (OSError, KeyError, ValueError, IndexError):
        return 0, None


# ---------------------------------------------------------------- results
def results(workdir: str) -> dict:
    """Calibrated multipliers, fit before and after (by running the model at both), residuals, sensitivities and
    parameter uncertainty (first-order for GLM, the posterior ensemble for IES)."""
    master = os.path.join(workdir, "master")
    meta = json.load(open(os.path.join(master, "meta.json")))
    params, method = meta["params"], meta["method"]
    best: dict[str, float] = {}
    spread: dict[str, dict] = {}
    if method == "ies":
        pars = sorted(Path(master).glob("case.*.par.csv"), key=lambda p: int(p.name.split(".")[1]))
        if not pars:
            raise CalibrationError("PEST++ IES produced no parameter ensemble; see pestpp.log.")
        rows = list(csv.DictReader(open(pars[-1])))
        # the best-fitting member of the final ensemble is the calibrated model; the ensemble's spread is its uncertainty
        phi_rows = list(csv.DictReader(open(os.path.join(master, "case.phi.actual.csv")))) if os.path.exists(os.path.join(master, "case.phi.actual.csv")) else []
        last = phi_rows[-1] if phi_rows else {}
        fixed = {"iteration", "total_runs", "mean", "standard_deviation", "min", "max"}
        by_real = {k: float(v) for k, v in last.items() if k not in fixed and v not in ("", None)}
        name_col = next(iter(rows[0])) if rows else "real_name"
        ranked = sorted((r for r in rows if r[name_col] in by_real), key=lambda r: by_real[r[name_col]])
        pick = ranked[0] if ranked else rows[0]
        for p in params:
            v = np.array([float(r[p["name"]]) for r in rows])
            best[p["name"]] = float(pick[p["name"]])
            spread[p["name"]] = {"post_lower": float(np.percentile(v, 10)), "post_upper": float(np.percentile(v, 90)), "band": "P10-P90 of the posterior ensemble"}
    else:
        parf = os.path.join(master, "case.par")
        if not os.path.exists(parf):
            cands = sorted(Path(master).glob("case.*.par"))
            if not cands:
                raise CalibrationError("PEST++ GLM produced no parameter file; see pestpp.log.")
            parf = str(cands[-1])
        for line in open(parf).read().splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 2:
                best[parts[0]] = float(parts[1])
        us = os.path.join(master, "case.par.usum.csv")
        if os.path.exists(us):
            for r in csv.DictReader(open(us)):
                nm = r.get("name") or r.get("parnme")
                if nm in best:
                    lo, hi = r.get("post_lower_bound"), r.get("post_upper_bound")
                    if lo and hi:  # log10 space for log-transformed parameters
                        spread[nm] = {"post_lower": 10 ** float(lo), "post_upper": 10 ** float(hi), "band": "95% posterior (first-order)"}
    for p in params:
        best.setdefault(p["name"], 1.0)
    # fit before and after, from the forward model itself
    before, after = _fit(master, {p["name"]: 1.0 for p in params}), _fit(master, best)
    sens = {}
    isen = os.path.join(master, "case.isen")
    if os.path.exists(isen):
        rows = list(csv.DictReader(open(isen)))
        if rows:
            last = rows[-1]
            sens = {p["name"]: float(last[p["name"]]) for p in params if p["name"] in last and last[p["name"]] not in ("", None)}
    phis = []
    for f in ("case.iobj", "case.phi.actual.csv"):
        fp = os.path.join(master, f)
        if os.path.exists(fp):
            for r in csv.DictReader(open(fp)):
                try:
                    phis.append({"iteration": int(float(r["iteration"])), "phi": float(r.get("total_phi") or r.get("mean"))})
                except (KeyError, ValueError, TypeError):
                    pass
    return {"method": method, "parameters": [{"name": p["name"], "label": p.get("label", p["name"]), "multiplier": round(best[p["name"]], 6),
                                              "lower": p["lower"], "upper": p["upper"], **({k: round(v, 6) if isinstance(v, float) else v for k, v in spread[p["name"]].items()} if p["name"] in spread else {}),
                                              **({"sensitivity": round(sens[p["name"]], 6)} if p["name"] in sens else {}),
                                              "at_bound": bool(abs(np.log(best[p["name"]] / p["lower"])) < 0.01 or abs(np.log(best[p["name"]] / p["upper"])) < 0.01)}
                                             for p in params],
            "fit_before": before["stats"], "fit_after": after["stats"], "residuals": after["residuals"], "objective_by_iteration": phis}


def _fit(master: str, vals: dict[str, float]) -> dict:
    d = os.path.join(master, "_fit")
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(os.path.join(master, "..", "template"), d)
    open(os.path.join(d, "params.dat"), "w").write("".join(f"{k} {v:.10g}\n" for k, v in vals.items()))
    here = os.getcwd()
    try:
        os.chdir(d)
        if forward() != 0:
            return {"stats": None, "residuals": []}
        sim = [float(x) for x in open("sim.out").read().split()]
    finally:
        os.chdir(here)
    meta = json.load(open(os.path.join(d, "meta.json")))
    res = [{"name": o["name"], "time": o["time"], "layer": o["layer"], "row": o["row"], "col": o["col"], "observed": o["value"],
            "simulated": round(s, 4), "residual": round(o["value"] - s, 4)} for o, s in zip(meta["obs"], sim)]
    r = np.array([x["residual"] for x in res])
    return {"stats": {"rmse_m": round(float(np.sqrt(np.mean(r ** 2))), 4), "mean_residual_m": round(float(r.mean()), 4),
                      "max_abs_residual_m": round(float(np.abs(r).max()), 4), "n": len(res)}, "residuals": res}
