"""Run the Groundwater Studio data journey on an install and record what happened as text, in evidence/.

    .venv/bin/python packaging/collect_evidence.py --profile <cli-profile> --catalog <catalog> --schema <schema> \
        --app-name <app> [--install-log path] [--out evidence]

Steps: the pipeline's update and expectation results, every table (type, comment, row count, columns, the column mask),
a REST scenario run, an MCP session (tools/list, describe_model, an ensemble on serverless Spark), MLflow runs, an
in-app agent study that asks Genie first, a new telemetry file that triggers the outlook job (ingest -> season runs ->
gold -> Lakebase -> agent briefing), the Lakebase tables and a field note written through the app, and the Genie Agent's
benchmarks. Workspace hosts and IDs, emails, user names and tokens are replaced with placeholders before anything is
written.
"""
import argparse
import csv
import io
import json
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from databricks.sdk import WorkspaceClient

p = argparse.ArgumentParser()
p.add_argument("--profile", required=True)
p.add_argument("--catalog", required=True)
p.add_argument("--schema", required=True)
p.add_argument("--app-name", required=True)
p.add_argument("--install-log", default=None)
p.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "evidence"))
p.add_argument("--skip", default="", help="comma list of steps to skip: agent,outlook,ensemble,genie")
p.add_argument("--no-drop", action="store_true", help="do not drop a new telemetry file; use the outlook run the last one triggered")
p.add_argument("--start-at", default="", help="resume: mlflow (keeps files already written and the outlook run already triggered)")
a = p.parse_args()
SKIP = set(filter(None, a.skip.split(",")))
OUT = Path(a.out)
OUT.mkdir(parents=True, exist_ok=True)

w = WorkspaceClient(profile=a.profile)
me = w.current_user.me()
HOST = w.config.host.rstrip("/")
WSID = str(w.get_workspace_id())
app = w.apps.get(a.app_name)
APP_URL = app.url.rstrip("/")
FQ, S, V = f"{a.catalog}.{a.schema}", f"`{a.catalog}`.`{a.schema}`", f"/Volumes/{a.catalog}/{a.schema}"
WH = None
STARTED = datetime.now(timezone.utc)

# ---- scrubbing ----------------------------------------------------------------------------------------------------
user = me.user_name or ""
local = user.split("@")[0]
SUBS = [(HOST, "https://<workspace>"), (APP_URL, "https://<app>"), (app.url.split("//")[1].split("/")[0], "<app>"),
        (HOST.split("//")[1], "<workspace>"), (WSID, "<workspace-id>"), (a.catalog, "<catalog>"),
        (user, "<user>"), (local, "<user>"), (local.replace(".", "-"), "<user>"), (local.replace(".", " "), "<user>"),
        (local.replace(".", "_"), "<user>")]
if me.display_name:
    SUBS.append((me.display_name, "<user>"))
for r in app.resources or []:  # warehouse, job and endpoint ids the app is bound to
    for v in (r.sql_warehouse.id if r.sql_warehouse else None, r.job.id if r.job else None):
        if v:
            SUBS.append((str(v), "<id>"))
SUBS.append((HOST.split("//")[1].split(".")[0], "<workspace>"))  # the workspace's own host label
RX = [(re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "<email>"), (re.compile(r"\b(dapi|dkea|dose)[0-9a-f]{20,}\b"), "<token>"),
      (re.compile(r"\beyJ[\w-]{20,}\.[\w-]{10,}\.[\w-]{10,}"), "<token>"), (re.compile(r"(?<![\d.])\d{13,19}(?![\d.])"), "<id>"),
      (re.compile(r"\bep-[a-z0-9-]{8,}[\w.-]*"), "<lakebase-endpoint>"),
      (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"), "<uuid>"),
      ]


def scrub(text: str) -> str:
    for old, new in sorted((s for s in SUBS if s[0]), key=lambda s: -len(s[0])):
        text = text.replace(old, new)
    for rx, new in RX:
        text = rx.sub(new, text)
    return text


def write(name: str, content):
    if not isinstance(content, str):
        content = json.dumps(content, indent=2, default=str)
        content = re.sub(r'(?<![\w".])(\d{13,19})(?![\w".])', r'"\1"', content)  # bare ids become strings, so placeholders stay valid JSON
    (OUT / name).write_text(scrub(content).rstrip() + "\n")
    print(f"  wrote evidence/{name}", flush=True)


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


# ---- clients ------------------------------------------------------------------------------------------------------
def token() -> str:
    return json.loads(subprocess.check_output(["databricks", "auth", "token", "--profile", a.profile]))["access_token"]


def appc() -> httpx.Client:
    return httpx.Client(base_url=APP_URL, headers={"Authorization": f"Bearer {token()}"}, timeout=180)


def sql(q: str):
    global WH
    if WH is None:  # the install's own warehouse, from the app's resources
        WH = next(r.sql_warehouse.id for r in (app.resources or []) if r.sql_warehouse)
    r = w.statement_execution.execute_statement(statement=q, warehouse_id=WH, wait_timeout="50s")
    while r.status.state.value in ("PENDING", "RUNNING"):
        time.sleep(2)
        r = w.statement_execution.get_statement(r.statement_id)
    if r.status.state.value != "SUCCEEDED":
        raise RuntimeError(f"{q[:120]} -> {r.status.error.message[:400]}")
    cols = [c.name for c in r.manifest.schema.columns] if r.manifest and r.manifest.schema else []
    rows = list(r.result.data_array or []) if r.result else []
    ch = r.result.next_chunk_index if r.result else None
    while ch:
        c = w.statement_execution.get_statement_result_chunk_n(r.statement_id, ch)
        rows += c.data_array or []
        ch = c.next_chunk_index
    return cols, rows


def md_table(cols, rows, limit=40) -> str:
    out = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    out += ["| " + " | ".join("" if v is None else str(v).replace("|", "/").replace("\n", " ") for v in r) + " |" for r in rows[:limit]]
    if len(rows) > limit:
        out.append(f"\n({len(rows)} rows, first {limit} shown)")
    return "\n".join(out)


def mcp(method: str, params: dict | None = None, rid=[0]):
    rid[0] += 1
    r = appc().post("/mcp", json={"jsonrpc": "2.0", "id": rid[0], "method": method, "params": params or {}},
                    headers={"Accept": "application/json, text/event-stream", "X-Modflow-Client": "evidence"})
    r.raise_for_status()
    return r.json()


def tool(name: str, args: dict):
    res = mcp("tools/call", {"name": name, "arguments": args})["result"]
    if res.get("structuredContent") is not None:
        sc = res["structuredContent"]
        return sc.get("result", sc) if isinstance(sc, dict) and set(sc) == {"result"} else sc
    txt = "".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
    try:
        return json.loads(txt)
    except Exception:
        return txt


summary = json.loads((OUT / "summary.json").read_text()) if a.start_at and (OUT / "summary.json").exists() else {}
print(f"Collecting evidence from {a.app_name} into {OUT}", flush=True)

RESUME = a.start_at == 'mlflow'
NODROP = a.no_drop or RESUME
outlook_job = next((j for j in w.jobs.list(name=f"{a.app_name}-seasonal-outlook")), None)
dropped = None
if not RESUME:
    # ---- 0. install log -------------------------------------------------------------------------------------------------
    if a.install_log and Path(a.install_log).exists():
        write("install.log", Path(a.install_log).read_text())

    # ---- 1. outlook trigger: drop a new telemetry file now, collect the run at the end ---------------------------------
    outlook_job = next((j for j in w.jobs.list(name=f"{a.app_name}-seasonal-outlook")), None)
    dropped = None
    if "outlook" not in SKIP and outlook_job and not NODROP:
        cols, rows = sql(f"SELECT bore_id, max_by(water_level_mahd, obs_date), max_by(depth_to_water_m, obs_date) "
                         f"FROM {S}.bore_water_levels GROUP BY bore_id ORDER BY bore_id")
        buf = io.StringIO()
        wr = csv.writer(buf)
        wr.writerow(["bore_id", "reading_time", "water_level_mahd", "depth_to_water_m", "method"])
        for b, lv, d in rows:
            wr.writerow([b, "2026-07-14T08:00:00", round(float(lv) + 0.05, 3), round(float(d) - 0.05, 3), "logger"])
        wr.writerow(["OB-07", "2026-07-14T09:00:00", -9999.0, "", "logger"])  # a logger fault, for the expectation to drop
        dropped = f"{V}/landing/telemetry/bore_levels/levels_2026-07_{datetime.now(timezone.utc):%Y%m%dT%H%M}.csv"
        w.files.upload(dropped, io.BytesIO(buf.getvalue().encode()), overwrite=True)
        drop_time = time.time()
        print(f"  dropped {dropped} ({len(rows) + 1} readings); the outlook job should trigger on file arrival", flush=True)

    # ---- 2. pipeline: updates, row counts, expectations ---------------------------------------------------------------
    pipe = next(x for x in w.pipelines.list_pipelines(filter=f"name LIKE '{a.app_name}-district-ingest'"))
    pid = pipe.pipeline_id
    updates = [u.as_dict() for u in (w.pipelines.list_updates(pid, max_results=10).updates or [])]
    _, dq = sql(f"""SELECT origin.flow_name, timestamp,
      details:flow_progress.metrics.num_output_rows AS output_rows,
      details:flow_progress.data_quality.dropped_records AS dropped,
      details:flow_progress.data_quality.expectations AS expectations
    FROM event_log('{pid}')
    WHERE event_type = 'flow_progress' AND details:flow_progress.status = 'COMPLETED'
    ORDER BY timestamp DESC LIMIT 60""")
    seen, flows = set(), []
    for name, ts, out_rows, dropped_n, exp in dq:
        if name in seen:
            continue
        seen.add(name)
        flows.append({"flow": name, "completed": ts, "output_rows": out_rows, "dropped_records": dropped_n,
                      "expectations": json.loads(exp) if exp else None})
    write("pipeline_update.json", {"pipeline": pipe.name, "updates": [{k: u.get(k) for k in ("update_id", "state", "cause", "creation_time")}
                                                                     for u in updates],
                                   "latest_flow_results": flows})
    summary["pipeline"] = {"flows": len(flows), "dropped": sum(int(f["dropped_records"] or 0) for f in flows)}

    # ---- 3. tables -------------------------------------------------------------------------------------------------------
    lines = [f"# Unity Catalog objects in `{FQ}`", "", f"Collected {stamp()}.", ""]
    for t in sorted(w.tables.list(a.catalog, a.schema), key=lambda x: x.name):
        if t.name.startswith("__") or t.name.startswith("event_log"):
            continue
        try:
            n = sql(f"SELECT count(*) FROM {S}.`{t.name}`")[1][0][0]
        except Exception as e:
            n = f"(not readable: {str(e)[:80]})"
        lines += [f"## {t.name}", "", f"- type: {t.table_type.value if t.table_type else '?'}", f"- rows: {n}",
                  f"- comment: {t.comment or ''}",
                  "- columns: " + ", ".join(f"{c.name} {c.type_text}" + (" (masked)" if c.mask else "") for c in (t.columns or [])), ""]
    cols, rows = sql(f"SELECT bore_id, bore_type, landholder, licence_no FROM {S}.bores WHERE bore_type = 'production' ORDER BY bore_id LIMIT 3")
    lines += ["## Column mask, read as a user outside the data stewards group", "", md_table(cols, rows), ""]
    write("tables.md", "\n".join(lines))

    # ---- 4. REST: a scenario run -------------------------------------------------------------------------------------------
    c = appc()
    base = c.post("/api/v1/runs", json={"scenario": {}, "label": "Evidence: calibrated baseline"}).json()
    lined = c.post("/api/v1/runs", json={"scenario": {"line_reaches": ["MC-05"]}, "label": "Evidence: line MC-05"}).json()
    write("scenario_run.json", {"request": "POST /api/v1/runs  {\"scenario\": {\"line_reaches\": [\"MC-05\"]}, \"label\": \"Evidence: line MC-05\"}",
                                "baseline": base, "line_mc05": lined})
    summary["scenario"] = {"area_within_2m_pct": lined.get("kpis", {}).get("area_dtw_lt_2m_pct"),
                           "canal_seepage_gl": lined.get("kpis", {}).get("canal_seepage_gl")}

    # ---- 5. MCP: tools/list, describe_model, an ensemble ---------------------------------------------------------------
    init = mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "evidence", "version": "1"}})
    tl = mcp("tools/list")["result"]["tools"]
    dm = tool("describe_model", {})
    mcp_lines = [f"MCP session against https://<app>/mcp, {stamp()}", "", f"initialize -> server {init['result']['serverInfo']}",
                 f"tools/list -> {len(tl)} tools:", "  " + ", ".join(t["name"] for t in tl), "",
                 "tools/call describe_model ->", json.dumps(dm, indent=1, default=str)[:4000]]
    ens_out = None
    if "ensemble" not in SKIP:
        st = tool("start_ensemble", {"scenario": {"line_reaches": ["MC-05"]}, "n": 32, "label": "Evidence: line MC-05 under uncertainty"})
        mcp_lines += ["", "tools/call start_ensemble {scenario: line MC-05, n: 32} ->", json.dumps(st, indent=1, default=str)[:1500]]
        eid = st.get("ensemble_id") if isinstance(st, dict) else None
        t0 = time.time()
        while eid and time.time() - t0 < 1500:
            time.sleep(20)
            ens_out = tool("get_ensemble", {"ensemble_id": eid})
            if isinstance(ens_out, dict) and str(ens_out.get("status", "")).lower() in ("finished", "succeeded", "failed", "error"):
                break
        write("ensemble.json", {"ensemble_id": eid, "started_via": "MCP tools/call start_ensemble", "result": ens_out})
        if isinstance(ens_out, dict):
            summary["ensemble"] = {k: ens_out.get(k) for k in ("status", "n_ok", "n_behavioural", "runtime_s")}
    write("mcp_session.txt", "\n".join(mcp_lines))

if NODROP:  # the outlook run the earlier drop triggered
    last = next((r for r in w.jobs.list_runs(job_id=outlook_job.job_id, limit=5) if r.trigger and r.trigger.value == "FILE_ARRIVAL"), None)
    drop_time = last.start_time / 1000 if last else time.time()
    files = sorted((f for f in w.files.list_directory_contents(f"{V}/landing/telemetry/bore_levels/") if "levels_2026-07_" in f.path),
                   key=lambda f: f.last_modified or 0)
    dropped = files[-1].path if files else None

# ---- 6. MLflow ----------------------------------------------------------------------------------------------------------
exp = w.experiments.get_by_name(f"/Users/{user}/{a.app_name}").experiment
import itertools
runs = list(itertools.islice(w.experiments.search_runs(experiment_ids=[exp.experiment_id], max_results=60), 60))
buf = io.StringIO()
wr = csv.writer(buf)
keys_p = ["label", "origin", "rain_mult", "deep_drainage_frac", "pumping_mult", "lined_reaches"]
keys_m = ["pct_area_dtw_lt_2m_final", "pct_area_dtw_lt_2m_peak", "canal_seepage_ml", "bore_extraction_ml", "rmse_m"]
wr.writerow(["run_name", "start_time"] + keys_p + keys_m)
for r in runs:
    pp = {x.key: x.value for x in (r.data.params or [])}
    mm = {x.key: x.value for x in (r.data.metrics or [])}
    wr.writerow([r.info.run_name, datetime.fromtimestamp(r.info.start_time / 1000, timezone.utc).isoformat()]
                + [pp.get(k, "") for k in keys_p] + [mm.get(k, "") for k in keys_m])
write("mlflow_runs.csv", buf.getvalue())
summary["mlflow_runs"] = len(runs)

# ---- 7. an in-app agent study that asks Genie first -------------------------------------------------------------------
if "agent" not in SKIP:
    c = appc()
    opts = c.get("/api/agent/options").json()
    h = next(x for x in opts["harnesses"] if x["id"] == "claude-sdk")
    model = next((m for pref in ("claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-sonnet-5")
                  for m in h["models"] if m.endswith(pref)), h["default_model"])
    prompt = ("Before running anything, ask Genie which filed runs have already tested lining MC-05 and what they found. "
              "Then test whether lining MC-03 as well as MC-05 beats lining MC-05 alone: open a study called "
              "'Lining MC-03 with MC-05', run both scenarios filed against it, record one finding that cites both runs "
              "and quotes the SQL Genie used, and conclude the study. Keep it short; no figures or PDF.")
    sid = c.post("/api/agent/sessions", json={"harness": "claude-sdk", "model": model, "mode": "auto", "message": prompt}).json()["session_id"]
    t0, snap, busy = time.time(), {}, False
    while time.time() - t0 < 1500:
        time.sleep(15)
        snap = appc().get(f"/api/agent/sessions/{sid}").json()
        busy |= snap.get("status") in ("running", "waiting")
        if (busy and snap.get("status") == "idle") or snap.get("status") == "failed" or snap.get("last_task_error"):
            break
    items = snap.get("items") or []
    calls = {}
    md = [f"# In-app agent study ({stamp()})", "", f"Harness claude-sdk, model {model}, Auto mode, through Groundwater Studio's "
          f"embedded Omnigent. Prompt:", "", f"> {prompt}", "", "## Transcript", ""]
    for it in items:
        d = it.get("data") or {}
        t = it.get("type")
        if t == "function_call":
            calls[d.get("call_id")] = d.get("name")
            args = d.get("arguments") or ""
            md.append(f"- **tool call** `{str(d.get('name')).split('__')[-1]}` {args[:600]}")
        elif t == "function_call_output":
            out = d.get("output") or ""
            md.append(f"  - result ({str(calls.get(d.get('call_id'), '')).split('__')[-1]}): {out[:1500]}")
        elif t == "message" and d.get("role") == "assistant":
            txt = "".join(x.get("text", "") for x in d.get("content") or [] if isinstance(x, dict))
            if txt.strip():
                md.append(f"\n**agent:** {txt.strip()}\n")
    used = [n.split("__")[-1] for n in calls.values()]
    md += ["", f"Tools used, in order: {', '.join(used)}", f"Asked Genie: {'yes' if 'ask_genie' in used else 'no'}",
           f"Session status: {snap.get('status')}" + (f" ({snap['last_task_error'].get('message')})" if snap.get("last_task_error") else "")]
    write("agent_study.md", "\n".join(md))
    summary["agent"] = {"tools": len(used), "asked_genie": "ask_genie" in used, "status": snap.get("status")}

# ---- 8. the outlook job run that the telemetry file triggered ---------------------------------------------------------
if dropped and outlook_job:
    jid = outlook_job.job_id
    run = None
    t0 = time.time()
    while time.time() - t0 < 2700:
        rs = [r for r in w.jobs.list_runs(job_id=jid, limit=5) if r.start_time and r.start_time / 1000 > drop_time - 30]
        if rs:
            run = w.jobs.get_run(rs[0].run_id)
            if run.state.life_cycle_state.value in ("TERMINATED", "INTERNAL_ERROR", "SKIPPED"):
                break
        time.sleep(30)
    if run:
        tasks = [{"task": t.task_key, "state": t.state.result_state.value if t.state.result_state else t.state.life_cycle_state.value,
                  "duration_s": round(((t.end_time or 0) - (t.start_time or 0)) / 1000) if t.end_time else None}
                 for t in run.tasks or []]
        write("outlook_job.json", {"job": outlook_job.settings.name, "trigger": run.trigger.value if run.trigger else None,
                                   "triggered_by_file": dropped, "state": run.state.result_state.value if run.state.result_state else None,
                                   "duration_s": round((run.end_time - run.start_time) / 1000) if run.end_time else None,
                                   "tasks": tasks})
        summary["outlook"] = {"trigger": run.trigger.value if run.trigger else None,
                              "state": run.state.result_state.value if run.state.result_state else None}

# ---- 9. Lakebase: the synced outlook and a field note written through the app ------------------------------------------
c = appc()
ob = c.get("/api/ops/outlook").json()
top = next((b for b in ob.get("bores", []) if b["season"] == "dry"), None)
note = c.post("/api/ops/notes", json={"bore_id": top["bore_id"] if top else "OB-01", "season": "dry", "status": "inspect",
                                      "note": "Evidence run: book a site visit before the next irrigation season"}).json() if ob.get("available") else None
lb = [f"Lakebase ({stamp()})", "", "GET /api/ops/outlook (the app reads Postgres as its service principal):",
      f"  available={ob.get('available')} bores={len(ob.get('bores', []))} reaches={len(ob.get('reaches', []))} notes={len(ob.get('notes', []))}",
      "  dry-year bores, shallowest first:"]
for b in [x for x in ob.get("bores", []) if x["season"] == "dry"][:8]:
    lb.append(f"    {b['bore_id']}  risk={b['risk']}  min_depth_m={b['min_depth_m']}  months_within_2m={b['months_within_2m']}")
lb += ["", f"POST /api/ops/notes -> {note}", ""]
try:
    import psycopg
    branch = w.postgres.get_project(f"projects/{a.app_name}").status.default_branch
    ep = next(iter(w.postgres.list_endpoints(branch))).name
    host = w.postgres.get_endpoint(ep).status.hosts.host
    try:
        addr = socket.gethostbyname(host)
    except Exception:
        addr = subprocess.check_output(["dig", "+short", host], text=True).split()[-1]
    with psycopg.connect(host=host, hostaddr=addr, dbname="databricks_postgres", user=user, sslmode="require",
                         password=w.postgres.generate_database_credential(endpoint=ep).token) as pc:
        for q in (f'SELECT season, count(*) AS bores, count(*) FILTER (WHERE risk <> \'normal\') AS at_risk FROM "{a.schema}".ops_outlook_bore_risk GROUP BY season ORDER BY season',
                  f'SELECT season, reach, seepage_ml, seepage_rank FROM "{a.schema}".ops_outlook_reach_seepage WHERE seepage_rank <= 3 ORDER BY season, seepage_rank',
                  'SELECT note_id, bore_id, season, status, note, created_at FROM studio_ops.field_notes ORDER BY note_id DESC LIMIT 3'):
            cur = pc.execute(q)
            lb += [f"psql> {q}", "  " + " | ".join(d.name for d in cur.description)] + [f"  {r}" for r in cur.fetchall()] + [""]
except Exception as e:
    lb.append(f"psql check skipped: {str(e).splitlines()[0][:200]}")
write("lakebase.txt", "\n".join(lb))
summary["lakebase"] = {"available": ob.get("available"), "bores": len(ob.get("bores", [])), "note_written": bool(note)}

# ---- 10. Genie: benchmarks, and one question through the app's Ask panel ---------------------------------------------
if "genie" not in SKIP:
    space = next((s for s in (w.genie.list_spaces(page_size=100).spaces or []) if s.title.endswith(f"({a.app_name})") or
                  s.title == "Groundwater Studio: sample district"), None)
    g = [f"# Genie Agent ({stamp()})", "", f"Space: {space.title if space else 'not found'}", ""]
    if space:
        ser = json.loads(w.api_client.do("GET", f"/api/2.0/genie/spaces/{space.space_id}", query={"include_serialized_space": "true"})["serialized_space"])
        bench = ser.get("benchmarks", {}).get("questions", [])
        try:
            ev = w.genie.genie_create_eval_run(space.space_id)
            evid = ev.eval_run_id if hasattr(ev, "eval_run_id") else ev.as_dict().get("eval_run_id") or ev.as_dict().get("id")
            t0 = time.time()
            while time.time() - t0 < 900:
                time.sleep(15)
                er = w.genie.genie_get_eval_run(space.space_id, evid).as_dict()
                if str(er.get("status", er.get("state", ""))).upper() in ("COMPLETED", "DONE", "FINISHED", "FAILED", "SUCCEEDED"):
                    break
            res = w.genie.genie_list_eval_results(space.space_id, evid).as_dict()
            g += ["## Benchmark evaluation", "", "```json", json.dumps({"run": er, "results": res}, indent=1, default=str)[:12000], "```", ""]
        except Exception as e:
            g += [f"Benchmark evaluation API: {str(e)[:300]}", ""]
        g += ["## Each benchmark question, asked as a user", ""]
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
        import genie as genie_mod
        genie_mod.SPACE_ID = space.space_id
        passed = 0
        for b in bench:
            q = b["question"][0]
            ans = genie_mod.ask(w, q, wait_s=45)
            if ans.get("status") == "pending":
                ans = genie_mod.poll(w, ans["conversation_id"], ans["message_id"], 45)
            expect = "".join(b.get("answer", [{}])[0].get("content", []))
            ok = ans.get("status") == "completed" and bool(ans.get("rows"))
            passed += ok
            g += [f"### {q}", "", f"status: {ans.get('status')}", "", "Genie's SQL:", "```sql", ans.get("sql") or "", "```",
                  "Answer rows:", "", md_table(ans.get("columns") or [], ans.get("rows") or [], 10), "",
                  "Expected (benchmark SQL):", "```sql", expect, "```", ""]
        g.insert(4, f"Benchmark questions answered with rows: {passed} of {len(bench)}\n")
        summary["genie"] = {"benchmarks": len(bench), "answered": passed}
        c = appc()
        pa = c.post("/api/genie/ask", json={"question": "Which monitoring bores are most at risk in the dry-year outlook?", "wait_s": 45}).json()
        if pa.get("status") == "pending":
            pa = c.get(f"/api/genie/{pa['conversation_id']}/{pa['message_id']}?wait_s=45").json()
        g += ["## Through the app's Record sheet panel (POST /api/genie/ask, as the signed-in user)", "", "```json",
              json.dumps({k: pa.get(k) for k in ("status", "text", "sql", "columns", "rows")}, indent=1)[:4000], "```"]
    write("genie_benchmarks.md", "\n".join(g))

# ---- README -----------------------------------------------------------------------------------------------------------
write("summary.json", summary)
readme = f"""# Evidence that the build ran

Collected {stamp()} from a fresh install (`./install.sh`) of this repo into a Databricks workspace, by
`packaging/collect_evidence.py`. Workspace hosts and IDs, emails, user names and tokens are replaced with placeholders.

| File | What it shows |
|---|---|
| `install.log` | The installer's output: schema, volumes, landing upload, pipeline update, Lakebase, synced tables, Genie, deploy |
| `pipeline_update.json` | Lakeflow pipeline updates and, per flow, output rows, dropped records and expectation results |
| `tables.md` | Every table in the schema: type (streaming table, materialized view, managed), rows, comment, columns; the column mask in action |
| `scenario_run.json` | REST `POST /api/v1/runs`: the calibrated baseline and lining reach MC-05 |
| `mcp_session.txt` | MCP `initialize`, `tools/list`, `describe_model`, and an ensemble started with `start_ensemble` |
| `ensemble.json` | The ensemble's result from serverless Spark (`get_ensemble`) |
| `mlflow_runs.csv` | Parameters and metrics MLflow holds for the filed runs |
| `agent_study.md` | An in-app agent study: the agent asks Genie first, runs two scenarios, records a finding and concludes |
| `outlook_job.json` | The outlook job run triggered by a new telemetry file: ingest, three season runs, gold, Lakebase sync, agent briefing |
| `lakebase.txt` | The outlook served from Lakebase to the app, a field note written back, and `psql` reads of both |
| `genie_benchmarks.md` | The Genie Agent's benchmark evaluation, each benchmark question with Genie's SQL and rows, and one question asked through the app |
| `summary.json` | Headline numbers from the above |

Headline: {json.dumps(summary, default=str)}
"""
write("README.md", readme)
print("done:", json.dumps(summary, default=str))
