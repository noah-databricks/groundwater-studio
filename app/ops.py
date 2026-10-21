"""Operations view: the latest seasonal outlook served from Lakebase, and field notes written back to it.

The Lakeflow pipeline builds the gold outlook tables in Unity Catalog; Lakebase synced tables copy them into Postgres
(schema = the install's Unity Catalog schema, tables ops_outlook_bore_risk and ops_outlook_reach_seepage). The app reads
them as its own service principal, which the ops-sync job grants SELECT. Field notes are a native Postgres table in a
schema the app creates and owns, so operations staff can acknowledge an at-risk bore or log an inspection.
"""
import os
import threading

from omni_lakebase import token

SYNC_SCHEMA = os.getenv("UC_SCHEMA", "groundwater_studio")
NOTES_SCHEMA = "studio_ops"
_ready = threading.Event()


def available() -> bool:
    return bool(os.getenv("PGHOST") and os.getenv("LAKEBASE_ENDPOINT"))


def _connect():
    import psycopg
    return psycopg.connect(host=os.environ["PGHOST"], port=int(os.getenv("PGPORT", "5432")), dbname=os.environ["PGDATABASE"],
                           user=os.environ["PGUSER"], password=token(), sslmode="require", connect_timeout=30, autocommit=True)


def _ensure(c):
    if _ready.is_set():
        return
    c.execute(f'CREATE SCHEMA IF NOT EXISTS "{NOTES_SCHEMA}"')
    c.execute(f'''CREATE TABLE IF NOT EXISTS "{NOTES_SCHEMA}".field_notes (
        note_id BIGSERIAL PRIMARY KEY, bore_id TEXT NOT NULL, season TEXT, status TEXT NOT NULL DEFAULT 'noted',
        note TEXT NOT NULL, author TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
    _ready.set()


def _rows(cur):
    cols = [d.name for d in cur.description]
    return [{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in zip(cols, r)} for r in cur.fetchall()]


def outlook() -> dict:
    """The latest outlook per season (bores ranked by risk, reaches by seepage) and the notes against it."""
    if not available():
        return {"available": False, "reason": "Lakebase is not configured for this install"}
    with _connect() as c:
        _ensure(c)
        out = {"available": True, "schema": SYNC_SCHEMA, "bores": [], "reaches": [], "notes": []}
        try:
            out["bores"] = _rows(c.execute(
                f'SELECT season, bore_id, risk, min_depth_m, final_depth_m, months_within_2m, run_id, run_label, run_at '
                f'FROM "{SYNC_SCHEMA}".ops_outlook_bore_risk ORDER BY season, min_depth_m'))
            out["reaches"] = _rows(c.execute(
                f'SELECT season, reach, seepage_ml, lined, seepage_rank, run_id, run_label, run_at '
                f'FROM "{SYNC_SCHEMA}".ops_outlook_reach_seepage ORDER BY season, seepage_rank'))
        except Exception as e:  # not synced yet, or the grant has not run
            out["reason"] = str(e).splitlines()[0][:300]
        out["notes"] = _rows(c.execute(
            f'SELECT note_id, bore_id, season, status, note, author, created_at FROM "{NOTES_SCHEMA}".field_notes '
            f'ORDER BY created_at DESC LIMIT 200'))
        return out


def add_note(bore_id: str, season: str | None, status: str, note: str, author: str) -> dict:
    with _connect() as c:
        _ensure(c)
        r = c.execute(f'INSERT INTO "{NOTES_SCHEMA}".field_notes (bore_id, season, status, note, author) '
                      f'VALUES (%s, %s, %s, %s, %s) RETURNING note_id, created_at', (bore_id, season, status, note, author)).fetchone()
        return {"note_id": r[0], "created_at": r[1].isoformat()}
