import { useRef, useState } from "react";
import { factorsOf, MONTHS, periodLabels, PRESETS, usedBy, type BuildDoc, type Schedule } from "../lib/build";
import { Icon } from "./Icon";

/** One schedule: a year of monthly factors (drag the bars, or click months on and off), overrides on spans of periods,
 *  and what it comes to over the model's own periods. */
export default function ScheduleEditor({ doc, name, onChange, onDelete }: {
  doc: BuildDoc; name: string; onChange: (s: Schedule) => void; onDelete: () => void;
}) {
  const s = doc.schedules[name];
  const bars = useRef<SVGSVGElement>(null);
  const [ov, setOv] = useState<{ from: number; to: number; factor: number; label: string } | null>(null);
  const labels = periodLabels(doc), eff = factorsOf(doc, name), users = usedBy(doc, name);
  const top = Math.max(2, ...s.factors.map((x) => x * 1.1));
  const W = 228, H = 64, bw = W / 12;
  const setMonth = (i: number, v: number) => onChange({ ...s, factors: s.factors.map((x, j) => (j === i ? Math.max(0, +v.toFixed(2)) : x)) });
  const drag = (e: React.PointerEvent, i: number) => {
    if (s.onoff) { setMonth(i, s.factors[i] > 0 ? 0 : 1); return; }
    const svg = bars.current!, box = svg.getBoundingClientRect();
    const move = (ev: PointerEvent) => setMonth(i, ((box.bottom - ev.clientY) / box.height) * top);
    move(e.nativeEvent);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const emax = Math.max(1, ...eff);
  return (
    <div className="sch">
      <div className="sch-h">
        <b>{name}</b><span className="muted">used by {users.length ? users.slice(0, 4).join(", ") + (users.length > 4 ? ` +${users.length - 4}` : "") : "nothing yet"}</span>
        <button className="icon-btn" onClick={onDelete} aria-label={`Delete schedule ${name}`} title="Delete (what uses it becomes constant)"><Icon name="x" size={11} /></button>
      </div>
      {s.kind === "months" ? (
        <>
          <svg ref={bars} width={W} height={H + 14} className="sch-bars" role="group" aria-label={`${name}, monthly factors`}>
            <line x1={0} x2={W} y1={H - H / top} y2={H - H / top} stroke="var(--hair)" strokeDasharray="2 2" />
            {s.factors.map((f, i) => (
              <g key={i} onPointerDown={(e) => drag(e, i)} style={{ cursor: s.onoff ? "pointer" : "ns-resize" }}>
                <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
                <rect x={i * bw + 2} y={H - (f / top) * H} width={bw - 4} height={Math.max(f > 0 ? 1.5 : 0, (f / top) * H)} fill={f > 0 ? "var(--ink)" : "none"} />
                {f === 0 && <line x1={i * bw + 3} x2={(i + 1) * bw - 3} y1={H - 1} y2={H - 1} stroke="var(--ink-3)" />}
                <text x={i * bw + bw / 2} y={H + 11} className="tick" textAnchor="middle">{MONTHS[i]}</text>
                <title>{`${MONTHS[i]}: ${s.onoff ? (f > 0 ? "on" : "off") : `×${f.toFixed(2)}`}`}</title>
              </g>
            ))}
          </svg>
          <div className="sch-ctl">
            <div className="seg quiet" role="radiogroup" aria-label="Schedule kind">
              <button role="radio" aria-checked={s.onoff} className={s.onoff ? "on" : ""} onClick={() => onChange({ ...s, onoff: true, factors: s.factors.map((x) => (x > 0 ? 1 : 0)) })}>On/off</button>
              <button role="radio" aria-checked={!s.onoff} className={!s.onoff ? "on" : ""} onClick={() => onChange({ ...s, onoff: false })}>Curve</button>
            </div>
            <select value="" onChange={(e) => { const p = PRESETS[e.target.value]; if (p) onChange({ ...s, ...p, factors: [...p.factors] }); }} aria-label="Preset">
              <option value="">Presets…</option>
              {Object.keys(PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
        </>
      ) : <div className="sch-note">Follows data: one factor per period{s.imported ? ", read from the uploaded files" : ""}.</div>}
      <svg width={W} height={30} className="sch-eff" role="img" aria-label="What it comes to, period by period">
        {eff.map((f, i) => {
          const w = W / eff.length, h = (f / emax) * 24;
          return <rect key={i} x={i * w + 0.5} y={26 - h} width={Math.max(1, w - 1)} height={h} fill={doc.time.periods[i]?.steady ? "var(--ink-3)" : "var(--water-ink)"}><title>{`${labels[i]}: ×${f.toFixed(2)}`}</title></rect>;
        })}
        <line x1={0} x2={W} y1={26.5} y2={26.5} stroke="var(--ink)" strokeWidth="0.6" />
      </svg>
      <div className="sch-eff-l muted">{labels.length} periods{doc.time.periods.length === 1 ? " (steady-state: the yearly mean applies)" : ""}</div>
      {(s.overrides ?? []).map((o, i) => (
        <div key={i} className="sch-ov"><span className="num">{labels[o.from] ?? o.from + 1}–{labels[o.to] ?? o.to + 1} ×{o.factor}</span>{o.label && <span className="muted"> {o.label}</span>}
          <button className="link small" onClick={() => onChange({ ...s, overrides: s.overrides.filter((_, j) => j !== i) })}>Remove</button></div>
      ))}
      {doc.time.periods.length > 1 && (ov ? (
        <form className="sch-ovf" onSubmit={(e) => { e.preventDefault(); onChange({ ...s, overrides: [...(s.overrides ?? []), { ...ov, from: Math.min(ov.from, ov.to), to: Math.max(ov.from, ov.to) }] }); setOv(null); }}>
          <select value={ov.from} onChange={(e) => setOv({ ...ov, from: +e.target.value })} aria-label="From period">{labels.map((l, i) => <option key={i} value={i}>{l}</option>)}</select>
          <span>to</span>
          <select value={ov.to} onChange={(e) => setOv({ ...ov, to: +e.target.value })} aria-label="To period">{labels.map((l, i) => <option key={i} value={i}>{l}</option>)}</select>
          <span>×</span><input type="number" step="0.05" min="0" value={ov.factor} onChange={(e) => setOv({ ...ov, factor: +e.target.value })} aria-label="Factor" />
          <input value={ov.label} onChange={(e) => setOv({ ...ov, label: e.target.value })} placeholder="why (e.g. drought)" aria-label="Label" />
          <button className="btn small">Add</button><button type="button" className="link small" onClick={() => setOv(null)}>Cancel</button>
        </form>
      ) : <button className="link small" onClick={() => setOv({ from: 1, to: Math.min(labels.length - 1, 12), factor: 0.6, label: "" })}>Add an override for a span of periods</button>)}
    </div>
  );
}
