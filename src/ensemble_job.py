"""Monte Carlo MODFLOW 6 ensemble, fanned out across Spark tasks.

Each realization samples uncertain parameters (K, specific yield, deep drainage, rainfall),
runs MODFLOW 6 inside a Spark task, and scores the fit against observed bore levels.
Behavioural realizations (RMSE under a threshold) are weighted GLUE-style to produce a
per-cell probability that the water table sits within 2 m of the surface: the salinity-risk map.

Job parameters (named): --ensemble_id --n --config_json --run_by --catalog --schema --label
"""
import argparse
import hashlib
import json
import os
import socket
import sys
import time

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd())
import gwmodel  # noqa: E402

p = argparse.ArgumentParser()
p.add_argument("--ensemble_id", required=True)
p.add_argument("--n", type=int, default=64)
p.add_argument("--config_json", default="{}")
p.add_argument("--run_by", default="")
p.add_argument("--label", default="")
p.add_argument("--job_run_id", default="")
p.add_argument("--catalog", required=True)
p.add_argument("--schema", required=True)
p.add_argument("--mf6_volume", default="")
p.add_argument("--experiment", default="")
args, _ = p.parse_known_args()

from pyspark.sql import SparkSession, functions as F, types as T  # noqa: E402

spark = SparkSession.builder.getOrCreate()
fq = f"{args.catalog}.{args.schema}"
cfg = json.loads(args.config_json or "{}")
base = {**gwmodel.DEFAULT_SCENARIO, **cfg.get("scenario", {})}
# What varies, around the scenario's own values (anything left out stays at the scenario's value):
#   k: log s.d. of conductivity; k_by_aquifer: Upper and lower aquifers vary independently
#   sy, deep_drainage: +/- relative spread (uniform); rain: s.d. of a rainfall multiplier
vary = {"k": 0.35, "k_by_aquifer": True, "sy": 0.5, "deep_drainage": 0.5, "rain": 0.15, **(cfg.get("vary") or {})}
if "spread" in cfg and "vary" not in cfg:  # the original request shape: conductivity spread only
    vary["k"] = float(cfg["spread"].get("k_log_sigma", vary["k"]))
spread = vary
rmse_threshold = float(cfg.get("rmse_threshold_m", 0.25))
t0 = time.time()

INPUT_TABLES = ["aquifer_cells", "boundary_cells", "bores", "bore_extractions_monthly", "weather_monthly"]
frames = {t: spark.table(f"{fq}.{t}").toPandas() for t in INPUT_TABLES + ["bore_water_levels"]}
observed = frames.pop("bore_water_levels")
cells = frames["aquifer_cells"]

rng = np.random.default_rng(int(hashlib.sha256(args.ensemble_id.encode()).hexdigest()[:8], 16))
n = args.n
ks, rel = float(vary.get("k") or 0), lambda key: float(vary.get(key) or 0)
by_aq = bool(vary.get("k_by_aquifer")) and ks > 0
samples = pd.DataFrame({
    "realization": np.arange(n),
    "k_mult": base["k_mult"] * (np.exp(rng.normal(0, ks, n)) if ks and not by_aq else 1.0),
    "k_mult_upper": np.exp(rng.normal(0, ks, n)) if by_aq else np.ones(n),
    "k_mult_lower": np.exp(rng.normal(0, ks, n)) if by_aq else np.ones(n),
    "sy": np.clip(base["sy"] * rng.uniform(1 - rel("sy"), 1 + rel("sy"), n), 0.01, 0.35),
    "deep_drainage_frac": np.clip(base["deep_drainage_frac"] * rng.uniform(1 - rel("deep_drainage"), 1 + rel("deep_drainage"), n), 0, 0.5),
    "rain_mult": base["rain_mult"] * (np.clip(rng.normal(1, rel("rain"), n), 0.3, 2.0) if rel("rain") else 1.0),
})
if by_aq:
    samples["k_mult"] = base["k_mult"] * np.ones(n)

# Ship gwmodel by value so executors don't need the workspace file on their path.
from pyspark import cloudpickle  # noqa: E402

cloudpickle.register_pickle_by_value(gwmodel)
MF6_ROOT = args.mf6_volume or f"/Volumes/{args.catalog}/{args.schema}/mf6_bin"


def run_partition(it):
    import shutil
    import tempfile

    local = gwmodel.install_mf6(lambda rel, dst: shutil.copy(os.path.join(MF6_ROOT, rel), dst),
                                os.path.join(tempfile.gettempdir(), "mf6"))
    inp = gwmodel.inputs_from_frames(*[frames[t] for t in INPUT_TABLES])
    for pdf in it:
        out = []
        for r in pdf.itertuples():
            sc = {**base, "k_mult": r.k_mult, "sy": r.sy, "deep_drainage_frac": r.deep_drainage_frac,
                  "rain_mult": r.rain_mult, "k_aquifer_mult": [r.k_mult_upper, r.k_mult_lower]}
            ws = tempfile.mkdtemp(prefix=f"real{r.realization}_")
            t = time.time()
            try:
                res = gwmodel.run(inp, sc, ws, local)
            except Exception as e:  # keep the ensemble going; record the failure
                res = {"ok": False, "stdout_tail": repr(e)}
            rec = {"realization": int(r.realization), "ok": bool(res["ok"]), "rmse_m": None,
                   "pct_area_dtw_lt_2m": None, "dtw_final": None, "dtw_min": None, "area_by_period": None, "bore_heads": None,
                   "runtime_s": time.time() - t,
                   "executor": f"{socket.gethostname()}/pid{os.getpid()}", "err": None if res["ok"] else res["stdout_tail"][-300:]}
            if res["ok"]:
                hyd = gwmodel.hydrographs(inp, res)
                fit = gwmodel.fit_stats(hyd, observed)
                fine = res.get("dtw_fine", res["dtw"])  # areas at the resolution MODFLOW solved
                dtw = res["dtw"][-1]
                hb = hyd.pivot_table(index="bore_id", columns="kper", values="sim_head").sort_index()
                rec.update(rmse_m=fit["rmse_m"], pct_area_dtw_lt_2m=float(100 * np.nanmean(fine[-1] < 2)),
                           dtw_final=np.round(dtw.ravel(), 3).astype(float).tolist(),
                           dtw_min=np.round(np.nanmin(res["dtw"][1:], axis=0).ravel(), 3).astype(float).tolist(),
                           area_by_period=[float(100 * np.nanmean(d < 2)) for d in fine],
                           bore_heads=json.dumps({b: [None if not np.isfinite(v) else round(float(v), 3) for v in row] for b, row in hb.iterrows()}))
            shutil.rmtree(ws, ignore_errors=True)
            out.append(rec)
        yield pd.DataFrame(out)


schema = T.StructType([
    T.StructField("realization", T.IntegerType()), T.StructField("ok", T.BooleanType()),
    T.StructField("rmse_m", T.DoubleType()), T.StructField("pct_area_dtw_lt_2m", T.DoubleType()),
    T.StructField("dtw_final", T.ArrayType(T.DoubleType())), T.StructField("dtw_min", T.ArrayType(T.DoubleType())),
    T.StructField("area_by_period", T.ArrayType(T.DoubleType())), T.StructField("bore_heads", T.StringType()),
    T.StructField("runtime_s", T.DoubleType()),
    T.StructField("executor", T.StringType()), T.StructField("err", T.StringType())])

sdf = spark.createDataFrame(samples).repartition(min(n, 64), "realization")
res = sdf.mapInPandas(run_partition, schema).toPandas()
res = res.merge(samples, on="realization").sort_values("realization")
wall = time.time() - t0
hosts = res.executor.str.split("/pid").str[0].nunique()
print(f"{res.ok.sum()}/{n} realizations ok on {hosts} hosts / {res.executor.nunique()} Python workers in {wall:.1f}s "
      f"(sum of run times {res.runtime_s.sum():.0f}s, effective parallelism {res.runtime_s.sum() / wall:.1f}x)")
if (~res.ok).any():
    print("first failure:", res.loc[~res.ok, "err"].iloc[0])

ok = res[res.ok].copy()
ok["behavioural"] = ok.rmse_m <= rmse_threshold
beh = ok[ok.behavioural] if ok.behavioural.any() else ok  # fall back to all runs if nothing fits
w = 1.0 / beh.rmse_m.clip(lower=1e-3) ** 2
w = w / w.sum()
ok["weight"] = 0.0
ok.loc[beh.index, "weight"] = w

nrow, ncol = int(cells.row.max()) + 1, int(cells.col.max()) + 1
D = np.array(beh.dtw_final.tolist())  # (n_beh, nrow*ncol)
p_shallow = (w.to_numpy()[:, None] * (D < gwmodel.SALINITY_RISK_DTW_M)).sum(0)
Dmin = np.array(beh.dtw_min.tolist())
p_any = (w.to_numpy()[:, None] * (Dmin < gwmodel.SALINITY_RISK_DTW_M)).sum(0)  # shallow in at least one month


def wq(q, X=None):
    """Weighted quantile down the first axis (realizations), per column."""
    X = D if X is None else X
    idx = np.argsort(X, axis=0)
    cw = np.cumsum(w.to_numpy()[idx], axis=0)
    pick = (cw >= q).argmax(axis=0)
    return np.take_along_axis(X, idx, 0)[pick, np.arange(X.shape[1])]


# every stress period: the share of the district within 2 m, weighted over behavioural realizations
A = np.array(beh.area_by_period.tolist())  # (n_beh, nper)
labels = gwmodel.period_labels(gwmodel.inputs_from_frames(*[frames[t] for t in INPUT_TABLES]))
monthly = pd.DataFrame({"ensemble_id": args.ensemble_id, "period": np.arange(A.shape[1]), "month": labels[:A.shape[1]],
                        "area_mean": (w.to_numpy()[:, None] * A).sum(0), "area_p10": wq(0.1, A), "area_p50": wq(0.5, A), "area_p90": wq(0.9, A)})
# every monitoring bore and period: the band of simulated heads
bh = [json.loads(x) for x in beh.bore_heads]
bores = []
for b in sorted(bh[0]):
    H = np.array([[np.nan if v is None else v for v in h[b]] for h in bh])
    bores.append(pd.DataFrame({"ensemble_id": args.ensemble_id, "bore_id": b, "period": np.arange(H.shape[1]), "month": labels[:H.shape[1]],
                               "head_p10": wq(0.1, H), "head_p50": wq(0.5, H), "head_p90": wq(0.9, H)}))
bore_bands = pd.concat(bores, ignore_index=True) if bores else pd.DataFrame()
final_area = np.array(beh.pct_area_dtw_lt_2m.tolist())[:, None]
peak_area = A[:, 1:].max(axis=1) if A.shape[1] > 1 else A[:, 0]


geo = cells[cells.layer == 0].sort_values(["row", "col"])
cellstats = pd.DataFrame({"ensemble_id": args.ensemble_id, "row": geo.row.astype(int).values,
                          "col": geo.col.astype(int).values, "lon": geo.lon.values, "lat": geo.lat.values,
                          "p_dtw_lt_2m": p_shallow, "dtw_p10": wq(0.1), "dtw_p50": wq(0.5), "dtw_p90": wq(0.9),
                          "p_dtw_lt_2m_any_month": p_any})
runtime = time.time() - t0

# MLflow: one parent run per ensemble so it sits next to the single runs from the app.
mlflow_run_id = None
try:
    import mlflow

    mlflow.set_tracking_uri("databricks")
    mlflow.set_experiment(args.experiment)
    with mlflow.start_run(run_name=f"ensemble {args.label or args.ensemble_id}") as mr:
        mlflow.set_tags({"run_type": "ensemble", "ensemble_id": args.ensemble_id, "run_by": args.run_by,
                         "engine": "MODFLOW 6.8.1", "compute": "Lakeflow Job (Spark)"})
        mlflow.log_params({"n_realizations": n, "rmse_threshold_m": rmse_threshold,
                           **{f"base_{k}": v for k, v in base.items() if k not in ("extra_bores", "land_use", "lined_reaches", "fidelity")},
                           "extra_bores": len(base["extra_bores"]), "land_use_cells_changed": len(base.get("land_use") or []),
                           "lined_reaches": ",".join(base.get("lined_reaches") or []) or "none",
                           "fidelity": json.dumps(base.get("fidelity") or "native"), **{f"vary_{k}": str(v) for k, v in spread.items()}})
        mlflow.log_metrics({"n_ok": int(ok.shape[0]), "n_behavioural": int(ok.behavioural.sum()),
                            "best_rmse_m": float(ok.rmse_m.min()),
                            "mean_pct_area_dtw_lt_2m": float((w * beh.pct_area_dtw_lt_2m).sum()),
                            "area_p_gt_50pct": float(100 * np.mean(p_shallow > 0.5)), "runtime_s": runtime})
        mlflow.log_table(ok.drop(columns=["dtw_final", "err"]), "realizations.json")
        mlflow_run_id = mr.info.run_id
except Exception as e:  # tracking is best-effort; results still land in UC
    print("MLflow logging skipped:", e)

real_cols = ["ensemble_id", "realization", "k_mult", "sy", "deep_drainage_frac", "rain_mult", "ok", "rmse_m",
             "behavioural", "weight", "pct_area_dtw_lt_2m", "runtime_s", "executor", "k_mult_upper", "k_mult_lower",
             "peak_pct_area_dtw_lt_2m"]
res["peak_pct_area_dtw_lt_2m"] = [max(a[1:]) if a is not None and len(a) > 1 else None for a in res.area_by_period]
allr = res.drop(columns=["dtw_final", "dtw_min", "area_by_period", "bore_heads", "err"]).merge(ok[["realization", "behavioural", "weight"]], on="realization", how="left")
allr["ensemble_id"] = args.ensemble_id
allr["behavioural"] = allr.behavioural.fillna(False).astype(bool)
allr["weight"] = allr.weight.fillna(0.0)
spark.createDataFrame(allr[real_cols]).write.mode("append").saveAsTable(f"{fq}.ensemble_realizations")
spark.createDataFrame(cellstats).write.mode("append").saveAsTable(f"{fq}.ensemble_cell_stats")
spark.createDataFrame(monthly).write.mode("append").saveAsTable(f"{fq}.ensemble_monthly")
if not bore_bands.empty:
    spark.createDataFrame(bore_bands).write.mode("append").saveAsTable(f"{fq}.ensemble_bore_bands")

job_run_id = int(args.job_run_id) if args.job_run_id.isdigit() else None
summary = pd.DataFrame([{
    "ensemble_id": args.ensemble_id, "created_at": pd.Timestamp.now("UTC").tz_localize(None), "run_by": args.run_by,
    "label": args.label, "config_json": json.dumps({"scenario": base, "spread": spread, "rmse_threshold_m": rmse_threshold}),
    "status": "SUCCEEDED", "job_run_id": job_run_id, "n_realizations": n, "n_ok": int(ok.shape[0]),
    "n_behavioural": int(ok.behavioural.sum()), "rmse_threshold_m": rmse_threshold,
    "mean_pct_area_dtw_lt_2m": float((w * beh.pct_area_dtw_lt_2m).sum()),
    "p90_pct_area_dtw_lt_2m": float(wq(0.9, final_area)[0]), "runtime_s": runtime,  # weighted, like the mean
    "mlflow_run_id": mlflow_run_id, "study_id": cfg.get("study_id"), "scenario_name": cfg.get("scenario_name"),
    "p10_pct_area_dtw_lt_2m": float(wq(0.1, final_area)[0]), "peak_mean_pct_area_dtw_lt_2m": float((w.to_numpy() * peak_area).sum())}])
spark.createDataFrame(summary).write.mode("append").option("mergeSchema", "false").saveAsTable(f"{fq}.ensemble_runs")
print(json.dumps(summary.drop(columns=["config_json"]).iloc[0].to_dict(), default=str, indent=1))
