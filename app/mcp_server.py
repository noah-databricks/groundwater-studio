"""MODFLOW OS over MCP: the same scenario, run and study operations the Studio uses, as tools.

Served at /mcp on the app (streamable HTTP, stateless, JSON responses). Callers authenticate to the app with a
workspace OAuth token, and the app forwards their identity, so every read runs as the caller under their Unity
Catalog grants and every filed run is stamped with their name. Agents in Omnigent sessions, Genie Code, jobs and
other agents all reach the model through these tools.
"""

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Literal

from fastapi import HTTPException
from mcp.server.fastmcp import Context, FastMCP, Image
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations

INSTRUCTIONS = """\
MODFLOW OS runs the USGS MODFLOW 6 groundwater model of a synthetic sample irrigation district (40 x 60 cells of 250 m,
two aquifer layers, monthly stress periods) on governed Unity Catalog data, as the calling user.

How to work:
1. describe_model first: parameters, crops, channel reaches, bores and the calibrated baseline numbers.
2. Look before you edit: render_map (land_use, depth_to_water, change, reaches) and find_cells.
3. Describe scenarios as a base plus edits (ScenarioSpec): parameters, land-use paint, lined reaches, proposed bores
   and proposed interceptor drains (add_drains: a line of cells and an invert depth). preview_scenario shows what an
   edit resolves to. Named zones (list_zones, save_zone) work anywhere a cell selector does: {"zone": "name"}.
4. run_scenario simulates and files the run (Delta tables, MLflow, model archive). At native fidelity runs take a few
   seconds; scenario.fidelity solves at up to 25 m cells, 6 layers per aquifer, daily steps and tight tolerances, and
   long runs go to a background task (estimate_fidelity first; the Studio wakes you when a task finishes).
5. For a research question, create_study first and pass study_id to every run, then record_finding with the
   run_ids each finding rests on, and conclude_study when done. Findings must rest on filed runs.
6. start_ensemble is how uncertainty is done: the scenario (every edit and its fidelity) solved many times on
   serverless Spark with conductivity (per aquifer), specific yield, deep drainage and rainfall sampled around its own
   values, kept by fit to the bores and weighted. get_ensemble gives the expected share within 2 m with its P10-P90,
   the band for every month and the best-fitting parameters; show_in_studio(ensemble=...) puts the chance map on the
   model. Use it before recommending an intervention: a difference smaller than the band is not a finding.
7. Other models: list_models shows the district model and every model package in the workspace: MODFLOW 6, or classic
   MODFLOW-2005, MODFLOW-NWT and MODFLOW-USG (run_model picks the engine from the name file; DISV and unstructured grids
   are drawn on a raster of their cells). Packages carry their real-world placement (origin, rotation, EPSG). inspect_model,
   read_model_file and run_model work on any package as-is. To build a new model, write its MODFLOW 6 input files
   build_model makes a structured-grid model from a plain description (grid, layers, K, boundaries, wells,
   recharge, rivers, drains); write_model takes complete MODFLOW 6 input files; edit_model_file changes one file.
   run_model then solves it and reports MODFLOW's own error text if it fails. To change an existing package, prefer
   get_model_build then edit_model (properties, active cells, wells, fixed heads, rivers, drains, recharge, ET,
   observation points, time setup, schedules, solver, regridding and layers): the same edits as the Studio's Build
   palette, only the changed files are rewritten, and parts it cannot represent are kept as uploaded. Schedules are
   named monthly patterns ("Irrigation season") that features follow over time: create one, then attach it.
   Calibration: calibrate_model fits a package to measured heads with PEST++ (GLM or IES) in the background, and
   apply_calibration saves the calibrated copy. Classic MODFLOW-2005/NWT packages convert to MODFLOW 6 first (convert_model). Packages open in the Studio's
   explorer like uploads. Scenarios, studies and ensembles apply to the district model only.
8. Probes: inspect_cell is a virtual bore anywhere (heads, depth, the cell's own budget, every month); zone_budget is
   ZoneBudget for any area; get_section samples a cross-section along any line.
   show_in_studio puts something on the user's screen (a run, a package, a view, an overlay, a month, a bore, a cell,
   a zone, a section line).
9. Every month is available: get_run_series for a district run, run_model's by_time for a package. For anything the
   tools do not compute (custom statistics, figures, animations frames, reports), write Python for run_python: it
   receives full arrays for runs and packages and returns what it writes to OUTPUTS as artifacts. view_image lets
   you see an uploaded image or one of your own figures.

Key outcome: area_dtw_lt_2m_pct, the share of the district with the water table within 2 m of the surface
(salinity risk). Lower is better. Channel seepage and deep drainage under irrigation are the main sources.
"""

WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)


def mount(app, api) -> FastMCP:
    """Register the tools against the app module `api` and serve them at /mcp."""
    mcp = FastMCP("MODFLOW OS", instructions=INSTRUCTIONS, streamable_http_path="/mcp", stateless_http=True, json_response=True,
                  transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False))

    def caller(ctx: Context) -> SimpleNamespace:
        req = getattr(ctx.request_context, "request", None)  # none over stdio: the sandbox or job identity is the caller
        headers = {k.lower(): v for k, v in (req.headers.items() if req is not None else [])}
        headers.setdefault("x-modflow-client", os.getenv("MODFLOW_OS_CLIENT", "mcp"))
        if not headers["x-modflow-client"].startswith("mcp"):
            headers["x-modflow-client"] = "mcp:" + headers["x-modflow-client"]
        return SimpleNamespace(headers=headers)

    async def call(fn, *a):
        try:
            return await asyncio.to_thread(fn, *a)
        except HTTPException as e:
            raise ToolError(str(e.detail))

    @mcp.tool(annotations=READ)
    async def describe_model(ctx: Context) -> dict:
        """The model an agent is working with: grid, adjustable parameters and their ranges, crops (with the water
        they use and how much drains to groundwater), supply-channel reaches, bores, and the calibrated baseline."""
        req = caller(ctx)

        def go():
            entry = api.load_inputs(req)
            inp, base = entry["inp"], api.baseline(entry)
            ha = inp.delr * inp.delc / 1e4
            lu = inp.land_use
            fields = api.Scenario.model_fields
            reaches = api.reach_payload(inp)
            bores = entry["frames"]["bores"]
            return {
                "grid": {"nrow": inp.nrow, "ncol": inp.ncol, "nlay": inp.nlay, "cell_m": inp.delr,
                         "periods": len(api.gwmodel.period_labels(inp)), "first_month": api.gwmodel.period_labels(inp)[1],
                         "orientation": "row 0 is the north edge, col 0 the west edge"},
                "parameters": {k: {"meaning": v, "default": fields[k].default,
                                   "min": next((m.ge for m in fields[k].metadata if hasattr(m, "ge")), None),
                                   "max": next((m.le for m in fields[k].metadata if hasattr(m, "le")), None)}
                               for k, v in api.PARAMS.items()},
                "crops": {k: {**v, "baseline_ha": round(float((lu == k).sum()) * ha)} for k, v in api.gwmodel.CROPS.items()},
                "reaches": [{"id": r["id"], "channel": r["channel"], "length_km": r["length_km"],
                             "baseline_seepage_ml": round(base["reaches"].get(r["id"], 0))} for r in reaches],
                "lining_effect": "Lining a reach cuts its seepage by about 90%",
                "bores": {"production": int((bores.bore_type == "production").sum()),
                          "monitoring": int((bores.bore_type == "monitoring").sum())},
                "baseline": {k: round(v, 3) if isinstance(v, float) else v for k, v in base["kpis"].items()},
                "inputs": {"read_as": entry["read_as"], "digest": entry["digest"], "catalog_schema": api.FQ},
            }
        return await call(go)

    @mcp.tool(annotations=READ)
    async def render_map(ctx: Context, layer: Literal["land_use", "depth_to_water", "change", "reaches"] = "land_use",
                         run_id: str | None = None, scenario: api.ScenarioSpec | None = None) -> str:
        """A text map of the district, one character per 250 m cell. depth_to_water and change read a filed run
        (depth_to_water defaults to the baseline); land_use and reaches show a scenario (default baseline)."""
        req = caller(ctx)

        def go():
            s = api.resolve_spec(req, scenario or api.ScenarioSpec(base_run_id=run_id if layer in ("land_use", "reaches") else None))[0]
            return api.render_map(req, layer, s, run_id)
        return await call(go)

    @mcp.tool(annotations=READ)
    async def find_cells(ctx: Context, where: api.CellSelector, scenario: api.ScenarioSpec | None = None) -> dict:
        """Find grid cells by crop, rectangle, irrigation, depth to water (baseline or a filed run) and distance to a
        channel reach. Returns a count, hectares, crop breakdown and the cells. Use the same selector in paint."""
        req = caller(ctx)

        def go():
            s = api.resolve_spec(req, scenario or api.ScenarioSpec())[0]
            return api.cell_summary(req, api.select_cells(req, where, s), s)
        return await call(go)

    @mcp.tool(annotations=READ)
    async def list_scenarios(ctx: Context) -> list[dict]:
        """Saved scenarios with their latest version and change summary."""
        req = caller(ctx)

        def go():
            df = api.sql(api.user_client(req), f"""
                SELECT scenario, max(version) AS latest_version, max_by(summary, version) AS latest_summary,
                       max_by(saved_by, version) AS saved_by, max(saved_at) AS last_saved_at
                FROM {api.FQ}.scenario_versions GROUP BY scenario ORDER BY last_saved_at DESC""")
            return api._records(df)
        return await call(go)

    @mcp.tool(annotations=READ)
    async def get_scenario(ctx: Context, name: str, version: int | None = None) -> dict:
        """A saved scenario's settings (latest, or a given version) and its version history."""
        req = caller(ctx)

        def go():
            stem = api._parse_ref(name)[0]
            v = api._versions(api.user_client(req), stem)
            if v.empty:
                raise HTTPException(404, f"No saved scenario called {name}.")
            hit = v if version is None else v[v.version == version]
            if hit.empty:
                raise HTTPException(404, f"{stem} has no version {version}.")
            row = hit.iloc[0]
            hist = api._records(v.drop(columns=["scenario_json", "scenario"]))
            return {"name": row.scenario, "version": int(row.version), "scenario": api.norm(json.loads(row.scenario_json)),
                    "history": hist}
        return await call(go)

    @mcp.tool(annotations=READ)
    async def preview_scenario(ctx: Context, scenario: api.ScenarioSpec) -> dict:
        """Resolve a scenario spec without running it: the full settings, a plain-language description of what
        changed, and the hectares repainted. Use it to check an edit before saving or running."""
        req = caller(ctx)

        def go():
            s, ref, desc = api.resolve_spec(req, scenario)
            return {"description": desc, "matches_saved": ref, "lined_reaches": s["lined_reaches"],
                    "cells_repainted": len(s["land_use"]), "extra_bores": s["extra_bores"],
                    "parameters": {k: s[k] for k in api.PARAMS}}
        return await call(go)

    @mcp.tool(annotations=WRITE)
    async def save_scenario(ctx: Context, name: str, scenario: api.ScenarioSpec, message: str = "",
                            base_version: int | None = None) -> dict:
        """Save a scenario as a new version (never overwrites history). To update an existing scenario pass the
        base_version you read, so a newer save by someone else is reported instead of overwritten."""
        req = caller(ctx)

        def go():
            s, _, desc = api.resolve_spec(req, scenario)
            stem = api._parse_ref(name)[0]
            latest = api._versions(api.user_client(req), stem)
            bv = base_version if base_version is not None else (int(latest.version.max()) if len(latest) else None)
            return api.save_scenario(api.SaveScenario(name=stem.replace("-", " "), scenario=api.Scenario(**s),
                                                      base_version=bv, message=message or ""), req) | {"description": desc}
        return await call(go)

    @mcp.tool(annotations=WRITE)
    async def run_scenario(ctx: Context, scenario: api.ScenarioSpec, label: str = "", study_id: str | None = None,
                           background: bool | None = None) -> dict:
        """Run MODFLOW 6 on a scenario and file the run (Delta tables, MLflow, model files). Returns the headline
        numbers beside the baseline (the baseline is solved at the same fidelity) and the reaches whose seepage changed.
        Pass study_id when working on a study.

        Fidelity (scenario.fidelity) sets how finely MODFLOW solves the district: refine (1 = 250 m cells, 2 = 125 m,
        4 = 62.5 m, 8 = 31 m, 10 = 25 m), sublayers per aquifer (1-6), nstp time steps per month (1-31) and solver
        (fast | standard | tight). Grid refinement changes answers materially (channels leak along a line instead of a
        250 m strip), so check sensitivity before trusting a result; the model was calibrated at 250 m.

        Runs estimated at over ~40 s (or with background=true) start as a background task and return a task_id at once:
        end your turn and the Studio wakes you with the result, or call get_task. Nothing is lost if it takes hours."""
        req = caller(ctx)
        s, ref, desc = await call(api.resolve_spec, req, scenario)
        est = await call(lambda: api.gwmodel.fidelity_size(api.load_inputs(req)["inp"], api.gwmodel.fidelity_of(s)))
        if background or (background is None and est["estimate_s"] > 40):
            t = await call(api.submit_run, req, s, label or desc[:120], True, ref, study_id)
            return {"background": True, **t, "description": desc,
                    "note": "Running in the background. End your turn; the Studio sends you the result when it finishes "
                            "(or poll get_task). Estimated " + f"{t['estimate_s']:.0f} s including the baseline at this fidelity."}
        try:
            payload = await api.do_run(req, s, label or desc[:120], True, ref, study_id)
        except HTTPException as e:
            raise ToolError(str(e.detail))
        host = req.headers.get("x-forwarded-host") or req.headers.get("host", "")
        base = f"https://{host}" if host else os.getenv("MODFLOW_OS_APP_URL", "")
        return api.run_summary(payload) | {"description": desc, "scenario_ref": ref,
                                           "open_in_studio": f"{base}/?run={payload['run_id']}" if base else None}

    @mcp.tool(annotations=WRITE)
    async def run_batch(ctx: Context, runs: list[api.BatchItem] | None = None, attribute: api.ScenarioSpec | None = None,
                        study_id: str | None = None, background: bool | None = None) -> dict:
        """Run several scenarios in one call, solved in parallel and filed like run_scenario, and get one comparison
        table back (area within 2 m and its change, peak change, seepage, extraction, median depth, fit), each against the
        baseline at its fidelity. Use it for sweeps: every reach, a range of values, several fidelities.

        attribute: give one scenario with several edits instead of runs, and it is split into its edits (each set
        parameter, the repaint, the lining, the bores), each run alone from the same base, plus the combined scenario;
        the result shares out the combined change and reports the interaction. Use it whenever you change more than
        one thing and need to say what caused what. A saved scenario works too: {"base": "name"} is split into its own edits.

        Batches estimated over ~40 s (or with background=true) run as a background task: end your turn and the Studio
        wakes you with the table."""
        req = caller(ctx)
        if attribute is not None:
            items = [(lbl, sp) for lbl, sp in api.attribution_specs(attribute, req)] + [("combined", attribute)]
            if len(items) < 3:
                raise ToolError("attribute needs a scenario with at least two edits to split.")
        elif runs:
            items = [(r.label, r.scenario) for r in runs]
        else:
            raise ToolError("Give runs (a list of {label, scenario}) or attribute (one scenario to split).")
        if len(items) > 60:
            raise ToolError("At most 60 runs per batch.")
        est = await call(api.batch_estimate, req, [sp for _, sp in items])
        if background or (background is None and est > 40):
            t = await call(api.submit_task, req, "run_batch", f"{len(items)} runs" + (" (attribution)" if attribute else ""), est,
                           lambda prog: (api.run_batch(req, items, study_id, attribute is not None, prog), None, None))
            return {"background": True, **t, "note": f"{len(items)} runs in the background (~{est:.0f} s). End your turn; the Studio "
                                                     "sends you the table when they finish (or poll get_task)."}
        return await call(api.run_batch, req, items, study_id, attribute is not None)

    @mcp.tool(annotations=READ)
    async def get_task(ctx: Context, task_id: str) -> dict:
        """A background task: stage, progress (time steps done of total), elapsed time, and when finished the run_id
        and the same summary run_scenario returns."""
        return await call(api.task_get, caller(ctx), task_id)

    @mcp.tool(annotations=READ)
    async def list_tasks(ctx: Context) -> list[dict]:
        """Your background tasks, newest first."""
        req = caller(ctx)
        return await call(lambda: [api.task_get(req, t) for t in reversed(list(api.tasks)) if api.tasks[t]["owner"] == api.user_email(req)][:30])

    @mcp.tool(annotations=READ)
    async def estimate_fidelity(ctx: Context, refine: int = 1, sublayers: int = 1, nstp: int = 2, solver: str = "standard") -> dict:
        """Cells, time steps, cell size and estimated solve time of the district model at a fidelity, before running it."""
        req = caller(ctx)
        return await call(lambda: api.fidelity_estimate(req, refine, sublayers, nstp, solver))

    @mcp.tool(annotations=READ)
    async def get_run(ctx: Context, run_id: str) -> dict:
        """A filed run: settings, headline metrics, water budget by component and seepage by channel reach."""
        return await call(api.filed_run, caller(ctx), run_id)

    @mcp.tool(annotations=READ)
    async def list_runs(ctx: Context, study_id: str | None = None, limit: int = 20) -> list[dict]:
        """Recently filed runs, newest first, optionally only those filed against a study."""
        req = caller(ctx)

        def go():
            where = "WHERE study_id = :s" if study_id else ""
            df = api.sql(api.user_client(req), f"""
                SELECT run_id, created_at, run_by, label, origin, study_id, scenario_name, scenario_version,
                       round(pct_area_dtw_lt_2m, 2) AS area_dtw_lt_2m_pct, round(canal_seepage_ml / 1000, 2) AS canal_seepage_gl,
                       round(bore_extraction_ml / 1000, 2) AS bore_extraction_gl, round(rmse_m, 3) AS rmse_m
                FROM {api.FQ}.model_runs {where} ORDER BY created_at DESC LIMIT {max(1, min(int(limit), 100))}""",
                         {"s": study_id} if study_id else None)
            return api._records(df)
        return await call(go)

    @mcp.tool(annotations=READ)
    async def compare_runs(ctx: Context, run_ids: list[str]) -> dict:
        """Side-by-side headline numbers and per-reach seepage for up to 12 filed runs."""
        req = caller(ctx)

        def go():
            ids = [r for r in run_ids if r.isalnum()][:12]
            if not ids:
                raise HTTPException(422, "Give at least one run id.")
            w, inl = api.user_client(req), ",".join(api.lit(r) for r in ids)
            runs = api.sql(w, f"""SELECT run_id, label, created_at, scenario_name, scenario_version, round(pct_area_dtw_lt_2m, 2) AS area_dtw_lt_2m_pct,
                                  round(canal_seepage_ml / 1000, 2) AS canal_seepage_gl, round(bore_extraction_ml / 1000, 2) AS bore_extraction_gl,
                                  round(max_drawdown_m, 3) AS max_fall_m, round(rmse_m, 3) AS rmse_m FROM {api.FQ}.model_runs WHERE run_id IN ({inl})""")
            seep = api.sql(w, f"SELECT run_id, reach, round(seepage_ml) AS seepage_ml FROM {api.FQ}.run_reach_seepage WHERE run_id IN ({inl})")
            by_reach = seep.pivot_table(index="reach", columns="run_id", values="seepage_ml").reset_index() if len(seep) else seep
            return {"runs": api._records(runs), "reach_seepage_ml": api._records(by_reach)}
        return await call(go)

    @mcp.tool(annotations=WRITE)
    async def start_ensemble(ctx: Context, scenario: api.ScenarioSpec, n: int = 64, label: str = "",
                             vary: api.EnsembleVary | None = None, rmse_threshold_m: float = 0.25, study_id: str | None = None) -> dict:
        """Uncertainty for a scenario: a Monte Carlo ensemble on serverless Spark. Each realization is the scenario (all its
        edits and its fidelity) with uncertain parameters sampled around the scenario's own values; realizations whose
        fit to observed bore levels is within rmse_threshold_m are kept and weighted by 1/RMSE^2 (GLUE).
        vary (defaults shown): k 0.35 (log s.d. of conductivity), k_by_aquifer true (the upper and lower aquifers independently),
        sy 0.5 and deep_drainage 0.5 (uniform +/- fraction), rain 0.15 (s.d. of a multiplier); 0 holds one fixed.
        Results: per-cell chance the water table is within 2 m (final month and any month), P10/P50/P90 depth, the band of
        the shallow area for every month, and head bands at every monitoring bore. Takes minutes: end your turn and the
        Studio wakes you when it finishes; the user sees it on the model when it does."""
        req = caller(ctx)

        def go():
            s, ref, desc = api.resolve_spec(req, scenario)
            return api.start_ensemble(api.EnsembleRequest(scenario=api.Scenario(**s), n=n, label=label or desc[:100], vary=vary or api.EnsembleVary(),
                                                          rmse_threshold_m=rmse_threshold_m, study_id=study_id,
                                                          scenario_name=f"{ref['name']} v{ref['version']}" if ref else None), req)
        return await call(go)

    @mcp.tool(annotations=READ)
    async def get_ensemble(ctx: Context, ensemble_id: str) -> dict:
        """An ensemble's result once finished: how many realizations were kept, the weighted expected and P10/P90 share
        of the district within 2 m (final month and the season's peak), that share's band for every month, what was
        varied, and the parameters of the best-fitting realizations. While its job is still running this returns status
        "running" with the elapsed time; in the Studio you are woken when it finishes, so there is no need to poll.
        For per-cell maps or bore bands in a figure, pass {"ensemble": id} to run_python... or show it with show_in_studio(ensemble=id)."""
        req = caller(ctx)

        def go():
            df = api.sql(api.user_client(req), f"SELECT * FROM {api.FQ}.ensemble_runs WHERE ensemble_id = :e", {"e": ensemble_id})
            if df.empty:
                job = api.ensemble_job(ensemble_id)
                if job is None:
                    raise HTTPException(404, f"No ensemble {ensemble_id} is running or filed (or it is not visible to you).")
                if job["state"] == "running":
                    import time
                    return {"status": "running", "ensemble_id": ensemble_id, "elapsed_s": int(time.time() - (job["started_ms"] or 0) / 1000),
                            "job_url": job["url"], "note": "Still running. Results are written when the job finishes; do not poll in a loop."}
                if job["state"] == "finished":
                    return {"status": "writing", "ensemble_id": ensemble_id, "note": "The job finished; results are being filed. Try again in a moment."}
                return {"status": "failed", "ensemble_id": ensemble_id, "job_url": job["url"], "message": job["message"]}
            row = api._records(df)[0]
            cfg = json.loads(row.pop("config_json") or "{}")
            mon = api._records(api.sql(api.user_client(req), f"SELECT month, round(area_mean, 2) AS mean, round(area_p10, 2) AS p10, round(area_p90, 2) AS p90 FROM {api.FQ}.ensemble_monthly WHERE ensemble_id = :e ORDER BY period", {"e": ensemble_id}))
            best = api._records(api.sql(api.user_client(req), f"""SELECT realization, round(rmse_m, 3) AS rmse_m, round(k_mult, 3) AS k_mult, round(k_mult_upper, 3) AS k_upper,
                round(k_mult_lower, 3) AS k_lower, round(sy, 4) AS sy, round(deep_drainage_frac, 3) AS deep_drainage, round(rain_mult, 3) AS rain_mult,
                round(pct_area_dtw_lt_2m, 2) AS area_final FROM {api.FQ}.ensemble_realizations WHERE ensemble_id = :e AND behavioural ORDER BY rmse_m LIMIT 8""", {"e": ensemble_id}))
            return {"status": "finished", **row, "varied": cfg.get("vary") or cfg.get("spread"), "scenario": cfg.get("scenario"),
                    "area_by_month": mon, "best_fitting": best}
        return await call(go)

    @mcp.tool(annotations=WRITE)
    async def create_study(ctx: Context, title: str, question: str) -> dict:
        """Open a study: a research question that runs and findings are filed against."""
        return await call(api.create_study, caller(ctx), title, question)

    @mcp.tool(annotations=READ)
    async def list_studies(ctx: Context) -> list[dict]:
        """Studies, most recently active first, with run and finding counts."""
        return await call(api.list_studies, caller(ctx))

    @mcp.tool(annotations=READ)
    async def get_study(ctx: Context, study_id: str) -> dict:
        """A study with its runs and findings."""
        return await call(api.study_detail, caller(ctx), study_id)

    @mcp.tool(annotations=WRITE)
    async def record_finding(ctx: Context, study_id: str, text: str, run_ids: list[str],
                             kind: Literal["observation", "conclusion", "caveat"] = "observation") -> dict:
        """Record a finding against a study, citing what it rests on: filed run ids and/or finished ensemble ids (ens-...)."""
        return await call(api.record_finding, caller(ctx), study_id, text, run_ids, kind)

    @mcp.tool(annotations=WRITE)
    async def conclude_study(ctx: Context, study_id: str, conclusion: str) -> dict:
        """Close a study with its conclusion."""
        return await call(api.conclude_study, caller(ctx), study_id, conclusion)

    # ---- every model in the workspace, and new ones
    @mcp.tool(annotations=READ)
    async def list_models(ctx: Context) -> list[dict]:
        """The models you can work with: the sample district model (scenario tools) and MODFLOW 6 packages (model tools)."""
        return await call(api.package_list, caller(ctx))

    @mcp.tool(annotations=READ)
    async def inspect_model(ctx: Context, name: str) -> dict:
        """A MODFLOW 6 package's model, grid, stress periods, packages and files."""
        return await call(api.package_inspect, caller(ctx), name)

    @mcp.tool(annotations=READ)
    async def read_model_file(ctx: Context, name: str, member: str) -> dict:
        """The text of one input file in a package (member as inspect_model lists it, e.g. 'model/gwf.npf')."""
        return await call(api.package_read, caller(ctx), name, member)

    @mcp.tool(annotations=READ)
    async def run_model(ctx: Context, name: str, probe: list[tuple[int, int, int]] | None = None) -> dict:
        """Solve a MODFLOW 6 package as-is with MODFLOW 6 and summarise heads (per layer), depth to water and the
        water budget of the last period. probe: [[layer, row, col], ...] (0-based) returns the final head at those cells.
        Nothing is filed; output files are not kept, so ask for probes here. Structured (DIS) grids only."""
        return await call(api.package_run, caller(ctx), name, probe)

    @mcp.tool(annotations=WRITE)
    async def write_model(ctx: Context, name: str, files: dict[str, str], overwrite: bool = False) -> dict:
        """Create (or with overwrite, replace) a MODFLOW 6 package from its input files: {relative path: file text},
        including mfsim.nam. The package is checked with FloPy before it is stored in the workspace volume."""
        return await call(api.package_write, caller(ctx), name, {k: v.encode() for k, v in files.items()}, overwrite)

    @mcp.tool(annotations=WRITE)
    async def build_model(ctx: Context, name: str, nlay: int, nrow: int, ncol: int, delr: float, delc: float, top: float,
                          botm: float | list[float], k: float | list[float] = 10.0, k33: float | list[float] | None = None,
                          icelltype: int = 1, sy: float = 0.1, ss: float = 1e-5, strt: float | None = None,
                          steady: bool = True, nper: int = 12, perlen: float = 30.0, nstp: int = 1,
                          chd: list[dict] | None = None, wells: list[dict] | None = None, recharge: float | None = None,
                          rivers: list[dict] | None = None, drains: list[dict] | None = None,
                          evt_rate: float | None = None, evt_depth: float = 2.0, solver: Literal["standard", "robust"] = "standard",
                          overwrite: bool = False) -> dict:
        """Build a new structured-grid MODFLOW 6 model with FloPy and store it as a package. Metres and days.
        botm: the bottom of the model (split evenly into layers) or one bottom per layer. k, k33: per layer or one value.
        Rows and columns are 0-based, row 0 = north. Boundaries take either {"edge": "west"|"east"|"north"|"south"} or
        {"cells": [[row, col], ...], "layer": 0}:
          chd:    [{"edge": "west", "head": 40}]
          wells:  [{"row": 15, "col": 15, "layer": 0, "rate": 500}]   (rate m3/d pumped out)
          rivers: [{"cells": [[0, 5], [1, 5]], "stage": 38, "cond": 100, "rbot": 37}]
          drains: [{"edge": "south", "elev": 30, "cond": 50}]
        recharge and evt_rate in m/d. Transient models: steady=false with nper, perlen, nstp (period 1 is steady).
        solver "robust" (complex IMS, more iterations, backtracking) for hard problems: extreme recharge or pumping,
        cells that dry and rewet, strong contrasts. Then run_model solves it; edit_model_file changes any file afterwards."""
        spec = {k_: v for k_, v in dict(nlay=nlay, nrow=nrow, ncol=ncol, delr=delr, delc=delc, top=top, botm=botm, k=k, icelltype=icelltype,
                                        sy=sy, ss=ss, steady=steady, nper=nper, perlen=perlen, nstp=nstp, chd=chd, wells=wells,
                                        recharge=recharge, rivers=rivers, drains=drains, evt_rate=evt_rate, evt_depth=evt_depth, solver=solver).items() if v is not None}
        if k33 is not None:
            spec["k33"] = k33
        if strt is not None:
            spec["strt"] = strt
        return await call(api.package_build, caller(ctx), name, spec, overwrite)

    @mcp.tool(annotations=READ)
    async def calibration_parameters(ctx: Context, name: str) -> list[dict]:
        """What a MODFLOW 6 package offers PEST++ to calibrate: multipliers on K, K33, Sy and Ss per layer, recharge,
        ET, and each river/drain/general-head package's conductance, with default bounds and which are chosen by default."""
        return await call(api.calibration_parameters, caller(ctx), name)

    @mcp.tool(annotations=WRITE)
    async def calibrate_model(ctx: Context, name: str, observations_file: str | None = None, observations: list[api.CalObs] | None = None,
                              parameters: list[api.CalParam] | None = None, method: Literal["glm", "ies"] = "glm",
                              iterations: int = 8, realizations: int = 40) -> dict:
        """Calibrate a MODFLOW 6 package to measured heads with PEST++ (runs in the background with parallel agents).
        observations_file: a CSV the user uploaded (list_uploads), columns name, layer, row, col (1-BASED, as in MODFLOW
        files), time (model time units since the start), head, optional weight. Or observations: a list with 0-based cells.
        parameters: names from calibration_parameters with optional lower/upper multiplier bounds (default: its usual set).
        method glm (Gauss-Levenberg-Marquardt: calibrated values, sensitivities and first-order 95% bands) or ies
        (iterative ensemble smoother: the best-fitting member and the posterior ensemble's P10-P90). Parameters are
        multipliers on the model's current values. Returns a task_id: end your turn; the Studio wakes you with the fit
        before/after and the multipliers. A parameter at its bound, or a band spanning an order of magnitude, means the
        observations do not pin it down: say so. apply_calibration then saves a calibrated copy."""
        req = caller(ctx)
        return await call(api.start_calibration, req, api.CalRequest(name=name, observations_file=observations_file, observations=observations or [],
                                                                     parameters=parameters or [], method=method, iterations=iterations, realizations=realizations))

    @mcp.tool(annotations=WRITE)
    async def apply_calibration(ctx: Context, name: str, task_id: str | None = None, multipliers: dict[str, float] | None = None,
                                as_name: str | None = None) -> dict:
        """Save a calibrated copy of a package (default <name>-calibrated.zip; the original is untouched): the multipliers
        of a finished calibrate_model task, or multipliers you give. Then run_model or show_in_studio(model=...)."""
        return await call(api.apply_calibration, caller(ctx), api.CalApply(name=name, task_id=task_id, multipliers=multipliers or {}, as_name=as_name))

    @mcp.tool(annotations=WRITE)
    async def convert_model(ctx: Context, name: str) -> dict:
        """Convert a MODFLOW-2005 or MODFLOW-NWT package to MODFLOW 6 with the USGS mf5to6 converter, keeping its
        placement and coordinate reference. The copy is stored as <name>-mf6.zip (the original is untouched) and can be
        edited with edit_model. Classic packages run as they are with run_model; conversion is only needed to edit them."""
        return await call(api.package_convert, caller(ctx), name)

    @mcp.tool(annotations=READ)
    async def get_model_build(ctx: Context, name: str) -> dict:
        """A MODFLOW 6 package as the Studio's Build palette sees it: grid, per-layer property ranges, time setup,
        solver, every feature (wells, fixed heads, rivers, drains) with its id and schedule, recharge and ET,
        observation points, schedules and what uses each, and the parts kept as uploaded (locked). Read it before edit_model."""
        req = caller(ctx)
        return await call(lambda: api.buildkit.summary(api.build_load(req, name)) | {"package": api._as_zip_name(name)})

    @mcp.tool(annotations=WRITE)
    async def edit_model(ctx: Context, name: str, edits: list[dict], run: bool = False) -> dict:
        """Edit a MODFLOW 6 package with the same operations as the Studio's Build palette, then save it (only the files
        that change are rewritten; locked parts stay as uploaded). Rows/cols/layers are 0-based. edits, applied in order:
          {"op":"set_property","property":"k|k33|sy|ss|strt|top|botm|idomain|icelltype","layer":0|"all","value":5,
           "mode":"set|multiply|add","where":{"all":true}|{"rect":[r0,c0,r1,c1]}|{"polygon":[[r,c],...]}|{"cells":[[r,c],...]}}
          {"op":"set_active","where":{...},"active":false,"layer":"all"}
          {"op":"add_well","row":10,"col":12,"layers":[1],"rate":500,"schedule":"Irrigation season"}   rate m3/d, + pumps, - injects
          {"op":"add_chd","edge":"west"|"cells":[[r,c]],"layers":"all","head":40,"head_mode":"abs|below_top"}
          {"op":"add_river","points":[[r,c],[r,c]],"layer":0,"stage_start":45,"stage_end":41,"bed_depth":1,"cond":100}
          {"op":"add_drain","points":[[r,c],...]|"edge":"south","elev":1.5,"elev_mode":"below_top|abs","cond":100}
          {"op":"set_recharge","mm_per_year":120,"where":{...},"mode":"set"}   {"op":"set_et","mm_per_year":900,"depth_m":2}
          {"op":"add_obs","name":"OB1","row":5,"col":5,"layer":0}
          {"op":"update","id":"W3","rate":800,"schedule":null}   {"op":"remove","id":"W3"}
          {"op":"set_time","transient":true,"start":"2025-07","period":"month|week|<days>","count":24,"nstp":2,"steady_first":true}
          {"op":"schedule","name":"Irrigation season","factors":[12 monthly factors Jan..Dec],"onoff":true}
          {"op":"schedule_override","name":"Recharge","from":13,"to":24,"factor":0.6,"label":"drought"}   0-based periods
          {"op":"attach" is "update" with "schedule"; recharge/ET take "schedule" in set_recharge/set_et}
          {"op":"delete_schedule","name":"..."}  {"op":"set_solver","solver":"standard|robust"}
          {"op":"resample","nrow":80,"ncol":80}  {"op":"split_layer","layer":0}  {"op":"remove_layer","layer":2}
        A schedule scales wells, recharge and ET and switches fixed heads, rivers and drains on (factor > 0) or off.
        run=true also solves it and returns run_model's summary; show_in_studio(model=name) puts it on the user's screen."""
        req = caller(ctx)

        def go():
            doc = api.build_load(req, name)
            if not doc.get("editable"):
                raise HTTPException(422, doc.get("why_not") or "This package cannot be edited.")
            doc, done = api.build_ops(doc, edits)
            saved = api.build_save(req, name, doc, doc.get("base_sha"))
            out = {"package": saved["package"], "done": done, "changed_files": saved["changed_files"]}
            if run:
                out["run"] = api.package_run(req, name)
            return out
        return await call(go)

    @mcp.tool(annotations=WRITE)
    async def edit_model_file(ctx: Context, name: str, member: str, text: str) -> dict:
        """Replace (or add) one input file in a package with new text, e.g. to change K in the NPF file or add a
        package (also list it in the model name file). The package is re-checked with FloPy before it is saved."""
        return await call(api.package_edit, caller(ctx), name, member, text)

    @mcp.tool(annotations=WRITE)
    async def delete_model(ctx: Context, name: str) -> dict:
        """Delete a MODFLOW 6 package from the workspace volume. Cannot be undone."""
        return await call(api.package_delete, caller(ctx), name)

    @mcp.tool(annotations=READ)
    async def list_ensembles(ctx: Context) -> list[dict]:
        """Recent ensembles, finished and still running."""
        req = caller(ctx)

        def go():
            df = api.sql(api.user_client(req), f"""SELECT ensemble_id, created_at, run_by, label, n_realizations, n_behavioural,
                mean_pct_area_dtw_lt_2m, p90_pct_area_dtw_lt_2m FROM {api.FQ}.ensemble_runs ORDER BY created_at DESC LIMIT 30""")
            done = api._records(df)
            ids = {d["ensemble_id"] for d in done}
            running = []
            for r in api.sp.jobs.list_runs(job_id=api.JOB_ID, active_only=True, limit=20):
                p = {x.name: x.value for x in (r.job_parameters or [])}
                if p.get("ensemble_id") and p["ensemble_id"] not in ids:
                    running.append({"ensemble_id": p["ensemble_id"], "label": p.get("label"), "status": "running"})
            return running + [d | {"status": "finished"} for d in done]
        return await call(go)

    @mcp.tool(annotations=WRITE)
    async def delete_scenario(ctx: Context, name: str) -> dict:
        """Delete a saved scenario file (its version history stays in scenario_versions). Cannot be undone."""
        return await call(api.delete_file, "scenarios", name if name.endswith(".json") else f"{name}.json", caller(ctx))

    @mcp.tool(annotations=READ)
    async def show_in_studio(ctx: Context, run_id: str | None = None, model: str | None = None, scenario: str | None = None,
                             ensemble: str | None = None,
                             view: Literal["plan", "axonometric"] | None = None,
                             overlay: Literal["land_use", "reaches", "depth_to_water", "none"] | None = None,
                             panel: Literal["section", "hydrograph", "budget", "changes", "cell", "zone"] | None = None,
                             bore: str | None = None, section_row: int | None = None, month: int | None = None,
                             cells: list[tuple[int, int]] | None = None, section_line: list[tuple[int, int]] | None = None,
                             cell: tuple[int, int] | None = None, zone: str | None = None,
                             sheet: Literal["model", "uncertainty", "record"] | None = None) -> dict:
        """Put something on the user's screen in the Studio: open a filed run, a finished ensemble (its chance map and bands),
        a package (by name) or a saved scenario on
        the model; switch plan/axonometric; show an overlay; open the section, a bore's hydrograph or the water budget;
        move the section to a row, or draw it along any line (section_line, [row, col] points); step to a stress period
        (1-based month); outline cells and move the view to them; open one cell's readout (cell) or a saved zone's water
        balance (zone); or switch sheet. The user sees it when they are following the agent. Changes nothing in the record."""
        shown = {k: v for k, v in dict(run_id=run_id, model=model, scenario=scenario, ensemble=ensemble, view=view, overlay=overlay, panel=panel,
                                        bore=bore, section_row=section_row, month=month, cells=cells, sheet=sheet,
                                        section_line=section_line, cell=cell, zone=zone).items() if v is not None}
        if not shown:
            raise ToolError("Say what to show: a run_id, model, scenario, view, overlay, panel, bore, section_row, section_line, month, cells, cell, zone or sheet.")
        return {"shown": shown, "note": "Shown in the Studio if the user is following the agent (Follow is on by default)."}

    # ---- probes: a cell, a zone, a section line; and named zones
    @mcp.tool(annotations=READ)
    async def inspect_cell(ctx: Context, row: int, col: int, run_id: str | None = None, scenario: api.ScenarioSpec | None = None) -> dict:
        """Everything about one cell, every month, for a filed run or a scenario (default the baseline): depth to water
        and its change from the baseline, the head in each aquifer, land surface, land use, conductivity per layer, Sy,
        and the cell's own water budget (recharge, channel seepage, ET, drains, bores, storage, flow to and from its
        neighbours) in ML per month. A virtual monitoring bore anywhere."""
        return await call(api.cell_probe, caller(ctx), row, col, scenario, run_id)

    @mcp.tool(annotations=READ)
    async def zone_budget(ctx: Context, where: api.CellSelector, run_id: str | None = None, scenario: api.ScenarioSpec | None = None) -> dict:
        """ZoneBudget: the water balance of an area (the whole aquifer column under it) over the 24 months, by component,
        including groundwater flowing in and out across its edge; plus its share within 2 m, median depth and change from
        the baseline, month by month. where is any cell selector: {"zone": "name"} for a saved zone, a rect, a polygon of
        [row, col] vertices, a crop, a reach buffer. Use it to say where the water comes from and where an intervention acts."""
        return await call(api.zone_stats, caller(ctx), where, scenario, run_id)

    @mcp.tool(annotations=READ)
    async def get_section(ctx: Context, points: list[tuple[int, int]], run_id: str | None = None, scenario: api.ScenarioSpec | None = None,
                          month: int | None = None) -> dict:
        """A cross-section along any line: [row, col] points (two for a straight line, more for a dog-leg), sampled cell by
        cell with distance, land surface, layer bottoms, water table and baseline, for a month (1-24, default the last).
        show_in_studio(section_line=points) draws the same section for the user."""
        return await call(api.section_profile, caller(ctx), points, scenario, run_id, month)

    @mcp.tool(annotations=READ)
    async def list_zones(ctx: Context) -> list[dict]:
        """Named zones saved in the workspace (drawn in the Studio or saved by an agent): name, hectares, note, who made it."""
        req = caller(ctx)
        return await call(lambda: [{k: z.get(k) for k in ("name", "hectares", "note", "created_by", "created_at", "rect", "polygon")}
                                   for z in api.zones_list(req)])

    @mcp.tool(annotations=WRITE)
    async def save_zone(ctx: Context, name: str, where: api.CellSelector, note: str = "") -> dict:
        """Save a named zone (an area to report on or edit): any cell selector, e.g. a rect, a polygon of [row, col]
        vertices, or cells near a reach. It appears in the Studio's zone list; use {"zone": name} in find_cells, paint and
        zone_budget. Saving an existing name replaces it."""
        req = caller(ctx)
        return await call(lambda: {k: v for k, v in api.zone_save(req, api.ZoneSave(name=name, where=where, note=note)).items() if k != "cells"})

    @mcp.tool(annotations=WRITE)
    async def delete_zone(ctx: Context, name: str) -> dict:
        """Delete a saved zone."""
        return await call(api.zone_delete, caller(ctx), name)

    # ---- every month, free-form analysis, and the user's own files
    @mcp.tool(annotations=READ)
    async def get_run_series(ctx: Context, run_id: str) -> dict:
        """A filed district run month by month: area within 2 m, median and shallowest depth to water, change vs
        baseline, the water budget by component for every month, and simulated vs baseline heads at every monitoring bore."""
        return await call(api.run_series, caller(ctx), run_id)

    @mcp.tool(annotations=READ)
    async def run_python(ctx: Context, code: str, inputs: list[dict] | None = None, title: str = "") -> dict:
        """Run a Python script in an isolated sandbox (numpy, pandas, scipy, matplotlib, flopy, fpdf2, Pillow; no
        network, no MODFLOW executable: solve with run_scenario/run_model and analyse the results here). The script
        gets INPUTS and OUTPUTS directory paths as globals. inputs, each loaded under INPUTS (see INPUTS/README.txt):
          {"run": run_id}        every month and cell of a filed district run, under runs/<run_id>/:
                                 arrays.npz: dtw, baseline_dtw [period, row, col] m below surface (25 x 40 x 60; period 0 =
                                 steady start, then Jul 2024..Jun 2026), top [row, col] m AHD, land_use [row, col] crop codes;
                                 run.json: scenario, kpis, periods, area_lt2 / baseline_area_lt2 (% within 2 m by period),
                                 hydrographs {bore: {sim: [...]}}, baseline_hydrographs, observed {bore: {t, h}},
                                 reach_seepage_ml / baseline_reach_seepage_ml, bore_rmse; budget.csv (month, component,
                                 direction, volume_ml)
          {"package": name}      a MODFLOW 6 package, under packages/: <name>.zip (input files) and <stem>/results.npz
                                 (heads [time, layer, row, col], times, top, botm) plus <stem>/budget.csv (TERM_IN/OUT by time)
          {"upload": filename}   a file the user uploaded
          {"file": "/Volumes/.../workspace/..."}  any workspace file, e.g. an earlier output of yours (loaded as files/<name>)
          {"ensemble": ensemble_id}  a finished ensemble: cells.csv (row, col, p_dtw_lt_2m, p_dtw_lt_2m_any_month, dtw_p10/50/90),
                                 monthly.csv (area band by month), bores.csv (head band by bore and month), realizations.csv
          {"sql": "SELECT ...", "as": "name.csv"}  a query result, run as the user
        The sandbox cannot read /Volumes paths directly: pass earlier outputs with {"file": path}.
        Everything the script writes to OUTPUTS (PNG/SVG figures, PDFs via fpdf2 or matplotlib's PdfPages, CSV, .tex
        sources, notes) is kept as artifacts in the workspace volume and shown to the user; describe them in your reply.
        Printed output is returned. Use matplotlib's mathtext ($...$) for equations; there is no TeX installation, so
        write .tex files for the user to compile when they want a LaTeX document. For a report, use the Report class
        provided as a global rather than laying out fpdf2 by hand:
            r = Report("Title", "subtitle", "author")
            r.section("Summary").text("Plain text with **bold**.").bullets(["point", "point"])
            r.figure(path_to_png, "caption").table(["col", "col"], rows, "caption").note("small print")
            r.save(os.path.join(OUTPUTS, "report.pdf"))
        (Unicode fonts are built in; figures are numbered and kept on one page.) If you do use fpdf2 directly, pass
        new_x="LMARGIN", new_y="NEXT" to multi_cell, or the next line has no width. The result's "inputs" list gives every file's keys and shapes,
        so there is no need to explore them first. Each call starts fresh (~20 s)."""
        return await call(api.sandbox_run, caller(ctx), code, inputs or [], title)

    @mcp.tool(annotations=READ)
    async def view_image(ctx: Context, path: str):
        """Look at an image: one the user uploaded (its file name) or a figure you made (the artifact path run_python
        returned). In the Studio the image is sent to you as your next message, as a real image you see directly: finish
        this step (end your turn if you need to see it before going on) and it arrives. Use it to read a screenshot or chart
        the user sent, and to check your own figures before you present them."""
        req = caller(ctx)

        def go():
            me = api._user_slug(req)
            full = path if path.startswith("/Volumes/") else f"{api.UPLOADS}/{me}/{Path(path).name}"
            if not full.startswith(api.WORKSPACE + "/") or ".." in full.split("/"):
                raise HTTPException(400, "Only images in the workspace volume can be viewed.")
            try:
                data = api.user_client(req).files.download(full).contents.read()
            except Exception as e:
                raise api._files_error(e)
            import agent
            url = agent.image_data_url(data)
            sid = req.headers.get("x-modflow-session")
            if sid:
                # tool results reach the model as text in this harness bridge, so the image travels as a message instead
                agent.omni("POST", f"/v1/sessions/{sid}/events", json={"type": "message", "data": {"role": "user", "content": [
                    {"type": "input_text", "text": f"[Studio] The image you asked to see (view_image): {full}"},
                    {"type": "input_image", "filename": Path(full).name, "image_url": url}]}})
                return {"queued": True, "path": full,
                        "note": "The image arrives as your next message, where you see it directly. End your turn now if you need it before continuing."}
            import base64
            head, b64 = url.split(",", 1)
            return Image(data=base64.b64decode(b64), format="png" if "png" in head else "jpeg")  # other MCP clients take images natively
        return await call(go)

    @mcp.tool(annotations=READ)
    async def list_uploads(ctx: Context) -> list[dict]:
        """Files the user uploaded for you (data, papers, images). Model packages and scenarios they upload go to
        list_models and list_scenarios instead."""
        return await call(api.uploads_list, caller(ctx))

    @mcp.tool(annotations=READ)
    async def read_upload(ctx: Context, name: str) -> dict:
        """The text of an uploaded file (first 300 lines). For binary files, spreadsheets or images use run_python."""
        return await call(api.upload_read, caller(ctx), name)

    @mcp.tool(annotations=READ)
    async def describe_data(ctx: Context) -> dict:
        """Where everything lives in Unity Catalog, for SQL, notebooks, Genie and jobs downstream of MODFLOW OS."""
        return {"catalog_schema": api.FQ, "inputs": [f"{api.FQ}.{t}" for t in api.INPUT_TABLES + ["bore_water_levels"]],
                "outputs": {t: f"{api.FQ}.{t}" for t in ("model_runs", "run_bore_heads", "run_water_budget", "run_cell_results",
                                                        "run_reach_seepage", "scenario_versions", "studies", "study_findings",
                                                        "ensemble_runs", "ensemble_realizations", "ensemble_cell_stats")},
                "volumes": {"model_files": api.RUNS_VOLUME, "workspace": api.WORKSPACE},
                "mlflow_experiment": f"{api.cfg.host}/ml/experiments/{api.EXPERIMENT_ID}",
                "join_keys": "run_id joins every run_* table to model_runs; study_id joins model_runs and study_findings to studies"}

    http = mcp.streamable_http_app()
    for route in http.routes:
        app.router.routes.insert(0, route)
    inner = app.router.lifespan_context

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(a):
        async with mcp.session_manager.run():
            async with inner(a) as st:
                yield st
    app.router.lifespan_context = lifespan
    return mcp
