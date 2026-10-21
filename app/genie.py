"""Genie Agent over the district's governed tables, for people (the Record sheet's Ask panel) and for the agent (the
ask_genie and get_genie_answer tools).

Every call runs as the caller: the signed-in user in the Studio, the job's identity in a job step. Genie writes and runs
the SQL under that identity's Unity Catalog grants, so masked columns stay masked. Questions are answered from what is
already filed (inputs, runs, ensembles, studies, the outlook); nothing here runs MODFLOW.
"""
import os
import time

SPACE_ID = os.getenv("GENIE_SPACE_ID", "")
DONE = {"COMPLETED", "FAILED", "CANCELLED", "QUERY_RESULT_EXPIRED"}
MAX_ROWS = 50


def configured() -> bool:
    return bool(SPACE_ID)


def _answer(w, msg, max_rows: int = MAX_ROWS) -> dict:
    status = msg.status.value if msg.status else "SUBMITTED"
    out = {"conversation_id": msg.conversation_id, "message_id": msg.message_id or msg.id, "status": status.lower(),
           "question": msg.content}
    if status not in DONE:
        out["status"] = "pending"
        return out
    if status != "COMPLETED":
        out["error"] = (msg.error.error if msg.error and getattr(msg.error, "error", None) else status.lower())
        return out
    texts, sugg = [], []
    for a in msg.attachments or []:
        if a.text and a.text.content:
            texts.append(a.text.content)
        if a.suggested_questions and a.suggested_questions.questions:
            sugg += list(a.suggested_questions.questions)
        if a.query and a.query.query:
            out["sql"] = a.query.query
            out["query_description"] = a.query.description
            try:
                r = w.genie.get_message_attachment_query_result(SPACE_ID, msg.conversation_id, out["message_id"], a.attachment_id)
                sr = r.statement_response
                cols = [c.name for c in sr.manifest.schema.columns] if sr and sr.manifest and sr.manifest.schema else []
                rows = (sr.result.data_array or []) if sr and sr.result else []
                total = sr.manifest.total_row_count if sr and sr.manifest else len(rows)
                out.update(columns=cols, rows=rows[:max_rows], row_count=total, truncated=(total or 0) > max_rows)
            except Exception as e:  # the answer still stands without its rows
                out["rows_error"] = str(e)[:300]
    out["text"] = "\n\n".join(texts)
    if sugg:
        out["suggested_questions"] = sugg[:3]
    return out


def ask(w, question: str, conversation_id: str | None = None, wait_s: float = 40) -> dict:
    """Ask (or follow up), then wait up to wait_s for the answer. Returns status 'pending' if Genie is still working."""
    if not SPACE_ID:
        raise RuntimeError("No Genie Agent is configured for this install (GENIE_SPACE_ID is empty)")
    started = (w.genie.create_message(SPACE_ID, conversation_id, question) if conversation_id
               else w.genie.start_conversation(SPACE_ID, question))
    first = started.response
    return poll(w, first.conversation_id, first.message_id or first.id, wait_s)


def poll(w, conversation_id: str, message_id: str, wait_s: float = 40) -> dict:
    deadline = time.time() + max(0.0, wait_s)
    while True:
        msg = w.genie.get_message(SPACE_ID, conversation_id, message_id)
        if (msg.status and msg.status.value in DONE) or time.time() >= deadline:
            return _answer(w, msg)
        time.sleep(1.5)


def space_url(host: str) -> str:
    return f"{host.rstrip('/')}/genie/rooms/{SPACE_ID}" if SPACE_ID else ""
