# Groundwater Studio: technical notes

## How it fits together

| Piece | Identity | What it does |
|---|---|---|
| UC tables (`aquifer_cells`, `boundary_cells`, `bores`, `bore_extractions_monthly`, `weather_monthly`, `bore_water_levels`) | n/a | Model grid, boundaries, bores, forcing, observations. `bores.landholder` / `licence_no` are column-masked unless in the data stewards group. |
| App: input reads | **User (OBO)**, scope `sql` | Every read runs as the signed-in researcher. The app SP has **no** SELECT on inputs. |
| App: MODFLOW run | App container | FloPy writes the model; `mf6` solves it (~0.3-0.6 s, ~3 s round trip). |
| App: archive download | **User (OBO)**, scope `files.files` | READ VOLUME on `model_runs` decides who can take model files home. |
| App: recording runs | App service principal | Zip to Volume `model_runs/runs/<id>/model.zip`; rows to `model_runs`, `run_bore_heads`, `run_water_budget` (stamped with the user); params/metrics to MLflow. |
| Ensemble job | Job run-as | `mapInPandas`, one realization per task; GLUE-style weighting against observed levels, output to `ensemble_*` tables + MLflow. |
| `mf6_bin` Volume | read by app SP + job | Governed executables: `6.8.1/linux-x86_64/bin/mf6` (official USGS, static) and `6.8.1/linux-aarch64/{bin/mf6,lib/*}` (conda-forge + Fortran runtime). |

## The interface (Sept 2026 redesign)

React + TypeScript + React Three Fiber front end (`ui/`, built into `app/static/dist`), designed as an irrigation engineering drawing set (see `PRODUCT.md` and `.impeccable/surfaces/`):

- **Start page (cover sheet)**: the app opens here instead of solving a scenario. *Continue* reopens what you had open last (remembered per browser: a saved scenario, a filed run, a package or the baseline); *Start* explores the district model, opens (uploads) a MODFLOW 6 package, starts an agent thread to build a model, or opens a study; the *Index* lists saved scenarios, recent runs, studies, packages and agent threads. The explorer's title (or the rail's home button) returns here. Deep links (`?run=`, `?study=`) skip it.

- **Sheet 1 Model**: cutaway 3D block model (hatched strata, blue water table with 0.5 m isolines, 2 m risk contour, revision clouds where the scenario moved the water table ≥0.2 m), draggable Section A–A′ that slices the model live, stress-period cue strip, bore hydrograph, water-budget schedule, title block (every figure with its delta vs baseline; "Issue run" files the run). Left explorer = drawing register (Sample district model, uploaded MODFLOW 6 packages, scenarios, issued runs) + package sections (RCH, EVT, RIV, WEL, NPF, STO) as expanders.
- **Uploaded models**: zip of MODFLOW 6 input files in Volume `workspace/models`; inspect (packages, grid, files), preview any text file, run as-is (structured DIS grids render in 3D), download, delete. All file operations run as the user (OBO `files.files`).
- **Record** (every filed run, every ensemble, and the studies that group them around a question).
- **Ensembles (uncertainty)** are a way of running the open scenario, not a separate sheet: *Run as an ensemble…* under the title block's Run and file sets the realizations, what varies around the scenario's own values (conductivity per aquifer, specific yield, deep drainage, rainfall) and the keep threshold. It runs as a Lakeflow Job on serverless Spark; when it finishes the model sheet shows its chance of a water table within 2 m (final month or any month) or P50 depth, the title block shows the weighted expected area with its P10-P90 and the peak month, hydrographs carry the P10-P90 head band, and an Ensemble inset tab shows the monthly band and fit against conductivity. Ensembles are listed in Record. **About the data** (identity model, sources, column masks) is reference, reached from the right end of the tab bar.
- **Camera:** drag to orbit, right-drag to pan, scroll to zoom; W A S D or arrows pan, Q/E turn, +/− zoom, 0 resets, P toggles plan, `,`/`.` step months, `?` lists every shortcut. The agent's harness and model are picked separately (harness first, then the models it can drive).

Seed packages: `setup/make_sample_models.py` (sample district baseline export + an independent 3-layer pumping test).

## Layout

```
src/gwmodel.py        shared model code (FloPy build, run, post-process) — used by app and job
src/ensemble_job.py   Spark ensemble
src/make_synthetic.py generates the synthetic district + "truth" run for observations
app/                  FastAPI backend (+ mf6files.py for uploaded packages); serves ui build from app/static/dist
ui/                   React + three.js front end (npm run build → app/static/dist)
setup/01_tables.sql   UC tables, column masks, output tables (run with setup/run_sql.py)
databricks.yml        bundle: job + app (resources, OBO scopes)
```

## Deploy

```
./deploy.sh            # copies src/gwmodel.py into app/, builds ui/, bundle deploy, bundle run app
```

## Gotchas found while building

- **Serverless Spark executors are aarch64.** The official MODFLOW Linux build is x86-64 only ("Exec format error"). Use the conda-forge `linux-aarch64` build (needs `libgfortran.so.5` + `libgcc_s.so.1` next to it; RPATH is `$ORIGIN/../lib`). Apps containers are x86-64. `gwmodel.install_mf6` picks by `platform.machine()`.
- **mf6 is ~49 MB**, over the app's per-file source limit, so it lives in a UC Volume and is fetched at startup (~2 s).
- **Statement Execution API is stateless:** `USE CATALOG/SCHEMA` does not carry to the next statement. Fully qualify every name.
- Serverless UDF tasks share one hostname/PID, so "executor count" is misleading; measure parallelism as sum(task time)/wall (~6x for 256 realizations, 220 s).
- `cloudpickle.register_pickle_by_value(gwmodel)` (from `pyspark`) ships the model module to executors without putting workspace files on their path.

## Production next steps

- Set the job `run_as` to a dedicated service principal; give researchers `CAN_USE` on the app and SELECT per trust tier.
- Real the data stewards group group + row filters for restricted monitoring networks.
- Swap the synthetic sample district for your own model (FloPy can `MFSimulation.load` an existing MODFLOW 6 model; MODFLOW-2005/NWT models convert with `mf5to6`).
- Genie space over `model_runs` / `ensemble_*` for "which scenarios cut salinity-risk area most?".

## Editing scenarios

- **Tools** (canvas toolbar; V, L, C, B, R, Z, X, Esc), in two groups. Edits: Select (click any cell to inspect it, a monitoring bore for its hydrograph), Land use (brush-paint rice / row crops / horticulture / pasture / dryland, or "Recorded" to paint back the UC map; 1, 3 or 5 cell brush with [ and ]; right-drag orbits while painting), Channels (click a 2 km reach to line or unline it), Bores (click to site a proposed bore), Drains (click along a line, double-click or ↵ to finish: a proposed sub-surface interceptor drain at 1.5 to 3 m, stored in the scenario as `drain_lines` and solved as its own DRN package, so the budget reports what it removes; click a drain to remove it). Analysis: Zones (drag a rectangle or click a polygon; the Zone tab gives its ZoneBudget, share within 2 m and median depth by month, and paints or lines channels inside it; save it by name and agents use it as `{"zone": name}`), Section (click two or more points for a cross-section along any line; the × on the Section tab goes back to a row). Undo/redo with ⌘Z / ⇧⌘Z; while drawing, ↵ finishes, ⌫ removes the last point and Esc cancels.
- **Inspect** (Select, then click a cell): the Cell tab is a virtual bore anywhere: depth to water and its change from the baseline, the head in each aquifer, conductivity per layer, Sy, land use, and the cell's own water budget (recharge, channel seepage, ET, drains, bores, storage, flow to and from its neighbours), read from the cell-by-cell budget file of the solve on screen.
- **Probes behind it**: every solve keeps its heads and cell-by-cell budget (`gwmodel.cell_budget`: each term per cell and month, plus east and south face flows so any zone's edge flow can be summed); the app keeps the last 16 in memory and re-solves on a miss. `/api/probe/cell`, `/api/probe/zone`, `/api/probe/section` and `/api/zones` serve the Studio; the MCP tools `inspect_cell`, `zone_budget`, `get_section`, `list_zones`, `save_zone` and `delete_zone` serve agents, and `show_in_studio` takes `cell`, `zone` and `section_line`. Zones live as JSON in `workspace/zones/`.
- **Scenario = document.** The explorer shows the open scenario's name, version and unsaved state. Save (⌘S) writes the canonical JSON to `workspace/scenarios/<name>.json` and appends a row to `scenario_versions` with an auto-generated change summary. Saving over a version someone else saved after you opened it is refused (409).
- **History and diffs.** Expand a scenario in the Scenarios tab to see its versions. Clicking one opens the Changes tab: a unified file diff of that version against its parent, and the same change drawn on the model (repainted cells, lined/unlined reaches, bores added/removed). With no version selected, Changes shows the working copy against the last save. Restore brings an old version back as unsaved changes; saving makes it the next version.
- **Provenance.** Runs issued from a saved, unedited version record `scenario_name` and `scenario_version` in `model_runs` (and MLflow `scenario_ref`).
- **Data.** `aquifer_cells.land_use` carries the crop per cell; `boundary_cells.reach` carries the channel reach id. Crop water use and drainage factors are `gwmodel.CROPS`; per-reach seepage comes from the MF6 cell budget (CANALS package).

## The model buildkit (Build palette)

Open any MODFLOW 6 package (uploaded, built by the agent, or "Start a blank model" on the cover sheet) and the palette becomes the Build palette: Structure (Select V, Grid G, Properties K), Boundaries (Heads H, Wells B, Rivers C, Drains R, Recharge & ET F, Observe O) and Section X, with a layer picker. Properties, active cells, heads and recharge paint with a 1 to 9 cell brush or fill a rectangle or polygon; alt-click picks up a value; the model is coloured by the property being painted. The explorer holds the grid (regrid, split or remove layers), Time (steady-state, or through time: start month, period length, count, steps, steady warm-up), Solver, Schedules and every feature with its values.

- **Schedules**: named patterns that anything changing over time follows: 12 monthly bars (drag them, or click months on and off), presets, overrides on a span of periods ("2025 drought ×0.6"), and a preview over the model's own periods. They scale wells, recharge and ET and switch fixed heads, rivers and drains on and off. Imports turn per-period data into "follows data" schedules.
- **How edits are stored** (`app/buildkit.py`): the package is read into a build document in `workspace/builds/<name>.json`; saving compiles it back to MODFLOW 6 files. A part that was not edited is written back byte for byte (the Changes tab shows only real file diffs), and packages or options it cannot represent (SFR, UZF, MAW, GHB, time series, auxiliary variables, cell-varying transient recharge) are kept exactly as uploaded and listed as locked. When the files change underneath (the agent's `edit_model_file`, a new upload), the document is read again and keeps its own form, such as named schedules, for every file that did not change.
- **Agents**: `get_model_build` and `edit_model` (the palette's operations as a list of edits, optionally solving) from MCP; the Studio follows them onto the model.

## Bring your own model: engines, grids, size, placement, calibration

- **Engines**: a package is a zip with `mfsim.nam` (MODFLOW 6) or a classic name file. MODFLOW-2005, MODFLOW-NWT and MODFLOW-USG run with the USGS builds from `mf6_bin/classic/linux-x86_64/` (fetched on first use; `require_engine`). The engine is chosen from the name file (USG for DISU/SMS, NWT for NWT/UPW), or named in a `modflow-os.json` sidecar. 2005 and NWT models convert to MODFLOW 6 with the USGS `mf5to6` (keeping origin, rotation and EPSG; heads match the original engine to a few millimetres), and the copy is editable in the Build palette (`convert_model`, `POST /api/models/{name}/convert`).
- **Grids**: DIS draws as it is. DISV (and MODFLOW 6 DISU) draw on a regular raster of their cells (`mf6files.raster_index`); USG DISU without cell outlines runs but does not draw. Editing is for DIS grids.
- **Size**: packages up to 2 GB, uploaded in 8 MB chunks (`/api/upload`, checked on disk before they reach the volume). Grids over 90,000 cells a layer are coarsened for the 3D view only, and at most 80 output times are drawn; runs and agent/sandbox results use every cell and time.
- **Packages beyond the palette**: GHB is fully editable (Heads tool, Fixed or General). SFR, UZF, LAK, MAW and anything else run and are kept byte for byte, are drawn on the model, and can be edited as text (the locked list's "Edit as text", or Edit on any file preview); the edit flows back into the build document.
- **Placement**: origin, rotation and EPSG are read from MODFLOW 6 DIS options, the classic name-file header (`#xll:..; rotation:..; crs:EPSG:..`) or `modflow-os.json`, shown with latitude/longitude for UTM/MGA systems (a built-in inverse transverse Mercator), a map link, world coordinates in the cell readout and a north arrow turned by the rotation; editable in the Build panel (DIS).
- **Calibration (PEST++ 5.2.16)**: `app/calibration.py`. Multipliers on K, K33, Sy, Ss per layer, recharge, ET and river/drain/GHB conductance; observed heads from an uploaded CSV (name, layer, row, col 1-based, time, head[, weight]). Each run starts from the saved package, so locked packages stay as uploaded. pestpp-glm (calibrated values, sensitivities, first-order 95% bands) or pestpp-ies (best-fitting member plus the posterior P10-P90), master + local agents in the app as a background task; the PEST++ files, summary and residuals go to the user's artifacts folder, and "Save a calibrated copy" writes `<name>-calibrated.zip`. Agents: `calibration_parameters`, `calibrate_model`, `apply_calibration`. Tested on synthetic truth: K ×0.5/×2.0 and recharge ×1.0 recovered to 1-2% in 67 s on the app.

## Verified on a public benchmark: Freyberg

The GMDSI monthly MODFLOW 6 Freyberg model (1 layer, 40 x 20, 25 stress periods, SFR, GHB, wells, per-period external
recharge and well files; github.com/gmdsi/GMDSI_notebooks, `models/monthly_model_files_1lyr_newstress`) is in the
workspace as `freyberg-mf6.zip`, with weekly heads at its two layer-1 truth bores as `freyberg-heads.csv` (from
`models/daily_freyberg_mf6_truth/obs_data.csv`). Uploaded as-is it solves in 0.14 s, opens in the Build palette with
only SFR kept as uploaded, and a save without edits writes every file back byte for byte. PEST++ GLM on K, Sy, recharge
and GHB conductance: RMSE 2.20 m to 0.16 m in 95 s on the app; calibrated K geometric mean 5.2 m/d against the truth
field's 6.1 (the model started at 11.1); GHB conductance reported as weakly constrained by these two bores.

## MODFLOW OS: the same model from agents, scripts and jobs

The Studio is one host of MODFLOW OS. The same code also runs as:

| Surface | Where | Identity |
|---|---|---|
| MCP server (34 tools) | `<app>/mcp`, streamable HTTP | the caller's workspace OAuth token, forwarded on-behalf-of |
| REST | `<app>/api/v1/*` (`runs`, `scenarios/resolve`, `cells/find`, `map`, `studies`) | as above |
| Job step | job `<app>-scenario-run` (`jobs/modflow_task.py`), serverless | the job's run-as identity |
| Studio agent | the Agent column in the app: Omnigent embedded in the app container (`app/omni_runtime.py`, `app/agent.py`) | the signed-in user (tools); the app's service principal (model calls via Unity AI Gateway) |
| Agent step | job `<app>-agent-step` (`jobs/agent_task.py`): prompt → managed Omnigent session on a Databricks Sandbox → MODFLOW tools | the job's run-as identity |

**The Studio agent.** The app starts the open-source Omnigent server and one host as local processes (loopback only)
and supervises them. The harnesses run in the container: Claude Agent SDK (driving the Claude Code CLI), Codex and Pi, all installed from
`app/package.json` (new Claude models need a recent Claude Code CLI, so it is pinned there rather than taken from the SDK), each offered only when its binary is present, with the chat models the workspace serves through
Unity AI Gateway. Each session's agent bundle points its MODFLOW MCP server at the app's own `/mcp` over loopback with a
per-session key; `AgentIdentity` in `app.py` swaps that key for the owning user's forwarded token, so tool calls read
under their Unity Catalog grants and file under their name (origin `mcp:omnigent/<harness>`). Ask / Auto / Read only are
Omnigent session policies. Threads live in Lakebase: the project install.sh creates (default branch, database
`databricks_postgres`, schema `omnigent`, created and owned by the app's service principal), attached to the app as a
`postgres` resource with CAN_CONNECT_AND_CREATE. `app/omni_lakebase.py` launches the Omnigent server with
`--database-uri` (no password) and plugs the Autoscaling credential call into Omnigent's per-connection token hook
(`set_lakebase_token_provider`; Omnigent's own default targets the retired Provisioned API), so tokens are minted as
connections open and pooled connections recycle every 10 minutes. The first start runs Omnigent's migrations (a few
minutes). Omnigent keeps agent bundles and attachments as local artifact files, so those (and the key-to-user map,
without tokens) are still snapshotted every minute to the private `agent_state` volume and restored on a fresh
container. The host runs with a fixed `OMNIGENT_HOST_ID`, so a thread from before a restart re-binds and continues
(tested). Without `PGHOST`/`LAKEBASE_ENDPOINT` (e.g. running locally) the server falls back to SQLite in the container. For a shared
multi-replica store, point `OMNIGENT_DATABASE_URI` at Lakebase Postgres instead. Ensembles outlive the agent's turn: the app
watches the jobs a thread started (`agent._watcher`) and, when all of them finish, posts a `[Studio]` message that wakes
the agent to read them and carry on; until then the thread shows as waiting. With Follow on, the model follows the
agent's tool calls: the overlay it reads (land use, reaches), the cells it found, the reaches or bores a run changes.

Dependencies: the app uses `pyproject.toml` + `uv.lock` (Python 3.12) with the Omnigent wheels vendored in `app/wheels/`
(built from github.com/omnigent-ai/omnigent with `SKIP_WEB_UI=1 deploy/databricks/build.sh`). The lock must reference
public PyPI; behind the internal proxy, lock normally and rewrite `pypi-proxy.dev.databricks.com/simple/` →
`pypi.org/simple` and `/packages/` → `files.pythonhosted.org/packages/` (same files, same hashes). `deploy.sh` refuses a
proxy lock. The jobs and sandbox install `app/engine-requirements.txt`.

**Any model, not only the district.** The agent (and any MCP client) can list the workspace's MODFLOW 6 packages,
inspect them, read any input file, build a new structured-grid model with FloPy from a plain description
(`build_model`: grid, layers, K, CHD edges, wells, recharge, rivers, drains, EVT, steady or transient), write one from
complete input files (`write_model`), change one file (`edit_model_file`), solve it as-is (`run_model`, with head probes
and MODFLOW's own error text on failure) and delete it. Packages land in the workspace volume as the user and open in the
explorer like uploads. `show_in_studio` lets the agent put a run, package, scenario, view, overlay, panel, bore, month,
section row or cells on the user's screen. The agent has no shell in the app container (Omnigent's sandbox needs
bubblewrap, which Apps does not provide, and an unsandboxed shell could read other users' tokens), so FloPy runs
server-side behind these tools instead.

**Scripting, figures and reports.** `run_python` runs the agent's Python in `<catalog>.<schema>.modflow_sandbox`,
a Unity Catalog Python function with STRICT ISOLATION on the serverless SQL warehouse (numpy, pandas, scipy, matplotlib,
FloPy, fpdf2, Pillow; `setup/02_sandbox.sql`). It runs as the user, has no file system, network or MODFLOW executable,
and shares nothing with the app or other users. The app gathers the inputs the script asks for (every month and cell of
a run, a package solved at every time, an upload, a query result) into a zip; what the script writes to `OUTPUTS` is
stored as the user in `workspace/artifacts/<user>/<time>-<title>/` and shown in the thread (figures inline, PDFs and
other files as links). There is no TeX in the sandbox: equations use matplotlib mathtext, reports are PDFs built with
fpdf2, and `.tex` sources can be written for the user to compile. `get_run_series` gives any filed run month by month;
`run_model` returns every output time of a package.

**Files for the agent.** Drop files on the agent (or use the paperclip): a MODFLOW 6 zip goes to `workspace/models`, a
scenario JSON to `workspace/scenarios`, anything else to `workspace/uploads/<user>/` (`list_uploads`, `read_upload`,
or `{"upload": name}` in a script's inputs). The message carries an `[Attached files]` list so the agent knows; attached
images also go into the message as `input_image` blocks (downscaled to 1568 px), so the model sees them natively.
`view_image` returns an MCP image, so the agent can look at uploads and check its own figures. The explorer's Files tab
lists the user's uploads and the agent's output folders; every row in the explorer has an "add to the current chat"
button. Both side panels resize by dragging their inner edge (`ui/src/lib/resize.ts`), and the detail inset (Section, Hydrograph, Budget, Ensemble, Changes) by its left edge (width) and bottom edge (height); its charts redraw to fit, sizes are remembered per browser, and a double-click on an edge resets it.

**Fidelity.** A scenario can carry `fidelity`: `refine` (split each 250 m cell into 2x2 ... 10x10, down to 25 m),
`sublayers` per aquifer (1-6), `nstp` time steps per month (1-31) and `solver` (fast 1e-2 m, standard 1e-3 m, tight
1e-5 m). `gwmodel.refine_inputs` builds the finer model from the same 250 m inputs (channels and drains are re-traced as
lines through their cells with conductance shared along them; bores sit in the centre sub-cell and middle sub-layer);
outputs are block-averaged back to 250 m for the Studio and the tables, with areas and medians taken at full resolution
and the full arrays available to scripts. The baseline is re-solved at the same fidelity, so a change is the
scenario's, not the grid's. The model was calibrated at 250 m, and grid refinement alone moves the headline numbers
(baseline area within 2 m 15.0% at 250 m, 12.8% at 125 m, 12.1% at 62.5 m, 11.8% at 31 m), so check sensitivity.
Set it in the explorer (DIS · Resolution and solver, with a live cell count and time estimate) or through the tools.

**Background tasks.** Runs finer than native (and any agent run estimated over ~40 s) run as background tasks in the
app (`/api/run?background=true`, `/api/tasks/{id}`, MCP `get_task`, `list_tasks`, `estimate_fidelity`): the Studio
shows solver progress in the title block, the agent gets a task id and is woken with the result when it finishes. The
app runs on LARGE compute for this. Tasks live in the app process, so a redeploy or restart loses unfinished ones; for
runs of many hours, use the scenario job step instead.

**Batches and attribution.** `run_batch` runs up to 60 scenarios in one call, in parallel, and returns one comparison
table; with `attribute`, one multi-edit scenario is split into its edits (each run alone from the same base) plus the
combination, and the change is shared out with the interaction reported. Agents used to do sweeps one call at a time and
could not say which edit caused what.

Scenarios are given as a **ScenarioSpec**: a base (`"base": "name@2"`, `"base_run_id"`, or nothing for the baseline) plus
edits (`set`, `paint` with cell selectors, `line_reaches`, `add_bores`, ...). Every run, from any surface, files into the
same Delta tables (`model_runs`, `run_cell_results`, `run_reach_seepage`, `run_bore_heads`, `run_water_budget`) with
`origin` and optional `study_id`; studies and findings live in `studies` and `study_findings`.

**Running the agent step as a service principal.** Give the service principal CAN_USE on the app, USE/SELECT on the
model's input tables, access to the workspace's Omnigent preview, then set the job's `run_as` to it. Upstream tasks
pass the prompt in, e.g. `prompt: "{{tasks.extract.values.prompt}}"`, and downstream tasks read
`{{tasks.agent.values.answer}}`. Use mode `auto` for unattended runs, or `read` for review-only agents.
