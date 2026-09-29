import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RunRow } from "../api";
import { CROP_COLORS, CROP_ORDER } from "../lib/scenario";
import type { ChatRef, Crop, Doc, FileItem, Inspect, Reach, Scenario, UserFiles, Version } from "../types";
import { Icon } from "./Icon";
import type { Me } from "../types";
import { tableUrl, volumeUrl, workspacePath } from "../lib/ws";
import { REFINE, cellM, fidelity, fidelityText, isNative } from "../lib/scenario";
import { api } from "../api";
import type { Fidelity, FidelityEstimate } from "../types";

export const DEFAULTS: Scenario = { k_mult: 1, sy: 0.08, rain_mult: 1, et_mult: 1, deep_drainage_frac: 0.12, pumping_mult: 1, canal_lining_pct: 0, extra_bores: [], lined_reaches: [], land_use: [] };
export const ago = (iso?: string) => {
  if (!iso) return "";
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 1 ? "just now" : m < 60 ? `${Math.round(m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
};
const pct = (v: number) => `${Math.round(v * 100)}%`;
const kb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "");

type Lever = { key: keyof Omit<Scenario, "extra_bores" | "lined_reaches" | "land_use">; label: string; min: number; max: number; step: number; fmt: (v: number) => string };
const PACKAGES: { code: string; name: string; levers: Lever[]; summary: (s: Scenario) => string }[] = [
  { code: "RCH", name: "Recharge", summary: (s) => `rain ${pct(s.rain_mult)}${s.land_use.length ? ` · ${Math.round(s.land_use.length * 6.25).toLocaleString("en-AU")} ha repainted` : ""}`, levers: [
    { key: "rain_mult", label: "Rainfall", min: 0.3, max: 2, step: 0.05, fmt: pct },
    { key: "deep_drainage_frac", label: "On-farm deep drainage", min: 0, max: 0.3, step: 0.01, fmt: (v) => `${Math.round(v * 100)}% of applied` }] },
  { code: "EVT", name: "Evapotranspiration", summary: (s) => pct(s.et_mult), levers: [
    { key: "et_mult", label: "Reference ET₀", min: 0.8, max: 1.3, step: 0.01, fmt: pct }] },
  { code: "RIV", name: "Supply channels", summary: (s) => (s.lined_reaches.length ? `${s.lined_reaches.length} lined` : "unlined"), levers: [] },
  { code: "WEL", name: "Bores", summary: (s) => `${pct(s.pumping_mult)}${s.extra_bores.length ? ` · +${s.extra_bores.length}` : ""}`, levers: [
    { key: "pumping_mult", label: "Licensed extraction", min: 0, max: 3, step: 0.05, fmt: (v) => `${pct(v)} of metered` }] },
  { code: "NPF", name: "Hydraulic conductivity", summary: (s) => `×${s.k_mult.toFixed(2)}`, levers: [
    { key: "k_mult", label: "K multiplier", min: 0.25, max: 4, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` }] },
  { code: "STO", name: "Storage", summary: (s) => `Sy ${s.sy.toFixed(3)}`, levers: [
    { key: "sy", label: "Specific yield", min: 0.03, max: 0.2, step: 0.005, fmt: (v) => v.toFixed(3) }] },
];
const changed = (s: Scenario, keys: Lever[]) => keys.some((l) => Math.abs((s[l.key] as number) - (DEFAULTS[l.key] as number)) > 1e-9);

function Fold({ title, meta, open, onToggle, children, red }: { title: ReactNode; meta?: ReactNode; open: boolean; onToggle: () => void; children?: ReactNode; red?: boolean }) {
  return (
    <div className={`fold ${open ? "open" : ""}`}>
      <button className="fold-head" onClick={onToggle} aria-expanded={open}>
        <span className="fold-title">{title}</span>
        {meta != null && <span className={`fold-meta num ${red ? "red" : ""}`}>{meta}</span>}
        <span className="caret"><Icon name="chevron" size={12} /></span>
      </button>
      {open && children && <div className="fold-body">{children}</div>}
    </div>
  );
}

/** Fidelity: how finely MODFLOW solves the district. The data stay at 250 m; this is the numerical resolution. */
function Resolution({ scenario, setScenario }: { scenario: Scenario; setScenario: (s: Scenario) => void }) {
  const f = fidelity(scenario);
  const set = (x: Partial<Fidelity>) => { const n = { ...f, ...x }; setScenario({ ...scenario, fidelity: isNative(n) ? null : n }); };
  const [est, setEst] = useState<FidelityEstimate | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => api.fidelityEstimate(f).then(setEst).catch(() => setEst(null)), 250);
    return () => window.clearTimeout(t);
  }, [f.refine, f.sublayers, f.nstp, f.solver]); // eslint-disable-line react-hooks/exhaustive-deps
  const secs = est ? est.estimate_s * (est.baseline_cached ? 1 : 2) : null;
  const dur = (x: number) => (x < 90 ? `${Math.max(1, Math.round(x))} s` : x < 5400 ? `${Math.round(x / 60)} min` : `${(x / 3600).toFixed(1)} h`);
  return (
    <div className="res">
      <div className="res-row">
        <span className="res-l">Cell size</span>
        <div className="seg res-seg" role="radiogroup" aria-label="Cell size">
          {REFINE.map((r) => <button key={r} role="radio" aria-checked={f.refine === r} className={f.refine === r ? "on" : ""} onClick={() => set({ refine: r })}
            title={`${r}×${r} cells per 250 m cell`}>{+cellM({ ...f, refine: r }).toFixed(1)}</button>)}
        </div>
        <span className="res-u">m</span>
      </div>
      <div className="res-row">
        <span className="res-l">Layers per aquifer</span>
        <div className="seg res-seg" role="radiogroup" aria-label="Layers per aquifer">
          {[1, 2, 3, 4, 6].map((n) => <button key={n} role="radio" aria-checked={f.sublayers === n} className={f.sublayers === n ? "on" : ""} onClick={() => set({ sublayers: n })}>{n}</button>)}
        </div>
      </div>
      <div className="res-row">
        <span className="res-l">Time steps per month</span>
        <div className="seg res-seg" role="radiogroup" aria-label="Time steps per month">
          {[1, 2, 4, 8, 15, 30].map((n) => <button key={n} role="radio" aria-checked={f.nstp === n} className={f.nstp === n ? "on" : ""} onClick={() => set({ nstp: n })}
            title={n === 30 ? "About daily" : `${n} per month`}>{n}</button>)}
        </div>
      </div>
      <div className="res-row">
        <span className="res-l">Solver</span>
        <div className="seg res-seg" role="radiogroup" aria-label="Solver">
          {(["fast", "standard", "tight"] as const).map((v) => <button key={v} role="radio" aria-checked={f.solver === v} className={f.solver === v ? "on" : ""} onClick={() => set({ solver: v })}
            title={v === "fast" ? "Closes heads to 1 cm" : v === "standard" ? "Closes heads to 1 mm" : "Closes heads to 0.01 mm"}>{v}</button>)}
        </div>
      </div>
      <div className="res-est num">
        {est ? <>{est.cells.toLocaleString("en-AU")} cells · {est.time_steps} steps · about {dur(secs!)}{!est.baseline_cached && " incl. its baseline"}
          {secs! > 20 && <span className="res-bg"> · runs in the background</span>}</> : "…"}
      </div>
      <p className="res-note">The inputs stay at 250 m, two aquifers and monthly forcing; this sets how finely MODFLOW solves them.
        The model was calibrated at 250 m, and the baseline is re-solved at the same resolution for comparison.
        {!isNative(f) && <> <button className="link small" onClick={() => setScenario({ ...scenario, fidelity: null })}>Back to native</button></>}</p>
    </div>
  );
}


type Props = {
  collapsed: boolean; onCollapse: () => void; me: Me | null; onHome: () => void; width?: number | null; resizer?: ReactNode;
  userFiles: UserFiles | null; onRefreshUserFiles: () => void; onDeleteUserFile: (path: string) => void; onAddToChat: (r: ChatRef) => void;
  scenario: Scenario; setScenario: (s: Scenario) => void; nameRequest: number;
  active: string; onActivate: (name: string) => void; models: FileItem[]; scenarios: FileItem[]; runs: RunRow[];
  inspect: Record<string, Inspect | "loading" | { error: string }>; onInspect: (name: string) => void;
  onPreview: (model: string, member: string) => void; onRunUploaded: (name: string) => void; busyModel: string | null;
  onUpload: (kind: "models" | "scenarios", f: File) => void; onDelete: (kind: "models" | "scenarios", name: string) => void;
  onLoadScenario: (name: string) => void; onLoadRun: (r: RunRow) => void;
  uploading: string | null; fileUrl: (kind: "models" | "scenarios", name: string) => string;
  /** an open package's Build panel (grid, time, solver, schedules, features), in place of the scenario packages */
  buildPanel?: ReactNode;
  doc: Doc; unsaved: boolean; onSave: (asName?: string) => void; onNew: () => void; saving: boolean;
  history: Record<string, Version[] | "loading">; onHistory: (file: string) => void; onCompare: (file: string, v: number) => void; comparing: string | null;
  crops: { code: Crop; label: string; drain: number }[]; landUse: Crop[][] | null; baseLandUse: Crop[][] | null;
  reaches: Reach[]; seepage: Record<string, number> | null; hoverReach: string | null; setHoverReach: (id: string | null) => void;
};

export default function Explorer(p: Props) {
  const [tab, setTab] = useState<"models" | "scenarios" | "runs" | "files">("models");
  const [artOpen, setArtOpen] = useState<string | null>(null);
  const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;
  const view = (path: string) => `/api/volume-file?path=${encodeURIComponent(path)}`;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({ WEL: true });
  const [naming, setNaming] = useState<string | null>(null);
  const [histOpen, setHistOpen] = useState<string | null>(null);
  useEffect(() => { if (p.nameRequest) setNaming(p.doc.file ? p.doc.name : ""); }, [p.nameRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const set = (k: Lever["key"], v: number) => p.setScenario({ ...p.scenario, [k]: v });
  const save = () => (p.doc.file ? p.onSave() : setNaming(""));
  const toggleReach = (id: string) => p.setScenario({ ...p.scenario, lined_reaches: p.scenario.lined_reaches.includes(id) ? p.scenario.lined_reaches.filter((x) => x !== id) : [...p.scenario.lined_reaches, id].sort() });
  const area = (lu: Crop[][] | null) => { const n: Record<string, number> = {}; lu?.forEach((r) => r.forEach((k) => { n[k] = (n[k] ?? 0) + 6.25; })); return n; };
  const now = area(p.landUse), was = area(p.baseLandUse);
  const uploadKind = tab === "scenarios" ? "scenarios" : "models";

  if (p.collapsed) {
    return (
      <aside className="explorer rail" aria-label="Model explorer (collapsed)">
        <button className="tool icon" onClick={p.onCollapse} aria-label="Open the explorer" title="Open the explorer: models, scenarios, runs and the package settings"><Icon name="rail" /></button>
        <button className="tool icon" onClick={p.onHome} aria-label="Start page" title="Start page"><Icon name="home" /></button>
        <button className="rail-files" onClick={p.onCollapse} title="Models, scenarios and runs"><Icon name="folder" size={15} /><span className="rail-label">Files</span></button>
        <div className="rail-pk" role="group" aria-label="Packages">
          {PACKAGES.map((k) => {
            const mod = changed(p.scenario, k.levers) || (k.code === "RIV" && p.scenario.lined_reaches.length > 0)
              || (k.code === "RCH" && p.scenario.land_use.length > 0) || (k.code === "WEL" && p.scenario.extra_bores.length > 0);
            return (
              <button key={k.code} className={mod ? "red" : ""} onClick={() => { setOpen((o) => ({ ...o, [k.code]: true })); p.onCollapse(); }}
                title={`${k.name}: ${k.summary(p.scenario)}${mod ? " (changed from baseline)" : ""}`}>{k.code}</button>
            );
          })}
        </div>
        {p.unsaved && <span className="rail-unsaved" title={`${p.doc.name} has unsaved changes`}>Unsaved</span>}
      </aside>
    );
  }
  const Act = ({ href, onClick, icon, label, ext }: { href?: string; onClick?: () => void; icon: string; label: string; ext?: boolean }) =>
    href ? <a className="fb-act" href={href} aria-label={label} title={label} onClick={(e) => e.stopPropagation()} {...(ext ? { target: "_blank", rel: "noreferrer" } : {})}><Icon name={icon} size={14} /></a>
      : <button className="fb-act" onClick={(e) => { e.stopPropagation(); onClick?.(); }} aria-label={label} title={label}><Icon name={icon} size={14} /></button>;

  return (
    <aside className="explorer" aria-label="Model explorer" style={p.width ? { width: p.width } : undefined}>
      {p.resizer}
      <div className="ex-head">
        <button className="ex-name ex-home" onClick={p.onHome} title="Back to the start page: continue, start new, or open from the index"><Icon name="home" size={15} />Groundwater Studio</button>
        <button className="tool icon" onClick={p.onCollapse} aria-label="Collapse explorer"><Icon name="rail" /></button>
      </div>

      <section className={`fb ${drag ? "drop" : ""}`} aria-label="Files"
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) p.onUpload(f.name.endsWith(".json") ? "scenarios" : "models", f); }}>
        <div className="fb-tabs" role="tablist">
          {(["models", "scenarios", "runs", "files"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); if (t === "files") p.onRefreshUserFiles(); }}>
              {t === "models" ? "Models" : t === "scenarios" ? "Scenarios" : t === "runs" ? "Runs" : "Files"}
              <span className="num">{t === "models" ? p.models.length + 1 : t === "scenarios" ? p.scenarios.length : t === "runs" ? p.runs.length : (p.userFiles?.uploads.length ?? 0) + (p.userFiles?.artifacts.length ?? 0)}</span>
            </button>
          ))}
        </div>
        <div className="fb-bar">
          <span className="fb-path"><Icon name="folder" size={13} />{tab === "runs" ? "model_runs" : tab === "files" ? "workspace/uploads" : `workspace/${tab}`}
            {(() => { const u = tab === "runs" ? tableUrl(p.me, "model_runs") : tab === "files" ? (p.userFiles ? volumeUrl(p.me, p.userFiles.uploads_path, true) : undefined) : volumeUrl(p.me, workspacePath(p.me, tab), true);
              return u ? <a className="fb-ext" href={u} target="_blank" rel="noreferrer" title={tab === "runs" ? "Open the model_runs table in Catalog Explorer" : `Open workspace/${tab} in Catalog Explorer`} aria-label="Open in the workspace"><Icon name="ext" size={12} /></a> : null; })()}</span>
          <span className="fb-bar-acts">
            {tab === "scenarios" && <button className="btn small" onClick={p.onNew}><Icon name="plus" size={13} />New</button>}
            {tab !== "runs" && tab !== "files" && (
              <button className="btn small" onClick={() => input.current?.click()} disabled={!!p.uploading}>
                <Icon name="up" size={13} />{p.uploading ? "Uploading" : "Upload"}
              </button>
            )}
          </span>
          <input ref={input} type="file" accept={uploadKind === "models" ? ".zip" : ".json"} hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onUpload(uploadKind, f); e.target.value = ""; }} />
        </div>

        <ul className="fb-list" role="list">
          {tab === "models" && (
            <>
              <li className={`fb-row ${p.active === "district" ? "on" : ""}`} onClick={() => p.onActivate("district")}>
                <Icon name="cube" size={14} /><span className="fb-name">Sample district model</span><span className="fb-size num">40×60×2</span>
                <span className="fb-acts" /><span className="fb-chev" />
              </li>
              {p.models.map((f) => {
                const info = p.inspect[f.name], isOpen = expanded === f.name;
                return (
                  <li key={f.name} className={`fb-item ${p.active === f.name ? "on" : ""}`}>
                    <div className="fb-row" onClick={() => { setExpanded(isOpen ? null : f.name); if (!info) p.onInspect(f.name); }}>
                      <Icon name="file" size={14} /><span className="fb-name" title={f.name}>{f.name.replace(/\.zip$/, "")}</span>
                      <span className="fb-size num">{kb(f.bytes)}</span>
                      <span className="fb-acts">
                        <Act onClick={() => p.onAddToChat({ name: f.name, kind: "model", path: workspacePath(p.me, `models/${f.name}`), hint: `MODFLOW 6 package ${f.name} (list_models, inspect_model, run_model)` })} icon="chat" label={`Add ${f.name} to the current chat`} />
                        <Act href={p.fileUrl("models", f.name)} icon="down" label={`Download ${f.name}`} />
                        <Act href={volumeUrl(p.me, workspacePath(p.me, `models/${f.name}`))} ext icon="ext" label={`Open ${f.name} in the workspace`} />
                        <Act onClick={() => { if (confirm(`Delete ${f.name} from the workspace volume?`)) p.onDelete("models", f.name); }} icon="x" label={`Delete ${f.name}`} />
                      </span>
                      <span className={`fb-chev ${isOpen ? "open" : ""}`}><Icon name="chevron" size={12} /></span>
                    </div>
                    {isOpen && (
                      <div className="fb-detail">
                        {info === "loading" && <div className="muted">Reading package…</div>}
                        {info && typeof info === "object" && "error" in info && <div className="red">{info.error}</div>}
                        {info && typeof info === "object" && "files" in info && (
                          <>
                            <div className="fb-meta num">{info.grid.nlay ? `${info.grid.nlay}×${info.grid.nrow}×${info.grid.ncol} · ` : ""}{info.nper} periods · {info.packages.map((q) => q.type).join(" ")}</div>
                            <button className="btn ink small" onClick={() => p.onRunUploaded(f.name)} disabled={p.busyModel === f.name}>{p.busyModel === f.name ? "Running" : "Run as-is"}</button>
                            <ul className="fb-files">
                              {info.files.map((x) => (
                                <li key={x.path}>
                                  {x.text ? <button className="link" onClick={() => p.onPreview(f.name, x.path)}>{x.name}</button> : <span className="muted">{x.name}</span>}
                                  <span className="num muted">{kb(x.bytes)}</span>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </>
          )}
          {tab === "scenarios" && (
            <>
              {p.scenarios.map((f) => {
                const open = histOpen === f.name, h = p.history[f.name];
                return (
                  <li key={f.name} className={`fb-item ${p.doc.file === f.name ? "on" : ""}`}>
                    <div className="fb-row" onClick={() => p.onLoadScenario(f.name)} title="Open">
                      <Icon name="file" size={14} /><span className="fb-name">{f.name.replace(/\.json$/, "").replace(/-/g, " ")}</span>
                      <span className="fb-size num">{day(f.modified)}</span>
                      <span className="fb-acts">
                        <Act onClick={() => p.onAddToChat({ name: f.name, kind: "scenario", path: workspacePath(p.me, `scenarios/${f.name}`), hint: `saved scenario ${f.name} (get_scenario; base a run on it with "base": "${f.name.replace(/\.json$/, "")}")` })} icon="chat" label={`Add ${f.name} to the current chat`} />
                        <Act href={p.fileUrl("scenarios", f.name)} icon="down" label={`Download ${f.name}`} />
                        <Act href={volumeUrl(p.me, workspacePath(p.me, `scenarios/${f.name}`))} ext icon="ext" label={`Open ${f.name} in the workspace`} />
                        <Act onClick={() => { if (confirm(`Delete scenario ${f.name}? Its version history stays in Unity Catalog.`)) p.onDelete("scenarios", f.name); }} icon="x" label={`Delete ${f.name}`} />
                      </span>
                      <button className={`fb-chev ${open ? "open" : ""}`} aria-label={`${open ? "Hide" : "Show"} history of ${f.name}`} aria-expanded={open}
                        onClick={(e) => { e.stopPropagation(); setHistOpen(open ? null : f.name); if (!open) p.onHistory(f.name); }}><Icon name="chevron" size={12} /></button>
                    </div>
                    {open && (
                      <ol className="fb-hist" aria-label={`History of ${f.name}`}>
                        {h === "loading" && <li className="muted">Reading history…</li>}
                        {Array.isArray(h) && !h.length && <li className="muted">No saved versions</li>}
                        {Array.isArray(h) && h.map((v) => (
                          <li key={v.version}>
                            <button className={p.comparing === `${f.name}@${v.version}` ? "on" : ""} onClick={() => p.onCompare(f.name, v.version)}>
                              <span className="h-v num">v{v.version}</span><span className="h-msg">{v.summary}</span>
                              <span className="h-by">{v.saved_by.split("@")[0]} · {ago(v.saved_at)}</span>
                            </button>
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                );
              })}
              {!p.scenarios.length && <li className="fb-empty">No saved scenarios</li>}
            </>
          )}
          {tab === "files" && (
            <>
              <li className="fb-sec">Your uploads</li>
              {p.userFiles?.uploads.map((f) => (
                <li key={f.path} className="fb-row" onClick={() => window.open(view(f.path), "_blank")} title={`Open ${f.name}`}>
                  {IMG.test(f.name) ? <img className="fb-thumb" src={view(f.path)} alt="" loading="lazy" /> : <Icon name="clip" size={14} />}
                  <span className="fb-name" title={f.name}>{f.name}</span><span className="fb-size num">{kb(f.bytes)}</span>
                  <span className="fb-acts">
                    <Act onClick={() => p.onAddToChat({ name: f.name, kind: IMG.test(f.name) ? "image" : "file", path: f.path, hint: `uploaded file ${f.name} (read_upload, view_image, or {"upload": "${f.name}"} in run_python)` })} icon="chat" label={`Add ${f.name} to the current chat`} />
                    <Act href={volumeUrl(p.me, f.path)} ext icon="ext" label={`Open ${f.name} in the workspace`} />
                    <Act onClick={() => { if (confirm(`Delete ${f.name}?`)) p.onDeleteUserFile(f.path); }} icon="x" label={`Delete ${f.name}`} />
                  </span><span className="fb-chev" />
                </li>
              ))}
              {p.userFiles && !p.userFiles.uploads.length && <li className="fb-empty">Drop files on the agent to give them to it; they land here.</li>}
              <li className="fb-sec">Made by the agent</li>
              {p.userFiles?.artifacts.map((a) => {
                const open = artOpen === a.path, label = a.folder.replace(/^\d{8}-\d{6}-/, "").replace(/-+/g, " ");
                return (
                  <li key={a.path} className="fb-item">
                    <div className="fb-row" onClick={() => setArtOpen(open ? null : a.path)}>
                      <Icon name="folder" size={14} /><span className="fb-name" title={a.folder}>{label}</span>
                      <span className="fb-size num" title={a.folder}>{a.folder.slice(6, 8)}/{a.folder.slice(4, 6)} {a.folder.slice(9, 11)}:{a.folder.slice(11, 13)}</span>
                      <span className="fb-acts">
                        <Act href={volumeUrl(p.me, a.path, true)} ext icon="ext" label="Open this folder in the workspace" />
                        <Act onClick={() => { if (confirm(`Delete ${label} and its ${a.files.length} files?`)) p.onDeleteUserFile(a.path); }} icon="x" label="Delete this folder" />
                      </span>
                      <span className={`fb-chev ${open ? "open" : ""}`}><Icon name="chevron" size={12} /></span>
                    </div>
                    {open && (
                      <ul className="fb-sub">
                        {a.files.map((f) => (
                          <li key={f.path} className="fb-row" onClick={() => window.open(view(f.path), "_blank")} title={`Open ${f.name}`}>
                            {IMG.test(f.name) ? <img className="fb-thumb" src={view(f.path)} alt="" loading="lazy" /> : <Icon name={/\.pdf$/i.test(f.name) ? "note" : "file"} size={14} />}
                            <span className="fb-name" title={f.name}>{f.name}</span><span className="fb-size num">{kb(f.bytes)}</span>
                            <span className="fb-acts">
                              <Act onClick={() => p.onAddToChat({ name: f.name, kind: IMG.test(f.name) ? "image" : "file", path: f.path, hint: `your earlier output ${f.name} at ${f.path} (view_image for images)` })} icon="chat" label={`Add ${f.name} to the current chat`} />
                              <Act href={`${view(f.path)}&download=true`} icon="down" label={`Download ${f.name}`} />
                            </span><span className="fb-chev" />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
              {p.userFiles && !p.userFiles.artifacts.length && <li className="fb-empty">Figures, reports and data the agent makes appear here.</li>}
            </>
          )}
          {tab === "runs" && p.runs.slice(0, 20).map((r) => (
            <li key={r.run_id} className="fb-row" onClick={() => p.onLoadRun(r)} title={`${r.run_by} · ${r.created_at}`}>
              <Icon name="file" size={14} /><span className="fb-name">{r.label || r.run_id}</span>
              <span className="fb-size num">{r.created_at.slice(5, 10).replace("-", "/")}</span>
              <span className="fb-acts"><Act onClick={() => p.onAddToChat({ name: r.label || r.run_id, kind: "run", hint: `filed run ${r.run_id} "${r.label || ""}" (get_run, get_run_series, or {"run": "${r.run_id}"} in run_python)` })} icon="chat" label="Add this run to the current chat" />
                {r.archive_path && <Act href={`/api/runs/${r.run_id}/archive`} icon="down" label="Download model files" />}
                {r.mlflow_run_id && p.me && <Act href={`${p.me.host}/ml/experiments/${p.me.experiment_id}/runs/${r.mlflow_run_id}`} ext icon="ext" label="Open this run in MLflow" />}</span><span className="fb-chev" />
            </li>
          ))}
        </ul>
      </section>

      <div className="ex-scroll">
        {p.active === "district" && (
          <div className="doc">
            {naming !== null ? (
              <form className="doc-naming" onSubmit={(e) => { e.preventDefault(); if (naming.trim()) { p.onSave(naming.trim()); setNaming(null); } }}>
                <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Name this scenario" aria-label="Scenario name"
                  onKeyDown={(e) => e.key === "Escape" && setNaming(null)} />
                <button className="btn small ink" disabled={!naming.trim()}>Save</button>
                <button type="button" className="btn small" onClick={() => setNaming(null)}>Cancel</button>
              </form>
            ) : (
              <>
                <div className="doc-l">
                  <div className="doc-name">{p.doc.name}</div>
                  <div className="doc-meta">
                    {p.unsaved ? <span className="doc-state">Unsaved changes</span> : p.doc.version ? <>v{p.doc.version} · saved {ago(p.doc.savedAt)}</> : "Not saved"}
                    {p.doc.file && <> · <button className="link" onClick={() => setNaming(p.doc.name)}>Save as</button></>}
                  </div>
                </div>
                <button className={`btn small ${p.unsaved ? "ink" : ""}`} onClick={save} disabled={p.saving || (!p.unsaved && !!p.doc.file)} title="Save (⌘S)">
                  {p.saving ? "Saving" : "Save"}
                </button>
              </>
            )}
          </div>
        )}
        {p.active === "district" && (
          <Fold title={<><span className="code">DIS</span>Resolution and solver</>} meta={fidelityText(fidelity(p.scenario))}
            red={!isNative(fidelity(p.scenario))} open={!!open.DIS} onToggle={() => setOpen((o) => ({ ...o, DIS: !o.DIS }))}>
            <Resolution scenario={p.scenario} setScenario={p.setScenario} />
          </Fold>
        )}
        {p.active === "district" ? PACKAGES.map((pk) => (
          <Fold key={pk.code} title={<><span className="code">{pk.code}</span>{pk.name}</>} meta={pk.summary(p.scenario)}
            red={changed(p.scenario, pk.levers) || (pk.code === "WEL" && p.scenario.extra_bores.length > 0) || (pk.code === "RIV" && p.scenario.lined_reaches.length > 0) || (pk.code === "RCH" && p.scenario.land_use.length > 0)}
            open={!!open[pk.code]} onToggle={() => setOpen((o) => ({ ...o, [pk.code]: !o[pk.code] }))}>
            {pk.levers.map((l) => {
              const v = p.scenario[l.key] as number, dirty = Math.abs(v - (DEFAULTS[l.key] as number)) > 1e-9;
              return (
                <label key={l.key} className="scale">
                  <span className="scale-lab"><span>{l.label}</span><b className={`num ${dirty ? "red" : ""}`}>{l.fmt(v)}</b></span>
                  <input type="range" min={l.min} max={l.max} step={l.step} value={v} onChange={(e) => set(l.key, +e.target.value)} />
                  {dirty && <button type="button" className="link small" onClick={() => set(l.key, DEFAULTS[l.key] as number)}>Reset to {l.fmt(DEFAULTS[l.key] as number)}</button>}
                </label>
              );
            })}
            {pk.code === "RCH" && (
              <table className="lu-t"><thead><tr><th>Land use</th><th className="n">Drains</th><th className="n">Area, ha</th></tr></thead>
                <tbody>{CROP_ORDER.map((k) => {
                  const d = (now[k] ?? 0) - (was[k] ?? 0), c = p.crops.find((x) => x.code === k);
                  return (
                    <tr key={k}><td><i className="sw-c" style={{ background: CROP_COLORS[k] }} />{c?.label ?? k}</td>
                      <td className="n muted">{c && c.drain ? `${Math.round(c.drain * p.scenario.deep_drainage_frac * 100)}%` : "–"}</td>
                      <td className="n">{Math.round(now[k] ?? 0).toLocaleString("en-AU")}{d !== 0 && <span className="red"> {d > 0 ? "+" : "−"}{Math.round(Math.abs(d)).toLocaleString("en-AU")}</span>}</td></tr>
                  );
                })}</tbody></table>
            )}
            {pk.code === "RIV" && (
              <table className="lu-t reaches"><thead><tr><th>Reach</th><th>Lined</th><th className="n">Seepage, GL/yr</th></tr></thead>
                <tbody>{p.reaches.map((r) => {
                  const on = p.scenario.lined_reaches.includes(r.id), q = p.seepage?.[r.id];
                  return (
                    <tr key={r.id} className={p.hoverReach === r.id ? "hot" : ""} onMouseEnter={() => p.setHoverReach(r.id)} onMouseLeave={() => p.setHoverReach(null)}>
                      <td><span className="num">{r.id}</span> <span className="muted">{r.channel.replace(" Canal", "")} · {r.length_km} km</span></td>
                      <td><input type="checkbox" checked={on} onChange={() => toggleReach(r.id)} aria-label={`Line ${r.id}`} /></td>
                      <td className="n num">{q == null ? "–" : (q / 2000).toFixed(2)}</td>
                    </tr>
                  );
                })}</tbody></table>
            )}
            {pk.code === "WEL" && p.scenario.extra_bores.length > 0 && (
              <div className="proposed">
                <div className="scale-lab"><span>Proposed bores</span></div>
                {p.scenario.extra_bores.map((b, i) => (
                  <div key={i} className="prop-row">
                    <span className="red">P{i + 1}</span><span className="num muted">r{b.row + 1} c{b.col + 1}</span>
                    <input type="number" min={0} step={50} value={b.ML_per_year} aria-label={`P${i + 1} ML per year`}
                      onChange={(e) => p.setScenario({ ...p.scenario, extra_bores: p.scenario.extra_bores.map((x, j) => (j === i ? { ...x, ML_per_year: +e.target.value } : x)) })} />
                    <span className="muted">ML/yr</span>
                    <button className="link" aria-label={`Remove P${i + 1}`} onClick={() => p.setScenario({ ...p.scenario, extra_bores: p.scenario.extra_bores.filter((_, j) => j !== i) })}><Icon name="x" size={12} /></button>
                  </div>
                ))}
              </div>
            )}
          </Fold>
        )) : p.buildPanel ?? <div className="ex-note">This package is kept as uploaded and runs unchanged.</div>}
        {p.active === "district" && (
          <Fold title={<><span className="code">DRN</span>Interceptor drains</>} meta={p.scenario.drain_lines?.length ? `${p.scenario.drain_lines.length} proposed` : "none"}
            red={!!p.scenario.drain_lines?.length} open={!!open.DRN} onToggle={() => setOpen((o) => ({ ...o, DRN: !o.DRN }))}>
            {p.scenario.drain_lines?.length ? (
              <div className="proposed">
                {p.scenario.drain_lines.map((d, i) => (
                  <div key={d.name} className="prop-row">
                    <span className="red">{d.name}</span><span className="num muted">{(d.cells.length * 0.25).toFixed(2)} km</span>
                    <select value={d.depth_m} aria-label={`${d.name} invert depth`}
                      onChange={(e) => p.setScenario({ ...p.scenario, drain_lines: p.scenario.drain_lines!.map((x, j) => (j === i ? { ...x, depth_m: +e.target.value } : x)) })}>
                      {[1, 1.5, 2, 2.5, 3, 4].map((v) => <option key={v} value={v}>{v} m deep</option>)}
                    </select>
                    <button className="link" aria-label={`Remove ${d.name}`} onClick={() => p.setScenario({ ...p.scenario, drain_lines: p.scenario.drain_lines!.filter((_, j) => j !== i) })}><Icon name="x" size={12} /></button>
                  </div>
                ))}
              </div>
            ) : <div className="ex-note">None proposed. Draw one with the Drains tool (R): a line of sub-surface drain that holds the water table near its invert.</div>}
          </Fold>
        )}
      </div>
    </aside>
  );
}
