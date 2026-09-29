# Groundwater Studio

Groundwater Studio is a Databricks App for groundwater modelling. It runs the real USGS MODFLOW 6 (and
MODFLOW-2005, NWT and USG) against data in Unity Catalog, from a browser. With it you can:

- open your own models, edit them in a 3D view, and run scenarios in seconds;
- calibrate with PEST++;
- run Monte Carlo ensembles on serverless Spark;
- work with an optional AI agent that uses the same tools.

Every run is recorded in Delta tables and MLflow under the name of whoever ran it.

The bundled data is a **synthetic sample district**: a made-up irrigation area, placed nowhere, with invented farms
(`Farm 01 (synthetic)`), bores (`PB-`, `OB-`), licences (`SYN-WAL-`) and weather stations. It is there to show the
workflow and is not anyone's real data. Your own models go in through the app's **Open a model** (upload).

## Install

```
git clone https://github.com/noah-databricks/groundwater-studio.git
cd groundwater-studio
./install.sh --profile <your-cli-profile>
```

(Or download the ZIP from GitHub's Code button, unzip it, and run `./install.sh` in the folder.)

That's it. It takes about 10 minutes, most of it the app's first start. At the end it prints the app's URL.

**Before you run it:**
- **Databricks CLI:** install it (https://docs.databricks.com/dev-tools/cli/install) and sign in once:
  `databricks auth login --host https://<your-workspace-url> --profile <name>`.
- **Python:** 3.10 or newer on your machine. The installer makes its own virtual environment in `.install/`.
- **Workspace:** it needs Unity Catalog, Databricks Apps, a serverless SQL warehouse, and user authorization for apps
  (on-behalf-of-user access), which is on by default in current workspaces.
- **Optional:** Lakebase, which keeps agent threads across app restarts, and Foundation Model APIs / Unity AI Gateway
  chat models, which power the agent. The installer uses them when it finds them and skips them when it doesn't.
- **Permissions:** you need to be able to create a schema in the catalog you install into, create an app, and create
  jobs.

**Options:**

| Option | Default | |
|---|---|---|
| `--profile` | `DEFAULT` | Databricks CLI profile for the workspace |
| `--catalog` | the workspace default catalog | where the schema is created |
| `--schema` | `groundwater_studio` | |
| `--warehouse` | a serverless warehouse it finds | SQL warehouse id |
| `--app-name` | `groundwater-studio` | also the prefix of the jobs and the Lakebase project |
| `--share-with` | nobody else | a workspace group to give the app, tables and volumes to |
| `--stewards-group` | `groundwater_data_stewards` | the group that can see the masked landholder and licence columns |
| `--no-lakebase` | | keep agent threads in the app container instead |

Run it again at any time, for example to update to a newer release or to add `--share-with`. It updates what is there
and never deletes run records, uploaded models or scenarios.

## What it creates

| In the workspace | |
|---|---|
| Schema `<catalog>.groundwater_studio` | sample-district input tables (`aquifer_cells`, `boundary_cells`, `bores`, `bore_extractions_monthly`, `weather_monthly`, `bore_water_levels`), the run record tables (`model_runs`, `run_*`, `ensemble_*`, `scenario_versions`, `studies`, `study_findings`), a column mask and `modflow_sandbox`, the agent's Python sandbox (a Unity Catalog Python function) |
| Volumes | `workspace` (models, scenarios, uploads, agent outputs, all read and written as the signed-in user), `model_runs` (archived model files per run), `mf6_bin` (executables), `landing` (sample input files), `agent_state` |
| App `groundwater-studio` | the Studio, plus an MCP server at `<app-url>/mcp` and a REST API at `<app-url>/api/v1` |
| Jobs | `groundwater-studio-ensemble` (Monte Carlo on serverless Spark), `groundwater-studio-scenario-run` and `groundwater-studio-agent-step` (MODFLOW and the agent as steps in your own jobs) |
| MLflow experiment | `/Users/<you>/groundwater-studio` |
| Lakebase project | `groundwater-studio` (agent threads) |

Example models are placed in the `workspace` volume:
- `sample-district-baseline.zip`, the sample district as a plain MODFLOW 6 package;
- `pumping-test-3layer.zip`;
- `freyberg-mf6.zip`, the public Freyberg benchmark, with `freyberg-heads.csv` observations for trying PEST++.

## Who can see what

Reads of model inputs, and every file the Studio opens or saves, run **as the signed-in user**. Unity Catalog grants
and masks apply to each person. The app's own service principal can only write run records and read the executables.

To let a team in, rerun with `--share-with <group>`. That gives the group:
- use of the app;
- read access to the schema;
- read and write on the `workspace` volume;
- read on `model_runs`;
- use of the warehouse.

For finer control, grant per table or volume in Catalog Explorer instead.

## Using your own models

- **Upload.** Upload a zip of a MODFLOW 6 simulation (with `mfsim.nam`) or a classic MODFLOW-2005/NWT/USG model with
  its name file, up to 2 GB. It opens in 3D, runs as-is, and can be edited in the Build palette.
- **Classic models.** These run on their own engine, and 2005/NWT models convert to MODFLOW 6 in one click.
- **Placement.** Georeference (origin, rotation, EPSG) is read from the files or from a `modflow-os.json` sidecar.
- **Calibration.** Calibrate against observed heads from a CSV (columns `name, layer, row, col, time, head[, weight]`,
  with 1-based layer, row and column) with PEST++ GLM or IES. You get a calibrated copy back as a new package.

To replace the sample district's tables with your own district data, keep the column names in
`installer/sql/schema.sql`, or point the app at your own model packages instead.

## Updating and removing

- **Update:** unzip the new release over this folder and run `./install.sh` again with the same options.
- **Remove the app, jobs and experiment:** `databricks bundle destroy --profile <profile>
  --var=catalog=<catalog> --var=warehouse_id=<id>` from this folder.
- **Remove the data:** drop the schema (`DROP SCHEMA <catalog>.groundwater_studio CASCADE`) and delete the Lakebase
  project in the Lakebase UI. The installer never does this for you.

## Troubleshooting

- **The app shows "Unavailable" for a few minutes after install.** The first start installs its dependencies. Check
  the app's Logs tab in Compute > Apps.
- **"No serverless SQL warehouse found".** Create one, or pass `--warehouse <id>`.
- **No agent column.** No supported chat model is served in the workspace (Claude Sonnet/Opus or GPT-5 on Foundation
  Model APIs). Everything else works without it.
- **The app starts but reading data fails with a permission error.** The signed-in user needs `USE CATALOG` on the
  catalog and `USE SCHEMA` and `SELECT` on the schema (`--share-with` grants these).

## Folder layout

```
install.sh, installer/    the installer (and the SQL it runs, installer/sql/)
databricks.yml            the bundle: jobs and experiment; install.sh writes resources/app.yml for your workspace
app/                      FastAPI backend, MCP server, built front end (app/static/dist)
src/, jobs/               shared model code, the Spark ensemble and the job steps
ui/                       front-end source (React + three.js; npm install && npm run build writes app/static/dist)
engines/                  MODFLOW and PEST++ Linux executables (see engines/SOURCES.md)
data/, examples/          synthetic sample district inputs, example model packages
docs/TECHNICAL.md         how it works: identity model, build kit, calibration, agent, jobs
```
