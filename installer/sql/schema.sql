-- Groundwater Studio: Unity Catalog objects. {S} is replaced with <catalog>.<schema> by the installer.
-- Inputs: the synthetic sample district (made-up data, placed nowhere), loaded from the landing volume.

CREATE OR REPLACE TABLE {S}.aquifer_cells COMMENT 'MODFLOW grid of the synthetic sample district: one row per layer/row/col cell with geometry and aquifer properties (made-up data, not placed anywhere)'
AS SELECT * FROM parquet.`{V}/landing/aquifer_cells.parquet`;
ALTER TABLE {S}.aquifer_cells ALTER COLUMN land_use COMMENT 'rice | pasture | broadacre | horticulture | dryland';
CREATE OR REPLACE TABLE {S}.bore_extractions_monthly COMMENT 'Metered monthly groundwater extraction per production bore, ML (synthetic)'
AS SELECT * FROM parquet.`{V}/landing/bore_extractions_monthly.parquet`;
CREATE OR REPLACE TABLE {S}.bore_water_levels COMMENT 'Observed groundwater levels at monitoring bores, m AHD (synthetic)'
AS SELECT * FROM parquet.`{V}/landing/bore_water_levels.parquet`;
CREATE OR REPLACE TABLE {S}.bores COMMENT 'Groundwater bores of the synthetic sample district: licensed production bores (PB-) and monitoring piezometers (OB-). Made-up data. Landholder and licence are masked columns.'
AS SELECT * FROM parquet.`{V}/landing/bores.parquet`;
CREATE OR REPLACE TABLE {S}.boundary_cells COMMENT 'Model boundary conditions: river, supply canals, sub-surface drains, regional constant heads (synthetic)'
AS SELECT * FROM parquet.`{V}/landing/boundary_cells.parquet`;
ALTER TABLE {S}.boundary_cells ALTER COLUMN reach COMMENT 'Supply-channel asset reach (2 km sections), e.g. MC-03';
CREATE OR REPLACE TABLE {S}.weather_monthly COMMENT 'Monthly rainfall and reference evapotranspiration (ET0) by weather station, mm (synthetic)'
AS SELECT * FROM parquet.`{V}/landing/weather_monthly.parquet`;


-- Landholder identity and licence numbers are visible only to members of the data stewards group
CREATE OR REPLACE FUNCTION {S}.mask_restricted(v STRING) RETURN
  CASE WHEN is_account_group_member('{STEWARDS}') OR v IS NULL THEN v ELSE '*** restricted ***' END;
ALTER TABLE {S}.bores ALTER COLUMN landholder SET MASK {S}.mask_restricted;
ALTER TABLE {S}.bores ALTER COLUMN licence_no SET MASK {S}.mask_restricted;

-- Outputs written by the app and the jobs (created empty; never dropped by a reinstall)
CREATE TABLE IF NOT EXISTS {S}.ensemble_bore_bands (
  ensemble_id STRING,
  bore_id STRING,
  period INT,
  month STRING,
  head_p10 DOUBLE,
  head_p50 DOUBLE,
  head_p90 DOUBLE)
COMMENT 'Per monitoring bore and stress period: weighted P10/P50/P90 simulated head (m AHD) over behavioural realizations';
CREATE TABLE IF NOT EXISTS {S}.ensemble_cell_stats (
  ensemble_id STRING,
  row INT,
  col INT,
  lon DOUBLE,
  lat DOUBLE,
  p_dtw_lt_2m DOUBLE,
  dtw_p10 DOUBLE,
  dtw_p50 DOUBLE,
  dtw_p90 DOUBLE,
  p_dtw_lt_2m_any_month DOUBLE)
COMMENT 'Per-cell probability of a shallow (<2 m) water table at end of simulation, weighted over behavioural realizations';
CREATE TABLE IF NOT EXISTS {S}.ensemble_monthly (
  ensemble_id STRING,
  period INT,
  month STRING,
  area_mean DOUBLE,
  area_p10 DOUBLE,
  area_p50 DOUBLE,
  area_p90 DOUBLE)
COMMENT 'Per stress period: weighted mean and P10/P50/P90 of the share of the district with the water table within 2 m, over behavioural realizations';
CREATE TABLE IF NOT EXISTS {S}.ensemble_realizations (
  ensemble_id STRING,
  realization INT,
  k_mult DOUBLE,
  sy DOUBLE,
  deep_drainage_frac DOUBLE,
  rain_mult DOUBLE,
  ok BOOLEAN,
  rmse_m DOUBLE,
  behavioural BOOLEAN,
  weight DOUBLE,
  pct_area_dtw_lt_2m DOUBLE,
  runtime_s DOUBLE,
  executor STRING,
  k_mult_upper DOUBLE,
  k_mult_lower DOUBLE,
  peak_pct_area_dtw_lt_2m DOUBLE)
COMMENT 'Per-realization parameters and fit for each ensemble';
CREATE TABLE IF NOT EXISTS {S}.ensemble_runs (
  ensemble_id STRING,
  created_at TIMESTAMP,
  run_by STRING,
  label STRING,
  config_json STRING,
  status STRING,
  job_run_id BIGINT,
  n_realizations INT,
  n_ok INT,
  n_behavioural INT,
  rmse_threshold_m DOUBLE,
  mean_pct_area_dtw_lt_2m DOUBLE,
  p90_pct_area_dtw_lt_2m DOUBLE,
  runtime_s DOUBLE,
  mlflow_run_id STRING,
  study_id STRING,
  scenario_name STRING,
  p10_pct_area_dtw_lt_2m DOUBLE,
  peak_mean_pct_area_dtw_lt_2m DOUBLE)
COMMENT 'Monte Carlo uncertainty ensembles run as Spark jobs';
CREATE TABLE IF NOT EXISTS {S}.model_runs (
  run_id STRING,
  created_at TIMESTAMP,
  run_by STRING,
  label STRING,
  scenario_json STRING,
  status STRING,
  mf6_version STRING,
  runtime_s DOUBLE,
  rmse_m DOUBLE,
  bias_m DOUBLE,
  n_obs INT,
  pct_area_dtw_lt_2m DOUBLE,
  max_drawdown_m DOUBLE,
  canal_seepage_ml DOUBLE,
  bore_extraction_ml DOUBLE,
  archive_path STRING,
  mlflow_run_id STRING,
  inputs_read_as STRING,
  scenario_name STRING COMMENT 'Saved scenario the run was issued from',
  scenario_version INT COMMENT 'Version of that scenario',
  study_id STRING COMMENT 'Study the run was filed against',
  origin STRING COMMENT 'studio | mcp:<client> | api | job:<run id>',
  inputs_digest STRING COMMENT 'Hash of the Unity Catalog inputs the run read')
COMMENT 'One row per MODFLOW 6 simulation run from the Groundwater Studio app';
CREATE TABLE IF NOT EXISTS {S}.run_bore_heads (
  run_id STRING,
  bore_id STRING,
  month DATE,
  sim_head_mahd DOUBLE,
  obs_head_mahd DOUBLE)
COMMENT 'Simulated vs observed monthly heads at monitoring bores, per run';
CREATE TABLE IF NOT EXISTS {S}.run_cell_results (
  run_id STRING NOT NULL,
  row INT,
  col INT,
  dtw_final_m DOUBLE COMMENT 'Depth to water below land surface, final stress period',
  change_m DOUBLE COMMENT 'Water-table change vs the baseline, m (positive = rise)',
  land_use STRING)
COMMENT 'Final-period depth to water per grid cell for every filed run';
CREATE TABLE IF NOT EXISTS {S}.run_reach_seepage (
  run_id STRING NOT NULL,
  reach STRING,
  seepage_ml DOUBLE,
  lined BOOLEAN)
COMMENT 'Supply-channel seepage to groundwater per 2 km reach for every filed run, ML over the simulation';
CREATE TABLE IF NOT EXISTS {S}.run_water_budget (
  run_id STRING,
  month DATE,
  component STRING,
  direction STRING,
  volume_ml DOUBLE)
COMMENT 'Monthly groundwater budget by component (ML), per run';
CREATE TABLE IF NOT EXISTS {S}.scenario_versions (
  scenario STRING,
  version INT,
  saved_at TIMESTAMP,
  saved_by STRING,
  summary STRING,
  scenario_json STRING)
COMMENT 'Version history of Groundwater Studio scenarios: one row per save, with an auto-generated change summary';
CREATE TABLE IF NOT EXISTS {S}.studies (
  study_id STRING NOT NULL,
  title STRING,
  question STRING,
  status STRING COMMENT 'open | concluded | abandoned',
  created_by STRING,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  conclusion STRING,
  origin STRING COMMENT 'Where the study was opened: studio, mcp:<client>, job:<run id>')
COMMENT 'A research question and everything filed against it: scenarios, runs and findings. Opened from the Studio, by agents over MCP, or by jobs';
CREATE TABLE IF NOT EXISTS {S}.study_findings (
  study_id STRING NOT NULL,
  finding_id STRING NOT NULL,
  created_at TIMESTAMP,
  created_by STRING,
  kind STRING COMMENT 'observation | conclusion | caveat',
  text STRING,
  run_ids ARRAY<STRING> COMMENT 'Runs the finding rests on',
  origin STRING)
COMMENT 'Findings recorded against a study, each tied to the model runs that support it';
