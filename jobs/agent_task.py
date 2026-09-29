"""A MODFLOW research agent as a Lakeflow Jobs task (approved by the project owner for scheduled, unattended use).

Starts an Omnigent session on a Databricks Sandbox with the MODFLOW OS agent, gives it the prompt, waits for it to
finish and publishes its answer as the task value `answer`. The session, the sandbox, the model calls (Unity AI Gateway)
and every MODFLOW tool call act as the job's run-as identity: typically a service principal granted CAN_USE on the app
and read access to the model's Unity Catalog inputs. Drop it into any job as an ordinary task, with the prompt built by
an upstream task (for example from a document that landed in a volume).

Guardrails for unattended runs: the agent can only change the MODFLOW record through the MODFLOW tools; mode `read`
denies all writes; shell and file work inside the sandbox is reported, and the session stays open in <workspace>/omnigent
for review.
"""
import argparse
import sys
import time
from types import SimpleNamespace

p = argparse.ArgumentParser()
p.add_argument("--app_dir", required=True)
p.add_argument("--app_name", required=True)
p.add_argument("--prompt", required=True)
p.add_argument("--harness", default="claude-sdk")
p.add_argument("--model", default="")
p.add_argument("--mode", default="auto", choices=["auto", "read"])
p.add_argument("--study_id", default="")
p.add_argument("--timeout_min", type=float, default=45)
a = p.parse_args()

sys.path.insert(0, a.app_dir)
import agent_managed as agent  # noqa: E402

w = agent._sp
app_url = w.apps.get(a.app_name).url
token = w.config.authenticate()["Authorization"].split(" ", 1)[1]
me = w.current_user.me().user_name
request = SimpleNamespace(headers={"x-forwarded-access-token": token, "x-forwarded-host": app_url.split("://", 1)[1],
                                   "x-forwarded-email": me})
model = a.model or next(h["default_model"] for h in agent.options(request)["harnesses"] if h["id"] == a.harness)
sid = agent.create_session(agent.NewSession(harness=a.harness, model=model, mode=a.mode, message=a.prompt,
                                            study_id=a.study_id or None), request)["session_id"]
print(f"Omnigent session {sid} as {me} ({a.harness}, {model}, mode {a.mode}): {agent.HOST}/omnigent")

deadline, seen_busy, snap = time.time() + a.timeout_min * 60, False, {}
while time.time() < deadline:
    time.sleep(10)
    snap = agent.get_session(sid, request)
    status = snap.get("status")
    seen_busy |= status in ("running", "waiting")
    if snap.get("last_task_error"):
        raise SystemExit(f"Agent session failed: {snap.get('last_task_error')}")
    if status == "idle" and seen_busy:
        break
else:
    raise SystemExit(f"Agent did not finish within {a.timeout_min} min; session {sid} is still open for review.")


def text_of(item):
    return "".join(c.get("text", "") for c in (item.get("data") or {}).get("content") or [] if isinstance(c, dict))


items = snap.get("items") or []
answer = next((text_of(i) for i in reversed(items) if (i.get("data") or {}).get("role") == "assistant" and text_of(i)), "")
calls = [(i.get("data") or {}).get("name") for i in items if i.get("type") == "function_call"]
print(f"Tool calls: {len(calls)} ({', '.join(sorted(set(filter(None, calls))))})")
print(answer)
try:
    from databricks.sdk.runtime import dbutils
    dbutils.jobs.taskValues.set("answer", answer[:40000])
    dbutils.jobs.taskValues.set("session_id", sid)
except Exception as e:
    print("task values not set:", e)
