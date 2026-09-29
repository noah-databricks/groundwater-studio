"""MODFLOW as a Lakeflow Jobs task.

Runs the same MODFLOW OS code the Studio serves (scenario specs, the mf6 engine, filing to Delta and MLflow), as the
job's identity, on serverless compute. Downstream tasks read the result from the task value `run` or from the Delta
tables by run_id.

Parameters
  --scenario  ScenarioSpec JSON, e.g. {"base": "rice-off-the-shallow-flats@2", "set": {"rain_mult": 0.8}}
  --label     Label for the run
  --study_id  Optional study to file the run against
"""
import argparse
import asyncio
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

p = argparse.ArgumentParser()
p.add_argument("--app_dir", required=True)
p.add_argument("--scenario", default="{}")
p.add_argument("--label", default="")
p.add_argument("--study_id", default="")
p.add_argument("--job_run_id", default="")
p.add_argument("--catalog", required=True)
p.add_argument("--schema", required=True)
p.add_argument("--warehouse_id", required=True)
p.add_argument("--experiment_id", default="")
a = p.parse_args()

os.environ.update(MODFLOW_OS_HOST="job", UC_CATALOG=a.catalog, UC_SCHEMA=a.schema, WAREHOUSE_ID=a.warehouse_id,
                  MLFLOW_EXPERIMENT_ID=a.experiment_id, STUDIO_WORKDIR="/tmp/modflow-os")
sys.path.insert(0, a.app_dir)
import app as mos  # noqa: E402

mos.WORK.mkdir(parents=True, exist_ok=True)
mos._install_mf6()
if not mos.state["mf6"]:
    raise SystemExit(f"MODFLOW executable unavailable: {mos.state['mf6_error']}")

request = SimpleNamespace(headers={"x-modflow-client": f"job:{a.job_run_id}" if a.job_run_id else "job"})
spec = mos.ScenarioSpec(**json.loads(a.scenario or "{}"))
scenario, ref, desc = mos.resolve_spec(request, spec)
print(f"Scenario: {desc}")
# serverless tasks run inside a live event loop, so the run gets a loop of its own
with ThreadPoolExecutor(1) as ex:
    payload = ex.submit(asyncio.run, mos.do_run(request, scenario, a.label or desc[:120], True, ref, a.study_id or None)).result()
mos.await_filed([payload["run_id"]], timeout=600)
filed = mos.runs[payload["run_id"]]
summary = mos.run_summary(payload) | {"description": desc, "scenario_ref": ref,
                                      "mlflow_run_id": filed.get("mlflow", {}).get("run_id"),
                                      "filed": {k: v.get("ok") for k, v in filed.items() if isinstance(v, dict)}}
print(json.dumps(summary, indent=1))
if not all(summary["filed"].values()):
    raise SystemExit(f"Run {payload['run_id']} simulated but was not fully filed: {filed}")
try:
    from databricks.sdk.runtime import dbutils
    dbutils.jobs.taskValues.set("run", summary)
    dbutils.jobs.taskValues.set("run_id", payload["run_id"])
except Exception as e:  # running outside a job
    print("task values not set:", e)
