"""Turn the sample district's tables into raw landing files, the way they would arrive from the field.

    python src/make_raw_landing.py data data/landing

The Lakeflow pipeline (pipelines/district_ingest.sql) ingests these with Auto Loader and rebuilds the model input tables,
so the clean silver tables match data/*.parquet exactly. A few bad records are mixed in, as real feeds have them: a
logger fault reading -9999, readings from bores not in the register, a blank bore id, a negative meter read and a
weather record with a negative ET0. The pipeline's expectations drop them and report the counts.
"""
import json
import sys
from pathlib import Path

import pandas as pd

BAD_LEVELS = [  # (bore_id, reading_time, water_level_mahd, depth_to_water_m, method), one set per file listed
    ("OB-07", "T09:00:00", -9999.0, None, "logger"),
    ("OB-99", "T10:15:00", 124.31, 2.4, "manual dip"),
    ("", "T11:30:00", 123.9, 2.8, "logger"),
]
BAD_LEVEL_MONTHS = {"2024-09", "2025-01", "2025-08", "2026-02"}
BAD_EXTRACTION = {"2025-02": ("PB-04", -12.5), "2025-11": ("PB-99", 40.0)}
BAD_WEATHER = ("WS-02", "2025-05", 31.0, -4.0)


def main(src, out):
    src, out = Path(src), Path(out)
    for d in ("telemetry/bore_levels", "telemetry/extractions", "weather", "reference"):
        (out / d).mkdir(parents=True, exist_ok=True)

    # reference: model geometry as surveyed (parquet), the bore register as exported from the licensing system (csv)
    for name in ("aquifer_cells", "boundary_cells"):
        pd.read_parquet(src / f"{name}.parquet").to_parquet(out / "reference" / f"{name}.parquet", index=False)
    pd.read_parquet(src / "bores.parquet").to_csv(out / "reference" / "bores.csv", index=False)

    # bore levels: one CSV per month, readings timestamped as the loggers report them
    lv = pd.read_parquet(src / "bore_water_levels.parquet")
    lv["ym"] = pd.to_datetime(lv.obs_date).dt.strftime("%Y-%m")
    n_bad = 0
    for ym, g in lv.groupby("ym"):
        rows = pd.DataFrame({"bore_id": g.bore_id,
                             "reading_time": pd.to_datetime(g.obs_date).dt.strftime("%Y-%m-%dT08:00:00"),
                             "water_level_mahd": g.water_level_mahd, "depth_to_water_m": g.depth_to_water_m,
                             "method": g.method})
        if ym in BAD_LEVEL_MONTHS:
            day = f"{ym}-15"
            bad = pd.DataFrame([dict(bore_id=b, reading_time=day + t, water_level_mahd=w, depth_to_water_m=d, method=m)
                                for b, t, w, d, m in BAD_LEVELS])
            rows = pd.concat([rows, bad], ignore_index=True)
            n_bad += len(bad)
        rows.to_csv(out / "telemetry" / "bore_levels" / f"levels_{ym}.csv", index=False)

    # metered extraction: one CSV per month, month as YYYY-MM
    ex = pd.read_parquet(src / "bore_extractions_monthly.parquet")
    ex["ym"] = pd.to_datetime(ex.month).dt.strftime("%Y-%m")
    for ym, g in ex.groupby("ym"):
        rows = pd.DataFrame({"bore_id": g.bore_id, "month": ym, "extraction_ml": g.extraction_ml})
        if ym in BAD_EXTRACTION:
            b, v = BAD_EXTRACTION[ym]
            rows = pd.concat([rows, pd.DataFrame([dict(bore_id=b, month=ym, extraction_ml=v)])], ignore_index=True)
            n_bad += 1
        rows.to_csv(out / "telemetry" / "extractions" / f"meter_{ym}.csv", index=False)

    # weather: JSON lines per station and water year, as the station network exports them
    wx = pd.read_parquet(src / "weather_monthly.parquet")
    wx["ym"] = pd.to_datetime(wx.month).dt.strftime("%Y-%m")
    for st, g in wx.groupby("station_id"):
        lines = [dict(station_id=r.station_id, station_name=r.station_name, month=r.ym,
                      rainfall_mm=r.rainfall_mm, et0_mm=r.et0_mm) for r in g.itertuples()]
        if st == BAD_WEATHER[0]:
            lines.append(dict(station_id=st, station_name=g.station_name.iloc[0], month=BAD_WEATHER[1],
                              rainfall_mm=BAD_WEATHER[2], et0_mm=BAD_WEATHER[3]))
            n_bad += 1
        (out / "weather" / f"{st}.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n")

    files = sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file())
    print(f"{len(files)} landing files, {n_bad} deliberately bad records")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
