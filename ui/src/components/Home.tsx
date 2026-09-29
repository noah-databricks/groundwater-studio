import { useEffect, useRef, useState } from "react";
import { api, source, type AgentSessionRow, type RunRow, type StudyRow } from "../api";
import { rev } from "../lib/rev";
import type { FileItem, Me } from "../types";
import { Icon } from "./Icon";

/** What the modeller had open last, so the cover sheet can offer to carry on with it. */
export type Last = { kind: "scenario" | "run" | "model" | "baseline"; key: string; label: string; at: number };
const LAST_KEY = "gs.last";
export const saveLast = (l: Omit<Last, "at">) => { try { localStorage.setItem(LAST_KEY, JSON.stringify({ ...l, at: Date.now() })); } catch { /* private window */ } };
export const readLast = (): Last | null => { try { return JSON.parse(localStorage.getItem(LAST_KEY) ?? "null"); } catch { return null; } };

const when = (ms: number | null | undefined) => {
  if (!ms) return "";
  const m = (Date.now() - ms) / 60000;
  return m < 1 ? "just now" : m < 60 ? `${Math.round(m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago`
    : new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
};
const iso = (s: string) => new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime();
const KIND: Record<Last["kind"], string> = { scenario: "Scenario", run: "Filed run", model: "MODFLOW 6 package", baseline: "Sample district model" };

/** The cover sheet: carry on, start something, or open anything in the project's index. */
export default function Home({ me, runs, scenarios, models, onBaseline, onScenario, onRun, onModel, onUpload, onStudy, onNewStudy, onAgent, onThread, onNewModel }: {
  me: Me | null; runs: RunRow[]; scenarios: FileItem[]; models: FileItem[];
  onBaseline: () => void; onScenario: (name: string) => void; onRun: (r: RunRow) => void; onModel: (name: string) => void;
  onUpload: (f: File) => void; onStudy: (id: string) => void; onNewStudy: () => void; onAgent: (text: string) => void; onThread: (id: string) => void;
  onNewModel: (spec: { name: string; nrow: number; ncol: number; cell_m: number; nlay: number; top: number; bottom: number; k: number; transient: boolean }) => Promise<void>;
}) {
  const [nm, setNm] = useState<null | { name: string; km_x: number; km_y: number; cell_m: number; nlay: number; top: number; bottom: number; k: number; transient: boolean }>(null);
  const [making, setMaking] = useState(false);
  const [studies, setStudies] = useState<StudyRow[] | null>(null), [threads, setThreads] = useState<AgentSessionRow[] | null>(null);
  const last = readLast(), file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api.studies().then(setStudies).catch(() => setStudies([]));
    api.agentSessions().then(setThreads).catch(() => setThreads([]));
  }, []);
  const lastRun = last?.kind === "run" ? runs.find((r) => r.run_id === last.key) : undefined;
  const resume = () => {
    if (!last) return;
    if (last.kind === "scenario") onScenario(last.key);
    else if (last.kind === "run" && lastRun) onRun(lastRun);
    else if (last.kind === "model") onModel(last.key);
    else onBaseline();
  };
  const canResume = last && (last.kind !== "run" || lastRun) && (last.kind !== "scenario" || scenarios.some((s) => s.name === last.key))
    && (last.kind !== "model" || models.some((m) => m.name === last.key));
  const who = me?.email.split("@")[0].replace(".", " ");

  return (
    <div className="home">
      <header className="home-head">
        <div>
          <h1>Groundwater Studio</h1>
          <p>MODFLOW 6 on Unity Catalog, run as you{who ? `, ${who}` : ""}. Pick up where you left off, start something new, or open anything from the index.</p>
        </div>
      </header>

      <div className="home-cols">
        <section className="home-start" aria-label="Start">
          {canResume && last && (
            <button className="home-resume" onClick={resume}>
              <span className="home-resume-l">Continue</span>
              <span className="home-resume-t">{last.label}</span>
              <span className="home-resume-m">{KIND[last.kind]} · {when(last.at)}</span>
              <span className="home-go"><Icon name="chevron" size={14} /></span>
            </button>
          )}
          <h2>Start</h2>
          <ul className="home-acts">
            <li><button onClick={onBaseline}><Icon name="cube" size={18} /><span><b>Explore the sample district model</b><span>The calibrated baseline: 40 × 60 cells of 250 m, two aquifers, 24 months. Edit it as a new scenario.</span></span></button></li>
            <li><button onClick={() => file.current?.click()}><Icon name="up" size={18} /><span><b>Open a MODFLOW 6 model</b><span>Upload a zipped package (mfsim.nam and its files). It is solved as-is and drawn in 3D.</span></span></button>
              <input ref={file} type="file" accept=".zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} /></li>
            <li><button onClick={() => setNm((x) => (x ? null : { name: "", km_x: 5, km_y: 4, cell_m: 100, nlay: 2, top: 100, bottom: 40, k: 10, transient: false }))} aria-expanded={!!nm}>
              <Icon name="plan" size={18} /><span><b>Start a blank model</b><span>Set the extent, cell size and layers, then build it with the Build palette: properties, heads, wells, rivers, drains, recharge.</span></span></button>
              {nm && (
                <form className="home-new" onSubmit={async (e) => {
                  e.preventDefault(); if (!nm.name.trim()) return; setMaking(true);
                  const cell = Math.max(1, nm.cell_m);
                  try { await onNewModel({ name: nm.name.trim(), nrow: Math.max(2, Math.round((nm.km_y * 1000) / cell)), ncol: Math.max(2, Math.round((nm.km_x * 1000) / cell)), cell_m: cell,
                    nlay: nm.nlay, top: nm.top, bottom: nm.bottom, k: nm.k, transient: nm.transient }); } finally { setMaking(false); }
                }}>
                  <label className="span2">Name <input value={nm.name} onChange={(e) => setNm({ ...nm, name: e.target.value })} placeholder="e.g. valley-test" autoFocus /></label>
                  <label>East–west, km <input type="number" min={0.1} step={0.5} value={nm.km_x} onChange={(e) => setNm({ ...nm, km_x: +e.target.value })} /></label>
                  <label>North–south, km <input type="number" min={0.1} step={0.5} value={nm.km_y} onChange={(e) => setNm({ ...nm, km_y: +e.target.value })} /></label>
                  <label>Cell size, m <input type="number" min={1} step={10} value={nm.cell_m} onChange={(e) => setNm({ ...nm, cell_m: +e.target.value })} /></label>
                  <label>Layers <input type="number" min={1} max={20} value={nm.nlay} onChange={(e) => setNm({ ...nm, nlay: +e.target.value })} /></label>
                  <label>Top, m <input type="number" step={1} value={nm.top} onChange={(e) => setNm({ ...nm, top: +e.target.value })} /></label>
                  <label>Bottom, m <input type="number" step={1} value={nm.bottom} onChange={(e) => setNm({ ...nm, bottom: +e.target.value })} /></label>
                  <label>K, m/d <input type="number" min={0.0001} step={1} value={nm.k} onChange={(e) => setNm({ ...nm, k: +e.target.value })} /></label>
                  <label className="home-chk"><input type="checkbox" checked={nm.transient} onChange={(e) => setNm({ ...nm, transient: e.target.checked })} />Through time (12 months)</label>
                  <p className="span2 home-new-n">{Math.max(2, Math.round((nm.km_y * 1000) / Math.max(1, nm.cell_m)))} × {Math.max(2, Math.round((nm.km_x * 1000) / Math.max(1, nm.cell_m)))} cells × {nm.nlay} layers. Starts with a fixed head on the west edge and 50 mm/yr of recharge, so it solves; change or remove them.</p>
                  <button className="btn ink span2" disabled={making || !nm.name.trim() || nm.bottom >= nm.top}>{making ? "Creating…" : "Create and open"}</button>
                </form>
              )}</li>
            <li><button onClick={() => onAgent("Build a new MODFLOW 6 model: ")}><Icon name="agent" size={18} /><span><b>Build a model with the agent</b><span>Describe the aquifer, boundaries and stresses; the agent builds, solves and shows it.</span></span></button></li>
            <li><button onClick={onNewStudy}><Icon name="study" size={18} /><span><b>Open a study</b><span>A research question with the runs that test it and the findings they support.</span></span></button></li>
          </ul>
        </section>

        <section className="home-index" aria-label="Index">
          <h2>Index</h2>
          <div className="home-grid">
            <Block title="Saved scenarios" empty="None yet: save one from the explorer (⌘S)." items={scenarios.slice(0, 6).map((f) => ({
              key: f.name, label: f.name.replace(/\.json$/, "").replace(/-/g, " "), meta: when(f.modified), onOpen: () => onScenario(f.name) }))} />
            <Block title="Recent runs" empty="Nothing filed yet." items={runs.slice(0, 6).map((r, i) => ({
              key: r.run_id, label: r.label || r.run_id, meta: `Rev ${rev(runs.length - 1 - i)} · ${source(r.origin).label} · ${when(iso(r.created_at))}`, onOpen: () => onRun(r) }))} />
            <Block title="Studies" empty="No studies yet." items={(studies ?? []).slice(0, 5).map((s) => ({
              key: s.study_id, label: s.title, meta: `${s.status} · ${s.n_runs} run${s.n_runs === 1 ? "" : "s"} · ${s.n_findings} finding${s.n_findings === 1 ? "" : "s"}`, onOpen: () => onStudy(s.study_id) }))}
              loading={studies === null} />
            <Block title="Models" empty="Only the sample district model so far." items={models.slice(0, 5).map((m) => ({
              key: m.name, label: m.name.replace(/\.zip$/, ""), meta: `MODFLOW 6 package · ${when(m.modified)}`, onOpen: () => onModel(m.name) }))} />
            <Block title="Agent threads" empty="No threads yet." items={(threads ?? []).slice(0, 5).map((t) => ({
              key: t.id, label: t.title, meta: `${t.status === "running" ? "working · " : t.waiting ? "waiting · " : ""}${when((t.updated_at ?? t.created_at) * 1000)}`, onOpen: () => onThread(t.id) }))}
              loading={threads === null} />
          </div>
        </section>
      </div>
    </div>
  );
}

function Block({ title, items, empty, loading }: { title: string; items: { key: string; label: string; meta: string; onOpen: () => void }[]; empty: string; loading?: boolean }) {
  return (
    <div className="home-block">
      <h3>{title}</h3>
      <ul>
        {items.map((it) => (
          <li key={it.key}><button onClick={it.onOpen} title={it.label}><span className="home-i-t">{it.label}</span><span className="home-i-m">{it.meta}</span></button></li>
        ))}
        {!items.length && <li className="home-empty">{loading ? "…" : empty}</li>}
      </ul>
    </div>
  );
}
