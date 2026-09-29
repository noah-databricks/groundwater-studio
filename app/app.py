"""Groundwater Studio: MODFLOW 6 as a Databricks App.

Identity model
- User (on-behalf-of, `sql` + `files.files` scopes): every read of model inputs, observations and
  results runs as the signed-in researcher, so UC grants, row filters and column masks apply.
  Archive downloads also run as the user, so READ VOLUME on the runs volume gates them.
- App service principal: the controlled writer. It fetches the governed mf6 binary, writes run
  results to UC (stamped with the user's identity), archives model files to a Volume, logs to
  MLflow and triggers the Spark ensemble job.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import shutil
import json
import logging
import os
import sys
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from databricks.sdk import WorkspaceClient
from databricks.sdk.core import Config
from databricks.sdk.service.sql import Disposition, Format, StatementParameterListItem, StatementState
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from typing import Literal

from pydantic import BaseModel, Field

import buildkit
import gwmodel
import mf6files

log = logging.getLogger("studio")
logging.basicConfig(level=logging.INFO)

CATALOG = os.getenv("UC_CATALOG", "main")
SCHEMA = os.getenv("UC_SCHEMA", "groundwater_studio")
FQ = f"{CATALOG}.{SCHEMA}"
WAREHOUSE_ID = os.getenv("WAREHOUSE_ID", "")
JOB_ID = int(os.getenv("ENSEMBLE_JOB_ID", "0") or 0)
SCENARIO_JOB_ID = int(os.getenv("SCENARIO_JOB_ID", "0") or 0)
EXPERIMENT_ID = os.getenv("MLFLOW_EXPERIMENT_ID", "")
BIN_VOLUME = f"/Volumes/{CATALOG}/{SCHEMA}/mf6_bin"
RUNS_VOLUME = f"/Volumes/{CATALOG}/{SCHEMA}/model_runs"
WORK = Path(os.getenv("STUDIO_WORKDIR", "/tmp/studio"))
INPUT_TABLES = ["aquifer_cells", "boundary_cells", "bores", "bore_extractions_monthly", "weather_monthly"]
ORDER = {"aquifer_cells": "layer, row, col", "boundary_cells": "kind, layer, row, col", "bores": "bore_id",
         "bore_extractions_monthly": "bore_id, month", "weather_monthly": "station_id, month",
         "bore_water_levels": "bore_id, obs_date"}  # deterministic model input order

# imported by a Lakeflow task or served over stdio inside an agent's sandbox: everything runs as that identity
HEADLESS = os.getenv("MODFLOW_OS_HOST") in ("job", "sandbox")
cfg = Config()
sp = WorkspaceClient()
pool = ThreadPoolExecutor(max_workers=max(2, os.cpu_count() or 2))  # mf6 is single-threaded: one solve per vCPU
filer = ThreadPoolExecutor(max_workers=1)  # runs are filed in order, one at a time
_known_studies: set[str] = set()
state = {"mf6": None, "mf6_error": None, "platform": gwmodel.platform_tag()}
runs: dict[str, dict] = {}  # in-memory status of persistence for runs started by this replica
_input_cache: dict[str, tuple[float, dict]] = {}
_baseline_cache: dict[str, dict] = {}
_lock = threading.Lock()

app = FastAPI(title="Groundwater Studio")


# ---------------------------------------------------------------- identity + SQL
def user_client(request: Request) -> WorkspaceClient:
    token = request.headers.get("x-forwarded-access-token")
    if not token:
        if os.getenv("STUDIO_LOCAL") or HEADLESS:
            return sp
        raise HTTPException(401, "No user token forwarded. Enable user authorization (scopes: sql, files.files).")
    return WorkspaceClient(host=cfg.host, token=token, auth_type="pat")


_me: list[str] = []


def user_email(request: Request) -> str:
    who = request.headers.get("x-forwarded-email") or request.headers.get("x-forwarded-preferred-username")
    if who:
        return who
    if HEADLESS:
        if not _me:
            _me.append(sp.current_user.me().user_name)
        return _me[0]
    return "local-dev"


_CAST = {"INT": "Int64", "LONG": "Int64", "SHORT": "Int64", "BYTE": "Int64", "DOUBLE": float, "FLOAT": float,
         "DECIMAL": float}


def sql(w: WorkspaceClient, statement: str, params: dict | None = None) -> pd.DataFrame:
    r = w.statement_execution.execute_statement(
        statement=statement, warehouse_id=WAREHOUSE_ID, wait_timeout="50s",
        disposition=Disposition.INLINE, format=Format.JSON_ARRAY,
        parameters=[StatementParameterListItem(name=k, value=None if v is None else str(v)) for k, v in (params or {}).items()])
    while r.status.state in (StatementState.PENDING, StatementState.RUNNING):
        time.sleep(0.5)
        r = w.statement_execution.get_statement(r.statement_id)
    if r.status.state != StatementState.SUCCEEDED:
        msg = r.status.error.message if r.status.error else str(r.status.state)
        raise HTTPException(403 if "PERMISSION" in msg.upper() or "INSUFFICIENT" in msg.upper() else 500, msg[:600])
    if not r.manifest or not r.manifest.schema or not r.manifest.schema.columns:
        return pd.DataFrame()
    cols = r.manifest.schema.columns
    rows = list(r.result.data_array or []) if r.result else []
    chunk = r.result.next_chunk_index if r.result else None
    while chunk:
        c = w.statement_execution.get_statement_result_chunk_n(r.statement_id, chunk)
        rows += c.data_array or []
        chunk = c.next_chunk_index
    df = pd.DataFrame(rows, columns=[c.name for c in cols])
    for c in cols:
        t = c.type_name.value if c.type_name else ""
        if t in _CAST:
            df[c.name] = pd.to_numeric(df[c.name]).astype(_CAST[t])
        elif t == "BOOLEAN":
            df[c.name] = df[c.name].map({"true": True, "false": False})
        elif t in ("DATE", "TIMESTAMP"):
            df[c.name] = pd.to_datetime(df[c.name])
    return df


def lit(v) -> str:
    if isinstance(v, (list, tuple)):
        return "array(" + ",".join(lit(x) for x in v) + ")" if v else "array()"
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return "NULL"
    if isinstance(v, (bool, np.bool_)):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float, np.integer, np.floating)):
        return repr(float(v)) if isinstance(v, (float, np.floating)) else str(int(v))
    if isinstance(v, (pd.Timestamp, datetime)):
        return f"TIMESTAMP'{pd.Timestamp(v).strftime('%Y-%m-%d %H:%M:%S')}'"
    return "'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'"


def insert(table: str, df: pd.DataFrame, batch: int = 1200):
    for i in range(0, len(df), batch):
        part = df.iloc[i:i + batch]
        values = ",\n".join("(" + ",".join(lit(v) for v in row) + ")" for row in part.itertuples(index=False))
        sql(sp, f"INSERT INTO {FQ}.{table} ({','.join(df.columns)}) VALUES {values}")


# ---------------------------------------------------------------- mf6 bootstrap
def _install_mf6():
    def fetch(rel, dst):
        resp = sp.files.download(f"{BIN_VOLUME}/{rel}")
        with open(dst, "wb") as f:
            f.write(resp.contents.read())

    try:
        t = time.time()
        exe = os.getenv("MF6_EXE") or gwmodel.install_mf6(fetch, str(WORK / "bin"))  # MF6_EXE: local dev only
        import subprocess

        ver = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
        state.update(mf6=exe, mf6_version=ver, mf6_install_s=round(time.time() - t, 1))
        log.info("mf6 ready: %s (%s)", exe, ver)
    except Exception as e:  # surfaced in /api/me so the UI can explain
        log.exception("mf6 install failed")
        state["mf6_error"] = repr(e)


@app.on_event("startup")
def startup():
    WORK.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_install_mf6, daemon=True).start()


_engines: dict[str, str] = {}
ENGINE_FILES = {"mf2005": "classic/linux-x86_64/mf2005", "mfnwt": "classic/linux-x86_64/mfnwt", "mfusg": "classic/linux-x86_64/mfusg",
                "mf5to6": "classic/linux-x86_64/mf5to6", "zbud6": "classic/linux-x86_64/zbud6",
                "pestpp-glm": "pestpp/linux-x86_64/pestpp-glm", "pestpp-ies": "pestpp/linux-x86_64/pestpp-ies", "pestpp-sen": "pestpp/linux-x86_64/pestpp-sen"}


def require_engine(name: str) -> str:
    """An executable from the governed binaries volume, fetched on first use: MODFLOW 6, the classic engines
    (MODFLOW-2005, NWT, USG), the mf5to6 converter, or PEST++."""
    if name == "mf6":
        return require_mf6()
    if name not in ENGINE_FILES:
        raise HTTPException(422, f"Unknown engine {name}.")
    with _lock:
        if name in _engines and os.path.exists(_engines[name]):
            return _engines[name]
    dest = WORK / "bin" / ENGINE_FILES[name]
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(f".tmp{os.getpid()}")
        try:
            with open(tmp, "wb") as f:
                f.write(sp.files.download(f"{BIN_VOLUME}/{ENGINE_FILES[name]}").contents.read())
        except Exception as e:
            raise HTTPException(503, f"The {name} executable is not available: {e}"[:300])
        os.chmod(tmp, 0o755)
        os.replace(tmp, dest)
    with _lock:
        _engines[name] = str(dest)
    return str(dest)


def require_mf6() -> str:
    for _ in range(120):
        if state["mf6"]:
            return state["mf6"]
        if state["mf6_error"]:
            raise HTTPException(503, f"MODFLOW executable unavailable: {state['mf6_error']}")
        time.sleep(0.5)
    raise HTTPException(503, "MODFLOW executable still installing")


# ---------------------------------------------------------------- inputs from UC (as the user)
def load_inputs(request: Request) -> dict:
    who = user_email(request)
    now = time.time()
    hit = _input_cache.get(who)
    if hit and now - hit[0] < 600:
        return hit[1]
    w = user_client(request)
    t = time.time()
    frames = {}
    with ThreadPoolExecutor(6) as ex:
        futs = {name: ex.submit(sql, w, f"SELECT * FROM {FQ}.{name} ORDER BY {ORDER[name]}") for name in INPUT_TABLES + ["bore_water_levels"]}
        for name, f in futs.items():
            frames[name] = f.result()
    obs = frames.pop("bore_water_levels")
    inp = gwmodel.inputs_from_frames(*[frames[n] for n in INPUT_TABLES])
    digest = hashlib.sha1(b"".join(
        pd.util.hash_pandas_object(frames[n].drop(columns=["landholder", "licence_no"], errors="ignore"),
                                   index=False).values.tobytes() for n in INPUT_TABLES)).hexdigest()[:12]
    entry = {"inp": inp, "frames": frames, "obs": obs, "digest": digest, "read_as": who,
             "read_s": round(time.time() - t, 2), "read_at": datetime.now(timezone.utc).isoformat()}
    _input_cache[who] = (now, entry)
    return entry


def simulate(entry: dict, scenario: dict, run_id: str, progress=None) -> dict:
    exe = require_mf6()
    ws = str(WORK / "runs" / run_id)
    res = gwmodel.run(entry["inp"], scenario, ws, exe, progress=progress)
    if not res["ok"]:
        raise HTTPException(422, "MODFLOW did not converge: " + res["stdout_tail"][-600:])
    return res


_solved: dict[str, dict] = {}


def _solution_key(entry: dict, scenario: dict) -> str:
    return entry["digest"] + hashlib.sha1(json.dumps(norm(scenario), sort_keys=True).encode()).hexdigest()[:16]


def keep_solution(entry: dict, scenario: dict, res: dict) -> None:
    """Remember a solve's heads and cell-by-cell budget so probes (a cell, a zone, a section) answer at once."""
    slim = {k: res[k] for k in ("dtw", "heads", "cell_budget", "fidelity") if k in res}
    with _lock:
        _solved[_solution_key(entry, scenario)] = slim
        while len(_solved) > 16:
            _solved.pop(next(iter(_solved)))


def solution(entry: dict, scenario: dict) -> dict:
    """A scenario's full solution, every month: from memory, or solved again (MODFLOW is deterministic)."""
    key = _solution_key(entry, scenario)
    with _lock:
        hit = _solved.get(key)
    if hit and "cell_budget" in hit:
        return hit
    res = simulate(entry, norm(scenario), f"probe-{key[-12:]}")
    keep_solution(entry, scenario, res)
    return _solved[key]


def fid_key(f: dict | None) -> str:
    f = gwmodel.fidelity_of({"fidelity": f})
    return f"r{f['refine']}l{f['sublayers']}t{f['nstp']}{f['solver'][0]}"


def baseline(entry: dict, fidelity: dict | None = None, progress=None) -> dict:
    """The calibrated baseline at the same fidelity as the scenario, so a change is the scenario's and not the grid's."""
    key = f"{entry['digest']}-{fid_key(fidelity)}"
    with _lock:
        if key in _baseline_cache:
            return _baseline_cache[key]
    res = simulate(entry, {"fidelity": fidelity} if fidelity else {}, f"baseline-{key}", progress)
    keep_solution(entry, {"fidelity": fidelity} if fidelity else {}, res)
    st = water_stats(entry, res)
    b = {"dtw": res["dtw"], "hyd": st["hyd"], "area": st["area"], "kpis": st["kpis"], "reaches": res["reach_seepage_ml"]}
    with _lock:
        _baseline_cache[key] = b
    return b


# ---------------------------------------------------------------- payload shaping
def r2(a, nd=2):
    a = np.asarray(a, dtype=float)
    return np.where(np.isfinite(a), np.round(a, nd), None).tolist()


def grid_payload(entry):
    inp, f = entry["inp"], entry["frames"]
    b = f["boundary_cells"]
    bores = f["bores"]
    return {
        "nrow": inp.nrow, "ncol": inp.ncol, "cell_km": inp.delr / 1000,
        "periods": gwmodel.period_labels(inp),
        "top": r2(inp.top), "botm": [r2(b) for b in inp.botm],
        "grid": {"nlay": inp.nlay, "nrow": inp.nrow, "ncol": inp.ncol, "delr_km": inp.delr / 1000,
                 "delc_km": inp.delc / 1000},
        "irrigated": inp.irrigated.astype(int).tolist(),
        "land_use": inp.land_use.tolist(),
        "crops": [{"code": k, **v} for k, v in gwmodel.CROPS.items()],
        "reaches": reach_payload(inp),
        "features": {k: b[b.kind == k][["row", "col", "name"]].to_dict("records") for k in ["river", "canal", "drain"]},
        "bores": bores[["bore_id", "bore_type", "layer", "row", "col", "lon", "lat", "landholder", "licence_no",
                        "entitlement_ml"]].replace({np.nan: None}).to_dict("records"),
    }


def reach_payload(inp) -> list[dict]:
    canal = gwmodel.canal_reaches(inp)
    out = []
    for rid, g in canal.groupby("reach", sort=True):
        g = g.sort_values(["col", "row"] if g.name.iloc[0] == "Main Canal" else ["row", "col"])
        out.append({"id": rid, "channel": g.name.iloc[0], "cells": g[["row", "col"]].to_dict("records"),
                    "length_km": round(len(g) * inp.delr / 1000, 2)})
    return out


def water_stats(entry, res) -> dict:
    """Headline numbers shared by the scenario and its baseline, so the two can be compared row by row."""
    inp = entry["inp"]
    hyd = gwmodel.hydrographs(inp, res)
    fit = gwmodel.fit_stats(hyd, entry["obs"])
    bud = gwmodel.budget_summary(res, inp)
    bud["component"] = bud.component.replace({"Storage (elastic)": "Storage", "Storage (water table)": "Storage"})
    bud = bud.groupby(["kper", "component", "direction"], as_index=False).volume_ml.sum()
    fine = res.get("dtw_fine", res["dtw"])  # areas and medians at the resolution MODFLOW solved
    area = [float(100 * np.nanmean(d < gwmodel.SALINITY_RISK_DTW_M)) for d in fine]
    tot = lambda comp, d: float(bud[(bud.component == comp) & (bud.direction == d)].volume_ml.sum())
    kpis = {
        "pct_area_dtw_lt_2m_final": area[-1], "pct_area_dtw_lt_2m_peak": max(area[1:]),
        "median_dtw_m": float(np.nanmedian(fine[-1])),
        "rmse_m": fit["rmse_m"], "bias_m": fit["bias_m"], "n_obs": fit["n_obs"],
        "canal_seepage_ml": tot("Supply canal seepage", "in"), "bore_extraction_ml": tot("Bore extraction", "out"),
        "recharge_ml": tot("Recharge (rain + deep drainage)", "in"), "gw_et_ml": tot("Groundwater ET", "out"),
        "interceptor_drain_ml": tot("Interceptor drains", "out"),
    }
    return {"hyd": hyd, "fit": fit, "bud": bud, "area": area, "kpis": kpis}


def result_payload(entry, res, base, scenario, run_id):
    inp = entry["inp"]
    st = water_stats(entry, res)
    hyd, fit, bud = st["hyd"], st["fit"], st["bud"]
    dtw = res["dtw"]
    area_lt2, base_lt2 = st["area"], base["area"]
    change = dtw[-1] - base["dtw"][-1]
    per_bore = {}
    if fit.get("matched") is not None:
        m = fit["matched"]
        per_bore = m.assign(r=(m.sim_head - m.water_level_mahd) ** 2).groupby("bore_id").r.mean().pow(.5).round(3).to_dict()
    obs = entry["obs"]
    disc = res["budget"]["PERCENT_DISCREPANCY"].abs().max()
    kpis = {
        **st["kpis"], "baseline_pct_area_dtw_lt_2m_final": base_lt2[-1],
        "mean_wt_change_m": float(np.nanmean(change)), "max_wt_rise_m": float(-np.nanmin(change)),
        "max_wt_fall_m": float(np.nanmax(change)),
        "max_discrepancy_pct": float(disc), "run_s": res["run_s"], "write_s": res["write_s"],
    }
    return {
        "run_id": run_id, "scenario": scenario, "kpis": kpis, "baseline_kpis": base["kpis"],
        "reach_seepage_ml": res["reach_seepage_ml"], "baseline_reach_seepage_ml": base["reaches"],
        "dtw": [r2(d) for d in dtw], "baseline_dtw": [r2(d) for d in base["dtw"]], "change_final": r2(change, 3),
        "area_lt2": area_lt2, "baseline_area_lt2": base_lt2,
        "hydrographs": {bid: {"sim": r2(g.sort_values("kper").sim_head, 3)} for bid, g in hyd.groupby("bore_id")},
        "baseline_hydrographs": {bid: r2(g.sort_values("kper").sim_head, 3) for bid, g in base["hyd"].groupby("bore_id")},
        "observed": {bid: {"t": g.obs_date.dt.strftime("%Y-%m-%d").tolist(), "h": r2(g.water_level_mahd, 3)}
                     for bid, g in obs.sort_values("obs_date").groupby("bore_id")},
        "bore_rmse": per_bore,
        "budget": bud.assign(volume_ml=bud.volume_ml.round(1)).to_dict("records"),
        "fidelity": res.get("fidelity"),
        "inputs": {"read_as": entry["read_as"], "read_s": entry["read_s"], "digest": entry["digest"]},
        "stdout_tail": res["stdout_tail"][-700:],
    }


# ---------------------------------------------------------------- persistence (service principal)
def persist(run_id: str, entry: dict, res: dict, payload: dict, who: str, label: str, ref: dict | None = None,
            study_id: str | None = None, origin: str = "api"):
    st = runs.setdefault(run_id, {})
    inp = entry["inp"]
    archive = f"{RUNS_VOLUME}/runs/{run_id}/model.zip"
    up = threading.Thread(target=_archive, args=(st, run_id, res, payload, who, archive), daemon=True)
    up.start()  # the model files upload runs alongside MLflow; Delta rows are written once both are known
    mlflow_run_id = _log_mlflow(st, run_id, entry, payload, who, label, ref, study_id, origin, archive)
    up.join()
    if not st["volume"]["ok"]:
        archive = None
    _file_delta(st, run_id, entry, res, payload, who, label, ref, study_id, origin, archive, mlflow_run_id)
    st["done"] = True


def _archive(st, run_id, res, payload, who, archive):
    try:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for p in Path(res["ws"]).iterdir():
                z.write(p, p.name)
            z.writestr("scenario.json", json.dumps(payload["scenario"], indent=1))
            z.writestr("README.txt", f"MODFLOW 6 model from Groundwater Studio\nrun_id={run_id}\nrun_by={who}\n"
                                     f"Run locally: mf6 mfsim.nam  (or flopy.mf6.MFSimulation.load)\n")
        buf.seek(0)
        sp.files.upload(archive, buf, overwrite=True)
        st["volume"] = {"ok": True, "path": archive, "bytes": buf.getbuffer().nbytes}
    except Exception as e:
        log.exception("archive upload failed")
        st["volume"] = {"ok": False, "error": repr(e)[:300]}


def _log_mlflow(st, run_id, entry, payload, who, label, ref, study_id, origin, archive):
    mlflow_run_id = None
    try:
        import mlflow

        mlflow.set_tracking_uri("databricks")
        k = payload["kpis"]
        with mlflow.start_run(experiment_id=EXPERIMENT_ID, run_name=label or f"scenario {run_id[:8]}") as mr:
            s = payload["scenario"]
            mlflow.set_tags({"run_type": "single", "run_by": who, "studio_run_id": run_id, "engine": state.get("mf6_version", ""),
                             "compute": f"{os.getenv('MODFLOW_OS_HOST') or 'Databricks App'} ({state['platform']})", "inputs_digest": entry["digest"],
                             "archive": archive or "", "origin": origin, "study_id": study_id or ""})
            fp = gwmodel.fidelity_of(s)
            mlflow.log_params({**{k2: v for k2, v in s.items() if k2 not in ("extra_bores", "land_use", "lined_reaches", "fidelity", "drain_lines")},
                               "drain_lines": json.dumps(s.get("drain_lines", []))[:5000],
                               **{f"fidelity_{k2}": v for k2, v in fp.items()}, "cell_m": gwmodel.fidelity_size(entry["inp"], fp)["cell_m"],
                               "extra_bores": json.dumps(s.get("extra_bores", []))[:5000],
                               "lined_reaches": ",".join(s.get("lined_reaches", [])) or "none",
                               "land_use_cells_changed": len(s.get("land_use", [])),
                               "scenario_ref": f"{ref['name']} v{ref['version']}" if ref else "unsaved"})
            mlflow.log_dict(s, "scenario.json")
            mlflow.log_metrics({k2: float(v) for k2, v in k.items() if isinstance(v, (int, float)) and v is not None})
            mlflow_run_id = mr.info.run_id
        st["mlflow"] = {"ok": True, "run_id": mlflow_run_id,
                        "url": f"{cfg.host}/ml/experiments/{EXPERIMENT_ID}/runs/{mlflow_run_id}"}
    except Exception as e:
        log.exception("mlflow failed")
        st["mlflow"] = {"ok": False, "error": repr(e)[:300]}
    return mlflow_run_id


def _file_delta(st, run_id, entry, res, payload, who, label, ref, study_id, origin, archive, mlflow_run_id):
    inp = entry["inp"]
    try:
        k = payload["kpis"]
        insert("model_runs", pd.DataFrame([{
            "run_id": run_id, "created_at": pd.Timestamp.now("UTC").tz_localize(None), "run_by": who, "label": label,
            "scenario_json": json.dumps(payload["scenario"]), "status": "SUCCEEDED",
            "mf6_version": state.get("mf6_version", ""), "runtime_s": k["run_s"], "rmse_m": k["rmse_m"],
            "bias_m": k["bias_m"], "n_obs": k["n_obs"], "pct_area_dtw_lt_2m": k["pct_area_dtw_lt_2m_final"],
            "max_drawdown_m": k["max_wt_fall_m"], "canal_seepage_ml": k["canal_seepage_ml"],
            "bore_extraction_ml": k["bore_extraction_ml"], "archive_path": archive, "mlflow_run_id": mlflow_run_id,
            "inputs_read_as": entry["read_as"],
            "scenario_name": ref["name"] if ref else None, "scenario_version": ref["version"] if ref else None,
            "study_id": study_id, "origin": origin, "inputs_digest": entry["digest"]}]))
        lu = gwmodel.land_use_for(inp, payload["scenario"])
        dtw, chg = np.asarray(res["dtw"][-1], float), np.asarray(payload["change_final"], dtype=float)
        rr, cc = np.nonzero(np.isfinite(dtw))
        insert("run_cell_results", pd.DataFrame({"run_id": run_id, "row": rr, "col": cc, "dtw_final_m": dtw[rr, cc].round(3),
                                                 "change_m": (-chg[rr, cc]).round(3), "land_use": lu[rr, cc]}))
        lined = set(payload["scenario"].get("lined_reaches", []))
        insert("run_reach_seepage", pd.DataFrame([{"run_id": run_id, "reach": r, "seepage_ml": round(float(v), 2),
                                                   "lined": r in lined} for r, v in res["reach_seepage_ml"].items()]))
        hyd = gwmodel.hydrographs(inp, res).dropna(subset=["month"])
        o = entry["obs"].assign(month=lambda d: d.obs_date.dt.to_period("M").dt.to_timestamp())
        o = o.groupby(["bore_id", "month"], as_index=False).water_level_mahd.mean()
        hyd = hyd.merge(o, on=["bore_id", "month"], how="left")
        insert("run_bore_heads", pd.DataFrame({"run_id": run_id, "bore_id": hyd.bore_id,
                                               "month": hyd.month.dt.strftime("%Y-%m-%d"),
                                               "sim_head_mahd": hyd.sim_head.round(3),
                                               "obs_head_mahd": hyd.water_level_mahd.round(3)}))
        b = pd.DataFrame(payload["budget"])
        months = gwmodel.period_labels(inp)
        insert("run_water_budget", pd.DataFrame({"run_id": run_id, "month": [months[i] + "-01" for i in b.kper],
                                                 "component": b.component, "direction": b.direction,
                                                 "volume_ml": b.volume_ml}))
        st["uc"] = {"ok": True, "tables": [f"{FQ}.{t}" for t in ("model_runs", "run_bore_heads", "run_water_budget",
                                                                  "run_cell_results", "run_reach_seepage")]}
    except Exception as e:
        log.exception("uc write failed")
        st["uc"] = {"ok": False, "error": getattr(e, "detail", repr(e))[:400]}


# ---------------------------------------------------------------- API
class Scenario(BaseModel):
    k_mult: float = Field(1.0, ge=0.1, le=10)
    sy: float = Field(0.08, ge=0.01, le=0.35)
    rain_mult: float = Field(1.0, ge=0, le=3)
    et_mult: float = Field(1.0, ge=0.5, le=1.5)
    deep_drainage_frac: float = Field(0.12, ge=0, le=0.5)
    pumping_mult: float = Field(1.0, ge=0, le=5)
    canal_lining_pct: float = Field(0, ge=0, le=100)
    lined_reaches: list[str] = []
    land_use: list[tuple[int, int, str]] = []
    extra_bores: list[dict] = []
    drain_lines: list["DrainLine"] = Field(default_factory=list, description="Proposed sub-surface (interceptor) drains")
    fidelity: "Fidelity | None" = None


class DrainLine(BaseModel):
    """A proposed sub-surface drain: a line of cells in the shallow aquifer that removes water above its invert."""
    name: str = Field("", description="Short id, e.g. D1 (given one if blank)")
    cells: list[tuple[int, int]] = Field(..., min_length=1, description="[row, col] along the drain; gaps between "
                                         "consecutive cells are filled in a straight line, so the two ends of a straight drain are enough")
    depth_m: float = Field(gwmodel.DRAIN_DEPTH_M, ge=0.5, le=5, description="Invert depth below the land surface, m")
    cond: float = Field(gwmodel.DRAIN_COND, ge=10, le=5000, description="Conductance per 250 m of drain, m2/d")


class Fidelity(BaseModel):
    """How finely MODFLOW discretises the district. The inputs stay at 250 m, two aquifers and monthly forcing."""
    refine: int = Field(1, description="Split each 250 m cell into refine x refine cells: 1 (250 m), 2 (125 m), 3, 4 (62.5 m), 5 (50 m), 6, 8 (31 m), 10 (25 m)")
    sublayers: int = Field(1, ge=1, le=6, description="Model layers per aquifer (vertical resolution)")
    nstp: int = Field(2, ge=1, le=31, description="Time steps per monthly stress period")
    solver: Literal["fast", "standard", "tight"] = Field("standard", description="Convergence: fast 1e-2 m, standard 1e-3 m, tight 1e-5 m")


Scenario.model_rebuild()


class ScenarioRef(BaseModel):
    name: str
    version: int


class RunRequest(BaseModel):
    scenario: Scenario = Scenario()
    label: str = ""
    persist: bool = True  # the page's initial baseline render is not recorded
    ref: ScenarioRef | None = None  # the saved scenario version this run was issued from, if any
    study_id: str | None = None


class EnsembleVary(BaseModel):
    """What varies across realizations, around the scenario's own values. 0 holds a parameter at the scenario's value."""
    k: float = Field(0.35, ge=0, le=1.5, description="Log standard deviation of hydraulic conductivity (0.35 is about x0.7 to x1.4)")
    k_by_aquifer: bool = Field(True, description="Vary upper aquifer and lower aquifer conductivity independently")
    sy: float = Field(0.5, ge=0, le=0.9, description="Specific yield, uniform +/- this fraction of the scenario value")
    deep_drainage: float = Field(0.5, ge=0, le=0.9, description="On-farm deep drainage, uniform +/- this fraction")
    rain: float = Field(0.15, ge=0, le=0.6, description="Standard deviation of a rainfall multiplier")


class EnsembleRequest(BaseModel):
    scenario: Scenario = Scenario()
    n: int = Field(64, ge=4, le=1000)
    label: str = ""
    k_log_sigma: float | None = None  # the original request shape; vary.k replaces it
    vary: EnsembleVary = EnsembleVary()
    rmse_threshold_m: float = 0.25
    study_id: str | None = None
    scenario_name: str | None = None


@app.get("/api/me")
def me(request: Request):
    return {"email": user_email(request), "obo": bool(request.headers.get("x-forwarded-access-token")),
            "platform": state["platform"], "mf6": bool(state["mf6"]), "mf6_version": state.get("mf6_version"),
            "mf6_install_s": state.get("mf6_install_s"), "mf6_error": state["mf6_error"],
            "host": cfg.host, "catalog": CATALOG, "schema": SCHEMA, "job_id": JOB_ID, "experiment_id": EXPERIMENT_ID,
            "scenario_job_id": SCENARIO_JOB_ID,
            "cpus": os.cpu_count()}


@app.get("/api/model")
async def model(request: Request):
    entry = await asyncio.get_running_loop().run_in_executor(pool, load_inputs, request)
    return grid_payload(entry) | {"inputs": {"read_as": entry["read_as"], "read_s": entry["read_s"],
                                             "digest": entry["digest"]}}


def origin_of(request) -> str:
    """Who is driving: the Studio sends its own header; MCP and jobs identify themselves the same way."""
    return (request.headers.get("x-modflow-client") or os.getenv("MODFLOW_OS_CLIENT") or "api")[:120]


async def do_run(request, scenario: dict, label: str = "", persist_run: bool = True, ref: dict | None = None,
                 study_id: str | None = None, progress=None) -> dict:
    """The one way a scenario is simulated and filed, whether the Studio, REST, MCP or a job asked."""
    loop = asyncio.get_running_loop()
    entry = await loop.run_in_executor(None if progress else pool, load_inputs, request)
    scenario = norm(scenario)
    fid = scenario.get("fidelity")
    ex = None if progress else pool  # background tasks already own a worker; they do not queue behind quick runs
    base = await loop.run_in_executor(ex, baseline, entry, fid, (lambda st, a, b: progress("baseline " + st, a, b)) if progress else None)
    run_id = uuid.uuid4().hex[:12]
    res = await loop.run_in_executor(ex, simulate, entry, scenario, run_id, progress)
    keep_solution(entry, scenario, res)
    payload = result_payload(entry, res, base, scenario, run_id)
    payload["persisted"] = persist_run
    if persist_run:
        if study_id and study_id not in _known_studies:
            await loop.run_in_executor(None, get_study_row, request, study_id)  # must exist and be visible
            _known_studies.add(study_id)
        runs[run_id] = {"started": time.time()}
        if ref and await loop.run_in_executor(None, scenario_differs, ScenarioRef(**ref), scenario, request):
            ref = None
        # one filing at a time, off the caller's path, so callers (and agents behind tool timeouts) are not held up
        filer.submit(persist, run_id, entry, res, payload, user_email(request), label, ref, study_id, origin_of(request))
    return payload


@app.post("/api/run")
async def run_scenario(req: RunRequest, request: Request, background: bool = False):
    if background:
        return await asyncio.get_running_loop().run_in_executor(None, submit_run, request, req.scenario.model_dump(), req.label, req.persist,
                                                                req.ref.model_dump() if req.ref else None, req.study_id)
    payload = await do_run(request, req.scenario.model_dump(), req.label, req.persist,
                           req.ref.model_dump() if req.ref else None, req.study_id)
    return JSONResponse(payload)


@app.get("/api/runs/{run_id}/status")
def run_status(run_id: str):
    return runs.get(run_id, {})


@app.get("/api/runs")
async def list_runs(request: Request):
    w = user_client(request)
    df = await asyncio.get_running_loop().run_in_executor(None, sql, w, f"""
        SELECT run_id, created_at, run_by, label, scenario_json, scenario_name, scenario_version, rmse_m, pct_area_dtw_lt_2m, max_drawdown_m,
               canal_seepage_ml, bore_extraction_ml, runtime_s, archive_path, mlflow_run_id, study_id, origin
        FROM {FQ}.model_runs ORDER BY created_at DESC LIMIT 80""")
    df["created_at"] = df.created_at.dt.strftime("%Y-%m-%d %H:%M")
    return df.replace({np.nan: None}).to_dict("records")


@app.get("/api/runs/{run_id}/archive")
def download(run_id: str, request: Request):
    if not run_id.isalnum():
        raise HTTPException(400, "bad run id")
    w = user_client(request)  # as the user: READ VOLUME on model_runs decides
    try:
        resp = w.files.download(f"{RUNS_VOLUME}/runs/{run_id}/model.zip")
    except Exception as e:
        raise HTTPException(403 if "PERMISSION" in str(e).upper() else 404, str(e)[:300])
    return Response(resp.contents.read(), media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="modflow6-{run_id}.zip"'})


@app.post("/api/ensembles")
def start_ensemble(req: EnsembleRequest, request: Request):
    eid = "ens-" + uuid.uuid4().hex[:10]
    vary = req.vary.model_dump()
    if req.k_log_sigma is not None:
        vary["k"] = req.k_log_sigma
    config = {"scenario": norm(req.scenario.model_dump()), "vary": vary, "rmse_threshold_m": req.rmse_threshold_m,
              "study_id": req.study_id, "scenario_name": req.scenario_name}
    r = sp.jobs.run_now(job_id=JOB_ID, job_parameters={
        "ensemble_id": eid, "n": str(req.n), "config_json": json.dumps(config),
        "run_by": user_email(request), "label": req.label or f"{req.n}-member ensemble"})
    return {"ensemble_id": eid, "job_run_id": r.run_id, "estimate_s": ensemble_estimate(request, config["scenario"], req.n),
            "url": f"{cfg.host}/jobs/{JOB_ID}/runs/{r.run_id}"}


def ensemble_estimate(request, scenario: dict, n: int) -> float:
    """Serverless start-up and table I/O, plus the realizations over the job's parallel tasks (measured: 64 in ~4 min,
    256 in ~6 min at native fidelity)."""
    per = gwmodel.fidelity_size(load_inputs(request)["inp"], gwmodel.fidelity_of(scenario))["estimate_s"] + 2.5
    return round(180 + n * per / 4, 0)


def ensemble_job(eid: str, job_run_id: int | None = None) -> dict | None:
    """Where an ensemble's Spark job is: pending, running, or finished (and how)."""
    runs = [sp.jobs.get_run(job_run_id)] if job_run_id else list(sp.jobs.list_runs(job_id=JOB_ID, limit=25))
    for r in runs:
        params = {p.name: p.value for p in (r.job_parameters or [])}
        if job_run_id is None and params.get("ensemble_id") != eid:
            continue
        life = r.state.life_cycle_state.value if r.state and r.state.life_cycle_state else ""
        result = r.state.result_state.value if r.state and r.state.result_state else ""
        done = life in ("TERMINATED", "SKIPPED", "INTERNAL_ERROR")
        return {"ensemble_id": eid, "job_run_id": r.run_id, "label": params.get("label"), "n": params.get("n"),
                "state": ("finished" if result == "SUCCESS" else "failed") if done else "running",
                "life_cycle": life, "result": result, "message": (r.state.state_message or "")[:300] if r.state else "",
                "started_ms": r.start_time, "ended_ms": r.end_time or None, "url": f"{cfg.host}/jobs/{JOB_ID}/runs/{r.run_id}"}
    return None


@app.get("/api/ensembles")
async def list_ensembles(request: Request):
    w = user_client(request)
    loop = asyncio.get_running_loop()
    done_f = loop.run_in_executor(None, sql, w, f"""
        SELECT ensemble_id, created_at, run_by, label, n_realizations, n_ok, n_behavioural, rmse_threshold_m,
               mean_pct_area_dtw_lt_2m, p10_pct_area_dtw_lt_2m, p90_pct_area_dtw_lt_2m, peak_mean_pct_area_dtw_lt_2m,
               study_id, scenario_name, runtime_s, job_run_id, mlflow_run_id
        FROM {FQ}.ensemble_runs ORDER BY created_at DESC LIMIT 30""")

    def active():
        out = []
        for r in sp.jobs.list_runs(job_id=JOB_ID, limit=20):
            params = {p.name: p.value for p in (r.job_parameters or [])}
            life = r.state.life_cycle_state.value if r.state and r.state.life_cycle_state else ""
            result = r.state.result_state.value if r.state and r.state.result_state else ""
            out.append({"ensemble_id": params.get("ensemble_id"), "label": params.get("label"),
                        "run_by": params.get("run_by"), "n": params.get("n"), "job_run_id": r.run_id,
                        "life_cycle": life, "result": result, "start": r.start_time,
                        "url": f"{cfg.host}/jobs/{JOB_ID}/runs/{r.run_id}"})
        return out

    jobs = await loop.run_in_executor(None, active)
    done = await done_f
    done["created_at"] = done.created_at.dt.strftime("%Y-%m-%d %H:%M")
    return {"completed": done.replace({np.nan: None}).to_dict("records"), "jobs": jobs}


@app.get("/api/ensembles/{eid}")
async def ensemble_detail(eid: str, request: Request):
    w = user_client(request)
    loop = asyncio.get_running_loop()
    cells_f = loop.run_in_executor(None, sql, w, f"SELECT row, col, p_dtw_lt_2m, dtw_p10, dtw_p50, dtw_p90, p_dtw_lt_2m_any_month FROM {FQ}.ensemble_cell_stats WHERE ensemble_id = :e", {"e": eid})
    real_f = loop.run_in_executor(None, sql, w, f"SELECT realization, k_mult, k_mult_upper, k_mult_lower, sy, deep_drainage_frac, rain_mult, ok, rmse_m, behavioural, weight, pct_area_dtw_lt_2m, peak_pct_area_dtw_lt_2m, runtime_s, executor FROM {FQ}.ensemble_realizations WHERE ensemble_id = :e ORDER BY realization", {"e": eid})
    mon_f = loop.run_in_executor(None, sql, w, f"SELECT period, month, area_mean, area_p10, area_p50, area_p90 FROM {FQ}.ensemble_monthly WHERE ensemble_id = :e ORDER BY period", {"e": eid})
    bore_f = loop.run_in_executor(None, sql, w, f"SELECT bore_id, period, head_p10, head_p50, head_p90 FROM {FQ}.ensemble_bore_bands WHERE ensemble_id = :e ORDER BY bore_id, period", {"e": eid})
    run_f = loop.run_in_executor(None, sql, w, f"SELECT * FROM {FQ}.ensemble_runs WHERE ensemble_id = :e", {"e": eid})
    cells, real, mon, bores, row = await cells_f, await real_f, await mon_f, await bore_f, await run_f
    if cells.empty:
        raise HTTPException(404, "ensemble not finished or not visible to you")
    nrow, ncol = int(cells.row.max()) + 1, int(cells.col.max()) + 1
    grid = lambda c: r2(cells.sort_values(["row", "col"])[c].to_numpy().reshape(nrow, ncol), 3)
    anym = cells["p_dtw_lt_2m_any_month"]
    summary = _records(row.drop(columns=["config_json"]))[0] if not row.empty else {}
    config = json.loads(row.iloc[0].config_json) if not row.empty and row.iloc[0].config_json else {}
    return {"p": grid("p_dtw_lt_2m"), "p10": grid("dtw_p10"), "p50": grid("dtw_p50"), "p90": grid("dtw_p90"),
            "p_any": grid("p_dtw_lt_2m_any_month") if anym.notna().any() else None,
            "realizations": real.replace({np.nan: None}).to_dict("records"),
            "monthly": mon.replace({np.nan: None}).to_dict("records"),
            "bores": {b: {"p10": g.head_p10.tolist(), "p50": g.head_p50.tolist(), "p90": g.head_p90.tolist()} for b, g in bores.groupby("bore_id")} if not bores.empty else {},
            "summary": summary, "config": config,
            "executors": int(real.executor.nunique()) if not real.empty else 0}


@app.get("/api/data")
async def data_catalog(request: Request):
    """What the model reads, as whom, and what UC governance applied."""
    w = user_client(request)
    loop = asyncio.get_running_loop()
    tables_f = loop.run_in_executor(None, sql, w, f"""
        SELECT table_name, comment FROM {CATALOG}.information_schema.tables WHERE table_schema = :s ORDER BY table_name""", {"s": SCHEMA})
    masked_f = loop.run_in_executor(None, sql, w, f"""
        SELECT bore_id, bore_type, landholder, licence_no, entitlement_ml FROM {FQ}.bores
        WHERE bore_type = 'production' ORDER BY bore_id LIMIT 6""")
    tables, masked = await tables_f, await masked_f
    counts = await loop.run_in_executor(None, sql, w, " UNION ALL ".join(
        f"SELECT '{t}' AS t, count(*) AS n FROM {FQ}.{t}" for t in tables.table_name))
    tables["rows"] = tables.table_name.map(dict(zip(counts.t, counts.n.astype(int))))
    tables["url"] = [f"{cfg.host}/explore/data/{CATALOG}/{SCHEMA}/{t}" for t in tables.table_name]
    return {"tables": tables.replace({np.nan: None}).to_dict("records"),
            "masked_sample": masked.replace({np.nan: None}).to_dict("records"),
            "read_as": user_email(request), "volumes": {"binaries": BIN_VOLUME, "runs": RUNS_VOLUME},
            "links": {"experiment": f"{cfg.host}/ml/experiments/{EXPERIMENT_ID}",
                      "job": f"{cfg.host}/jobs/{JOB_ID}",
                      "schema": f"{cfg.host}/explore/data/{CATALOG}/{SCHEMA}"}}


# ---------------------------------------------------------------- project files (as the user)
WORKSPACE = f"/Volumes/{CATALOG}/{SCHEMA}/workspace"
KINDS = {"models": (".zip",), "scenarios": (".json",)}


def _safe_name(name: str, kind: str) -> str:
    base = Path(name).name
    if not base or base.startswith(".") or not base.lower().endswith(KINDS[kind]) or len(base) > 120:
        raise HTTPException(400, f"{kind[:-1].capitalize()} files must be {' or '.join(KINDS[kind])}, e.g. my-model{KINDS[kind][0]}")
    if any(ch in base for ch in "\\/:*?\"<>|"):
        raise HTTPException(400, "File names cannot contain / \\ : * ? \" < > |")
    return base


def _kind(kind: str) -> str:
    if kind not in KINDS:
        raise HTTPException(404, "Unknown file area")
    return kind


def _files_error(e: Exception) -> HTTPException:
    msg = str(e)
    if "PERMISSION" in msg.upper() or "403" in msg:
        return HTTPException(403, "Your Unity Catalog grants do not allow this on the workspace volume.")
    if "NOT_FOUND" in msg.upper() or "404" in msg:
        return HTTPException(404, "File not found.")
    return HTTPException(500, msg[:300])


def _read(w: WorkspaceClient, kind: str, name: str) -> bytes:
    try:
        return w.files.download(f"{WORKSPACE}/{kind}/{name}").contents.read()
    except Exception as e:
        raise _files_error(e)


@app.get("/api/files/{kind}")
def list_files(kind: str, request: Request):
    w = user_client(request)
    try:
        items = list(w.files.list_directory_contents(f"{WORKSPACE}/{_kind(kind)}"))
    except Exception as e:
        raise _files_error(e)
    out = [{"name": i.name, "bytes": i.file_size, "modified": i.last_modified} for i in items if not i.is_directory]
    return sorted(out, key=lambda f: -(f["modified"] or 0))


@app.post("/api/files/{kind}")
async def upload_file(kind: str, request: Request, file: UploadFile = File(...), overwrite: bool = False):
    w = user_client(request)
    name = _safe_name(file.filename or "", _kind(kind))
    data = await file.read()
    try:
        if kind == "models":
            mf6files.validate_zip(data)
        else:
            json.loads(data)
    except mf6files.ModelError as e:
        raise HTTPException(422, str(e))
    except ValueError:
        raise HTTPException(422, "That file is not valid JSON.")
    try:
        w.files.upload(f"{WORKSPACE}/{kind}/{name}", io.BytesIO(data), overwrite=overwrite)
    except Exception as e:
        if "ALREADY_EXISTS" in str(e).upper() or "409" in str(e):
            raise HTTPException(409, f"{name} already exists. Rename it or replace the existing file.")
        raise _files_error(e)
    return {"name": name, "bytes": len(data)}


# ---- big uploads: chunks to disk, checked there, then streamed into the volume (request bodies stay small)
_uploads: dict[str, dict] = {}
UPLOAD_CHUNK = 8 * 1024 * 1024


class UploadStart(BaseModel):
    kind: str
    name: str
    size: int = Field(..., gt=0, le=mf6files.MAX_ZIP_BYTES)


@app.post("/api/upload")
def upload_start(req: UploadStart, request: Request):
    name = _safe_name(req.name, _kind(req.kind))
    uid = uuid.uuid4().hex
    path = WORK / "incoming" / uid
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    _uploads[uid] = {"owner": user_email(request), "kind": req.kind, "name": name, "size": req.size, "path": path, "t": time.time()}
    for k in [k for k, v in _uploads.items() if time.time() - v["t"] > 6 * 3600]:  # abandoned uploads
        _uploads.pop(k)["path"].unlink(missing_ok=True)
    return {"upload_id": uid, "chunk_bytes": UPLOAD_CHUNK}


def _upload_of(request, uid: str) -> dict:
    u = _uploads.get(uid)
    if not u or u["owner"] != user_email(request):
        raise HTTPException(404, "No such upload in progress.")
    return u


@app.put("/api/upload/{uid}")
async def upload_chunk(uid: str, request: Request, offset: int = 0):
    u = _upload_of(request, uid)
    data = await request.body()
    if len(data) > UPLOAD_CHUNK + 1024:
        raise HTTPException(413, f"Chunks are at most {UPLOAD_CHUNK // 2**20} MB.")
    have = u["path"].stat().st_size
    if offset != have:
        raise HTTPException(409, f"Expected offset {have}, got {offset}.")
    with open(u["path"], "ab") as f:
        f.write(data)
    u["t"] = time.time()
    return {"received": have + len(data)}


@app.post("/api/upload/{uid}/finish")
def upload_finish(uid: str, request: Request, overwrite: bool = False):
    u = _upload_of(request, uid)
    size = u["path"].stat().st_size
    if size != u["size"]:
        raise HTTPException(409, f"Received {size} of {u['size']} bytes.")
    try:
        if u["kind"] == "models":
            _zip_head_check(u["path"])
        else:
            json.loads(u["path"].read_bytes())
    except mf6files.ModelError as e:
        raise HTTPException(422, str(e))
    except ValueError:
        raise HTTPException(422, "That file is not valid JSON.")
    try:
        with open(u["path"], "rb") as f:
            user_client(request).files.upload(f"{WORKSPACE}/{u['kind']}/{u['name']}", f, overwrite=overwrite)
    except Exception as e:
        if "ALREADY_EXISTS" in str(e).upper() or "409" in str(e):
            raise HTTPException(409, f"{u['name']} already exists. Rename it or replace the existing file.")
        raise _files_error(e)
    _uploads.pop(uid, None)
    u["path"].unlink(missing_ok=True)
    return {"name": u["name"], "bytes": size}


def _zip_head_check(path) -> None:
    """The same checks as validate_zip, run on the archive on disk rather than read whole into memory."""
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise mf6files.ModelError("That file is not a valid zip archive.")
    with z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        for n in names:
            if n.startswith("/") or ".." in Path(n).parts:
                raise mf6files.ModelError(f"Unsafe path in archive: {n}")
        mf6files._root(names)


@app.get("/api/files/{kind}/{name}")
def download_file(kind: str, name: str, request: Request):
    name = _safe_name(name, _kind(kind))
    data = _read(user_client(request), kind, name)
    media = "application/zip" if kind == "models" else "application/json"
    return Response(data, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.delete("/api/files/{kind}/{name}")
def delete_file(kind: str, name: str, request: Request):
    name = _safe_name(name, _kind(kind))
    try:
        user_client(request).files.delete(f"{WORKSPACE}/{kind}/{name}")
    except Exception as e:
        raise _files_error(e)
    return {"deleted": name}


class SaveScenario(BaseModel):
    name: str
    label: str = ""
    scenario: Scenario
    overwrite: bool = False
    base_version: int | None = None  # the version the editor started from; a newer saved version is a conflict
    message: str = ""


def _stem(name: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_ " else "-" for ch in name).strip().replace(" ", "-")[:80]


def norm(scenario: dict) -> dict:
    """Canonical scenario: validated, JSON types only, painted cells sorted, so equal settings compare equal."""
    d = json.loads(json.dumps(Scenario(**scenario).model_dump()))
    f = gwmodel.fidelity_of(d)
    d["fidelity"] = None if f == gwmodel.DEFAULT_FIDELITY else f  # the native model needs no fidelity recorded
    if d["fidelity"] is None:
        d.pop("fidelity")
    d["land_use"] = sorted(d["land_use"])
    d["lined_reaches"] = sorted(set(d["lined_reaches"]))
    drains = []
    for i, x in enumerate(d.get("drain_lines") or []):
        pts, path = [tuple(c) for c in x["cells"]], []
        for a, b in zip(pts, pts[1:] or pts):  # traced cell to cell, so a drain is always a connected line
            path += [q for q in gwmodel._line(*a, *b) if not path or q != path[-1]]
        drains.append({"name": x["name"] or f"D{i + 1}", "cells": [list(q) for q in dict.fromkeys(path or pts)],
                       "depth_m": round(float(x["depth_m"]), 2), "cond": round(float(x["cond"]), 1)})
    names = [x["name"] for x in drains]
    for i, x in enumerate(drains):  # names are how drains are removed and reported: keep them unique
        if names.count(x["name"]) > 1 and names.index(x["name"]) != i:
            x["name"] = f"{x['name']}-{i + 1}"
    d["drain_lines"] = drains
    if not drains:
        d.pop("drain_lines")
    return d


def dump_doc(doc: dict) -> str:
    """Line-diffable JSON: one painted cell, reach or bore per line (same layout the app diffs)."""
    def val(v, depth):
        pad = " " * (depth + 1)
        if isinstance(v, dict):
            return "{\n" + ",\n".join(f'{pad}{json.dumps(k)}: {val(x, depth + 1)}' for k, x in v.items()) + "\n" + " " * depth + "}"
        if isinstance(v, list) and v:
            return "[\n" + ",\n".join(pad + json.dumps(x, separators=(", ", ": ")) for x in v) + "\n" + " " * depth + "]"
        return json.dumps(v)
    return val(doc, 0) + "\n"


def _versions(w: WorkspaceClient, stem: str) -> pd.DataFrame:
    """Version history, newest first. Names match case-insensitively; `scenario` carries the stem as first saved."""
    return sql(w, f"""SELECT scenario, version, saved_at, saved_by, summary, scenario_json FROM {FQ}.scenario_versions
                      WHERE lower(scenario) = lower(:s) ORDER BY version DESC""", {"s": stem})


def scenario_differs(ref: ScenarioRef, scenario: dict, request: Request) -> bool:
    """True when the run's settings are not exactly the saved version it claims to come from."""
    v = _versions(user_client(request), _stem(ref.name.removesuffix(".json")))
    row = v[v.version == ref.version]
    return row.empty or norm(json.loads(row.scenario_json.iloc[0])) != norm(scenario)


def fidelity_text(f: dict) -> str:
    return (f"{250 / f['refine']:g} m cells, {f['sublayers']} layer{'s' if f['sublayers'] > 1 else ''} per aquifer, "
            f"{f['nstp']} steps a month, {f['solver']} solver")


def change_summary(prev: dict | None, new: dict, entry: dict | None) -> str:
    """Plain-language summary of what a save changed, the way a commit message would describe it."""
    if prev is None:
        what = change_summary(dict(gwmodel.DEFAULT_SCENARIO), new, entry)
        return "Created" if what == "No changes" else f"Created: {what}"
    prev, new = norm(prev), norm(new)
    out = []
    fmt = {"rain_mult": ("rainfall", lambda v: f"{v:.0%}"), "et_mult": ("ET", lambda v: f"{v:.0%}"),
           "deep_drainage_frac": ("deep drainage", lambda v: f"{v:.0%}"), "pumping_mult": ("extraction", lambda v: f"{v:.0%}"),
           "k_mult": ("K", lambda v: f"x{v:.2f}"), "sy": ("Sy", lambda v: f"{v:.3f}"), "canal_lining_pct": ("lining", lambda v: f"{v:.0f}%")}
    for k, (label, f) in fmt.items():
        if abs(prev[k] - new[k]) > 1e-9:
            out.append(f"{label} {f(prev[k])} to {f(new[k])}")
    lp, ln = set(prev["lined_reaches"]), set(new["lined_reaches"])
    if ln - lp:
        out.append("lined " + ", ".join(sorted(ln - lp)))
    if lp - ln:
        out.append("unlined " + ", ".join(sorted(lp - ln)))
    if entry is not None and prev["land_use"] != new["land_use"]:
        inp = entry["inp"]
        a, b = gwmodel.land_use_for(inp, prev), gwmodel.land_use_for(inp, new)
        moved = pd.Series([f"{gwmodel.CROPS[y]['label'].lower()}" for x, y in zip(a.ravel(), b.ravel()) if x != y])
        ha = inp.delr * inp.delc / 1e4
        if len(moved):
            parts = [f"{n * ha:,.0f} ha to {crop}" for crop, n in moved.value_counts().items()]
            out.append("repainted " + ", ".join(parts[:3]) + ("" if len(parts) <= 3 else f" and {len(parts) - 3} more"))
    bp, bn = len(prev["extra_bores"]), len(new["extra_bores"])
    if bn != bp:
        out.append(f"{'added' if bn > bp else 'removed'} {abs(bn - bp)} proposed bore{'s' if abs(bn - bp) > 1 else ''}")
    elif prev["extra_bores"] != new["extra_bores"]:
        out.append("edited proposed bores")
    dp = {x["name"]: x for x in prev.get("drain_lines", [])}
    dn = {x["name"]: x for x in new.get("drain_lines", [])}
    km = lambda x: len(x["cells"]) * (entry["inp"].delr if entry else 250) / 1000
    if set(dn) - set(dp):
        out.append("added drain " + ", ".join(f"{n} ({km(dn[n]):.1f} km at {dn[n]['depth_m']:g} m)" for n in sorted(set(dn) - set(dp))))
    if set(dp) - set(dn):
        out.append("removed drain " + ", ".join(sorted(set(dp) - set(dn))))
    if any(dp[n] != dn[n] for n in set(dp) & set(dn)):
        out.append("edited drain " + ", ".join(sorted(n for n in set(dp) & set(dn) if dp[n] != dn[n])))
    fp, fn = gwmodel.fidelity_of(prev), gwmodel.fidelity_of(new)
    if fp != fn:
        out.append("fidelity " + fidelity_text(fp) + " to " + fidelity_text(fn))
    return "; ".join(out)[:500] if out else "No changes"


@app.post("/api/scenarios")
def save_scenario(req: SaveScenario, request: Request):
    """Save a scenario: the JSON file in the workspace volume is the current copy; every save is also
    appended to the scenario_versions table, so history, restore and run provenance come from UC."""
    stem = _stem(req.name)
    if not stem:
        raise HTTPException(400, "Give the scenario a name.")
    who, w = user_email(request), user_client(request)
    hist = _versions(w, stem)
    stem = hist.scenario.iloc[0] if len(hist) else stem
    name = f"{stem}.json"
    latest = int(hist.version.max()) if len(hist) else 0
    if latest and req.base_version is None and not req.overwrite:
        raise HTTPException(409, f"A scenario called {req.name} already exists.")
    if latest and req.base_version is not None and req.base_version != latest:
        by = hist.saved_by.iloc[0]
        raise HTTPException(409, f"{req.name} was saved as v{latest} by {by} after you opened it. Save under a new name, or reload it first.")
    prev = json.loads(hist.scenario_json.iloc[0]) if latest else None
    entry = _input_cache.get(who, (0, None))[1]
    scenario = norm(req.scenario.model_dump())
    summary = req.message.strip()[:500] if req.message.strip() else change_summary(prev, scenario, entry)
    version = latest + 1
    now = datetime.now(timezone.utc)
    doc = {"schema": "groundwater-studio/scenario@2", "name": req.name, "label": req.label or req.name, "version": version,
           "saved_by": who, "saved_at": now.isoformat(), "summary": summary,
           "model": "Sample district (Unity Catalog, synthetic)", "scenario": scenario}
    try:
        w.files.upload(f"{WORKSPACE}/scenarios/{name}", io.BytesIO(dump_doc(doc).encode()), overwrite=True)
    except Exception as e:
        raise _files_error(e)
    insert("scenario_versions", pd.DataFrame([{"scenario": stem, "version": version, "saved_at": now.replace(tzinfo=None),
                                               "saved_by": who, "summary": summary, "scenario_json": json.dumps(scenario)}]))
    return {"name": name, "version": version, "summary": summary, "saved_at": now.isoformat(), "saved_by": who}


@app.get("/api/scenarios/{name}/history")
def scenario_history(name: str, request: Request):
    stem = _safe_name(name, "scenarios").removesuffix(".json")
    v = _versions(user_client(request), stem)
    v["saved_at"] = pd.to_datetime(v.saved_at).dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    return v.drop(columns=["scenario_json", "scenario"]).to_dict("records")


@app.get("/api/scenarios/{name}")
def load_scenario(name: str, request: Request, version: int | None = None):
    name = _safe_name(name, "scenarios")
    w = user_client(request)
    if version is not None:
        v = _versions(w, name.removesuffix(".json"))
        row = v[v.version == version]
        if row.empty:
            raise HTTPException(404, f"{name} has no version {version}.")
        r = row.iloc[0]
        return {"name": name.removesuffix(".json").replace("-", " "), "version": int(r.version), "saved_by": r.saved_by,
                "saved_at": str(r.saved_at), "summary": r.summary, "scenario": norm(json.loads(r.scenario_json))}
    try:
        doc = json.loads(_read(w, "scenarios", name))
    except ValueError:
        raise HTTPException(422, "That scenario file is not valid JSON.")
    v = _versions(w, name.removesuffix(".json"))
    doc["version"] = int(v.version.max()) if len(v) else None
    return doc


def _model_workdir(name: str, request: Request) -> str:
    return str(WORK / "uploaded" / hashlib.sha1(f"{user_email(request)}/{name}".encode()).hexdigest()[:12])


@app.get("/api/models/{name}/inspect")
async def inspect_model(name: str, request: Request):
    name = _safe_name(name, "models")
    data = _read(user_client(request), "models", name)
    try:
        return await asyncio.get_running_loop().run_in_executor(pool, mf6files.inspect, data, _model_workdir(name, request) + "-i")
    except mf6files.ModelError as e:
        raise HTTPException(422, str(e))


@app.get("/api/models/{name}/preview")
def preview_model_file(name: str, member: str, request: Request, full: bool = False):
    name = _safe_name(name, "models")
    try:
        return {"member": member, "text": mf6files.preview(_read(user_client(request), "models", name), member, max_lines=10**7 if full else 400), "full": full}
    except mf6files.ModelError as e:
        raise HTTPException(422, str(e))


@app.post("/api/models/{name}/run")
async def run_model(name: str, request: Request):
    name = _safe_name(name, "models")
    data = _read(user_client(request), "models", name)
    exe = require_mf6()
    try:
        out = await asyncio.get_running_loop().run_in_executor(pool, mf6files.run, data, require_engine, _model_workdir(name, request) + "-r")
    except mf6files.ModelError as e:
        raise HTTPException(422, str(e))
    for k in ("heads_all", "budget_all", "top_all", "botm_all"):
        out.pop(k, None)
    return out | {"name": name, "run_by": user_email(request)}


# ---------------------------------------------------------------- model packages for agents and scripts
# The same package area the Studio's explorer shows. Agents can list, inspect, read, write, run and delete packages,
# all as the calling user (Volume grants decide), so a model an agent builds opens in the Studio like an upload.
OUTPUT_SUFFIXES = {".hds", ".cbc", ".bud", ".lst", ".grb", ".ucn", ".cbb"}


def _as_zip_name(name: str) -> str:
    return _safe_name(name if name.lower().endswith(".zip") else f"{name}.zip", "models")


def package_list(request) -> list[dict]:
    files = list_files("models", request)
    return [{"name": "district", "kind": "Sample district model", "note": "The calibrated sample district model (synthetic data) built from Unity Catalog "
             "tables; edit it through scenarios (run_scenario)."}] + [{"name": f["name"], "kind": "MODFLOW 6 package", "bytes": f["bytes"]} for f in files]


def package_inspect(request, name: str) -> dict:
    name = _as_zip_name(name)
    try:
        return mf6files.inspect(_read(user_client(request), "models", name), _model_workdir(name, request) + "-i") | {"name": name}
    except mf6files.ModelError as e:
        raise HTTPException(422, str(e))


def package_read(request, name: str, member: str) -> dict:
    name = _as_zip_name(name)
    try:
        return {"name": name, "member": member, "text": mf6files.preview(_read(user_client(request), "models", name), member)}
    except mf6files.ModelError as e:
        raise HTTPException(422, str(e))


def package_write(request, name: str, files: dict[str, bytes], overwrite: bool) -> dict:
    """Zip MODFLOW 6 input files into a package, check that FloPy can load it, and store it in the workspace volume."""
    name = _as_zip_name(name)
    files = {k.lstrip("/"): v for k, v in files.items() if Path(k).suffix.lower() not in OUTPUT_SUFFIXES}
    if not any(Path(k).name.lower() == "mfsim.nam" or Path(k).suffix.lower() in (".nam", ".mfn") for k in files):
        raise HTTPException(422, "A MODFLOW package needs a name file: mfsim.nam for MODFLOW 6, or the model's .nam for MODFLOW-2005, NWT or USG.")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for k, v in sorted(files.items()):
            z.writestr(k, v)
    data = buf.getvalue()
    try:
        mf6files.validate_zip(data)
        info = mf6files.inspect(data, _model_workdir(name, request) + "-w")
    except mf6files.ModelError as e:
        raise HTTPException(422, str(e))
    except Exception as e:  # FloPy could not load it: say why, so the author can fix the files
        raise HTTPException(422, f"FloPy could not load the package: {e}"[:600])
    try:
        user_client(request).files.upload(f"{WORKSPACE}/models/{name}", io.BytesIO(data), overwrite=overwrite)
    except Exception as e:
        if "ALREADY_EXISTS" in str(e).upper() or "409" in str(e):
            raise HTTPException(409, f"{name} already exists. Pass overwrite=true to replace it, or pick another name.")
        raise _files_error(e)
    return {"package": name, "bytes": len(data), "sha": hashlib.sha1(data).hexdigest(), "files": sorted(files), "model": info.get("model"),
            "grid": info.get("grid"), "nper": info.get("nper"), "packages": [p["type"] for p in info.get("packages", [])]}


def package_build(request, name: str, spec: dict, overwrite: bool) -> dict:
    name = _as_zip_name(name)
    try:
        files = mf6files.build(spec, _model_workdir(name, request) + "-b")
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(422, f"Could not build that model: {e}")
    return package_write(request, name, files, overwrite)


def package_edit(request, name: str, member: str, text: str) -> dict:
    name = _as_zip_name(name)
    data = mf6files.replace_member(_read(user_client(request), "models", name), member, text)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        files = {n: z.read(n) for n in z.namelist() if not n.endswith("/")}
    return package_write(request, name, files, overwrite=True) | {"edited": member}


def package_run(request, name: str, probe: list[tuple[int, int, int]] | None = None) -> dict:
    """Run a package as-is and summarise what it did: the full payload is what the Studio draws."""
    name = _as_zip_name(name)
    data = _read(user_client(request), "models", name)
    try:
        out = mf6files.run(data, require_engine, _model_workdir(name, request) + "-r")
    except mf6files.ModelError as e:
        raise HTTPException(422, str(e))
    out.pop("top_all", None); out.pop("botm_all", None)

    def stats(a):
        v = np.array([x for row in a for x in row if x is not None], float)
        v = v[np.isfinite(v)]
        return None if not len(v) else {"min": round(float(v.min()), 3), "mean": round(float(v.mean()), 3), "max": round(float(v.max()), 3)}
    ha = np.asarray(out.pop("heads_all"), float)
    g, hl = out["grid"], ha[-1]
    top = np.array([[np.nan if v is None else v for v in row] for row in g["top"]], float)
    series = []
    for i, t in enumerate(out["times"]):
        wt = np.full(ha.shape[2:], np.nan)
        for k in range(ha.shape[1] - 1, -1, -1):
            wt = np.where(np.isfinite(ha[i, k]), ha[i, k], wt)
        d = top - wt
        series.append({"time": t, "head_mean_by_layer_m": [None if not np.isfinite(ha[i, k]).any() else round(float(np.nanmean(ha[i, k])), 3) for k in range(ha.shape[1])],
                       "depth_to_water_mean_m": None if not np.isfinite(d).any() else round(float(np.nanmean(d)), 3),
                       "depth_to_water_min_m": None if not np.isfinite(d).any() else round(float(np.nanmin(d)), 3),
                       "probes_m": [None if not (0 <= k < ha.shape[1] and 0 <= r < ha.shape[2] and 0 <= c < ha.shape[3]) or not np.isfinite(ha[i, k, r, c])
                                    else round(float(ha[i, k, r, c]), 3) for k, r, c in (probe or [])]})
    budget_series = out.pop("budget_all", None)
    return {"package": name, "model": out["model"], "grid": {k: g[k] for k in ("nlay", "nrow", "ncol", "delr_km", "delc_km")},
            "n_outputs": len(out["times"]), "times": out["times"], "time_units": out["time_units"], "solve_s": out["run_s"],
            "final_water_table_m": stats(out["wt"][-1]), "final_depth_to_water_m": stats(out["dtw"][-1]),
            "wells": len(out["bores"]), "boundary_cells": {k: len(v) for k, v in out["features"].items() if v},
            "budget_last_period": out["budget_last"], "mf6_tail": out["stdout_tail"][-300:],
            "heads_by_layer_m": [stats(layer.tolist()) for layer in hl],
            "probes": [{"layer": k, "row": r, "col": c, "head_m": None if not np.isfinite(hl[k, r, c]) else round(float(hl[k, r, c]), 3)}
                       for k, r, c in (probe or []) if 0 <= k < hl.shape[0] and 0 <= r < hl.shape[1] and 0 <= c < hl.shape[2]],
            "by_time": series if len(series) <= 120 else series[:: max(1, len(series) // 120)],
            "budget_by_time": (budget_series or [])[:120],
            "note": "by_time holds every output time; pass {\"package\": name} to run_python for every cell at every time"}


def package_convert(request, name: str) -> dict:
    """A MODFLOW-2005 or NWT package converted to MODFLOW 6 with the USGS mf5to6 converter, stored as <name>-mf6.zip."""
    zname = _as_zip_name(name)
    data = _read(user_client(request), "models", zname)
    try:
        files = mf6files.convert_to_mf6(data, require_engine("mf5to6"), _model_workdir(zname, request) + "-cv")
    except mf6files.ModelError as e:
        raise HTTPException(422, str(e))
    out = package_write(request, f"{Path(zname).stem}-mf6.zip", files, overwrite=True)
    return out | {"converted_from": zname}


class MemberEdit(BaseModel):
    member: str
    text: str


@app.put("/api/models/{name}/member")
async def api_edit_member(name: str, body: MemberEdit, request: Request):
    """Replace one input file of a package with new text. The build document reads the change back on next open."""
    return await asyncio.get_running_loop().run_in_executor(pool, package_edit, request, name, body.member, body.text)


@app.post("/api/models/{name}/convert")
async def api_convert_model(name: str, request: Request):
    return await asyncio.get_running_loop().run_in_executor(pool, package_convert, request, name)


def package_delete(request, name: str) -> dict:
    out = delete_file("models", _as_zip_name(name), request)
    try:
        user_client(request).files.delete(_build_path(name))
    except Exception:
        pass  # never built in the Studio
    return out


# ---------------------------------------------------------------- the model buildkit: packages as editable documents
BUILDS = f"{WORKSPACE}/builds"


def _build_path(name: str) -> str:
    return f"{BUILDS}/{Path(_as_zip_name(name)).stem}.json"


def _put_build(request, name: str, doc: dict) -> None:
    try:
        user_client(request).files.upload(_build_path(name), io.BytesIO(json.dumps(doc).encode()), overwrite=True)
    except Exception as e:
        log.warning("could not store the build document for %s: %s", name, e)


def build_load(request, name: str) -> dict:
    """The package as an editable document. Read again (keeping named schedules) whenever its files changed underneath."""
    zname = _as_zip_name(name)
    w = user_client(request)
    data = _read(w, "models", zname)
    zsha = hashlib.sha1(data).hexdigest()
    try:
        doc = json.loads(w.files.download(_build_path(zname)).contents.read())
    except Exception:
        doc = None
    if doc and doc.get("base_sha") == zsha and doc.get("format") == buildkit.FORMAT:
        return doc
    try:
        new = buildkit.import_package(data, _model_workdir(zname, request) + "-imp", Path(zname).stem)
    except mf6files.ModelError as e:
        raise HTTPException(422, str(e))
    if doc and doc.get("format") == buildkit.FORMAT:
        new = buildkit.merge(doc, new)
    new["base_sha"] = zsha
    if new.get("editable"):
        _put_build(request, zname, new)
    return new


def _zip_files(data: bytes) -> dict[str, str]:
    names = mf6files.validate_zip(data)
    root = mf6files._root(names)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {n[len(root):]: z.read(n).decode("utf-8", errors="replace") for n in names if n.startswith(root) and not n.endswith("/")
                and Path(n).suffix.lower() not in OUTPUT_SUFFIXES and b"\x00" not in z.read(n)[:2048]}


def build_preview(request, name: str, doc: dict) -> dict:
    """The files a document would write, against the stored package: only the ones that change."""
    zname = _as_zip_name(name)
    data = _read(user_client(request), "models", zname)
    try:
        files = buildkit.compile_doc(doc, data, _model_workdir(zname, request) + "-pv")
    except (mf6files.ModelError, KeyError, ValueError) as e:
        raise HTTPException(422, f"Could not write the model: {e}"[:600])
    before = _zip_files(data)
    after = {k: v.decode("utf-8", errors="replace") for k, v in files.items() if Path(k).suffix.lower() not in OUTPUT_SUFFIXES}
    changed = [{"member": k, "before": before.get(k, ""), "after": after.get(k, "")} for k in sorted(set(before) | set(after))
               if before.get(k) != after.get(k)]
    for c in changed:  # arrays of a big grid run to megabytes: the diff view needs the text, not all of it
        for f in ("before", "after"):
            if len(c[f]) > 400_000:
                c[f] = c[f][:400_000] + "\n… (truncated)"
    return {"files": changed, "stale": doc.get("base_sha") != hashlib.sha1(data).hexdigest()}


def build_save(request, name: str, doc: dict, base_sha: str | None) -> dict:
    zname = _as_zip_name(name)
    w = user_client(request)
    data = _read(w, "models", zname)
    if base_sha and base_sha != hashlib.sha1(data).hexdigest():
        raise HTTPException(409, f"{zname} changed since you opened it (another edit, the agent or an upload). Reload it to carry on from the new version.")
    try:
        files = buildkit.compile_doc(doc, data, _model_workdir(zname, request) + "-sv")
    except (mf6files.ModelError, KeyError, ValueError) as e:
        raise HTTPException(422, f"Could not write the model: {e}"[:600])
    before = _zip_files(data)
    out = package_write(request, zname, files, overwrite=True)
    buildkit._stamp(doc, files)
    doc["base_sha"] = out["sha"]
    _put_build(request, zname, doc)
    changed = sorted(k for k, v in files.items() if Path(k).suffix.lower() not in OUTPUT_SUFFIXES and before.get(k) != v.decode("utf-8", errors="replace"))
    return {"package": zname, "sha": out["sha"], "changed_files": changed, "doc": doc}


def build_ops(doc: dict, ops: list[dict]) -> tuple[dict, list[str]]:
    done = []
    for op in ops:
        try:
            done.append(buildkit.apply_op(doc, op))
        except (mf6files.ModelError, KeyError, ValueError, TypeError) as e:
            raise HTTPException(422, f"Edit {len(done) + 1} ({op.get('op')}): {e}")
    return doc, done


# ---- PEST++ calibration of an editable MODFLOW 6 package
import calibration


class CalParam(BaseModel):
    name: str = Field(..., description="A parameter from calibration_parameters, e.g. k_l1, sy_l1, rch, rivcond_riv")
    lower: float | None = Field(None, gt=0, description="Lowest multiplier allowed (default from the list)")
    upper: float | None = Field(None, gt=0, description="Highest multiplier allowed")


class CalObs(BaseModel):
    name: str = ""
    layer: int = Field(..., ge=0, description="0-based, like every other tool")
    row: int = Field(..., ge=0)
    col: int = Field(..., ge=0)
    time: float = Field(..., description="Model time units since the start")
    value: float = Field(..., description="Measured head, m")
    weight: float = 1.0


class CalRequest(BaseModel):
    name: str
    observations_file: str | None = Field(None, description="A CSV the user uploaded (name, layer, row, col 1-based, time, head[, weight])")
    observations: list[CalObs] = Field(default_factory=list, description="Or the observations themselves (0-based cells)")
    parameters: list[CalParam] = Field(default_factory=list, description="Parameters to calibrate; default: the model's usual set")
    method: Literal["glm", "ies"] = Field("glm", description="glm: Gauss-Levenberg-Marquardt with first-order uncertainty; ies: iterative ensemble smoother")
    iterations: int = Field(8, ge=1, le=50)
    realizations: int = Field(40, ge=10, le=500, description="IES ensemble size")


def calibration_parameters(request, name: str) -> list[dict]:
    doc = build_load(request, name)
    if not doc.get("editable"):
        raise HTTPException(422, doc.get("why_not") or "Only models the Studio can edit can be calibrated.")
    return calibration.candidates(doc)


def _cal_obs(request, req: CalRequest) -> list[dict]:
    if req.observations_file:
        path = req.observations_file if req.observations_file.startswith("/Volumes/") else f"{UPLOADS}/{_user_slug(request)}/{Path(req.observations_file).name}"
        if not path.startswith(WORKSPACE + "/") or ".." in path.split("/"):
            raise HTTPException(400, "Observation files come from the workspace volume.")
        try:
            text = user_client(request).files.download(path).contents.read().decode("utf-8", errors="replace")
        except Exception as e:
            raise _files_error(e)
        try:
            return calibration.read_observations(text)
        except calibration.CalibrationError as e:
            raise HTTPException(422, str(e))
    return [o.model_dump() for o in req.observations]


def start_calibration(request, req: CalRequest) -> dict:
    zname = _as_zip_name(req.name)
    doc = build_load(request, zname)
    if not doc.get("editable"):
        raise HTTPException(422, doc.get("why_not") or "Only models the Studio can edit can be calibrated.")
    cands = {c["name"]: c for c in calibration.candidates(doc)}
    chosen = req.parameters or [CalParam(name=n) for n, c in cands.items() if c["default"]]
    bad = [p.name for p in chosen if p.name not in cands]
    if bad:
        raise HTTPException(422, f"Unknown parameter {bad[0]}. This model offers: {', '.join(cands)}")
    params = [{**cands[p.name], **({"lower": p.lower} if p.lower else {}), **({"upper": p.upper} if p.upper else {})} for p in chosen]
    obs = _cal_obs(request, req)
    mf6, exe = require_mf6(), require_engine(f"pestpp-{req.method}")
    wd = str(WORK / "calibration" / uuid.uuid4().hex[:10])
    try:
        info = calibration.setup(doc, obs, params, req.method, wd, mf6, req.iterations, req.realizations,
                                 base=_read(user_client(request), "models", zname))
    except calibration.CalibrationError as e:
        raise HTTPException(422, str(e))
    agents = max(1, min(8, (os.cpu_count() or 2) - 1))
    npar = len(params)
    est = (req.realizations if req.method == "ies" else npar + 4) * (req.iterations + 1) * 1.5 / agents + 20
    who = user_email(request)

    def work(progress):
        progress("starting PEST++", 0, 1)
        r = calibration.run(wd, exe, agents, progress)
        progress("reading the results", 1, 1)
        out = calibration.results(wd) | {"package": zname, "seconds": r["seconds"], "agents": agents, "observations": info["observations"]}
        # the run's files, for the record and for anyone who wants to carry on in PEST++ themselves
        folder = f"{ARTIFACTS}/{_user_slug(request)}/{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-calibration-{Path(zname).stem}"[:240]
        w = user_client(request)
        master = Path(r["master"])
        for f in ["case.pst", "case.rec", "case.par", "case.rei", "case.isen", "case.iobj", "case.par.usum.csv", "case.phi.actual.csv"] + \
                 sorted(x.name for x in master.glob("case.*.par.csv"))[-1:]:
            if (master / f).exists():
                w.files.upload(f"{folder}/{f}", io.BytesIO((master / f).read_bytes()), overwrite=True)
        w.files.upload(f"{folder}/summary.json", io.BytesIO(json.dumps(out, indent=1).encode()), overwrite=True)
        w.files.upload(f"{folder}/residuals.csv", io.BytesIO(pd.DataFrame(out["residuals"]).to_csv(index=False).encode()), overwrite=True)
        out["folder"] = folder
        out["params_spec"] = params
        shutil.rmtree(wd, ignore_errors=True)
        fa, fb = out["fit_after"] or {}, out["fit_before"] or {}
        summary = {"package": zname, "method": req.method, "rmse_before_m": fb.get("rmse_m"), "rmse_after_m": fa.get("rmse_m"),
                   "parameters": {p["name"]: p["multiplier"] for p in out["parameters"]},
                   "at_bounds": [p["name"] for p in out["parameters"] if p["at_bound"]], "folder": folder,
                   "note": "Multipliers on the model's current values. apply_calibration saves a calibrated copy."}
        log.info("calibration of %s by %s: RMSE %s -> %s", zname, who, fb.get("rmse_m"), fa.get("rmse_m"))
        return summary, None, out
    t = submit_task(request, "calibration", f"PEST++ {req.method.upper()} calibration of {Path(zname).stem}", est, work)
    return t | {"parameters": [p["name"] for p in params], "observations": info["observations"], "agents": agents}


class CalApply(BaseModel):
    name: str
    task_id: str | None = Field(None, description="A finished calibration task; its multipliers are applied")
    multipliers: dict[str, float] = Field(default_factory=dict, description="Or multipliers by parameter name")
    as_name: str | None = Field(None, description="Name of the calibrated copy (default <name>-calibrated)")


def apply_calibration(request, req: CalApply) -> dict:
    zname = _as_zip_name(req.name)
    doc = build_load(request, zname)
    cands = {c["name"]: c for c in calibration.candidates(doc)}
    vals = dict(req.multipliers)
    if req.task_id:
        task_get(request, req.task_id)
        t = tasks[req.task_id]
        if t["status"] != "finished" or t["kind"] != "calibration":
            raise HTTPException(409, f"Task {req.task_id} is not a finished calibration.")
        vals = {p["name"]: p["multiplier"] for p in t["payload"]["parameters"]} | vals
    if not vals:
        raise HTTPException(422, "Give a finished calibration task_id or the multipliers.")
    new = calibration.apply(doc, [cands[n] for n in vals if n in cands], vals)
    out_name = _as_zip_name(req.as_name or f"{Path(zname).stem}-calibrated")
    try:
        data = _read(user_client(request), "models", zname)
        files = buildkit.compile_doc(new, data, _model_workdir(out_name, request) + "-cal")
    except (mf6files.ModelError, KeyError, ValueError) as e:
        raise HTTPException(422, f"Could not write the calibrated model: {e}"[:600])
    out = package_write(request, out_name, files, overwrite=True)
    buildkit._stamp(new, files)
    new["base_sha"], new["name"] = out["sha"], Path(out_name).stem
    _put_build(request, out_name, new)
    return {"package": out_name, "applied": vals, "from": zname}


@app.get("/api/calibrate/{name}/parameters")
async def api_cal_params(name: str, request: Request):
    return await asyncio.get_running_loop().run_in_executor(pool, calibration_parameters, request, name)


@app.post("/api/calibrate")
async def api_calibrate(req: CalRequest, request: Request):
    return await asyncio.get_running_loop().run_in_executor(None, start_calibration, request, req)


@app.post("/api/calibrate/apply")
async def api_cal_apply(req: CalApply, request: Request):
    return await asyncio.get_running_loop().run_in_executor(pool, apply_calibration, request, req)


class BuildNew(BaseModel):
    name: str
    nrow: int = Field(40, ge=2, le=1000)
    ncol: int = Field(40, ge=2, le=1000)
    cell_m: float = Field(100, gt=0)
    nlay: int = Field(2, ge=1, le=50)
    top: float = 100
    bottom: float = 50
    k: float = Field(10, gt=0)
    transient: bool = False


def build_new(request, spec: BuildNew) -> dict:
    zname = _as_zip_name(_stem(spec.name) or "new-model")
    if spec.bottom >= spec.top:
        raise HTTPException(422, "The bottom of the model must be below its top.")
    doc = buildkit.blank(Path(zname).stem, spec.nrow, spec.ncol, spec.cell_m, spec.nlay, spec.top, spec.bottom, spec.k, spec.transient)
    files = buildkit.compile_doc(doc, None, _model_workdir(zname, request) + "-new")
    out = package_write(request, zname, files, overwrite=False)
    buildkit._stamp(doc, files)
    doc["base_sha"] = out["sha"]
    _put_build(request, zname, doc)
    return {"package": zname}


class BuildDocBody(BaseModel):
    doc: dict
    base_sha: str | None = None
    ops: list[dict] = []


@app.get("/api/build/{name}")
async def api_build_get(name: str, request: Request):
    return await asyncio.get_running_loop().run_in_executor(pool, build_load, request, name)


@app.post("/api/build/{name}/preview")
async def api_build_preview(name: str, body: BuildDocBody, request: Request):
    return await asyncio.get_running_loop().run_in_executor(pool, build_preview, request, name, body.doc)


@app.put("/api/build/{name}")
async def api_build_save(name: str, body: BuildDocBody, request: Request):
    return await asyncio.get_running_loop().run_in_executor(pool, build_save, request, name, body.doc, body.base_sha)


@app.post("/api/build/{name}/ops")
async def api_build_ops(name: str, body: BuildDocBody, request: Request):
    doc, done = await asyncio.get_running_loop().run_in_executor(pool, build_ops, body.doc, body.ops)
    return {"doc": doc, "done": done}


@app.post("/api/build-new")
async def api_build_new(spec: BuildNew, request: Request):
    return await asyncio.get_running_loop().run_in_executor(pool, build_new, request, spec)


# ---------------------------------------------------------------- scenario specs: a base plus edits, resolved here
# Agents, jobs and scripts describe a scenario the way a modeller would say it ("start from v2, move the rice on the
# shallow flats to horticulture, line MC-05"), and the Studio's own rules turn that into cells.
PARAMS = {
    "k_mult": "Hydraulic conductivity multiplier, both layers",
    "sy": "Specific yield of the shallow aquifer",
    "rain_mult": "Rainfall multiplier (climate)",
    "et_mult": "Reference evapotranspiration multiplier (climate)",
    "deep_drainage_frac": "Share of applied irrigation water that drains below the root zone",
    "pumping_mult": "Multiplier on metered extraction from licensed bores",
    "canal_lining_pct": "Legacy blanket lining, % of channel cells (prefer lined_reaches)",
}


class CellSelector(BaseModel):
    cells: list[tuple[int, int]] | None = Field(None, description="Explicit [row, col] cells")
    rect: tuple[int, int, int, int] | None = Field(None, description="[row0, col0, row1, col1], inclusive")
    polygon: list[tuple[float, float]] | None = Field(None, description="[row, col] vertices (cell indices, may be "
                                                      "fractional); cells whose centre is inside are selected")
    zone: str | None = Field(None, description="A saved zone, by name (list_zones)")
    crop: str | None = Field(None, description="Only cells currently under this crop code")
    irrigated_only: bool = Field(False, description="Only cells inside irrigation district holdings")
    dtw_below_m: float | None = Field(None, description="Only cells whose final depth to water is shallower than this, m")
    dtw_run_id: str | None = Field(None, description="Filed run whose water table the depth filter reads; default the baseline")
    near_reach: str | None = Field(None, description="Only cells within `within_cells` cells of this channel reach, e.g. MC-03")
    within_cells: int = Field(2, ge=0, le=20)


class Paint(BaseModel):
    where: CellSelector
    crop: str = Field(..., description="Crop code to paint, or 'original' to restore the Unity Catalog land use")


class NewBore(BaseModel):
    row: int
    col: int
    ML_per_year: float = Field(..., gt=0, le=5000)
    layer: int = Field(1, ge=0, le=1, description="0 = shallow Upper aquifer, 1 = deep Lower aquifer")


class ScenarioSpec(BaseModel):
    """A scenario as a base plus edits. Every field is optional; an empty spec is the calibrated baseline."""
    base: str | None = Field(None, description="Saved scenario to start from: 'name' (latest) or 'name@3'")
    base_run_id: str | None = Field(None, description="Start from the settings of a filed run instead")
    scenario: Scenario | None = Field(None, description="A complete scenario document to start from instead")
    set: dict[str, float] = Field(default_factory=dict, description="Parameter overrides, e.g. {'rain_mult': 0.8}")
    paint: list[Paint] = Field(default_factory=list, description="Land-use repaints, applied in order")
    line_reaches: list[str] = Field(default_factory=list)
    unline_reaches: list[str] = Field(default_factory=list)
    add_bores: list[NewBore] = Field(default_factory=list)
    remove_bores: list[tuple[int, int]] = Field(default_factory=list, description="[row, col] of proposed bores to remove")
    add_drains: list[DrainLine] = Field(default_factory=list, description="Proposed interceptor drains to add")
    remove_drains: list[str] = Field(default_factory=list, description="Names of proposed drains to remove")
    fidelity: Fidelity | None = Field(None, description="How finely to solve: cell refinement, sub-layers, time steps, solver. "
                                                        "Omit for the native 250 m model (or the base's own fidelity)")


def _parse_ref(base: str) -> tuple[str, int | None]:
    name, _, ver = base.partition("@")
    name = _stem(name.removesuffix(".json"))
    return name, int(ver.lstrip("v")) if ver else None


def run_row(request, run_id: str) -> pd.Series:
    if not run_id.isalnum():
        raise HTTPException(400, "bad run id")
    df = sql(user_client(request), f"SELECT * FROM {FQ}.model_runs WHERE run_id = :r", {"r": run_id})
    if df.empty:
        raise HTTPException(404, f"No filed run {run_id} is visible to you.")
    return df.iloc[0]


def resolve_spec(request, spec: ScenarioSpec) -> tuple[dict, dict | None, str]:
    """Turn a spec into (scenario, saved ref it is identical to or None, plain-language description)."""
    ref, what = None, "the calibrated baseline"
    if spec.scenario is not None:
        s, what = norm(spec.scenario.model_dump()), "the supplied scenario"
    elif spec.base_run_id:
        r = run_row(request, spec.base_run_id)
        s, what = norm(json.loads(r.scenario_json)), f"run {spec.base_run_id}"
    elif spec.base:
        name, ver = _parse_ref(spec.base)
        v = _versions(user_client(request), name)
        if v.empty:
            raise HTTPException(404, f"No saved scenario called {spec.base}.")
        hit = v if ver is None else v[v.version == ver]
        if hit.empty:
            raise HTTPException(404, f"{name} has no version {ver}.")
        row = hit.iloc[0]
        s = norm(json.loads(row.scenario_json))
        name = row.scenario
        ref, what = {"name": f"{name}.json", "version": int(row.version)}, f"{name} v{int(row.version)}"
    else:
        s = norm({})
    start = dict(s)
    entry = load_inputs(request)
    inp = entry["inp"]
    for k, v in spec.set.items():
        if k not in PARAMS:
            raise HTTPException(422, f"Unknown parameter {k}. Settable: {', '.join(PARAMS)}")
        s[k] = v
    known = {r["id"] for r in reach_payload(inp)}
    for rid in spec.line_reaches + spec.unline_reaches:
        if rid not in known:
            raise HTTPException(422, f"Unknown reach {rid}. Reaches: {', '.join(sorted(known))}")
    s["lined_reaches"] = sorted((set(s["lined_reaches"]) | set(spec.line_reaches)) - set(spec.unline_reaches))
    for p in spec.paint:
        if p.crop != "original" and p.crop not in gwmodel.CROPS:
            raise HTTPException(422, f"Unknown crop {p.crop}. Crops: {', '.join(gwmodel.CROPS)} or 'original'")
        cells = select_cells(request, p.where, s)
        painted = {(r, c): k for r, c, k in s["land_use"]}
        for r, c in cells:
            to = inp.land_use[r, c] if p.crop == "original" else p.crop
            if to == inp.land_use[r, c]:
                painted.pop((r, c), None)
            else:
                painted[(r, c)] = to
        s["land_use"] = [[r, c, k] for (r, c), k in painted.items()]
    if spec.fidelity is not None:
        s["fidelity"] = spec.fidelity.model_dump()
    gone = {tuple(x) for x in spec.remove_bores}
    s["extra_bores"] = [b for b in s["extra_bores"] if (b["row"], b["col"]) not in gone]
    for b in spec.add_bores:
        if not (0 <= b.row < inp.nrow and 0 <= b.col < inp.ncol) or not np.isfinite(inp.top[b.row, b.col]):
            raise HTTPException(422, f"Bore at [{b.row}, {b.col}] is outside the active model.")
        s["extra_bores"].append(b.model_dump())
    drains = [x for x in s.get("drain_lines", []) if x["name"] not in set(spec.remove_drains)]
    for x in spec.add_drains:
        bad = [c for c in x.cells if not (0 <= c[0] < inp.nrow and 0 <= c[1] < inp.ncol) or not np.isfinite(inp.top[c[0], c[1]])]
        if bad:
            raise HTTPException(422, f"Drain {x.name or ''} leaves the active model at {list(bad[0])}.")
        taken = {d["name"] for d in drains}
        name = x.name or next(f"D{i}" for i in range(1, 999) if f"D{i}" not in taken)
        drains = [d for d in drains if d["name"] != name] + [{**x.model_dump(), "name": name}]
    s["drain_lines"] = drains
    s = norm(s)
    if ref and s != start:
        ref = None
    change = change_summary(start, s, entry)
    desc = what if change == "No changes" else f"{what}, then {change}"
    return s, ref, desc


def _dtw_final(request, run_id: str | None) -> np.ndarray:
    entry = load_inputs(request)
    inp = entry["inp"]
    if not run_id:
        return np.asarray(baseline(entry)["dtw"][-1], float)
    await_filed([run_id], timeout=120)  # a run filed a moment ago is still being written: wait rather than fail
    df = sql(user_client(request), f"SELECT row, col, dtw_final_m FROM {FQ}.run_cell_results WHERE run_id = :r", {"r": run_id})
    if df.empty:
        raise HTTPException(404, f"Run {run_id} has no filed cell results: it is not a filed district run, or you cannot see it.")
    g = np.full((inp.nrow, inp.ncol), np.nan)
    g[df.row.to_numpy(), df.col.to_numpy()] = df.dtw_final_m.to_numpy(float)
    return g


def select_cells(request, where: CellSelector, scenario: dict) -> list[tuple[int, int]]:
    inp = load_inputs(request)["inp"]
    active = np.isfinite(inp.top)
    m = active.copy()
    if where.cells is not None:
        pick = np.zeros_like(m)
        for r, c in where.cells:
            if 0 <= r < inp.nrow and 0 <= c < inp.ncol:
                pick[r, c] = True
        m &= pick
    if where.rect is not None:
        r0, c0, r1, c1 = where.rect
        rr, cc = np.mgrid[0:inp.nrow, 0:inp.ncol]
        m &= (rr >= min(r0, r1)) & (rr <= max(r0, r1)) & (cc >= min(c0, c1)) & (cc <= max(c0, c1))
    if where.polygon:
        if len(where.polygon) < 3:
            raise HTTPException(422, "A polygon needs at least three vertices.")
        m &= in_polygon(where.polygon, inp.nrow, inp.ncol)
    if where.zone:
        z = zone_get(request, where.zone)
        pick = np.zeros_like(m)
        for r, c in z["cells"]:
            pick[r, c] = True
        m &= pick
    if where.crop:
        m &= gwmodel.land_use_for(inp, scenario) == where.crop
    if where.irrigated_only:
        m &= inp.irrigated.astype(bool)
    if where.dtw_below_m is not None:
        d = _dtw_final(request, where.dtw_run_id)
        m &= np.nan_to_num(d, nan=1e9) < where.dtw_below_m
    if where.near_reach:
        reach = next((r for r in reach_payload(inp) if r["id"] == where.near_reach), None)
        if reach is None:
            raise HTTPException(422, f"Unknown reach {where.near_reach}.")
        rr, cc = np.mgrid[0:inp.nrow, 0:inp.ncol]
        near = np.zeros_like(m)
        for c in reach["cells"]:
            near |= np.maximum(abs(rr - c["row"]), abs(cc - c["col"])) <= where.within_cells
        m &= near
    return [(int(r), int(c)) for r, c in zip(*np.nonzero(m))]


def cell_summary(request, cells: list[tuple[int, int]], scenario: dict) -> dict:
    inp = load_inputs(request)["inp"]
    ha = inp.delr * inp.delc / 1e4
    lu = gwmodel.land_use_for(inp, scenario)
    crops = pd.Series([lu[r, c] for r, c in cells], dtype=object).value_counts().to_dict() if cells else {}
    out = {"n_cells": len(cells), "hectares": round(len(cells) * ha), "by_crop_ha": {k: round(v * ha) for k, v in crops.items()}}
    if cells:
        rs, cs = zip(*cells)
        out["bbox"] = [min(rs), min(cs), max(rs), max(cs)]
    out["cells"] = [list(x) for x in cells[:400]]
    if len(cells) > 400:
        out["cells_truncated"] = True
    return out


MAP_GLYPH = {"rice": "R", "broadacre": "B", "horticulture": "H", "pasture": "P", "dryland": "."}


def render_map(request, layer: str, scenario: dict, run_id: str | None = None) -> str:
    """A text map an agent can read: one character per 250 m cell, rows north to south, with row/col rulers."""
    entry = load_inputs(request)
    inp = entry["inp"]
    grid = np.full((inp.nrow, inp.ncol), " ", dtype=object)
    legend = ""
    if layer == "land_use":
        lu = gwmodel.land_use_for(inp, scenario)
        for (r, c), k in np.ndenumerate(lu):
            grid[r, c] = MAP_GLYPH.get(k, "?")
        legend = "R rice, B row crops, H horticulture, P pasture, . dryland"
    elif layer in ("depth_to_water", "change"):
        if layer == "depth_to_water":
            d = _dtw_final(request, run_id)
            bands = [(1, "#"), (2, "+"), (4, "-"), (1e9, ".")]
            legend = "# <1 m, + 1-2 m (salinity risk), - 2-4 m, . >4 m depth to water, final period"
        else:
            if not run_id:
                raise HTTPException(422, "The change layer needs a run_id.")
            df = sql(user_client(request), f"SELECT row, col, change_m FROM {FQ}.run_cell_results WHERE run_id = :r", {"r": run_id})
            d = np.full((inp.nrow, inp.ncol), np.nan)
            d[df.row.to_numpy(), df.col.to_numpy()] = df.change_m.to_numpy(float)
            bands = [(-0.5, "v"), (-0.1, "-"), (0.1, "."), (0.5, "+"), (1e9, "^")]
            legend = "v fell >0.5 m, - fell 0.1-0.5, . within 0.1 m, + rose 0.1-0.5, ^ rose >0.5 m vs baseline"
        for (r, c), v in np.ndenumerate(d):
            if np.isfinite(v):
                grid[r, c] = next(g for lim, g in bands if v < lim)
    elif layer == "reaches":
        for (r, c), k in np.ndenumerate(gwmodel.land_use_for(inp, scenario)):
            grid[r, c] = "." if k == "dryland" else ","
        lined = set(scenario["lined_reaches"])
        for rch in reach_payload(inp):
            g = rch["id"][-1] if rch["id"] not in lined else "="
            for cell in rch["cells"]:
                grid[cell["row"], cell["col"]] = g
        legend = ("digits: last digit of the unlined reach id along that channel (MC = Main Canal runs west-east, "
                  "BC = Branch Canal runs north-south); = lined reach; , irrigated; . dryland")
    else:
        raise HTTPException(422, "layer must be land_use, depth_to_water, change or reaches")
    grid[~np.isfinite(inp.top)] = " "
    tens = "    " + "".join(str(c // 10) if c % 10 == 0 else " " for c in range(inp.ncol))
    ones = "    " + "".join(str(c % 10) for c in range(inp.ncol))
    body = "\n".join(f"{r:>3} " + "".join(grid[r]) for r in range(inp.nrow))
    return f"{layer} (row 0 = north, col 0 = west, cells {inp.delr:.0f} m)\n{tens}\n{ones}\n{body}\nLegend: {legend}"


# ---------------------------------------------------------------- studies: a question and everything filed against it
def _sid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def get_study_row(request, study_id: str) -> pd.Series:
    df = sql(user_client(request), f"SELECT * FROM {FQ}.studies WHERE study_id = :s", {"s": study_id})
    if df.empty:
        raise HTTPException(404, f"No study {study_id} is visible to you.")
    return df.iloc[0]


def create_study(request, title: str, question: str) -> dict:
    sid, now = _sid("st"), pd.Timestamp.now("UTC").tz_localize(None)
    _known_studies.add(sid)
    insert("studies", pd.DataFrame([{"study_id": sid, "title": title[:200], "question": question[:2000], "status": "open",
                                     "created_by": user_email(request), "created_at": now, "updated_at": now,
                                     "conclusion": None, "origin": origin_of(request)}]))
    return {"study_id": sid, "title": title, "question": question, "status": "open"}


def record_finding(request, study_id: str, text: str, run_ids: list[str], kind: str = "observation") -> dict:
    get_study_row(request, study_id)
    if kind not in ("observation", "conclusion", "caveat"):
        raise HTTPException(422, "kind must be observation, conclusion or caveat")
    ens_ids = [r for r in run_ids if r.startswith("ens-")]  # a finding can rest on an ensemble as well as on runs
    run_only = [r for r in run_ids if not r.startswith("ens-")]
    if run_ids:
        await_filed(run_only, timeout=12)
        w = user_client(request)
        seen = set(sql(w, f"SELECT run_id FROM {FQ}.model_runs WHERE run_id IN ({','.join(lit(r) for r in run_only)})").run_id) if run_only else set()
        if ens_ids:
            seen |= set(sql(w, f"SELECT ensemble_id FROM {FQ}.ensemble_runs WHERE ensemble_id IN ({','.join(lit(r) for r in ens_ids)})").ensemble_id)
        filing = {r for r in run_only if r in runs and not runs[r].get("done")}  # simulated here, still being filed
        missing = set(run_ids) - seen - filing
        if missing:
            raise HTTPException(422, f"Runs not filed (yet): {', '.join(sorted(missing))}. Findings must rest on filed runs or finished ensembles.")
    fid, now = _sid("f"), pd.Timestamp.now("UTC").tz_localize(None)
    insert("study_findings", pd.DataFrame([{"study_id": study_id, "finding_id": fid, "created_at": now,
                                            "created_by": user_email(request), "kind": kind, "text": text[:4000],
                                            "run_ids": list(run_ids), "origin": origin_of(request)}]))
    sql(sp, f"UPDATE {FQ}.studies SET updated_at = current_timestamp() WHERE study_id = :s", {"s": study_id})
    return {"finding_id": fid, "study_id": study_id}


def conclude_study(request, study_id: str, conclusion: str, status: str = "concluded") -> dict:
    get_study_row(request, study_id)
    sql(sp, f"UPDATE {FQ}.studies SET status = :st, conclusion = :c, updated_at = current_timestamp() WHERE study_id = :s",
        {"st": status, "c": conclusion[:4000], "s": study_id})
    return {"study_id": study_id, "status": status}


def _records(df: pd.DataFrame) -> list[dict]:
    for c in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            df[c] = df[c].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    return df.replace({np.nan: None}).to_dict("records")


def list_studies(request) -> list[dict]:
    df = sql(user_client(request), f"""
        SELECT s.study_id, s.title, s.question, s.status, s.created_by, s.created_at, s.updated_at, s.origin,
               (SELECT count(*) FROM {FQ}.model_runs r WHERE r.study_id = s.study_id) AS n_runs,
               (SELECT count(*) FROM {FQ}.study_findings f WHERE f.study_id = s.study_id) AS n_findings
        FROM {FQ}.studies s ORDER BY s.updated_at DESC LIMIT 50""")
    return _records(df)


def study_detail(request, study_id: str) -> dict:
    w = user_client(request)
    s = get_study_row(request, study_id)
    with ThreadPoolExecutor(2) as ex:
        rf = ex.submit(sql, w, f"""SELECT run_id, created_at, run_by, label, origin, scenario_name, scenario_version, pct_area_dtw_lt_2m,
                                   canal_seepage_ml, bore_extraction_ml, rmse_m FROM {FQ}.model_runs WHERE study_id = :s ORDER BY created_at""", {"s": study_id})
        ff = ex.submit(sql, w, f"SELECT finding_id, created_at, created_by, kind, text, run_ids, origin FROM {FQ}.study_findings WHERE study_id = :s ORDER BY created_at", {"s": study_id})
        runs_df, finds = rf.result(), ff.result()
    finds["run_ids"] = finds.run_ids.map(lambda v: json.loads(v) if isinstance(v, str) else list(v or []))
    return {"study": _records(pd.DataFrame([s]))[0], "runs": _records(runs_df), "findings": _records(finds)}


# ---------------------------------------------------------------- filed runs, read back as the user
def run_summary(payload: dict) -> dict:
    """The numbers an agent or job needs from a run, each beside its baseline."""
    k, b = payload["kpis"], payload["baseline_kpis"]
    pair = lambda key, scale=1, nd=1: {"value": round(k[key] / scale, nd), "baseline": round(b[key] / scale, nd),
                                      "change": round((k[key] - b[key]) / scale, nd)}
    reach = {r: {"ml": round(v), "baseline_ml": round(payload["baseline_reach_seepage_ml"].get(r, 0))}
             for r, v in payload["reach_seepage_ml"].items()
             if abs(v - payload["baseline_reach_seepage_ml"].get(r, 0)) > 1}
    return {
        "run_id": payload["run_id"],
        "kpis": {"area_dtw_lt_2m_pct": pair("pct_area_dtw_lt_2m_final"), "median_dtw_m": pair("median_dtw_m", nd=2),
                 "canal_seepage_gl": pair("canal_seepage_ml", 1000, 2), "bore_extraction_gl": pair("bore_extraction_ml", 1000, 2),
                 "recharge_gl": pair("recharge_ml", 1000, 2), "groundwater_et_gl": pair("gw_et_ml", 1000, 2),
                 "fit_rmse_m": pair("rmse_m", nd=3)},
        "water_table_change_m": {"mean": round(k["mean_wt_change_m"], 3), "max_rise": round(k["max_wt_rise_m"], 3) + 0.0,
                                 "max_fall": round(k["max_wt_fall_m"], 3) + 0.0},
        "reaches_changed": reach, "solver": {"max_discrepancy_pct": round(k["max_discrepancy_pct"], 4), "run_s": k["run_s"]},
        "persisted": payload.get("persisted", False),
        "fidelity": payload.get("fidelity"),
    }


def await_filed(run_ids: list[str], timeout: float = 120) -> None:
    """Runs this replica is still filing (archive, MLflow, Delta) are waited for, so a caller can read or cite a run
    straight after running it."""
    end = time.time() + timeout
    while time.time() < end and any(r in runs and not runs[r].get("done") for r in run_ids):
        time.sleep(1)


def filed_run(request, run_id: str) -> dict:
    await_filed([run_id], timeout=30)
    if run_id in runs and not runs[run_id].get("done"):
        raise HTTPException(409, f"Run {run_id} is still being filed (model files, MLflow, Delta). Ask again in a minute.")
    r = run_row(request, run_id)
    w = user_client(request)
    with ThreadPoolExecutor(2) as ex:
        bf = ex.submit(sql, w, f"""SELECT component, direction, round(sum(volume_ml), 1) AS volume_ml FROM {FQ}.run_water_budget
                                   WHERE run_id = :r GROUP BY component, direction ORDER BY component""", {"r": run_id})
        sf = ex.submit(sql, w, f"SELECT reach, seepage_ml, lined FROM {FQ}.run_reach_seepage WHERE run_id = :r ORDER BY reach", {"r": run_id})
        bud, seep = bf.result(), sf.result()
    row = _records(pd.DataFrame([r.drop(labels=["scenario_json"])]))[0]
    return {"run": row, "scenario": json.loads(r.scenario_json), "water_budget_ml": _records(bud),
            "reach_seepage_ml": _records(seep)}


# ---------------------------------------------------------------- background tasks: work that outlives a request
# A run at high fidelity can take minutes to hours. It runs here in the background; callers get a task id at once and
# can poll it, and an agent that started it is woken with the result when it finishes (agent._watcher).
tasks: dict[str, dict] = {}
heavy = ThreadPoolExecutor(max_workers=int(os.getenv("MODFLOW_HEAVY_WORKERS", "2")))


def task_public(t: dict) -> dict:
    return {k: v for k, v in t.items() if k not in ("payload", "request", "future")}


def submit_task(request, kind: str, label: str, estimate_s: float, work, fidelity: dict | None = None) -> dict:
    """Run work(progress) in the background; it returns (summary, run_id or None, payload or None)."""
    tid = "task-" + uuid.uuid4().hex[:10]
    t = tasks[tid] = {"task_id": tid, "kind": kind, "label": label, "status": "running", "stage": "queued", "done": 0, "total": 1,
                      "started": time.time(), "finished": None, "estimate_s": estimate_s, "fidelity": fidelity,
                      "session": request.headers.get("x-modflow-session") or None, "owner": user_email(request),
                      "run_id": None, "error": None, "summary": None, "told": False}

    def go():
        try:
            summary, rid, payload = work(lambda st, a, b: t.update(stage=st, done=a, total=b))
            t.update(status="finished", run_id=rid, summary=summary, payload=payload, stage="done")
        except HTTPException as e:
            t.update(status="failed", error=str(e.detail)[:1500])
        except Exception as e:  # noqa: BLE001 - surfaced to the caller
            log.exception("background task")
            t.update(status="failed", error=str(e)[:1500])
        t["finished"] = time.time()
        while len(tasks) > 200:
            tasks.pop(next(iter(tasks)))
    heavy.submit(go)
    return task_public(t)


# ---- batches: a sweep or an attribution in one call, solved in parallel and returned as one table
def expand_base(request, spec: "ScenarioSpec") -> "ScenarioSpec":
    """A spec whose edits all live in its base (a saved scenario, a filed run or a scenario document), rewritten as the
    same edits applied to the calibrated baseline, so attribution can split them."""
    s, _, _ = resolve_spec(request, ScenarioSpec(base=spec.base, base_run_id=spec.base_run_id, scenario=spec.scenario))
    d = gwmodel.DEFAULT_SCENARIO
    painted: dict[str, list] = {}
    for r, c, k in s.get("land_use") or []:
        painted.setdefault(k, []).append((int(r), int(c)))
    return ScenarioSpec(
        set={k: s[k] for k in PARAMS if k in s and abs(float(s[k]) - float(d.get(k, s[k]))) > 1e-12} | dict(spec.set),
        paint=[Paint(where=CellSelector(cells=cells), crop=k) for k, cells in painted.items()] + list(spec.paint),
        line_reaches=sorted(set(s.get("lined_reaches") or []) | set(spec.line_reaches)), unline_reaches=spec.unline_reaches,
        add_bores=[NewBore(**b) for b in s.get("extra_bores") or []] + list(spec.add_bores), remove_bores=spec.remove_bores,
        add_drains=[DrainLine(**x) for x in s.get("drain_lines") or []] + list(spec.add_drains), remove_drains=spec.remove_drains,
        fidelity=spec.fidelity or (Fidelity(**s["fidelity"]) if s.get("fidelity") else None))


def attribution_specs(spec: "ScenarioSpec", request=None) -> list[tuple[str, "ScenarioSpec"]]:
    """One spec per kind of edit in spec (each on its own, from the same base), for splitting a combined effect.
    When the edits are all in a saved base, they are taken from it, each applied alone to the baseline."""
    if request is not None and (spec.base or spec.base_run_id or spec.scenario):
        explicit = (spec.set or spec.paint or spec.line_reaches or spec.unline_reaches or spec.add_bores or spec.remove_bores
                    or spec.add_drains or spec.remove_drains)
        if not explicit:
            spec = expand_base(request, spec)
    common = {"base": spec.base, "base_run_id": spec.base_run_id, "scenario": spec.scenario, "fidelity": spec.fidelity}
    parts = [(f"{k} = {v:g}", ScenarioSpec(**common, set={k: v})) for k, v in spec.set.items()]
    if spec.paint:
        parts.append(("land-use repaint", ScenarioSpec(**common, paint=spec.paint)))
    if spec.line_reaches or spec.unline_reaches:
        parts.append(("channel lining " + ", ".join(spec.line_reaches + [f"unline {r}" for r in spec.unline_reaches]),
                      ScenarioSpec(**common, line_reaches=spec.line_reaches, unline_reaches=spec.unline_reaches)))
    if spec.add_bores or spec.remove_bores:
        parts.append((f"bores (+{len(spec.add_bores)} / -{len(spec.remove_bores)})",
                      ScenarioSpec(**common, add_bores=spec.add_bores, remove_bores=spec.remove_bores)))
    if spec.add_drains or spec.remove_drains:
        parts.append((f"drains (+{len(spec.add_drains)} / -{len(spec.remove_drains)})",
                      ScenarioSpec(**common, add_drains=spec.add_drains, remove_drains=spec.remove_drains)))
    return parts


def run_batch(request, items: list[tuple[str, "ScenarioSpec"]], study_id: str | None, attribute: bool, progress=None) -> dict:
    resolved = [(label, *resolve_spec(request, spec)) for label, spec in items]
    entry = load_inputs(request)
    for f in {json.dumps(r[1].get("fidelity"), sort_keys=True) for r in resolved}:  # baselines once, not per worker
        baseline(entry, json.loads(f))
    done = [0]

    def one(label, s, ref, desc):
        def prog(st, a, b):
            pass
        payload = asyncio.run(do_run(request, s, label or desc[:120], True, ref, study_id, prog))
        done[0] += 1
        if progress:
            progress("runs", done[0], len(resolved))
        return label, desc, payload
    with ThreadPoolExecutor(max_workers=max(1, (os.cpu_count() or 2) - 1)) as ex:
        results = list(ex.map(lambda r: one(*r), resolved))
    rows = []
    for label, desc, p in results:
        k, b = p["kpis"], p["baseline_kpis"]
        rows.append({"label": label, "run_id": p["run_id"], "description": desc,
                     "area_lt2m_pct": round(k["pct_area_dtw_lt_2m_final"], 2), "area_change_pp": round(k["pct_area_dtw_lt_2m_final"] - b["pct_area_dtw_lt_2m_final"], 2),
                     "peak_area_change_pp": round(k["pct_area_dtw_lt_2m_peak"] - b["pct_area_dtw_lt_2m_peak"], 2),
                     "seepage_change_gl": round((k["canal_seepage_ml"] - b["canal_seepage_ml"]) / 1000, 3),
                     "extraction_change_gl": round((k["bore_extraction_ml"] - b["bore_extraction_ml"]) / 1000, 3),
                     "median_dtw_change_m": round(k["median_dtw_m"] - b["median_dtw_m"], 3), "fit_rmse_m": round(k["rmse_m"], 3) if k.get("rmse_m") else None})
    out = {"runs": rows, "baseline_area_lt2m_pct": round(results[0][2]["baseline_kpis"]["pct_area_dtw_lt_2m_final"], 2) if results else None,
           "fidelity": results[0][2].get("fidelity") if results else None}
    if attribute and len(rows) > 1:
        combined, parts = rows[-1], rows[:-1]
        total = sum(r["area_change_pp"] for r in parts)
        out["attribution"] = {
            "combined_area_change_pp": combined["area_change_pp"], "sum_of_separate_pp": round(total, 2),
            "interaction_pp": round(combined["area_change_pp"] - total, 2),
            "shares": [{"edit": r["label"], "area_change_pp": r["area_change_pp"],
                        "share_of_sum": round(r["area_change_pp"] / total, 3) if abs(total) > 1e-9 else None} for r in parts],
            "note": "Each edit run alone from the same base; the interaction is what the edits do together beyond their sum."}
    return out


class BatchItem(BaseModel):
    label: str = Field("", description="What this run is, e.g. 'line MC-05'")
    scenario: "ScenarioSpec"


def batch_estimate(request, specs: list["ScenarioSpec"]) -> float:
    inp = load_inputs(request)["inp"]
    per = [gwmodel.fidelity_size(inp, gwmodel.fidelity_of({"fidelity": sp.fidelity.model_dump() if sp.fidelity else None}))["estimate_s"] for sp in specs]
    workers = max(1, (os.cpu_count() or 2) - 1)
    return round(sum(per) / workers + max(per, default=0) + 2 * len(per), 1)


def submit_run(request, scenario: dict, label: str, persist_run: bool, ref, study_id, kind: str = "run_scenario") -> dict:
    """Start a scenario run in the background; the task records progress and, when done, the result."""
    tid = "task-" + uuid.uuid4().hex[:10]
    entry = load_inputs(request)
    fid = gwmodel.fidelity_of(norm(scenario))
    size = gwmodel.fidelity_size(entry["inp"], fid)
    need_base = f"{entry['digest']}-{fid_key(fid)}" not in _baseline_cache
    t = tasks[tid] = {"task_id": tid, "kind": kind, "label": label, "status": "running", "stage": "queued", "done": 0, "total": 1,
                      "started": time.time(), "finished": None, "estimate_s": size["estimate_s"] * (2 if need_base else 1),
                      "fidelity": fid | size, "session": request.headers.get("x-modflow-session") or None,
                      "owner": user_email(request), "run_id": None, "error": None, "summary": None, "told": False}

    def progress(stage, done, total):
        t.update(stage=stage, done=done, total=total)

    def go():
        try:
            payload = asyncio.run(do_run(request, scenario, label, persist_run, ref, study_id, progress))
            t.update(status="finished", run_id=payload["run_id"], summary=run_summary(payload), payload=payload, stage="done")
        except HTTPException as e:
            t.update(status="failed", error=str(e.detail)[:1500])
        except Exception as e:  # noqa: BLE001 - surfaced to the caller
            log.exception("background run")
            t.update(status="failed", error=str(e)[:1500])
        t["finished"] = time.time()
        while len(tasks) > 200:
            tasks.pop(next(iter(tasks)))
    heavy.submit(go)
    return task_public(t)


def task_get(request, task_id: str) -> dict:
    t = tasks.get(task_id)
    if not t or t["owner"] != user_email(request):
        raise HTTPException(404, f"No task {task_id} (tasks live with the app; a restart forgets unfinished ones).")
    out = task_public(t) | {"elapsed_s": round((t["finished"] or time.time()) - t["started"], 1)}
    return out


@app.get("/api/tasks/{task_id}")
def get_task(task_id: str, request: Request):
    return task_get(request, task_id)


@app.get("/api/tasks/{task_id}/result")
def get_task_result(task_id: str, request: Request):
    task_get(request, task_id)
    t = tasks[task_id]
    if t["status"] != "finished":
        raise HTTPException(409, f"Task {task_id} is {t['status']}.")
    return JSONResponse(t["payload"])


@app.get("/api/fidelity/estimate")
def fidelity_estimate(request: Request, refine: int = 1, sublayers: int = 1, nstp: int = 2, solver: str = "standard"):
    entry = load_inputs(request)
    f = gwmodel.fidelity_of({"fidelity": {"refine": refine, "sublayers": sublayers, "nstp": nstp, "solver": solver}})
    return f | gwmodel.fidelity_size(entry["inp"], f) | {"baseline_cached": f"{entry['digest']}-{fid_key(f)}" in _baseline_cache}


# ---------------------------------------------------------------- every month of a run, and the sandbox that reads it
_arrays: dict[str, dict] = {}


def run_arrays(request, run_id: str) -> dict:
    """A filed run in full, month by month. Re-solved from its recorded scenario (MODFLOW is deterministic and takes
    about a second), so nothing has to be kept per cell per month in Delta."""
    await_filed([run_id], timeout=120)  # a run filed a moment ago (e.g. by run_batch) is still being written
    row = run_row(request, run_id)  # the caller must be able to see the run
    if run_id not in _arrays:
        entry = load_inputs(request)
        scen = norm(json.loads(row.scenario_json))
        base = baseline(entry, scen.get("fidelity"))
        res = simulate(entry, scen, f"series-{run_id}")
        p = result_payload(entry, res, base, scen, run_id)
        p["periods"], p["top"], p["land_use"] = gwmodel.period_labels(entry["inp"]), entry["inp"].top, entry["inp"].land_use.tolist()
        if "dtw_fine" in res:
            p["dtw_fine"], p["heads_fine_last"] = res["dtw_fine"], res["heads_fine"][-1]
        _arrays[run_id] = p
        while len(_arrays) > 24:
            _arrays.pop(next(iter(_arrays)))
    return _arrays[run_id]


def run_series(request, run_id: str) -> dict:
    p = run_arrays(request, run_id)
    per = p["periods"]
    months = []
    for i, lab in enumerate(per):
        d = np.array([[np.nan if v is None else v for v in row] for row in p["dtw"][i]], float)
        bd = np.array([[np.nan if v is None else v for v in row] for row in p["baseline_dtw"][i]], float)
        months.append({"period": i, "month": lab, "area_dtw_lt_2m_pct": round(float(p["area_lt2"][i]), 2),
                       "baseline_area_dtw_lt_2m_pct": round(float(p["baseline_area_lt2"][i]), 2),
                       "median_dtw_m": round(float(np.nanmedian(d)), 3), "min_dtw_m": round(float(np.nanmin(d)), 3),
                       "mean_change_vs_baseline_m": round(float(np.nanmean(d - bd)), 3)})
    bud = pd.DataFrame(p["budget"])
    budget = []
    if not bud.empty:
        tcol = next((c for c in ("month", "kper", "period") if c in bud.columns), None)
        if tcol:
            piv = bud.pivot_table(index=tcol, columns=["component", "direction"], values="volume_ml", aggfunc="sum").fillna(0)
            for t, r in piv.iterrows():
                budget.append({"month": str(t)[:10], **{f"{c}_{d}_ml": round(float(v), 1) for (c, d), v in r.items() if abs(v) > 0.05}})
    bores = {b: {"sim_mahd": h["sim"], "baseline_mahd": p["baseline_hydrographs"].get(b)} for b, h in p["hydrographs"].items()}
    return {"run_id": run_id, "periods": per, "months": months, "budget_by_month": budget, "bore_heads_by_month": bores,
            "observed": p["observed"], "note": "period 0 is the steady-state start; pass {\"run\": id} to run_python for every cell"}


# ---------------------------------------------------------------- probes: one cell, a zone, a section line
def in_polygon(poly: list, nrow: int, ncol: int) -> np.ndarray:
    """Cells whose centre (row, col) lies inside a polygon given in cell indices (even-odd rule)."""
    rr, cc = np.mgrid[0:nrow, 0:ncol].astype(float)
    inside = np.zeros((nrow, ncol), bool)
    pts = [(float(r), float(c)) for r, c in poly]
    for (r0, c0), (r1, c1) in zip(pts, pts[1:] + pts[:1]):
        cross = (r0 > rr) != (r1 > rr)
        with np.errstate(divide="ignore", invalid="ignore"):
            at = c0 + (rr - r0) * (c1 - c0) / (r1 - r0)
        inside ^= cross & (cc < at)
    return inside


def _probe_scenario(request, spec: "ScenarioSpec | None", run_id: str | None) -> tuple[dict, str]:
    if run_id:
        return norm(json.loads(run_row(request, run_id).scenario_json)), f"run {run_id}"
    s, _, desc = resolve_spec(request, spec or ScenarioSpec())
    return s, desc


def _month_days(inp) -> np.ndarray:
    return np.array([1.0] + [pd.Timestamp(m).days_in_month for m in inp.months])


def cell_probe(request, row: int, col: int, spec: "ScenarioSpec | None" = None, run_id: str | None = None) -> dict:
    """Everything about one cell of a solved scenario, month by month."""
    entry = load_inputs(request)
    inp = entry["inp"]
    if not (0 <= row < inp.nrow and 0 <= col < inp.ncol) or not np.isfinite(inp.top[row, col]):
        raise HTTPException(422, f"[{row}, {col}] is outside the active model.")
    s, what = _probe_scenario(request, spec, run_id)
    sol, base = solution(entry, s), baseline(entry, s.get("fidelity"))
    per, days = gwmodel.period_labels(inp), _month_days(inp)
    q = lambda a, nd=3: [None if not np.isfinite(v) else round(float(v), nd) for v in a]
    dtw, bdtw = sol["dtw"][:, row, col], np.asarray(base["dtw"])[:, row, col]
    am = s.get("k_aquifer_mult") or []
    layers = [{"layer": k, "name": ["Upper aquifer", "Lower aquifer"][k] if inp.nlay == 2 else f"Layer {k + 1}",
               "top_m": round(float(inp.top[row, col] if k == 0 else inp.botm[k - 1][row, col]), 2), "bottom_m": round(float(inp.botm[k][row, col]), 2),
               "k_m_per_d": round(float(inp.k[k, row, col] * s["k_mult"] * (float(am[min(k, len(am) - 1)]) if am else 1)), 3),
               "head_m": q(sol["heads"][:, k, row, col])} for k in range(inp.nlay)]
    cb = sol["cell_budget"]
    budget = {}
    for t, a in cb.items():
        if t in ("frf", "fff"):
            continue
        v = a[:, row, col] * days / 1000.0
        if np.abs(v[1:]).max() > 1e-4:
            budget[gwmodel.CELL_TERM_LABELS[t]] = q(v, 4)
    lat = -cb["frf"][:, row, col] - cb["fff"][:, row, col]
    if col > 0:
        lat = lat + cb["frf"][:, row, col - 1]
    if row > 0:
        lat = lat + cb["fff"][:, row - 1, col]
    budget[gwmodel.CELL_TERM_LABELS["lateral"]] = q(lat * days / 1000.0, 4)
    lu = gwmodel.land_use_for(inp, s)
    bores = entry["frames"]["bores"]
    here = bores[(bores.row == row) & (bores.col == col)]
    feats = entry["frames"]["boundary_cells"]
    fc = feats[(feats.row == row) & (feats.col == col)]
    reach = next((r["id"] for r in reach_payload(inp) if any(c["row"] == row and c["col"] == col for c in r["cells"])), None)
    return {
        "scenario": what, "row": row, "col": col, "periods": per,
        "land_m_ahd": round(float(inp.top[row, col]), 2), "land_use": lu[row, col], "recorded_land_use": inp.land_use[row, col],
        "irrigated": bool(inp.irrigated[row, col]), "sy": s["sy"], "layers": layers,
        "dtw_m": q(dtw), "baseline_dtw_m": q(bdtw), "change_m": q(dtw - bdtw),
        "budget_ml_by_month": budget, "budget_note": "ML per month into (+) or out of (-) the aquifer column under this cell; "
                                                     "Storage + is water released as the water table falls; period 0 is the steady start (a daily rate)",
        "bores": here[["bore_id", "bore_type", "layer"]].to_dict("records"),
        "features": sorted(set(fc.kind)) + (["proposed drain"] if any([row, col] in d["cells"] for d in s.get("drain_lines", [])) else []),
        "reach": reach, "proposed_bores": [b for b in s["extra_bores"] if b["row"] == row and b["col"] == col],
    }


def zone_stats(request, where: "CellSelector", spec: "ScenarioSpec | None" = None, run_id: str | None = None) -> dict:
    """A zone's water balance (ZoneBudget for the column of cells) and its depth-to-water statistics, month by month."""
    entry = load_inputs(request)
    inp = entry["inp"]
    s, what = _probe_scenario(request, spec, run_id)
    cells = select_cells(request, where, s)
    if not cells:
        raise HTTPException(422, "The zone has no active cells.")
    m = np.zeros((inp.nrow, inp.ncol), bool)
    m[tuple(np.array(cells).T)] = True
    sol, base = solution(entry, s), baseline(entry, s.get("fidelity"))
    per, days = gwmodel.period_labels(inp), _month_days(inp)
    dtw, bdtw = sol["dtw"][:, m], np.asarray(base["dtw"])[:, m]
    months = [{"period": i, "month": per[i], "area_lt_2m_pct": round(float(100 * np.nanmean(dtw[i] < 2)), 2),
               "baseline_area_lt_2m_pct": round(float(100 * np.nanmean(bdtw[i] < 2)), 2),
               "median_dtw_m": round(float(np.nanmedian(dtw[i])), 3), "min_dtw_m": round(float(np.nanmin(dtw[i])), 3),
               "mean_change_m": round(float(np.nanmean(dtw[i] - bdtw[i])), 3)} for i in range(1, len(per))]
    cb = sol["cell_budget"]
    terms = {}
    for t, a in cb.items():
        if t in ("frf", "fff"):
            continue
        v = a[:, m]
        terms[t] = (np.clip(v, 0, None).sum(axis=1), -np.clip(v, None, 0).sum(axis=1))
    # flow across the zone's edge, face by face (into the zone is +)
    ex = (m[:, :-1] != m[:, 1:]) * np.where(m[:, :-1], -1, 1)
    sx = (m[:-1, :] != m[1:, :]) * np.where(m[:-1, :], -1, 1)
    qf = np.concatenate([(cb["frf"][:, :, :-1] * ex).reshape(len(per), -1), (cb["fff"][:, :-1, :] * sx).reshape(len(per), -1)], axis=1)
    terms["lateral"] = (np.clip(qf, 0, None).sum(axis=1), -np.clip(qf, None, 0).sum(axis=1))
    ml = lambda a: a * days / 1000.0
    by_month, totals = [], []
    for i in range(1, len(per)):
        by_month.append({"month": per[i], **{f"{gwmodel.CELL_TERM_LABELS[t]} {d}": round(float(ml(v[j])[i]), 2)
                                              for t, v in terms.items() for j, d in ((0, "in"), (1, "out")) if v[j][i] > 1e-6}})
    for t, (vi, vo) in terms.items():
        tin, tout = float(ml(vi)[1:].sum()), float(ml(vo)[1:].sum())
        if tin + tout > 0.05:
            totals.append({"component": gwmodel.CELL_TERM_LABELS[t], "in_ml": round(tin, 1), "out_ml": round(tout, 1), "net_ml": round(tin - tout, 1)})
    totals.sort(key=lambda r: -(r["in_ml"] + r["out_ml"]))
    tin, tout = sum(r["in_ml"] for r in totals), sum(r["out_ml"] for r in totals)
    ha = inp.delr * inp.delc / 1e4
    rs, cs = zip(*cells)
    return {"scenario": what, "zone": where.zone, "n_cells": len(cells), "hectares": round(len(cells) * ha),
            "bbox": [min(rs), min(cs), max(rs), max(cs)], "months": months, "budget_totals_ml": totals,
            "budget_by_month_ml": by_month, "discrepancy_pct": round(100 * (tin - tout) / max(1e-9, (tin + tout) / 2), 3),
            "note": "Water balance of the full aquifer column under the zone over the 24 months (ZoneBudget). 'Flow across the zone "
                    "edge' is groundwater moving in from or out to the rest of the district; Storage in is water released as the water table falls."}


def section_profile(request, points: list, spec: "ScenarioSpec | None" = None, run_id: str | None = None, period: int | None = None) -> dict:
    """The model sampled cell by cell along a polyline: land surface, layer bottoms, water table and baseline."""
    entry = load_inputs(request)
    inp = entry["inp"]
    if len(points) < 2:
        raise HTTPException(422, "A section needs at least two points.")
    s, what = _probe_scenario(request, spec, run_id)
    sol, base = solution(entry, s), baseline(entry, s.get("fidelity"))
    k = len(gwmodel.period_labels(inp)) - 1 if period is None else max(0, min(int(period), len(inp.months)))
    path = []
    for a, b in zip(points, points[1:]):
        path += [q for q in gwmodel._line(int(a[0]), int(a[1]), int(b[0]), int(b[1])) if not path or q != path[-1]]
    out, dist, prev = [], 0.0, None
    for r, c in path:
        if not (0 <= r < inp.nrow and 0 <= c < inp.ncol):
            continue
        if prev:
            dist += float(np.hypot((r - prev[0]) * inp.delc, (c - prev[1]) * inp.delr)) / 1000
        prev = (r, c)
        if not np.isfinite(inp.top[r, c]):
            continue
        d, bd = float(sol["dtw"][k, r, c]), float(np.asarray(base["dtw"])[k, r, c])
        out.append({"distance_km": round(dist, 3), "row": r, "col": c, "land_m": round(float(inp.top[r, c]), 2),
                    "layer_bottoms_m": [round(float(inp.botm[j][r, c]), 2) for j in range(inp.nlay)],
                    "water_table_m": round(float(inp.top[r, c]) - d, 3), "dtw_m": round(d, 3), "baseline_dtw_m": round(bd, 3)})
    return {"scenario": what, "month": gwmodel.period_labels(inp)[k], "length_km": round(dist, 2), "samples": out}


# ---- zones: named areas of the district, shared in the workspace volume like scenarios
ZONES = f"{WORKSPACE}/zones"


class ZoneSave(BaseModel):
    name: str
    where: CellSelector = Field(..., description="The cells: a rect, a polygon, explicit cells, or any other selector")
    note: str = ""


def zones_list(request) -> list[dict]:
    w = user_client(request)
    try:
        items = [i for i in w.files.list_directory_contents(ZONES) if not i.is_directory and i.name.endswith(".json")]
    except Exception as e:  # no zones yet: the folder is made by the first save
        if type(e).__name__ in ("NotFound", "ResourceDoesNotExist") or "NOT_FOUND" in str(e).upper() or "does not exist" in str(e).lower():
            return []
        raise _files_error(e)

    def one(i):
        try:
            return json.loads(w.files.download(f"{ZONES}/{i.name}").contents.read())
        except Exception:
            return None
    with ThreadPoolExecutor(8) as ex:
        zs = [z for z in ex.map(one, items) if z]
    return sorted(zs, key=lambda z: z.get("created_at", ""), reverse=True)


def zone_get(request, name: str) -> dict:
    stem = _stem(name.removesuffix(".json"))
    try:
        return json.loads(user_client(request).files.download(f"{ZONES}/{stem}.json").contents.read())
    except Exception as e:
        err = _files_error(e)
        if err.status_code == 404:
            raise HTTPException(404, f"No zone called {name}. Zones: {', '.join(z['name'] for z in zones_list(request)) or 'none yet'}")
        raise err


def zone_save(request, z: ZoneSave) -> dict:
    stem = _stem(z.name)
    if not stem:
        raise HTTPException(400, "Give the zone a name.")
    cells = select_cells(request, z.where, norm({}))
    if not cells:
        raise HTTPException(422, "That zone has no active cells.")
    inp = load_inputs(request)["inp"]
    doc = {"name": z.name.strip(), "file": f"{stem}.json", "cells": [list(c) for c in cells], "note": z.note,
           "polygon": [list(p) for p in z.where.polygon] if z.where.polygon else None,
           "rect": list(z.where.rect) if z.where.rect else None, "hectares": round(len(cells) * inp.delr * inp.delc / 1e4),
           "created_by": user_email(request), "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    try:
        user_client(request).files.upload(f"{ZONES}/{stem}.json", io.BytesIO(json.dumps(doc).encode()), overwrite=True)
    except Exception as e:
        raise _files_error(e)
    return doc


def zone_delete(request, name: str) -> dict:
    stem = _stem(name.removesuffix(".json"))
    try:
        user_client(request).files.delete(f"{ZONES}/{stem}.json")
    except Exception as e:
        raise _files_error(e)
    return {"deleted": name}


class ProbeRequest(BaseModel):
    scenario: "ScenarioSpec | None" = None
    run_id: str | None = None


class CellProbe(ProbeRequest):
    row: int
    col: int


class ZoneProbe(ProbeRequest):
    where: CellSelector


class SectionProbe(ProbeRequest):
    points: list[tuple[int, int]]
    period: int | None = None


@app.post("/api/probe/cell")
async def api_probe_cell(req: CellProbe, request: Request):
    return await asyncio.get_running_loop().run_in_executor(pool, cell_probe, request, req.row, req.col, req.scenario, req.run_id)


@app.post("/api/probe/zone")
async def api_probe_zone(req: ZoneProbe, request: Request):
    return await asyncio.get_running_loop().run_in_executor(pool, zone_stats, request, req.where, req.scenario, req.run_id)


@app.post("/api/probe/section")
async def api_probe_section(req: SectionProbe, request: Request):
    return await asyncio.get_running_loop().run_in_executor(pool, section_profile, request, req.points, req.scenario, req.run_id, req.period)


@app.get("/api/zones")
def api_zones(request: Request):
    return zones_list(request)


@app.post("/api/zones")
def api_zone_save(z: ZoneSave, request: Request):
    return zone_save(request, z)


@app.delete("/api/zones/{name}")
def api_zone_delete(name: str, request: Request):
    return zone_delete(request, name)


SANDBOX_FN = f"{FQ}.modflow_sandbox"
ARTIFACTS = f"{WORKSPACE}/artifacts"
UPLOADS = f"{WORKSPACE}/uploads"


def _user_slug(request) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in user_email(request).split("@")[0]).strip("-") or "user"


def _npz(**arrays) -> bytes:
    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    return buf.getvalue()


def _grid(a) -> np.ndarray:
    return np.array([[np.nan if v is None else v for v in row] for row in a], float)


def sandbox_inputs(request, inputs: list[dict]) -> tuple[bytes, list[str]]:
    """Gather what a script asked for into one zip: runs (every month, every cell), packages (their files and, solved,
    their heads for every output time), uploaded files and query results, with a README saying what is where."""
    files: dict[str, bytes] = {}
    notes: list[str] = []
    for item in inputs or []:
        if item.get("run"):
            rid = str(item["run"])
            p = run_arrays(request, rid)
            extra = {"dtw_fine": np.asarray(p["dtw_fine"], "float32"), "heads_fine_last": np.asarray(p["heads_fine_last"], "float32")} if "dtw_fine" in p else {}
            files[f"runs/{rid}/arrays.npz"] = _npz(dtw=np.stack([_grid(d) for d in p["dtw"]]), baseline_dtw=np.stack([_grid(d) for d in p["baseline_dtw"]]),
                                                    top=np.asarray(p["top"], float), land_use=np.asarray(p["land_use"]), **extra)
            if extra:
                notes.append(f"runs/{rid}/arrays.npz also holds dtw_fine {list(extra['dtw_fine'].shape)} (the run's own resolution, "
                             f"{p['fidelity']['cell_m']:g} m cells) and heads_fine_last [layer, row, col] for the final month")
            files[f"runs/{rid}/run.json"] = json.dumps({k: p[k] for k in ("run_id", "scenario", "kpis", "baseline_kpis", "periods", "area_lt2",
                                                                         "baseline_area_lt2", "hydrographs", "baseline_hydrographs", "observed",
                                                                         "reach_seepage_ml", "baseline_reach_seepage_ml", "bore_rmse")}, default=str).encode()
            files[f"runs/{rid}/budget.csv"] = pd.DataFrame(p["budget"]).to_csv(index=False).encode()
            P, R, C = len(p["dtw"]), len(p["dtw"][0]), len(p["dtw"][0][0])
            notes.append(f"runs/{rid}/arrays.npz: np.load(...) keys dtw and baseline_dtw float [{P}, {R}, {C}] = [period, row, col], depth "
                         f"to water in m below land surface (NaN outside the model; period 0 is the steady-state start, then months "
                         f"{p['periods'][1] if len(p['periods']) > 1 else ''} to {p['periods'][-1]}), top float [{R}, {C}] land surface m AHD, land_use "
                         f"str [{R}, {C}] crop codes. Row 0 is north, cells are 250 m. "
                         f"runs/{rid}/run.json keys: run_id, scenario, kpis, baseline_kpis, periods (list of {P} labels), area_lt2 and "
                         f"baseline_area_lt2 (list of {P}: % of district within 2 m), hydrographs {{bore_id: {{sim: [{P} m AHD]}}}}, "
                         f"baseline_hydrographs {{bore_id: [{P}]}}, observed {{bore_id: {{t: [dates], h: [m AHD]}}}}, reach_seepage_ml and "
                         f"baseline_reach_seepage_ml {{reach: ML}}, bore_rmse {{bore_id: m}}. "
                         f"runs/{rid}/budget.csv columns: {', '.join(pd.DataFrame(p['budget']).columns)} (ML per month)")
        elif item.get("package"):
            name = _as_zip_name(str(item["package"]))
            data = _read(user_client(request), "models", name)
            stem = name.removesuffix(".zip")
            files[f"packages/{name}"] = data
            if item.get("solve", True):
                try:
                    out = mf6files.run(data, require_engine, _model_workdir(name, request) + "-s")
                    files[f"packages/{stem}/results.npz"] = _npz(heads=np.asarray(out["heads_all"], float), times=np.asarray(out["times"], float),
                                                                 top=np.asarray(out["top_all"], float), botm=np.asarray(out["botm_all"], float))
                    files[f"packages/{stem}/budget.csv"] = pd.DataFrame(out.get("budget_all") or []).to_csv(index=False).encode()
                    h = np.asarray(out["heads_all"])
                    notes.append(f"packages/{name}: the {mf6files.ENGINES.get(out.get('engine'), 'MODFLOW')} input files, zipped"
                                 + (f" (a {out['raster']['from']} grid of {out['raster']['cells']} cells, resampled here onto a regular raster)" if out.get("raster") else "")
                                 + f". packages/{stem}/results.npz keys heads float "
                                 f"{list(h.shape)} = [time, layer, row, col] m (NaN = dry or inactive), times [{h.shape[0]}] in "
                                 f"{out['time_units']}, top [{h.shape[2]}, {h.shape[3]}], botm [{h.shape[1]}, {h.shape[2]}, {h.shape[3]}]; "
                                 f"packages/{stem}/budget.csv: one row per output time, columns TERM_IN / TERM_OUT rates")
                except (mf6files.ModelError, HTTPException) as e:
                    notes.append(f"packages/{name}: could not be solved ({getattr(e, 'detail', e)}); only the input files are included")
            else:
                notes.append(f"packages/{name}: the MODFLOW 6 input files, zipped")
        elif item.get("upload"):
            nm = Path(str(item["upload"])).name
            try:
                files[f"uploads/{nm}"] = user_client(request).files.download(f"{UPLOADS}/{_user_slug(request)}/{nm}").contents.read()
                notes.append(f"uploads/{nm}: a file the user uploaded")
            except Exception as e:
                raise _files_error(e)
        elif item.get("ensemble"):
            eid = str(item["ensemble"]); w = user_client(request)
            for t, name in (("ensemble_cell_stats", "cells"), ("ensemble_monthly", "monthly"), ("ensemble_bore_bands", "bores"), ("ensemble_realizations", "realizations")):
                files[f"ensembles/{eid}/{name}.csv"] = sql(w, f"SELECT * FROM {FQ}.{t} WHERE ensemble_id = :e", {"e": eid}).to_csv(index=False).encode()
            notes.append(f"ensembles/{eid}/: cells.csv (row, col, p_dtw_lt_2m final month, p_dtw_lt_2m_any_month, dtw_p10/p50/p90), "
                         "monthly.csv (period, month, area_mean, area_p10/p50/p90), bores.csv (bore_id, period, head_p10/p50/p90), realizations.csv")
        elif item.get("file"):
            fp = str(item["file"])
            if not fp.startswith(WORKSPACE + "/") or ".." in fp.split("/"):
                raise HTTPException(400, f"{fp} is not in the workspace volume; pass files as /Volumes/.../workspace/... paths.")
            try:
                files[f"files/{Path(fp).name}"] = user_client(request).files.download(fp).contents.read()
            except Exception as e:
                raise _files_error(e)
            notes.append(f"files/{Path(fp).name}: {fp}")
        elif item.get("sql"):
            name = Path(str(item.get("as") or "query.csv")).name
            files[f"tables/{name}"] = sql(user_client(request), str(item["sql"])).to_csv(index=False).encode()
            notes.append(f"tables/{name}: the result of the query, run as the user")
    files["README.txt"] = ("Inputs for this script (paths relative to INPUTS):\n" + "\n".join(f"- {n}" for n in notes)).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for k, v in files.items():
            z.writestr(k, v)
    if buf.tell() > 9 * 2**20:
        raise HTTPException(413, "Those inputs are over 9 MB; ask for fewer runs or packages at once.")
    return buf.getvalue(), notes


def sandbox_run(request, code: str, inputs: list[dict], title: str) -> dict:
    """Run a script in the isolated sandbox as the user; keep what it wrote to OUTPUTS as artifacts in the volume."""
    import base64
    blob, notes = sandbox_inputs(request, inputs)
    t0 = time.time()
    # inputs travel inline in the statement (base64 has no quote characters); a parameter is limited to about 1 MB
    df = sql(user_client(request), f"SELECT {SANDBOX_FN}(:code, '{base64.b64encode(blob).decode()}') AS r", {"code": code})
    out = json.loads(df.iloc[0]["r"])
    first = next((Path(f["name"]).stem for f in out.get("files", []) if not f["name"].endswith(".py")), None)
    slug = "".join(ch if ch.isalnum() else "-" for ch in (title or first or "script").lower()).strip("-")[:48] or "script"
    folder = f"{ARTIFACTS}/{_user_slug(request)}/{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{slug}"
    w = user_client(request)
    arts = []
    for f in out.get("files", []):
        name = f["name"].replace("\\", "/").lstrip("/")
        if ".." in Path(name).parts:
            continue
        data = base64.b64decode(f["b64"])
        path = f"{folder}/{name}"
        try:
            w.files.upload(path, io.BytesIO(data), overwrite=True)
        except Exception as e:
            raise _files_error(e)
        arts.append({"name": name, "path": path, "bytes": len(data), "url": f"/api/volume-file?path={path}"})
    if out.get("files"):
        w.files.upload(f"{folder}/script.py", io.BytesIO(code.encode()), overwrite=True)
    return {"ok": not out.get("error"), "stdout": out.get("stdout", ""), "error": out.get("error"), "artifacts": arts,
            "folder": folder if arts else None, "inputs": notes, "seconds": round(time.time() - t0, 1)}


def uploads_list(request) -> list[dict]:
    try:
        items = list(user_client(request).files.list_directory_contents(f"{UPLOADS}/{_user_slug(request)}"))
    except Exception:
        return []
    return sorted([{"name": i.name, "bytes": i.file_size, "modified": i.last_modified} for i in items if not i.is_directory],
                  key=lambda f: -(f["modified"] or 0))


def upload_read(request, name: str, max_lines: int = 300) -> dict:
    nm = Path(name).name
    try:
        raw = user_client(request).files.download(f"{UPLOADS}/{_user_slug(request)}/{nm}").contents.read()
    except Exception as e:
        raise _files_error(e)
    if b"\x00" in raw[:4096]:
        return {"name": nm, "bytes": len(raw), "binary": True, "note": "Binary file: pass {\"upload\": name} to run_python to open it."}
    lines = raw.decode("utf-8", errors="replace").splitlines()
    return {"name": nm, "bytes": len(raw), "lines": len(lines), "text": "\n".join(lines[:max_lines])}


VOLUME_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif",
                ".pdf": "application/pdf", ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown", ".tex": "text/plain",
                ".json": "application/json", ".py": "text/plain", ".html": "text/html"}


@app.get("/api/volume-file")
def volume_file(path: str, request: Request, download: bool = False):
    """A file from the workspace volume, read as the user (artifacts open inline in the browser)."""
    p = Path(path)
    if not str(p).startswith(WORKSPACE + "/") or ".." in p.parts:
        raise HTTPException(400, "Only files in the workspace volume can be opened here.")
    try:
        data = user_client(request).files.download(str(p)).contents.read()
    except Exception as e:
        raise _files_error(e)
    kind = VOLUME_TYPES.get(p.suffix.lower(), "application/octet-stream")
    if kind == "text/html":
        kind = "text/plain"  # never render agent-written HTML on the app's origin
    disp = "attachment" if download or kind == "application/octet-stream" else "inline"
    headers = {"Content-Disposition": f'{disp}; filename="{p.name}"', "X-Content-Type-Options": "nosniff"}
    if kind not in ("application/pdf",):  # scripts in an SVG or text never run on the app's origin (PDF viewers need no sandbox)
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"
    return Response(data, media_type=kind, headers=headers)


@app.get("/api/user-files")
def user_files(request: Request):
    """The user's own files for the explorer: what they gave the agent, and what the agent made for them."""
    w, me = user_client(request), _user_slug(request)
    arts = []
    try:
        folders = sorted((i for i in w.files.list_directory_contents(f"{ARTIFACTS}/{me}") if i.is_directory), key=lambda i: i.name, reverse=True)[:30]
        for f in folders:
            d = f"{ARTIFACTS}/{me}/{f.name.rstrip('/')}"
            files = [{"name": i.name, "path": f"{d}/{i.name}", "bytes": i.file_size} for i in w.files.list_directory_contents(d) if not i.is_directory]
            arts.append({"folder": f.name.rstrip("/"), "path": d, "files": [x for x in files if x["name"] != "script.py"] + [x for x in files if x["name"] == "script.py"]})
    except Exception:
        pass
    ups = [u | {"path": f"{UPLOADS}/{me}/{u['name']}"} for u in uploads_list(request)]
    return {"uploads": ups, "artifacts": arts, "uploads_path": f"{UPLOADS}/{me}", "artifacts_path": f"{ARTIFACTS}/{me}"}


@app.delete("/api/user-files")
def delete_user_file(path: str, request: Request):
    me = _user_slug(request)
    if not (path.startswith(f"{UPLOADS}/{me}/") or path.startswith(f"{ARTIFACTS}/{me}/")) or ".." in path.split("/"):
        raise HTTPException(403, "Only your own uploads and agent outputs can be deleted here.")
    w = user_client(request)
    try:
        items = list(w.files.list_directory_contents(path)) if not Path(path).suffix else []
        for i in items:
            w.files.delete(f"{path.rstrip('/')}/{i.name}")
        if items:
            w.files.delete_directory(path)
        else:
            w.files.delete(path)
    except Exception as e:
        raise _files_error(e)
    return {"deleted": path}


@app.post("/api/agent-uploads")
async def agent_upload(request: Request, file: UploadFile = File(...)):
    """A file given to the agent, filed where it belongs: MODFLOW 6 packages with the models, scenario documents with the
    scenarios, anything else (data, papers, images) in the user's uploads folder for the agent to read."""
    w = user_client(request)
    data = await file.read()
    base = Path(file.filename or "upload").name
    low = base.lower()
    if low.endswith(".zip"):
        try:
            mf6files.validate_zip(data)
            name = _safe_name(base, "models")
            w.files.upload(f"{WORKSPACE}/models/{name}", io.BytesIO(data), overwrite=True)
            return {"kind": "model", "name": name, "path": f"{WORKSPACE}/models/{name}",
                    "hint": f"MODFLOW 6 package {name}, now in the workspace models (list_models, inspect_model)"}
        except mf6files.ModelError:
            pass  # a zip that is not a model is just a file
    if low.endswith(".json"):
        try:
            doc = json.loads(data)
            if isinstance(doc, dict) and set(doc) & set(Scenario.model_fields):
                name = _safe_name(base, "scenarios")
                w.files.upload(f"{WORKSPACE}/scenarios/{name}", io.BytesIO(data), overwrite=True)
                return {"kind": "scenario", "name": name, "path": f"{WORKSPACE}/scenarios/{name}",
                        "hint": f"scenario file {name}, now in the workspace scenarios (base it with \"base\": \"{name[:-5]}\")"}
        except ValueError:
            pass
    if len(data) > 50 * 2**20:
        raise HTTPException(413, "Files for the agent are limited to 50 MB.")
    name = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in base)[:120] or "upload"
    path = f"{UPLOADS}/{_user_slug(request)}/{name}"
    try:
        w.files.upload(path, io.BytesIO(data), overwrite=True)
    except Exception as e:
        raise _files_error(e)
    return {"kind": "file", "name": name, "path": path,
            "hint": f"uploaded file {name} (read_upload to read text; pass {{\"upload\": \"{name}\"}} in run_python inputs)"}


# ---------------------------------------------------------------- REST twins of the MCP tools, for jobs and scripts
class RunSpecRequest(BaseModel):
    scenario: ScenarioSpec = ScenarioSpec()
    label: str = ""
    study_id: str | None = None


class FindCellsRequest(BaseModel):
    where: CellSelector
    scenario: ScenarioSpec = ScenarioSpec()


class StudyIn(BaseModel):
    title: str
    question: str


class FindingIn(BaseModel):
    text: str
    run_ids: list[str] = []
    kind: str = "observation"


class ConcludeIn(BaseModel):
    conclusion: str
    status: str = "concluded"


def _off(fn, *a):
    return asyncio.get_running_loop().run_in_executor(None, fn, *a)


@app.post("/api/v1/scenarios/resolve")
async def api_resolve(spec: ScenarioSpec, request: Request):
    s, ref, desc = await _off(resolve_spec, request, spec)
    return {"scenario": s, "matches_saved": ref, "description": desc}


@app.post("/api/v1/runs")
async def api_run_spec(req: RunSpecRequest, request: Request):
    s, ref, desc = await _off(resolve_spec, request, req.scenario)
    payload = await do_run(request, s, req.label or desc[:120], True, ref, req.study_id)
    return run_summary(payload) | {"description": desc, "scenario_ref": ref}


@app.get("/api/v1/runs/{run_id}")
async def api_filed_run(run_id: str, request: Request):
    return await _off(filed_run, request, run_id)


@app.post("/api/v1/cells/find")
async def api_find_cells(req: FindCellsRequest, request: Request):
    def go():
        s, _, _ = resolve_spec(request, req.scenario)
        return cell_summary(request, select_cells(request, req.where, s), s)
    return await _off(go)


@app.get("/api/v1/map")
async def api_map(request: Request, layer: str = "land_use", run_id: str | None = None, base: str | None = None):
    def go():
        s = resolve_spec(request, ScenarioSpec(base=base, base_run_id=run_id if layer == "land_use" else None))[0]
        return render_map(request, layer, s, run_id)
    return Response(await _off(go), media_type="text/plain")


@app.get("/api/v1/studies")
async def api_studies(request: Request):
    return await _off(list_studies, request)


@app.post("/api/v1/studies")
async def api_create_study(s: StudyIn, request: Request):
    return await _off(create_study, request, s.title, s.question)


@app.get("/api/v1/studies/{study_id}")
async def api_study(study_id: str, request: Request):
    return await _off(study_detail, request, study_id)


@app.post("/api/v1/studies/{study_id}/findings")
async def api_finding(study_id: str, f: FindingIn, request: Request):
    return await _off(record_finding, request, study_id, f.text, f.run_ids, f.kind)


@app.post("/api/v1/studies/{study_id}/conclude")
async def api_conclude(study_id: str, c: ConcludeIn, request: Request):
    return await _off(conclude_study, request, study_id, c.conclusion, c.status)


import mcp_server  # noqa: E402  (tools call the functions above)
import agent  # noqa: E402
import omni_runtime  # noqa: E402

app.include_router(agent.router)
MCP = mcp_server.mount(app, sys.modules[__name__])


class AgentIdentity:
    """MODFLOW tool calls from this app's own Omnigent host act as the user who owns the session.

    The host reaches /mcp over loopback with the session's key; the key is swapped for that user's forwarded
    identity, exactly as the Apps proxy presents it for their own requests. Anything else passes through untouched.
    """

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            hs = scope["headers"]
            key = next((v.decode() for k, v in hs if k == b"x-modflow-key"), None)
            if key is not None:
                who = agent.identity_for(key)
                client = (scope.get("client") or ("",))[0]
                if who is None or client not in ("127.0.0.1", "::1"):
                    return await JSONResponse({"detail": "Unknown agent session."}, status_code=401)(scope, receive, send)
                drop = {b"x-modflow-key", b"x-forwarded-access-token", b"x-forwarded-email", b"x-modflow-client",
                        b"x-forwarded-preferred-username", b"x-modflow-session"}
                scope = dict(scope, headers=[(k, v) for k, v in hs if k not in drop] + [
                    (b"x-forwarded-access-token", who["token"].encode()), (b"x-forwarded-email", who["email"].encode()),
                    (b"x-modflow-client", who["client"].encode()), (b"x-modflow-session", str(who.get("sid") or "").encode())])
        await self.inner(scope, receive, send)


app.add_middleware(AgentIdentity)
app.on_event("startup")(omni_runtime.start)
app.on_event("startup")(agent.start_watcher)
app.on_event("shutdown")(omni_runtime.stop)

STATIC = Path(__file__).parent / "static"
DIST = STATIC / "dist"
app.mount("/assets", StaticFiles(directory=DIST / "assets", check_dir=False), name="assets")


@app.get("/")
def index():
    return FileResponse(DIST / "index.html")
