import { useEffect, useMemo, useState, type ReactNode } from "react";
import { at, factorsOf, featureTotal, periodLabels, PRESETS, setRate, setTime, timeRegular, timeSetup, TYPE_LABEL, updateFeature, usedBy, withDoc, worldOf, type BFeature, type Build, type BType } from "../lib/build";
import { diffLines, hunks } from "../lib/scenario";
import { Icon } from "./Icon";
import ScheduleEditor from "./ScheduleEditor";

const fmt = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "–" : Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : v.toLocaleString("en-AU", { maximumFractionDigits: d }));

function Fold({ code, title, meta, open, onToggle, children, red }: { code: string; title: string; meta?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode; red?: boolean }) {
  return (
    <div className={`fold ${open ? "open" : ""}`}>
      <button className="fold-head" onClick={onToggle} aria-expanded={open}>
        <span className="fold-title"><span className="code">{code}</span>{title}</span>
        {meta != null && <span className={`fold-meta num ${red ? "red" : ""}`}>{meta}</span>}
        <span className="caret"><Icon name="chevron" size={12} /></span>
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}

/** The explorer's side of the Build palette: the model's structure, time, solver, schedules and features. */
export default function BuildPanel({ b, set, unsaved, saving, onSave, onDiscard, onServer, selected, onSelect, busy, onEditFile, calibration }: {
  b: Build; set: (b: Build) => void; unsaved: boolean; saving: boolean; onSave: () => void; onDiscard: () => void;
  onServer: (ops: Record<string, unknown>[]) => void; selected: string | null; onSelect: (id: string | null) => void; busy: boolean;
  onEditFile: (member: string) => void; calibration?: ReactNode;
}) {
  const d = b.doc, g = d.grid;
  const [open, setOpen] = useState<Record<string, boolean>>({ TDIS: true, SCH: true, FEAT: true });
  const tog = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const [grid, setGrid] = useState({ nrow: g.nrow, ncol: g.ncol });
  useEffect(() => setGrid({ nrow: g.nrow, ncol: g.ncol }), [g.nrow, g.ncol]);
  const [newSch, setNewSch] = useState("");
  const [schOpen, setSchOpen] = useState<string | null>(null);
  const [retime, setRetime] = useState(false);
  const ts = timeSetup(d);
  const setT = (x: Partial<typeof ts>) => set(withDoc(b, setTime(d, { ...ts, ...x })));
  const sched = Object.keys(d.schedules);
  const cell = +(g.delr.reduce((a, x) => a + x, 0) / g.ncol).toFixed(2);
  const icell = (L: number) => b.arr.icelltype?.[L * g.nrow * g.ncol] ?? 0;
  const setConvertible = (L: number, on: boolean) => {
    const a = new Float32Array(b.arr.icelltype), n = g.nrow * g.ncol;
    a.fill(on ? 1 : 0, L * n, (L + 1) * n);
    const dirty = new Set(b.dirty); dirty.add("icelltype");
    set({ ...b, arr: { ...b.arr, icelltype: a }, dirty });
  };
  const range = (key: string, L: number) => {
    const a = b.arr[key]; if (!a) return null;
    const n = g.nrow * g.ncol, off = a.length === n ? 0 : L * n, act = b.arr.idomain;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { if (act && act[L * n + i] <= 0) continue; const v = a[off + i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    return lo === Infinity ? null : [lo, hi];
  };
  const groups = useMemo(() => {
    const m: Record<BType, BFeature[]> = { wel: [], chd: [], ghb: [], riv: [], drn: [] };
    d.boundaries.forEach((x) => m[x.type].push(x));
    return m;
  }, [d.boundaries]);
  const upd = (id: string, patch: Partial<BFeature>) => set(updateFeature(b, id, patch));
  const SchedPick = ({ value, onPick }: { value: string | null; onPick: (v: string | null) => void }) => (
    <select value={value ?? ""} onChange={(e) => onPick(e.target.value || null)} aria-label="Schedule" className="bp-sel">
      <option value="">Constant</option>
      {sched.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
  const transient = d.time.periods.some((p) => !p.steady);

  return (
    <div className="bp">
      <div className="doc">
        <div className="doc-l"><div className="doc-name">{d.name}</div>
          <div className="doc-meta">{unsaved ? <span className="doc-state">Unsaved changes</span> : "Saved"} · {g.nlay}×{g.nrow}×{g.ncol} · {fmt(cell, 1)} m</div></div>
        <div className="doc-acts">
          {unsaved && <button className="link small" onClick={onDiscard}>Discard</button>}
          <button className="btn small" disabled={!unsaved || saving} onClick={onSave} title="Write the changed files (⌘S)">{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
      {d.locked.length > 0 && (
        <div className="bp-lock"><Icon name="alert" size={12} /><span>{d.locked.length} part{d.locked.length > 1 ? "s" : ""} kept as uploaded, not editable here: {d.locked.map((l) => l.what).join(", ")}.
          <button className="link small" onClick={() => tog("LOCK")}>{open.LOCK ? "Hide" : "Why"}</button></span></div>
      )}
      {open.LOCK && <ul className="bp-locklist">{d.locked.map((l) => (
        <li key={l.what}><b>{l.what}</b> {l.reason}
          {(l as { file?: string }).file && <button className="link small" onClick={() => onEditFile((l as { file?: string }).file!)} title="Edit this file as text; the model reads it back">Edit as text</button>}</li>
      ))}</ul>}

      <Fold code="DIS" title="Grid and layers" meta={`${g.nlay} layer${g.nlay > 1 ? "s" : ""}`} open={!!open.DIS} onToggle={() => tog("DIS")}>
        <form className="bp-row" onSubmit={(e) => { e.preventDefault(); if (grid.nrow !== g.nrow || grid.ncol !== g.ncol) onServer([{ op: "resample", nrow: grid.nrow, ncol: grid.ncol }]); }}>
          <label>Rows <input type="number" min={2} max={1000} value={grid.nrow} onChange={(e) => setGrid({ ...grid, nrow: +e.target.value })} /></label>
          <label>Cols <input type="number" min={2} max={1000} value={grid.ncol} onChange={(e) => setGrid({ ...grid, ncol: +e.target.value })} /></label>
          <button className="btn small" disabled={busy || (grid.nrow === g.nrow && grid.ncol === g.ncol)} title="Every property and feature is carried to the new grid by nearest cell">Regrid</button>
        </form>
        <Georef b={b} set={set} />
        <table className="lu-t bp-layers"><thead><tr><th>Layer</th><th className="n">Bottom, m</th><th>Water table</th><th /></tr></thead>
          <tbody>{Array.from({ length: g.nlay }, (_, L) => {
            const r = range("botm", L);
            return <tr key={L}><td>L{L + 1}</td><td className="n num">{r ? `${fmt(r[0], 1)}–${fmt(r[1], 1)}` : "–"}</td>
              <td><label className="bp-chk"><input type="checkbox" checked={icell(L) > 0} onChange={(e) => setConvertible(L, e.target.checked)} />convertible</label></td>
              <td className="bp-lacts"><button className="link small" disabled={busy} onClick={() => onServer([{ op: "split_layer", layer: L }])} title="Split into two layers of half the thickness">Split</button>
                {g.nlay > 1 && <button className="link small" disabled={busy} onClick={() => onServer([{ op: "remove_layer", layer: L }])}>Remove</button>}</td></tr>;
          })}</tbody></table>
      </Fold>

      <Fold code="TDIS" title="Time" meta={transient ? `${d.time.periods.length} periods` : "steady-state"} open={!!open.TDIS} onToggle={() => tog("TDIS")}>
        <div className="seg" role="radiogroup" aria-label="Time">
          <button role="radio" aria-checked={!transient} className={!transient ? "on" : ""} onClick={() => setT({ transient: false })}>Steady-state</button>
          <button role="radio" aria-checked={transient} className={transient ? "on" : ""} onClick={() => setT({ transient: true })}>Through time</button>
        </div>
        <p className="bp-help">{transient ? "Stress periods; wells, recharge and channels change between them by their schedules." : "One answer: where the water table settles if nothing changes."}</p>
        {transient && !timeRegular(d) && !retime && (
          <div className="bp-asis">
            <p className="bp-help">As uploaded: {d.time.periods.length} periods{d.time.periods[0]?.steady ? " (the first steady-state)" : ""}, lengths {[...new Set(d.time.periods.slice(0, 6).map((p) => +p.perlen.toFixed(2)))].join(", ")}{d.time.periods.length > 6 ? ", …" : ""} {d.time_units}{d.time.start ? `, from ${d.time.start}` : ", with no calendar start"}. Ends at {periodLabels(d).slice(-1)[0]}.</p>
            <button className="link small" onClick={() => setRetime(true)}>Replace with a regular setup…</button>
          </div>
        )}
        {transient && (timeRegular(d) || retime) && (
          <div className="bp-grid">
            <label>Starts <input type="month" value={ts.start} onChange={(e) => e.target.value && setT({ start: e.target.value })} /></label>
            <label>Each period <select value={String(ts.period)} onChange={(e) => setT({ period: e.target.value === "month" || e.target.value === "week" ? e.target.value : +e.target.value })}>
              <option value="month">a month</option><option value="week">a week</option>
              {[1, 10, 14, 91, 365].map((n) => <option key={n} value={n}>{n} days</option>)}
              {typeof ts.period === "number" && ![1, 10, 14, 91, 365].includes(ts.period) && <option value={ts.period}>{ts.period} days</option>}
            </select></label>
            <label>Periods <input type="number" min={1} max={600} value={ts.count} onChange={(e) => setT({ count: Math.max(1, +e.target.value) })} /></label>
            <label>Steps each <input type="number" min={1} max={100} value={ts.nstp} onChange={(e) => setT({ nstp: Math.max(1, +e.target.value) })} /></label>
            <label className="bp-chk span2"><input type="checkbox" checked={ts.steadyFirst} onChange={(e) => setT({ steadyFirst: e.target.checked })} />Start from a steady-state warm-up period</label>
          </div>
        )}
      </Fold>

      <Fold code="IMS" title="Solver" meta={d.solver === "as_uploaded" ? "as uploaded" : d.solver} open={!!open.IMS} onToggle={() => tog("IMS")}>
        <div className="seg" role="radiogroup" aria-label="Solver">
          {(d.files && (d.files as Record<string, string>).ims && d.solver === "as_uploaded" ? ["as_uploaded", "standard", "robust"] : ["standard", "robust"]).map((s) => (
            <button key={s} role="radio" aria-checked={d.solver === s} className={d.solver === s ? "on" : ""} onClick={() => set(withDoc(b, { ...d, solver: s }))}>{s === "as_uploaded" ? "As uploaded" : s[0].toUpperCase() + s.slice(1)}</button>
          ))}
        </div>
        <p className="bp-help">Robust: more iterations and backtracking, for cells that dry and rewet or strong contrasts.</p>
      </Fold>

      <Fold code="SCH" title="Schedules" meta={sched.length ? `${sched.length}` : "none"} open={!!open.SCH} onToggle={() => tog("SCH")}>
        {!transient && sched.length === 0 && <p className="bp-help">Schedules make things change through time. Switch Time to "Through time" to use them.</p>}
        {sched.map((n) => (
          <div key={n} className={`bp-sch ${schOpen === n ? "open" : ""}`}>
            <button className="bp-sch-h" onClick={() => setSchOpen((x) => (x === n ? null : n))} aria-expanded={schOpen === n}>
              <Spark f={d.schedules[n].kind === "months" ? d.schedules[n].factors : factorsOf(d, n)} /><span>{n}</span><span className="muted num">{usedBy(d, n).length}</span>
            </button>
            {schOpen === n && <ScheduleEditor doc={d} name={n} onChange={(s) => set(withDoc(b, { ...d, schedules: { ...d.schedules, [n]: s } }))}
              onDelete={() => {
                const schedules = { ...d.schedules }; delete schedules[n];
                set(withDoc(b, { ...d, schedules, boundaries: d.boundaries.map((x) => (x.schedule === n ? { ...x, schedule: null } : x)),
                  recharge: d.recharge && d.recharge.schedule === n ? { ...d.recharge, schedule: null } : d.recharge, et: d.et && d.et.schedule === n ? { ...d.et, schedule: null } : d.et }));
              }} />}
          </div>
        ))}
        <form className="bp-row" onSubmit={(e) => {
          e.preventDefault(); const nm = newSch.trim(); if (!nm || d.schedules[nm]) return;
          const p = PRESETS[nm] ?? PRESETS["Irrigation season"];
          set(withDoc(b, { ...d, schedules: { ...d.schedules, [nm]: { kind: "months", factors: [...p.factors], onoff: p.onoff, overrides: [] } } })); setNewSch(""); setSchOpen(nm);
        }}>
          <input list="sch-presets" value={newSch} onChange={(e) => setNewSch(e.target.value)} placeholder="New schedule, e.g. Irrigation season" aria-label="New schedule name" />
          <datalist id="sch-presets">{Object.keys(PRESETS).filter((k) => !d.schedules[k]).map((k) => <option key={k} value={k} />)}</datalist>
          <button className="btn small" disabled={!newSch.trim() || !!d.schedules[newSch.trim()]}>Add</button>
        </form>
      </Fold>

      <Fold code="BND" title="Features" meta={`${d.boundaries.length + d.obs.length}`} open={!!open.FEAT} onToggle={() => tog("FEAT")}>
        {(["wel", "chd", "ghb", "riv", "drn"] as BType[]).map((t) => groups[t].length > 0 && (
          <div key={t} className="bp-feat">
            <div className="scale-lab"><span>{TYPE_LABEL[t]}s</span><span className="muted num">{groups[t].length}</span></div>
            {groups[t].slice(0, 60).map((f) => (
              <div key={f.id} className={`prop-row bp-f ${selected === f.id ? "sel" : ""}`} onClick={() => onSelect(selected === f.id ? null : f.id)}>
                <span className="bp-fid">{f.id}</span>
                <span className="num muted">{t === "wel" ? `r${f.cells[0][1] + 1} c${f.cells[0][2] + 1} L${f.cells.map((c) => c[0] + 1).join("+")}` : `${f.cells.length} cells`}</span>
                {t === "wel" && <input type="number" step={50} value={+(featureTotal(f) ?? 0).toFixed(3)} aria-label={`${f.id} rate m3/d`} title="m³/d, + pumps, − injects"
                  onClick={(e) => e.stopPropagation()} onChange={(e) => upd(f.id, setRate(f, +e.target.value))} />}
                {t === "chd" && f.head && <input type="number" step={0.5} value={+f.head[0].toFixed(3)} aria-label={`${f.id} head`} title="Head, m (sets every cell of this feature)"
                  onClick={(e) => e.stopPropagation()} onChange={(e) => upd(f.id, { head: f.cells.map(() => +e.target.value) })} />}
                {t === "ghb" && f.bhead && <input type="number" step={0.5} value={+f.bhead[0].toFixed(3)} aria-label={`${f.id} head`} title="Head outside the boundary, m"
                  onClick={(e) => e.stopPropagation()} onChange={(e) => upd(f.id, { bhead: f.cells.map(() => +e.target.value) })} />}
                {(t === "riv" || t === "drn") && f.cond && <input type="number" step={10} value={+f.cond[0].toFixed(3)} aria-label={`${f.id} conductance`} title="Conductance, m²/d per cell"
                  onClick={(e) => e.stopPropagation()} onChange={(e) => upd(f.id, { cond: f.cells.map(() => +e.target.value) })} />}
                <span onClick={(e) => e.stopPropagation()}><SchedPick value={f.schedule} onPick={(v) => upd(f.id, { schedule: v })} /></span>
                <button className="link" aria-label={`Remove ${f.id}`} onClick={(e) => { e.stopPropagation(); set(withDoc(b, { ...d, boundaries: d.boundaries.filter((x) => x.id !== f.id) })); }}><Icon name="x" size={11} /></button>
              </div>
            ))}
            {groups[t].length > 60 && <div className="muted small">and {groups[t].length - 60} more</div>}
          </div>
        ))}
        {d.obs.length > 0 && (
          <div className="bp-feat"><div className="scale-lab"><span>Observation points</span><span className="muted num">{d.obs.length}</span></div>
            {d.obs.map((o) => <div key={o.name} className={`prop-row bp-f ${selected === o.name ? "sel" : ""}`} onClick={() => onSelect(selected === o.name ? null : o.name)}>
              <span className="bp-fid">{o.name}</span><span className="num muted">r{o.cell[1] + 1} c{o.cell[2] + 1} L{o.cell[0] + 1}</span>
              <button className="link" aria-label={`Remove ${o.name}`} onClick={(e) => { e.stopPropagation(); set(withDoc(b, { ...d, obs: d.obs.filter((x) => x.name !== o.name) })); }}><Icon name="x" size={11} /></button></div>)}
          </div>
        )}
        {(["recharge", "et"] as const).map((k) => d[k] && (
          <div key={k} className="prop-row bp-f">
            <span className="bp-fid">{k === "recharge" ? "RCH" : "EVT"}</span>
            <span className="num muted">{(() => { const r = range(k === "recharge" ? "rch" : "evt", 0); return r ? `${fmt(r[0], 0)}–${fmt(r[1], 0)} mm/yr` : ""; })()}</span>
            <SchedPick value={d[k]!.schedule} onPick={(v) => set(withDoc(b, { ...d, [k]: { ...d[k]!, schedule: v } }))} />
          </div>
        ))}
        {!d.boundaries.length && !d.obs.length && !d.recharge && <p className="bp-help">No features yet. Draw them with the palette: fixed heads (H), wells (B), rivers (C), drains (R), recharge (F).</p>}
      </Fold>
      {calibration && (
        <Fold code="PEST" title="Calibration" meta="PEST++" open={!!open.CAL} onToggle={() => tog("CAL")}>{unsaved ? <p className="bp-help">Save the model first: PEST++ calibrates the saved package.</p> : calibration}</Fold>
      )}
    </div>
  );
}

/** Where the grid sits in the world: its lower-left origin, rotation and coordinate reference (EPSG). */
function Georef({ b, set }: { b: Build; set: (b: Build) => void }) {
  const g = b.doc.georef ?? { xorigin: 0, yorigin: 0, angrot: 0, epsg: null };
  const put = (x: Partial<typeof g>) => set(withDoc(b, { ...b.doc, georef: { ...g, ...x } }));
  return (
    <div className="bp-grid bp-geo">
      <label>X origin, m <input type="number" step={1} value={g.xorigin} onChange={(e) => put({ xorigin: +e.target.value })} /></label>
      <label>Y origin, m <input type="number" step={1} value={g.yorigin} onChange={(e) => put({ yorigin: +e.target.value })} /></label>
      <label>Rotation, ° <input type="number" step={0.5} value={g.angrot} onChange={(e) => put({ angrot: +e.target.value })} title="Counter-clockwise from east, about the origin (MODFLOW's ANGROT)" /></label>
      <label>EPSG <input type="number" step={1} value={g.epsg ?? ""} placeholder="e.g. 28355" onChange={(e) => put({ epsg: e.target.value ? +e.target.value : null })} title="Coordinate reference, e.g. 28355 for GDA94 / MGA zone 55, 7855 for GDA2020" /></label>
    </div>
  );
}

function Spark({ f }: { f: number[] }) {
  const mx = Math.max(1, ...f), w = 34 / Math.max(1, f.length);
  return <svg width={34} height={12} className="bp-spark" aria-hidden>{f.map((v, i) => <rect key={i} x={i * w} y={12 - (v / mx) * 11} width={Math.max(0.8, w - 0.6)} height={(v / mx) * 11} fill="currentColor" />)}</svg>;
}

/** One cell of the model being built: every property per layer, what is on it, and its head from the last solve. */
export function BuildCell({ b, cell, heads, onClose }: { b: Build; cell: { row: number; col: number }; heads: (number | null)[] | null; onClose: () => void }) {
  const g = b.doc.grid, { row, col } = cell, w = worldOf(b, row, col);
  const on = b.doc.boundaries.filter((f) => f.cells.some((c) => c[1] === row && c[2] === col));
  const obs = b.doc.obs.filter((o) => o.cell[1] === row && o.cell[2] === col);
  return (
    <div className="det probe">
      <div className="det-sub probe-h"><span><b>Row {row + 1}, col {col + 1}</b> · top {fmt(at(b, "top", 0, row, col), 2)} m
        {on.map((f) => ` · ${f.id}`).join("")}{obs.map((o) => ` · ${o.name}`).join("")}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close the cell readout"><Icon name="x" size={12} /></button></div>
      <table className="schedule"><thead><tr><th>Layer</th><th className="n">Bottom</th><th className="n">K</th><th className="n">K33</th><th className="n">Sy</th><th className="n">Ss</th><th className="n">Start</th>{heads && <th className="n">Head</th>}</tr></thead>
        <tbody>{Array.from({ length: g.nlay }, (_, L) => {
          const act = (at(b, "idomain", L, row, col) ?? 1) > 0;
          return <tr key={L} className={act ? "" : "muted"}><td>L{L + 1}{act ? "" : " off"}</td><td className="n">{fmt(at(b, "botm", L, row, col))}</td><td className="n">{fmt(at(b, "k", L, row, col), 3)}</td>
            <td className="n">{fmt(at(b, "k33", L, row, col), 3)}</td><td className="n">{fmt(at(b, "sy", L, row, col), 3)}</td><td className="n">{fmt(at(b, "ss", L, row, col), 6)}</td>
            <td className="n">{fmt(at(b, "strt", L, row, col))}</td>{heads && <td className="n">{fmt(heads[L])}</td>}</tr>;
        })}</tbody></table>
      {w && <div className="det-sub">E {w.x.toLocaleString("en-AU", { maximumFractionDigits: 0 })} · N {w.y.toLocaleString("en-AU", { maximumFractionDigits: 0 })}{b.doc.georef?.epsg ? ` · EPSG:${b.doc.georef.epsg}` : ""}</div>}
      {(b.arr.rch || b.arr.evt) && <div className="det-sub">{b.arr.rch ? `Recharge ${fmt(at(b, "rch", 0, row, col), 0)} mm/yr` : ""}{b.arr.evt ? ` · ET ${fmt(at(b, "evt", 0, row, col), 0)} mm/yr to ${fmt(at(b, "evt_depth", 0, row, col), 1)} m` : ""}</div>}
    </div>
  );
}

/** What saving would write: only the files that change, as line diffs. */
export function BuildChanges({ files, loading, error, height }: { files: { member: string; before: string; after: string }[] | null; loading: boolean; error: string | null; height: number }) {
  const [open, setOpen] = useState<string | null>(null);
  if (loading) return <div className="det empty"><span className="ld-line" />Writing the files to compare</div>;
  if (error) return <div className="det empty">{error}</div>;
  if (!files) return <div className="det empty">No changes.</div>;
  if (!files.length) return <div className="det empty">No changes to the files.</div>;
  return (
    <div className="det chg"><div className="chg-body" style={{ maxHeight: height }}>
      <div className="det-sub">{files.length} file{files.length > 1 ? "s" : ""} change; everything else is written back as it was</div>
      {files.map((f) => <FileDiff key={f.member} f={f} open={open === f.member} onToggle={() => setOpen((x) => (x === f.member ? null : f.member))} />)}
    </div></div>
  );
}

function FileDiff({ f, open, onToggle }: { f: { member: string; before: string; after: string }; open: boolean; onToggle: () => void }) {
  const ops = useMemo(() => (open ? diffLines(f.before.split("\n"), f.after.split("\n")) : []), [open, f]);
  const stat = useMemo(() => {  // cheap line count for the header before the diff is opened
    const a = new Set(f.before.split("\n")), bb = new Set(f.after.split("\n"));
    return { add: f.after.split("\n").filter((l) => !a.has(l)).length, del: f.before.split("\n").filter((l) => !bb.has(l)).length };
  }, [f]);
  const hs = useMemo(() => hunks(ops), [ops]);
  return (
    <div className="chg-file">
      <button className="chg-file-h" onClick={onToggle} aria-expanded={open}>
        <Icon name="chevron" size={11} /><span className="num">{f.member}</span>{!f.before && <span className="chg-tag add">new</span>}
        <span className="chg-stat num"><span className="add">+{stat.add}</span><span className="del">−{stat.del}</span></span>
      </button>
      {open && <div className="dv">{hs.slice(0, 40).map((h, i) => "skip" in h ? <div key={i} className="dv-skip">{h.skip} unchanged line{h.skip > 1 ? "s" : ""}</div> : (
        <div key={i}><div className="dv-hunk num">{h.head}</div>{h.ops.slice(0, 400).map((o, j) => (
          <div key={j} className={`dv-l ${o.t === "+" ? "add" : o.t === "-" ? "del" : ""}`}><span className="dv-n num">{o.t === "-" ? o.a ?? "" : o.b ?? ""}</span><span className="dv-s">{o.t === " " ? "" : o.t === "-" ? "−" : "+"}</span><span className="dv-c">{o.text}</span></div>
        ))}</div>
      ))}</div>}
    </div>
  );
}
