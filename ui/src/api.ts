import type { FileItem, Inspect, Me, ModelInfo, PersistStatus, RunResult, Scenario, UploadedRun, Version } from "./types";

export type SavedScenario = { name: string; label?: string; version: number | null; saved_by?: string; saved_at?: string; summary?: string; scenario: Scenario };

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = { "X-Modflow-Client": "studio" };
  const r = await fetch(path, { ...init, headers: init.body instanceof FormData ? { ...base, ...init.headers } : { "Content-Type": "application/json", ...base, ...init.headers } });
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.detail || msg; } catch { /* not json */ }
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return r.json() as Promise<T>;
}

const pending = new Map<string, string>();  // chunked uploads waiting on their last step

export const api = {
  me: () => req<Me>("/api/me"),
  model: () => req<ModelInfo>("/api/model"),
  run: (scenario: Scenario, label: string, persist: boolean, ref: { name: string; version: number } | null = null) =>
    req<RunResult>("/api/run", { method: "POST", body: JSON.stringify({ scenario, label, persist, ref }) }),
  runBackground: (scenario: Scenario, label: string, persist: boolean, ref: { name: string; version: number } | null = null) =>
    req<import("./types").Task>("/api/run?background=true", { method: "POST", body: JSON.stringify({ scenario, label, persist, ref }) }),
  task: (id: string) => req<import("./types").Task>(`/api/tasks/${id}`),
  taskResult: (id: string) => req<RunResult>(`/api/tasks/${id}/result`),
  fidelityEstimate: (f: import("./types").Fidelity) =>
    req<import("./types").FidelityEstimate>(`/api/fidelity/estimate?refine=${f.refine}&sublayers=${f.sublayers}&nstp=${f.nstp}&solver=${f.solver}`),
  runStatus: (id: string) => req<PersistStatus>(`/api/runs/${id}/status`),
  runs: () => req<RunRow[]>("/api/runs"),
  files: (kind: "models" | "scenarios") => req<FileItem[]>(`/api/files/${kind}`),
  upload: async (kind: "models" | "scenarios", file: File, overwrite = false, onProgress?: (frac: number) => void) => {
    if (file.size <= 16 * 1024 * 1024) {
      const fd = new FormData(); fd.append("file", file);
      return req<{ name: string }>(`/api/files/${kind}?overwrite=${overwrite}`, { method: "POST", body: fd });
    }
    // big packages go up in chunks; a retry to replace an existing file only repeats the last step
    const key = `${kind}/${file.name}/${file.size}/${file.lastModified}`;
    let uid = pending.get(key);
    if (!uid) {
      const s0 = await req<{ upload_id: string; chunk_bytes: number }>("/api/upload", { method: "POST", body: JSON.stringify({ kind, name: file.name, size: file.size }) });
      uid = s0.upload_id;
      for (let off = 0; off < file.size; off += s0.chunk_bytes) {
        const body = await file.slice(off, off + s0.chunk_bytes).arrayBuffer();
        await req(`/api/upload/${uid}?offset=${off}`, { method: "PUT", body, headers: { "Content-Type": "application/octet-stream" } });
        onProgress?.(Math.min(1, (off + s0.chunk_bytes) / file.size));
      }
      pending.set(key, uid);
    }
    const r = await req<{ name: string }>(`/api/upload/${uid}/finish?overwrite=${overwrite}`, { method: "POST" });
    pending.delete(key);
    return r;
  },
  remove: (kind: "models" | "scenarios", name: string) => req(`/api/files/${kind}/${encodeURIComponent(name)}`, { method: "DELETE" }),
  fileUrl: (kind: "models" | "scenarios", name: string) => `/api/files/${kind}/${encodeURIComponent(name)}`,
  saveScenario: (name: string, scenario: Scenario, opts: { base_version?: number | null; overwrite?: boolean } = {}) =>
    req<{ name: string; version: number; summary: string; saved_at: string; saved_by: string }>("/api/scenarios",
      { method: "POST", body: JSON.stringify({ name, scenario, base_version: opts.base_version ?? null, overwrite: !!opts.overwrite }) }),
  loadScenario: (name: string, version?: number) =>
    req<SavedScenario>(`/api/scenarios/${encodeURIComponent(name)}${version != null ? `?version=${version}` : ""}`),
  history: (name: string) => req<Version[]>(`/api/scenarios/${encodeURIComponent(name)}/history`),
  inspect: (name: string) => req<Inspect>(`/api/models/${encodeURIComponent(name)}/inspect`),
  preview: (name: string, member: string) => req<{ member: string; text: string }>(`/api/models/${encodeURIComponent(name)}/preview?member=${encodeURIComponent(member)}`),
  probeCell: (row: number, col: number, scenario: Scenario) =>
    req<import("./types").CellProbe>("/api/probe/cell", { method: "POST", body: JSON.stringify({ row, col, scenario: { scenario } }) }),
  probeZone: (where: Record<string, unknown>, scenario: Scenario) =>
    req<import("./types").ZoneStats>("/api/probe/zone", { method: "POST", body: JSON.stringify({ where, scenario: { scenario } }) }),
  zones: () => req<import("./types").Zone[]>("/api/zones"),
  saveZone: (name: string, where: Record<string, unknown>, note = "") =>
    req<import("./types").Zone>("/api/zones", { method: "POST", body: JSON.stringify({ name, where, note }) }),
  deleteZone: (name: string) => req(`/api/zones/${encodeURIComponent(name)}`, { method: "DELETE" }),
  buildGet: (name: string) => req<import("./lib/build").BuildDoc>(`/api/build/${encodeURIComponent(name)}`),
  buildPreview: (name: string, doc: import("./lib/build").BuildDoc) =>
    req<{ files: { member: string; before: string; after: string }[]; stale: boolean }>(`/api/build/${encodeURIComponent(name)}/preview`, { method: "POST", body: JSON.stringify({ doc }) }),
  buildSave: (name: string, doc: import("./lib/build").BuildDoc) =>
    req<{ package: string; sha: string; changed_files: string[]; doc: import("./lib/build").BuildDoc }>(`/api/build/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ doc, base_sha: doc.base_sha }) }),
  buildOps: (name: string, doc: import("./lib/build").BuildDoc, ops: Record<string, unknown>[]) =>
    req<{ doc: import("./lib/build").BuildDoc; done: string[] }>(`/api/build/${encodeURIComponent(name)}/ops`, { method: "POST", body: JSON.stringify({ doc, ops }) }),
  buildNew: (spec: { name: string; nrow: number; ncol: number; cell_m: number; nlay: number; top: number; bottom: number; k: number; transient: boolean }) =>
    req<{ package: string }>("/api/build-new", { method: "POST", body: JSON.stringify(spec) }),
  previewFull: (name: string, member: string) => req<{ member: string; text: string }>(`/api/models/${encodeURIComponent(name)}/preview?full=true&member=${encodeURIComponent(member)}`),
  saveMember: (name: string, member: string, text: string) =>
    req<{ package: string; edited: string }>(`/api/models/${encodeURIComponent(name)}/member`, { method: "PUT", body: JSON.stringify({ member, text }) }),
  calParams: (name: string) => req<{ name: string; label: string; lower: number; upper: number; default: boolean }[]>(`/api/calibrate/${encodeURIComponent(name)}/parameters`),
  calibrate: (body: { name: string; observations_file: string; method: "glm" | "ies"; iterations: number; realizations: number; parameters: { name: string; lower: number; upper: number }[] }) =>
    req<import("./types").Task & { parameters: string[]; observations: number; agents: number }>("/api/calibrate", { method: "POST", body: JSON.stringify(body) }),
  calApply: (body: { name: string; task_id: string }) => req<{ package: string }>("/api/calibrate/apply", { method: "POST", body: JSON.stringify(body) }),
  convertModel: (name: string) => req<{ package: string; converted_from: string }>(`/api/models/${encodeURIComponent(name)}/convert`, { method: "POST" }),
  runUploaded: (name: string) => req<UploadedRun>(`/api/models/${encodeURIComponent(name)}/run`, { method: "POST" }),
  ensembles: () => req<{ completed: EnsembleRow[]; jobs: JobRow[] }>("/api/ensembles"),
  ensemble: (id: string) => req<EnsembleDetail>(`/api/ensembles/${id}`),
  launchEnsemble: (body: { scenario: Scenario; n: number; vary: import("./components/Ensemble").Vary; rmse_threshold_m: number; label: string;
    study_id?: string | null; scenario_name?: string | null }) =>
    req<{ ensemble_id: string; job_run_id: number; url: string; estimate_s: number }>("/api/ensembles", { method: "POST", body: JSON.stringify(body) }),
  data: () => req<DataCatalog>("/api/data"),
  studies: () => req<StudyRow[]>("/api/v1/studies"),
  study: (id: string) => req<StudyDetail>(`/api/v1/studies/${encodeURIComponent(id)}`),
  agentOptions: () => req<AgentOptions>("/api/agent/options"),
  userFiles: () => req<import("./types").UserFiles>("/api/user-files"),
  deleteUserFile: (path: string) => req(`/api/user-files?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  agentUpload: async (f: File) => {
    const fd = new FormData(); fd.append("file", f);
    const r = await fetch("/api/agent-uploads", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `Upload failed (${r.status})`);
    return (await r.json()) as { kind: "model" | "scenario" | "file"; name: string; path: string; hint: string };
  },
  agentStatus: () => req<AgentStatus>("/api/agent/status"),
  agentDelete: (id: string) => req(`/api/agent/sessions/${id}`, { method: "DELETE" }),
  agentSessions: () => req<AgentSessionRow[]>("/api/agent/sessions"),
  agentSession: (id: string) => req<AgentSnapshot>(`/api/agent/sessions/${id}`),
  agentStart: (body: { harness: string; model: string; mode: string; message: string; study_id?: string | null; attachments?: string[] }) =>
    req<{ session_id: string }>("/api/agent/sessions", { method: "POST", body: JSON.stringify(body) }),
  agentSend: (id: string, text: string, attachments: string[] = []) => req(`/api/agent/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text, attachments }) }),
  agentStop: (id: string) => req(`/api/agent/sessions/${id}/interrupt`, { method: "POST" }),
  agentMode: (id: string, mode: string) => req(`/api/agent/sessions/${id}/mode`, { method: "PUT", body: JSON.stringify({ mode }) }),
  agentResolve: (id: string, eid: string, action: "accept" | "decline") =>
    req(`/api/agent/sessions/${id}/elicitations/${encodeURIComponent(eid)}`, { method: "POST", body: JSON.stringify({ action }) }),
  createStudy: (title: string, question: string) => req<{ study_id: string }>("/api/v1/studies", { method: "POST", body: JSON.stringify({ title, question }) }),
};

export type StudyRow = {
  study_id: string; title: string; question: string; status: "open" | "concluded" | "abandoned"; created_by: string;
  created_at: string; updated_at: string; origin: string | null; n_runs: number; n_findings: number;
};
export type Finding = { finding_id: string; created_at: string; created_by: string; kind: "observation" | "conclusion" | "caveat"; text: string; run_ids: string[]; origin: string | null };
export type StudyDetail = {
  study: StudyRow & { conclusion: string | null };
  runs: { run_id: string; created_at: string; run_by: string; label: string | null; origin: string | null; scenario_name: string | null;
    scenario_version: number | null; pct_area_dtw_lt_2m: number | null; canal_seepage_ml: number | null; bore_extraction_ml: number | null; rmse_m: number | null }[];
  findings: Finding[];
};

/** Who filed something, in the register's words: the Studio, an agent (by harness), another MCP client, or a job. */
export function source(origin: string | null | undefined): { label: string; kind: "studio" | "agent" | "mcp" | "job" | "api" } {
  const o = origin ?? "";
  if (!o || o === "studio") return { label: "Studio", kind: "studio" };
  if (o.startsWith("mcp:omnigent/")) {
    const h = o.slice("mcp:omnigent/".length);
    return { label: `Agent · ${({ "claude-sdk": "Claude", codex: "Codex", pi: "Pi" } as Record<string, string>)[h] ?? h}`, kind: "agent" };
  }
  if (o.startsWith("mcp")) return { label: o.includes(":") ? `MCP · ${o.split(":").slice(1).join(":")}` : "MCP", kind: "mcp" };
  if (o.startsWith("job")) return { label: "Job", kind: "job" };
  return { label: "API", kind: "api" };
}

export type RunRow = {
  run_id: string; created_at: string; run_by: string; label: string | null; scenario_json: string; rmse_m: number | null;
  scenario_name: string | null; scenario_version: number | null;
  pct_area_dtw_lt_2m: number | null; max_drawdown_m: number | null; canal_seepage_ml: number | null;
  bore_extraction_ml: number | null; runtime_s: number | null; archive_path: string | null; mlflow_run_id: string | null;
  study_id: string | null; origin: string | null;
};
export type EnsembleRow = {
  ensemble_id: string; created_at: string; run_by: string; label: string; n_realizations: number; n_ok: number;
  n_behavioural: number; rmse_threshold_m: number; mean_pct_area_dtw_lt_2m: number; p90_pct_area_dtw_lt_2m: number;
  p10_pct_area_dtw_lt_2m?: number | null; peak_mean_pct_area_dtw_lt_2m?: number | null; study_id?: string | null; scenario_name?: string | null;
  runtime_s: number; job_run_id: number; mlflow_run_id: string | null;
};
export type JobRow = { ensemble_id: string | null; label: string | null; run_by: string | null; n: string | null; job_run_id: number; life_cycle: string; result: string; start: number; url: string };
export type EnsembleDetail = {
  p: (number | null)[][]; p10: (number | null)[][]; p50: (number | null)[][]; p90: (number | null)[][];
  realizations: { realization: number; k_mult: number; k_mult_upper?: number | null; k_mult_lower?: number | null; sy: number;
    deep_drainage_frac: number; rain_mult: number; ok: boolean; rmse_m: number | null; behavioural: boolean; weight: number;
    pct_area_dtw_lt_2m: number | null; peak_pct_area_dtw_lt_2m?: number | null; runtime_s: number }[];
  p_any?: (number | null)[][] | null;
  monthly?: { period: number; month: string; area_mean: number | null; area_p10: number | null; area_p50: number | null; area_p90: number | null }[];
  bores?: Record<string, { p10: (number | null)[]; p50: (number | null)[]; p90: (number | null)[] }>;
  summary?: Partial<EnsembleRow>; config?: { scenario?: Record<string, unknown>; vary?: Record<string, unknown> };
};
export type DataCatalog = {
  tables: { table_name: string; comment: string | null; rows: number | null; url: string }[];
  masked_sample: { bore_id: string; landholder: string; licence_no: string; entitlement_ml: number }[];
  read_as: string; volumes: Record<string, string>; links: Record<string, string>;
};

export type AgentOptions = {
  harnesses: { id: string; label: string; models: string[]; default_model: string }[];
  modes: { id: "ask" | "auto" | "read"; label: string }[]; runtime: { server_version?: string; host?: string; up_since?: number | null };
};
export type AgentStatus = { up: boolean; error: string | null; host_id: string | null; up_since: number | null };
export type AgentSessionRow = { id: string; title: string; status: string; harness: string | null; llm_model: string | null; created_at: number; updated_at: number | null;
  total_cost_usd: number | null; waiting?: number; labels?: Record<string, string> };
export type AgentEnsemble = { ensemble_id: string; job_run_id: number; url?: string; label: string | null; state: "running" | "finished" | "failed";
  started_ms: number | null; ended_ms: number | null; message?: string; told: boolean };
export type AgentItem = { id: string; type: string; status?: string; created_at: number;
  data: { role?: string; content?: { type: string; text?: string; image_url?: string; filename?: string }[]; name?: string; arguments?: string; output?: string; call_id?: string } };
export type Elicitation = { elicitation_id?: string; id?: string; params?: { message?: string; tool_name?: string; arguments?: unknown; [k: string]: unknown }; [k: string]: unknown };
export type AgentSnapshot = {
  id: string; title: string; status: "idle" | "running" | "waiting" | "failed" | string; harness: string; llm_model: string | null;
  host_id: string | null; host_online: boolean | null; items: AgentItem[]; pending_elicitations: Elicitation[]; mode: "ask" | "auto" | "read";
  total_cost_usd: number | null; last_task_error: string | { message?: string; code?: string } | null; ensembles?: AgentEnsemble[]; tasks?: import("./types").Task[];
};
