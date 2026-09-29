"""The Studio's agent: MODFLOW OS tools driven by any harness Omnigent runs, inside this app.

Omnigent's server and host run beside the Studio (omni_runtime). Each session is scoped to the signed-in user: the
Studio only relays sessions they own, and the session's MODFLOW tools reach this app over loopback with a key that
stands for that user, so every read runs under their Unity Catalog grants and everything filed carries their name.
Model calls go through Unity AI Gateway. The same agent runs unattended as a job step (agent_managed, jobs/).
"""
import hashlib
import io
import json
import os
import secrets
import logging
import tarfile
import threading
import time

import httpx
import yaml
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import omni_runtime as rt

log = logging.getLogger("agent")
from agent_managed import (HARNESS_FAMILIES, MODES, POLICY_PREFIX, PREFERRED, PROMPT, Mode, NewSession, Text, Verdict,
                           _msg, mode_policies, workspace_models)

router = APIRouter(prefix="/api/agent")
AGENT_NAME = "modflow"
APP_PORT = int(os.getenv("DATABRICKS_APP_PORT", "8000"))
HARNESS_LABEL = {"claude-sdk": "Claude Agent SDK", "codex": "Codex", "pi": "Pi"}
ORDER = ["claude-sdk", "codex", "pi"]

# key -> the user a session's MODFLOW tools act for. The key travels only between this app and its own Omnigent host.
# It is kept in the runtime's private directory (0600) as well, so threads keep working when the app process restarts
# on a container that keeps its Omnigent history.
_KEYS = rt.DATA / "keys.json"
try:
    _keys: dict[str, dict] = json.loads(_KEYS.read_text())
except (OSError, ValueError):
    _keys = {}


def _save_keys():
    try:
        rt.DATA.mkdir(parents=True, exist_ok=True)
        tmp = _KEYS.with_suffix(".tmp")
        tmp.touch(mode=0o600)
        tmp.write_text(json.dumps(_keys))
        tmp.replace(_KEYS)
    except OSError:
        log.warning("could not save agent keys")
# session -> the ensembles its agent started: {ensemble_id: {job_run_id, label, state, started_ms, ended_ms, url, told}}
_ens: dict[str, dict[str, dict]] = {}


def _owner(email: str) -> str:
    return hashlib.sha1(email.lower().encode()).hexdigest()[:16]


def _user(request: Request) -> tuple[str, str]:
    email = request.headers.get("x-forwarded-email") or request.headers.get("x-forwarded-preferred-username")
    token = request.headers.get("x-forwarded-access-token")
    if not email or not token:
        raise HTTPException(401, "Sign in through the app to use the agent.")
    stale = False
    for v in _keys.values():  # keep the user's running sessions on their freshest token
        if v["email"] == email and v["token"] != token:
            v["token"], stale = token, True
    if stale:
        _save_keys()
    return email, token


def identity_for(key: str | None) -> dict | None:
    return _keys.get(key) if key else None


def omni(method: str, path: str, **kw) -> httpx.Response:
    try:
        r = httpx.request(method, rt.URL + path, timeout=60, **kw)
    except httpx.HTTPError as e:
        raise HTTPException(503, f"The agent runtime is not reachable yet ({e.__class__.__name__}). {rt.state['error'] or ''}")
    if r.status_code >= 400:
        raise HTTPException(r.status_code if r.status_code < 500 else 502, r.text[:500])
    return r


def _own(sid: str, request: Request) -> dict:
    email, _ = _user(request)
    snap = omni("GET", f"/v1/sessions/{sid}").json()
    if (snap.get("labels") or {}).get("owner") != _owner(email):
        raise HTTPException(404, "No such session.")
    return snap


@router.get("/options")
def options(request: Request):
    _user(request)
    try:
        hid = rt.host_id()
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    host = next((h for h in omni("GET", "/v1/hosts").json().get("hosts", []) if h["host_id"] == hid), {})
    ready = host.get("configured_harnesses") or {}
    models = workspace_models()
    out = []
    for h in omni("GET", "/v1/harnesses").json()["data"]:
        fams = HARNESS_FAMILIES.get(h["id"])
        if not fams or h["capabilities"].get("auth") != "omnigent-credential" or ready.get(h["id"]) not in (True, "needs-auth"):
            continue  # vendor sign-in harnesses and ones whose binary this container lacks (bundles bring their own auth)
        ms = [m["name"] for m in models if m["family"] in fams]
        if ms:
            out.append({"id": h["id"], "label": HARNESS_LABEL.get(h["id"], h["label"]), "models": ms,
                        "default_model": next((m for m in PREFERRED.get(h["id"], []) if m in ms), ms[0])})
    out.sort(key=lambda h: ORDER.index(h["id"]) if h["id"] in ORDER else 9)
    info = omni("GET", "/v1/info").json()
    return {"harnesses": out, "modes": [{"id": k, "label": v} for k, v in MODES.items()],
            "runtime": {"server_version": info.get("server_version"), "host": host.get("name"),
                        "up_since": rt.state["started"]}}


def _bundle(harness: str, model: str, key: str, who: str, study: str | None) -> bytes:
    study_line = f"\nThis session is working on study {study}; pass study_id=\"{study}\" to every run." if study else ""
    prompt = PROMPT.format(user=who, study=study_line).replace(
        "You may use the sandbox shell for analysis (for example, plotting a\n  comparison), but the model",
        "You have a scratch directory for analysis, but the model") + (
        "\n\nEnsembles run as a Spark job and take about 4 minutes for 64 members. After starting them, tell the user what "
        "you are waiting for and end your turn: do not poll get_ensemble in a loop. The Studio watches the jobs and sends "
        "you a message starting with [Studio] when they have all finished; then read them and continue.\n"
        "The user watches the model beside you. Tables in your replies render, so use them for comparisons.\n"
        "Beyond the district model you can work with any MODFLOW 6 package (list_models). To create a model use "
        "build_model (FloPy runs in the Studio), or write_model with full MODFLOW 6 input files; edit_model_file changes "
        "one file; run_model solves it. You have no shell here; for analysis, figures and reports write Python for "
        "run_python, a sandbox that gets full arrays for any run or package and keeps what it writes to OUTPUTS as "
        "artifacts the user sees in the thread. Make figures that explain: label axes with units, annotate what matters, "
        "and compare against the baseline. For a written report, build a PDF with fpdf2 (embed your figures) and, if the "
        "user wants LaTeX, also write the .tex source. Use show_in_studio to put what you are talking about on the "
        "user's screen. Files the user attaches arrive as an '[Attached files]' list in their message; images they attach are "
        "in the message itself, so look at them directly. view_image shows you any upload or any figure you made: look at "
        "your figures before you present them and fix what does not read well. When you have made files, end your reply by "
        "linking each one as a markdown link, [file name](url), using the url run_python returned; the Studio shows "
        "images and PDFs as previews under your message.")
    config = {"spec_version": 1, "name": AGENT_NAME,
              "description": "MODFLOW OS research agent: builds, runs and compares MODFLOW 6 scenarios and files studies",
              "executor": {"type": "omnigent", "model": model, "profile": rt.PROFILE, "config": {"harness": harness},
                           "auth": {"type": "databricks", "profile": rt.PROFILE}},
              "instructions": "AGENTS.md"}
    mcp = {"name": "modflow", "description": "MODFLOW OS: MODFLOW 6 scenarios, runs and studies on Unity Catalog data",
           "transport": "http", "url": f"http://127.0.0.1:{APP_PORT}/mcp", "timeout": 600,
           "headers": {"X-Modflow-Key": key, "X-Modflow-Client": f"mcp:omnigent/{harness}"}}
    files = {"config.yaml": yaml.safe_dump(config, sort_keys=False), "AGENTS.md": prompt,
             "tools/mcp/modflow.yaml": yaml.safe_dump(mcp, sort_keys=False)}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, text in files.items():
            data = text.encode()
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            tar.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def set_mode(sid: str, mode: str):
    if mode not in MODES:
        raise HTTPException(422, f"mode must be one of {', '.join(MODES)}")
    have = omni("GET", f"/v1/sessions/{sid}/policies").json()
    for p in have.get("data", have if isinstance(have, list) else []):
        if str(p.get("name", "")).startswith(POLICY_PREFIX):
            omni("DELETE", f"/v1/sessions/{sid}/policies/{p['id']}")
    for p in mode_policies(mode):
        omni("POST", f"/v1/sessions/{sid}/policies", json=p)


def get_mode(sid: str) -> str:
    have = omni("GET", f"/v1/sessions/{sid}/policies").json()
    names = {str(p.get("name")) for p in have.get("data", have if isinstance(have, list) else [])}
    return "ask" if f"{POLICY_PREFIX}-ask" in names else "read" if f"{POLICY_PREFIX}-read" in names else "auto"


IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp")


def image_data_url(data: bytes, max_edge: int = 1568) -> str:
    """An image the model can take: at most 1568 px on the long edge (what vision models use anyway), JPEG unless it
    needs transparency, as a data URL."""
    import base64
    from PIL import Image

    im = Image.open(io.BytesIO(data))
    im.thumbnail((max_edge, max_edge))
    out = io.BytesIO()
    if im.mode in ("RGBA", "LA", "P") and "transparency" in im.info or im.mode == "RGBA":
        im.save(out, "PNG", optimize=True)
        kind = "png"
    else:
        im.convert("RGB").save(out, "JPEG", quality=85)
        kind = "jpeg"
    return f"data:image/{kind};base64," + base64.b64encode(out.getvalue()).decode()


def _with_images(text: str, paths: list[str], request: Request) -> dict:
    """The user's message, with the images they attached as image blocks the harness passes to the model."""
    import app as api  # reads run as the user
    msg = _msg(text)
    for p in [p for p in paths if p.lower().endswith(IMAGE_SUFFIXES)][:6]:
        if not p.startswith(api.WORKSPACE + "/") or ".." in p.split("/"):
            continue
        try:
            data = api.user_client(request).files.download(p).contents.read()
            msg["data"]["content"].append({"type": "input_image", "filename": p.rsplit("/", 1)[-1], "image_url": image_data_url(data)})
        except Exception:
            log.warning("could not attach image %s", p)
    return msg


@router.post("/sessions")
def create_session(req: NewSession, request: Request):
    email, token = _user(request)
    try:
        hid = rt.host_id()
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    key = secrets.token_urlsafe(32)
    _keys[key] = {"email": email, "token": token, "client": f"mcp:omnigent/{req.harness}"}
    title = req.message.strip().split("\n")[0][:80] or "MODFLOW session"
    labels = {"app": "modflow", "owner": _owner(email), "mode": req.mode, "harness": req.harness, "model": req.model,
              **({"study": req.study_id} if req.study_id else {})}
    meta = {"title": title, "labels": labels, "host_type": "external", "host_id": hid,
            "workspace": rt.workspace_dir(_owner(email))}
    r = omni("POST", "/v1/sessions", data={"metadata": json.dumps(meta)},
             files={"bundle": ("modflow.tar.gz", _bundle(req.harness, req.model, key, email, req.study_id), "application/gzip")})
    sid = r.json().get("session_id") or r.json().get("id")
    _keys[key]["sid"] = sid
    _save_keys()
    set_mode(sid, req.mode)
    omni("POST", f"/v1/sessions/{sid}/events", json=_with_images(req.message, req.attachments, request))
    return {"session_id": sid}


@router.get("/sessions")
def list_sessions(request: Request):
    email, _ = _user(request)
    d = omni("GET", "/v1/sessions", params={"limit": 50}).json()
    mine = [s for s in d.get("data", []) if (s.get("labels") or {}).get("owner") == _owner(email)]
    out = []
    for s in mine:
        lab = s.get("labels") or {}
        import app as api
        waiting = [e for e in _ens.get(s["id"], {}).values() if e["state"] == "running"] + \
            [t for t in api.tasks.values() if t.get("session") == s["id"] and t["status"] == "running"]
        out.append({k: s.get(k) for k in ("id", "title", "status", "created_at", "updated_at", "labels", "total_cost_usd")}
                   | {"harness": s.get("harness") or lab.get("harness"), "llm_model": s.get("llm_model") or lab.get("model"),
                      "waiting": len(waiting)})
    return out


@router.get("/sessions/{sid}")
def get_session(sid: str, request: Request):
    _own(sid, request)
    snap = omni("GET", f"/v1/sessions/{sid}", params={"include_items": "true", "include_liveness": "true",
                                                      "include_usage": "true"}).json()
    _track(sid, snap.get("items") or [])
    import app as api
    mine = [api.task_public(t) | {"elapsed_s": round((t["finished"] or time.time()) - t["started"], 1)} for t in api.tasks.values() if t.get("session") == sid]
    return snap | {"mode": get_mode(sid), "ensembles": list(_ens.get(sid, {}).values()), "tasks": mine}


# ---- work the agent left running. An ensemble outlives the agent's turn, so the Studio watches its job and wakes the
# session with the result when it finishes; until then the Studio shows the session as waiting, not done.
def _parse(out: str | None):
    try:
        v = json.loads(out or "")
        if isinstance(v, dict) and isinstance(v.get("result"), str):
            v = json.loads(v["result"])
        return v if isinstance(v, dict) else None
    except (ValueError, TypeError):
        return None


def _track(sid: str, items: list[dict]):
    """Register the ensembles a thread started, as the transcript shows them (so this survives an app restart): an
    ensemble already named in a [Studio] message has been reported, and a new entry starts from its job's real state."""
    told = " ".join(c.get("text", "") for it in items if it.get("type") == "message"
                    for c in (it.get("data") or {}).get("content") or [] if str(c.get("text", "")).startswith("[Studio]"))
    for it in items:
        if it.get("type") != "function_call_output":
            continue
        v = _parse((it.get("data") or {}).get("output"))
        if not (v and v.get("ensemble_id") and v.get("job_run_id")) or v["ensemble_id"] in _ens.get(sid, {}):
            continue
        e = {"ensemble_id": v["ensemble_id"], "job_run_id": v["job_run_id"], "url": v.get("url"), "state": "running",
             "label": None, "started_ms": int(it.get("created_at", time.time()) * 1000), "ended_ms": None,
             "told": v["ensemble_id"] in told}
        try:
            import app as api
            j = api.ensemble_job(e["ensemble_id"], e["job_run_id"])
            if j:
                e.update(state=j["state"], label=j["label"], started_ms=j["started_ms"] or e["started_ms"], ended_ms=j["ended_ms"])
        except Exception:
            log.warning("could not read ensemble job %s", e["job_run_id"])
        _ens.setdefault(sid, {})[e["ensemble_id"]] = e


def _watch_once():
    import app as api  # the app module: its service principal can see the ensemble job's runs
    keyed = {v.get("sid") for v in list(_keys.values()) if v.get("sid")}
    for sid in keyed | set(_ens):
        try:
            snap = omni("GET", f"/v1/sessions/{sid}", params={"include_items": "true"}).json()
        except HTTPException:
            continue
        _track(sid, snap.get("items") or [])
        ens = _ens.get(sid, {})
        for e in ens.values():
            if e["state"] == "running":
                j = api.ensemble_job(e["ensemble_id"], e["job_run_id"])
                if j and j["state"] != "running":
                    e.update(state=j["state"], label=j["label"], ended_ms=j["ended_ms"], message=j["message"])
                elif j:
                    e.update(label=j["label"], started_ms=j["started_ms"] or e["started_ms"])
        done = [e for e in ens.values() if e["state"] != "running" and not e["told"]]
        if not done or any(e["state"] == "running" for e in ens.values()) or snap.get("status") != "idle":
            continue  # tell the agent once everything it started has finished, between turns
        if sid not in keyed:  # its tools can no longer act for anyone; the thread shows the ensembles as finished
            for e in done:
                e["told"] = True
            continue
        lines = [f"- {e['ensemble_id']} ({e.get('label') or 'ensemble'}): "
                 + ("finished" if e["state"] == "finished" else f"FAILED {e.get('message') or ''}".strip()) for e in done]
        msg = ("[Studio] The ensembles you started have finished:\n" + "\n".join(lines)
               + "\nRead them with get_ensemble (results can take a few seconds to file after the job ends), then carry on "
                 "with what you told the user you would do.")
        try:
            omni("POST", f"/v1/sessions/{sid}/events", json=_msg(msg))
            for e in done:
                e["told"] = True
        except HTTPException as ex:
            log.warning("could not wake session %s: %s", sid, ex.detail)


def _wake_tasks():
    import app as api
    by_sid: dict[str, list] = {}
    for t in list(api.tasks.values()):
        if t.get("session") and t["status"] != "running" and not t["told"]:
            by_sid.setdefault(t["session"], []).append(t)
    for sid, done in by_sid.items():
        if any(x["status"] == "running" for x in api.tasks.values() if x.get("session") == sid):
            continue  # report a batch together
        try:
            if omni("GET", f"/v1/sessions/{sid}").json().get("status") != "idle":
                continue
            lines = [f"- {t['task_id']} ({t['label'] or t['kind']}): " + ((f"finished, run {t['run_id']}; summary: {json.dumps(t['summary'])[:1500]}" if t.get("run_id") else f"finished: {json.dumps(t['summary'])[:8000]}")
                     if t["status"] == "finished" else f"FAILED: {t['error']}") for t in done]
            omni("POST", f"/v1/sessions/{sid}/events", json=_msg("[Studio] Your background runs have finished:\n" + "\n".join(lines)
                                                                + "\nCarry on with what you told the user you would do."))
            for t in done:
                t["told"] = True
        except HTTPException as ex:
            log.warning("could not wake session %s: %s", sid, ex.detail)


def _watcher():
    while not rt.state["stopping"]:
        try:
            if rt.state["host_id"]:
                _watch_once()
                _wake_tasks()
        except Exception:
            log.exception("ensemble watcher")
        time.sleep(20)


def start_watcher():
    if rt.enabled():
        threading.Thread(target=_watcher, name="agent-ensembles", daemon=True).start()


@router.get("/sessions/{sid}/stream")
async def stream(sid: str, request: Request):
    _own(sid, request)

    async def gen():
        async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=20)) as c:
            async with c.stream("GET", f"{rt.URL}/v1/sessions/{sid}/stream", headers={"Accept": "text/event-stream"}) as r:
                async for chunk in r.aiter_raw():
                    if await request.is_disconnected():
                        break
                    yield chunk
    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/sessions/{sid}/messages")
def send(sid: str, t: Text, request: Request):
    email, _ = _user(request)
    _own(sid, request)
    rt.workspace_dir(_owner(email))  # a fresh container has lost the scratch folder the thread's runner starts in
    try:
        return omni("POST", f"/v1/sessions/{sid}/events", json=_with_images(t.text, t.attachments, request)).json()
    except HTTPException as e:
        if "runner_unavailable" in str(e.detail) or "No runner bound" in str(e.detail):
            raise HTTPException(409, "This thread was started on an agent host from before the app was redeployed, so it can be "
                                     "read but not continued. Start a new thread (you can attach this one's results from the Files "
                                     "and Runs tabs).")
        raise


@router.post("/sessions/{sid}/interrupt")
def interrupt(sid: str, request: Request):
    _own(sid, request)
    return omni("POST", f"/v1/sessions/{sid}/events", json={"type": "interrupt", "data": {}}).json()


@router.put("/sessions/{sid}/mode")
def change_mode(sid: str, m: Mode, request: Request):
    _own(sid, request)
    set_mode(sid, m.mode)
    return {"mode": m.mode}


@router.post("/sessions/{sid}/elicitations/{eid}")
def resolve(sid: str, eid: str, v: Verdict, request: Request):
    email, _ = _user(request)
    _own(sid, request)
    rt.workspace_dir(_owner(email))
    return omni("POST", f"/v1/sessions/{sid}/elicitations/{eid}/resolve", json={"action": v.action}).json()


@router.delete("/sessions/{sid}")
def delete(sid: str, request: Request):
    _own(sid, request)
    omni("DELETE", f"/v1/sessions/{sid}")
    for k in [k for k, v in _keys.items() if v.get("sid") == sid]:
        _keys.pop(k, None)
    _save_keys()
    _ens.pop(sid, None)
    return {"deleted": sid}


@router.get("/status")
def status(request: Request):
    """Runtime health for the Studio (and for whoever is debugging it)."""
    _user(request)
    st = rt.state
    out = {"up": bool(st["host_id"]), "error": st["error"], "host_id": st["host_id"], "up_since": st["started"],
           "restored_from_snapshot": bool(st.get("restored")), "last_snapshot": st.get("snapshot_at"),
           "thread_store": f"lakebase ({os.getenv('LAKEBASE_ENDPOINT')}, schema {os.getenv('OMNIGENT_PG_SCHEMA', 'omnigent')})" if rt.lakebase() else "sqlite (container)"}
    if request.query_params.get("logs"):
        try:
            host = next((h for h in omni("GET", "/v1/hosts").json().get("hosts", []) if h["host_id"] == st["host_id"]), {})
            out["harnesses"] = {k: v for k, v in (host.get("configured_harnesses") or {}).items() if k in ("claude-sdk", "codex", "pi")}
        except HTTPException:
            pass
        env = rt._env()
        out["binaries"] = {k: env.get(k) for k in ("OMNIGENT_CLAUDE_PATH", "OMNIGENT_CODEX_PATH", "OMNIGENT_PI_PATH")} | {
            "node": __import__("shutil").which("node", path=env["PATH"])}
        runners = sorted((rt.DATA / "data" / "logs" / "runner").glob("*.log"), key=lambda p: p.stat().st_mtime)
        out |= {"server_log": rt.tail("server", 40), "host_log": rt.tail("host", 40),
                "runner_log": "\n".join(l for l in runners[-1].read_text(errors="replace").splitlines()
                                        if "schema contains" not in l)[-6000:] if runners else None}
    return out
