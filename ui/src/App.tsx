import { rev } from "./lib/rev";
import { volumeUrl } from "./lib/ws";
import { usePanelWidth } from "./lib/resize";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, source, type RunRow } from "./api";
import BlockModel, { ZONE_INK, type CameraCmd, type Readout, type ViewMode } from "./components/BlockModel";
import { CellPanel, ZonePanel, type Loadable } from "./components/Probe";
import BuildTools, { BTOOL_KEYS, type BOpts, type BTool } from "./components/BuildTools";
import BuildPanel, { BuildCell, BuildChanges } from "./components/BuildPanel";
import Calibration from "./components/Calibration";
import { addGhb, addHeads, addLine, addWell, at, buildScene, periodLabels, open as openBuild, paintProp, PROPS, propRange, removeFeature, toDoc, withDoc, type Build } from "./lib/build";
import { EARTH_STOPS, REDLINE, rampCss } from "./theme";
import CueStrip from "./components/CueStrip";
import Changes, { type Compare } from "./components/Changes";
import Explorer, { DEFAULTS } from "./components/Explorer";
import Agent, { type Activity } from "./components/Agent";
import Home, { saveLast } from "./components/Home";
import Tools, { TOOL_KEYS } from "./components/Tools";
import { canonical, emptyDiff, fidelity, fidelityText, inPolygon, isNative, landUseFor, paint, same, sceneDiff, trace } from "./lib/scenario";
import Hydrograph from "./components/Hydrograph";
import { Icon } from "./components/Icon";
import Legend from "./components/Legend";
import Section from "./components/Section";
import TitleBlock, { type Figure } from "./components/TitleBlock";
import NotesSheet from "./sheets/NotesSheet";
import RegisterSheet from "./sheets/RegisterSheet";
import StudiesSheet, { ALL_ENSEMBLES, ALL_RUNS } from "./sheets/StudiesSheet";
import EnsemblesTable from "./sheets/EnsemblesTable";
import { EnsemblePanel, FitScatter, MonthlyBand, type Vary } from "./components/Ensemble";
import type { EnsembleDetail } from "./api";
import type { CellProbe, ChatRef, Crop, Doc, FileItem, Task, UserFiles, Inspect, Me, ModelInfo, PersistStatus, RunResult, Scenario, SceneModel, Tool, UploadedRun, Version, Zone, ZoneShape, ZoneStats } from "./types";
import type { SavedScenario } from "./api";

// two places to work (the model, and the record of what was run and why) plus the reference notes; uncertainty is a
// way of running the model (an ensemble), shown on the model and filed in the record, not a place of its own
const SHEETS = ["Model", "Record"] as const;
const SHEET_ICONS = ["cube", "list"];
const RECORD = 1;
// agent tools whose result belongs on the model: following them leaves the start page
const MODEL_TOOLS = new Set(["render_map", "find_cells", "run_scenario", "run_batch", "run_model", "describe_model", "preview_scenario", "start_ensemble", "get_ensemble",
  "inspect_cell", "zone_budget", "get_section", "save_zone", "edit_model", "get_model_build"]);
const ABOUT = 2;
const KEYS: [string[], string][] = [
  [["W", "A", "S", "D"], "Pan (or the arrow keys)"], [["Q", "E"], "Turn"], [["+", "−"], "Zoom"], [["0"], "Reset the view"],
  [["P"], "Plan or axonometric"], [[",", "."], "Previous or next month"], [["V", "L", "C", "B"], "Select and inspect, land use, channels, bores"],
  [["R", "Z", "X"], "Drains, zones, section line"], [["↵", "⌫", "Esc"], "Finish, undo a point, cancel a drawing"], [["[", "]"], "Brush size"], [["⌘Z", "⇧⌘Z"], "Undo, redo"], [["⌘S"], "Save the scenario"], [["⌘↵"], "Run and file"], [["?"], "This list"],
];
const RIGHT_MAX = 452; // overlay column width on the model sheet, narrower when the agent shares the screen
const fmt = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "–" : v.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d }));
const delta = (a: number | null | undefined, b: number | null | undefined, d: number, unit: string, scale = 1) => {
  if (a == null || b == null) return null;
  const x = (a - b) * scale;
  return Math.abs(x) < Math.pow(10, -d) / 2 ? "±0" : `${x > 0 ? "+" : "−"}${fmt(Math.abs(x), d)}${unit}`;
};
const monthLabel = (l: string) => (/^\d{4}-\d{2}$/.test(l) ? new Date(`${l}-15`).toLocaleDateString("en-AU", { month: "short", year: "numeric" }) : l);

function describe(s: Scenario) {
  const parts: string[] = [];
  if (s.rain_mult !== 1) parts.push(`rain ${Math.round(s.rain_mult * 100)}%`);
  if (s.et_mult !== 1) parts.push(`ET ${Math.round(s.et_mult * 100)}%`);
  if (s.deep_drainage_frac !== 0.12) parts.push(`deep drainage ${Math.round(s.deep_drainage_frac * 100)}%`);
  if (s.pumping_mult !== 1) parts.push(`extraction ${Math.round(s.pumping_mult * 100)}%`);
  if (s.canal_lining_pct) parts.push(`${s.canal_lining_pct}% of channels lined`);
  if (s.lined_reaches.length) parts.push(`${s.lined_reaches.join(", ")} lined`);
  if (s.land_use.length) parts.push(`${Math.round(s.land_use.length * 6.25).toLocaleString("en-AU")} ha repainted`);
  if (s.k_mult !== 1) parts.push(`K ×${s.k_mult.toFixed(2)}`);
  if (s.sy !== 0.08) parts.push(`Sy ${s.sy.toFixed(3)}`);
  if (s.extra_bores.length) parts.push(`${s.extra_bores.length} proposed bore${s.extra_bores.length > 1 ? "s" : ""}`);
  if (s.drain_lines?.length) parts.push(`${s.drain_lines.length} interceptor drain${s.drain_lines.length > 1 ? "s" : ""}`);
  const fx = isNative(fidelity(s)) ? "" : ` (${fidelityText(fidelity(s))})`;
  return (parts.length ? parts.join(", ") : "Baseline") + fx;
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [s, set] = useState({ w: 800, h: 600 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => set({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current); return () => ro.disconnect();
  }, [ref]);
  return s;
}

export default function App() {
  const [sheet, setSheet] = useState(() => (new URLSearchParams(window.location.search).get("study") ? RECORD : 0));
  const [study, setStudy] = useState<string | null>(() => new URLSearchParams(window.location.search).get("study"));
  const [keysOpen, setKeysOpen] = useState(false);
  // the cover sheet: nothing is solved until the modeller picks what to work on (deep links skip it)
  const startHome = useRef(!new URLSearchParams(window.location.search).get("run") && !new URLSearchParams(window.location.search).get("study"));
  const [home, setHome] = useState(startHome.current);
  const [prefill, setPrefill] = useState<{ n: number; text: string } | null>(null);
  const [openThread, setOpenThread] = useState<{ n: number; id: string } | null>(null);
  const [draftRequest, setDraftRequest] = useState(0);
  // the user's own files (uploads and what the agent made), and things handed to the agent from the explorer
  const [userFiles, setUserFiles] = useState<UserFiles | null>(null);
  const refreshUserFiles = useCallback(() => { api.userFiles().then(setUserFiles).catch(() => {}); }, []);
  const [inbox, setInbox] = useState<{ n: number; ref: ChatRef } | null>(null);
  // what the agent is looking at, drawn on the model while the user follows it
  const [agentView, setAgentView] = useState<{ overlay: "land" | "reaches" | null; cells: { row: number; col: number }[] | null; label: string } | null>(null);
  const [agentHidden, setAgentHidden] = useState(() => { try { return localStorage.getItem("gs.agent") === "hidden" || window.innerWidth < 1100; } catch { return false; } });
  const [follow, setFollow] = useState(true);
  // both side panels: dragged from their inner edge, remembered per browser, double-click to reset
  const [dragging, setDragging] = useState(false);
  const agentPanel = usePanelWidth("gs.agent.w", "left", 340, 0.62, setDragging);
  const explorerPanel = usePanelWidth("gs.explorer.w", "right", 240, 0.4, setDragging);
  // the detail inset (section, hydrograph, budget, changes, ensemble): wider from its left edge, taller from its bottom
  const insetPanel = usePanelWidth("gs.inset.w", "left", 340, 0.62, setDragging);
  const [insetExtra, setInsetExtra] = useState(() => { try { return Math.max(0, Number(localStorage.getItem("gs.inset.h")) || 0); } catch { return 0; } });
  const insetDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY, e0 = Math.min(insetExtra, maxInsetExtra.current); let last = e0;
    // room to grow: what the right column has left below the inset once the title block and gaps are counted
    const sec = (e.currentTarget as HTMLElement).parentElement as HTMLElement, col = sec.parentElement as HTMLElement;
    const others = [...col.children].filter((c) => c !== sec).reduce((h, c) => h + (c as HTMLElement).getBoundingClientRect().height, 0);
    const gaps = 12 * Math.max(0, col.children.length - 1);
    maxInsetExtra.current = Math.max(0, e0 + col.getBoundingClientRect().height - others - gaps - sec.getBoundingClientRect().height);
    setDragging(true);
    const move = (ev: PointerEvent) => { last = Math.max(0, Math.min(maxInsetExtra.current, e0 + ev.clientY - y0)); setInsetExtra(last); };
    const up = () => { setDragging(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); try { localStorage.setItem("gs.inset.h", String(Math.round(last))); } catch { /* private window */ } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const maxInsetExtra = useRef(2000);
  const toggleAgent = () => setAgentHidden((h) => { try { localStorage.setItem("gs.agent", h ? "shown" : "hidden"); } catch { /* private window */ } return !h; });
  const deepRun = useRef<string | null>(new URLSearchParams(window.location.search).get("run"));
  const [me, setMe] = useState<Me | null>(null);
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [res, setRes] = useState<RunResult | null>(null);
  const [scenario, setScenario] = useState<Scenario>(DEFAULTS);
  const [runLabel, setRunLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<PersistStatus | null>(null);
  const [period, setPeriod] = useState(24);
  const [view, setView] = useState<ViewMode>("axo");
  const [ex, setEx] = useState(40);
  const [section, setSection] = useState<{ on: boolean; row: number; line?: [number, number][] | null }>({ on: true, row: 20 });
  // probes: one inspected cell, one open zone (saved or just drawn), and the depth new drains are drawn at
  const [cell, setCell] = useState<{ row: number; col: number } | null>(null);
  const [cellProbe, setCellProbe] = useState<Loadable<CellProbe>>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [zoneSel, setZoneSel] = useState<{ name?: string; shape?: ZoneShape; cells: [number, number][] } | null>(null);
  const [zoneStats, setZoneStats] = useState<Loadable<ZoneStats>>(null);
  const [drainDepth, setDrainDepth] = useState(2);
  const refreshZones = useCallback(() => api.zones().then((z) => { setZones(z); return z; }).catch(() => [] as Zone[]), []);
  const [bore, setBore] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const placing = tool === "bores";
  const [crop, setCrop] = useState<Crop | "original">("horticulture");
  const [brush, setBrush] = useState(3);
  const [hoverReach, setHoverReach] = useState<string | null>(null);
  const NEW_DOC: Doc = { file: null, name: "Untitled scenario", version: null, saved: DEFAULTS };
  const [doc, setDoc] = useState<Doc>(NEW_DOC);
  const [saving, setSaving] = useState(false);
  const [nameRequest, setNameRequest] = useState(0);
  const [history, setHistory] = useState<Record<string, Version[] | "loading">>({});
  const [compare, setCompare] = useState<(Compare & { key: string }) | null>(null);
  const versions = useRef<Record<string, SavedScenario>>({});
  const hist = useRef({ past: [] as Scenario[], future: [] as Scenario[], t: 0, key: "" });
  const [, bump] = useState(0);
  const [ack, setAck] = useState<string | null>(null);
  // laptops: the model and the agent share the screen; the explorer opens on demand
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1600 && window.innerWidth >= 1100);
  const [detail, setDetail] = useState<"section" | "hydro" | "budget" | "file" | "changes" | "ensemble" | "cell" | "zone">("section");
  // ---- ensembles: run from the title block, shown on the model, filed in the record
  const [ens, setEns] = useState<{ id: string; det: EnsembleDetail } | null>(null);
  const [ensLayer, setEnsLayer] = useState<"p" | "p_any" | "p50" | "off">("p");
  const [ensPanel, setEnsPanel] = useState(false);
  const [ensBusy, setEnsBusy] = useState(false);
  const [ensPending, setEnsPending] = useState<{ id: string; label: string; started: number; estimate: number }[]>([]);
  const [secOpen, setSecOpen] = useState(true);
  const [models, setModels] = useState<FileItem[]>([]), [scenarios, setScenarios] = useState<FileItem[]>([]), [runs, setRuns] = useState<RunRow[]>([]);
  const [inspect, setInspect] = useState<Record<string, Inspect | "loading" | { error: string }>>({});
  const [preview, setPreview] = useState<{ model: string; member: string; text: string } | null>(null);
  const [fileEdit, setFileEdit] = useState<{ model: string; member: string; text: string; orig: string; saving?: boolean } | null>(null);
  const openFileEdit = async (model: string, member: string) => {
    try { const r = await api.previewFull(model, member); setFileEdit({ model, member, text: r.text, orig: r.text }); setDetail("file"); setSecOpen(true); }
    catch (e) { note((e as Error).message); }
  };
  const saveFileEdit = async () => {
    if (!fileEdit) return;
    setFileEdit({ ...fileEdit, saving: true });
    try {
      await api.saveMember(fileEdit.model, fileEdit.member, fileEdit.text);
      note(`${fileEdit.member} saved in ${fileEdit.model}. Solving it again.`);
      const m = fileEdit.model; setFileEdit(null); setPreview(null);
      if (m === active) { await loadBuild(m); await runUploaded(m); }
    } catch (e) { note((e as Error).message); setFileEdit((f) => (f ? { ...f, saving: false } : f)); }
  };
  const [active, setActive] = useState("district");
  const [uploaded, setUploaded] = useState<UploadedRun | null>(null);
  // ---- the model buildkit: an open package as an editable document, with its own undo and save
  const [build, setBuildRaw] = useState<Build | null>(null);
  const bh = useRef({ past: [] as Build[], future: [] as Build[] });
  const bBase = useRef("");
  const [bUnsaved, setBUnsaved] = useState(false);
  const [btool, setBtool] = useState<BTool>("select");
  const [bopts, setBoptsRaw] = useState<BOpts>({ prop: "k", mode: "set", value: 10, brush: 3, fill: false, active: true, head: 0, headMode: "abs", headKind: "chd", allLayers: false,
    rate: 500, schedule: null, stage0: 0, stage1: 0, bed: 1, cond: 100, depth: 1.5, flux: "rch", mm: 100 });
  const setBopts = (x: Partial<BOpts>) => setBoptsRaw((o) => ({ ...o, ...x }));
  const [blayer, setBlayer] = useState(0);
  const [bcell, setBcell] = useState<{ row: number; col: number } | null>(null);
  const [bsel, setBsel] = useState<string | null>(null);
  const [bsaving, setBsaving] = useState(false);
  const [bbusy, setBbusy] = useState(false);
  const [bdiff, setBdiff] = useState<{ files: { member: string; before: string; after: string }[] | null; loading: boolean; error: string | null }>({ files: null, loading: false, error: null });
  const bedit = (next: Build) => {
    setBuildRaw((cur) => { if (cur) { bh.current.past.push(cur); if (bh.current.past.length > 100) bh.current.past.shift(); bh.current.future = []; } return next; });
    setBUnsaved(true);
  };
  const bundo = () => setBuildRaw((cur) => { const prev = bh.current.past.pop(); if (!prev || !cur) return cur; bh.current.future.push(cur); setBUnsaved(true); return prev; });
  const bredo = () => setBuildRaw((cur) => { const nx = bh.current.future.pop(); if (!nx || !cur) return cur; bh.current.past.push(cur); setBUnsaved(true); return nx; });
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [cmd, setCmd] = useState<{ n: number; c: CameraCmd } | null>(null);
  const camCmd = (c: CameraCmd) => setCmd((x) => ({ n: (x?.n ?? 0) + 1, c }));
  const readout = useRef<Readout>({ north: null });
  const work = useRef<HTMLDivElement>(null);
  const size = useSize(work);
  const note = (m: string) => { setToast(m); window.clearTimeout((note as unknown as { t: number }).t); (note as unknown as { t: number }).t = window.setTimeout(() => setToast(null), 4200); };

  // ---- editing: every change goes through edit() so undo, redo and the unsaved state stay truthful
  const scenRef = useRef(scenario); scenRef.current = scenario;
  const edit = (next: Scenario) => {
    const cur = scenRef.current, h = hist.current, now = Date.now();
    const ks = (Object.keys(next) as (keyof Scenario)[]).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
    const key = ks.length === 1 && typeof next[ks[0]] === "number" ? ks[0] : ""; // slider drags coalesce into one step
    if (!ks.length) return;
    if (!key || key !== h.key || now - h.t > 900) { h.past.push(cur); if (h.past.length > 200) h.past.shift(); h.future = []; }
    h.t = now; h.key = key;
    setScenario(canonical(next)); setCompare(null); bump((n) => n + 1); setEns(null);
  };
  const undo = () => { const h = hist.current, prev = h.past.pop(); if (!prev) return; h.future.push(scenRef.current); h.key = ""; setScenario(prev); bump((n) => n + 1); };
  const redo = () => { const h = hist.current, nx = h.future.pop(); if (!nx) return; h.past.push(scenRef.current); h.key = ""; setScenario(nx); bump((n) => n + 1); };
  const resetHistory = () => { hist.current = { past: [], future: [], t: 0, key: "" }; bump((n) => n + 1); };
  const unsaved = !same(scenario, doc.saved);
  const discardOk = () => !unsaved || confirm(`Discard unsaved changes to ${doc.name}?`);

  const refreshFiles = useCallback(() => {
    api.files("models").then(setModels).catch((e) => note(`Models: ${e.message}`));
    api.files("scenarios").then(setScenarios).catch((e) => note(`Scenarios: ${e.message}`));
    api.runs().then(setRuns).catch(() => {});
  }, []);

  // ?run=<id> opens a filed run (agents and jobs hand these links out); ?study=<id> opens a study
  useEffect(() => {
    const id = deepRun.current;
    if (!id || !info || !runs.length) return;
    deepRun.current = null;
    window.history.replaceState(null, "", window.location.pathname);
    const r = runs.find((x) => x.run_id === id);
    if (r) loadRun(r); else { note(`Run ${id} is not among the latest filed runs.`); run(DEFAULTS, "", false); }
  }, [info, runs]); // eslint-disable-line react-hooks/exhaustive-deps

  // runs filed from elsewhere (agents, MCP clients, jobs) appear without a reload
  const lastTop = useRef<string | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.hidden) return;
      api.runs().then((rs) => {
        const top = rs[0];
        if (top && lastTop.current && top.run_id !== lastTop.current && top.origin && top.origin !== "studio")
          note(`${source(top.origin).label} filed rev ${rev(rs.length - 1)}: ${top.label || top.run_id}`);
        lastTop.current = top?.run_id ?? null; setRuns(rs);
      }).catch(() => {});
    }, 15000);
    return () => window.clearInterval(t);
  }, []);

  const [progress, setProgress] = useState<Task | null>(null);
  const run = useCallback(async (s: Scenario, label: string, persist: boolean, ref: { name: string; version: number } | null = null) => {
    setBusy(true);
    try {
      let r: RunResult;
      if (!isNative(fidelity(s))) {
        // finer than native can take minutes: solve it as a background task and show the solver's progress
        let t = await api.runBackground(s, label, persist, ref);
        setProgress(t);
        while (t.status === "running") {
          await new Promise((ok) => setTimeout(ok, 1200));
          t = await api.task(t.task_id).catch(() => t);
          setProgress(t);
        }
        setProgress(null);
        if (t.status === "failed") throw new Error(t.error ?? "The run failed.");
        r = await api.taskResult(t.task_id);
      } else r = await api.run(s, label, persist, ref);
      setRes(r); setPeriod(r.dtw.length - 1); setStatus(persist ? {} : null);
      if (persist) {
        for (let i = 0; i < 40; i++) {
          await new Promise((ok) => setTimeout(ok, 1500));
          const st = await api.runStatus(r.run_id).catch(() => ({}) as PersistStatus);
          setStatus(st); if (st.done) break;
        }
        refreshFiles();
      }
    } catch (e) { note((e as Error).message); setProgress(null); }
    setBusy(false);
  }, [refreshFiles]);

  useEffect(() => {
    api.me().then(setMe).catch((e) => note(e.message));
    api.model().then((m) => { setInfo(m); setBore(m.bores.find((b) => b.bore_type === "monitoring")?.bore_id ?? null); if (!deepRun.current && !startHome.current) run(DEFAULTS, "", false); })
      .catch((e) => note(`Could not read model inputs from Unity Catalog: ${e.message}`));
    refreshFiles(); refreshUserFiles(); refreshZones();
  }, [run, refreshFiles, refreshUserFiles, refreshZones]);

  // probes follow the solved result on screen: re-read when the run changes
  const probeScen = res && active === "district" ? res.scenario : null;
  const probeKey = probeScen ? JSON.stringify(canonical(probeScen)) : "";
  useEffect(() => {
    if (!cell || !probeScen) { setCellProbe(null); return; }
    let live = true; setCellProbe("loading");
    api.probeCell(cell.row, cell.col, probeScen).then((x) => live && setCellProbe(x)).catch((e) => live && setCellProbe({ error: e.message }));
    return () => { live = false; };
  }, [cell, probeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoneWhere = (z: NonNullable<typeof zoneSel>): Record<string, unknown> => (z.name ? { zone: z.name } : z.shape ? { ...z.shape } : { cells: z.cells });
  useEffect(() => {
    if (!zoneSel || !probeScen) { setZoneStats(null); return; }
    let live = true; setZoneStats("loading");
    api.probeZone(zoneWhere(zoneSel), probeScen).then((x) => live && setZoneStats(x)).catch((e) => live && setZoneStats({ error: e.message }));
    return () => { live = false; };
  }, [zoneSel, probeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoneCells = (shape: ZoneShape): [number, number][] => {
    if (!info) return [];
    const act = (r: number, c: number) => info.top[r]?.[c] != null;
    if ("rect" in shape) {
      const [r0, c0, r1, c1] = shape.rect, out: [number, number][] = [];
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (act(r, c)) out.push([r, c]);
      return out;
    }
    return inPolygon(shape.polygon, info.grid.nrow, info.grid.ncol).filter(([r, c]) => act(r, c));
  };
  const openZone = (z: { name?: string; shape?: ZoneShape; cells: [number, number][] }) => { setZoneSel(z); setDetail("zone"); setSecOpen(true); };
  const onDrawZone = (shape: ZoneShape) => {
    const cells = zoneCells(shape);
    if (!cells.length) { note("That shape has no active cells."); return; }
    openZone({ shape, cells });
  };
  const onDrawLine = (kind: "section" | "drains", pts: [number, number][]) => {
    if (kind === "section") { setSection((s) => ({ ...s, on: true, line: pts })); setDetail("section"); setSecOpen(true); return; }
    if (!info) return;
    const cells = trace(pts).filter(([r, c]) => info.top[r]?.[c] != null);
    if (cells.length < 2) { note("A drain needs at least two active cells."); return; }
    const taken = new Set((scenario.drain_lines ?? []).map((d) => d.name));
    let i = 1; while (taken.has(`D${i}`)) i++;
    edit({ ...scenario, drain_lines: [...(scenario.drain_lines ?? []), { name: `D${i}`, cells, depth_m: drainDepth, cond: 500 }] });
    note(`D${i} drawn: ${(cells.length * 0.25).toFixed(2)} km of interceptor drain at ${drainDepth} m. Run the model to see what it removes.`);
  };
  const saveZone = async (name: string) => {
    if (!zoneSel) return;
    try {
      const z = await api.saveZone(name, zoneWhere(zoneSel));
      await refreshZones(); setZoneSel({ name: z.name, cells: z.cells }); note(`Zone ${z.name} saved: ${z.hectares.toLocaleString("en-AU")} ha. The agent can use it by name.`);
    } catch (e) { note((e as Error).message); }
  };
  const deleteZone = async () => {
    if (!zoneSel?.name || !confirm(`Delete the zone ${zoneSel.name}?`)) return;
    try { await api.deleteZone(zoneSel.name); await refreshZones(); setZoneSel(null); if (detail === "zone") setDetail("section"); } catch (e) { note((e as Error).message); }
  };

  // scene for the active model
  const bColor = build?.doc.editable && active !== "district" ? (btool === "props" ? bopts.prop : btool === "grid" ? "idomain" : btool === "flux" ? bopts.flux : null) : null;
  const scene: SceneModel | null = useMemo(() => {
    if (active !== "district" && build?.doc.editable) {
      return buildScene(build, uploaded && uploaded.name === active ? uploaded : null, period, { layer: blayer, color: bColor, showInactive: btool === "grid",
        boreMode: btool === "wel" ? "wel" : btool === "obs" ? "obs" : null });
    }
    if (active !== "district" && uploaded) {
      const p = Math.min(period, uploaded.wt.length - 1);
      return { key: `u:${uploaded.name}`, grid: uploaded.grid, wt: uploaded.wt[p], dtw: uploaded.dtw[p], features: uploaded.features,
        bores: uploaded.bores, change: null };
    }
    if (!info || !res) return null;
    const p = Math.min(period, res.dtw.length - 1);
    const grid = { ...info.grid, top: info.top, botm: info.botm };
    const wt = info.top.map((row, r) => row.map((t, c) => (t == null || res.dtw[p][r][c] == null ? null : t - (res.dtw[p][r][c] as number))));
    const baseWt = info.top.map((row, r) => row.map((t, c) => (t == null || res.baseline_dtw[p][r][c] == null ? null : t - (res.baseline_dtw[p][r][c] as number))));
    const change = ack === res.run_id ? null : res.dtw[p].map((row, r) => row.map((v, c) => (v == null || res.baseline_dtw[p][r][c] == null ? null : (v as number) - (res.baseline_dtw[p][r][c] as number))));
    const proposed = scenario.extra_bores.map((b, i) => ({ bore_id: `P${i + 1}`, bore_type: "proposed" as const, layer: b.layer, row: b.row, col: b.col }));
    // an open ensemble draws its chance of a shallow water table (final month or any month) or its P50 depth instead
    const eOn = ens && ensLayer !== "off";
    const probability = eOn && ensLayer !== "p50" ? (ensLayer === "p_any" ? ens!.det.p_any ?? ens!.det.p : ens!.det.p) : null;
    return { key: "district", grid, wt, dtw: eOn && ensLayer === "p50" ? ens!.det.p50 : res.dtw[p], baseWt, change: eOn ? null : change,
      features: info.features, bores: [...info.bores, ...proposed], probability };
  }, [active, uploaded, info, res, period, ack, scenario.extra_bores, ens, ensLayer, build, blayer, bColor, btool]);

  // a package being built reads its periods as months when it has a start date and a result for each period
  const bLabels = build?.doc.editable && active !== "district" && build.doc.time.start ? periodLabels(build.doc) : null;  // a calendar only when the model has one
  const labels = active !== "district" && uploaded
    ? (bLabels && uploaded.name === active && bLabels.length === uploaded.times.length ? bLabels
      : ["initial", ...uploaded.times.slice(1).map((t, i) => `Period ${i + 2} · ${fmt(t, 0)} ${uploaded.time_units}`)])
    : info?.periods ?? [];
  const revisions = scene?.change ? scene.change.flat().filter((v) => v != null && Math.abs(v) >= 0.2).length : 0;
  const nClouds = revisions > 0 ? 1 : 0;

  const onPlace = (row: number, col: number) => {
    edit({ ...scenario, extra_bores: [...scenario.extra_bores, { row, col, layer: 1, ML_per_year: 1000 }] });
    note(`P${scenario.extra_bores.length + 1} sited at row ${row + 1}, col ${col + 1}, 1,000 ML/yr. Run the model to see its drawdown.`);
  };
  const ref = doc.file && doc.version && !unsaved ? { name: doc.file, version: doc.version } : null;
  const issue = () => {
    setAck(null);
    const label = runLabel || (doc.file ? `${doc.name} v${doc.version}${unsaved ? ", edited" : ""}` : describe(scenario));
    run(scenario, label, true, ref);
  };

  // ---- the scenario document: save (a new version), save as, new, open, history, compare, restore
  const loadHistory = (file: string) => {
    setHistory((h) => ({ ...h, [file]: h[file] ?? "loading" }));
    api.history(file).then((v) => setHistory((h) => ({ ...h, [file]: v }))).catch((e) => { note(e.message); setHistory((h) => ({ ...h, [file]: [] })); });
  };
  const saveDoc = async (asName?: string) => {
    if (active !== "district" || saving) return;
    if (!asName && !doc.file) { setNameRequest((n) => n + 1); return; }
    const name = asName ?? doc.name;
    setSaving(true);
    try {
      let r;
      try { r = await api.saveScenario(name, scenario, asName ? {} : { base_version: doc.version }); }
      catch (e) {
        if (asName && /already exists/.test((e as Error).message) && confirm(`${name} already exists. Save this as its next version?`)) r = await api.saveScenario(name, scenario, { overwrite: true });
        else throw e;
      }
      setDoc({ file: r.name, name, version: r.version, saved: scenario, savedBy: r.saved_by, savedAt: r.saved_at });
      saveLast({ kind: "scenario", key: r.name, label: `${name} v${r.version}` });
      note(`Saved ${name} v${r.version} · ${r.summary}`);
      refreshFiles(); loadHistory(r.name);
    } catch (e) { note((e as Error).message); }
    setSaving(false);
  };
  const newDoc = () => {
    if (!discardOk()) return;
    setScenario(DEFAULTS); setDoc(NEW_DOC); resetHistory(); setRunLabel(""); setCompare(null); setActive("district"); run(DEFAULTS, "", false);
    saveLast({ kind: "baseline", key: "district", label: "Sample district model, calibrated baseline" });
  };
  const getVersion = async (file: string, v: number) => (versions.current[`${file}@${v}`] ??= await api.loadScenario(file, v));
  const compareVersion = async (file: string, v: number) => {
    try {
      const cur = await getVersion(file, v), prev = v > 1 ? await getVersion(file, v - 1) : null;
      setCompare({ key: `${file}@${v}`, path: `workspace/scenarios/${file}`, fromLabel: prev ? `v${v - 1}` : "Baseline", toLabel: `v${v}`,
        from: canonical({ ...DEFAULTS, ...(prev?.scenario ?? {}) }), to: canonical({ ...DEFAULTS, ...cur.scenario }),
        summary: cur.summary, by: cur.saved_by, at: cur.saved_at, restore: doc.file === file && doc.version === v ? undefined : { version: v } });
      setDetail("changes"); setSecOpen(true);
    } catch (e) { note((e as Error).message); }
  };
  const restore = async () => {
    if (!compare?.restore) return;
    const file = compare.key.split("@")[0], v = compare.restore.version;
    if (doc.file !== file && !discardOk()) return;
    try {
      const latest = await api.loadScenario(file), old = await getVersion(file, v);
      const saved = canonical({ ...DEFAULTS, ...latest.scenario }), next = canonical({ ...DEFAULTS, ...old.scenario });
      if (doc.file !== file) resetHistory();
      setDoc({ file, name: latest.name, version: latest.version, saved, savedBy: latest.saved_by, savedAt: latest.saved_at });
      setActive("district"); edit(next); setScenario(next); setCompare(null);
      run(next, "", false);
      note(same(next, saved) ? `v${v} is the current version.` : `v${v} restored as unsaved changes. Save to make it v${(latest.version ?? 0) + 1}.`);
    } catch (e) { note((e as Error).message); }
  };

  const activate = async (name: string) => {
    setActive(name);
    if (name === "district") { setPeriod(res ? res.dtw.length - 1 : 24); setEx(40); return; }
  };
  const runUploaded = async (name: string) => {
    setBusyModel(name);
    try {
      const u = await api.runUploaded(name);
      setUploaded(u); setActive(name); setPeriod(u.wt.length - 1); setEx(autoEx(u.grid));
      saveLast({ kind: "model", key: name, label: name.replace(/\.zip$/, "") });
      setSection({ on: true, row: Math.floor(u.grid.nrow / 2) }); setBore(null);
      note(`${name} solved in ${fmt(u.run_s, 2)} s`);
    } catch (e) { note((e as Error).message); setActive(name); saveLast({ kind: "model", key: name, label: name.replace(/\.zip$/, "") }); }
    setBusyModel(null);
  };
  // the open package as a build document; read again whenever another package opens
  const loadBuild = useCallback(async (name: string) => {
    try {
      const b = await openBuild(await api.buildGet(name));
      setBuildRaw(b); bh.current = { past: [], future: [] }; bBase.current = b.doc.base_sha; setBUnsaved(false); setBcell(null); setBsel(null);
      setBlayer((l) => (b.doc.grid ? Math.min(l, b.doc.grid.nlay - 1) : 0));  // packages kept as uploaded have no grid here
      if (b.doc.editable) {
        const t = b.arr.top, mean = t.reduce((a, x) => a + x, 0) / t.length;
        setBopts({ head: Math.round(mean - 2), stage0: Math.round(mean - 1), stage1: Math.round(mean - 3) });
      }
    } catch (e) { setBuildRaw(null); note(`Could not open ${name} for editing: ${(e as Error).message}`); }
  }, []);
  useEffect(() => { setFileEdit((f) => (f && f.model !== active ? null : f)); if (active === "district") { setBuildRaw(null); return; } void loadBuild(active); }, [active, loadBuild]);
  useEffect(() => {
    if (!bmode || detail !== "changes" || !secOpen || !build) return;
    if (!bUnsaved) { setBdiff({ files: [], loading: false, error: null }); return; }
    let live = true; setBdiff((x) => ({ ...x, loading: true, error: null }));
    const t = window.setTimeout(async () => {
      try { const d = await toDoc(build); const r = await api.buildPreview(active, d); if (live) setBdiff({ files: r.files, loading: false, error: null }); }
      catch (e) { if (live) setBdiff({ files: null, loading: false, error: (e as Error).message }); }
    }, 450);
    return () => { live = false; window.clearTimeout(t); };
  }, [build, detail, secOpen, bUnsaved]); // eslint-disable-line react-hooks/exhaustive-deps
  const bsave = async (andRun = false) => {
    if (!build || bsaving || active === "district") return;
    if (!bUnsaved) { if (andRun) await runUploaded(active); return; }
    setBsaving(true);
    try {
      const d = await toDoc(build); d.base_sha = bBase.current;
      const r = await api.buildSave(active, d);
      const nb = await openBuild(r.doc);
      setBuildRaw(nb); bBase.current = nb.doc.base_sha; setBUnsaved(false); setBdiff({ files: null, loading: false, error: null });
      note(r.changed_files.length ? `Saved ${active}: ${r.changed_files.join(", ")} rewritten; everything else as it was.` : `Saved ${active}: no file changed.`);
      refreshFiles();
      if (andRun) await runUploaded(active);
    } catch (e) { note((e as Error).message); }
    setBsaving(false);
  };
  const bserver = async (ops: Record<string, unknown>[]) => {
    if (!build) return;
    setBbusy(true);
    try {
      const d = await toDoc(build); d.base_sha = bBase.current;
      const r = await api.buildOps(active, d, ops);
      bedit(await openBuild(r.doc)); note(r.done.join("; "));
    } catch (e) { note((e as Error).message); }
    setBbusy(false);
  };
  const bLayers = (layered = true) => (!layered ? [0] : bopts.allLayers && build ? Array.from({ length: build.doc.grid.nlay }, (_, i) => i) : [blayer]);
  const bpaint = (cells: { row: number; col: number }[]) => {
    if (!build || !cells.length) return;
    if (btool === "props") { const meta = PROPS.find((x) => x.key === bopts.prop); bedit(paintProp(build, bopts.prop, bLayers(meta?.layered !== false), cells, bopts.mode, bopts.value)); }
    else if (btool === "grid") bedit(paintProp(build, "idomain", bLayers(), cells, "set", bopts.active ? 1 : 0));
    else if (btool === "flux") bedit(paintProp(build, bopts.flux, [0], cells, bopts.mode, bopts.mm));
    else if (btool === "chd" && bopts.headKind === "ghb") { bedit(addGhb(build, cells.map((c) => [c.row, c.col]), bLayers(), bopts.head, bopts.headMode, bopts.cond, bopts.schedule)); note(`General head on ${cells.length} cells.`); }
    else if (btool === "chd") { bedit(addHeads(build, cells.map((c) => [c.row, c.col]), bLayers(), bopts.head, bopts.headMode, bopts.schedule)); note(`Fixed head on ${cells.length} cells.`); }
  };
  const bfill = (shape: ZoneShape) => {
    if (!build) return;
    const { nrow, ncol } = build.doc.grid, cells: { row: number; col: number }[] = [];
    if ("rect" in shape) { const [r0, c0, r1, c1] = shape.rect; for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push({ row: r, col: c }); }
    else inPolygon(shape.polygon, nrow, ncol).forEach(([row, col]) => cells.push({ row, col }));
    bpaint(cells);
  };
  const bedge = (e: "west" | "east" | "north" | "south") => {
    if (!build) return;
    const { nrow, ncol } = build.doc.grid;
    const cells: [number, number][] = e === "west" ? Array.from({ length: nrow }, (_, r) => [r, 0]) : e === "east" ? Array.from({ length: nrow }, (_, r) => [r, ncol - 1])
      : e === "north" ? Array.from({ length: ncol }, (_, c) => [0, c]) : Array.from({ length: ncol }, (_, c) => [nrow - 1, c]);
    if (bopts.headKind === "ghb") { bedit(addGhb(build, cells, bLayers(), bopts.head, bopts.headMode, bopts.cond, bopts.schedule)); note(`General head along the ${e} edge.`); return; }
    bedit(addHeads(build, cells, bLayers(), bopts.head, bopts.headMode, bopts.schedule)); note(`Fixed head along the ${e} edge.`);
  };
  const doInspect = (name: string) => {
    setInspect((x) => ({ ...x, [name]: "loading" }));
    api.inspect(name).then((i) => setInspect((x) => ({ ...x, [name]: i }))).catch((e) => setInspect((x) => ({ ...x, [name]: { error: e.message } })));
  };
  const doPreview = (model: string, member: string) => {
    api.preview(model, member).then((p) => { setPreview({ model, member, text: p.text }); setDetail("file"); setSecOpen(true); }).catch((e) => note(e.message));
  };
  const upload = async (kind: "models" | "scenarios", f: File) => {
    setUploading(kind);
    try {
      const prog = f.size > 16 * 1024 * 1024 ? (x: number) => note(`Uploading ${f.name}: ${Math.round(x * 100)}% of ${(f.size / 2 ** 20).toFixed(0)} MB`) : undefined;
      await api.upload(kind, f, false, prog).catch(async (e: Error) => {
        if (/already exists/.test(e.message) && confirm(`${f.name} already exists. Replace it?`)) return api.upload(kind, f, true, prog);
        throw e;
      });
      note(`${f.name} uploaded to the workspace volume`); refreshFiles();
    } catch (e) { note((e as Error).message); }
    setUploading(null);
  };
  const remove = async (kind: "models" | "scenarios", name: string) => {
    try { await api.remove(kind, name); if (active === name) setActive("district"); refreshFiles(); note(`${name} deleted`); } catch (e) { note((e as Error).message); }
  };
  const loadScenario = async (name: string) => {
    if (doc.file === name && !unsaved) return;
    if (!discardOk()) return;
    try {
      const d = await api.loadScenario(name), sc = canonical({ ...DEFAULTS, ...d.scenario });
      setScenario(sc); setDoc({ file: name, name: d.name, version: d.version, saved: sc, savedBy: d.saved_by, savedAt: d.saved_at });
      resetHistory(); setRunLabel(""); setActive("district"); setCompare(null); setShownRun(null);
      run(sc, d.name, false);
      saveLast({ kind: "scenario", key: name, label: `${d.name}${d.version ? ` v${d.version}` : ""}` });
    } catch (e) { note((e as Error).message); }
  };
  // a run the agent filed, put on the model: quietly (following) or because the user asked
  const [shownRun, setShownRun] = useState<string | null>(null);
  const openAgentRun = async (id: string, quiet: boolean) => {
    if (quiet && unsaved) { note("The agent filed a run. Save or discard your changes to see it on the model."); return; }
    for (let i = 0; i < 6; i++) {
      const rs = await api.runs().catch(() => null);
      const r = rs?.find((x) => x.run_id === id);
      if (rs && r) {
        setRuns(rs);
        if (!quiet && !discardOk()) return;
        const sc = canonical({ ...DEFAULTS, ...JSON.parse(r.scenario_json || "{}") } as Scenario);
        setScenario(sc); setRunLabel(r.label || ""); setActive("district"); resetHistory(); setCompare(null);
        setDoc({ file: null, name: r.label || `Run ${r.run_id.slice(0, 6)}`, version: null, saved: sc });
        run(sc, r.label || "", false); setShownRun(id);
        setHome(false);  // following the agent lands on the model, not the start page
        if (!quiet) setSheet(0);
        return;
      }
      await new Promise((ok) => window.setTimeout(ok, 1500)); // filing is a moment behind the tool result
    }
    if (!quiet) note("That run is still filing; try again in a moment.");
  };
  // following the agent: put the overlay it is reading on the model and move the view to where it is working
  const live = useRef({ follow, sheet, info, nrow: 40, home, hasRes: false });
  live.current = { follow, sheet, info, nrow: info?.grid.nrow ?? 40, home, hasRes: !!res };
  const frame = (cells: { row: number; col: number }[]) => {
    if (!cells.length) return;
    const rs = cells.map((c) => c.row), cs = cells.map((c) => c.col);
    const r0 = Math.min(...rs), r1 = Math.max(...rs), c0 = Math.min(...cs), c1 = Math.max(...cs);
    setSection((s) => (s.on && r1 > s.row ? { ...s, row: Math.min(live.current.nrow - 2, r1) } : s)); // keep the cutaway off them
    camCmd({ kind: "focus", rows: [r0, r1], cols: [c0, c1] });
  };
  const onActivity = useCallback((a: Activity) => {
    const { follow: on, sheet: sh, info: inf } = live.current;
    if (!on || !inf) return;
    const r0 = a.result;
    // the start page steps aside for anything the agent does on the model
    if (sh === 0 && live.current.home && MODEL_TOOLS.has(a.tool)) {
      setHome(false);
      if (!live.current.hasRes) run(scenRef.current, "", false);
    }
    if (a.tool === "show_in_studio" && r0?.shown) { show(r0.shown as Shown); return; }
    if ((a.tool === "save_zone" || a.tool === "delete_zone") && r0) {
      void fns.current.refreshZones().then((zs) => { const z = zs.find((x) => x.name === r0.name); if (z && a.tool === "save_zone") { fns.current.openZone({ name: z.name, cells: z.cells }); frame(z.cells.map(([row, col]) => ({ row, col }))); } });
      return;
    }
    if (a.tool === "run_model" && r0?.package) { setSheet(0); fns.current.runUploaded(String(r0.package)); return; }
    if (a.tool === "edit_model" && r0?.package) { setSheet(0); setHome(false); fns.current.afterAgentEdit(String(r0.package)); return; }
    if (a.tool === "get_ensemble" && r0?.status === "finished" && r0.ensemble_id) { void fns.current.openEnsemble(String(r0.ensemble_id)); return; }
    if (sh !== 0) return;
    const spec = (a.args.scenario ?? {}) as { line_reaches?: string[]; add_bores?: { row: number; col: number }[]; paint?: unknown[]; add_drains?: { cells: [number, number][] }[] };
    const r = a.result;
    if (a.tool === "inspect_cell" && a.first && a.args.row != null) {
      const c = { row: Number(a.args.row), col: Number(a.args.col) };
      setCell(c); setDetail("cell"); setSecOpen(true); frame([c]); return;
    }
    if (a.tool === "zone_budget" && a.first && a.args.where) {
      const w = a.args.where as { zone?: string; rect?: [number, number, number, number]; polygon?: [number, number][]; cells?: [number, number][] };
      const open = (z: { name?: string; shape?: ZoneShape; cells: [number, number][] }) => { fns.current.openZone(z); frame(z.cells.map(([row, col]) => ({ row, col }))); };
      if (w.zone) void fns.current.refreshZones().then((zs) => { const z = zs.find((x) => x.name.toLowerCase() === w.zone!.toLowerCase()); if (z) open({ name: z.name, cells: z.cells }); });
      else if (w.rect || w.polygon) { const shape = (w.rect ? { rect: w.rect } : { polygon: w.polygon }) as ZoneShape; open({ shape, cells: fns.current.zoneCells(shape) }); }
      else if (w.cells?.length) open({ cells: w.cells });
      return;
    }
    if (a.tool === "get_section" && a.first && Array.isArray(a.args.points)) {
      const pts = a.args.points as [number, number][];
      setSection((s) => ({ ...s, on: true, line: pts })); setDetail("section"); setSecOpen(true); frame(pts.map(([row, col]) => ({ row, col }))); return;
    }
    if (a.tool === "describe_model" && a.first) { setAgentView(null); camCmd({ kind: "reset" }); }
    else if (a.tool === "render_map" && a.first) {
      const layer = String(a.args.layer ?? "land_use");
      setAgentView({ overlay: layer === "land_use" ? "land" : layer === "reaches" ? "reaches" : null, cells: null,
        label: layer === "land_use" ? "Land use" : layer === "reaches" ? "Channel reaches" : layer === "change" ? "Change from baseline" : "Depth to water" });
      if (layer === "change") setAck(null);
    } else if (a.tool === "find_cells" && r && Array.isArray(r.cells)) {
      const cells = (r.cells as [number, number][]).map(([row, col]) => ({ row, col }));
      const where = (a.args.where ?? {}) as Record<string, unknown>;
      setAgentView({ overlay: where.crop ? "land" : null, cells, label: `${String(r.hectares ?? "")} ha found` });
      frame(cells);
    } else if (a.tool === "run_scenario" && a.first) {
      const label = String(a.args.label || "a scenario");
      if (spec.line_reaches?.length) {
        const cells = inf.reaches.filter((x) => spec.line_reaches!.includes(x.id)).flatMap((x) => x.cells);
        setAgentView({ overlay: "reaches", cells, label: `Running: ${label}` }); setHoverReach(spec.line_reaches[0]); frame(cells);
      } else if (spec.add_drains?.length) {
        const cells = spec.add_drains.flatMap((d) => trace(d.cells)).map(([row, col]) => ({ row, col }));
        setAgentView({ overlay: null, cells, label: `Running: ${label}` }); frame(cells);
      } else if (spec.add_bores?.length) {
        const cells = spec.add_bores.map((b) => ({ row: b.row, col: b.col }));
        setAgentView({ overlay: null, cells, label: `Running: ${label}` }); frame(cells);
      } else setAgentView({ overlay: spec.paint?.length ? "land" : null, cells: null, label: `Running: ${label}` });
    }
    if (a.tool === "run_scenario" && r?.run_id) {
      setAgentView((v) => (v ? { ...v, cells: null, label: `Filed: ${String(a.args.label || r.run_id)}` } : v));
      setHoverReach(null); setDetail("section"); setSecOpen(true);
    } else if ((a.tool === "compare_runs" || a.tool === "get_run") && r) { setDetail("budget"); setSecOpen(true); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // the agent asked for something to be on screen
  type Shown = { ensemble?: string; run_id?: string; model?: string; scenario?: string; view?: string; overlay?: string; panel?: string; bore?: string;
    section_row?: number; month?: number; cells?: [number, number][]; sheet?: string; section_line?: [number, number][]; cell?: [number, number]; zone?: string };
  const fns = useRef({ runUploaded: (_: string) => {}, openAgentRun: (_: string) => {}, loadScenario: (_: string) => {}, labels: 0,
    openEnsemble: async (_: string) => {}, refreshZones: async () => [] as Zone[], openZone: (_: { name?: string; shape?: ZoneShape; cells: [number, number][] }) => {},
    zoneCells: (_: ZoneShape) => [] as [number, number][], afterAgentEdit: (_: string) => {} });
  const show = (w: Shown) => {
    const f = fns.current;
    setHome(false);
    if (w.sheet) setSheet(w.sheet === "record" ? RECORD : 0);
    else setSheet(0);
    if (w.run_id) f.openAgentRun(w.run_id);
    if (w.ensemble) void f.openEnsemble(w.ensemble);
    if (w.model) { if (w.model === "district") { setActive("district"); } else f.runUploaded(w.model.endsWith(".zip") ? w.model : `${w.model}.zip`); }
    if (w.scenario) f.loadScenario(w.scenario.endsWith(".json") ? w.scenario : `${w.scenario}.json`);
    if (w.view) setView(w.view === "plan" ? "plan" : "axo");
    if (w.overlay) setAgentView(w.overlay === "none" || w.overlay === "depth_to_water" ? null
      : { overlay: w.overlay === "land_use" ? "land" : "reaches", cells: null, label: w.overlay === "land_use" ? "Land use" : "Channel reaches" });
    if (w.panel) { setDetail(w.panel === "hydrograph" ? "hydro" : w.panel === "budget" ? "budget" : w.panel === "changes" ? "changes" : w.panel === "cell" ? "cell" : w.panel === "zone" ? "zone" : "section"); setSecOpen(true); }
    if (w.bore) { setBore(w.bore); setDetail("hydro"); setSecOpen(true); }
    if (w.section_row != null) setSection((s) => ({ ...s, on: true, line: null, row: Math.max(1, Math.min(live.current.nrow - 2, w.section_row! - 1)) }));
    if (w.section_line?.length) { setSection((s) => ({ ...s, on: true, line: w.section_line })); setDetail("section"); setSecOpen(true); }
    if (w.cell) { const c = { row: w.cell[0], col: w.cell[1] }; setCell(c); setDetail("cell"); setSecOpen(true); frame([c]); }
    if (w.zone) void f.refreshZones().then((zs) => { const z = zs.find((x) => x.name.toLowerCase() === w.zone!.toLowerCase()); if (z) { f.openZone({ name: z.name, cells: z.cells }); frame(z.cells.map(([row, col]) => ({ row, col }))); } });
    if (w.month != null) setPeriod(Math.max(1, Math.min(f.labels - 1, w.month)));
    if (w.cells?.length) { const cells = w.cells.map(([row, col]) => ({ row, col })); setAgentView((v) => ({ overlay: v?.overlay ?? null, cells, label: `${cells.length} cells` })); frame(cells); }
  };
  useEffect(() => { if (!follow) setAgentView(null); }, [follow]);
  useEffect(() => { if (tool !== "select") setAgentView(null); }, [tool]);

  fns.current = { runUploaded: (n) => { void runUploaded(n); }, openAgentRun: (id) => { void openAgentRun(id, true); },
    loadScenario: (n) => { void loadScenario(n); }, labels: labels.length, openEnsemble: (id) => openEnsemble(id), refreshZones, openZone, zoneCells,
    afterAgentEdit: (n) => {
      if (n === active && bUnsaved) { note(`The agent edited ${n}. Save or discard your changes to see its version.`); return; }
      void loadBuild(n).then(() => runUploaded(n));
    } };
  const addToChat = (ref: ChatRef) => {
    if (agentHidden) toggleAgent();
    setInbox((x) => ({ n: (x?.n ?? 0) + 1, ref }));
  };
  // open a finished ensemble on the model: its scenario as the single run for context, its chance map and bands on top
  const openEnsemble = async (id: string) => {
    try {
      const det = await api.ensemble(id);
      const cfgS = det.config?.scenario as Partial<Scenario> | undefined;
      setSheet(0); setHome(false); setActive("district");
      if (cfgS && !same(canonical({ ...DEFAULTS, ...cfgS } as Scenario), scenario)) {
        if (!discardOk()) return;
        const sc = canonical({ ...DEFAULTS, ...cfgS } as Scenario);
        setScenario(sc); resetHistory(); setCompare(null); setDoc({ file: null, name: det.summary?.label || id, version: null, saved: sc });
        run(sc, det.summary?.label || "", false);
      } else if (!res) run(scenario, "", false);
      setEns({ id, det }); setEnsLayer("p"); setDetail("ensemble"); setSecOpen(true);
    } catch (e) { note((e as Error).message); }
  };
  const launchEnsemble = async (o: { n: number; vary: Vary; rmse_threshold_m: number; label: string }) => {
    setEnsBusy(true);
    try {
      const label = o.label || `${o.n}-member ensemble of ${doc.file ? doc.name : describe(scenario)}`.slice(0, 120);
      const r = await api.launchEnsemble({ scenario, n: o.n, vary: o.vary, rmse_threshold_m: o.rmse_threshold_m, label,
        scenario_name: doc.file && doc.version && !unsaved ? `${doc.file} v${doc.version}` : null });
      setEnsPending((p) => [...p, { id: r.ensemble_id, label, started: Date.now(), estimate: r.estimate_s }]);
      setEnsPanel(false); note(`Ensemble submitted to serverless Spark; about ${Math.round(r.estimate_s / 60)} min. It opens here when it finishes.`);
    } catch (e) { note((e as Error).message); }
    setEnsBusy(false);
  };
  // watch submitted ensembles; open each on the model as it finishes
  useEffect(() => {
    if (!ensPending.length) return;
    const t = window.setInterval(async () => {
      const d = await api.ensembles().catch(() => null);
      if (!d) return;
      for (const p of ensPending) {
        if (d.completed.some((e) => e.ensemble_id === p.id)) {
          setEnsPending((x) => x.filter((y) => y.id !== p.id)); note(`Ensemble finished: ${p.label}`); void fns.current.openEnsemble(p.id);
        } else {
          const j = d.jobs.find((x) => x.ensemble_id === p.id);
          if (j && j.life_cycle === "TERMINATED" && j.result && j.result !== "SUCCESS") {
            setEnsPending((x) => x.filter((y) => y.id !== p.id)); note(`Ensemble ${p.label} failed (${j.result}). The job run has the details.`);
          }
        }
      }
    }, 12000);
    return () => window.clearInterval(t);
  }, [ensPending]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadRun = (r: RunRow) => {
    if (!discardOk()) return;
    const s = canonical({ ...DEFAULTS, ...JSON.parse(r.scenario_json || "{}") } as Scenario);
    setScenario(s); setRunLabel(r.label || ""); setActive("district"); resetHistory(); setCompare(null);
    setDoc({ file: null, name: r.label || `Run ${r.run_id.slice(0, 6)}`, version: null, saved: s });
    run(s, r.label || "", false); setShownRun(null);
    saveLast({ kind: "run", key: r.run_id, label: r.label || `Run ${r.run_id.slice(0, 6)}` });
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement, typing = ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName), mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
      if (mod && k === "s") { e.preventDefault(); if (active !== "district") void bsave(); else saveDoc(); return; }
      if (!typing && sheet === 0 && !home && active !== "district" && build?.doc.editable) {
        if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) bredo(); else bundo(); return; }
        if (mod && e.key === "Enter") { e.preventDefault(); void bsave(true); return; }
        if (mod || e.altKey) return;
        if (e.key === "?") { setKeysOpen((o) => !o); return; }
        if (k === "p") { setView((v) => (v === "plan" ? "axo" : "plan")); return; }
        if (e.key === "0" || e.key === "Home") { camCmd({ kind: "reset" }); return; }
        if (e.key === "," || e.key === ".") { setPeriod((p) => Math.max(0, Math.min(labels.length - 1, p + (e.key === "," ? -1 : 1)))); return; }
        if (e.key === "Escape") { setBtool("select"); return; }
        if (BTOOL_KEYS[k]) { setBtool(BTOOL_KEYS[k]); return; }
        if (e.key === "[") setBopts({ brush: Math.max(1, bopts.brush === 9 ? 5 : bopts.brush - 2) });
        if (e.key === "]") setBopts({ brush: Math.min(9, bopts.brush === 5 ? 9 : bopts.brush + 2) });
        return;
      }
      if (mod && e.key === "Enter" && sheet === 0 && active === "district" && !busy) { e.preventDefault(); issue(); return; }
      if (typing || sheet !== 0 || active !== "district" || home) return;
      if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && k === "y") { e.preventDefault(); redo(); return; }
      if (mod || e.altKey) return;
      if (e.key === "?") { setKeysOpen((o) => !o); return; }
      if (k === "p") { setView((v) => (v === "plan" ? "axo" : "plan")); return; }
      if (e.key === "0" || e.key === "Home") { camCmd({ kind: "reset" }); return; }
      if (e.key === "," || e.key === ".") { setPeriod((p) => Math.max(1, Math.min(labels.length - 1, p + (e.key === "," ? -1 : 1)))); return; }
      if (e.key === "Escape" && keysOpen) setKeysOpen(false);
      else if (e.key === "Escape") setTool("select");
      else if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
      else if (e.key === "[") setBrush((b) => Math.max(1, b - 2));
      else if (e.key === "]") setBrush((b) => Math.min(5, b + 2));
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  });
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (unsaved) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h);
  }, [unsaved]);

  // title block content
  const k = res?.kpis, b = res?.baseline_kpis;
  const es = ens?.det.summary;
  const ensFigures: Figure[] = ens && es ? [
    { label: "Area < 2 m, Jun 2026", value: `${fmt(es.mean_pct_area_dtw_lt_2m)}%`, range: es.p10_pct_area_dtw_lt_2m != null ? `P10–P90 ${fmt(es.p10_pct_area_dtw_lt_2m)}–${fmt(es.p90_pct_area_dtw_lt_2m)}` : `P90 ${fmt(es.p90_pct_area_dtw_lt_2m)}` },
    { label: "Peak month", value: es.peak_mean_pct_area_dtw_lt_2m != null ? `${fmt(es.peak_mean_pct_area_dtw_lt_2m)}%` : "–", delta: null },
    { label: "Cells > 50% likely", value: `${fmt((ens.det.p.flat().filter((v) => v != null && v > 0.5).length / Math.max(1, ens.det.p.flat().filter((v) => v != null).length)) * 100)}%` },
    { label: "Kept", value: `${es.n_behavioural} of ${es.n_realizations}` },
    { label: "Best fit", value: `${fmt(Math.min(...ens.det.realizations.filter((r) => r.rmse_m != null).map((r) => r.rmse_m as number)), 2)} m` },
    { label: "Spark", value: `${fmt(es.runtime_s, 0)} s` },
  ] : [];
  const figures: Figure[] = ens && ensFigures.length ? ensFigures : active !== "district" && uploaded ? [
    { label: "Grid", value: `${uploaded.grid.nlay}×${uploaded.grid.nrow}×${uploaded.grid.ncol}` },
    { label: "Stress periods", value: `${uploaded.times.length}` },
    { label: "Median depth", value: `${fmt(median(uploaded.dtw[uploaded.dtw.length - 1]), 2)} m` },
    { label: "Solve", value: `${fmt(uploaded.run_s, 2)} s` },
    { label: "Wells", value: `${uploaded.bores.length}` },
    { label: "Cell size", value: `${fmt(uploaded.grid.delr_km * 1000, 0)} m` },
  ] : k && b ? [
    { label: "Area < 2 m", value: `${fmt(k.pct_area_dtw_lt_2m_final)}%`, delta: delta(k.pct_area_dtw_lt_2m_final, b.pct_area_dtw_lt_2m_final, 1, "") },
    { label: "Worst month", value: `${fmt(k.pct_area_dtw_lt_2m_peak)}%`, delta: delta(k.pct_area_dtw_lt_2m_peak, b.pct_area_dtw_lt_2m_peak, 1, "") },
    { label: "Channel seepage", value: `${fmt(k.canal_seepage_ml / 1000)} GL`, delta: delta(k.canal_seepage_ml, b.canal_seepage_ml, 1, "", 1e-3) },
    { label: "Extraction", value: `${fmt(k.bore_extraction_ml / 1000)} GL`, delta: delta(k.bore_extraction_ml, b.bore_extraction_ml, 1, "", 1e-3) },
    { label: "Groundwater ET", value: `${fmt(k.gw_et_ml / 1000)} GL`, delta: delta(k.gw_et_ml, b.gw_et_ml, 1, "", 1e-3) },
    { label: "Median depth", value: `${fmt(k.median_dtw_m, 2)} m`, delta: delta(k.median_dtw_m, b.median_dtw_m, 2, "") },
  ] : [];
  const filedIdx = status && res ? runs.findIndex((r) => r.run_id === res.run_id) : -1;
  const revLetter = filedIdx >= 0 ? rev(runs.length - 1 - filedIdx) : `${rev(runs.length)} (next)`;
  const dirty = !same(scenario, res?.scenario ?? DEFAULTS);
  const agentContext = home && sheet === 0 ? "the user is on the Studio's start page; nothing is open on the model yet"
    : active !== "district" ? `the uploaded package ${active} is open on the model`
    : [shownRun ? `run ${shownRun} is open on the model` : res?.run_id && status ? `run ${res.run_id} is open on the model` : null,
       doc.file ? `working scenario ${doc.file}${doc.version ? ` v${doc.version}` : ""}${unsaved ? " with unsaved edits" : ""}` : unsaved ? "unsaved edits to the working scenario" : null]
      .filter(Boolean).join("; ") || null;
  const nextRev = rev(runs.length);
  const secPath = useMemo(() => {
    if (!scene) return [];
    if (section.line?.length) return trace(section.line).filter(([r, c]) => r < scene.grid.nrow && c < scene.grid.ncol).map(([row, col]) => ({ row, col }));
    return Array.from({ length: scene.grid.ncol }, (_, col) => ({ row: section.row, col }));
  }, [scene, section.line, section.row]);
  const secKm = secPath.length > 1 ? secPath.slice(1).reduce((d, q, i) => d + Math.hypot(q.row - secPath[i].row, q.col - secPath[i].col), 0) * (scene?.grid.delr_km ?? 0.25) : 0;
  const marks = useMemo(() => {
    const m: { cells: { row: number; col: number }[]; color: string }[] = [];
    if (active !== "district") {
      const f = uploaded?.features;
      if (f?.chd?.length) m.push({ cells: f.chd, color: "#5b3a8c" });
      if (f?.ghb?.length) m.push({ cells: f.ghb, color: "#2f7d6d" });
      if (f?.lake?.length || f?.uzf?.length) m.push({ cells: [...(f.lake ?? []), ...(f.uzf ?? [])], color: "#8a6d3b" });
      return m;
    }
    if (zoneSel) m.push({ cells: zoneSel.cells.map(([row, col]) => ({ row, col })), color: ZONE_INK });
    if (cell && detail === "cell") m.push({ cells: [cell], color: "#111111" });
    return m;
  }, [zoneSel, cell, detail, active, uploaded]);
  const bmode = active !== "district" && !!build?.doc.editable;
  const geo = build?.doc.editable ? { ...(uploaded?.name === active ? uploaded.georef : undefined), ...build.doc.georef } : uploaded?.name === active ? uploaded.georef : undefined;
  const ENGINE: Record<string, string> = { mf6: "MODFLOW 6", mf2005: "MODFLOW-2005", mfnwt: "MODFLOW-NWT", mfusg: "MODFLOW-USG" };
  const ll = uploaded?.name === active ? uploaded.georef?.centre_lonlat : undefined;
  const pkgSubtitle = [`${ENGINE[uploaded?.engine ?? "mf6"]} package · ${uploaded?.model ?? active.replace(/\.zip$/, "")}`,
    geo?.epsg ? `EPSG:${geo.epsg}` : geo && (geo.xorigin || geo.yorigin) ? "placed, no coordinate reference" : null,
    ll ? `${Math.abs(ll[1]).toFixed(3)}°${ll[1] < 0 ? "S" : "N"} ${Math.abs(ll[0]).toFixed(3)}°${ll[0] < 0 ? "W" : "E"}` : null].filter(Boolean).join(" · ");
  const bmTool: Tool = btool === "select" ? "select" : ["grid", "props", "chd", "flux"].includes(btool) ? (bopts.fill ? "zones" : "paint")
    : btool === "wel" || btool === "obs" ? "bores" : btool === "riv" || btool === "drn" ? "drains" : btool === "section" ? "section" : "select";
  const blines = useMemo(() => (build ? build.doc.boundaries.filter((f) => f.type === "riv" || f.type === "drn").map((f) => ({
    name: f.id, cells: f.cells.map((c) => [c[1], c[2]] as [number, number]), color: f.type === "riv" ? "#1f5fa8" : REDLINE,
    label: f.label && f.label !== f.pkg ? `${f.id} · ${f.label}` : f.id, removable: btool === f.type })).concat(
    (build.doc.display ?? []).filter((x) => ["sfr", "riv", "str", "drn"].includes(x.type)).map((x) => ({
      name: `${x.type.toUpperCase()} ${x.name}`, cells: x.cells.map((c) => [c[1], c[2]] as [number, number]), color: "#7b93b0", label: `${x.type.toUpperCase()} (as uploaded)`, removable: false })))
    : []), [build, btool]);
  const bmarks = useMemo(() => {
    const m: { cells: { row: number; col: number }[]; color: string }[] = [];
    if (!build) return m;
    const heads = build.doc.boundaries.filter((f) => f.type === "chd").flatMap((f) => f.cells.filter((c) => c[0] === blayer || btool !== "chd").map((c) => ({ row: c[1], col: c[2] })));
    if (heads.length) m.push({ cells: heads, color: "#5b3a8c" });
    const ghb = build.doc.boundaries.filter((f) => f.type === "ghb").flatMap((f) => f.cells.filter((c) => c[0] === blayer || btool !== "chd").map((c) => ({ row: c[1], col: c[2] })));
    if (ghb.length) m.push({ cells: ghb, color: "#2f7d6d" });
    const kept = (build.doc.display ?? []).filter((x) => !["sfr", "riv", "str", "drn"].includes(x.type)).flatMap((x) => x.cells.map((c) => ({ row: c[1], col: c[2] })));
    if (kept.length) m.push({ cells: kept, color: "#8a6d3b" });
    const sel = build.doc.boundaries.find((f) => f.id === bsel);
    if (sel) m.push({ cells: sel.cells.map((c) => ({ row: c[1], col: c[2] })), color: ZONE_INK });
    if (bcell && detail === "cell") m.push({ cells: [bcell], color: "#111111" });
    return m;
  }, [build, blayer, btool, bsel, bcell, detail]);
  const zoneReaches = zoneSel && info ? info.reaches.filter((r) => r.cells.some((c) => zoneSel.cells.some(([zr, zc]) => zr === c.row && zc === c.col))).map((r) => r.id) : [];
  const selBore = info?.bores.find((x) => x.bore_id === bore);
  const wide = size.w > 760;
  const RIGHT = Math.min(Math.max(320, size.w - 340), insetPanel.width ?? (size.w > 1000 ? RIGHT_MAX : 392));  // leave the model room
  const ex2 = wide ? Math.min(insetExtra, Math.max(0, size.h - 520)) : 0;  // a remembered height never pushes past a smaller window
  const layerNames = active === "district" ? ["Upper aquifer", "Lower aquifer"] : Array.from({ length: scene?.grid.nlay ?? 1 }, (_, i) => `Layer ${i + 1}`);
  const baseLU = info?.land_use ?? null;
  const cmp: Compare = compare ?? {
    path: doc.file ? `workspace/scenarios/${doc.file}` : "Untitled scenario (not saved)",
    fromLabel: doc.version ? `v${doc.version}` : doc.file ? "Saved" : "Baseline", toLabel: "Working copy", from: doc.saved, to: scenario,
  };
  const showChanges = sheet === 0 && active === "district" && secOpen && detail === "changes";
  const sd = useMemo(() => (baseLU ? sceneDiff(cmp.from, cmp.to, baseLU) : null), [baseLU, cmp.from, cmp.to]);
  const diff = showChanges && sd && !emptyDiff(sd) ? sd : null;
  const shown = diff ? cmp.to : scenario;
  const landUse = useMemo(() => (baseLU ? landUseFor(baseLU, shown) : null), [baseLU, shown]);
  const panelW = wide ? RIGHT - 3 : Math.max(300, size.w - 28); // insets become full-width blocks on narrow screens

  return (
    <div className={`sheet ${agentHidden ? "agent-hidden" : ""} ${dragging ? "resizing" : ""}`}
      style={!agentHidden && agentPanel.width ? { ["--agent-w" as string]: `${agentPanel.width}px` } : undefined}>
      <div className="frame">
        <div className="frame-body">
          {sheet === 0 && home && (
            <Home me={me} runs={runs} scenarios={scenarios} models={models}
              onBaseline={() => { setHome(false); if (doc.file || unsaved || !res || active !== "district") newDoc(); }}
              onScenario={(n) => { setHome(false); if (doc.file === n && !unsaved && res && active === "district") return; void loadScenario(n); }}
              onRun={(r) => { setHome(false); loadRun(r); }}
              onModel={(n) => { setHome(false); void runUploaded(n); }}
              onUpload={async (f) => { await upload("models", f); setHome(false); void runUploaded(f.name); }}
              onStudy={(id) => { setStudy(id); setSheet(RECORD); }}
              onNewStudy={() => { setSheet(RECORD); setDraftRequest((n) => n + 1); }}
              onAgent={(text) => { if (agentHidden) toggleAgent(); setPrefill((x) => ({ n: (x?.n ?? 0) + 1, text })); }}
              onThread={(id) => { if (agentHidden) toggleAgent(); setOpenThread((x) => ({ n: (x?.n ?? 0) + 1, id })); }}
              onNewModel={async (spec) => {
                try { const r = await api.buildNew(spec); refreshFiles(); setHome(false); setBtool("props"); await runUploaded(r.package); }
                catch (e) { note((e as Error).message); }
              }} />
          )}
          {sheet === 0 && !home && (
            <>
              <Explorer me={me} onHome={() => setHome(true)} width={explorerPanel.width} userFiles={userFiles} onRefreshUserFiles={refreshUserFiles}
                onDeleteUserFile={(path) => api.deleteUserFile(path).then(refreshUserFiles).catch((e) => note(e.message))}
                onAddToChat={addToChat}
                resizer={<div className="ex-resize" role="separator" aria-orientation="vertical" aria-label="Resize the explorer" tabIndex={0}
                  title="Drag to resize · double-click to reset" {...explorerPanel.handle} />}
                collapsed={collapsed} onCollapse={() => setCollapsed((c) => !c)} scenario={scenario} setScenario={edit} nameRequest={nameRequest}
                doc={doc} unsaved={unsaved} onSave={saveDoc} onNew={newDoc} saving={saving} history={history} onHistory={loadHistory}
                onCompare={compareVersion} comparing={compare?.key ?? null} crops={info?.crops ?? []} landUse={landUse} baseLandUse={baseLU}
                reaches={info?.reaches ?? []} seepage={res?.reach_seepage_ml ?? null} hoverReach={hoverReach} setHoverReach={setHoverReach}
                active={active} onActivate={activate} models={models} scenarios={scenarios} runs={runs}
                inspect={inspect} onInspect={doInspect} onPreview={doPreview} onRunUploaded={runUploaded} busyModel={busyModel}
                onUpload={upload} onDelete={remove} onLoadScenario={loadScenario} onLoadRun={loadRun}
                uploading={uploading} fileUrl={api.fileUrl}
                buildPanel={active !== "district" && build?.doc.editable ? (
                  <BuildPanel b={build} set={bedit} onEditFile={(m) => void openFileEdit(active, m)}
                    calibration={<Calibration name={active} files={userFiles} onFilesChanged={() => { refreshUserFiles(); refreshFiles(); }}
                      onOpenModel={(n) => { refreshFiles(); void runUploaded(n); }} folderUrl={(p) => volumeUrl(me, p, true) ?? "#"} />} unsaved={bUnsaved} saving={bsaving} busy={bbusy} onSave={() => void bsave()} onServer={(ops) => void bserver(ops)}
                    onDiscard={() => { if (confirm(`Discard unsaved changes to ${active}?`)) void loadBuild(active); }}
                    selected={bsel} onSelect={(id) => {
                      setBsel(id);
                      const f = build.doc.boundaries.find((x) => x.id === id), o = build.doc.obs.find((x) => x.name === id);
                      const cells = f ? f.cells.map((c) => ({ row: c[1], col: c[2] })) : o ? [{ row: o.cell[1], col: o.cell[2] }] : [];
                      if (cells.length) frame(cells);
                    }} />
                ) : undefined} />
              <div className="work" ref={work} style={{ ["--right" as string]: `${wide ? RIGHT : 0}px` }}>
                <div className="canvas-wrap">
                  {scene ? (
                    <BlockModel model={scene} view={view} ex={ex} section={section} onSectionRow={(row) => setSection((s) => ({ ...s, row }))}
                      selectedBore={bore} onSelectBore={(id) => { setBore(id); setDetail("hydro"); setSecOpen(true); }} placing={bmode ? bmTool === "bores" : placing}
                      onPlace={bmode ? (row, col) => {
                        if (btool === "wel") { bedit(addWell(build!, row, col, bLayers(), bopts.rate, bopts.schedule)); note(`Well at row ${row + 1}, col ${col + 1}, ${bopts.rate} m³/d.`); }
                        else if (btool === "obs") { const n = build!.doc.obs.length + 1; bedit(withDoc(build!, { ...build!.doc, obs: [...build!.doc.obs, { name: `OB${n}`, cell: [blayer, row, col] }] })); }
                      } : onPlace}
                      showClouds={active === "district"} colorMode={scene.prop ? "prop" : scene.probability ? "probability" : "dtw"} northDeg={active !== "district" ? geo?.angrot ?? 0 : 0} readout={readout} inset={wide ? Math.round(RIGHT * 0.5) : 0} layerNames={layerNames} cmd={cmd}
                      tool={bmode ? bmTool : active === "district" ? tool : "select"} crop={crop} brush={bmode ? bopts.brush : brush} landUse={active === "district" ? landUse : null} baseLandUse={baseLU}
                      onPaint={bmode ? bpaint : (cells) => baseLU && edit(paint(scenario, baseLU, cells, crop))}
                      reaches={active === "district" ? info?.reaches : undefined} lined={shown.lined_reaches} hoverReach={hoverReach} onHoverReach={setHoverReach}
                      onToggleReach={(id) => edit({ ...scenario, lined_reaches: scenario.lined_reaches.includes(id) ? scenario.lined_reaches.filter((x) => x !== id) : [...scenario.lined_reaches, id] })}
                      overlay={active === "district" ? agentView?.overlay ?? null : null} highlight={active === "district" ? agentView?.cells ?? null : null}
                      diff={bmode ? null : diff} onRemoveBore={bmode ? (i) => {
                        if (btool === "wel") { const w = build!.doc.boundaries.filter((x) => x.type === "wel")[i]; if (w) { bedit(removeFeature(build!, w.id)); note(`${w.id} removed.`); } }
                        else if (btool === "obs") { const o = build!.doc.obs[i]; if (o) bedit(removeFeature(build!, o.name)); }
                      } : (i) => { edit({ ...scenario, extra_bores: scenario.extra_bores.filter((_, j) => j !== i) }); note(`P${i + 1} removed.`); }}
                      drains={bmode ? blines : active === "district" ? (diff ? cmp.to : scenario).drain_lines ?? [] : []}
                      onRemoveDrain={bmode ? (id) => { bedit(removeFeature(build!, id)); note(`${id} removed.`); } : (name) => { edit({ ...scenario, drain_lines: (scenario.drain_lines ?? []).filter((d) => d.name !== name) }); note(`${name} removed.`); }}
                      onInspect={(row, col) => { if (bmode) { setBcell({ row, col }); setDetail("cell"); setSecOpen(true); return; } if (active !== "district") return; setCell({ row, col }); setDetail("cell"); setSecOpen(true); }}
                      onDrawZone={bmode ? bfill : onDrawZone} onDrawLine={bmode ? (kind, pts) => {
                        if (kind === "section") { onDrawLine(kind, pts); return; }
                        if (btool === "riv") { bedit(addLine(build!, "riv", pts, blayer, { stage_start: bopts.stage0, stage_end: bopts.stage1, bed_depth: bopts.bed, cond: bopts.cond }, bopts.schedule)); note("River drawn."); }
                        else if (btool === "drn") { bedit(addLine(build!, "drn", pts, blayer, { elev: bopts.depth, elev_mode: "below_top", cond: bopts.cond }, bopts.schedule)); note("Drain drawn."); }
                      } : onDrawLine} marks={bmode ? bmarks : marks}
                      onPick={bmode ? (row, col) => {
                        if (btool === "props") { const v = at(build!, bopts.prop, blayer, row, col); if (v != null) { setBopts({ value: +v.toPrecision(4), mode: "set" }); note(`Picked ${v.toPrecision(4)}`); } }
                        else if (btool === "flux") { const v = at(build!, bopts.flux, 0, row, col); if (v != null) setBopts({ mm: Math.round(v), mode: "set" }); }
                      } : undefined} />
                  ) : <div className="loading"><span className="ld-line" />Loading model</div>}
                </div>

                <header className="view-head">
                  <div className="view-title">{view === "plan" ? "Plan" : "Axonometric"}{labels[period] ? ` · ${monthLabel(labels[period])}` : ""}</div>
                  {diff ? <div className="view-sub chg-cap">Changes · {cmp.fromLabel} → {cmp.toLabel}</div>
                    : dirty && active === "district" && <div className="view-sub red">Settings changed since this run</div>}
                  {ens && active === "district" && (
                    <div className="ens-sub">
                      <span className="ens-sub-t"><Icon name="spread" size={12} />Ensemble · {ens.det.summary?.label ?? ens.id} · {ens.det.summary?.n_behavioural ?? "?"} of {ens.det.summary?.n_realizations ?? "?"} kept</span>
                      <div className="seg" role="radiogroup" aria-label="Ensemble layer">
                        {([["p", "Chance < 2 m, Jun 2026"], ["p_any", "Chance < 2 m, any month"], ["p50", "P50 depth"], ["off", "This run"]] as const).map(([k, l]) => (
                          <button key={k} role="radio" aria-checked={ensLayer === k} className={ensLayer === k ? "on" : ""} disabled={k === "p_any" && !ens.det.p_any}
                            onClick={() => setEnsLayer(k)}>{l}</button>))}
                      </div>
                      <button className="link small" onClick={() => { setEns(null); if (detail === "ensemble") setDetail("section"); }}>Close</button>
                    </div>
                  )}
                  {ensPending.length > 0 && <div className="view-sub">Ensemble running on Spark: {ensPending.map((e) => `${e.label} (~${Math.max(1, Math.round((e.estimate - (Date.now() - e.started) / 1000) / 60))} min left)`).join("; ")}</div>}
                  {agentView && active === "district" && (
                    <div className="agent-sub"><Icon name="follow" size={12} />Following the agent · {agentView.label}
                      <button onClick={() => { setAgentView(null); setHoverReach(null); }} aria-label="Clear the agent's view">Clear</button></div>
                  )}
                  <div className="view-tools">
                    <div className="seg" role="group" aria-label="View">
                      <button className={view === "plan" ? "on" : ""} onClick={() => setView("plan")}><Icon name="plan" size={14} />Plan</button>
                      <button className={view === "axo" ? "on" : ""} onClick={() => setView("axo")}><Icon name="cube" size={14} />Axonometric</button>
                    </div>
                    <label className={`ve ${view === "plan" ? "dim" : ""}`}>
                      <span>Vertical exaggeration</span>
                      <input type="range" min={5} max={80} step={1} value={ex} onChange={(e) => { setEx(+e.target.value); if (view === "plan") setView("axo"); }} />
                      <b className="num">{ex}×</b>
                    </label>
                    <button className={`tool ${section.on ? "on" : ""}`} onClick={() => setSection((s) => ({ ...s, on: !s.on }))} aria-pressed={section.on}>
                      <Icon name="cut" size={14} />Cut at A–A′
                    </button>
                  </div>
                  {active !== "district" && build?.doc.editable && (
                    <BuildTools tool={btool} setTool={setBtool} o={bopts} set={setBopts} layer={blayer} setLayer={setBlayer} nlay={build.doc.grid.nlay}
                      schedules={Object.keys(build.doc.schedules)} canUndo={bh.current.past.length > 0} canRedo={bh.current.future.length > 0} onUndo={bundo} onRedo={bredo}
                      onEdge={bedge} transient={build.doc.time.periods.some((x) => !x.steady)} />
                  )}
                  {active !== "district" && build && !build.doc.editable && (
                    <div className="view-sub pkg-note">{build.doc.why_not}
                      {build.doc.convertible && <button className="btn small" disabled={converting} onClick={async () => {
                        setConverting(true);
                        try { const r = await api.convertModel(active); refreshFiles(); note(`Converted to MODFLOW 6 as ${r.package}; the original is unchanged.`); await runUploaded(r.package); }
                        catch (e) { note((e as Error).message); }
                        setConverting(false);
                      }}>{converting ? "Converting…" : "Convert a copy to MODFLOW 6"}</button>}</div>
                  )}
                  {active !== "district" && ll && (
                    <div className="view-sub"><a className="link small" href={`https://www.openstreetmap.org/?mlat=${ll[1].toFixed(5)}&mlon=${ll[0].toFixed(5)}#map=12/${ll[1].toFixed(5)}/${ll[0].toFixed(5)}`}
                      target="_blank" rel="noreferrer"><Icon name="map" size={11} /> Where it is: {Math.abs(ll[1]).toFixed(3)}°{ll[1] < 0 ? "S" : "N"}, {Math.abs(ll[0]).toFixed(3)}°{ll[0] < 0 ? "W" : "E"}</a></div>
                  )}
                  {active !== "district" && uploaded?.name === active && (uploaded.raster || (uploaded.display && uploaded.display.coarsen > 1)) && (
                    <div className="view-sub">{uploaded.raster ? `${uploaded.raster.from} grid of ${uploaded.raster.cells.toLocaleString("en-AU")} cells, drawn on a ${uploaded.raster.raster[0]} × ${uploaded.raster.raster[1]} raster. ` : ""}
                      {uploaded.display && uploaded.display.coarsen > 1 ? `Drawn at 1/${uploaded.display.coarsen} resolution (${uploaded.display.native_cells.toLocaleString("en-AU")} cells a layer); the model runs at full resolution. ` : ""}
                      {uploaded.display && uploaded.display.times_shown < uploaded.display.times_total ? `${uploaded.display.times_shown} of ${uploaded.display.times_total} output times shown.` : ""}</div>
                  )}
                  {active === "district" && info && (
                    <Tools tool={tool} setTool={setTool} crop={crop} setCrop={setCrop} brush={brush} setBrush={setBrush} crops={info.crops}
                      canUndo={hist.current.past.length > 0} canRedo={hist.current.future.length > 0} onUndo={undo} onRedo={redo}>
                      {tool === "select" && <span className="tool-hint">Click a cell to inspect it · click a monitoring bore for its hydrograph</span>}
                      {tool === "drains" && (
                        <>
                          <div className="seg quiet" role="radiogroup" aria-label="Drain depth">
                            {[1.5, 2, 2.5, 3].map((d) => <button key={d} role="radio" aria-checked={drainDepth === d} className={drainDepth === d ? "on" : ""} onClick={() => setDrainDepth(d)}>{d} m</button>)}
                          </div>
                          <span className="tool-hint">Click along the drain, double-click or ↵ to finish · click a drain to remove it</span>
                        </>
                      )}
                      {tool === "zones" && (
                        <>
                          {zones.length > 0 && (
                            <div className="zone-chips" role="list" aria-label="Saved zones">
                              {zones.slice(0, 8).map((z) => <button key={z.name} role="listitem" className={zoneSel?.name === z.name ? "on" : ""}
                                onClick={() => { openZone({ name: z.name, cells: z.cells }); frame(z.cells.map(([row, col]) => ({ row, col }))); }} title={`${z.hectares} ha${z.note ? ` · ${z.note}` : ""}`}>{z.name}</button>)}
                            </div>
                          )}
                          <span className="tool-hint">Drag a rectangle, or click corners and double-click to close</span>
                        </>
                      )}
                      {tool === "section" && <span className="tool-hint">Click two or more points, double-click or ↵ to finish</span>}
                    </Tools>
                  )}
                </header>

                <div className="map-tools">
                  {bmode && bColor && build ? <PropLegend b={build} prop={bColor} layer={blayer} /> : <Legend readout={readout} probability={!!scene?.probability} layerNames={layerNames} />}
                  <div className="cam-tools" role="group" aria-label="Camera">
                    <div className="cg">
                      <button onClick={() => camCmd({ kind: "zoom", f: 1.25 })} aria-label="Zoom in" title="Zoom in (+)"><Icon name="plus" size={14} /></button>
                      <button onClick={() => camCmd({ kind: "zoom", f: 0.8 })} aria-label="Zoom out" title="Zoom out (−)"><Icon name="minus" size={14} /></button>
                      <button onClick={() => camCmd({ kind: "reset" })} aria-label="Reset view" title="Reset view (0)"><Icon name="home" size={14} /></button>
                    </div>
                    <div className="cg">
                      <button onClick={() => camCmd({ kind: "rotate", deg: -45 })} aria-label="Turn left" title="Turn 45° left (Q)"><Icon name="rotL" size={14} /></button>
                      <button onClick={() => camCmd({ kind: "rotate", deg: 45 })} aria-label="Turn right" title="Turn 45° right (E)"><Icon name="rotR" size={14} /></button>
                      <button className={keysOpen ? "on" : ""} onClick={() => setKeysOpen((o) => !o)} aria-expanded={keysOpen} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"><Icon name="keys" size={14} /></button>
                    </div>
                    {keysOpen && (
                      <div className="keys-card" role="dialog" aria-label="Keyboard shortcuts">
                        <div className="kc-h">Keyboard<button className="icon-btn" onClick={() => setKeysOpen(false)} aria-label="Close"><Icon name="x" size={12} /></button></div>
                        <dl>{KEYS.map(([ks, what]) => <div key={what}><dt>{ks.map((x) => <kbd key={x}>{x}</kbd>)}</dt><dd>{what}</dd></div>)}</dl>
                        <p>Mouse: drag to orbit, right-drag to pan, scroll to zoom.</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="right-col" style={{ width: wide ? RIGHT : undefined }}>
                  <section className={`inset ${secOpen ? "" : "shut"}`} style={{ ["--inset-extra" as string]: `${ex2}px` }}>
                    {wide && <div className="inset-rw" role="separator" aria-orientation="vertical" aria-label="Resize the detail panel's width" tabIndex={0}
                      title="Drag to resize · double-click to reset" {...insetPanel.handle} />}
                    {wide && secOpen && <div className="inset-rh" role="separator" aria-orientation="horizontal" aria-label="Resize the detail panel's height"
                      title="Drag to resize · double-click to reset" onPointerDown={insetDrag}
                      onDoubleClick={() => { setInsetExtra(0); try { localStorage.removeItem("gs.inset.h"); } catch { /* private window */ } }} />}
                    <header className="inset-head">
                      <button className="inset-toggle" onClick={() => setSecOpen((o) => !o)} aria-expanded={secOpen} aria-label={secOpen ? "Collapse details" : "Expand details"}><Icon name="chevron" size={12} /></button>
                      <div className="tabs" role="tablist">
                        <button role="tab" aria-selected={detail === "section"} onClick={() => { setDetail("section"); setSecOpen(true); }}>Section</button>
                        <button role="tab" aria-selected={detail === "hydro"} onClick={() => { setDetail("hydro"); setSecOpen(true); }}>Hydrograph</button>
                        <button role="tab" aria-selected={detail === "budget"} onClick={() => { setDetail("budget"); setSecOpen(true); }}>Budget</button>
                        {ens && active === "district" && <button role="tab" aria-selected={detail === "ensemble"} onClick={() => { setDetail("ensemble"); setSecOpen(true); }}>Ensemble</button>}
                        {bmode && bcell && <button role="tab" aria-selected={detail === "cell"} onClick={() => { setDetail("cell"); setSecOpen(true); }}>Cell</button>}
                        {bmode && <button role="tab" aria-selected={detail === "changes"} onClick={() => { setDetail("changes"); setSecOpen(true); }}>Changes{bUnsaved && <span className="tab-dot" aria-label="unsaved" />}</button>}
                        {cell && active === "district" && <button role="tab" aria-selected={detail === "cell"} onClick={() => { setDetail("cell"); setSecOpen(true); }}>Cell</button>}
                        {zoneSel && active === "district" && <button role="tab" aria-selected={detail === "zone"} onClick={() => { setDetail("zone"); setSecOpen(true); }}>Zone</button>}
                        {active === "district" && <button role="tab" aria-selected={detail === "changes"} onClick={() => { setDetail("changes"); setSecOpen(true); }}>Changes{unsaved && <span className="tab-dot" aria-label="unsaved" />}</button>}
                        {fileEdit && !preview && <button role="tab" aria-selected={detail === "file"} onClick={() => { setDetail("file"); setSecOpen(true); }}>{fileEdit.member.split("/").pop()}</button>}
                        {preview && <button role="tab" aria-selected={detail === "file"} onClick={() => { setDetail("file"); setSecOpen(true); }}>{preview.member.split("/").pop()}</button>}
                      </div>
                      {detail === "section" && section.line?.length ? (
                        <div className="stepper" role="group" aria-label="Section line">
                          <span className="stepper-l">Line · {secKm.toFixed(1)} km</span>
                          <button onClick={() => setSection((s) => ({ ...s, line: null }))} title="Back to a section along a row" aria-label="Section along a row"><Icon name="x" size={12} /></button>
                        </div>
                      ) : detail === "section" && (
                        <div className="stepper" role="group" aria-label="Move section">
                          <span className="stepper-l">Row {section.row + 1}</span>
                          <button onClick={() => setSection((s) => ({ ...s, row: Math.max(1, s.row - 1) }))} aria-label="Move section north" title="Move north"><Icon name="caretUp" size={12} /></button>
                          <button onClick={() => setSection((s) => ({ ...s, row: Math.min((scene?.grid.nrow ?? 40) - 2, s.row + 1) }))} aria-label="Move section south" title="Move south"><Icon name="caretDown" size={12} /></button>
                        </div>
                      )}
                    </header>
                    {secOpen && detail === "section" && scene && (
                      <div className="det">
                        <Section grid={scene.grid} path={secPath} wt={scene.wt} baseWt={scene.baseWt ?? null} bores={scene.bores} width={panelW} height={236 + ex2}
                          label={labels[period] ? monthLabel(labels[period]) : ""} layerNames={layerNames} drains={active === "district" ? scenario.drain_lines : undefined} />
                      </div>
                    )}
                    {secOpen && detail === "hydro" && (active === "district" && res && bore && res.hydrographs[bore] ? (
                      <div className="det">
                        <div className="det-sub">{bore} · {selBore?.layer === 0 ? "shallow, Upper aquifer" : "deep, Lower aquifer"} · fit {fmt(res.bore_rmse[bore], 2)} m RMSE
                          <select value={bore} onChange={(e) => setBore(e.target.value)} aria-label="Monitoring bore">
                            {info?.bores.filter((x) => x.bore_type === "monitoring").map((x) => <option key={x.bore_id} value={x.bore_id}>{x.bore_id}</option>)}
                          </select></div>
                        <Hydrograph labels={info!.periods} sim={res.hydrographs[bore].sim} base={res.baseline_hydrographs[bore]} obs={res.observed[bore] ?? { t: [], h: [] }}
                          landSurface={selBore ? (info!.top[selBore.row][selBore.col] as number) : null} width={panelW} height={222 + ex2}
                          band={ens ? ens.det.bores?.[bore] ?? null : null} />
                      </div>
                    ) : <div className="det empty">{active === "district" ? "Select a monitoring bore on the model." : "No observation bores in this package."}</div>)}
                    {secOpen && detail === "budget" && (active === "district" && res ? <Budget res={res} /> : uploaded?.budget_last ? <UploadedBudget u={uploaded} /> : null)}
                    {secOpen && detail === "changes" && active === "district" && sd && (
                      <Changes key={compare?.key ?? "wc"} c={cmp} scene={sd} onRestore={restore} height={(size.h > 820 ? 300 : 220) + ex2} />
                    )}
                    {secOpen && detail === "cell" && bmode && bcell && (
                      <BuildCell b={build!} cell={bcell} onClose={() => { setBcell(null); setDetail("section"); }}
                        heads={null} />
                    )}
                    {secOpen && detail === "changes" && bmode && <BuildChanges files={bdiff.files} loading={bdiff.loading} error={bdiff.error} height={(size.h > 820 ? 300 : 220) + ex2} />}
                    {secOpen && detail === "cell" && cell && active === "district" && (
                      <CellPanel cell={cell} probe={cellProbe} period={period} labels={info?.periods ?? []} width={panelW} height={236 + ex2}
                        onClose={() => { setCell(null); setDetail("section"); }} />
                    )}
                    {secOpen && detail === "zone" && zoneSel && active === "district" && (
                      <ZonePanel key={zoneSel.name ?? "draft"} title={zoneSel.name ?? "New zone"} stats={zoneStats} labels={info?.periods ?? []} width={panelW} height={236 + ex2}
                        saved={!!zoneSel.name} onSave={saveZone} onDelete={deleteZone} crops={info?.crops ?? []} reaches={zoneReaches}
                        onPaint={(c) => { if (!baseLU) return; edit(paint(scenario, baseLU, zoneSel.cells.map(([row, col]) => ({ row, col })), c)); note(`Painted ${Math.round(zoneSel.cells.length * 6.25).toLocaleString("en-AU")} ha of ${zoneSel.name ?? "the zone"}. Run the model to see the effect.`); }}
                        onLine={() => { edit({ ...scenario, lined_reaches: [...new Set([...scenario.lined_reaches, ...zoneReaches])] }); note(`Lined ${zoneReaches.join(", ")}.`); }}
                        onClose={() => { setZoneSel(null); setDetail("section"); }} />
                    )}
                    {secOpen && detail === "ensemble" && ens && (
                      <div className="det">
                        <div className="det-sub">Share of the district within 2 m, every month</div>
                        <MonthlyBand det={ens.det} single={(res as unknown as { area_lt2?: number[] })?.area_lt2 ?? null} labels={info?.periods ?? []} width={panelW} height={150 + ex2 / 2} />
                        <div className="det-sub">Fit against conductivity, one dot per realization</div>
                        <FitScatter det={ens.det} thr={ens.det.summary?.rmse_threshold_m ?? 0.25} width={panelW} height={150 + ex2 / 2} />
                      </div>
                    )}
                    {secOpen && detail === "file" && fileEdit && (
                      <div className="det file edit">
                        <div className="det-sub"><span>{fileEdit.model} / {fileEdit.member}{fileEdit.text !== fileEdit.orig && <span className="red"> · edited</span>}</span>
                          <span className="probe-acts"><button className="link small" onClick={() => setFileEdit(null)}>Cancel</button>
                            <button className="btn small ink" disabled={fileEdit.saving || fileEdit.text === fileEdit.orig} onClick={() => void saveFileEdit()}>{fileEdit.saving ? "Saving…" : "Save and solve"}</button></span></div>
                        <textarea className="file-ed" spellCheck={false} value={fileEdit.text} onChange={(e) => setFileEdit({ ...fileEdit, text: e.target.value })} style={{ height: 230 + ex2 }}
                          aria-label={`Edit ${fileEdit.member}`} />
                      </div>
                    )}
                    {secOpen && detail === "file" && !fileEdit && preview && (
                      <div className="det file"><div className="det-sub"><span>{preview.model} / {preview.member}</span><span className="probe-acts">
                        <button className="link small" onClick={() => void openFileEdit(preview.model, preview.member)}>Edit</button>
                        <a href={api.fileUrl("models", preview.model)}>Download package</a></span></div><pre>{preview.text}</pre></div>
                    )}
                  </section>

                  {ensPanel && active === "district" && (
                    <EnsemblePanel scenarioText={doc.file ? `${doc.name}${unsaved ? " (unsaved edits)" : ""}` : describe(scenario)} busy={ensBusy}
                      perRunS={res?.fidelity?.estimate_s ?? 0.7} onClose={() => setEnsPanel(false)} onRun={launchEnsemble} />
                  )}
                  <TitleBlock
                    title={ens && es ? `Ensemble · ${es.label ?? ens.id}` : active === "district" ? (res?.run_id && status ? runLabel || describe(res.scenario) : res ? describe(res.scenario) : "Sample district model") : active.replace(/\.zip$/, "")}
                    subtitle={active === "district" ? `Sample district · synthetic data · ${res ? fidelityText(fidelity(res.scenario)) : "250 m"}` : pkgSubtitle}
                    progress={progress ? `${/baseline/.test(progress.stage) ? "Baseline" : "Solving"} ${progress.total > 1 ? `${progress.done}/${progress.total} steps` : progress.stage.replace("baseline ", "")} · ${Math.round(progress.elapsed_s ?? 0)} s of ~${Math.round(progress.estimate_s)} s` : undefined}
                    progressFrac={progress && progress.total > 1 ? progress.done / progress.total : undefined}
                    figures={figures} onEnsemble={active === "district" ? () => setEnsPanel((v) => !v) : undefined} ensembleOpen={!!ens}
                    drawn={me ? me.email.split("@")[0].replace(".", " ") : "…"}
                    checked={active === "district" && k ? `${fmt(k.rmse_m, 2)} m · ${k.n_obs} obs` : "not checked"}
                    engine={active !== "district" && uploaded?.engine && uploaded.engine !== "mf6" ? `${ENGINE[uploaded.engine]} · ${me?.platform.replace("linux-", "") ?? ""}`
                      : me?.mf6_version ? `${me.mf6_version.replace("mf6: ", "MF6 ")} · ${me.platform.replace("linux-", "")}` : "…"}
                    runId={status && res ? res.run_id : shownRun && !dirty ? shownRun : null} date={new Date().toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" })}
                    rev={revLetter} status={status} persisted={!!status}
                    busy={busy} onIssue={active === "district" ? issue : bmode ? () => void bsave(true) : undefined} issueLabel={bmode ? (bUnsaved ? "Save and run" : "Run again") : dirty ? "Run and file" : "Run again"} dirty={bmode ? bUnsaved : dirty && active === "district"} nextRev={nextRev}
                    revisions={nClouds} onAck={res ? () => setAck(res.run_id) : undefined} runLabel={runLabel} onRunLabel={active === "district" ? setRunLabel : undefined} />
                </div>

                <div className="cue-wrap" style={{ right: wide ? RIGHT + 24 : undefined }}>
                  {labels.length > 1 && <CueStrip labels={labels} value={Math.min(period, labels.length - 1)} onChange={setPeriod} phases={active === "district"} />}
                </div>
              </div>
            </>
          )}
          {sheet === RECORD && <StudiesSheet onOpenEnsemble={(id) => void openEnsemble(id)} draftRequest={draftRequest} runs={runs} open={study} onOpen={setStudy} onLoadRun={(r) => { loadRun(r); setSheet(0); }}
            register={<RegisterSheet runs={runs} me={me} onLoadRun={(r) => { loadRun(r); setSheet(0); }} onRefresh={refreshFiles} onOpenStudy={setStudy} />}
            ensembles={<EnsemblesTable me={me} onOpen={(id) => void openEnsemble(id)} onOpenStudy={setStudy} />} />}
          {sheet === ABOUT && <NotesSheet me={me} />}
        </div>
      </div>
      <Agent inbox={inbox} prefill={prefill} openThread={openThread} onFilesChanged={refreshUserFiles} resizer={<div className="ag-resize" role="separator" aria-orientation="vertical" aria-label="Resize the agent panel" tabIndex={0}
          title="Drag to resize · double-click to reset" {...agentPanel.handle} />}
        collapsed={agentHidden} onToggle={toggleAgent} study={sheet === RECORD && study !== ALL_RUNS && study !== ALL_ENSEMBLES ? study : null} onFiled={refreshFiles}
        context={agentContext} follow={follow} setFollow={setFollow} shownRun={shownRun} onRunFiled={(id) => follow && openAgentRun(id, true)} onActivity={onActivity}
        links={{
          onOpenRun: (id) => openAgentRun(id, false),
          onOpenStudy: (id) => { setStudy(id); setSheet(RECORD); },
          onOpenScenario: (name) => { setSheet(0); loadScenario(name.endsWith(".json") ? name : `${name}.json`); },
          folderUrl: (path) => volumeUrl(me, path, true),
          onOpenEnsemble: (id) => void openEnsemble(id),
          onOpenModel: (name) => { setSheet(0); if (name === "district") setActive("district"); else void runUploaded(name.endsWith(".zip") ? name : `${name}.zip`); },
        }} />
      <nav className="sheet-tabs" aria-label="Sheets">
        {SHEETS.map((s, i) => (
          <button key={s} className={sheet === i ? "on" : ""} onClick={() => setSheet(i)} aria-current={sheet === i ? "page" : undefined}><Icon name={SHEET_ICONS[i]} size={15} />{s}</button>
        ))}
        <button className={`about ${sheet === ABOUT ? "on" : ""}`} onClick={() => setSheet(ABOUT)} aria-current={sheet === ABOUT ? "page" : undefined}
          title="Where the data comes from, who it is read as, and how runs are filed"><Icon name="info" size={15} />About the data</button>
      </nav>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

/** Exaggeration that makes the model's thickness about a fifth of its plan extent. */
function autoEx(g: { nrow: number; ncol: number; delr_km: number; delc_km: number; top: (number | null)[][]; botm: (number | null)[][][] }) {
  const t = g.top.flat().filter((v): v is number => v != null), b = g.botm[g.botm.length - 1].flat().filter((v): v is number => v != null);
  const thick = Math.max(...t) - Math.min(...b), span = Math.max(g.ncol * g.delr_km, g.nrow * g.delc_km) * 1000;
  return Math.max(2, Math.min(80, Math.round((0.2 * span) / Math.max(1, thick))));
}

function median(a: (number | null)[][]) {
  const v = a.flat().filter((x): x is number => x != null).sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

function Budget({ res }: { res: RunResult }) {
  const t: Record<string, { in: number; out: number }> = {};
  res.budget.forEach((b) => { t[b.component] ??= { in: 0, out: 0 }; t[b.component][b.direction] += b.volume_ml; });
  const rows = Object.entries(t).filter(([, v]) => v.in + v.out > 1).sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out));
  return (
    <div className="det">
      <div className="det-sub">Schedule of flows, 24 months, GL</div>
      <table className="schedule"><thead><tr><th>Component</th><th className="n">In</th><th className="n">Out</th><th className="n">Net</th></tr></thead>
        <tbody>{rows.map(([c, v]) => <tr key={c}><td>{c}</td><td className="n">{fmt(v.in / 1000)}</td><td className="n">{fmt(v.out / 1000)}</td><td className="n">{fmt((v.in - v.out) / 1000)}</td></tr>)}</tbody>
        <tfoot><tr><td>Mass balance error</td><td className="n" colSpan={3}>{fmt(res.kpis.max_discrepancy_pct, 2)}% worst period</td></tr></tfoot></table>
    </div>
  );
}
function UploadedBudget({ u }: { u: UploadedRun }) {
  return (
    <div className="det">
      <div className="det-sub">Flow rates, last stress period, {u.time_units === "days" ? "m³/d" : "model units"}</div>
      <table className="schedule"><thead><tr><th>Term</th><th className="n">In</th><th className="n">Out</th></tr></thead>
        <tbody>{[...new Set(u.budget_last!.map((b) => b.term))].map((t) => {
          const i = u.budget_last!.find((b) => b.term === t && b.direction === "in")?.rate ?? 0, o = u.budget_last!.find((b) => b.term === t && b.direction === "out")?.rate ?? 0;
          return <tr key={t}><td>{t}</td><td className="n">{fmt(i, 0)}</td><td className="n">{fmt(o, 0)}</td></tr>;
        })}</tbody></table>
    </div>
  );
}

/** The legend while a property is painted: its range on the earth ramp (log scale for conductivities). */
function PropLegend({ b, prop, layer }: { b: Build; prop: string; layer: number }) {
  const meta = PROPS.find((x) => x.key === prop), r = prop === "idomain" ? null : propRange(b, prop, layer);
  const grad = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((v) => rampCss(EARTH_STOPS, v)).join(", ")})`;
  const f = (v: number) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0) ? v.toExponential(1) : +v.toPrecision(3));
  return (
    <div className="legend prop-legend">
      <div className="lg-h">{prop === "idomain" ? "Active cells" : meta?.label ?? prop}{meta?.layered !== false ? ` · L${layer + 1}` : ""}</div>
      {prop === "idomain" ? <div className="pl-row"><i style={{ background: rampCss(EARTH_STOPS, 0.55) }} />in the model<i style={{ background: rampCss(EARTH_STOPS, 0.02) }} />out</div> : (
        <><div className="pl-bar" style={{ background: grad }} /><div className="pl-ticks"><span>{r ? f(r[0]) : "–"}</span><span>{meta?.log ? "log scale" : ""}</span><span>{r ? f(r[1]) : "–"} {meta?.unit}</span></div></>
      )}
    </div>
  );
}
