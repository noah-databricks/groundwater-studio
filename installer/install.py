"""Install Groundwater Studio into a Databricks workspace. Run through ../install.sh.

Creates (or reuses) the schema, volumes and tables, uploads the MODFLOW engines, sample data and example models,
creates the Lakebase project for agent threads, writes the workspace-specific app config, then deploys the bundle and
starts the app. Safe to run again: it updates what is there and never drops run records or uploaded files.
"""
import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile
import time
from pathlib import Path

from databricks.sdk import WorkspaceClient
from databricks.sdk.errors import NotFound, ResourceDoesNotExist

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
ENGINES = ROOT / "engines"
MODELS = {"claude": re.compile(r"^databricks-claude-(sonnet|opus)-[\d-]+$"), "gpt": re.compile(r"^databricks-gpt-5[\d-]*$")}


def say(msg):
    print(f"  {msg}", flush=True)


def step(msg):
    print(f"\n> {msg}", flush=True)


p = argparse.ArgumentParser(description="Install Groundwater Studio into a Databricks workspace.")
p.add_argument("--profile", default=None, help="Databricks CLI profile (default: DEFAULT)")
p.add_argument("--catalog", default=None, help="Catalog for the schema (default: the workspace's default catalog)")
p.add_argument("--schema", default="groundwater_studio")
p.add_argument("--warehouse", default=None, help="SQL warehouse id (default: a serverless warehouse in the workspace)")
p.add_argument("--app-name", default="groundwater-studio")
p.add_argument("--share-with", default=None, help="Workspace group to give access to (app, tables, volumes)")
p.add_argument("--stewards-group", default="groundwater_data_stewards",
               help="Group that can see the masked landholder and licence columns")
p.add_argument("--no-lakebase", action="store_true", help="Keep agent threads in the app container instead of Lakebase")
a = p.parse_args()

w = WorkspaceClient(profile=a.profile)
me = w.current_user.me().user_name
print(f"Installing Groundwater Studio into {w.config.host} as {me}")

# ---- warehouse -------------------------------------------------------------------------------------------------
step("SQL warehouse")
if a.warehouse:
    wh = w.warehouses.get(a.warehouse)
else:
    whs = [x for x in w.warehouses.list() if x.enable_serverless_compute]
    if not whs:
        sys.exit("No serverless SQL warehouse found. Create one (SQL > SQL warehouses) or pass --warehouse <id>.")
    whs.sort(key=lambda x: (str(x.state) != "State.RUNNING", x.name))
    wh = whs[0]
if not wh.enable_serverless_compute:
    say("warning: this warehouse is not serverless; the agent's Python sandbox needs a serverless warehouse")
say(f"{wh.name} ({wh.id})")


def sql(stmt, quiet=False):
    r = w.statement_execution.execute_statement(statement=stmt, warehouse_id=wh.id, wait_timeout="50s")
    while r.status.state.value in ("PENDING", "RUNNING"):
        time.sleep(2)
        r = w.statement_execution.get_statement(r.statement_id)
    if r.status.state.value != "SUCCEEDED":
        raise RuntimeError(f"{' '.join(stmt.split())[:160]}\n  -> {r.status.error.message[:800]}")
    return (r.result.data_array or []) if r.result else []


def statements(text):
    """Split a SQL file on ; at line ends, keeping $$ ... $$ function bodies whole."""
    out, cur, in_body = [], [], False
    for line in text.splitlines():
        if not in_body and line.strip().startswith("--"):
            continue
        cur.append(line)
        if line.count("$$") % 2:
            in_body = not in_body
        if not in_body and line.rstrip().endswith(";"):
            s = "\n".join(cur).strip().rstrip(";")
            if s:
                out.append(s)
            cur = []
    return out


# ---- catalog, schema, volumes ------------------------------------------------------------------------------------
step("Unity Catalog schema and volumes")
catalog = a.catalog or sql("SELECT current_catalog()")[0][0]
if catalog in ("hive_metastore", "spark_catalog", None):
    sys.exit("The workspace has no Unity Catalog default catalog. Pass --catalog <name>.")
S = f"`{catalog}`.`{a.schema}`"
V = f"/Volumes/{catalog}/{a.schema}"
sql(f"CREATE SCHEMA IF NOT EXISTS {S} COMMENT 'Groundwater Studio: MODFLOW model inputs, run records and files'")
VOLUMES = {"landing": "Sample-district input files the tables are loaded from",
           "mf6_bin": "MODFLOW, PEST++ executables and the MODFLOW OS package for sandboxes and job steps",
           "model_runs": "Archived model files of every filed run",
           "workspace": "Uploaded models, scenarios, builds, zones and agent outputs (read and written as the user)",
           "agent_state": "Agent bundles and attachments, snapshotted by the app"}
for v, c in VOLUMES.items():
    sql(f"CREATE VOLUME IF NOT EXISTS {S}.`{v}` COMMENT '{c}'")
say(f"{catalog}.{a.schema} with volumes {', '.join(VOLUMES)}")


def upload(local: Path, remote: str, skip_same_size=True):
    if skip_same_size:
        try:
            if w.files.get_metadata(remote).content_length == local.stat().st_size:
                return False
        except (NotFound, ResourceDoesNotExist):
            pass
    with open(local, "rb") as f:
        w.files.upload(remote, f, overwrite=True)
    return True


def exists(remote):
    try:
        w.files.get_metadata(remote)
        return True
    except (NotFound, ResourceDoesNotExist):
        return False


# ---- engines, data, examples -------------------------------------------------------------------------------------
step("MODFLOW and PEST++ executables")
n = 0
for f in sorted(x for x in ENGINES.rglob("*") if x.is_file() and x.name != "SOURCES.md"):
    n += upload(f, f"{V}/mf6_bin/{f.relative_to(ENGINES).as_posix()}")
say(f"{n} uploaded, the rest already there")

step("Sample district data and example models")
for f in sorted((ROOT / "data").glob("*.parquet")):
    upload(f, f"{V}/landing/{f.name}", skip_same_size=False)
slug = "".join(ch if ch.isalnum() else "-" for ch in me.split("@")[0]).strip("-") or "user"
for f in sorted((ROOT / "examples").glob("*.zip")) + sorted((ROOT / "examples").glob("*.csv")):
    dest = f"{V}/workspace/uploads/{slug}/{f.name}" if f.suffix == ".csv" else f"{V}/workspace/models/{f.name}"
    if not exists(dest):  # never overwrite a model someone has since edited
        upload(f, dest, skip_same_size=False)
say("sample district in landing/, example models in workspace/models/")

step("Tables, column masks and the agent's Python sandbox")
for name in ("schema.sql", "sandbox.sql"):
    text = (ROOT / "installer" / "sql" / name).read_text()
    text = text.replace("{S}", S).replace("{V}", V).replace("{STEWARDS}", a.stewards_group)
    for s in statements(text):
        sql(s)
rows = sql(f"SELECT count(*) FROM {S}.aquifer_cells")
say(f"inputs loaded ({rows[0][0]} grid cells), output tables ready, {S}.modflow_sandbox created")

# ---- Lakebase (agent threads) ------------------------------------------------------------------------------------
pg = None
if not a.no_lakebase:
    step("Lakebase project for agent threads")
    pid = re.sub(r"[^a-z0-9-]", "-", a.app_name.lower()).strip("-")[:63]
    try:
        try:
            w.postgres.get_project(f"projects/{pid}")
            say(f"reusing projects/{pid}")
        except (NotFound, ResourceDoesNotExist):
            from databricks.sdk.service.postgres import Project, ProjectSpec
            say(f"creating projects/{pid} (a minute or two)")
            w.postgres.create_project(project=Project(spec=ProjectSpec(display_name="Groundwater Studio agent threads")),
                                      project_id=pid).wait()
        proj = w.postgres.get_project(f"projects/{pid}")
        branch = proj.status.default_branch
        db = next(iter(w.postgres.list_databases(branch))).name
        ep = next(iter(w.postgres.list_endpoints(branch))).name
        pg = {"branch": branch, "database": db, "endpoint": ep}
        say(f"{branch}")
    except Exception as e:  # Lakebase not enabled or not in this region: the app keeps threads in its container
        say(f"Lakebase unavailable ({str(e).splitlines()[0][:160]}); agent threads will live in the app container")

# ---- served models for the agent ---------------------------------------------------------------------------------
step("Chat models for the agent (Unity AI Gateway)")
eps = [e.name for e in w.serving_endpoints.list()
       if "chat" in (e.task or "").lower() and any(r.match(e.name) for r in MODELS.values())]
eps = sorted(eps, key=lambda n: [(0, int(x), "") if x.isdigit() else (1, 0, x) for x in n.split("-")], reverse=True)
# an app takes at most 20 resources: the newest of each family (others still show if the app can query them)
pick = [e for fam in ("sonnet", "opus", "gpt") for e in [x for x in eps if f"-{fam}-" in x][:1]]
say(", ".join(pick) if pick else "none found: the agent column stays hidden until a chat model is served")

# ---- app config ----------------------------------------------------------------------------------------------------
step("App configuration")
env = [{"name": "WAREHOUSE_ID", "valueFrom": "sql-warehouse"},
       {"name": "ENSEMBLE_JOB_ID", "valueFrom": "ensemble-job"},
       {"name": "SCENARIO_JOB_ID", "valueFrom": "scenario-job"},
       {"name": "MLFLOW_EXPERIMENT_ID", "valueFrom": "experiment"},
       {"name": "UC_CATALOG", "value": catalog},
       {"name": "UC_SCHEMA", "value": a.schema}]
if pg:
    env.append({"name": "LAKEBASE_ENDPOINT", "value": pg["endpoint"]})
(APP / "app.yaml").write_text(json.dumps({"command": ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"],
                                          "env": env}, indent=2) + "\n")

T = f"{catalog}.{a.schema}"
res = [{"name": "sql-warehouse", "sql_warehouse": {"id": "${var.warehouse_id}", "permission": "CAN_USE"}},
       {"name": "ensemble-job", "job": {"id": "${resources.jobs.modflow_ensemble.id}", "permission": "CAN_MANAGE_RUN"}},
       {"name": "scenario-job", "job": {"id": "${resources.jobs.modflow_scenario.id}", "permission": "CAN_MANAGE_RUN"}},
       {"name": "experiment", "experiment": {"experiment_id": "${resources.experiments.studio.id}", "permission": "CAN_EDIT"}},
       {"name": "mf6-bin", "uc_securable": {"securable_full_name": f"{T}.mf6_bin", "securable_type": "VOLUME", "permission": "READ_VOLUME"}},
       {"name": "model-runs-volume", "uc_securable": {"securable_full_name": f"{T}.model_runs", "securable_type": "VOLUME", "permission": "WRITE_VOLUME"}},
       {"name": "agent-state-volume", "uc_securable": {"securable_full_name": f"{T}.agent_state", "securable_type": "VOLUME", "permission": "WRITE_VOLUME"}}]
for t in ("model_runs", "run_bore_heads", "run_water_budget", "scenario_versions", "run_cell_results", "run_reach_seepage",
          "studies", "study_findings"):
    res.append({"name": f"{t.replace('_', '-')}-table",
                "uc_securable": {"securable_full_name": f"{T}.{t}", "securable_type": "TABLE", "permission": "MODIFY"}})
if pg:
    res.append({"name": "agent-db", "postgres": {"branch": pg["branch"], "database": pg["database"],
                                                 "permission": "CAN_CONNECT_AND_CREATE"}})
for i, m in enumerate(pick):
    res.append({"name": f"model-{i + 1}", "serving_endpoint": {"name": m, "permission": "CAN_QUERY"}})
app_res = {"name": "${var.app_name}",
           "description": "Groundwater Studio: MODFLOW 6 scenarios, calibration and uncertainty ensembles on Unity Catalog data",
           "source_code_path": "../app", "compute_size": "LARGE",
           "user_api_scopes": ["sql", "files.files"], "resources": res}
if a.share_with:
    app_res["permissions"] = [{"group_name": a.share_with, "level": "CAN_USE"}]
(ROOT / "resources").mkdir(exist_ok=True)
(ROOT / "resources" / "app.yml").write_text(
    "# Written by install.sh for this workspace; rerun it rather than editing by hand.\n"
    + json.dumps({"resources": {"apps": {"groundwater_studio": app_res}}}, indent=2) + "\n")
say("app/app.yaml and resources/app.yml written")

# ---- MODFLOW OS package for sandboxes and job steps --------------------------------------------------------------
step("MODFLOW OS package (for agent sandboxes and job steps)")
files = sorted(f for f in APP.rglob("*") if f.is_file() and not {"static", "__pycache__", "wheels", "node_modules"} & set(f.parts)
               and f.name not in ("os_package.json", "os_tools.json", "uv.lock", "package.json", "package-lock.json"))
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as tar:
    for f in files:
        tar.add(f, arcname=str(f.relative_to(APP)))
key = hashlib.sha1(b"".join(f.read_bytes() for f in files)).hexdigest()[:12]
pkg_path = f"{V}/mf6_bin/modflow-os/app-{key}.tar.gz"
w.files.upload(pkg_path, io.BytesIO(buf.getvalue()), overwrite=True)
tools = json.loads((APP / "os_tools.json").read_text())


def write_package(ids):
    (APP / "os_package.json").write_text(json.dumps({
        "package": pkg_path, "key": key, "instructions": tools["instructions"], "tools": tools["tools"],
        "requirements": [l.strip() for l in (APP / "engine-requirements.txt").read_text().splitlines() if l.strip()],
        "env": {"UC_CATALOG": catalog, "UC_SCHEMA": a.schema, "WAREHOUSE_ID": wh.id, **ids}}))


write_package({"MLFLOW_EXPERIMENT_ID": "", "ENSEMBLE_JOB_ID": "0", "SCENARIO_JOB_ID": "0"})
say(pkg_path)

# ---- deploy ----------------------------------------------------------------------------------------------------------
cli = ["databricks"] + (["--profile", a.profile] if a.profile else [])
bvars = [f"--var=catalog={catalog}", f"--var=schema={a.schema}", f"--var=warehouse_id={wh.id}", f"--var=app_name={a.app_name}"]


def bundle(*args, capture=False):
    r = subprocess.run(cli[:1] + ["bundle", *args] + cli[1:] + bvars, cwd=ROOT, text=True,
                       capture_output=capture)
    if r.returncode:
        sys.exit(f"databricks bundle {args[0]} failed" + (f":\n{r.stderr[-3000:]}" if capture else ""))
    return r.stdout


step("Deploying the bundle (jobs, experiment, app)")
bundle("deploy")
summary = json.loads(bundle("summary", "-o", "json", capture=True))["resources"]
ids = {"ENSEMBLE_JOB_ID": str(summary["jobs"]["modflow_ensemble"]["id"]),
       "SCENARIO_JOB_ID": str(summary["jobs"]["modflow_scenario"]["id"]),
       "MLFLOW_EXPERIMENT_ID": str(summary["experiments"]["studio"]["id"])}
write_package(ids)
bundle("deploy")

# ---- access ----------------------------------------------------------------------------------------------------------
if a.share_with:
    step(f"Access for {a.share_with}")
    g = f"`{a.share_with}`"
    for stmt in (f"GRANT USE CATALOG ON CATALOG `{catalog}` TO {g}",
                 f"GRANT USE SCHEMA, SELECT, EXECUTE ON SCHEMA {S} TO {g}",
                 f"GRANT READ VOLUME ON VOLUME {S}.`model_runs` TO {g}",
                 f"GRANT READ VOLUME, WRITE VOLUME ON VOLUME {S}.`workspace` TO {g}"):
        try:
            sql(stmt)
        except RuntimeError as e:
            say(f"could not run: {stmt}\n    {str(e).splitlines()[-1][:200]}")
    try:
        from databricks.sdk.service.sql import WarehouseAccessControlRequest, WarehousePermissionLevel
        w.warehouses.update_permissions(wh.id, access_control_list=[WarehouseAccessControlRequest(
            group_name=a.share_with, permission_level=WarehousePermissionLevel.CAN_USE)])
    except Exception as e:
        say(f"could not give {a.share_with} CAN_USE on the warehouse: {str(e)[:160]}")
    say("done")

step("Starting the app (the first start installs its dependencies: 3 to 6 minutes)")
bundle("run", "groundwater_studio")
url = w.apps.get(a.app_name).url
print(f"""
Groundwater Studio is running:

  {url}

Data:    {catalog}.{a.schema} (synthetic sample district, run records, volumes)
Models:  workspace/models has the sample district, a 3-layer pumping test and the public Freyberg benchmark
Agent:   {", ".join(pick) or "no chat models served"}; threads in {"Lakebase " + pg["branch"] if pg else "the app container"}
""")
if not a.share_with:
    print("Only you can use it so far. To add your team, rerun with --share-with <group>.")
