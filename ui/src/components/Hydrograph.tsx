import { useState } from "react";
import { niceStep } from "../lib/geom";

type Props = {
  labels: string[]; sim: (number | null)[]; base: (number | null)[]; obs: { t: string[]; h: (number | null)[] };
  landSurface: number | null; width: number; height: number;
  band?: { p10: (number | null)[]; p90: (number | null)[] } | null;  // an ensemble's P10-P90 heads at this bore
};
const monthEnd = (l: string) => { const [y, m] = l.split("-").map(Number); return Date.UTC(y, m, 0); };

/** Head at one observation bore, drafted: scenario in water ink, baseline dashed, observations as open circles. */
export default function Hydrograph({ labels, sim, base, obs, landSurface, width, height, band }: Props) {
  const [hi, setHi] = useState<number | null>(null);
  const pad = { l: 44, r: 12, t: 12, b: 24 };
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const ts = labels.slice(1).map(monthEnd), s = sim.slice(1), b = base.slice(1);
  const ot = obs.t.map((d) => Date.parse(d)), oh = obs.h;
  const lo = band?.p10.slice(1) ?? [], hiB = band?.p90.slice(1) ?? [];
  const vals = [...s, ...b, ...oh, ...lo, ...hiB].filter((v): v is number => v != null);
  if (landSurface != null) vals.push(landSurface - 2);
  const y0 = Math.min(...vals) - 0.1, y1 = Math.max(...vals) + 0.1, t0 = ts[0] - 20 * 864e5, t1 = ts[ts.length - 1] + 5 * 864e5;
  const X = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * W, Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * H;
  const line = (v: (number | null)[]) => v.map((x, i) => (x == null ? "" : `${i ? "L" : "M"}${X(ts[i]).toFixed(1)},${Y(x).toFixed(1)}`)).join("");
  const step = niceStep(y1 - y0, 4), ticks: number[] = [];
  for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) ticks.push(+v.toFixed(3));
  const years = ts.filter((t) => new Date(t).getUTCMonth() === 0);
  return (
    <svg width={width} height={height} className="hydro" role="img" aria-label="Bore hydrograph"
      onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const x = e.clientX - r.left;
        let bi = 0, bd = 1e9; ts.forEach((t, i) => { const d = Math.abs(X(t) - x); if (d < bd) { bd = d; bi = i; } }); setHi(bi); }}
      onMouseLeave={() => setHi(null)}>
      {ticks.map((v) => <g key={v}><line x1={pad.l} x2={pad.l + W} y1={Y(v)} y2={Y(v)} stroke="var(--hair)" strokeWidth="0.6" />
        <text x={pad.l - 6} y={Y(v) + 3.5} className="tick" textAnchor="end">{v.toFixed(step < 0.1 ? 2 : 1)}</text></g>)}
      {years.map((t) => <g key={t}><line x1={X(t)} x2={X(t)} y1={pad.t} y2={pad.t + H} stroke="var(--hair)" strokeWidth="0.6" />
        <text x={X(t) + 3} y={pad.t + H + 14} className="tick">{new Date(t).getUTCFullYear()}</text></g>)}
      {landSurface != null && landSurface - 2 <= y1 && <g>
        <line x1={pad.l} x2={pad.l + W} y1={Y(landSurface - 2)} y2={Y(landSurface - 2)} stroke="var(--ink)" strokeDasharray="5 3" strokeWidth="0.8" />
        <text x={pad.l + W} y={Y(landSurface - 2) - 4} className="tick" textAnchor="end">2 m below surface</text></g>}
      {band && <polygon fill="#aecdf0" opacity="0.75" points={[...hiB.map((v, i) => (v == null ? null : `${X(ts[i]).toFixed(1)},${Y(v).toFixed(1)}`)),
        ...lo.map((v, i) => (v == null ? null : `${X(ts[i]).toFixed(1)},${Y(v).toFixed(1)}`)).reverse()].filter(Boolean).join(" ")} />}
      <path d={line(b)} fill="none" stroke="var(--ink)" strokeWidth="1" strokeDasharray="3 3" />
      <path d={line(s)} fill="none" stroke="var(--water-ink)" strokeWidth="1.8" />
      {ot.map((t, i) => oh[i] != null && <circle key={i} cx={X(t)} cy={Y(oh[i] as number)} r="2.8" fill="var(--sheet)" stroke="var(--ink)" strokeWidth="1" />)}
      <line x1={pad.l} x2={pad.l + W} y1={pad.t + H} y2={pad.t + H} stroke="var(--ink)" strokeWidth="0.8" />
      <text x={10} y={pad.t + H / 2} className="tick" transform={`rotate(-90 10 ${pad.t + H / 2})`} textAnchor="middle">Head, m AHD</text>
      {hi != null && s[hi] != null && (
        <g>
          <line x1={X(ts[hi])} x2={X(ts[hi])} y1={pad.t} y2={pad.t + H} stroke="var(--ink)" strokeWidth="0.5" strokeDasharray="2 2" />
          <circle cx={X(ts[hi])} cy={Y(s[hi] as number)} r="3" fill="var(--water-ink)" />
          <rect x={Math.min(X(ts[hi]) + 8, pad.l + W - 150)} y={pad.t + 4} width="146" height="42" fill="var(--sheet)" stroke="var(--ink)" strokeWidth="0.6" />
          <text x={Math.min(X(ts[hi]) + 14, pad.l + W - 144)} y={pad.t + 19} className="tick strong">{new Date(ts[hi]).toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" })}</text>
          <text x={Math.min(X(ts[hi]) + 14, pad.l + W - 144)} y={pad.t + 35} className="tick">Scenario {(s[hi] as number).toFixed(2)} · base {b[hi] != null ? (b[hi] as number).toFixed(2) : "–"}</text>
        </g>
      )}
    </svg>
  );
}
