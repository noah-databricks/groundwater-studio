export type Cell = { row: number; col: number; name?: string };
export type Bore = {
  bore_id: string; bore_type: "production" | "monitoring" | "proposed"; layer: number; row: number; col: number;
  landholder?: string | null; entitlement_ml?: number | null;
};
export type Grid = {
  nlay: number; nrow: number; ncol: number; delr_km: number; delc_km: number;
  top: (number | null)[][]; botm: (number | null)[][][];
};
export type Features = { river: Cell[]; canal: Cell[]; drain: Cell[]; chd?: Cell[]; ghb?: Cell[]; lake?: Cell[]; uzf?: Cell[] };

export type Crop = "rice" | "pasture" | "broadacre" | "horticulture" | "dryland";
export type Reach = { id: string; channel: string; cells: { row: number; col: number }[]; length_km: number };

export type ModelInfo = {
  grid: Grid & { nlay: number };
  land_use: Crop[][]; crops: { code: Crop; label: string; water: number; drain: number }[]; reaches: Reach[];
  top: (number | null)[][]; botm: (number | null)[][][];
  periods: string[]; features: Features; bores: Bore[];
  inputs: { read_as: string; read_s: number; digest: string };
};

export type Scenario = {
  k_mult: number; sy: number; rain_mult: number; et_mult: number; deep_drainage_frac: number;
  pumping_mult: number; canal_lining_pct: number; extra_bores: { row: number; col: number; layer: number; ML_per_year: number }[];
  lined_reaches: string[]; land_use: [number, number, Crop][];
  drain_lines?: DrainLine[];
  fidelity?: Fidelity | null;
};
/** A proposed sub-surface (interceptor) drain: a connected line of cells, its invert depth below the surface. */
export type DrainLine = { name: string; cells: [number, number][]; depth_m: number; cond: number };
/** How finely MODFLOW solves the district (the inputs stay at 250 m, two aquifers, monthly). */
export type Fidelity = { refine: number; sublayers: number; nstp: number; solver: "fast" | "standard" | "tight" };
export type FidelityEstimate = Fidelity & { cells: number; time_steps: number; cell_m: number; estimate_s: number; baseline_cached: boolean };
export type Task = { task_id: string; kind: string; label: string; status: "running" | "finished" | "failed"; stage: string; done: number; total: number;
  started: number; finished: number | null; estimate_s: number; elapsed_s?: number; run_id: string | null; error: string | null;
  summary: Record<string, unknown> | null; fidelity?: FidelityEstimate };

export type Version = { version: number; saved_at: string; saved_by: string; summary: string };
/** The open scenario document: `saved` is the content of `version` as last saved (or the defaults when new). */
export type Doc = { file: string | null; name: string; version: number | null; saved: Scenario; savedBy?: string; savedAt?: string };
export type Tool = "select" | "landuse" | "channels" | "bores" | "drains" | "zones" | "section" | "paint";
/** A named area of the district, shared in the workspace volume. */
export type Zone = { name: string; file: string; cells: [number, number][]; hectares: number; note: string;
  polygon: [number, number][] | null; rect: [number, number, number, number] | null; created_by: string; created_at: string };
/** A zone being drawn: a rectangle of cells, or a polygon in fractional cell indices. */
export type ZoneShape = { rect: [number, number, number, number] } | { polygon: [number, number][] };
export type CellProbe = {
  scenario: string; row: number; col: number; periods: string[]; land_m_ahd: number; land_use: Crop; recorded_land_use: Crop;
  irrigated: boolean; sy: number; layers: { layer: number; name: string; top_m: number; bottom_m: number; k_m_per_d: number; head_m: (number | null)[] }[];
  dtw_m: (number | null)[]; baseline_dtw_m: (number | null)[]; change_m: (number | null)[];
  budget_ml_by_month: Record<string, (number | null)[]>; bores: { bore_id: string; bore_type: string; layer: number }[];
  features: string[]; reach: string | null; proposed_bores: unknown[];
};
export type ZoneStats = {
  scenario: string; zone: string | null; n_cells: number; hectares: number; bbox: [number, number, number, number];
  months: { period: number; month: string; area_lt_2m_pct: number; baseline_area_lt_2m_pct: number; median_dtw_m: number; min_dtw_m: number; mean_change_m: number }[];
  budget_totals_ml: { component: string; in_ml: number; out_ml: number; net_ml: number }[]; discrepancy_pct: number;
};

export type Kpis = Record<string, number | null> & {
  pct_area_dtw_lt_2m_final: number; pct_area_dtw_lt_2m_peak: number; median_dtw_m: number; rmse_m: number | null;
  bias_m: number | null; n_obs: number; canal_seepage_ml: number; bore_extraction_ml: number; recharge_ml: number;
  gw_et_ml: number; max_discrepancy_pct: number; run_s: number;
};

export type RunResult = {
  run_id: string; scenario: Scenario; kpis: Kpis; baseline_kpis: Kpis; persisted: boolean;
  reach_seepage_ml: Record<string, number>; baseline_reach_seepage_ml: Record<string, number>;
  dtw: (number | null)[][][]; baseline_dtw: (number | null)[][][]; change_final: (number | null)[][];
  hydrographs: Record<string, { sim: (number | null)[] }>; baseline_hydrographs: Record<string, (number | null)[]>;
  observed: Record<string, { t: string[]; h: (number | null)[] }>; bore_rmse: Record<string, number>;
  budget: { kper: number; component: string; direction: "in" | "out"; volume_ml: number }[];
  fidelity?: (Fidelity & { cells: number; cell_m: number; estimate_s: number }) | null;
  inputs: { read_as: string; read_s: number };
};

export type UploadedRun = {
  name: string; model: string; run_by: string; run_s: number; grid: Grid; times: number[]; time_units: string;
  wt: (number | null)[][][]; dtw: (number | null)[][][]; features: Features;
  bores: (Bore & { rate?: number })[]; budget_last: { term: string; direction: string; rate: number }[] | null;
  engine?: "mf6" | "mf2005" | "mfnwt" | "mfusg"; georef?: Georef;
  raster?: { from: string; cells: number; raster: [number, number] } | null;
  display?: { coarsen: number; times_shown: number; times_total: number; native_cells: number };
};
/** Where a model sits in the world: its origin and rotation, and its coordinate reference when known. */
export type Georef = { xorigin: number; yorigin: number; angrot: number; epsg: number | null; placed?: boolean; extent?: number[]; centre_lonlat?: [number, number] };

export type FileItem = { name: string; bytes: number; modified: number | null };
export type Inspect = {
  files: { name: string; path: string; bytes: number; text: boolean }[]; model: string; model_type: string;
  nper: number; time_units: string; packages: { type: string; name: string; file: string }[];
  grid: { type: string; nlay?: number; nrow?: number; ncol?: number; extent_m?: [number, number] };
};

export type Me = {
  email: string; obo: boolean; platform: string; mf6: boolean; mf6_version?: string; mf6_error?: string | null;
  host: string; catalog: string; schema: string; job_id: number; experiment_id: string; cpus: number; scenario_job_id?: number;
};

export type PersistStatus = {
  done?: boolean;
  volume?: { ok: boolean; path?: string; error?: string };
  uc?: { ok: boolean; error?: string };
  mlflow?: { ok: boolean; url?: string; error?: string };
};

/** What the 3D view and section draw, whichever model is active. */
export type SceneModel = {
  key: string; grid: Grid; wt: (number | null)[][]; dtw: (number | null)[][];
  baseWt?: (number | null)[][]; change?: (number | null)[][] | null;
  features: Features; bores: Bore[]; probability?: (number | null)[][] | null;
  /** a property being edited, 0-1 on its own scale, drawn instead of depth to water */
  prop?: (number | null)[][] | null;
};

/** Something handed to the agent: a file it can open (path) or a thing it can look up by name. */
export type ChatRef = { name: string; hint: string; kind: "model" | "scenario" | "run" | "file" | "image"; path?: string };
export type UserFiles = { uploads: { name: string; path: string; bytes: number; modified: number | null }[];
  artifacts: { folder: string; path: string; files: { name: string; path: string; bytes: number }[] }[]; uploads_path: string; artifacts_path: string };
