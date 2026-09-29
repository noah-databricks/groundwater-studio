"""The Studio's agent: MODFLOW OS tools driven by any harness Omnigent runs, on a Databricks Sandbox.

Sessions live on the workspace's managed Omnigent server and are created as the signed-in user, so the sandbox, the
model calls (Unity AI Gateway) and every MODFLOW tool call act with that user's permissions. The app only builds the
agent (prompt, harness, model, the MODFLOW MCP server) and relays the conversation; Omnigent owns the session, its
policies and its history, which also appear in <workspace>/omnigent.
"""
import io
import json
import os
import tarfile
import time
from pathlib import Path

import httpx
from databricks.sdk import WorkspaceClient
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/agent")
_sp = WorkspaceClient()
HOST = _sp.config.host.rstrip("/")
OMNI = f"{HOST}/api/2.0/omnigent"
AGENT_NAME = "modflow"
_cache: dict[str, tuple[float, object]] = {}

# The MCP server the harness launches inside the sandbox. A sandbox's only credential is the session owner's workspace
# identity, and Databricks Apps accept only OAuth tokens, so the sandbox runs MODFLOW OS itself rather than calling the
# app: this stdlib-only launcher answers the MCP handshake at once (tool list baked into the bundle), sets up the
# published MODFLOW OS package from Unity Catalog in the background, then relays tool calls to it. The engine then reads
# and files as the session owner, into the same tables, MLflow experiment and volume the Studio uses.
LAUNCHER = r"""
import base64, json, os, shutil, subprocess, sys, threading, zlib
cfg = json.loads(zlib.decompress(base64.b64decode(sys.argv[1])))
HOME = os.path.expanduser("~/.modflow-os")
os.makedirs(HOME, exist_ok=True)
# the runner may not drain our stderr; a full pipe would stall the engine, so all logging goes to a file
LOG = open(HOME + "/engine.log", "a", buffering=1)
st = {"child": None, "err": None}
ready, io_lock, call_lock = threading.Event(), threading.Lock(), threading.Lock()
def log(*a):
    print("[modflow-os]", *a, file=LOG, flush=True)
def reply(obj):
    with io_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()
def run(cmd, **kw):
    subprocess.run(cmd, check=True, stdout=LOG, stderr=LOG, stdin=subprocess.DEVNULL, **kw)
def setup():
    try:
        os.makedirs(HOME, exist_ok=True)
        py = HOME + "/venv/bin/python"
        uv = shutil.which("uv") or HOME + "/uv/uv"
        if not os.path.exists(uv):
            try:  # uv needs no system venv/ensurepip, which sandbox images may lack
                log("installing uv")
                run(["sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=$0 UV_NO_MODIFY_PATH=1 sh", HOME + "/uv"])
            except Exception as e:
                log("uv unavailable", repr(e)[:200])
        have_uv = os.path.exists(uv)
        if not os.path.exists(py):
            run([uv, "venv", "-q", "--python", "3.12", HOME + "/venv"] if have_uv else [sys.executable, "-m", "venv", HOME + "/venv"])
        marker = HOME + "/.deps-" + cfg["deps_key"]
        if not os.path.exists(marker):
            log("installing engine dependencies")
            run([uv, "pip", "install", "-q", "--python", py, *cfg["requirements"]] if have_uv
                else [py, "-m", "pip", "install", "-q", "--disable-pip-version-check", *cfg["requirements"]])
            open(marker, "w").close()
        pkg = HOME + "/app-" + cfg["key"]
        if not os.path.exists(pkg + "/modflow_os_stdio.py"):
            log("fetching", cfg["package"])
            os.makedirs(pkg, exist_ok=True)
            run([py, "-c", "import sys; from databricks.sdk import WorkspaceClient; "
                 "open(sys.argv[2], 'wb').write(WorkspaceClient().files.download(sys.argv[1]).contents.read())",
                 cfg["package"], HOME + "/app.tar.gz"])
            run(["tar", "-xzf", HOME + "/app.tar.gz", "-C", pkg])
        env = {**os.environ, **cfg["env"], "MODFLOW_OS_HOST": "sandbox", "STUDIO_WORKDIR": HOME + "/work"}
        child = subprocess.Popen([py, pkg + "/modflow_os_stdio.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=LOG, env=env, text=True, bufsize=1)
        child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": "_init", "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "modflow-os-launcher", "version": "1"}}}) + "\n")
        child.stdin.flush()
        if not child.stdout.readline():
            raise RuntimeError("MODFLOW OS engine exited during start-up")
        child.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        child.stdin.flush()
        st["child"] = child
        threading.Thread(target=pump, daemon=True).start()
        log("engine ready")
    except Exception as e:
        st["err"] = repr(e)[:500]
        log("setup failed", st["err"])
    ready.set()
def pump():
    # the engine answers calls as they finish; relay each response to the harness as it arrives
    for line in st["child"].stdout:
        if not line.strip():
            continue
        try:
            reply(json.loads(line))
        except ValueError:  # never let a stray line end the relay
            log("dropped non-protocol output:", line.strip()[:200])
    st["err"], st["child"] = "MODFLOW OS engine stopped", None
def forward(msg):
    if not ready.wait(900) or st["child"] is None:
        return reply({"jsonrpc": "2.0", "id": msg["id"], "result": {"isError": True, "content": [
            {"type": "text", "text": "MODFLOW OS engine is not available in this sandbox: " + str(st["err"] or "still starting")}]}})
    with call_lock:
        st["child"].stdin.write(json.dumps(msg) + "\n")
        st["child"].stdin.flush()
threading.Thread(target=setup, daemon=True).start()
for line in sys.stdin:
    if not line.strip():
        continue
    msg = json.loads(line)
    m = msg.get("method")
    if m == "initialize":
        reply({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": (msg.get("params") or {}).get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "MODFLOW OS", "version": "1.0"},
            "instructions": cfg["instructions"]}})
    elif m == "tools/list":
        reply({"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": cfg["tools"]}})
    elif m == "ping":
        reply({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
    elif m == "tools/call":
        threading.Thread(target=forward, args=(msg,), daemon=True).start()
    elif "id" in msg:
        reply({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "Method not found: " + str(m)}})
"""
_PKG = Path(__file__).with_name("os_package.json")


def launcher_config(harness: str, app_url: str) -> str:
    """The published package, tool list and Unity Catalog coordinates the launcher needs, compressed into one argv."""
    import base64
    import hashlib
    import zlib

    pkg = json.loads(_PKG.read_text())
    env = {**pkg["env"], **{k: os.environ[k] for k in pkg["env"] if os.environ.get(k)},
           "MODFLOW_OS_CLIENT": f"mcp:omnigent/{harness}", "MODFLOW_OS_APP_URL": app_url}
    cfg = {"package": pkg["package"], "key": pkg["key"], "requirements": pkg["requirements"], "env": env,
           "deps_key": hashlib.sha1("\n".join(pkg["requirements"]).encode()).hexdigest()[:10],
           "instructions": pkg["instructions"], "tools": pkg["tools"]}
    return base64.b64encode(zlib.compress(json.dumps(cfg).encode(), 9)).decode()


PROMPT = """\
You are a groundwater modelling research assistant working in MODFLOW OS, on the sample irrigation district model (synthetic data)
(MODFLOW 6, Unity Catalog data). Your MODFLOW tools act as {user} with their permissions, and everything you file
(saved scenarios, runs, studies, findings) is recorded under their name and shown live in their Groundwater Studio.

Work like a careful modeller:
- Start with describe_model. Look at render_map and find_cells before changing land use, so edits target real places.
- Express scenarios as a base plus edits. preview_scenario before saving when an edit is large or ambiguous.
- Prefer one clear change per run so effects can be attributed; compare against the baseline and against each other.
- For any question that needs more than one run, create_study first and pass study_id to every run_scenario.
  Record findings as you go with the run_ids they rest on, add caveats (the model is synthetic, calibrated to
  observed bore levels with the RMSE describe_model reports), and conclude_study at the end.
- Report numbers with units and the run ids behind them. Say what you could not establish.
- Keep to groundwater work in this model. You may use the sandbox shell for analysis (for example, plotting a
  comparison), but the model and its records are only changed through the MODFLOW tools.
{study}"""

MODES = {
    "ask": "Ask before changes",
    "auto": "Auto",
    "read": "Read only",
}
WRITE_TOOLS = ["save_scenario", "run_scenario", "start_ensemble", "create_study", "record_finding", "conclude_study",
               "write_model", "build_model", "edit_model_file", "delete_model", "delete_scenario", "run_batch",
               "save_zone", "delete_zone", "edit_model", "convert_model", "calibrate_model", "apply_calibration"]
POLICY_PREFIX = "modflow-mode"


def _cel(result: str, reason: str) -> str:
    names = " || ".join(f'event.data.name.endsWith("{t}")' for t in WRITE_TOOLS)
    return (f'event.type == "tool_call" && ({names}) ? {{"result": "{result}", "reason": "{reason}"}} '
            f': {{"result": "ALLOW"}}')


def mode_policies(mode: str) -> list[dict]:
    if mode == "ask":
        return [{"name": f"{POLICY_PREFIX}-ask", "type": "python", "handler": "omnigent.policies.builtins.cel.cel_policy",
                 "factory_params": {"expression": _cel("ASK", "Changes the MODFLOW record (saves, runs, studies or model packages)")}},
                {"name": f"{POLICY_PREFIX}-os", "type": "python", "handler": "omnigent.policies.builtins.safety.ask_on_os_tools"}]
    if mode == "read":
        return [{"name": f"{POLICY_PREFIX}-read", "type": "python", "handler": "omnigent.policies.builtins.cel.cel_policy",
                 "factory_params": {"expression": _cel("DENY", "Read-only session: switch to Ask or Auto to change the record")}},
                {"name": f"{POLICY_PREFIX}-os", "type": "python", "handler": "omnigent.policies.builtins.orchestration.read_only_os"}]
    return []


def _token(request: Request) -> str:
    tok = request.headers.get("x-forwarded-access-token")
    if not tok:
        raise HTTPException(401, "No user token forwarded.")
    return tok


def omni(request: Request, method: str, path: str, **kw) -> httpx.Response:
    """Call the managed Omnigent server as the signed-in user."""
    r = httpx.request(method, OMNI + path, headers={"Authorization": f"Bearer {_token(request)}"}, timeout=60, **kw)
    if r.status_code >= 400:
        msg = r.text[:500]
        if "required scopes: all-apis" in msg:
            raise HTTPException(403, "SIGNIN: Omnigent needs a full workspace sign-in, which Databricks Apps user "
                                     "authorization cannot grant. Connect your workspace account to start agent sessions here.")
        if r.status_code in (401, 403) or "login" in r.headers.get("location", ""):
            msg = "Omnigent did not accept your sign-in from the app. " + msg
        raise HTTPException(r.status_code if r.status_code < 500 else 502, msg)
    return r


def _cached(key: str, ttl: float, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    v = fn()
    _cache[key] = (time.time(), v)
    return v


def _family(name: str) -> str | None:
    n = name.lower()
    if "embed" in n or "bge" in n or "gte" in n:
        return None
    if "claude" in n:
        return "claude"
    if "gpt" in n:
        return "gpt"
    if "gemini" in n:
        return "gemini"
    return "other"


def workspace_models() -> list[dict]:
    """Chat models this workspace serves through Unity AI Gateway (Foundation Model APIs and external models)."""
    def go():
        out = []
        for e in _sp.serving_endpoints.list():
            task = (e.task or "").lower()
            ents = (e.config.served_entities if e.config else None) or []
            hosted = any(getattr(s, "foundation_model", None) or getattr(s, "external_model", None) for s in ents)
            if "chat" not in task or not (hosted or e.name.startswith("databricks-")):
                continue
            fam = _family(e.name)
            if fam and (e.state is None or str(getattr(e.state, "ready", "READY")).endswith("READY")):
                out.append({"name": e.name, "family": fam})
        return sorted(out, key=lambda m: (m["family"], m["name"]))
    return _cached("models", 600, go)


# sensible defaults per harness when the workspace serves them; otherwise the first compatible model
PREFERRED = {"claude-sdk": ["databricks-claude-sonnet-5", "databricks-claude-opus-5-5", "databricks-claude-sonnet-4-6"],
             "codex": ["databricks-gpt-5-5", "databricks-gpt-5-4"],
             "pi": ["databricks-gpt-5-5", "databricks-gpt-5-4"]}
# harness -> model families it can drive through the gateway
# (Pi's Anthropic path sends a thinking setting current Claude models reject; Claude runs on the Claude Agent SDK instead)
HARNESS_FAMILIES = {"claude-sdk": {"claude"}, "codex": {"gpt"}, "pi": {"gpt", "gemini", "other"}}


@router.get("/options")
def options(request: Request):
    harnesses = omni(request, "GET", "/v1/harnesses").json()["data"]
    models = workspace_models()
    out = []
    for h in harnesses:
        fams = HARNESS_FAMILIES.get(h["id"])
        if not fams or h["capabilities"].get("auth") != "omnigent-credential":
            continue  # harnesses that need their own vendor sign-in cannot run through the workspace gateway
        ms = [m["name"] for m in models if m["family"] in fams]
        if ms:
            out.append({"id": h["id"], "label": h["label"], "models": ms,
                        "default_model": next((m for m in PREFERRED.get(h["id"], []) if m in ms), ms[0])})
    order = ["claude-sdk", "codex", "pi"]
    out.sort(key=lambda h: order.index(h["id"]) if h["id"] in order else 9)
    info = omni(request, "GET", "/v1/info").json()
    return {"harnesses": out, "modes": [{"id": k, "label": v} for k, v in MODES.items()],
            "sandbox": info.get("managed_sandboxes_enabled", False), "omnigent_url": f"{HOST}/omnigent",
            "server_version": info.get("server_version")}


def _bundle(harness: str, model: str, request: Request, study: str | None) -> bytes:
    import yaml

    app_host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    who = request.headers.get("x-forwarded-email", "the signed-in user")
    study_line = f"\nThis session is working on study {study}; pass study_id=\"{study}\" to every run." if study else ""
    config = {
        "spec_version": 1,
        "name": AGENT_NAME,
        "description": "MODFLOW OS research agent: builds, runs and compares MODFLOW 6 scenarios and files studies",
        "executor": {"type": "omnigent", "model": model, "config": {"harness": harness}},
        "instructions": "AGENTS.md",
    }
    mcp = {"name": "modflow", "description": "MODFLOW OS: MODFLOW 6 scenarios, runs and studies on Unity Catalog data",
           "transport": "stdio", "command": "python3",
           "args": ["-c", LAUNCHER, launcher_config(harness, f"https://{app_host}")]}
    files = {"config.yaml": yaml.safe_dump(config, sort_keys=False),
             "AGENTS.md": PROMPT.format(user=who, study=study_line),
             "tools/mcp/modflow.yaml": yaml.safe_dump(mcp, sort_keys=False)}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, text in files.items():
            data = text.encode()
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            tar.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def set_mode(request: Request, sid: str, mode: str):
    if mode not in MODES:
        raise HTTPException(422, f"mode must be one of {', '.join(MODES)}")
    have = omni(request, "GET", f"/v1/sessions/{sid}/policies").json()
    for p in have.get("data", have if isinstance(have, list) else []):
        if str(p.get("name", "")).startswith(POLICY_PREFIX):
            omni(request, "DELETE", f"/v1/sessions/{sid}/policies/{p['id']}")
    for p in mode_policies(mode):
        omni(request, "POST", f"/v1/sessions/{sid}/policies", json=p)


def get_mode(request: Request, sid: str) -> str:
    have = omni(request, "GET", f"/v1/sessions/{sid}/policies").json()
    names = {str(p.get("name")) for p in have.get("data", have if isinstance(have, list) else [])}
    return "ask" if f"{POLICY_PREFIX}-ask" in names else "read" if f"{POLICY_PREFIX}-read" in names else "auto"


class NewSession(BaseModel):
    harness: str
    model: str
    mode: str = "ask"
    message: str
    attachments: list[str] = []  # workspace volume paths the user attached; images are shown to the model
    study_id: str | None = None


def _msg(text: str) -> dict:
    return {"type": "message", "data": {"role": "user", "content": [{"type": "input_text", "text": text}]}}


@router.post("/sessions")
def create_session(req: NewSession, request: Request):
    title = req.message.strip().split("\n")[0][:80] or "MODFLOW session"
    meta = {"title": title, "labels": {"app": "modflow", "mode": req.mode, **({"study": req.study_id} if req.study_id else {})},
            "host_type": "managed"}
    r = omni(request, "POST", "/v1/sessions", data={"metadata": json.dumps(meta)},
             files={"bundle": ("modflow.tar.gz", _bundle(req.harness, req.model, request, req.study_id), "application/gzip")})
    sid = r.json().get("session_id") or r.json().get("id")
    set_mode(request, sid, req.mode)
    omni(request, "POST", f"/v1/sessions/{sid}/events", json=_msg(req.message))
    return {"session_id": sid}


@router.get("/sessions")
def list_sessions(request: Request):
    d = omni(request, "GET", "/v1/sessions", params={"agent_name": AGENT_NAME, "limit": 30}).json()
    return [{k: s.get(k) for k in ("id", "title", "status", "harness", "llm_model", "created_at", "updated_at", "labels",
                                   "total_cost_usd")} for s in d.get("data", [])]


@router.get("/sessions/{sid}")
def get_session(sid: str, request: Request):
    snap = omni(request, "GET", f"/v1/sessions/{sid}", params={"include_items": "true", "include_liveness": "true",
                                                              "include_usage": "true"}).json()
    return snap | {"mode": get_mode(request, sid)}


@router.get("/sessions/{sid}/stream")
async def stream(sid: str, request: Request):
    tok = _token(request)

    async def gen():
        async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=20)) as c:
            async with c.stream("GET", f"{OMNI}/v1/sessions/{sid}/stream", headers={"Authorization": f"Bearer {tok}",
                                                                                     "Accept": "text/event-stream"}) as r:
                async for chunk in r.aiter_raw():
                    if await request.is_disconnected():
                        break
                    yield chunk
    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class Text(BaseModel):
    text: str
    attachments: list[str] = []


@router.post("/sessions/{sid}/messages")
def send(sid: str, t: Text, request: Request):
    return omni(request, "POST", f"/v1/sessions/{sid}/events", json=_msg(t.text)).json()


@router.post("/sessions/{sid}/interrupt")
def interrupt(sid: str, request: Request):
    return omni(request, "POST", f"/v1/sessions/{sid}/events", json={"type": "interrupt", "data": {}}).json()


class Mode(BaseModel):
    mode: str


@router.put("/sessions/{sid}/mode")
def change_mode(sid: str, m: Mode, request: Request):
    set_mode(request, sid, m.mode)
    return {"mode": m.mode}


class Verdict(BaseModel):
    action: str  # accept | decline


@router.post("/sessions/{sid}/elicitations/{eid}")
def resolve(sid: str, eid: str, v: Verdict, request: Request):
    return omni(request, "POST", f"/v1/sessions/{sid}/elicitations/{eid}/resolve", json={"action": v.action}).json()


@router.delete("/sessions/{sid}")
def delete(sid: str, request: Request):
    omni(request, "DELETE", f"/v1/sessions/{sid}")
    return {"deleted": sid}


@router.get("/ping")
def ping(request: Request):
    return {"omnigent_user": omni(request, "GET", "/v1/me").json(), "gateway_models": len(workspace_models())}
