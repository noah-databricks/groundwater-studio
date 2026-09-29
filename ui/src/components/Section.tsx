import { useMemo, useState } from "react";
import { niceStep } from "../lib/geom";
import type { Bore, Grid } from "../types";

type Props = {
  grid: Grid; path: { row: number; col: number }[]; wt: (number | null)[][]; baseWt?: (number | null)[][] | null; bores: Bore[];
  width: number; height: number; label: string; layerNames?: string[]; drains?: { name: string; cells: [number, number][]; depth_m: number }[];
};

/** A long section along any path of cells (a model row, or a line drawn on the model), drawn like a drafted cross-section. */
export default function Section({ grid, path, wt: wt2, baseWt: base2, bores, width, height, label, layerNames, drains }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 16, t: 34, b: 26 };
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const nc = path.length;
  // distance along the path at each cell centre, km
  const dist = useMemo(() => {
    const d = [0];
    for (let i = 1; i < path.length; i++) d.push(d[i - 1] + Math.hypot((path[i].row - path[i - 1].row) * grid.delc_km, (path[i].col - path[i - 1].col) * grid.delr_km));
    return d;
  }, [path, grid.delc_km, grid.delr_km]);
  const half = grid.delr_km / 2, km = (dist[nc - 1] ?? 0) + 2 * half;
  const at = (a: (number | null)[][]) => path.map((q) => a[q.row]?.[q.col] ?? null);
  const top = at(grid.top), layers = grid.botm.map((b) => at(b));
  const wt = at(wt2), baseWt = base2 ? at(base2) : null;
  const all = [...top, ...layers.flat()].filter((v): v is number => v != null);
  const zmin = Math.min(...all) - 2, zmax = Math.max(...(top.filter((v) => v != null) as number[])) + 3;
  const X = (i: number) => pad.l + ((dist[i] + half) / km) * W;
  const Y = (z: number) => pad.t + (1 - (z - zmin) / (zmax - zmin)) * H;
  const path_ = (vals: (number | null)[]) => vals.map((v, c) => (v == null ? "" : `${c && vals[c - 1] != null ? "L" : "M"}${X(c).toFixed(1)},${Y(v).toFixed(1)}`)).join("");
  const band = (hi: (number | null)[], lo: (number | null)[]) => {
    const up = hi.map((v, c) => `${c ? "L" : "M"}${X(c).toFixed(1)},${Y(v ?? zmin).toFixed(1)}`).join("");
    const dn = [...lo].reverse().map((v, i) => `L${X(nc - 1 - i).toFixed(1)},${Y(v ?? zmin).toFixed(1)}`).join("");
    return up + dn + "Z";
  };
  const wtc = wt.map((v, c) => (v == null || top[c] == null ? v : Math.min(top[c] as number, v)));
  const ve = Math.round(((km * 1000) / W) / ((zmax - zmin) / H));
  const zStep = niceStep(zmax - zmin, 4), xStep = niceStep(km, 5);
  const zTicks = useMemo(() => { const t: number[] = []; for (let z = Math.ceil(zmin / zStep) * zStep; z <= zmax; z += zStep) t.push(z); return t; }, [zmin, zmax, zStep]);
  const xTicks = useMemo(() => { const t: number[] = []; for (let x = 0; x <= km + 1e-6; x += xStep) t.push(x); return t; }, [km, xStep]);
  // bores on (or beside) the section line, placed at the nearest point on it; stagger labels so neighbours do not collide
  const near = bores.flatMap((b) => {
    let bi = -1, bd = 1.5;
    path.forEach((q, i) => { const d = Math.max(Math.abs(q.row - b.row), Math.abs(q.col - b.col)); if (d < bd) { bd = d; bi = i; } });
    return bi < 0 ? [] : [{ ...b, i: bi }];
  }).sort((a, b) => a.i - b.i);
  // proposed drains the section crosses, drawn at their invert
  const drainHits = (drains ?? []).flatMap((d) => path.flatMap((q, i) => (d.cells.some(([r, c]) => r === q.row && c === q.col) && top[i] != null ? [{ name: d.name, i, z: (top[i] as number) - d.depth_m }] : [])));
  // greedy label rows: a label moves up a row while it would overlap the previous label on that row
  const lift: number[] = [], rowEnd: number[] = [];
  near.forEach((b) => {
    const x0 = X(b.i) + 3, w = b.bore_id.length * 5.6 + 4;
    let lv = 0; while (rowEnd[lv] != null && rowEnd[lv] > x0) lv++;
    rowEnd[lv] = x0 + w; lift.push(lv);
  });
  const hc = hover == null ? null : Math.max(0, Math.min(nc - 1, hover));

  return (
    <svg width={width} height={height} className="section" role="img" aria-label={label ? `Section, ${label}` : "Section"}
      onMouseMove={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(), x = ((e.clientX - r.left - pad.l) / W) * km - half;
        let bi = 0; dist.forEach((d, i) => { if (Math.abs(d - x) < Math.abs(dist[bi] - x)) bi = i; }); setHover(bi);
      }}
      onMouseLeave={() => setHover(null)}>
      <defs>
        <pattern id="p-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--ink)" strokeWidth="0.6" opacity="0.55" /></pattern>
        <pattern id="p-cross" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V8M0 0H8" stroke="var(--ink)" strokeWidth="0.5" opacity="0.5" /></pattern>
        <pattern id="p-stip" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="2" r="0.55" fill="var(--ink)" opacity="0.6" /><circle cx="5" cy="5.5" r="0.5" fill="var(--ink)" opacity="0.5" /></pattern>
        <pattern id="p-water" width="16" height="6" patternUnits="userSpaceOnUse"><line x1="2" y1="3" x2="9" y2="3" stroke="var(--water-ink)" strokeWidth="0.7" opacity="0.6" /></pattern>
      </defs>
      {layers.slice(1).map((lo, k) => (
        <g key={k}><path d={band(layers[k], lo)} fill={k % 2 ? "#e9e8e2" : "#dcdbd4"} /><path d={band(layers[k], lo)} fill={k % 2 ? "url(#p-hatch)" : "url(#p-cross)"} /></g>
      ))}
      <path d={band(wtc, layers[0])} fill="#b8d2ef" /><path d={band(wtc, layers[0])} fill="url(#p-water)" />
      <path d={band(top, wtc)} fill="#f6f5f0" /><path d={band(top, wtc)} fill="url(#p-stip)" />
      {layers.map((l, k) => <path key={k} d={path_(l)} fill="none" stroke="var(--ink)" strokeWidth={k === layers.length - 1 ? 1.1 : 0.6} />)}
      {baseWt && <path d={path_(baseWt.map((v, c) => (v == null || top[c] == null ? v : Math.min(top[c] as number, v))))} fill="none" stroke="var(--ink)" strokeWidth="0.9" strokeDasharray="4 3" />}
      <path d={path_(wtc)} fill="none" stroke="var(--water-ink)" strokeWidth="1.8" />
      <path d={path_(top)} fill="none" stroke="var(--ink)" strokeWidth="1.3" />
      {near.map((b, i) => {
        const t = top[b.i], lay = Math.min(b.layer, grid.nlay - 1), bot = layers[lay][b.i];
        if (t == null || bot == null) return null;
        const red = b.bore_type === "proposed";
        return <g key={b.bore_id}>
          <line x1={X(b.i)} x2={X(b.i)} y1={pad.t - 4 - lift[i] * 10} y2={Y(bot + 4)} stroke={red ? "var(--red)" : "var(--ink)"} strokeWidth={b.bore_type === "monitoring" ? 0.9 : 1.6} />
          <text x={X(b.i) + 3} y={pad.t - 6 - lift[i] * 10} className={`sec-label ${red ? "red" : ""}`}>{b.bore_id}</text>
        </g>;
      })}
      {zTicks.map((z) => <g key={z}><line x1={pad.l - 4} x2={pad.l} y1={Y(z)} y2={Y(z)} stroke="var(--ink)" strokeWidth="0.75" /><text x={pad.l - 7} y={Y(z) + 3.5} className="tick" textAnchor="end">{z}</text></g>)}
      <text x={10} y={pad.t + H / 2} className="tick" transform={`rotate(-90 10 ${pad.t + H / 2})`} textAnchor="middle">m AHD</text>
      {xTicks.map((x) => <g key={x}><line x1={pad.l + (x / km) * W} x2={pad.l + (x / km) * W} y1={pad.t + H} y2={pad.t + H + 4} stroke="var(--ink)" strokeWidth="0.75" /><text x={pad.l + (x / km) * W} y={pad.t + H + 15} className="tick" textAnchor="middle">{x} km</text></g>)}
      <line x1={pad.l} x2={pad.l + W} y1={pad.t + H} y2={pad.t + H} stroke="var(--ink)" strokeWidth="0.75" />
      <text x={pad.l - 30} y={pad.t - 20} className="sec-letter">A</text>
      <text x={pad.l + W} y={pad.t - 20} className="sec-letter" textAnchor="end">A′</text>
      {layers.map((l, k) => {
        const c = Math.min(nc - 1, Math.round(nc * 0.06)), hi = k === 0 ? top[c] : layers[k - 1][c], lo = l[c];
        return hi == null || lo == null || Y(lo) - Y(hi) < 12 ? null : <text key={`ln${k}`} x={X(c)} y={(Y(hi) + Y(lo)) / 2 + 3.5} className="sec-layer">{`L${k + 1} ${layerNames?.[k] ?? ""}`}</text>;
      })}
      {drainHits.map((d, j) => <g key={`dr${j}`}><circle cx={X(d.i)} cy={Y(d.z)} r="3.2" fill="var(--sheet)" stroke="var(--red)" strokeWidth="1.4" />
        {(j === 0 || drainHits[j - 1].name !== d.name) && <text x={X(d.i) + 5} y={Y(d.z) + 3.5} className="sec-label red">{d.name}</text>}</g>)}
      <text x={pad.l + W} y={pad.t + H - 6} className="tick" textAnchor="end">V.E. ≈ {ve}× · {label}</text>
      {hc != null && top[hc] != null && wtc[hc] != null && (
        <g>
          <line x1={X(hc)} x2={X(hc)} y1={pad.t} y2={pad.t + H} stroke="var(--ink)" strokeWidth="0.5" strokeDasharray="2 2" />
          <rect x={Math.min(X(hc) + 6, pad.l + W - 132)} y={pad.t + 14} width="126" height="40" fill="var(--sheet)" stroke="var(--ink)" strokeWidth="0.6" />
          <text x={Math.min(X(hc) + 12, pad.l + W - 126)} y={pad.t + 29} className="tick strong">R{path[hc].row + 1} C{path[hc].col + 1} · {(dist[hc] + half).toFixed(2)} km</text>
          <text x={Math.min(X(hc) + 12, pad.l + W - 126)} y={pad.t + 45} className="tick">Depth to water {((top[hc] as number) - (wtc[hc] as number)).toFixed(2)} m</text>
        </g>
      )}
    </svg>
  );
}
