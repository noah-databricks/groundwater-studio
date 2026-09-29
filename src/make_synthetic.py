"""Generate the synthetic sample irrigation district: made-up data, placed nowhere and named after nothing real,
so it can never be mistaken for a real district's records.

Observed bore water levels come from a hidden "truth" MODFLOW run (different K and
deep drainage from the base model) plus measurement noise, so calibration and
ensemble conditioning have something real to fit against.

Usage: python make_synthetic.py <mf6 exe> <out dir>
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import gwmodel

RNG = np.random.default_rng(20260925)
CRNG = np.random.default_rng(11)
NLAY, NROW, NCOL, D = 2, 40, 60, 250.0


def smooth_field(sigma_cells, shape):
    noise = RNG.standard_normal(shape)
    ky = np.fft.fftfreq(shape[0])[:, None]
    kx = np.fft.fftfreq(shape[1])[None, :]
    f = np.real(np.fft.ifft2(np.fft.fft2(noise) * np.exp(-2 * (np.pi * sigma_cells) ** 2 * (kx ** 2 + ky ** 2))))
    return (f - f.mean()) / f.std()


def lonlat(row, col):
    return None, None  # the sample district is not placed anywhere on Earth


def main(exe, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    rr, cc = np.mgrid[0:NROW, 0:NCOL]
    top = 118 + 14 * cc / (NCOL - 1) + 3 * (1 - rr / (NROW - 1)) + 0.6 * smooth_field(4, (NROW, NCOL))
    botm = np.stack([top - 25, top - 85])
    k = np.stack([2.0 * np.exp(0.6 * smooth_field(5, (NROW, NCOL))),
                  25.0 * np.exp(0.5 * smooth_field(8, (NROW, NCOL)))])
    k33 = np.stack([k[0] / 10, k[1] / 5])

    irrigated = np.zeros((NROW, NCOL), bool)
    crop = np.full((NROW, NCOL), "dryland", dtype=object)
    crops = ["rice", "pasture", "broadacre", "horticulture"]
    for _ in range(90):
        r, c = RNG.integers(0, NROW - 5), RNG.integers(1, NCOL - 5)
        hr, wc = RNG.integers(2, 6), RNG.integers(2, 6)
        irrigated[r:r + hr, c:c + wc] = True
        # a separate stream so the rest of the dataset is unchanged: rice on the tighter soils,
        # horticulture on the northern rises, pasture towards the river flats
        clay = float(np.clip(1.2 - k[0, r, c] / 2.0, 0, 1))
        p = np.array([0.15 + 0.6 * clay, 0.15 + 0.25 * r / NROW, 0.35, 0.1 + 0.5 * (r < 14)])
        crop[r:r + hr, c:c + wc] = crops[CRNG.choice(4, p=p / p.sum())]
    irrigated[NROW - 3:] = False
    zone = np.where(irrigated, crop, "dryland")

    cells = []
    for l in range(NLAY):
        for r in range(NROW):
            for c in range(NCOL):
                lon, lat = lonlat(r, c)
                cells.append(dict(layer=l, row=r, col=c, delr=D, delc=D, x_m=(c + 0.5) * D,
                                  y_m=(NROW - r - 0.5) * D, lon=lon, lat=lat, top=round(top[r, c], 3),
                                  botm=round(botm[l, r, c], 3), k=round(k[l, r, c], 4), k33=round(k33[l, r, c], 5),
                                  ss=1e-5, irrigated=int(irrigated[r, c]), land_use=zone[r, c],
                                  unit="Upper aquifer" if l == 0 else "Lower aquifer"))
    cells = pd.DataFrame(cells)

    bnd = []
    for c in range(NCOL):
        bnd.append(dict(kind="river", name="River (southern boundary)", layer=0, row=NROW - 1, col=c,
                        stage=top[-1, c] - 4, rbot=top[-1, c] - 6, cond=2000.0))
    for r in range(NROW - 1):
        for l in range(NLAY):
            bnd.append(dict(kind="chd", name="Regional head (west)", layer=l, row=r, col=0,
                            stage=top[r, 0] - 3.0, rbot=None, cond=None))
            bnd.append(dict(kind="chd", name="Regional head (east)", layer=l, row=r, col=NCOL - 1,
                            stage=top[r, -1] - 2.5, rbot=None, cond=None))
    seen = set()
    for c in range(3, NCOL - 3):
        r = int(round(10 + 3 * np.sin(c / 8)))
        seen.add((r, c))
    for r in range(11, 35):
        seen.add((r, 36))
    canal = []
    for r, c in sorted(seen):
        name = "Branch Canal" if c == 36 and r >= 11 and (r, c) != (int(round(10 + 3 * np.sin(36 / 8))), 36) else "Main Canal"
        canal.append(dict(kind="canal", name=name, layer=0, row=r, col=c, stage=top[r, c] - 0.3,
                          rbot=top[r, c] - 2.5, cond=float(240 * np.exp(0.5 * RNG.standard_normal()))))
    # reaches: 2 km asset sections numbered downstream (main canal west to east, branch north to south)
    for name, code, key in [("Main Canal", "MC", lambda d: d["col"]), ("Branch Canal", "BC", lambda d: d["row"])]:
        for i, d in enumerate(sorted((d for d in canal if d["name"] == name), key=key)):
            d["reach"] = f"{code}-{i // 8 + 1:02d}"
    bnd += canal
    for name, c, r0 in [("Drain D1", 18, 5), ("Drain D2", 48, 2)]:
        for r in range(r0, NROW - 1):
            bnd.append(dict(kind="drain", name=name, layer=0, row=r, col=c, stage=top[r, c] - 1.8,
                            rbot=None, cond=500.0))
    bnd = pd.DataFrame(bnd).round(3)
    bnd = bnd[~((bnd.kind != "chd") & bnd.col.isin([0, NCOL - 1]))]

    bores = []
    irr_cells = np.argwhere(irrigated[2:-4, 3:-3]) + [2, 3]
    for i, (r, c) in enumerate(irr_cells[RNG.choice(len(irr_cells), 12, replace=False)]):
        lon, lat = lonlat(r, c)
        bores.append(dict(bore_id=f"PB-{i + 1:02d}", bore_type="production", layer=1, row=int(r), col=int(c),
                          lon=lon, lat=lat, screen_from_m=40.0, screen_to_m=80.0,
                          landholder=f"Farm {i + 1:02d} (synthetic)", licence_no=f"SYN-WAL-{RNG.integers(100000, 999999)}",
                          entitlement_ml=float(RNG.integers(4, 12) * 100)))
    for i in range(20):
        r, c = RNG.integers(2, NROW - 3), RNG.integers(3, NCOL - 3)
        layer = 0 if i < 14 else 1
        lon, lat = lonlat(r, c)
        bores.append(dict(bore_id=f"OB-{i + 1:02d}", bore_type="monitoring", layer=layer, row=int(r), col=int(c),
                          lon=lon, lat=lat, screen_from_m=3.0 if layer == 0 else 45.0,
                          screen_to_m=12.0 if layer == 0 else 70.0, landholder="District network (synthetic)",
                          licence_no=None, entitlement_ml=None))
    bores = pd.DataFrame(bores)

    months = pd.date_range("2024-07-01", "2026-06-01", freq="MS")
    rain_clim = dict(zip(range(1, 13), [30, 32, 35, 30, 32, 32, 30, 30, 32, 38, 32, 33]))
    et_clim = dict(zip(range(1, 13), [220, 180, 140, 85, 50, 32, 35, 55, 85, 130, 170, 210]))
    weather = []
    for st, name in [("WS-01", "District weather station 1 (synthetic)"), ("WS-02", "District weather station 2 (synthetic)")]:
        for m in months:
            wet = 1.6 if m.year == 2025 and m.month in (1, 2, 3) else 1.0  # a wet summer in 2025
            weather.append(dict(station_id=st, station_name=name, month=m.date(),
                                rainfall_mm=round(rain_clim[m.month] * wet * RNG.gamma(4, 0.25), 1),
                                et0_mm=round(et_clim[m.month] * RNG.normal(1, 0.05), 1)))
    weather = pd.DataFrame(weather)

    season = {1: .16, 2: .14, 3: .10, 4: .04, 5: .01, 6: 0, 7: 0, 8: .01, 9: .05, 10: .10, 11: .17, 12: .22}
    ext = []
    for b in bores[bores.bore_type == "production"].itertuples():
        use = RNG.uniform(0.6, 0.95)
        for m in months:
            ext.append(dict(bore_id=b.bore_id, month=m.date(),
                            extraction_ml=round(b.entitlement_ml * use * season[m.month] * RNG.normal(1, .1), 2)))
    ext = pd.DataFrame(ext)
    ext["extraction_ml"] = ext.extraction_ml.clip(lower=0)

    inp = gwmodel.inputs_from_frames(cells, bnd, bores, ext, weather)
    truth = gwmodel.run(inp, {"k_mult": 1.3, "deep_drainage_frac": 0.12, "sy": 0.07}, str(out / "_truth"), exe)
    assert truth["ok"], truth["stdout_tail"]
    h = gwmodel.hydrographs(inp, truth).dropna(subset=["month"])
    obs = []
    for r in h.itertuples():
        if RNG.random() < 0.12:
            continue
        d = pd.Timestamp(r.month) + pd.Timedelta(days=int(RNG.integers(5, 25)))
        b = bores.set_index("bore_id").loc[r.bore_id]
        wl = r.sim_head + RNG.normal(0, 0.08)
        obs.append(dict(bore_id=r.bore_id, obs_date=d.date(), water_level_mahd=round(wl, 3),
                        depth_to_water_m=round(top[b.row, b.col] - wl, 3), method="logger" if RNG.random() < .7 else "manual dip"))
    obs = pd.DataFrame(obs)

    for name, df in dict(aquifer_cells=cells, boundary_cells=bnd, bores=bores, bore_extractions_monthly=ext,
                         weather_monthly=weather, bore_water_levels=obs).items():
        df.to_parquet(out / f"{name}.parquet", index=False)
        print(name, len(df))
    dtw = truth["dtw"][-1]
    print("truth DTW final: min %.2f median %.2f max %.2f; <2m %.1f%%" % (
        np.nanmin(dtw), np.nanmedian(dtw), np.nanmax(dtw), 100 * np.mean(dtw < 2)))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
