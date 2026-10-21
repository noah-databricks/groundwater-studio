"""The install's Genie Agent: the district's governed tables, how to read them, trusted SQL and benchmarks.

Used by install.py to create or update the space. Questions are about what is on record (inputs, runs, ensembles,
studies, the seasonal outlook); the modelling agent and the Studio change and solve the model.
"""
import json

TITLE = "Groundwater Studio: sample district"
DESCRIPTION = ("Ask about the synthetic sample irrigation district: filed MODFLOW 6 runs and their outcomes, uncertainty "
               "ensembles, studies and findings, the latest seasonal outlook for operations, and the telemetry the model "
               "reads (bore levels, metered extraction, weather).")

TABLES = ["bores", "bore_water_levels", "bore_extractions_monthly", "weather_monthly", "model_runs", "run_reach_seepage",
          "run_bore_heads", "ensemble_runs", "studies", "study_findings", "outlook_bore_risk", "outlook_reach_seepage"]

INSTRUCTIONS = """\
This space covers a synthetic sample irrigation district modelled with MODFLOW 6 (40 x 60 cells of 250 m, two aquifer
layers, monthly stress periods July 2024 to June 2026). All data is made up.

Key outcome: model_runs.pct_area_dtw_lt_2m is the share of the district (percent) with the water table within 2 m of the
land surface at the end of the run: the waterlogging and salinity-risk area. Lower is better. The calibrated baseline is
about 15.0%.

Runs: model_runs has one row per filed run. label is the human description (for example "MC-05 lined" or
"Outlook: dry year (low allocation, more pumping)"). origin says who filed it: studio (a person in the app), mcp:<client>
(the modelling agent), api, or job:<run id> (a Lakeflow job). run_by is the person or identity. canal_seepage_ml and
bore_extraction_ml are totals over the 24-month simulation in ML; divide by 1000 for GL. rmse_m is the fit to observed
bore levels.

Supply channel reaches are 2 km asset sections named MC-01..MC-07 (main canal) and BC-01..BC-03 (branch canal).
run_reach_seepage has seepage per reach per run; lined = true when the scenario lined that reach.

Ensembles (ensemble_runs) are Monte Carlo sets of runs with uncertain parameters: mean_pct_area_dtw_lt_2m with
p10_pct_area_dtw_lt_2m and p90_pct_area_dtw_lt_2m give the uncertainty band; n_behavioural is how many realizations
still fit the observed bores.

Studies group runs around a question; study_findings has the findings (kind observation | conclusion | caveat) and the
run_ids each rests on.

Seasonal outlook: outlook_bore_risk ranks monitoring bores (OB-nn) by shallow water-table risk for the latest dry,
average and wet outlook runs (season column). min_depth_m is the shallowest depth to water over the simulation; risk is
high when under 1 m, elevated when under 2 m. outlook_reach_seepage ranks reaches by seepage per season.

Telemetry: bore_water_levels (observed levels, m AHD), bore_extractions_monthly (metered extraction, ML per month),
weather_monthly (rainfall and ET0, mm). bores is the register: PB-nn production bores (licensed) and OB-nn monitoring
bores; landholder and licence_no are masked for most users.

When a question asks to test or change something ("what if we line MC-03"), say that needs a model run in Groundwater
Studio; answer only from what is filed.
"""

EXAMPLES = [
    ("Which filed runs cut the area within 2 m of the surface the most, and by how much?",
     """SELECT r.label, r.pct_area_dtw_lt_2m,
       round(b.pct_area_dtw_lt_2m - r.pct_area_dtw_lt_2m, 2) AS reduction_pts, r.run_by, r.created_at
FROM {T}.model_runs r
CROSS JOIN (SELECT pct_area_dtw_lt_2m FROM {T}.model_runs
            WHERE scenario_json IS NULL OR scenario_json IN ('{{}}', '') OR label ILIKE '%baseline%'
            ORDER BY created_at LIMIT 1) b
ORDER BY r.pct_area_dtw_lt_2m ASC
LIMIT 10"""),
    ("Which monitoring bores are most at risk in the dry-year outlook?",
     """SELECT bore_id, risk, min_depth_m, final_depth_m, months_within_2m
FROM {T}.outlook_bore_risk
WHERE season = 'dry'
ORDER BY min_depth_m ASC
LIMIT 10"""),
    ("How much channel seepage did lining MC-05 save over the simulation?",
     """SELECT l.label, round((b.canal_seepage_ml - l.canal_seepage_ml) / 1000, 2) AS seepage_saved_gl,
       round(b.canal_seepage_ml / 1000, 2) AS baseline_gl, round(l.canal_seepage_ml / 1000, 2) AS lined_gl
FROM {T}.model_runs l
CROSS JOIN (SELECT canal_seepage_ml FROM {T}.model_runs WHERE label ILIKE 'Outlook: average%' OR label ILIKE '%baseline%'
            ORDER BY created_at DESC LIMIT 1) b
WHERE l.label ILIKE '%MC-05%' OR l.scenario_json LIKE '%MC-05%'
ORDER BY l.created_at DESC
LIMIT 5"""),
    ("What did the latest ensemble give for the share within 2 m, P10 to P90?",
     """SELECT label, scenario_name, n_behavioural, n_realizations, round(mean_pct_area_dtw_lt_2m, 1) AS mean_pct,
       round(p10_pct_area_dtw_lt_2m, 1) AS p10_pct, round(p90_pct_area_dtw_lt_2m, 1) AS p90_pct, created_at
FROM {T}.ensemble_runs
WHERE status IN ('finished', 'SUCCEEDED', 'succeeded') OR mean_pct_area_dtw_lt_2m IS NOT NULL
ORDER BY created_at DESC
LIMIT 1"""),
    ("Which reaches leak the most in the wet-year outlook?",
     """SELECT reach, seepage_ml, lined, seepage_rank
FROM {T}.outlook_reach_seepage
WHERE season = 'wet'
ORDER BY seepage_rank
LIMIT 10"""),
    ("Which findings cite the wet-year outlook run?",
     """SELECT s.title, f.kind, f.text, f.created_at
FROM {T}.study_findings f
JOIN {T}.studies s ON s.study_id = f.study_id
JOIN {T}.model_runs r ON array_contains(f.run_ids, r.run_id)
WHERE r.label ILIKE 'Outlook: wet%'
ORDER BY f.created_at DESC"""),
    ("Monthly metered extraction across the district",
     """SELECT month, round(sum(extraction_ml), 1) AS extraction_ml
FROM {T}.bore_extractions_monthly
GROUP BY month
ORDER BY month"""),
]

BENCHMARKS = [
    ("Which monitoring bores are most at risk in the dry-year outlook?", 1),
    ("Which reaches leak the most in the wet-year outlook?", 4),
    ("What did the latest ensemble give for the share within 2 m, P10 to P90?", 3),
    ("How many runs has each origin filed?",
     "SELECT origin, count(*) AS runs FROM {T}.model_runs GROUP BY origin ORDER BY runs DESC"),
    ("Which study has the most findings?",
     "SELECT s.title, count(*) AS findings FROM {T}.study_findings f JOIN {T}.studies s ON s.study_id = f.study_id "
     "GROUP BY s.title ORDER BY findings DESC LIMIT 1"),
    ("What was the total metered extraction in the 2025 calendar year, in GL?",
     "SELECT round(sum(extraction_ml) / 1000, 3) AS extraction_gl FROM {T}.bore_extractions_monthly "
     "WHERE month >= DATE'2025-01-01' AND month < DATE'2026-01-01'"),
    ("Which monitoring bore had the shallowest observed water level?",
     "SELECT bore_id, min(depth_to_water_m) AS shallowest_depth_m FROM {T}.bore_water_levels "
     "GROUP BY bore_id ORDER BY shallowest_depth_m ASC LIMIT 1"),
    ("How many monitoring bores are high or elevated risk in each outlook season?",
     "SELECT season, count_if(risk IN ('high', 'elevated')) AS bores_at_risk FROM {T}.outlook_bore_risk "
     "GROUP BY season ORDER BY season"),
]

SAMPLES = [EXAMPLES[1][0], EXAMPLES[0][0], EXAMPLES[2][0], EXAMPLES[3][0]]


def _lines(text: str) -> list[str]:
    parts = text.split("\n")
    return [p + "\n" for p in parts[:-1]] + [parts[-1]]


def serialized(catalog: str, schema: str) -> str:
    T = f"`{catalog}`.`{schema}`"
    n = iter(range(1, 10_000))
    nid = lambda: f"{next(n):032x}"  # fixed width, so every list is in id order
    space = {
        "version": 2,
        "config": {"sample_questions": [{"id": nid(), "question": [q]} for q in SAMPLES]},
        "data_sources": {"tables": [{"identifier": f"{catalog}.{schema}.{t}"} for t in sorted(TABLES)]},
        "instructions": {
            "text_instructions": [{"id": nid(), "content": _lines(INSTRUCTIONS)}],
            "example_question_sqls": [{"id": nid(), "question": [q], "sql": _lines(sql.format(T=T))} for q, sql in EXAMPLES],
        },
        "benchmarks": {"questions": [
            {"id": nid(), "question": [q],
             "answer": [{"format": "SQL", "content": _lines((EXAMPLES[a][1] if isinstance(a, int) else a).format(T=T))}]}
            for q, a in BENCHMARKS]},
    }
    space["data_sources"]["tables"].sort(key=lambda x: x["identifier"])
    return json.dumps(space)
