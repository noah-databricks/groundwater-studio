"""Uploaded MODFLOW model packages: validate, inspect, preview and run them as-is.

A package is a zip of native input files: MODFLOW 6 (mfsim.nam), or a classic MODFLOW-2005, MODFLOW-NWT or
MODFLOW-USG model (its name file). The engine is chosen from the name file. Structured grids are drawn as they are;
DISV and unstructured grids are drawn on a regular raster of their cells, and very large grids are coarsened for the
3D view only (the model itself always runs at full resolution). The model's real-world position (origin, rotation,
coordinate reference) is read from the grid, the classic name-file header, or a modflow-os.json sidecar.
"""
from __future__ import annotations

import io
import os
import shutil
import subprocess
import time
import zipfile
from pathlib import Path

import numpy as np

MAX_ZIP_BYTES = 2 * 1024 ** 3  # 2 GB; big uploads arrive in chunks (see the app's /api/upload)
DISPLAY_CELLS = 90_000  # per layer, for the 3D view only
DISPLAY_TIMES = 80
ENGINES = {"mf6": "MODFLOW 6", "mf2005": "MODFLOW-2005", "mfnwt": "MODFLOW-NWT", "mfusg": "MODFLOW-USG"}
TEXT_SUFFIXES = {".nam", ".dis", ".npf", ".sto", ".ic", ".chd", ".riv", ".drn", ".wel", ".rch", ".rcha", ".evt",
                 ".evta", ".ghb", ".oc", ".ims", ".tdis", ".obs", ".lst", ".csv", ".txt", ".json", ".sfr", ".maw",
                 ".uzf", ".lak", ".buy", ".disv", ".disu"}
HDRY = 1e20


class ModelError(ValueError):
    pass


def _root(names: list[str]) -> str:
    """Folder inside the zip that holds the simulation's name file ('' when at the root)."""
    hits = sorted((n for n in names if n.rsplit("/", 1)[-1].lower() == "mfsim.nam"), key=len)
    if hits:
        return hits[0][: -len("mfsim.nam")]
    nams = sorted((n for n in names if n.lower().endswith((".nam", ".mfn"))), key=lambda n: (n.count("/"), len(n)))
    if not nams:
        raise ModelError("Not a MODFLOW package: no mfsim.nam (MODFLOW 6) or model name file (.nam) found in the zip.")
    return nams[0][: len(nams[0]) - len(nams[0].rsplit("/", 1)[-1])]


def _ftypes(nam_text: str) -> list[tuple[str, str]]:
    """(file type, file name) rows of a classic name file."""
    rows = []
    for line in nam_text.splitlines():
        parts = line.split("#")[0].split()
        if len(parts) >= 3 and not parts[0].startswith("#"):
            rows.append((parts[0].upper(), parts[2]))
    return rows


def detect(ws: str) -> dict:
    """Which engine a package needs and its name file: MODFLOW 6 when there is an mfsim.nam, otherwise the classic
    model's name file (USG when it uses DISU or SMS, NWT when it uses NWT or UPW, else MODFLOW-2005). A modflow-os.json
    sidecar may name the engine outright."""
    side = sidecar(ws)
    if os.path.exists(os.path.join(ws, "mfsim.nam")):
        return {"engine": "mf6", "nam": "mfsim.nam"}
    nams = sorted(f for f in os.listdir(ws) if f.lower().endswith((".nam", ".mfn")))
    if not nams:
        raise ModelError("No mfsim.nam or model name file (.nam) in the package.")
    nam = next((n for n in nams if any(t in ("DIS", "DISU", "BAS6") for t, _ in _ftypes(open(os.path.join(ws, n), errors="replace").read()))), nams[0])
    kinds = {t for t, _ in _ftypes(open(os.path.join(ws, nam), errors="replace").read())}
    engine = side.get("engine") or ("mfusg" if kinds & {"DISU", "SMS", "CLN", "GNC"} else "mfnwt" if kinds & {"NWT", "UPW"} else "mf2005")
    if engine not in ENGINES:
        raise ModelError(f"Unknown engine {engine} in modflow-os.json (use one of {', '.join(ENGINES)}).")
    return {"engine": engine, "nam": nam}


def sidecar(ws: str) -> dict:
    import json

    p = os.path.join(ws, "modflow-os.json")
    try:
        return json.load(open(p)) if os.path.exists(p) else {}
    except ValueError:
        return {}


def validate_zip(data: bytes) -> list[str]:
    if len(data) > MAX_ZIP_BYTES:
        raise ModelError(f"Model packages are limited to {MAX_ZIP_BYTES // 2**20} MB.")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ModelError("That file is not a valid zip archive.")
    names = [n for n in z.namelist() if not n.endswith("/")]
    for n in names:
        if n.startswith("/") or ".." in Path(n).parts:
            raise ModelError(f"Unsafe path in archive: {n}")
    _root(names)
    return names


def extract(data: bytes, dest: str) -> str:
    names = validate_zip(data)
    shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(dest)
    return os.path.join(dest, _root(names))


def _load(ws: str):
    import flopy

    sim = flopy.mf6.MFSimulation.load(sim_ws=ws, verbosity_level=0, load_only=None)
    names = list(sim.model_names)
    if not names:
        raise ModelError("The simulation contains no models.")
    return sim, sim.get_model(names[0])


def inspect(data: bytes, workdir: str) -> dict:
    ws = extract(data, workdir)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        files = [{"name": i.filename.rsplit("/", 1)[-1], "path": i.filename, "bytes": i.file_size,
                  "text": Path(i.filename).suffix.lower() in TEXT_SUFFIXES}
                 for i in z.infolist() if not i.filename.endswith("/")]
    eng = detect(ws)
    if eng["engine"] != "mf6":
        m = _load_classic(ws, eng)
        info = {"files": files, "model": m.name, "model_type": ENGINES[eng["engine"]], "engine": eng["engine"],
                "nper": int(m.nper), "time_units": {0: "undefined", 1: "seconds", 2: "minutes", 3: "hours", 4: "days", 5: "years"}.get(int(getattr(m.dis, "itmuni", 4) if hasattr(m, "dis") and m.dis else 4), "days"),
                "packages": [{"type": t, "name": t.lower(), "file": f} for t, f in _ftypes(open(os.path.join(ws, eng["nam"]), errors="replace").read())],
                "grid": {"type": "DISU" if eng["engine"] == "mfusg" and not getattr(m, "structured", True) else "DIS",
                         **({"nlay": int(m.nlay), "nrow": int(m.nrow), "ncol": int(m.ncol)} if getattr(m, "structured", True) else {"nodes": int(m.disu.nodes)})},
                "georef": georef(m.modelgrid, ws)}
        return info
    sim, gwf = _load(ws)
    tdis = sim.tdis
    info = {"files": files, "model": gwf.name, "model_type": gwf.model_type, "engine": "mf6", "georef": georef(gwf.modelgrid, ws),
            "nper": int(tdis.nper.get_data()), "time_units": str(tdis.time_units.get_data() or "days"),
            "packages": [{"type": p.package_type.upper(), "name": p.package_name, "file": p.filename}
                         for p in gwf.packagelist], "grid": None}
    dis = getattr(gwf, "dis", None)
    if dis is not None and gwf.modelgrid.grid_type == "structured":
        mg = gwf.modelgrid
        info["grid"] = {"type": "DIS", "nlay": int(mg.nlay), "nrow": int(mg.nrow), "ncol": int(mg.ncol),
                        "extent_m": [float(np.sum(mg.delr)), float(np.sum(mg.delc))]}
    else:
        info["grid"] = {"type": getattr(gwf.modelgrid, "grid_type", "unknown")}
    return info


def preview(data: bytes, member: str, max_lines: int = 400) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if member not in z.namelist():
            raise ModelError("No such file in the package.")
        raw = z.read(member)[: (64 if max_lines > 10**6 else 2) * 1024 * 1024]
    if b"\x00" in raw[:4096]:
        raise ModelError("Binary file (heads, budget or grid file); download it to open in FloPy.")
    lines = raw.decode("utf-8", errors="replace").splitlines()
    more = f"\n… {len(lines) - max_lines} more lines" if len(lines) > max_lines else ""
    return "\n".join(lines[:max_lines]) + more


def failure(stdout: str, ws: str) -> str:
    """The part of a failed run a modeller needs: MODFLOW's error report, not its licence banner."""
    text = stdout
    for lst in [Path(ws) / "mfsim.lst", *Path(ws).glob("*.lst")]:
        try:
            text += "\n" + lst.read_text(errors="replace")
        except OSError:
            pass
    lines = text.splitlines()
    hits = [i for i, l in enumerate(lines) if "ERROR" in l.upper() or "FAILED TO CONVERGE" in l.upper() or "UNIT" in l.upper() and "OPEN" in l.upper()]
    hint = ""
    if "convergence failure" in text.lower():
        hint = ("\nLikely fixes: a stronger solver (build_model solver='robust', or in the IMS file COMPLEX with more outer "
                "iterations and BACKTRACKING_NUMBER), NEWTON UNDER_RELAXATION in the model name file options, more or smaller "
                "time steps (TDIS NSTP), and less extreme stresses: huge recharge or pumping against low K dries or floods cells.")
    if hits:
        keep: list[str] = []
        for i in hits[:6]:
            for l in lines[i:i + 6]:
                if l.strip() and l not in keep:
                    keep.append(l.rstrip())
        return "\n".join(keep)[:1500] + hint
    start = next((i for i, l in enumerate(lines) if "Run start" in l), max(0, len(lines) - 25))
    return "\n".join(l.rstrip() for l in lines[start:] if l.strip())[-1500:]


def build(spec: dict, workdir: str) -> dict[str, bytes]:
    """Write a structured-grid MODFLOW 6 groundwater-flow model with FloPy from a plain description; return its files."""
    import flopy

    shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(workdir)
    g = spec
    nlay, nrow, ncol = g["nlay"], g["nrow"], g["ncol"]
    botm = g["botm"] if isinstance(g["botm"], list) else [g["top"] - (g["top"] - g["botm"]) * (k + 1) / nlay for k in range(nlay)]
    per = lambda v: v if isinstance(v, list) else [v] * nlay
    steady = g.get("steady", True)
    nper = 1 if steady else g.get("nper", 12)
    sim = flopy.mf6.MFSimulation(sim_name="mfsim", sim_ws=workdir, exe_name="mf6")
    flopy.mf6.ModflowTdis(sim, nper=nper, time_units="days",
                          perioddata=[(g.get("perlen", 1.0 if steady else 30.0), g.get("nstp", 1), 1.0)] * nper)
    if g.get("solver") == "robust":
        flopy.mf6.ModflowIms(sim, complexity="COMPLEX", outer_maximum=500, inner_maximum=500, outer_dvclose=1e-3,
                             backtracking_number=20, under_relaxation="DBD", linear_acceleration="BICGSTAB")
    else:
        flopy.mf6.ModflowIms(sim, complexity="MODERATE", outer_maximum=200, inner_maximum=300)
    gwf = flopy.mf6.ModflowGwf(sim, modelname=g.get("model_name", "gwf"), save_flows=True, newtonoptions="NEWTON UNDER_RELAXATION")
    flopy.mf6.ModflowGwfdis(gwf, nlay=nlay, nrow=nrow, ncol=ncol, delr=g["delr"], delc=g["delc"], top=g["top"], botm=botm, length_units="meters")
    flopy.mf6.ModflowGwfic(gwf, strt=g.get("strt", g["top"]))
    flopy.mf6.ModflowGwfnpf(gwf, icelltype=per(g.get("icelltype", 1)), k=per(g.get("k", 10.0)), k33=per(g.get("k33", g.get("k", 10.0))), save_specific_discharge=True)
    flopy.mf6.ModflowGwfsto(gwf, iconvert=per(g.get("icelltype", 1)), sy=per(g.get("sy", 0.1)), ss=per(g.get("ss", 1e-5)),
                            steady_state={0: True} if steady else None, transient=None if steady else {0: True})

    def cells_of(item: dict) -> list[tuple[int, int, int]]:
        lay = item.get("layer", 0)
        if "edge" in item:
            e = item["edge"]
            rc = ([(r, 0) for r in range(nrow)] if e == "west" else [(r, ncol - 1) for r in range(nrow)] if e == "east"
                  else [(0, c) for c in range(ncol)] if e == "north" else [(nrow - 1, c) for c in range(ncol)])
            layers = range(nlay) if item.get("all_layers", True) else [lay]
            return [(k, r, c) for k in layers for r, c in rc]
        return [(lay, int(r), int(c)) for r, c in item["cells"]]

    if g.get("chd"):
        flopy.mf6.ModflowGwfchd(gwf, stress_period_data={0: [[cid, h["head"]] for h in g["chd"] for cid in cells_of(h)]})
    if g.get("wells"):
        flopy.mf6.ModflowGwfwel(gwf, stress_period_data={0: [[(w.get("layer", 0), w["row"], w["col"]), -abs(w["rate"])] for w in g["wells"]]})
    if g.get("recharge"):
        flopy.mf6.ModflowGwfrcha(gwf, recharge=g["recharge"])
    if g.get("rivers"):
        flopy.mf6.ModflowGwfriv(gwf, pname="riv", stress_period_data={0: [[cid, r["stage"], r.get("cond", 100.0), r.get("rbot", r["stage"] - 1)]
                                                                          for r in g["rivers"] for cid in cells_of(r)]})
    if g.get("drains"):
        flopy.mf6.ModflowGwfdrn(gwf, stress_period_data={0: [[cid, d["elev"], d.get("cond", 100.0)] for d in g["drains"] for cid in cells_of(d)]})
    if g.get("evt_rate"):
        flopy.mf6.ModflowGwfevta(gwf, surface=g["top"], rate=g["evt_rate"], depth=g.get("evt_depth", 2.0))
    flopy.mf6.ModflowGwfoc(gwf, head_filerecord=f"{gwf.name}.hds", budget_filerecord=f"{gwf.name}.cbc",
                           saverecord=[("HEAD", "ALL"), ("BUDGET", "ALL")], printrecord=[("BUDGET", "LAST")])
    sim.write_simulation(silent=True)
    return {str(f.relative_to(workdir)): f.read_bytes() for f in Path(workdir).rglob("*") if f.is_file()}


def replace_member(data: bytes, member: str, text: str) -> bytes:
    """The same package with one input file replaced (or added)."""
    names = validate_zip(data)
    root = _root(names)
    target = member if member in names else root + member.lstrip("/")
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as zin, zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in names:
            if n != target:
                zout.writestr(n, zin.read(n))
        zout.writestr(target, text)
    return buf.getvalue()


def _load_classic(ws: str, eng: dict):
    import flopy

    try:
        if eng["engine"] == "mfusg":
            return flopy.mfusg.MfUsg.load(eng["nam"], model_ws=ws, check=False, verbose=False)
        return flopy.modflow.Modflow.load(eng["nam"], model_ws=ws, version=eng["engine"], check=False, verbose=False, forgive=True)
    except Exception as e:
        raise ModelError(f"FloPy could not read the {ENGINES[eng['engine']]} model: {e}"[:600])


# ---------------------------------------------------------------- where the model sits in the world
def georef(mg, ws: str) -> dict:
    """Origin, rotation and coordinate reference of a model grid, plus the latitude/longitude of its centre when the
    coordinate system is UTM (MGA zones on GDA94 or GDA2020, WGS 84 UTM)."""
    side = sidecar(ws)
    epsg = side.get("epsg")
    if epsg is None:
        crs = getattr(mg, "crs", None)
        try:
            epsg = crs.to_epsg() if crs is not None and hasattr(crs, "to_epsg") else None
        except Exception:
            epsg = None
        if epsg is None:
            m = __import__("re").search(r"EPSG:(\d+)", str(getattr(mg, "_crs", "") or crs or ""))
            epsg = int(m.group(1)) if m else None
    if epsg is None:  # classic name files carry it in their header comment: "#xll:..; crs:EPSG:28355" or "epsg:28355"
        import re as _re
        for n in sorted(Path(ws).glob("*.nam")):
            m = _re.search(r"(?:crs|epsg|proj4_str)\s*[:=]\s*(?:EPSG:)?(\d{4,5})", "".join(open(n, errors="replace").readlines()[:6]), _re.I)
            if m:
                epsg = int(m.group(1))
                break
    x0, y0, rot = float(getattr(mg, "xoffset", 0) or 0), float(getattr(mg, "yoffset", 0) or 0), float(getattr(mg, "angrot", 0) or 0)
    out = {"xorigin": x0, "yorigin": y0, "angrot": rot, "epsg": int(epsg) if epsg else None, "placed": bool(x0 or y0 or epsg)}
    try:
        ex = mg.extent  # (xmin, xmax, ymin, ymax) in world coordinates
        cx, cy = (ex[0] + ex[1]) / 2, (ex[2] + ex[3]) / 2
        out["extent"] = [round(float(v), 2) for v in ex]
        ll = to_lonlat(cx, cy, out["epsg"])
        if ll:
            out["centre_lonlat"] = [round(ll[0], 6), round(ll[1], 6)]
    except Exception:
        pass
    return out


def utm_zone(epsg: int | None) -> tuple[int, bool] | None:
    """(zone, southern) for UTM-based coordinate systems: GDA94 and GDA2020 MGA, WGS 84 UTM north and south."""
    if not epsg:
        return None
    if 28348 <= epsg <= 28358:
        return epsg - 28300, True
    if 7846 <= epsg <= 7859:
        return epsg - 7800, True
    if 32601 <= epsg <= 32660:
        return epsg - 32600, False
    if 32701 <= epsg <= 32760:
        return epsg - 32700, True
    return None


def to_lonlat(x: float, y: float, epsg: int | None) -> tuple[float, float] | None:
    """Inverse transverse Mercator on the GRS80/WGS84 ellipsoid (sub-metre over a zone), so no projection library."""
    import math

    z = utm_zone(epsg)
    if not z:
        return None
    zone, south = z
    a, f, k0 = 6378137.0, 1 / 298.257222101, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    xx, yy = x - 500000.0, (y - 10000000.0) if south else y
    m = yy / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu) \
        + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu)
    n1 = a / math.sqrt(1 - e2 * math.sin(p1) ** 2)
    t1, c1 = math.tan(p1) ** 2, ep2 * math.cos(p1) ** 2
    r1 = a * (1 - e2) / (1 - e2 * math.sin(p1) ** 2) ** 1.5
    d = xx / (n1 * k0)
    lat = p1 - (n1 * math.tan(p1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
                                            + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / math.cos(p1)
    return math.degrees(lon) + (zone * 6 - 183), math.degrees(lat)


# ---------------------------------------------------------------- DISV and unstructured grids on a raster
def raster_index(mg, target: int = 160) -> tuple[np.ndarray, float, float, np.ndarray, np.ndarray]:
    """A regular raster over a vertex or unstructured grid in model coordinates: for each raster cell, the model cell
    whose polygon holds its centre (-1 outside). Returns (index [nr, nc], dx, dy, cell centre x, cell centre y)."""
    from matplotlib.path import Path as MPath

    verts = _local_polys(mg)
    xs = np.concatenate([v[:, 0] for v in verts]); ys = np.concatenate([v[:, 1] for v in verts])
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    w, h = x1 - x0, y1 - y0
    ncell = len(verts)
    long_side = int(np.clip(np.sqrt(ncell) * 2.2, 40, target))
    if w >= h:
        nc, nr = long_side, max(4, int(round(long_side * h / w)))
    else:
        nr, nc = long_side, max(4, int(round(long_side * w / h)))
    dx, dy = w / nc, h / nr
    # a hair off the cell centres, so a raster point never sits exactly on an edge that no polygon claims
    gx = x0 + (np.arange(nc) + 0.5) * dx + dx * 1.3e-6
    gy = y1 - (np.arange(nr) + 0.5) * dy - dy * 1.7e-6  # row 0 is the north edge, as in DIS
    idx = np.full((nr, nc), -1, int)
    for i, v in enumerate(verts):
        c0 = max(0, int((v[:, 0].min() - x0) / dx) - 1); c1 = min(nc, int((v[:, 0].max() - x0) / dx) + 2)
        r0 = max(0, int((y1 - v[:, 1].max()) / dy) - 1); r1 = min(nr, int((y1 - v[:, 1].min()) / dy) + 2)
        if c0 >= c1 or r0 >= r1:
            continue
        XX, YY = np.meshgrid(gx[c0:c1], gy[r0:r1])
        inside = MPath(v).contains_points(np.column_stack([XX.ravel(), YY.ravel()])).reshape(XX.shape)
        sub = idx[r0:r1, c0:c1]
        sub[inside & (sub < 0)] = i
    cx = np.array([v[:, 0].mean() for v in verts]); cy = np.array([v[:, 1].mean() for v in verts])
    return idx, dx, dy, (cx - x0) / dx - 0.5, (y1 - cy) / dy - 0.5


def _local_polys(mg) -> list[np.ndarray]:
    """Each cell's outline in the model's own (unrotated) coordinates."""
    out = []
    xv, yv = mg.xvertices, mg.yvertices  # world coordinates, rotated
    import math

    th = math.radians(float(getattr(mg, "angrot", 0) or 0))
    x0, y0 = float(getattr(mg, "xoffset", 0) or 0), float(getattr(mg, "yoffset", 0) or 0)
    for xs, ys in zip(xv, yv):
        xs, ys = np.asarray(xs, float) - x0, np.asarray(ys, float) - y0
        out.append(np.column_stack([xs * math.cos(th) + ys * math.sin(th), -xs * math.sin(th) + ys * math.cos(th)]))
    return out


def _coarsen(a: np.ndarray, f: int) -> np.ndarray:
    """Block mean over the last two axes (NaN-aware), trimming the ragged edge."""
    if f <= 1:
        return a
    import warnings

    nr, nc = a.shape[-2] // f * f, a.shape[-1] // f * f
    a = a[..., :nr, :nc]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmean(a.reshape(a.shape[:-2] + (nr // f, f, nc // f, f)), axis=(-3, -1))


def _run_exe(exe: str, args: list[str], ws: str, timeout: float = 3600) -> subprocess.CompletedProcess:
    return subprocess.run([exe, *args], cwd=ws, capture_output=True, text=True, timeout=timeout)


def run(data: bytes, exe, workdir: str) -> dict:
    """Run the package unchanged with its own engine and return a payload the 3D view can draw.

    exe is the MODFLOW 6 path, or a function engine -> path that installs the engine on first use."""
    import flopy

    ws = extract(data, workdir)
    eng = detect(ws)
    path = exe(eng["engine"]) if callable(exe) else exe
    if eng["engine"] != "mf6" and not callable(exe):
        raise ModelError(f"This is a {ENGINES[eng['engine']]} model; its engine is not available here.")
    t0 = time.time()
    proc = _run_exe(path, ["mfsim.nam"] if eng["engine"] == "mf6" else [eng["nam"]], ws)
    run_s = time.time() - t0
    out_text = proc.stdout + proc.stderr
    if "Normal termination" not in out_text and "normal termination" not in out_text.lower():
        raise ModelError(f"{ENGINES[eng['engine']]} did not finish normally:\n" + failure(out_text, ws))
    if eng["engine"] == "mf6":
        return _results_mf6(ws, run_s, out_text)
    return _results_classic(ws, eng, run_s, out_text)


def _heads_file(ws: str, prefer: str | None = None) -> str | None:
    cands = [p for p in Path(ws).iterdir() if p.suffix.lower() in (".hds", ".hed", ".bhd", ".head")]
    if prefer:
        cands.sort(key=lambda p: p.name.lower() != prefer.lower())
    return str(max(cands, key=lambda p: p.stat().st_mtime)) if cands and not prefer else (str(cands[0]) if cands else None)


def _water_table(heads: np.ndarray, botm: np.ndarray) -> np.ndarray:
    """Head in the uppermost wet layer, for every output time: heads [t, lay, ...], botm [lay, ...]."""
    wt = np.full((heads.shape[0],) + heads.shape[2:], np.nan)
    for k in range(heads.shape[1] - 1, -1, -1):
        h = heads[:, k]
        wt = np.where(np.isfinite(h) & (h > botm[k][None]), h, wt)
    return wt


def _payload(top, botm, heads, times, feats, bores, budget, budget_all, run_s, stdout, model, time_units, delr_km, delc_km, extra) -> dict:
    """The 3D view's payload for a structured (or rasterised) grid, coarsened and thinned for display when large."""
    nr, nc = top.shape
    f = int(np.ceil(np.sqrt(nr * nc / DISPLAY_CELLS))) if nr * nc > DISPLAY_CELLS else 1
    keep = list(range(len(times)))
    if len(keep) > DISPLAY_TIMES:
        keep = sorted(set(np.linspace(0, len(times) - 1, DISPLAY_TIMES).round().astype(int).tolist()))
    heads_d = heads[keep]
    wt = _water_table(heads_d, botm)
    dtw = top[None] - wt
    top_d, botm_d, wt_d, dtw_d = _coarsen(top, f), _coarsen(botm, f), _coarsen(wt, f), _coarsen(dtw, f)
    if f > 1:
        for key in feats:
            feats[key] = list({(x["row"] // f, x["col"] // f): {**x, "row": x["row"] // f, "col": x["col"] // f} for x in feats[key]}.values())
        bores = [{**b, "row": b["row"] // f, "col": b["col"] // f} for b in bores]
    r3 = lambda a: np.where(np.isfinite(a), np.round(a, 3), None).tolist()
    return {
        "grid": {"nlay": int(botm.shape[0]), "nrow": int(top_d.shape[0]), "ncol": int(top_d.shape[1]),
                 "delr_km": delr_km * f, "delc_km": delc_km * f, "top": r3(top_d), "botm": r3(botm_d)},
        "times": [times[i] for i in keep], "time_units": time_units,
        "wt": [r3(w) for w in wt_d], "dtw": [r3(d) for d in dtw_d],
        "features": feats, "bores": bores, "budget_last": budget, "run_s": round(run_s, 2),
        "heads_all": heads, "budget_all": budget_all, "top_all": top, "botm_all": botm,  # full resolution, every output time, for agents; dropped before the Studio's payload
        "stdout_tail": stdout[-600:], "model": model,
        "display": {"coarsen": f, "times_shown": len(keep), "times_total": len(times), "native_cells": int(nr * nc)}, **extra,
    }


def _budget(lst: str | None, classic: bool):
    import flopy

    if not lst or not os.path.exists(lst):
        return None, []
    try:
        cls = flopy.utils.MfListBudget if classic else flopy.utils.Mf6ListBudget
        if classic and "usg" in open(lst, errors="replace").read(4000).lower():
            cls = flopy.utils.MfusgListBudget
        inc, _ = cls(lst).get_dataframes()
        allb = [{"time": str(t), **{c: float(v) for c, v in row.items() if c.endswith(("_IN", "_OUT"))}} for t, row in inc.iterrows()]
        last = inc.iloc[-1]
        return [{"term": c.rsplit("_", 1)[0], "direction": c.rsplit("_", 1)[1].lower(), "rate": float(last[c])}
                for c in inc.columns if c.endswith(("_IN", "_OUT")) and not c.startswith("TOTAL") and abs(float(last[c])) > 0], allb
    except Exception:
        return None, []


FEATURE_OF = {"riv": "river", "drn": "drain", "chd": "chd", "ghb": "ghb", "sfr": "river", "lak": "lake", "maw": "wells",
              "uzf": "uzf", "str": "river", "drt": "drain", "evt": None}


def _results_mf6(ws: str, run_s: float, stdout: str) -> dict:
    import flopy

    sim, gwf = _load(ws)
    mg = gwf.modelgrid
    try:
        hds = gwf.output.head()
    except Exception:
        raise ModelError("Solved, but the model saves no heads (add HEAD to the OC package).")
    heads = hds.get_alldata().astype(float)
    times = [float(t) for t in hds.get_times()]
    heads = np.where(np.abs(heads) > HDRY, np.nan, heads)
    nper = int(sim.tdis.nper.get_data())
    lst = next((str(f) for f in Path(ws).glob("*.lst") if f.name != "mfsim.lst"), None)
    budget, budget_all = _budget(lst, False)
    tu = str(sim.tdis.time_units.get_data() or "days")
    geo = georef(mg, ws)
    feats = {"river": [], "canal": [], "drain": [], "chd": [], "ghb": [], "lake": [], "uzf": []}
    bores = []
    if mg.grid_type == "structured":
        top, botm = np.asarray(mg.top, float), np.asarray(mg.botm, float)
        to_rc = lambda cid: (int(cid[0]), int(cid[1]), int(cid[2])) if len(cid) == 3 else None
        extra = {"engine": "mf6", "georef": geo}
        delr, delc = float(np.mean(mg.delr)) / 1000, float(np.mean(mg.delc)) / 1000
    else:
        idx, dx, dy, ccol, crow = raster_index(mg)
        nr, nc = idx.shape
        valid = idx >= 0
        take = lambda a: np.where(valid, np.asarray(a, float)[..., np.clip(idx, 0, None)], np.nan)
        if mg.grid_type == "vertex":
            top, botm = take(mg.top), take(mg.botm)
            heads = take(heads.reshape(heads.shape[0], mg.nlay, -1))
            to_rc = lambda cid: (int(cid[0]), int(round(crow[cid[1]])), int(round(ccol[cid[1]]))) if len(cid) == 2 else None
        else:  # DISU: one stack of nodes; draw the uppermost node in each place as a single layer
            ntop, nbot = np.asarray(mg.top, float), np.asarray(mg.botm, float).ravel()
            top, botm = take(ntop), take(nbot)[None]
            heads = take(heads.reshape(heads.shape[0], -1))[:, None]
            to_rc = lambda cid: (0, int(round(crow[cid[0]])), int(round(ccol[cid[0]])))
        extra = {"engine": "mf6", "georef": geo, "raster": {"from": mg.grid_type.upper() if mg.grid_type != "vertex" else "DISV",
                 "cells": int(mg.ncpl if mg.grid_type == "vertex" else mg.nnodes), "raster": [int(nr), int(nc)]}}
        delr, delc = dx / 1000, dy / 1000
    for p in gwf.packagelist:
        t = p.package_type.lower()
        key = FEATURE_OF.get(t)
        cids = []
        try:
            if t in ("riv", "drn", "chd", "ghb", "wel"):
                spd = p.stress_period_data
                recs = next((d for d in (spd.get_data(k) for k in range(nper)) if d is not None and len(d)), None)
                cids = [(tuple(r["cellid"]), r) for r in (recs if recs is not None else [])]
            elif t in ("sfr", "uzf"):
                cids = [(tuple(r["cellid"]), r) for r in p.packagedata.get_data() if isinstance(r["cellid"], tuple)]
            elif t in ("lak", "maw"):
                cids = [(tuple(r["cellid"]), r) for r in p.connectiondata.get_data() if isinstance(r["cellid"], tuple)]
        except Exception:
            continue
        for cid, rec in cids:
            q = to_rc(cid)
            if q is None:
                continue
            k, r, c = q
            if t in ("wel", "maw"):
                if any(b["row"] == r and b["col"] == c and b["bore_id"].startswith(p.package_name.upper()) for b in bores):
                    continue
                bores.append({"bore_id": f"{p.package_name.upper()}-{r}-{c}", "bore_type": "production", "layer": k, "row": r, "col": c,
                              "rate": float(rec["q"]) if t == "wel" else None})
            elif key:
                if t == "riv" and "canal" in p.package_name.lower():
                    key = "canal"
                feats[key].append({"row": r, "col": c, "name": p.package_name})
    return _payload(top, botm, heads, times, feats, bores, budget, budget_all, run_s, stdout, gwf.name, tu, delr, delc, extra)


def _results_classic(ws: str, eng: dict, run_s: float, stdout: str) -> dict:
    import flopy

    m = _load_classic(ws, eng)
    mg = m.modelgrid
    if not getattr(m, "structured", True):
        raise ModelError("Solved. This MODFLOW-USG model is unstructured (DISU) without cell outlines, so it cannot be drawn in 3D; "
                         "its heads and budget are in the run's files.")
    hf = _heads_file(ws)
    if not hf:
        raise ModelError("Solved, but the model saves no heads (set SAVE HEAD in the OC file).")
    try:
        hds = flopy.utils.HeadFile(hf)
    except Exception:
        hds = flopy.utils.HeadFile(hf, precision="double")
    heads = hds.get_alldata().astype(float)
    heads = np.where((np.abs(heads) > 1e29) | (heads <= -999), np.nan, heads)
    times = [float(t) for t in hds.get_times()]
    top, botm = np.asarray(mg.top, float), np.asarray(mg.botm, float)
    if botm.shape[0] != heads.shape[1]:
        botm = botm[: heads.shape[1]]  # quasi-3D confining beds are not model layers
    lst = next((str(f) for f in Path(ws).iterdir() if f.suffix.lower() in (".list", ".lst")), None)
    budget, budget_all = _budget(lst, True)
    feats = {"river": [], "canal": [], "drain": [], "chd": [], "ghb": [], "lake": [], "uzf": []}
    bores = []
    for name in ("RIV", "DRN", "CHD", "GHB", "WEL", "STR", "DRT"):
        p = m.get_package(name)
        if p is None or getattr(p, "stress_period_data", None) is None:
            continue
        recs = next((p.stress_period_data[k] for k in range(m.nper) if p.stress_period_data[k] is not None and len(p.stress_period_data[k])), None)
        for r in recs if recs is not None else []:
            k, i, j = int(r["k"]), int(r["i"]), int(r["j"])
            if name == "WEL":
                bores.append({"bore_id": f"WEL-{i}-{j}", "bore_type": "production", "layer": k, "row": i, "col": j, "rate": float(r["flux"])})
            else:
                feats[FEATURE_OF[name.lower()]].append({"row": i, "col": j, "name": name.lower()})
    sfr = m.get_package("SFR")
    if sfr is not None:
        for r in sfr.reach_data:
            feats["river"].append({"row": int(r["i"]), "col": int(r["j"]), "name": "sfr"})
    itmuni = int(getattr(m.dis, "itmuni", 4) or 4)
    tu = {0: "undefined", 1: "seconds", 2: "minutes", 3: "hours", 4: "days", 5: "years"}.get(itmuni, "days")
    return _payload(top, botm, heads, times, feats, bores, budget, budget_all, run_s, stdout, m.name, tu,
                    float(np.mean(mg.delr)) / 1000, float(np.mean(mg.delc)) / 1000,
                    {"engine": eng["engine"], "georef": georef(mg, ws)})


def convert_to_mf6(data: bytes, mf5to6: str, workdir: str) -> dict[str, bytes]:
    """A MODFLOW-2005 or NWT model as MODFLOW 6 input files, with the USGS mf5to6 converter."""
    ws = extract(data, workdir)
    eng = detect(ws)
    if eng["engine"] not in ("mf2005", "mfnwt"):
        raise ModelError(f"Only MODFLOW-2005 and NWT models convert to MODFLOW 6 (this is {ENGINES[eng['engine']]}).")
    out = os.path.join(workdir, "mf6")
    os.makedirs(out, exist_ok=True)
    before = set(os.listdir(ws))
    proc = _run_exe(mf5to6, [eng["nam"], Path(eng["nam"]).stem + "_mf6"], ws, timeout=900)  # its own name: same-named output overwrites the input mid-read
    new = [f for f in os.listdir(ws) if f not in before]
    if "mfsim.nam" not in new:
        raise ModelError("mf5to6 could not convert the model:\n" + (proc.stdout + proc.stderr)[-1200:])
    files = {f: open(os.path.join(ws, f), "rb").read() for f in new if Path(f).suffix.lower() not in (".lst", ".hds", ".cbc")}
    side = sidecar(ws) or {}
    g = georef(_load_classic(ws, eng).modelgrid, ws)
    if not side.get("epsg") and g.get("epsg"):
        side["epsg"] = g["epsg"]
    # mf5to6 does not carry the classic name file's placement; the MODFLOW 6 grid file has options for it
    dis = next((f for f in files if f.lower().endswith(".dis")), None)
    if dis and (g["xorigin"] or g["yorigin"] or g["angrot"]):
        import re as _re
        text = files[dis].decode(errors="replace")
        opts = f"  XORIGIN  {g['xorigin']:.6f}\n  YORIGIN  {g['yorigin']:.6f}\n  ANGROT  {g['angrot']:.6f}\n"
        files[dis] = _re.sub(r"(BEGIN\s+OPTIONS[^\n]*\n)", lambda m: m.group(1) + opts, text, count=1, flags=_re.I).encode()
    if side:
        import json
        files["modflow-os.json"] = json.dumps({k: v for k, v in side.items() if k != "engine"}).encode()
    return files
