"""The model buildkit: a MODFLOW 6 package as an editable description, and back again.

A structured (DIS) groundwater-flow package is read into a build document: the grid and its arrays (top, bottoms,
active cells, K, K33, Sy, Ss, starting heads, convertible layers), the time setup, the solver, boundary features
(fixed heads, wells, rivers, drains), recharge and ET, observation points, and schedules (named patterns that anything
changing over time follows). The Studio's Build palette and agents edit the document; compile() writes it back as
MODFLOW 6 files.

Nothing is lost on the way through:
  - a part of the model that was not edited is written back byte for byte from the files it came from, so diffs show
    only real changes;
  - packages and options the document cannot represent (SFR, UZF, MAW, GHB, time series, auxiliary variables, ...) are
    kept exactly as they were and reported as locked;
  - when the package's files change underneath the document (an agent edits a file as text, a new upload), load()
    reads it again and keeps the document's own form (named schedules) for every part whose files did not change.

Schedules: one year of monthly factors (kind "months"), optionally on/off only, or one factor per stress period
(kind "series", from imports or data), with overrides that multiply a span of periods. For wells, recharge and ET the
factor multiplies the rate; for fixed heads, rivers and drains it switches the feature on (factor > 0) or off.
"""
from __future__ import annotations

import base64
import calendar
import copy
import hashlib
import io
import json
import os
import re
import shutil
import zipfile
import zlib
from datetime import date
from pathlib import Path

import numpy as np

from mf6files import ModelError, _root, validate_zip

FORMAT = "modflow-os-build/1"
BOUNDARY_TYPES = {"chd": "CHD6", "wel": "WEL6", "riv": "RIV6", "drn": "DRN6", "ghb": "GHB6"}
LEVEL_TYPES = {"chd", "riv", "drn", "ghb"}
FIELDS = {"chd": ["head"], "wel": ["q"], "riv": ["stage", "cond", "rbot"], "drn": ["elev", "cond"], "ghb": ["bhead", "cond"]}  # a schedule switches these on and off; it scales wells, recharge and ET
PER_YEAR = {"days": 365.25, "years": 1.0, "hours": 8766.0, "minutes": 525960.0, "seconds": 31557600.0}
DAYS_PER_UNIT = {"days": 1.0, "years": 365.25, "hours": 1 / 24, "minutes": 1 / 1440, "seconds": 1 / 86400}
ARRAY3 = ("botm", "idomain", "k", "k33", "icelltype", "sy", "ss", "strt")
OUTPUT_SUFFIXES = {".hds", ".cbc", ".bud", ".lst", ".grb", ".ucn", ".cbb", ".csv"}


# ---------------------------------------------------------------- arrays in JSON: float32, zlib, base64
def enc(a) -> dict:
    a = np.ascontiguousarray(np.asarray(a, dtype="<f4"))
    return {"z": base64.b64encode(zlib.compress(a.tobytes(), 6)).decode(), "shape": list(a.shape)}


def dec(v) -> np.ndarray:
    return np.frombuffer(zlib.decompress(base64.b64decode(v["z"])), "<f4").reshape(v["shape"]).astype(float)


def A(doc: dict, key: str) -> np.ndarray:
    return dec(doc["arrays"][key])


def put(doc: dict, key: str, a) -> None:
    doc["arrays"][key] = enc(a)


def sha(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()


# ---------------------------------------------------------------- schedules
def period_months(doc: dict) -> list[int | None]:
    """Calendar month (1-12) at the middle of each stress period, None for steady-state periods."""
    t = doc["time"]
    y, m = (int(x) for x in (t.get("start") or "2025-01").split("-")[:2])
    per_day = DAYS_PER_UNIT.get(doc.get("time_units", "days"), 1.0)
    start, out, el = date(y, m, 1).toordinal(), [], 0.0
    for p in t["periods"]:
        days = p["perlen"] * per_day
        if p.get("steady"):
            out.append(None)
            continue  # a steady-state period does not advance the calendar
        mid = date.fromordinal(int(start + el + days / 2))
        out.append(mid.month)
        el += days
    return out


def factors(doc: dict, name: str | None) -> list[float]:
    nper = len(doc["time"]["periods"])
    if not name:
        return [1.0] * nper
    s = doc["schedules"].get(name)
    if s is None:
        raise ModelError(f"No schedule called {name}.")
    if s["kind"] == "series":
        f = list(s["factors"])[:nper]
        f += [f[-1] if f else 1.0] * (nper - len(f))
    else:
        mon = period_months(doc)
        mean = float(np.mean(s["factors"]))
        f = [mean if mo is None else float(s["factors"][mo - 1]) for mo in mon]
    for o in s.get("overrides") or []:
        for p in range(max(0, int(o["from"])), min(nper - 1, int(o["to"])) + 1):
            f[p] *= float(o["factor"])
    return [float(x) for x in f]


# ---------------------------------------------------------------- sections: what goes in each file
def _sched_defs(doc: dict, names) -> dict:
    return {n: doc["schedules"].get(n) for n in sorted({n for n in names if n})}


def section_payloads(doc: dict) -> dict[str, object]:
    """Everything that determines each file's content, so an unchanged part can be written back verbatim."""
    ar, t = doc["arrays"], doc["time"]
    out = {
        "tdis": [t, doc.get("time_units")],
        "ims": doc.get("solver"),
        "dis": [doc["grid"], ar["top"], ar["botm"], ar["idomain"], doc.get("length_units"),
                {k: v for k, v in (doc.get("georef") or {}).items() if k != "epsg"}],
        "npf": [ar["k"], ar["k33"], ar["icelltype"], doc.get("npf_options")],
        "ic": [ar["strt"]],
        "sto": [ar["sy"], ar["ss"], ar["icelltype"], [p.get("steady") for p in t["periods"]]] if doc.get("has_sto", True) else None,
        "oc": "fixed",
        "obs": doc.get("obs") or None,  # an empty list is no package: the name file must change when one appears
        "rch": [doc.get("recharge"), t, _sched_defs(doc, [(doc.get("recharge") or {}).get("schedule")])] if doc.get("recharge") else None,
        "evt": [doc.get("et"), t, _sched_defs(doc, [(doc.get("et") or {}).get("schedule")])] if doc.get("et") else None,
    }
    for pk in sorted({(b["type"], b["pkg"]) for b in doc["boundaries"]}):
        items = [b for b in doc["boundaries"] if (b["type"], b["pkg"]) == pk]
        out[f"pkg:{pk[0]}:{pk[1]}"] = [items, t, _sched_defs(doc, [b.get("schedule") for b in items])]
    out["nam"] = [sorted(k for k, v in out.items() if v is not None), doc.get("options"), doc.get("passthrough")]
    out["sim"] = [doc.get("model_name"), out["nam"]]
    return {k: v for k, v in out.items() if v is not None}


def section_hashes(doc: dict) -> dict[str, str]:
    return {k: sha(json.dumps(v, sort_keys=True, default=str).encode()) for k, v in section_payloads(doc).items()}


# ---------------------------------------------------------------- import: a package into a document
def _period_blocks(text: str) -> list[int]:
    """0-based periods that have an explicit PERIOD block (an empty block switches everything off)."""
    return sorted({int(m.group(1)) - 1 for m in re.finditer(r"^\s*BEGIN\s+PERIOD\s+(\d+)", text, re.I | re.M)})


def _records_by_period(pkg, text: str, nper: int) -> list[list]:
    data = pkg.stress_period_data.get_data() or {}
    blocks = _period_blocks(text)
    cur, out = [], []
    for p in range(nper):
        if p in blocks:
            d = data.get(p)
            cur = [] if d is None else list(d)
        out.append(cur)
    return out


def _nam_lines(text: str) -> list[tuple[str, str, str]]:
    m = re.search(r"BEGIN\s+PACKAGES(.*?)END\s+PACKAGES", text, re.I | re.S)
    rows = []
    for line in (m.group(1) if m else "").splitlines():
        parts = line.split("#")[0].split()
        if len(parts) >= 2:
            rows.append((parts[0].upper(), parts[1], parts[2] if len(parts) > 2 else ""))
    return rows


def _cells_of(p, nper: int) -> list[list[int]]:
    """Where a package acts, as [layer, row, col] cells, whatever kind it is (list stress data, SFR/UZF reaches,
    LAK/MAW connections)."""
    if p is None:
        return []
    out = []
    try:
        t = p.package_type.lower()
        if hasattr(p, "stress_period_data") and t not in ("sfr", "uzf", "lak", "maw"):
            d = p.stress_period_data.get_data() or {}
            recs = next((v for v in d.values() if v is not None and len(v)), None)
            out = [list(map(int, r["cellid"])) for r in (recs if recs is not None else []) if isinstance(r["cellid"], tuple) and len(r["cellid"]) == 3]
        elif t in ("sfr", "uzf"):
            out = [list(map(int, r["cellid"])) for r in p.packagedata.get_data() if isinstance(r["cellid"], tuple) and len(r["cellid"]) == 3]
        elif t in ("lak", "maw"):
            out = [list(map(int, r["cellid"])) for r in p.connectiondata.get_data() if isinstance(r["cellid"], tuple) and len(r["cellid"]) == 3]
    except Exception:
        return []
    return [list(x) for x in dict.fromkeys(tuple(c) for c in out)]


def import_package(data: bytes, workdir: str, name: str) -> dict:
    """Read a package into a build document. Parts that cannot be represented are kept verbatim (locked)."""
    import flopy

    names = validate_zip(data)
    root = _root(names)
    shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(workdir)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(workdir)
        raw = {n[len(root):]: z.read(n) for n in names if n.startswith(root)}
    ws = os.path.join(workdir, root)
    doc = {"format": FORMAT, "name": name, "editable": False, "why_not": None, "locked": [], "passthrough": [],
           "boundaries": [], "schedules": {}, "obs": [], "recharge": None, "et": None, "files": {}, "file_sha": {}}
    import mf6files
    try:
        eng = mf6files.detect(ws)
    except ModelError as e:
        doc["why_not"] = str(e)
        return doc
    if eng["engine"] != "mf6":
        doc["engine"] = eng["engine"]
        doc["convertible"] = eng["engine"] in ("mf2005", "mfnwt")
        doc["why_not"] = (f"This is a {mf6files.ENGINES[eng['engine']]} model: it runs and draws as it is. "
                          + ("Convert a copy to MODFLOW 6 to edit it here (the USGS mf5to6 converter; results match to millimetres)."
                             if doc["convertible"] else "Editing here is for MODFLOW 6 models, and there is no converter for USG."))
        return doc
    try:
        sim = flopy.mf6.MFSimulation.load(sim_ws=ws, verbosity_level=0)
    except Exception as e:
        doc["why_not"] = f"FloPy could not load the package: {e}"[:400]
        return doc
    if len(sim.model_names) != 1:
        doc["why_not"] = "Only simulations with a single groundwater-flow model can be edited; this one is kept as uploaded."
        return doc
    gwf = sim.get_model(sim.model_names[0])
    if gwf.model_type != "gwf6" or getattr(gwf, "dis", None) is None or gwf.modelgrid.grid_type != "structured":
        doc["why_not"] = "Only structured-grid (DIS) groundwater-flow models can be edited; this one is kept as uploaded."
        return doc
    mg, dis = gwf.modelgrid, gwf.dis
    nlay, nrow, ncol = int(mg.nlay), int(mg.nrow), int(mg.ncol)
    tdis = sim.tdis
    tu = str(tdis.time_units.get_data() or "days").lower()
    pdata = tdis.perioddata.get_data()
    nper = len(pdata)
    start = tdis.start_date_time.get_data()
    doc.update({"model_name": gwf.name, "time_units": tu if tu in PER_YEAR else "days",
                "length_units": str(dis.length_units.get_data() or "meters").lower(),
                "grid": {"nlay": nlay, "nrow": nrow, "ncol": ncol, "delr": [float(x) for x in mg.delr], "delc": [float(x) for x in mg.delc]}})
    doc["georef"] = {k: v for k, v in mf6files.georef(mg, ws).items() if k in ("xorigin", "yorigin", "angrot", "epsg")}
    nt = gwf.name_file
    newton = nt.newtonoptions.get_data()
    doc["options"] = {"newton": bool(newton is not None and len(newton)), "under_relaxation": bool(newton is not None and len(newton) and "UNDER_RELAXATION" in str(newton).upper())}
    one = lambda v, fill: np.broadcast_to(np.asarray(fill if v is None else v, float), (nlay, nrow, ncol)).copy()
    doc["arrays"] = {}
    put(doc, "top", np.broadcast_to(np.asarray(dis.top.array, float), (nrow, ncol)))
    put(doc, "botm", one(dis.botm.array, 0))
    put(doc, "idomain", one(dis.idomain.array, 1))
    npf = getattr(gwf, "npf", None)
    k = one(npf.k.array if npf else None, 1.0)
    put(doc, "k", k)
    put(doc, "k33", one(npf.k33.array if npf and npf.k33.has_data() else None, 0) if npf and npf.k33.has_data() else k)
    put(doc, "icelltype", one(npf.icelltype.array if npf else None, 0))
    sto = getattr(gwf, "sto", None)
    doc["has_sto"] = sto is not None
    put(doc, "sy", one(sto.sy.array if sto is not None and sto.sy.has_data() else None, 0.1))
    put(doc, "ss", one(sto.ss.array if sto is not None and sto.ss.has_data() else None, 1e-5))
    ic = getattr(gwf, "ic", None)
    put(doc, "strt", one(ic.strt.array if ic is not None else None, 0) if ic is not None else np.broadcast_to(np.asarray(dis.top.array, float), (nlay, nrow, ncol)))
    doc["npf_options"] = {"save_specific_discharge": bool(npf and npf.save_specific_discharge.get_data())}

    # steady or transient, period by period (MF6: steady unless a STO period block says transient)
    steady = [True] * nper
    if sto is not None:
        text = raw.get(sto.filename, b"").decode(errors="replace")
        state, blocks = True, dict(re.findall(r"BEGIN\s+PERIOD\s+(\d+)\s*\n\s*(STEADY-STATE|TRANSIENT)", text, re.I))
        for p in range(nper):
            if str(p + 1) in blocks:
                state = blocks[str(p + 1)].upper() == "STEADY-STATE"
            steady[p] = state
    doc["time"] = {"start": None, "periods": [{"perlen": float(r[0]), "nstp": int(r[1]), "tsmult": float(r[2]), "steady": steady[i]} for i, r in enumerate(pdata)]}
    if start:
        m = re.match(r"(\d{4})-(\d{2})", str(start))
        doc["time"]["start"] = f"{m.group(1)}-{m.group(2)}" if m else None
    doc["time_start_raw"] = str(start) if start else None

    ims = sim.get_package("ims")
    doc["solver"] = "as_uploaded" if ims is not None else "standard"

    # packages: each managed type read into the document, or kept verbatim with the reason
    nam_text = raw.get(gwf.name_file.filename, b"").decode(errors="replace")
    lines = _nam_lines(nam_text)
    by_file = {p.filename: p for p in gwf.packagelist}
    series_groups: dict[str, str] = {}

    def schedule_for(vec: list[float], prefix: str) -> str | None:
        if all(abs(x - 1) < 1e-9 for x in vec):
            return None
        key = json.dumps([round(x, 6) for x in vec])
        if key not in series_groups:
            nm = f"{prefix} pattern {sum(1 for v in series_groups.values() if v.startswith(prefix)) + 1}"
            series_groups[key] = nm
            doc["schedules"][nm] = {"kind": "series", "factors": [round(x, 6) for x in vec], "onoff": all(x in (0, 1) for x in vec), "overrides": [], "imported": True}
        return series_groups[key]

    def lock(ftype, fname, pname, why):
        doc["passthrough"].append([ftype, fname, pname])
        doc["locked"].append({"what": f"{ftype.removesuffix('6')} {fname}", "reason": why, "file": fname})
        cells = _cells_of(by_file.get(fname), nper)
        if cells:
            doc.setdefault("display", []).append({"type": ftype.removesuffix("6").lower(), "name": pname, "file": fname, "cells": cells[:20000]})

    for ftype, fname, pname in lines:
        p = by_file.get(fname)
        kind = ftype.removesuffix("6").lower()
        text = raw.get(fname, b"").decode(errors="replace")
        if ftype in ("DIS6", "NPF6", "STO6", "IC6", "OC6"):
            sec = kind
            if ftype == "NPF6" and p is not None and (p.k22.has_data() or p.angle1.has_data() or p.wetdry.has_data() or p.xt3doptions.get_data() or p.rewet_record.get_data()):
                lock(ftype, fname, pname, "K22, rotation angles, rewetting or XT3D are not editable here")
                doc["npf_locked"] = True
                continue
            doc["files"][sec] = fname
            continue
        if p is None:
            lock(ftype, fname, pname, "FloPy did not load this package")
            continue
        if kind in BOUNDARY_TYPES:
            opts = text.upper()
            has_aux = bool(re.search(r"^\s*AUX(ILIARY)?\s", text, re.I | re.M))
            if "TS6" in opts or "TAS6" in opts or "OBS6" in opts or has_aux or "MOVER" in opts:
                lock(ftype, fname, pname, "uses time series, observations, auxiliary variables or the mover")
                continue
            recs = _records_by_period(p, text, nper)
            fld = FIELDS[kind]
            bnames = "boundname" in (recs[0][0].dtype.names if any(recs) and len(recs[0]) else ())
            cells: dict[tuple, dict] = {}
            ok = True
            for per, rs in enumerate(recs):
                for r in rs:
                    cid = tuple(int(x) for x in r["cellid"])
                    vals = [r[f] for f in fld]
                    if any(isinstance(v, (str, bytes)) for v in vals):
                        ok = False
                        break
                    c = cells.setdefault(cid, {"vals": {}, "name": str(r["boundname"]) if bnames else None})
                    c["vals"][per] = [float(v) for v in vals]
                if not ok:
                    break
            if not ok:
                lock(ftype, fname, pname, "values are time-series names")
                continue
            groups: dict[tuple, dict] = {}
            for cid, c in cells.items():
                if kind == "wel":
                    base = next((v[0] for v in c["vals"].values() if abs(v[0]) > 0), 0.0)
                    vec = [0.0 if per not in c["vals"] else (c["vals"][per][0] / base if base else 0.0) for per in range(nper)]
                    doc["boundaries"].append({"id": f"W{len([b for b in doc['boundaries'] if b['type'] == 'wel']) + 1}", "type": "wel", "pkg": pname,
                                              "label": c["name"] or "", "cells": [list(cid)], "rate": [-base], "schedule": schedule_for(vec, "Wells")})
                    continue
                present = [per in c["vals"] for per in range(nper)]
                first = next(v for v in c["vals"].values())
                if any(any(abs(a - b) > 1e-9 for a, b in zip(v, first)) for v in c["vals"].values()):
                    ok = False
                    break
                gk = (tuple(present), c["name"])
                g = groups.setdefault(gk, {"cells": [], "vals": []})
                g["cells"].append(list(cid))
                g["vals"].append(first)
            if not ok:
                lock(ftype, fname, pname, "values change from period to period (only on/off is editable)")
                doc["boundaries"] = [b for b in doc["boundaries"] if b["pkg"] != pname]
                continue
            for i, ((present, bname), g) in enumerate(groups.items()):
                vec = [1.0 if x else 0.0 for x in present]
                v = np.array(g["vals"])
                b = {"id": f"{kind.upper()}-{pname}-{i + 1}", "type": kind, "pkg": pname, "label": bname or pname,
                     "cells": g["cells"], "schedule": schedule_for(vec, {"chd": "Heads", "riv": "Rivers", "drn": "Drains", "ghb": "General heads"}[kind])}
                for j, f in enumerate(fld):
                    b[f] = [round(float(x), 6) for x in v[:, j]]
                doc["boundaries"].append(b)
            doc["files"][f"pkg:{kind}:{pname}"] = fname
            continue
        if kind in ("rch", "evt"):
            arrays_mode = p.package_type in ("rcha", "evta")
            if not arrays_mode or "TAS6" in text.upper() or re.search(r"^\s*AUX", text, re.I | re.M):
                lock(ftype, fname, pname, "list-based or time-series recharge/ET is kept as uploaded")
                continue
            if (kind == "rch" and doc["recharge"]) or (kind == "evt" and doc["et"]):
                lock(ftype, fname, pname, "a second recharge/ET package is kept as uploaded")
                continue
            per_year = PER_YEAR[doc["time_units"]]
            field = p.recharge if kind == "rch" else p.rate
            d = field.get_data() or {}
            blocks = _period_blocks(text)
            cur, series = None, []
            for per in range(nper):
                if per in d and d[per] is not None:
                    cur = np.broadcast_to(np.asarray(d[per], float), (nrow, ncol))
                series.append(cur)
            base = next((s for s in series if s is not None and np.abs(s).max() > 0), series[0])
            if base is None:
                base = np.zeros((nrow, ncol))
            vec, fine = [], True
            for s in series:
                if s is None:
                    vec.append(0.0)
                    continue
                nz = np.abs(base) > 0
                f = float(np.median(s[nz] / base[nz])) if nz.any() else 1.0
                if not np.allclose(s, base * f, rtol=1e-5, atol=1e-12):
                    fine = False
                    break
                vec.append(f)
            if not fine:
                lock(ftype, fname, pname, "the recharge/ET pattern changes cell by cell over time (only a whole-model factor is editable)")
                continue
            entry = {"rate_mm_yr": enc(base * per_year * 1000), "schedule": schedule_for(vec, "Recharge" if kind == "rch" else "ET"), "pname": pname}
            if kind == "evt":
                surf, dep = p.surface.get_data(), p.depth.get_data()
                s0 = surf.get(0) if isinstance(surf, dict) else surf
                d0 = dep.get(0) if isinstance(dep, dict) else dep
                entry["surface"] = enc(np.broadcast_to(np.asarray(s0 if s0 is not None else dis.top.array, float), (nrow, ncol)))
                entry["depth"] = enc(np.broadcast_to(np.asarray(d0 if d0 is not None else 2.0, float), (nrow, ncol)))
                doc["et"] = entry
            else:
                doc["recharge"] = entry
            doc["files"][kind] = fname
            continue
        if ftype == "OBS6":
            cont = p.continuous.get_data() or {}
            recs = [r for v in cont.values() for r in v]
            if any(str(r[1]).lower() != "head" for r in recs) or len(cont) > 1:
                lock(ftype, fname, pname, "observations other than heads are kept as uploaded")
                continue
            doc["obs"] = [{"name": str(r[0]), "cell": [int(x) for x in r[2]]} for r in recs]
            doc["obs_file"] = next(iter(cont), f"{gwf.name}.head.obs.csv")
            doc["files"]["obs"] = fname
            continue
        lock(ftype, fname, pname, f"{ftype.removesuffix('6')} is not in the Build palette yet")

    doc["files"]["tdis"] = sim.tdis.filename
    if ims is not None:
        doc["files"]["ims"] = ims.filename
    doc["files"]["nam"] = gwf.name_file.filename
    doc["files"]["sim"] = "mfsim.nam"
    doc["editable"] = True
    _stamp(doc, raw)
    return doc


def _stamp(doc: dict, raw: dict[str, bytes]) -> None:
    """Record what each part looked like in these files, so compile() keeps unchanged parts verbatim."""
    doc["origin"] = section_hashes(doc)
    doc["file_sha"] = {k: sha(raw[f]) for k, f in doc["files"].items() if f in raw}
    doc["base_files"] = sorted(raw)


# ---------------------------------------------------------------- a blank model
def blank(name: str, nrow: int, ncol: int, cell_m: float, nlay: int, top: float, bottom: float, k: float = 10.0,
          transient: bool = False) -> dict:
    doc = {"format": FORMAT, "name": name, "editable": True, "why_not": None, "locked": [], "passthrough": [], "boundaries": [],
           "schedules": {}, "obs": [], "recharge": None, "et": None, "files": {}, "file_sha": {}, "origin": {}, "base_files": [],
           "model_name": "gwf", "time_units": "days", "length_units": "meters", "has_sto": True,
           "grid": {"nlay": nlay, "nrow": nrow, "ncol": ncol, "delr": [float(cell_m)] * ncol, "delc": [float(cell_m)] * nrow},
           "options": {"newton": True, "under_relaxation": True}, "npf_options": {"save_specific_discharge": True}, "solver": "standard",
           "time": {"start": "2025-01", "periods": [{"perlen": 1.0, "nstp": 1, "tsmult": 1.0, "steady": True}]}, "arrays": {}}
    shape = (nlay, nrow, ncol)
    put(doc, "top", np.full((nrow, ncol), top))
    put(doc, "botm", np.stack([np.full((nrow, ncol), top - (top - bottom) * (i + 1) / nlay) for i in range(nlay)]))
    put(doc, "idomain", np.ones(shape))
    for key, v in (("k", k), ("k33", k), ("icelltype", 0), ("sy", 0.1), ("ss", 1e-5), ("strt", top - 1)):
        put(doc, key, np.full(shape, v))
    a = A(doc, "icelltype")
    a[0] = 1  # the top layer is convertible (it holds the water table)
    put(doc, "icelltype", a)
    if transient:
        set_time(doc, True, "2025-01", "month", 12, 2, True)
    # a starting point that solves: a fixed head along the west edge and light recharge, both easy to change or remove
    apply_op(doc, {"op": "add_chd", "edge": "west", "layers": "all", "head": round(top - 2, 3), "label": "West boundary"})
    apply_op(doc, {"op": "set_recharge", "mm_per_year": 50.0})
    return doc


def set_time(doc: dict, transient: bool, start: str | None, period, count: int, nstp: int, steady_first: bool) -> None:
    if not transient:
        doc["time"] = {"start": start or doc["time"].get("start"), "periods": [{"perlen": 1.0, "nstp": 1, "tsmult": 1.0, "steady": True}]}
        return
    y, m = (int(x) for x in (start or "2025-01").split("-")[:2])
    per = []
    if steady_first:
        per.append({"perlen": 1.0, "nstp": 1, "tsmult": 1.0, "steady": True})
    to_units = 1 / DAYS_PER_UNIT.get(doc.get("time_units", "days"), 1.0)
    for i in range(int(count)):
        if period == "month":
            yy, mm = y + (m - 1 + i) // 12, (m - 1 + i) % 12 + 1
            days = calendar.monthrange(yy, mm)[1]
        elif period == "week":
            days = 7
        else:
            days = float(period)
        per.append({"perlen": days * to_units, "nstp": int(nstp), "tsmult": 1.0, "steady": False})
    doc["time"] = {"start": f"{y:04d}-{m:02d}", "periods": per}


# ---------------------------------------------------------------- compile: a document into files
def compile_doc(doc: dict, base: bytes | None, workdir: str) -> dict[str, bytes]:
    """MODFLOW 6 input files for the document. Unchanged parts come back verbatim from `base`; locked parts always do."""
    import flopy

    if not doc.get("editable"):
        raise ModelError(doc.get("why_not") or "This package cannot be edited.")
    raw: dict[str, bytes] = {}
    if base:
        names = validate_zip(base)
        root = _root(names)
        with zipfile.ZipFile(io.BytesIO(base)) as z:
            raw = {n[len(root):]: z.read(n) for n in names if n.startswith(root) and not n.endswith("/")}
    shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(workdir)
    g, t, ar = doc["grid"], doc["time"], doc["arrays"]
    nlay, nrow, ncol = g["nlay"], g["nrow"], g["ncol"]
    nper = len(t["periods"])
    mname = doc.get("model_name") or "gwf"
    files = doc.setdefault("files", {})
    fn = lambda sec, default: files.setdefault(sec, default)  # the name is kept, so the next save can write this part back verbatim
    sim = flopy.mf6.MFSimulation(sim_name="mfsim", sim_ws=workdir, exe_name="mf6", verbosity_level=0)
    flopy.mf6.ModflowTdis(sim, nper=nper, time_units=doc.get("time_units", "days"), filename=fn("tdis", f"{mname}.tdis"),
                          start_date_time=doc.get("time_start_raw") if doc.get("time_start_raw") and t.get("start") and doc["time_start_raw"].startswith(t["start"]) else (f"{t['start']}-01T00:00:00" if t.get("start") and any(not p.get("steady") for p in t["periods"]) else None),
                          perioddata=[(p["perlen"], p["nstp"], p.get("tsmult", 1.0)) for p in t["periods"]])
    ims_file = fn("ims", f"{mname}.ims")
    if doc.get("solver") == "robust":
        ims = flopy.mf6.ModflowIms(sim, complexity="COMPLEX", outer_maximum=500, inner_maximum=500, outer_dvclose=1e-3, backtracking_number=20,
                                   under_relaxation="DBD", linear_acceleration="BICGSTAB", filename=ims_file)
    else:
        ims = flopy.mf6.ModflowIms(sim, complexity="MODERATE", outer_maximum=200, inner_maximum=300, filename=ims_file)
    o = doc.get("options") or {}
    gwf = flopy.mf6.ModflowGwf(sim, modelname=mname, save_flows=True, model_nam_file=fn("nam", f"{mname}.nam"),
                               newtonoptions=("NEWTON UNDER_RELAXATION" if o.get("under_relaxation") else "NEWTON") if o.get("newton") else None)
    geo = doc.get("georef") or {}
    flopy.mf6.ModflowGwfdis(gwf, nlay=nlay, nrow=nrow, ncol=ncol, delr=g["delr"], delc=g["delc"], top=dec(ar["top"]), botm=dec(ar["botm"]),
                            idomain=dec(ar["idomain"]).astype(int), length_units=doc.get("length_units", "meters"), filename=fn("dis", f"{mname}.dis"),
                            xorigin=geo.get("xorigin") or None, yorigin=geo.get("yorigin") or None, angrot=geo.get("angrot") or None)
    icell = dec(ar["icelltype"]).astype(int)
    if not doc.get("npf_locked"):
        flopy.mf6.ModflowGwfnpf(gwf, icelltype=icell, k=dec(ar["k"]), k33=dec(ar["k33"]), filename=fn("npf", f"{mname}.npf"),
                                save_specific_discharge=(doc.get("npf_options") or {}).get("save_specific_discharge", True))
    if doc.get("has_sto", True):
        st = [p.get("steady", False) for p in t["periods"]]
        ss_blocks = {i: True for i in range(nper) if st[i] and (i == 0 or not st[i - 1])}
        tr_blocks = {i: True for i in range(nper) if not st[i] and (i == 0 or st[i - 1])}
        flopy.mf6.ModflowGwfsto(gwf, iconvert=icell, sy=dec(ar["sy"]), ss=dec(ar["ss"]), steady_state=ss_blocks or None,
                                transient=tr_blocks or None, filename=fn("sto", f"{mname}.sto"))
    flopy.mf6.ModflowGwfic(gwf, strt=dec(ar["strt"]), filename=fn("ic", f"{mname}.ic"))

    top = dec(ar["top"])
    empties: dict[str, list[int]] = {}
    for (kind, pname) in sorted({(b["type"], b["pkg"]) for b in doc["boundaries"]}):
        items = [b for b in doc["boundaries"] if (b["type"], b["pkg"]) == (kind, pname)]
        spd, prev = {}, None
        for per in range(nper):
            recs = []
            for b in items:
                f = factors(doc, b.get("schedule"))[per]
                if kind in LEVEL_TYPES and f <= 1e-9:
                    continue
                for j, cid in enumerate(b["cells"]):
                    cid = tuple(int(x) for x in cid)
                    if kind == "wel":
                        q = -float(b["rate"][j]) * f
                        if q != 0:
                            recs.append([cid, q])
                    elif kind == "chd":
                        recs.append([cid, float(b["head"][j])])
                    elif kind == "riv":
                        recs.append([cid, float(b["stage"][j]), float(b["cond"][j]), float(b["rbot"][j])])
                    elif kind == "ghb":
                        recs.append([cid, float(b["bhead"][j]), float(b["cond"][j])])
                    else:
                        recs.append([cid, float(b["elev"][j]), float(b["cond"][j])])
            if recs != prev:
                spd[per] = recs
                prev = recs
        cls = {"chd": flopy.mf6.ModflowGwfchd, "wel": flopy.mf6.ModflowGwfwel, "riv": flopy.mf6.ModflowGwfriv, "drn": flopy.mf6.ModflowGwfdrn,
               "ghb": flopy.mf6.ModflowGwfghb}[kind]
        pfile = fn(f"pkg:{kind}:{pname}", f"{mname}.{pname}.{kind}")
        cls(gwf, pname=pname, filename=pfile, stress_period_data={p_: v for p_, v in spd.items() if v}, maxbound=max([len(v) for v in spd.values()] + [1]))
        empties[pfile] = sorted(p_ for p_, v in spd.items() if not v)
    per_year = PER_YEAR.get(doc.get("time_units", "days"), 365.25)
    for kind in ("rch", "evt"):
        e = doc.get("recharge" if kind == "rch" else "et")
        if not e:
            continue
        base = dec(e["rate_mm_yr"]) / 1000.0 / per_year
        fac = factors(doc, e.get("schedule"))
        rates, prev = {}, None
        for per in range(nper):
            if prev is None or fac[per] != prev:
                rates[per] = base * fac[per]
                prev = fac[per]
        if kind == "rch":
            flopy.mf6.ModflowGwfrcha(gwf, pname=e.get("pname") or "rcha", recharge=rates, filename=fn("rch", f"{mname}.rcha"))
        else:
            flopy.mf6.ModflowGwfevta(gwf, pname=e.get("pname") or "evta", surface=dec(e["surface"]) if e.get("surface") else top, rate=rates,
                                     depth=dec(e["depth"]) if e.get("depth") else 2.0, filename=fn("evt", f"{mname}.evta"))
    if doc.get("obs"):
        flopy.mf6.ModflowUtlobs(gwf, digits=10, filename=fn("obs", f"{mname}.obs"),
                                continuous={doc.get("obs_file") or f"{mname}.head.obs.csv": [(o_["name"], "HEAD", tuple(o_["cell"])) for o_ in doc["obs"]]})
    oc_file = fn("oc", f"{mname}.oc")
    flopy.mf6.ModflowGwfoc(gwf, head_filerecord=f"{mname}.hds", budget_filerecord=f"{mname}.cbc", filename=oc_file,
                           saverecord=[("HEAD", "LAST"), ("BUDGET", "LAST")], printrecord=[("BUDGET", "LAST")])
    sim.write_simulation(silent=True)
    for f, ps in empties.items():
        if ps:
            _add_empty_blocks(os.path.join(workdir, f), ps)
    out = {str(f.relative_to(workdir)): f.read_bytes() for f in Path(workdir).rglob("*") if f.is_file()}

    # the model name file lists locked packages too
    nam = fn("nam", f"{mname}.nam")
    if doc.get("passthrough"):
        text = out[nam].decode()
        extra = "".join(f"  {ft}  {f}  {p}\n" for ft, f, p in doc["passthrough"])
        out[nam] = re.sub(r"(END\s+packages)", extra.replace("\\", "\\\\") + r"\1", text, count=1, flags=re.I).encode()
    # parts that did not change are written back byte for byte
    now, origin = section_hashes(doc), doc.get("origin") or {}
    for sec, h in now.items():
        f = files.get(sec)
        if f and (origin.get(sec) == h or sec == "oc") and f in raw and f in out:  # output control is never edited here
            out[f] = raw[f]
    # a regenerated file that says the same thing as before (FloPy stamps the time on line 1) is kept as it was
    body = lambda b: re.sub(rb"^#[^\n]*generated by flopy[^\n]*\n", b"", b, flags=re.I)
    for n in list(out):
        if n in raw and out[n] != raw[n] and body(out[n]) == body(raw[n]):
            out[n] = raw[n]
    # the coordinate reference lives beside the model files (MODFLOW 6 has no place for it)
    if geo.get("epsg"):
        side = json.loads(raw["modflow-os.json"]) if "modflow-os.json" in raw else {}
        if side.get("epsg") != geo["epsg"]:
            out["modflow-os.json"] = json.dumps({**side, "epsg": int(geo["epsg"])}).encode()
    # every other file of the original package (locked packages and what they read) is kept as it was
    managed = set(files.values())
    for n, b in raw.items():
        if n not in out and n not in managed and Path(n).suffix.lower() not in OUTPUT_SUFFIXES:
            out[n] = b
    return out


def _add_empty_blocks(path: str, periods: list[int]) -> None:
    """flopy skips an empty period block, but an empty block is how MODFLOW is told to switch everything off."""
    text = open(path).read()
    head, *blocks = re.split(r"(?=^BEGIN\s+period\s+\d+)", text, flags=re.I | re.M)
    blocks += [f"BEGIN period  {p + 1}\nEND period  {p + 1}\n\n" for p in periods]
    blocks.sort(key=lambda b: int(re.match(r"BEGIN\s+period\s+(\d+)", b, re.I).group(1)))
    open(path, "w").write(head + "".join(b.rstrip("\n") + "\n\n" for b in blocks))


# ---------------------------------------------------------------- merging after the files changed underneath
def merge(old: dict, new: dict) -> dict:
    """A fresh import of changed files, keeping the old document's own form for every part whose file did not change."""
    if not (old.get("editable") and new.get("editable")):
        return new
    same = {sec for sec, h in new.get("file_sha", {}).items() if old.get("file_sha", {}).get(sec) == h and old.get("files", {}).get(sec) == new["files"].get(sec)}
    out = copy.deepcopy(new)
    keep_sched = set()
    for sec in same:
        if sec.startswith("pkg:"):
            _, kind, pname = sec.split(":", 2)
            out["boundaries"] = [b for b in out["boundaries"] if (b["type"], b["pkg"]) != (kind, pname)] + \
                                [b for b in old["boundaries"] if (b["type"], b["pkg"]) == (kind, pname)]
        elif sec in ("rch", "evt"):
            out["recharge" if sec == "rch" else "et"] = old.get("recharge" if sec == "rch" else "et")
        elif sec == "tdis":
            out["time"] = old["time"]
    for b in out["boundaries"]:
        keep_sched.add(b.get("schedule"))
    for e in (out.get("recharge"), out.get("et")):
        if e:
            keep_sched.add(e.get("schedule"))
    for nm, s in old.get("schedules", {}).items():
        if nm in keep_sched or not s.get("imported"):
            out["schedules"][nm] = s
    out["schedules"] = {k: v for k, v in out["schedules"].items() if k in keep_sched or not v.get("imported")}
    out["origin"] = {**new.get("origin", {}), **{k: v for k, v in section_hashes(out).items() if k in same}}
    return out


# ---------------------------------------------------------------- edits shared by the Studio and agents
def _mask(doc: dict, where: dict | None) -> np.ndarray:
    g = doc["grid"]
    nrow, ncol = g["nrow"], g["ncol"]
    where = where or {"all": True}
    m = np.zeros((nrow, ncol), bool)
    if where.get("all"):
        m[:] = True
    if where.get("rect"):
        r0, c0, r1, c1 = where["rect"]
        m[min(r0, r1):max(r0, r1) + 1, min(c0, c1):max(c0, c1) + 1] = True
    if where.get("cells"):
        for r, c in where["cells"]:
            if 0 <= r < nrow and 0 <= c < ncol:
                m[int(r), int(c)] = True
    if where.get("polygon"):
        rr, cc = np.mgrid[0:nrow, 0:ncol].astype(float)
        inside = np.zeros((nrow, ncol), bool)
        pts = [tuple(map(float, p)) for p in where["polygon"]]
        for (r0, c0), (r1, c1) in zip(pts, pts[1:] + pts[:1]):
            with np.errstate(divide="ignore", invalid="ignore"):
                at = c0 + (rr - r0) * (c1 - c0) / (r1 - r0)
            inside ^= ((r0 > rr) != (r1 > rr)) & (cc < at)
        m |= inside
    if where.get("edge"):
        e = where["edge"]
        {"west": lambda: m.__setitem__((slice(None), 0), True), "east": lambda: m.__setitem__((slice(None), ncol - 1), True),
         "north": lambda: m.__setitem__((0, slice(None)), True), "south": lambda: m.__setitem__((nrow - 1, slice(None)), True)}[e]()
    return m


def _layers(doc: dict, layer) -> list[int]:
    n = doc["grid"]["nlay"]
    if layer in (None, "all"):
        return list(range(n))
    ls = layer if isinstance(layer, list) else [layer]
    bad = [x for x in ls if not 0 <= int(x) < n]
    if bad:
        raise ModelError(f"Layer {bad[0]} does not exist (layers 0 to {n - 1}).")
    return [int(x) for x in ls]


def _line_cells(points: list) -> list[tuple[int, int]]:
    path = []
    for a, b in zip(points, points[1:] or points):
        n = max(abs(b[0] - a[0]), abs(b[1] - a[1]))
        seg = [(round(a[0] + (b[0] - a[0]) * i / n), round(a[1] + (b[1] - a[1]) * i / n)) for i in range(n + 1)] if n else [tuple(a)]
        path += [q for q in seg if not path or q != path[-1]]
    return list(dict.fromkeys((int(r), int(c)) for r, c in path))


def _next_id(doc: dict, prefix: str) -> str:
    taken = {b["id"] for b in doc["boundaries"]}
    i = 1
    while f"{prefix}{i}" in taken:
        i += 1
    return f"{prefix}{i}"


def _pkg(doc: dict, kind: str, pname: str | None) -> str:
    if pname:
        return pname
    have = [b["pkg"] for b in doc["boundaries"] if b["type"] == kind]
    return have[0] if have else kind


def apply_op(doc: dict, op: dict) -> str:
    """Apply one edit; returns a plain-language description. The same operations the Build palette performs."""
    o = dict(op)
    kind = o.pop("op")
    g = doc["grid"]
    top = A(doc, "top")
    if kind == "set_property":
        prop, mode, value = o["property"], o.get("mode", "set"), float(o["value"])
        m = _mask(doc, o.get("where"))
        if prop == "top":
            a = top
            a[m] = a[m] * value if mode == "multiply" else a[m] + value if mode == "add" else value
            put(doc, "top", a)
            return f"top {mode} {value:g} on {int(m.sum())} cells"
        if prop not in ARRAY3:
            raise ModelError(f"Unknown property {prop}. Properties: top, {', '.join(ARRAY3)}.")
        a = A(doc, prop)
        for L in _layers(doc, o.get("layer", "all")):
            s = a[L][m]
            a[L][m] = s * value if mode == "multiply" else s + value if mode == "add" else value
        put(doc, prop, a)
        return f"{prop} {mode} {value:g} on {int(m.sum())} cells, layer {o.get('layer', 'all')}"
    if kind == "set_active":
        a = A(doc, "idomain")
        m = _mask(doc, o.get("where"))
        for L in _layers(doc, o.get("layer", "all")):
            a[L][m] = 1 if o.get("active", True) else 0
        put(doc, "idomain", a)
        return f"{'activated' if o.get('active', True) else 'deactivated'} {int(m.sum())} cells"
    if kind == "add_well":
        ls = _layers(doc, o.get("layers", [o.get("layer", 0)]))
        rate = float(o["rate"])
        wid = o.get("id") or _next_id(doc, "W")
        doc["boundaries"].append({"id": wid, "type": "wel", "pkg": _pkg(doc, "wel", o.get("pkg")), "label": o.get("label", ""),
                                  "cells": [[L, int(o["row"]), int(o["col"])] for L in ls], "rate": [rate / len(ls)] * len(ls),
                                  "schedule": o.get("schedule"), "drawn": {"rate": rate, "layers": ls}})
        return f"well {wid} at row {o['row']}, col {o['col']}, {rate:g} m3/d"
    if kind == "add_ghb":
        m = _mask(doc, {"cells": o.get("cells"), "edge": o.get("edge"), "rect": o.get("rect"), "polygon": o.get("polygon")})
        ls = _layers(doc, o.get("layers", "all"))
        cells = [[L, int(r), int(c)] for L in ls for r, c in zip(*np.nonzero(m))]
        mode, h = o.get("head_mode", "abs"), float(o["head"])
        bid = o.get("id") or _next_id(doc, "G")
        doc["boundaries"].append({"id": bid, "type": "ghb", "pkg": _pkg(doc, "ghb", o.get("pkg")), "label": o.get("label", ""), "cells": cells,
                                  "bhead": [round(float(top[c[1], c[2]] - h), 4) if mode == "below_top" else h for c in cells],
                                  "cond": [float(o.get("cond", 100.0))] * len(cells), "schedule": o.get("schedule"),
                                  "drawn": {"head": h, "head_mode": mode, "layers": ls, "cond": float(o.get("cond", 100.0))}})
        return f"general head {bid}: {len(cells)} cells at {h:g} m, conductance {o.get('cond', 100.0):g}"
    if kind == "add_chd":
        m = _mask(doc, {"cells": o.get("cells"), "edge": o.get("edge"), "rect": o.get("rect"), "polygon": o.get("polygon")})
        ls = _layers(doc, o.get("layers", "all"))
        cells = [[L, int(r), int(c)] for L in ls for r, c in zip(*np.nonzero(m))]
        mode, h = o.get("head_mode", "abs"), float(o["head"])
        heads = [round(float(top[c[1], c[2]] - h), 4) if mode == "below_top" else h for c in cells]
        bid = o.get("id") or _next_id(doc, "H")
        doc["boundaries"].append({"id": bid, "type": "chd", "pkg": _pkg(doc, "chd", o.get("pkg")), "label": o.get("label", ""), "cells": cells,
                                  "head": heads, "schedule": o.get("schedule"), "drawn": {"head": h, "head_mode": mode, "layers": ls}})
        return f"fixed head {bid}: {len(cells)} cells at {h:g} m{' below the top' if mode == 'below_top' else ''}"
    if kind in ("add_river", "add_drain"):
        rc = _line_cells(o["points"]) if o.get("points") else [tuple(x) for x in zip(*np.nonzero(_mask(doc, {"edge": o.get("edge")})))]
        L = _layers(doc, o.get("layer", 0))[0]
        n = len(rc)
        if kind == "add_river":
            s0 = float(o["stage_start"])
            s1 = float(o.get("stage_end", s0))
            stage = [round(s0 + (s1 - s0) * i / max(1, n - 1), 4) for i in range(n)]
            bed = float(o.get("bed_depth", 1.0))
            bid = o.get("id") or _next_id(doc, "RV")
            doc["boundaries"].append({"id": bid, "type": "riv", "pkg": _pkg(doc, "riv", o.get("pkg")), "label": o.get("label", ""),
                                      "cells": [[L, r, c] for r, c in rc], "stage": stage, "rbot": [round(s - bed, 4) for s in stage],
                                      "cond": [float(o.get("cond", 100.0))] * n, "schedule": o.get("schedule"),
                                      "drawn": {"points": o.get("points"), "stage_start": s0, "stage_end": s1, "bed_depth": bed, "cond": float(o.get("cond", 100.0))}})
            return f"river {bid}: {n} cells, stage {s0:g} to {s1:g} m"
        mode, e = o.get("elev_mode", "below_top"), float(o.get("elev", 1.5))
        elev = [round(float(top[r, c] - e), 4) if mode == "below_top" else e for r, c in rc]
        bid = o.get("id") or _next_id(doc, "D")
        doc["boundaries"].append({"id": bid, "type": "drn", "pkg": _pkg(doc, "drn", o.get("pkg")), "label": o.get("label", ""),
                                  "cells": [[L, r, c] for r, c in rc], "elev": elev, "cond": [float(o.get("cond", 100.0))] * n,
                                  "schedule": o.get("schedule"), "drawn": {"points": o.get("points"), "elev": e, "elev_mode": mode, "cond": float(o.get("cond", 100.0))}})
        return f"drain {bid}: {n} cells, {e:g} m{' below the top' if mode == 'below_top' else ''}"
    if kind == "remove":
        n0 = len(doc["boundaries"]) + len(doc["obs"])
        doc["boundaries"] = [b for b in doc["boundaries"] if b["id"] != o["id"]]
        doc["obs"] = [x for x in doc["obs"] if x["name"] != o["id"]]
        if len(doc["boundaries"]) + len(doc["obs"]) == n0:
            raise ModelError(f"No feature {o['id']}.")
        return f"removed {o['id']}"
    if kind == "update":
        b = next((x for x in doc["boundaries"] if x["id"] == o["id"]), None)
        if b is None:
            raise ModelError(f"No feature {o['id']}.")
        if "schedule" in o:
            if o["schedule"] and o["schedule"] not in doc["schedules"]:
                raise ModelError(f"No schedule called {o['schedule']}.")
            b["schedule"] = o["schedule"] or None
        if "label" in o:
            b["label"] = o["label"]
        if "rate" in o and b["type"] == "wel":
            b["rate"] = [float(o["rate"]) / len(b["cells"])] * len(b["cells"])
            b.setdefault("drawn", {})["rate"] = float(o["rate"])
        if "head" in o and b["type"] == "chd":
            b["head"] = [float(o["head"])] * len(b["cells"])
        if "head" in o and b["type"] == "ghb":
            b["bhead"] = [float(o["head"])] * len(b["cells"])
        if "cond" in o and b["type"] in ("riv", "drn", "ghb"):
            b["cond"] = [float(o["cond"])] * len(b["cells"])
        return f"updated {o['id']}"
    if kind in ("set_recharge", "set_et"):
        key = "recharge" if kind == "set_recharge" else "et"
        e = doc.get(key) or {"rate_mm_yr": enc(np.zeros((g["nrow"], g["ncol"]))), "schedule": None, "pname": "rcha" if key == "recharge" else "evta"}
        if key == "et" and "surface" not in e:
            e["surface"], e["depth"] = enc(top), enc(np.full((g["nrow"], g["ncol"]), 2.0))
        m = _mask(doc, o.get("where"))
        if "mm_per_year" in o:
            a, v, mode = dec(e["rate_mm_yr"]), float(o["mm_per_year"]), o.get("mode", "set")
            a[m] = a[m] * v if mode == "multiply" else a[m] + v if mode == "add" else v
            e["rate_mm_yr"] = enc(a)
        if key == "et" and "depth_m" in o:
            d = dec(e["depth"])
            d[m] = float(o["depth_m"])
            e["depth"] = enc(d)
        if "schedule" in o:
            e["schedule"] = o["schedule"] or None
        doc[key] = e
        return f"{key} on {int(m.sum())} cells"
    if kind == "add_obs":
        nm = o.get("name") or f"OBS{len(doc['obs']) + 1}"
        doc["obs"].append({"name": nm, "cell": [int(o.get("layer", 0)), int(o["row"]), int(o["col"])]})
        return f"observation point {nm}"
    if kind == "set_time":
        set_time(doc, bool(o.get("transient", True)), o.get("start"), o.get("period", "month"), int(o.get("count", 12)),
                 int(o.get("nstp", 2)), bool(o.get("steady_first", True)))
        return f"time: {len(doc['time']['periods'])} periods"
    if kind == "schedule":
        nm = o["name"]
        f = o.get("factors") or ([1.0] * 12)
        if o.get("kind", "months") == "months" and len(f) != 12:
            raise ModelError("A monthly schedule has 12 factors, January to December.")
        old = doc["schedules"].get(nm, {})
        doc["schedules"][nm] = {"kind": o.get("kind", "months"), "factors": [float(x) for x in f], "onoff": bool(o.get("onoff", False)),
                                "overrides": o.get("overrides", old.get("overrides", []))}
        return f"schedule {nm}"
    if kind == "schedule_override":
        s = doc["schedules"].get(o["name"])
        if s is None:
            raise ModelError(f"No schedule called {o['name']}.")
        s.setdefault("overrides", []).append({"from": int(o["from"]), "to": int(o["to"]), "factor": float(o["factor"]), "label": o.get("label", "")})
        return f"override on {o['name']}: periods {o['from']}-{o['to']} x{o['factor']}"
    if kind == "delete_schedule":
        doc["schedules"].pop(o["name"], None)
        for b in doc["boundaries"]:
            if b.get("schedule") == o["name"]:
                b["schedule"] = None
        for e in (doc.get("recharge"), doc.get("et")):
            if e and e.get("schedule") == o["name"]:
                e["schedule"] = None
        return f"deleted schedule {o['name']}"
    if kind == "set_georef":
        g0 = doc.get("georef") or {}
        doc["georef"] = {**g0, **{k: (float(o[k]) if k != "epsg" else (int(o[k]) if o[k] else None)) for k in ("xorigin", "yorigin", "angrot", "epsg") if k in o}}
        return f"placed at {doc['georef']}"
    if kind == "set_solver":
        doc["solver"] = o["solver"]
        return f"solver {o['solver']}"
    if kind == "resample":
        resample(doc, int(o["nrow"]), int(o["ncol"]), float(o.get("delr", 0)) or None, float(o.get("delc", 0)) or None)
        return f"grid {o['nrow']} x {o['ncol']}"
    if kind == "split_layer":
        split_layer(doc, int(o["layer"]))
        return f"split layer {o['layer']}"
    if kind == "remove_layer":
        remove_layer(doc, int(o["layer"]))
        return f"removed layer {o['layer']}"
    raise ModelError(f"Unknown edit {kind}.")


def resample(doc: dict, nrow: int, ncol: int, delr: float | None, delc: float | None) -> None:
    """A new grid over the same extent (or a new cell size), every array and feature carried across by nearest cell."""
    g = doc["grid"]
    if not (2 <= nrow <= 1000 and 2 <= ncol <= 1000):
        raise ModelError("Rows and columns must be between 2 and 1000.")
    xr, yc = np.cumsum([0] + g["delr"]), np.cumsum([0] + g["delc"])
    W, H = xr[-1], yc[-1]
    dr, dc = (delr or W / ncol), (delc or H / nrow)
    cx, cy = (np.arange(ncol) + 0.5) * dr, (np.arange(nrow) + 0.5) * dc
    ci = np.clip(np.searchsorted(xr, np.minimum(cx, W - 1e-9), side="right") - 1, 0, g["ncol"] - 1)
    ri = np.clip(np.searchsorted(yc, np.minimum(cy, H - 1e-9), side="right") - 1, 0, g["nrow"] - 1)
    for key in ("top",) + ARRAY3:
        a = A(doc, key)
        put(doc, key, a[..., ri[:, None], ci[None, :]])
    for key in ("recharge", "et"):
        e = doc.get(key)
        if e:
            for f in ("rate_mm_yr", "surface", "depth"):
                if e.get(f):
                    e[f] = enc(dec(e[f])[ri[:, None], ci[None, :]])
    ocx, ocy = (xr[:-1] + xr[1:]) / 2, (yc[:-1] + yc[1:]) / 2
    to_c = lambda c: int(np.clip(np.floor(ocx[c] / dr), 0, ncol - 1))
    to_r = lambda r: int(np.clip(np.floor(ocy[r] / dc), 0, nrow - 1))
    for b in doc["boundaries"]:
        seen, keep = set(), []
        for j, (L, r, c) in enumerate(b["cells"]):
            q = (L, to_r(r), to_c(c))
            if q not in seen:
                seen.add(q)
                keep.append((j, list(q)))
        for f in ("head", "rate", "stage", "rbot", "cond", "elev", "bhead"):
            if f in b:
                b[f] = [b[f][j] for j, _ in keep]
        b["cells"] = [q for _, q in keep]
    for o in doc["obs"]:
        o["cell"] = [o["cell"][0], to_r(o["cell"][1]), to_c(o["cell"][2])]
    doc["grid"] = {**g, "nrow": nrow, "ncol": ncol, "delr": [dr] * ncol, "delc": [dc] * nrow}


def split_layer(doc: dict, L: int) -> None:
    g = doc["grid"]
    top, botm = A(doc, "top"), A(doc, "botm")
    upper = top if L == 0 else botm[L - 1]
    mid = (upper + botm[L]) / 2
    put(doc, "botm", np.insert(botm, L, mid, axis=0))
    for key in ARRAY3[1:]:
        a = A(doc, key)
        put(doc, key, np.insert(a, L, a[L], axis=0))
    for b in doc["boundaries"]:
        for c in b["cells"]:
            if c[0] > L:
                c[0] += 1
    for o in doc["obs"]:
        if o["cell"][0] > L:
            o["cell"][0] += 1
    g["nlay"] += 1


def remove_layer(doc: dict, L: int) -> None:
    g = doc["grid"]
    if g["nlay"] <= 1:
        raise ModelError("A model needs at least one layer.")
    botm = A(doc, "botm")
    if L == g["nlay"] - 1:
        botm = np.delete(botm, L, axis=0)  # the layer above now reaches the old base
        botm[-1] = A(doc, "botm")[L]
    else:
        botm = np.delete(botm, L, axis=0)
    put(doc, "botm", botm)
    for key in ARRAY3[1:]:
        put(doc, key, np.delete(A(doc, key), L, axis=0))
    for b in doc["boundaries"]:
        idx = [j for j, c in enumerate(b["cells"]) if c[0] != L]
        for f in ("head", "rate", "stage", "rbot", "cond", "elev", "bhead"):
            if f in b:
                b[f] = [b[f][j] for j in idx]
        b["cells"] = [[c[0] - (1 if c[0] > L else 0), c[1], c[2]] for c in (b["cells"][j] for j in idx)]
    doc["boundaries"] = [b for b in doc["boundaries"] if b["cells"]]
    doc["obs"] = [{**o, "cell": [o["cell"][0] - (1 if o["cell"][0] > L else 0), o["cell"][1], o["cell"][2]]} for o in doc["obs"] if o["cell"][0] != L]
    g["nlay"] -= 1


def summary(doc: dict) -> dict:
    """The document in words and counts, without arrays: what an agent reads before editing."""
    g = doc.get("grid") or {}
    if not doc.get("editable"):
        return {"editable": False, "why_not": doc.get("why_not")}
    a = {k: dec(v) for k, v in doc["arrays"].items()}
    act = a["idomain"] > 0

    def rng(x, L):
        v = x[L][act[L]]
        return None if not len(v) else [round(float(v.min()), 6), round(float(v.max()), 6)]
    feats = {}
    for b in doc["boundaries"]:
        feats.setdefault(b["type"], []).append({"id": b["id"], "label": b.get("label"), "cells": len(b["cells"]), "schedule": b.get("schedule"),
                                                **({"rate_m3_per_day": round(sum(b["rate"]), 3)} if b["type"] == "wel" else {})})
    per = doc["time"]["periods"]
    return {"editable": True, "grid": {"nlay": g["nlay"], "nrow": g["nrow"], "ncol": g["ncol"], "cell_m": [round(float(np.mean(g["delr"])), 3), round(float(np.mean(g["delc"])), 3)]},
            "layers": [{"layer": L, "k": rng(a["k"], L), "k33": rng(a["k33"], L), "sy": rng(a["sy"], L), "ss": rng(a["ss"], L),
                        "convertible": bool(np.any(a["icelltype"][L] > 0)), "active_cells": int(act[L].sum()),
                        "bottom_m": rng(a["botm"], L)} for L in range(g["nlay"])],
            "top_m": [round(float(np.nanmin(a["top"])), 3), round(float(np.nanmax(a["top"])), 3)],
            "time": {"transient": any(not p.get("steady") for p in per), "periods": len(per), "start": doc["time"].get("start"),
                     "steady_first": bool(per and per[0].get("steady")), "time_units": doc.get("time_units")},
            "solver": doc.get("solver"), "features": feats, "obs": [o["name"] for o in doc["obs"]],
            "recharge": None if not doc.get("recharge") else {"mm_per_year": [round(float(dec(doc["recharge"]["rate_mm_yr"]).min()), 2), round(float(dec(doc["recharge"]["rate_mm_yr"]).max()), 2)], "schedule": doc["recharge"].get("schedule")},
            "et": None if not doc.get("et") else {"mm_per_year": round(float(dec(doc["et"]["rate_mm_yr"]).max()), 2), "schedule": doc["et"].get("schedule")},
            "schedules": {k: {"kind": v["kind"], "onoff": v.get("onoff"), "factors": v["factors"], "overrides": v.get("overrides", []),
                              "used_by": [b["id"] for b in doc["boundaries"] if b.get("schedule") == k] + [x for x in ("recharge", "et") if (doc.get(x) or {}).get("schedule") == k]}
                          for k, v in doc["schedules"].items()},
            "locked": doc.get("locked", [])}
