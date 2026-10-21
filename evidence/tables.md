# Unity Catalog objects in `<catalog>.gw_submit`

Collected 2026-10-21 02:40 UTC.

## aquifer_cells

- type: MATERIALIZED_VIEW
- rows: 4800
- comment: MODFLOW grid of the synthetic sample district: one row per layer/row/col cell with geometry and aquifer properties (made-up data, not placed anywhere)
- columns: layer bigint, row bigint, col bigint, delr double, delc double, x_m double, y_m double, lon double, lat double, top double, botm double, k double, k33 double, ss double, irrigated bigint, land_use string, unit string

## bore_extractions_monthly

- type: MATERIALIZED_VIEW
- rows: 288
- comment: Metered monthly groundwater extraction per production bore, ML (synthetic)
- columns: bore_id string, month date, extraction_ml double

## bore_water_levels

- type: MATERIALIZED_VIEW
- rows: 440
- comment: Observed groundwater levels at monitoring bores, m AHD (synthetic)
- columns: bore_id string, obs_date date, water_level_mahd double, depth_to_water_m double, method string

## bores

- type: MATERIALIZED_VIEW
- rows: 32
- comment: Groundwater bores of the synthetic sample district: licensed production bores and the monitoring network
- columns: bore_id string, bore_type string, layer bigint, row bigint, col bigint, lon double, lat double, screen_from_m double, screen_to_m double, landholder string (masked), licence_no string (masked), entitlement_ml double

## boundary_cells

- type: MATERIALIZED_VIEW
- rows: 363
- comment: Model boundary conditions: river, supply canals, sub-surface drains and regional heads (synthetic)
- columns: kind string, name string, layer bigint, row bigint, col bigint, stage double, rbot double, cond double, reach string

## ensemble_bore_bands

- type: MANAGED
- rows: 500
- comment: Per monitoring bore and stress period: weighted P10/P50/P90 simulated head (m AHD) over behavioural realizations
- columns: ensemble_id string, bore_id string, period int, month string, head_p10 double, head_p50 double, head_p90 double

## ensemble_cell_stats

- type: MANAGED
- rows: 2400
- comment: Per-cell probability of a shallow (<2 m) water table at end of simulation, weighted over behavioural realizations
- columns: ensemble_id string, row int, col int, lon double, lat double, p_dtw_lt_2m double, dtw_p10 double, dtw_p50 double, dtw_p90 double, p_dtw_lt_2m_any_month double

## ensemble_monthly

- type: MANAGED
- rows: 25
- comment: Per stress period: weighted mean and P10/P50/P90 of the share of the district with the water table within 2 m, over behavioural realizations
- columns: ensemble_id string, period int, month string, area_mean double, area_p10 double, area_p50 double, area_p90 double

## ensemble_realizations

- type: MANAGED
- rows: 32
- comment: Per-realization parameters and fit for each ensemble
- columns: ensemble_id string, realization int, k_mult double, sy double, deep_drainage_frac double, rain_mult double, ok boolean, rmse_m double, behavioural boolean, weight double, pct_area_dtw_lt_2m double, runtime_s double, executor string, k_mult_upper double, k_mult_lower double, peak_pct_area_dtw_lt_2m double

## ensemble_runs

- type: MANAGED
- rows: 1
- comment: Monte Carlo uncertainty ensembles run as Spark jobs
- columns: ensemble_id string, created_at timestamp, run_by string, label string, config_json string, status string, job_run_id bigint, n_realizations int, n_ok int, n_behavioural int, rmse_threshold_m double, mean_pct_area_dtw_lt_2m double, p90_pct_area_dtw_lt_2m double, runtime_s double, mlflow_run_id string, study_id string, scenario_name string, p10_pct_area_dtw_lt_2m double, peak_mean_pct_area_dtw_lt_2m double

## model_runs

- type: MANAGED
- rows: 8
- comment: One row per MODFLOW 6 simulation run from the Groundwater Studio app
- columns: run_id string, created_at timestamp, run_by string, label string, scenario_json string, status string, mf6_version string, runtime_s double, rmse_m double, bias_m double, n_obs int, pct_area_dtw_lt_2m double, max_drawdown_m double, canal_seepage_ml double, bore_extraction_ml double, archive_path string, mlflow_run_id string, inputs_read_as string, scenario_name string, scenario_version int, study_id string, origin string, inputs_digest string

## ops_outlook_bore_risk

- type: FOREIGN
- rows: 60
- comment: 
- columns: season string, bore_id string, run_id string, run_label string, run_at timestamp, min_depth_m double, final_depth_m double, months_within_2m int, risk string

## ops_outlook_reach_seepage

- type: FOREIGN
- rows: 30
- comment: 
- columns: season string, reach string, run_id string, run_label string, run_at timestamp, seepage_ml double, lined boolean, seepage_rank int

## outlook_bore_risk

- type: MATERIALIZED_VIEW
- rows: 60
- comment: Gold: monitoring bores ranked by shallow-watertable risk under the latest dry, average and wet outlook runs (served to the app from Lakebase)
- columns: season string, bore_id string, run_id string, run_label string, run_at timestamp, min_depth_m double, final_depth_m double, months_within_2m int, risk string

## outlook_reach_seepage

- type: MATERIALIZED_VIEW
- rows: 30
- comment: Gold: supply-channel seepage per 2 km reach under the latest dry, average and wet outlook runs, ML over the simulation (served to the app from Lakebase)
- columns: season string, reach string, run_id string, run_label string, run_at timestamp, seepage_ml double, lined boolean, seepage_rank int

## raw_aquifer_cells

- type: MATERIALIZED_VIEW
- rows: 4800
- comment: Bronze: model grid as surveyed, one row per layer/row/col cell (parquet)
- columns: layer bigint, row bigint, col bigint, delr double, delc double, x_m double, y_m double, lon double, lat double, top double, botm double, k double, k33 double, ss double, irrigated bigint, land_use string, unit string, _rescued_data string

## raw_bore_levels

- type: STREAMING_TABLE
- rows: 454
- comment: Bronze: monitoring-bore readings as delivered by loggers and field dips (CSV per month), unvalidated
- columns: bore_id string, reading_time timestamp, water_level_mahd double, depth_to_water_m double, method string, source_file string, ingested_at timestamp

## raw_bores

- type: STREAMING_TABLE
- rows: 32
- comment: Bronze: the bore register as exported from the licensing system (CSV)
- columns: bore_id string, bore_type string, layer bigint, row bigint, col bigint, lon double, lat double, screen_from_m double, screen_to_m double, landholder string, licence_no string, entitlement_ml double, source_file string, ingested_at timestamp

## raw_boundary_cells

- type: MATERIALIZED_VIEW
- rows: 363
- comment: Bronze: model boundary conditions as surveyed: river, supply canals, sub-surface drains, regional heads (parquet)
- columns: kind string, name string, layer bigint, row bigint, col bigint, stage double, rbot double, cond double, reach string, _rescued_data string

## raw_extractions

- type: STREAMING_TABLE
- rows: 290
- comment: Bronze: metered monthly groundwater extraction per licensed production bore (CSV per month), unvalidated
- columns: bore_id string, month string, extraction_ml double, source_file string, ingested_at timestamp

## raw_weather

- type: STREAMING_TABLE
- rows: 49
- comment: Bronze: monthly rainfall and reference ET0 from the district weather stations (JSON lines), unvalidated
- columns: station_id string, station_name string, month string, rainfall_mm double, et0_mm double, source_file string, ingested_at timestamp

## run_bore_heads

- type: MANAGED
- rows: 3840
- comment: Simulated vs observed monthly heads at monitoring bores, per run
- columns: run_id string, bore_id string, month date, sim_head_mahd double, obs_head_mahd double

## run_cell_results

- type: MANAGED
- rows: 19200
- comment: Final-period depth to water per grid cell for every filed run
- columns: run_id string, row int, col int, dtw_final_m double, change_m double, land_use string

## run_reach_seepage

- type: MANAGED
- rows: 80
- comment: Supply-channel seepage to groundwater per 2 km reach for every filed run, ML over the simulation
- columns: run_id string, reach string, seepage_ml double, lined boolean

## run_water_budget

- type: MANAGED
- rows: 3072
- comment: Monthly groundwater budget by component (ML), per run
- columns: run_id string, month date, component string, direction string, volume_ml double

## scenario_versions

- type: MANAGED
- rows: 0
- comment: Version history of Groundwater Studio scenarios: one row per save, with an auto-generated change summary
- columns: scenario string, version int, saved_at timestamp, saved_by string, summary string, scenario_json string

## studies

- type: MANAGED
- rows: 2
- comment: A research question and everything filed against it: scenarios, runs and findings. Opened from the Studio, by agents over MCP, or by jobs
- columns: study_id string, title string, question string, status string, created_by string, created_at timestamp, updated_at timestamp, conclusion string, origin string

## study_findings

- type: MANAGED
- rows: 7
- comment: Findings recorded against a study, each tied to the model runs that support it
- columns: study_id string, finding_id string, created_at timestamp, created_by string, kind string, text string, run_ids array<string>, origin string

## weather_monthly

- type: MATERIALIZED_VIEW
- rows: 48
- comment: Monthly rainfall and reference evapotranspiration (ET0) by weather station (synthetic)
- columns: station_id string, station_name string, month date, rainfall_mm double, et0_mm double

## Column mask, read as a user outside the data stewards group

| bore_id | bore_type | landholder | licence_no |
|---|---|---|---|
| PB-01 | production | *** restricted *** | *** restricted *** |
| PB-02 | production | *** restricted *** | *** restricted *** |
| PB-03 | production | *** restricted *** | *** restricted *** |
