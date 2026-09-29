import { PROPS, type Mode } from "../lib/build";
import { Icon } from "./Icon";

export type BTool = "select" | "grid" | "props" | "chd" | "wel" | "riv" | "drn" | "flux" | "obs" | "section";
export type BOpts = {
  prop: string; mode: Mode; value: number; brush: number; fill: boolean; active: boolean;
  head: number; headMode: "abs" | "below_top"; headKind: "chd" | "ghb"; allLayers: boolean; rate: number; schedule: string | null;
  stage0: number; stage1: number; bed: number; cond: number; depth: number; flux: "rch" | "evt"; mm: number;
};
export const BTOOLS: { id: BTool; label: string; icon: string; key: string; tip: string; group: 0 | 1 | 2 }[] = [
  { id: "select", label: "Select", icon: "cursor", key: "V", tip: "Inspect a cell: every property per layer and what is on it", group: 0 },
  { id: "grid", label: "Grid", icon: "plan", key: "G", tip: "Paint cells in or out of the model; rows, columns and layers are in the explorer", group: 0 },
  { id: "props", label: "Properties", icon: "brush", key: "K", tip: "Paint K, Sy, Ss, starting heads, top and bottoms", group: 0 },
  { id: "chd", label: "Heads", icon: "head", key: "H", tip: "Fixed heads (CHD) or general heads (GHB): paint cells or pick an edge", group: 1 },
  { id: "wel", label: "Wells", icon: "pin", key: "B", tip: "Place wells (WEL); click one to remove it", group: 1 },
  { id: "riv", label: "Rivers", icon: "channel", key: "C", tip: "Draw a river (RIV) with a sloping stage", group: 1 },
  { id: "drn", label: "Drains", icon: "drain", key: "R", tip: "Draw a drain (DRN) at a depth", group: 1 },
  { id: "flux", label: "Recharge & ET", icon: "spread", key: "F", tip: "Paint recharge or ET in mm/yr", group: 1 },
  { id: "obs", label: "Observe", icon: "probe", key: "O", tip: "Observation points: a simulated hydrograph wherever you want one", group: 1 },
  { id: "section", label: "Section", icon: "section", key: "X", tip: "Draw a cross-section along any line", group: 2 },
];
export const BTOOL_KEYS: Record<string, BTool> = Object.fromEntries(BTOOLS.map((t) => [t.key.toLowerCase(), t.id]));

const Num = ({ label, value, onChange, step = 1, unit, w = 64 }: { label: string; value: number; onChange: (v: number) => void; step?: number; unit?: string; w?: number }) => (
  <label className="bt-num"><span>{label}</span><input type="number" step={step} value={value} style={{ width: w }} onChange={(e) => onChange(+e.target.value)} />{unit && <em>{unit}</em>}</label>
);

/** The Build palette: structure, boundaries, analysis; the active tool's options on the row below. */
export default function BuildTools({ tool, setTool, o, set, layer, setLayer, nlay, schedules, canUndo, canRedo, onUndo, onRedo, onEdge, transient }: {
  tool: BTool; setTool: (t: BTool) => void; o: BOpts; set: (x: Partial<BOpts>) => void; layer: number; setLayer: (l: number) => void; nlay: number;
  schedules: string[]; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; onEdge: (e: "west" | "east" | "north" | "south") => void; transient: boolean;
}) {
  const prop = PROPS.find((p) => p.key === o.prop) ?? PROPS[0];
  const brush = (
    <div className="seg quiet" role="radiogroup" aria-label="Brush">
      {[1, 3, 5, 9].map((n) => <button key={n} role="radio" aria-checked={!o.fill && o.brush === n} className={!o.fill && o.brush === n ? "on" : ""} onClick={() => set({ brush: n, fill: false })} title={`${n}×${n} cells ([ and ])`}><span className="bsz" style={{ width: 3 + Math.min(n, 5) * 2, height: 3 + Math.min(n, 5) * 2 }} /></button>)}
      <button role="radio" aria-checked={o.fill} className={o.fill ? "on" : ""} onClick={() => set({ fill: true })} title="Fill a shape: drag a rectangle, or click corners and double-click"><Icon name="zone" size={13} /></button>
    </div>
  );
  const sched = (
    <label className="bt-num"><span>Schedule</span>
      <select value={o.schedule ?? ""} onChange={(e) => set({ schedule: e.target.value || null })} disabled={!transient} title={transient ? "" : "Steady-state: switch Time to through time to use schedules"}>
        <option value="">Constant</option>{schedules.map((s) => <option key={s} value={s}>{s}</option>)}
      </select></label>
  );
  const layers = (
    <div className="seg quiet" role="radiogroup" aria-label="Layers">
      <button role="radio" aria-checked={!o.allLayers} className={!o.allLayers ? "on" : ""} onClick={() => set({ allLayers: false })}>L{layer + 1}</button>
      <button role="radio" aria-checked={o.allLayers} className={o.allLayers ? "on" : ""} onClick={() => set({ allLayers: true })}>All layers</button>
    </div>
  );
  return (
    <div className="tools" role="toolbar" aria-label="Build tools">
      {[0, 1, 2].map((grp) => (
        <div key={grp} className="seg" role="radiogroup" aria-label={["Structure", "Boundaries", "Analysis"][grp]}>
          {BTOOLS.filter((t) => t.group === grp).map((t) => (
            <button key={t.id} role="radio" aria-checked={tool === t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)} title={`${t.tip} (${t.key})`}>
              <Icon name={t.icon} size={14} />{t.label}
            </button>
          ))}
        </div>
      ))}
      <div className="seg quiet" role="group" aria-label="History">
        <button onClick={onUndo} disabled={!canUndo} aria-label="Undo" title="Undo (⌘Z)"><Icon name="undo" size={14} /></button>
        <button onClick={onRedo} disabled={!canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><Icon name="redo" size={14} /></button>
      </div>
      <label className="bt-num bt-layer"><span>Layer</span>
        <select value={layer} onChange={(e) => setLayer(+e.target.value)} aria-label="Layer shown and edited">
          {Array.from({ length: nlay }, (_, L) => <option key={L} value={L}>L{L + 1}</option>)}
        </select></label>

      <div className="tool-opts" role="group" aria-label="Tool options">
        {tool === "select" && <span className="tool-hint">Click a cell for every property on every layer</span>}
        {tool === "grid" && <>
          <div className="seg quiet" role="radiogroup" aria-label="Paint cells">
            <button role="radio" aria-checked={o.active} className={o.active ? "on" : ""} onClick={() => set({ active: true })}>In the model</button>
            <button role="radio" aria-checked={!o.active} className={!o.active ? "on" : ""} onClick={() => set({ active: false })}>Out</button>
          </div>{layers}{brush}<span className="tool-hint">Shape the model's edge; rows, columns and layers are in the explorer (DIS)</span></>}
        {tool === "props" && <>
          <label className="bt-num"><span>Property</span><select value={o.prop} onChange={(e) => set({ prop: e.target.value })}>
            {PROPS.filter((p) => !["rch", "evt", "evt_depth"].includes(p.key)).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
          <div className="seg quiet" role="radiogroup" aria-label="Mode">
            {(["set", "multiply", "add"] as Mode[]).map((m) => <button key={m} role="radio" aria-checked={o.mode === m} className={o.mode === m ? "on" : ""} onClick={() => set({ mode: m })}>{m === "set" ? "Set" : m === "multiply" ? "×" : "+"}</button>)}
          </div>
          <Num label={o.mode === "set" ? "Value" : o.mode === "multiply" ? "Times" : "Add"} value={o.value} step={prop.log && o.mode === "set" ? 0.5 : 0.05} unit={o.mode === "multiply" ? "" : prop.unit} onChange={(v) => set({ value: v })} />
          {prop.layered && layers}{brush}<span className="tool-hint">Alt-click a cell to pick up its value</span></>}
        {tool === "chd" && <>
          <div className="seg quiet" role="radiogroup" aria-label="Kind of head boundary">
            <button role="radio" aria-checked={o.headKind === "chd"} className={o.headKind === "chd" ? "on" : ""} onClick={() => set({ headKind: "chd" })} title="Holds the head exactly (CHD)">Fixed</button>
            <button role="radio" aria-checked={o.headKind === "ghb"} className={o.headKind === "ghb" ? "on" : ""} onClick={() => set({ headKind: "ghb" })} title="Exchanges water with a head outside, through a conductance (GHB)">General</button>
          </div>
          {o.headKind === "ghb" && <Num label="Cond." value={o.cond} step={10} unit="m²/d" onChange={(v) => set({ cond: v })} />}
          <Num label="Head" value={o.head} step={0.5} unit={o.headMode === "abs" ? "m" : "m below top"} onChange={(v) => set({ head: v })} />
          <div className="seg quiet" role="radiogroup" aria-label="Head is">
            <button role="radio" aria-checked={o.headMode === "abs"} className={o.headMode === "abs" ? "on" : ""} onClick={() => set({ headMode: "abs" })}>Level</button>
            <button role="radio" aria-checked={o.headMode === "below_top"} className={o.headMode === "below_top" ? "on" : ""} onClick={() => set({ headMode: "below_top" })}>Below top</button>
          </div>{layers}{brush}
          <div className="seg quiet" role="group" aria-label="Whole edge">{(["west", "north", "east", "south"] as const).map((e) => <button key={e} onClick={() => onEdge(e)} title={`${o.headKind === "ghb" ? "General" : "Fixed"} head along the whole ${e} edge`}>{e[0].toUpperCase() + e.slice(1)} edge</button>)}</div>
          {sched}</>}
        {tool === "wel" && <><Num label="Rate" value={o.rate} step={50} unit="m³/d" onChange={(v) => set({ rate: v })} />{layers}{sched}<span className="tool-hint">+ pumps, − injects · click a well to remove it</span></>}
        {tool === "riv" && <>
          <Num label="Stage from" value={o.stage0} step={0.5} unit="m" onChange={(v) => set({ stage0: v })} /><Num label="to" value={o.stage1} step={0.5} unit="m" onChange={(v) => set({ stage1: v })} />
          <Num label="Bed" value={o.bed} step={0.25} unit="m deep" w={52} onChange={(v) => set({ bed: v })} /><Num label="Cond." value={o.cond} step={10} unit="m²/d" onChange={(v) => set({ cond: v })} />
          {sched}<span className="tool-hint">Click along the river, double-click or ↵ to finish</span></>}
        {tool === "drn" && <>
          <Num label="Depth" value={o.depth} step={0.25} unit="m below top" w={52} onChange={(v) => set({ depth: v })} /><Num label="Cond." value={o.cond} step={10} unit="m²/d" onChange={(v) => set({ cond: v })} />
          {sched}<span className="tool-hint">Click along the drain, double-click or ↵ to finish</span></>}
        {tool === "flux" && <>
          <div className="seg quiet" role="radiogroup" aria-label="Flux">
            <button role="radio" aria-checked={o.flux === "rch"} className={o.flux === "rch" ? "on" : ""} onClick={() => set({ flux: "rch" })}>Recharge</button>
            <button role="radio" aria-checked={o.flux === "evt"} className={o.flux === "evt" ? "on" : ""} onClick={() => set({ flux: "evt" })}>ET</button>
          </div>
          <div className="seg quiet" role="radiogroup" aria-label="Mode">
            {(["set", "multiply", "add"] as Mode[]).map((m) => <button key={m} role="radio" aria-checked={o.mode === m} className={o.mode === m ? "on" : ""} onClick={() => set({ mode: m })}>{m === "set" ? "Set" : m === "multiply" ? "×" : "+"}</button>)}
          </div>
          <Num label={o.mode === "set" ? "Rate" : o.mode === "multiply" ? "Times" : "Add"} value={o.mm} step={10} unit={o.mode === "multiply" ? "" : "mm/yr"} onChange={(v) => set({ mm: v })} />
          {brush}<span className="tool-hint">Its schedule is in the explorer (BND)</span></>}
        {tool === "obs" && <span className="tool-hint">Click to add an observation point on L{layer + 1} · click one to remove it</span>}
        {tool === "section" && <span className="tool-hint">Click two or more points, double-click or ↵ to finish</span>}
      </div>
    </div>
  );
}
