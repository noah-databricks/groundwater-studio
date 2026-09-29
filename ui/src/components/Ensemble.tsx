import { useEffect, useState } from "react";
import type { EnsembleDetail } from "../api";
import { Icon } from "./Icon";

export type Vary = { k: number; k_by_aquifer: boolean; sy: number; deep_drainage: number; rain: number };
export const DEFAULT_VARY: Vary = { k: 0.35, k_by_aquifer: true, sy: 0.5, deep_drainage: 0.5, rain: 0.15 };
const pct = (v: number) => `±${Math.round(v * 100)}%`;

/** Set up an ensemble of the open scenario: how many realizations, what varies and by how much, which ones to keep. */
export function EnsemblePanel({ scenarioText, perRunS, onRun, onClose, busy }: {
  scenarioText: string; perRunS: number; busy: boolean; onClose: () => void;
  onRun: (o: { n: number; vary: Vary; rmse_threshold_m: number; label: string }) => void;
}) {
  const [n, setN] = useState(64), [vary, setVary] = useState<Vary>(DEFAULT_VARY), [thr, setThr] = useState(0.25), [label, setLabel] = useState("");
  const set = (x: Partial<Vary>) => setVary((v) => ({ ...v, ...x }));
  const est = 180 + (n * (perRunS + 2.5)) / 4;  // measured: 64 in ~4 min, 256 in ~6 min at native fidelity
  const dur = (x: number) => (x < 90 ? `${Math.round(x)} s` : `${Math.round(x / 60)} min`);
  const Choice = ({ value, opts, fmt, onPick, label: l }: { value: number; opts: number[]; fmt: (v: number) => string; onPick: (v: number) => void; label: string }) => (
    <div className="seg res-seg" role="radiogroup" aria-label={l}>
      {opts.map((o) => <button key={o} role="radio" aria-checked={value === o} className={value === o ? "on" : ""} onClick={() => onPick(o)}>{o === 0 ? "fixed" : fmt(o)}</button>)}
    </div>
  );
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);
  return (
    <div className="ens-panel" role="dialog" aria-label="Run an ensemble">
      <div className="ens-panel-h"><b>Run as an ensemble</b><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={12} /></button></div>
      <p className="ens-panel-p">Solves <b>{scenarioText}</b> many times with uncertain parameters sampled around its own values, keeps the realizations that fit the observed bore levels, and shows how sure the result is.</p>
      <div className="res">
        <div className="res-row"><span className="res-l">Realizations</span><Choice label="Realizations" value={n} opts={[16, 64, 256, 512]} fmt={String} onPick={setN} /></div>
        <div className="res-row"><span className="res-l">Conductivity, log s.d.</span><Choice label="Conductivity" value={vary.k} opts={[0, 0.2, 0.35, 0.6]} fmt={(v) => v.toFixed(2)} onPick={(k) => set({ k })} /></div>
        {vary.k > 0 && <label className="ens-check"><input type="checkbox" checked={vary.k_by_aquifer} onChange={(e) => set({ k_by_aquifer: e.target.checked })} /> Upper and lower aquifers vary independently</label>}
        <div className="res-row"><span className="res-l">Specific yield</span><Choice label="Specific yield" value={vary.sy} opts={[0, 0.25, 0.5]} fmt={pct} onPick={(sy) => set({ sy })} /></div>
        <div className="res-row"><span className="res-l">Deep drainage</span><Choice label="Deep drainage" value={vary.deep_drainage} opts={[0, 0.25, 0.5]} fmt={pct} onPick={(deep_drainage) => set({ deep_drainage })} /></div>
        <div className="res-row"><span className="res-l">Rainfall, s.d.</span><Choice label="Rainfall" value={vary.rain} opts={[0, 0.1, 0.15, 0.25]} fmt={(v) => `${Math.round(v * 100)}%`} onPick={(rain) => set({ rain })} /></div>
        <div className="res-row"><span className="res-l">Keep if bore fit within</span><Choice label="Keep threshold" value={thr} opts={[0.15, 0.25, 0.4]} fmt={(v) => `${v} m`} onPick={setThr} /></div>
        <input className="ens-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name this ensemble (optional)" aria-label="Ensemble name" />
        <div className="res-est num">{n} realizations · about {dur(est)} on serverless Spark · the model shows it when it finishes</div>
      </div>
      <button className="issue full" disabled={busy} onClick={() => onRun({ n, vary, rmse_threshold_m: thr, label })}>
        <span className="issue-main"><Icon name="spread" size={13} />{busy ? "Submitting…" : "Run ensemble"}</span>
      </button>
    </div>
  );
}

/** The share of the district within 2 m, month by month: the ensemble's P10-P90 band and weighted mean, against the single run. */
export function MonthlyBand({ det, single, labels, width, height }: { det: EnsembleDetail; single: number[] | null; labels: string[]; width: number; height: number }) {
  const m = (det.monthly ?? []).filter((r) => r.period > 0);
  if (!m.length) return <div className="det empty">No monthly results in this ensemble (it predates them).</div>;
  const pad = { l: 38, r: 10, t: 12, b: 22 }, W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const vals = [...m.flatMap((r) => [r.area_p10, r.area_p90]), ...(single ?? []).slice(1)].filter((v): v is number => v != null);
  const y0 = Math.max(0, Math.floor(Math.min(...vals) - 1)), y1 = Math.ceil(Math.max(...vals) + 1);
  const X = (i: number) => pad.l + (i / Math.max(1, m.length - 1)) * W, Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * H;
  const band = m.map((r, i) => `${X(i)},${Y(r.area_p90 ?? 0)}`).join(" ") + " " + [...m].reverse().map((r, i) => `${X(m.length - 1 - i)},${Y(r.area_p10 ?? 0)}`).join(" ");
  const line = (vs: (number | null)[]) => vs.map((v, i) => (v == null ? "" : `${i ? "L" : "M"}${X(i)},${Y(v)}`)).join("");
  const ticks = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
  return (
    <svg width={width} height={height} className="hydro" role="img" aria-label="Share of district within 2 m by month, ensemble band">
      {ticks.map((t) => <g key={t}><line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--hair)" strokeWidth="0.6" /><text x={pad.l - 5} y={Y(t) + 3.5} className="tick" textAnchor="end">{t.toFixed(0)}%</text></g>)}
      <polygon points={band} fill="#aecdf0" opacity="0.75" />
      <path d={line(m.map((r) => r.area_mean))} fill="none" stroke="var(--water-ink)" strokeWidth="1.8" />
      {single && <path d={line(single.slice(1))} fill="none" stroke="var(--ink)" strokeWidth="1" strokeDasharray="4 3" />}
      {m.map((r, i) => (i % 3 === 0 ? <text key={i} x={X(i)} y={height - 6} className="tick" textAnchor="middle">{(labels[r.period] ?? r.month).slice(2)}</text> : null))}
      <text x={width - pad.r} y={pad.t + 9} className="tick" textAnchor="end">band P10–P90 · line weighted mean{single ? " · dashed this run" : ""}</text>
    </svg>
  );
}

/** Each realization's conductivity against its fit, with the keep threshold: what the observations pin down. */
export function FitScatter({ det, thr, width, height }: { det: EnsembleDetail; thr: number; width: number; height: number }) {
  const pad = { l: 42, r: 12, t: 12, b: 30 };
  const R = det.realizations.filter((r) => r.ok && r.rmse_m != null);
  if (!R.length) return <div className="det empty">No realizations solved.</div>;
  const kOf = (r: EnsembleDetail["realizations"][number]) => r.k_mult * (r.k_mult_lower ?? 1);
  const xs = R.map((r) => Math.log(kOf(r))), ys = R.map((r) => r.rmse_m as number);
  const x0 = Math.min(...xs) - 0.05, x1 = Math.max(...xs) + 0.05, y1 = Math.max(...ys, thr) * 1.08;
  const X = (v: number) => pad.l + ((Math.log(v) - x0) / (x1 - x0)) * (width - pad.l - pad.r), Y = (v: number) => pad.t + (1 - v / y1) * (height - pad.t - pad.b);
  const kt = [0.5, 0.75, 1, 1.5, 2, 3].filter((k) => Math.log(k) > x0 && Math.log(k) < x1);
  const byAq = R.some((r) => r.k_mult_lower != null && Math.abs((r.k_mult_lower ?? 1) - 1) > 1e-6);
  return (
    <svg width={width} height={height} className="hydro" role="img" aria-label="Realization fit against conductivity">
      {[0.1, 0.2, 0.3, 0.4, 0.5].filter((v) => v < y1).map((v) => <g key={v}><line x1={pad.l} x2={width - pad.r} y1={Y(v)} y2={Y(v)} stroke="var(--hair)" strokeWidth="0.6" /><text x={pad.l - 6} y={Y(v) + 3.5} className="tick" textAnchor="end">{v.toFixed(1)}</text></g>)}
      {kt.map((k) => <g key={k}><line x1={X(k)} x2={X(k)} y1={height - pad.b} y2={height - pad.b + 4} stroke="var(--ink)" strokeWidth="0.7" /><text x={X(k)} y={height - pad.b + 15} className="tick" textAnchor="middle">×{k}</text></g>)}
      <line x1={pad.l} x2={width - pad.r} y1={Y(thr)} y2={Y(thr)} stroke="var(--ink)" strokeDasharray="5 3" strokeWidth="0.8" />
      <text x={width - pad.r} y={Y(thr) - 4} className="tick" textAnchor="end">kept if RMSE ≤ {thr} m</text>
      {R.map((r) => <circle key={r.realization} cx={X(kOf(r))} cy={Y(r.rmse_m as number)} r="3" fill={r.behavioural ? "var(--water-ink)" : "var(--sheet)"} stroke="var(--water-ink)" strokeWidth="1">
        <title>{`#${r.realization} · K ×${kOf(r).toFixed(2)}${byAq ? ` (upper aquifer ×${(r.k_mult_upper ?? 1).toFixed(2)})` : ""} · Sy ${r.sy.toFixed(3)} · RMSE ${(r.rmse_m as number).toFixed(2)} m`}</title></circle>)}
      <line x1={pad.l} x2={width - pad.r} y1={height - pad.b} y2={height - pad.b} stroke="var(--ink)" strokeWidth="0.8" />
      <text x={(width + pad.l) / 2} y={height - 2} className="tick" textAnchor="middle">{byAq ? "Lower-aquifer conductivity multiplier (log)" : "Conductivity multiplier (log)"}</text>
      <text x={10} y={(height - pad.b) / 2} className="tick" transform={`rotate(-90 10 ${(height - pad.b) / 2})`} textAnchor="middle">Fit RMSE, m</text>
    </svg>
  );
}
