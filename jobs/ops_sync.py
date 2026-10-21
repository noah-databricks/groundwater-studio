"""Lakeflow job step: refresh the Lakebase copies of the seasonal outlook and let the app read them.

Runs after the pipeline has rebuilt the gold outlook tables. Re-snapshots the two Lakebase synced tables
(<catalog>.<schema>.ops_outlook_bore_risk and ops_outlook_reach_seepage, which land in Postgres schema <schema>), then
grants the app's service principal SELECT on them, as the job's identity (the synced tables' owner).
"""
import argparse
import time

import psycopg
from databricks.sdk import WorkspaceClient

p = argparse.ArgumentParser()
p.add_argument("--catalog", required=True)
p.add_argument("--schema", required=True)
p.add_argument("--app_name", required=True)
p.add_argument("--project", default="", help="Lakebase project id; empty when the install has no Lakebase")
a = p.parse_args()

w = WorkspaceClient()
if not a.project:
    print("This install has no Lakebase project: nothing to sync")
    raise SystemExit(0)
TABLES = ("ops_outlook_bore_risk", "ops_outlook_reach_seepage")


def wait_pipeline(pid: str, update_id: str | None = None, timeout=1800):
    t0 = time.time()
    while time.time() - t0 < timeout:
        pl = w.pipelines.get(pid)
        if update_id:
            st = w.pipelines.get_update(pid, update_id).update.state.value
            if st in ("COMPLETED", "FAILED", "CANCELED"):
                return st
        elif pl.state and pl.state.value in ("IDLE", "FAILED"):
            return pl.state.value
        time.sleep(10)
    raise SystemExit(f"pipeline {pid} did not finish in {timeout} s")


for t in TABLES:
    name = f"{a.catalog}.{a.schema}.{t}"
    st = w.postgres.get_synced_table(f"synced_tables/{name}").status
    pid = st.pipeline_id
    wait_pipeline(pid)  # a sync can still be running from the install or a previous run
    update = w.pipelines.start_update(pid).update_id
    state = wait_pipeline(pid, update)
    print(f"{name}: snapshot {state}")
    if state != "COMPLETED":
        raise SystemExit(f"sync of {name} ended {state}")

sp = w.apps.get(a.app_name).service_principal_client_id
branch = w.postgres.get_project(f"projects/{a.project}").status.default_branch
ep = next(iter(w.postgres.list_endpoints(branch))).name
host = w.postgres.get_endpoint(ep).status.hosts.host
me = w.current_user.me()
role = me.user_name or me.application_id
with psycopg.connect(host=host, dbname="databricks_postgres", user=role, sslmode="require", autocommit=True,
                     password=w.postgres.generate_database_credential(endpoint=ep).token, connect_timeout=60) as c:
    for q in (f'GRANT USAGE ON SCHEMA "{a.schema}" TO "{sp}"',
              f'GRANT SELECT ON ALL TABLES IN SCHEMA "{a.schema}" TO "{sp}"',
              f'ALTER DEFAULT PRIVILEGES IN SCHEMA "{a.schema}" GRANT SELECT ON TABLES TO "{sp}"'):
        c.execute(q)
    rows = {t: c.execute(f'SELECT count(*) FROM "{a.schema}"."{t}"').fetchone()[0] for t in TABLES}
print(f"granted {a.app_name} ({sp}) SELECT on {a.schema}.*; rows {rows}")
