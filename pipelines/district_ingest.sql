-- Groundwater Studio: Lakeflow Spark Declarative Pipeline for the sample district.
--
-- Bronze: Auto Loader picks up raw files from the landing volume as they arrive (telemetry CSVs, weather JSON lines,
-- the bore register and the model geometry). Silver: the model input tables the Studio reads, cleaned by expectations,
-- with the landholder and licence columns masked. Gold: the latest seasonal outlook, ranked for operations, which is
-- synced into Lakebase for the app's Operations sheet.
--
-- Pipeline configuration: landing (volume path), fq (catalog.schema of the install), mask_fn (column mask function).

-- ---------------------------------------------------------------- bronze
CREATE OR REFRESH STREAMING TABLE raw_bore_levels
COMMENT 'Bronze: monitoring-bore readings as delivered by loggers and field dips (CSV per month), unvalidated'
AS SELECT *, _metadata.file_path AS source_file, current_timestamp() AS ingested_at
FROM STREAM read_files('${landing}/telemetry/bore_levels/', format => 'csv', header => true,
  schema => 'bore_id STRING, reading_time TIMESTAMP, water_level_mahd DOUBLE, depth_to_water_m DOUBLE, method STRING');

CREATE OR REFRESH STREAMING TABLE raw_extractions
COMMENT 'Bronze: metered monthly groundwater extraction per licensed production bore (CSV per month), unvalidated'
AS SELECT *, _metadata.file_path AS source_file, current_timestamp() AS ingested_at
FROM STREAM read_files('${landing}/telemetry/extractions/', format => 'csv', header => true,
  schema => 'bore_id STRING, month STRING, extraction_ml DOUBLE');

CREATE OR REFRESH STREAMING TABLE raw_weather
COMMENT 'Bronze: monthly rainfall and reference ET0 from the district weather stations (JSON lines), unvalidated'
AS SELECT *, _metadata.file_path AS source_file, current_timestamp() AS ingested_at
FROM STREAM read_files('${landing}/weather/', format => 'json',
  schema => 'station_id STRING, station_name STRING, month STRING, rainfall_mm DOUBLE, et0_mm DOUBLE');

CREATE OR REFRESH STREAMING TABLE raw_bores
COMMENT 'Bronze: the bore register as exported from the licensing system (CSV)'
AS SELECT *, _metadata.file_path AS source_file, current_timestamp() AS ingested_at
FROM STREAM read_files('${landing}/reference/', format => 'csv', header => true, pathGlobFilter => 'bores*.csv',
  schema => 'bore_id STRING, bore_type STRING, layer BIGINT, row BIGINT, col BIGINT, lon DOUBLE, lat DOUBLE,
             screen_from_m DOUBLE, screen_to_m DOUBLE, landholder STRING, licence_no STRING, entitlement_ml DOUBLE');

CREATE OR REFRESH MATERIALIZED VIEW raw_aquifer_cells
COMMENT 'Bronze: model grid as surveyed, one row per layer/row/col cell (parquet)'
AS SELECT * FROM read_files('${landing}/reference/', format => 'parquet', pathGlobFilter => 'aquifer_cells*.parquet');

CREATE OR REFRESH MATERIALIZED VIEW raw_boundary_cells
COMMENT 'Bronze: model boundary conditions as surveyed: river, supply canals, sub-surface drains, regional heads (parquet)'
AS SELECT * FROM read_files('${landing}/reference/', format => 'parquet', pathGlobFilter => 'boundary_cells*.parquet');

-- ---------------------------------------------------------------- silver: the model inputs
CREATE OR REFRESH MATERIALIZED VIEW bores (
  bore_id STRING COMMENT 'PB-nn production bore or OB-nn monitoring bore',
  bore_type STRING COMMENT 'production | monitoring',
  layer BIGINT COMMENT 'Model layer of the screen (0 = upper aquifer)',
  row BIGINT COMMENT 'Model row, 0-based',
  col BIGINT COMMENT 'Model column, 0-based',
  lon DOUBLE, lat DOUBLE,
  screen_from_m DOUBLE, screen_to_m DOUBLE,
  landholder STRING MASK ${mask_fn} COMMENT 'Restricted: visible to the data stewards group only',
  licence_no STRING MASK ${mask_fn} COMMENT 'Restricted: visible to the data stewards group only',
  entitlement_ml DOUBLE COMMENT 'Licensed annual entitlement, ML',
  CONSTRAINT bore_id_present EXPECT (bore_id IS NOT NULL) ON VIOLATION DROP ROW,
  CONSTRAINT known_type EXPECT (bore_type IN ('production', 'monitoring')) ON VIOLATION DROP ROW
)
COMMENT 'Groundwater bores of the synthetic sample district: licensed production bores and the monitoring network'
AS SELECT bore_id, bore_type, layer, row, col, lon, lat, screen_from_m, screen_to_m, landholder, licence_no, entitlement_ml
FROM raw_bores;

CREATE OR REFRESH MATERIALIZED VIEW aquifer_cells
COMMENT 'MODFLOW grid of the synthetic sample district: one row per layer/row/col cell with geometry and aquifer properties (made-up data, not placed anywhere)'
AS SELECT layer, row, col, delr, delc, x_m, y_m, lon, lat, top, botm, k, k33, ss, irrigated, land_use, unit FROM raw_aquifer_cells;

CREATE OR REFRESH MATERIALIZED VIEW boundary_cells
COMMENT 'Model boundary conditions: river, supply canals, sub-surface drains and regional heads (synthetic)'
AS SELECT kind, name, layer, row, col, stage, rbot, cond, reach FROM raw_boundary_cells;

CREATE OR REFRESH PRIVATE MATERIALIZED VIEW bore_levels_checked (
  CONSTRAINT bore_id_present EXPECT (bore_id IS NOT NULL AND bore_id <> '') ON VIOLATION DROP ROW,
  CONSTRAINT bore_in_register EXPECT (in_register) ON VIOLATION DROP ROW,
  CONSTRAINT level_plausible EXPECT (water_level_mahd BETWEEN 50 AND 200) ON VIOLATION DROP ROW
)
AS SELECT r.bore_id, CAST(r.reading_time AS DATE) AS obs_date, r.water_level_mahd, r.depth_to_water_m, r.method,
          b.bore_id IS NOT NULL AS in_register
FROM raw_bore_levels r LEFT JOIN bores b ON r.bore_id = b.bore_id;

CREATE OR REFRESH MATERIALIZED VIEW bore_water_levels
COMMENT 'Observed groundwater levels at monitoring bores, m AHD (synthetic)'
AS SELECT bore_id, obs_date, water_level_mahd, depth_to_water_m, method FROM bore_levels_checked;

CREATE OR REFRESH PRIVATE MATERIALIZED VIEW extractions_checked (
  CONSTRAINT bore_in_register EXPECT (in_register) ON VIOLATION DROP ROW,
  CONSTRAINT non_negative EXPECT (extraction_ml >= 0) ON VIOLATION DROP ROW
)
AS SELECT r.bore_id, to_date(r.month || '-01') AS month, r.extraction_ml, b.bore_id IS NOT NULL AS in_register
FROM raw_extractions r LEFT JOIN bores b ON r.bore_id = b.bore_id AND b.bore_type = 'production';

CREATE OR REFRESH MATERIALIZED VIEW bore_extractions_monthly
COMMENT 'Metered monthly groundwater extraction per production bore, ML (synthetic)'
AS SELECT bore_id, month, extraction_ml FROM extractions_checked;

CREATE OR REFRESH MATERIALIZED VIEW weather_monthly (
  CONSTRAINT rainfall_non_negative EXPECT (rainfall_mm >= 0) ON VIOLATION DROP ROW,
  CONSTRAINT et0_non_negative EXPECT (et0_mm >= 0) ON VIOLATION DROP ROW
)
COMMENT 'Monthly rainfall and reference evapotranspiration (ET0) by weather station (synthetic)'
AS SELECT station_id, station_name, to_date(month || '-01') AS month, rainfall_mm, et0_mm FROM raw_weather;

-- ---------------------------------------------------------------- gold: the latest seasonal outlook, for operations
CREATE OR REFRESH MATERIALIZED VIEW outlook_bore_risk
COMMENT 'Gold: monitoring bores ranked by shallow-watertable risk under the latest dry, average and wet outlook runs (served to the app from Lakebase)'
AS WITH latest AS (
  SELECT run_id, label, created_at, lower(regexp_extract(label, '^Outlook: (\\w+)', 1)) AS season,
         row_number() OVER (PARTITION BY lower(regexp_extract(label, '^Outlook: (\\w+)', 1)) ORDER BY created_at DESC) AS rn
  FROM ${fq}.model_runs WHERE label LIKE 'Outlook: %'
), surface AS (
  SELECT b.bore_id, c.top FROM bores b JOIN aquifer_cells c ON c.layer = 0 AND c.row = b.row AND c.col = b.col
  WHERE b.bore_type = 'monitoring'
), depth AS (
  SELECT l.season, l.run_id, l.label, l.created_at, h.bore_id, h.month, s.top - h.sim_head_mahd AS depth_m
  FROM latest l JOIN ${fq}.run_bore_heads h ON h.run_id = l.run_id JOIN surface s ON s.bore_id = h.bore_id
  WHERE l.rn = 1 AND h.sim_head_mahd IS NOT NULL
)
SELECT season, bore_id, first(run_id) AS run_id, first(label) AS run_label, first(created_at) AS run_at,
       round(min(depth_m), 2) AS min_depth_m, round(max_by(depth_m, month), 2) AS final_depth_m,
       CAST(sum(CASE WHEN depth_m < 2 THEN 1 ELSE 0 END) AS INT) AS months_within_2m,
       CASE WHEN min(depth_m) < 1 THEN 'high' WHEN min(depth_m) < 2 THEN 'elevated' ELSE 'normal' END AS risk
FROM depth GROUP BY season, bore_id;

CREATE OR REFRESH MATERIALIZED VIEW outlook_reach_seepage
COMMENT 'Gold: supply-channel seepage per 2 km reach under the latest dry, average and wet outlook runs, ML over the simulation (served to the app from Lakebase)'
AS WITH latest AS (
  SELECT run_id, label, created_at, lower(regexp_extract(label, '^Outlook: (\\w+)', 1)) AS season,
         row_number() OVER (PARTITION BY lower(regexp_extract(label, '^Outlook: (\\w+)', 1)) ORDER BY created_at DESC) AS rn
  FROM ${fq}.model_runs WHERE label LIKE 'Outlook: %'
)
SELECT l.season, s.reach, l.run_id, l.label AS run_label, l.created_at AS run_at, round(s.seepage_ml, 1) AS seepage_ml, s.lined,
       CAST(rank() OVER (PARTITION BY l.season ORDER BY s.seepage_ml DESC) AS INT) AS seepage_rank
FROM latest l JOIN ${fq}.run_reach_seepage s ON s.run_id = l.run_id
WHERE l.rn = 1 AND s.reach IS NOT NULL;
