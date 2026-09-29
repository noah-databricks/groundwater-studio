import { useState } from "react";
import type { CellProbe, Crop, ZoneStats } from "../types";
import Hydrograph from "./Hydrograph";
import { Icon } from "./Icon";

const fmt = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "–" : v.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d }));
const signed = (v: number | null | undefined, d = 2) => (v == null ? "–" : Math.abs(v) < Math.pow(10, -d) / 2 ? "±0" : `${v > 0 ? "+" : "−"}${fmt(Math.abs(v), d)}`);
const CROP: Record<string, string> = { rice: "Rice", broadacre: "Row crops", horticulture: "Horticulture", pasture: "Pasture", dryland: "Dryland" };
const FEATURE: Record<string, string> = { canal: "supply channel", river: "river", drain: "district drain", chd: "regional boundary", "proposed drain": "proposed drain" };

export type Loadable<T> = T | "loading" | { error: string } | null;
const isErr = (x: unknown): x is { error: string } => !!x && typeof x === "object" && "error" in (x as object);

/** One cell of the solved model, as a virtual bore: water table against the baseline, heads, properties and its own budget. */
export function CellPanel({ cell, probe, period, labels, width, height, onClose }: {
  cell: { row: number; col: number }; probe: Loadable<CellProbe>; period: number; labels: string[]; width: number; height: number; onClose: () => void;
}) {
  const head = (
    <div className="det-sub probe-h">
      <span><b>Row {cell.row + 1}, col {cell.col + 1}</b>{probe && typeof probe === "object" && !isErr(probe) &&
        <> · {CROP[probe.land_use] ?? probe.land_use}{probe.land_use !== probe.recorded_land_use ? <span className="red"> (was {CROP[probe.recorded_land_use]?.toLowerCase()})</span> : ""}
          {probe.irrigated ? " · irrigated" : ""}{probe.reach ? ` · ${probe.reach}` : ""}{probe.features.filter((f) => f !== "canal").map((f) => ` · ${FEATURE[f] ?? f}`).join("")}
          {probe.bores.map((b) => ` · ${b.bore_id}`).join("")}</>}</span>
      <button className="icon-btn" onClick={onClose} aria-label="Close the cell readout" title="Close (Esc)"><Icon name="x" size={12} /></button>
    </div>
  );
  if (!probe || probe === "loading") return <div className="det">{head}<div className="det empty"><span className="ld-line" />Reading the cell from the solved model</div></div>;
  if (isErr(probe)) return <div className="det">{head}<div className="det empty">{probe.error}</div></div>;
  const p = Math.min(period, probe.dtw_m.length - 1);
  const land = probe.land_m_ahd;
  const wt = probe.dtw_m.map((d) => (d == null ? null : land - d)), bwt = probe.baseline_dtw_m.map((d) => (d == null ? null : land - d));
  // the cell's budget over the 24 months, largest terms first
  const rows = Object.entries(probe.budget_ml_by_month).map(([k, v]) => {
    const xs = v.slice(1).filter((x): x is number => x != null);
    return { k, in: xs.filter((x) => x > 0).reduce((a, b) => a + b, 0), out: -xs.filter((x) => x < 0).reduce((a, b) => a + b, 0), now: v[p] ?? 0 };
  }).filter((r) => r.in + r.out > 0.005).sort((a, b) => b.in + b.out - (a.in + a.out));
  return (
    <div className="det probe">
      {head}
      <dl className="probe-figs">
        <div><dt>Depth to water</dt><dd className={probe.dtw_m[p] != null && probe.dtw_m[p]! < 2 ? "red" : ""}>{fmt(probe.dtw_m[p], 2)} m</dd><dd className="muted" title="Water table against the baseline: + is higher (shallower)">water table {signed(probe.change_m[p] == null ? null : -probe.change_m[p]!)} m</dd></div>
        {probe.layers.map((l) => (
          <div key={l.layer}><dt>Head, {l.name}</dt><dd>{fmt(l.head_m[p], 2)} m</dd><dd className="muted">K {fmt(l.k_m_per_d, l.k_m_per_d < 10 ? 2 : 1)} m/d</dd></div>
        ))}
        <div><dt>Land surface</dt><dd>{fmt(land, 2)} m</dd><dd className="muted">Sy {probe.sy.toFixed(3)}</dd></div>
      </dl>
      <div className="det-sub">Water table, this scenario against the baseline (dashed); a virtual bore</div>
      <Hydrograph labels={labels} sim={wt} base={bwt} obs={{ t: [], h: [] }} landSurface={land} width={width} height={Math.max(130, height * 0.45)} />
      <div className="det-sub">This cell's water, 24 months</div>
      <table className="schedule"><thead><tr><th>Component</th><th className="n">In, ML</th><th className="n">Out, ML</th><th className="n">{labels[p]?.slice(2) ?? "Month"}</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.k}><td>{r.k}</td><td className="n">{fmt(r.in, 2)}</td><td className="n">{fmt(r.out, 2)}</td><td className="n muted">{signed(r.now, 2)}</td></tr>)}</tbody></table>
    </div>
  );
}

/** A zone's water balance (ZoneBudget over its aquifer column) and how shallow its water table is, month by month. */
export function ZonePanel({ title, stats, labels, width, height, saved, onSave, onDelete, onPaint, onLine, crops, reaches, onClose }: {
  title: string; stats: Loadable<ZoneStats>; labels: string[]; width: number; height: number; saved: boolean;
  onSave?: (name: string) => void; onDelete?: () => void; onPaint: (crop: Crop | "original") => void; onLine?: () => void;
  crops: { code: Crop; label: string }[]; reaches: string[]; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [crop, setCrop] = useState<Crop | "original">("dryland");
  const ok = stats && stats !== "loading" && !isErr(stats) ? stats : null;
  return (
    <div className="det probe">
      <div className="det-sub probe-h">
        <span><b>{title}</b>{ok ? ` · ${ok.hectares.toLocaleString("en-AU")} ha · ${ok.n_cells} cells` : ""}</span>
        <span className="probe-acts">
          {saved && onDelete && <button className="link small" onClick={onDelete}>Delete</button>}
          <button className="icon-btn" onClick={onClose} aria-label="Close the zone" title="Close (Esc)"><Icon name="x" size={12} /></button>
        </span>
      </div>
      {!saved && onSave && (
        <form className="zone-save" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name.trim()); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this zone to keep it" aria-label="Zone name" />
          <button className="btn small" disabled={!name.trim()}>Save zone</button>
        </form>
      )}
      {stats === "loading" && <div className="det empty"><span className="ld-line" />Balancing the zone's water</div>}
      {isErr(stats) && <div className="det empty">{stats.error}</div>}
      {ok && <ZoneBody z={ok} labels={labels} width={width} height={height} />}
      <div className="zone-edit" role="group" aria-label="Edit inside the zone">
        <span className="zone-edit-l">In this zone</span>
        <select value={crop} onChange={(e) => setCrop(e.target.value as Crop | "original")} aria-label="Crop to paint">
          {crops.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          <option value="original">Recorded land use</option>
        </select>
        <button className="btn small" onClick={() => onPaint(crop)}><Icon name="brush" size={12} />Paint</button>
        {reaches.length > 0 && onLine && <button className="btn small" onClick={onLine} title={reaches.join(", ")}><Icon name="channel" size={12} />Line {reaches.length} reach{reaches.length > 1 ? "es" : ""}</button>}
      </div>
    </div>
  );
}

function ZoneBody({ z, labels, width, height }: { z: ZoneStats; labels: string[]; width: number; height: number }) {
  const last = z.months[z.months.length - 1];
  const tin = z.budget_totals_ml.reduce((a, r) => a + r.in_ml, 0);
  return (
    <>
      <dl className="probe-figs">
        <div><dt>Area &lt; 2 m</dt><dd className={last.area_lt_2m_pct > last.baseline_area_lt_2m_pct + 0.05 ? "red" : ""}>{fmt(last.area_lt_2m_pct)}%</dd><dd className="muted">baseline {fmt(last.baseline_area_lt_2m_pct)}%</dd></div>
        <div><dt>Worst month</dt><dd>{fmt(Math.max(...z.months.map((m) => m.area_lt_2m_pct)))}%</dd><dd className="muted">baseline {fmt(Math.max(...z.months.map((m) => m.baseline_area_lt_2m_pct)))}%</dd></div>
        <div><dt>Median depth</dt><dd>{fmt(last.median_dtw_m, 2)} m</dd><dd className="muted" title="Mean water table against the baseline: + is higher (shallower)">water table {signed(-last.mean_change_m)} m</dd></div>
      </dl>
      <AreaChart z={z} labels={labels} width={width} height={Math.max(110, height * 0.36)} />
      <div className="det-sub">Zone budget, 24 months, ML <span className="muted">balance {fmt(z.discrepancy_pct, 2)}%</span></div>
      <table className="schedule"><thead><tr><th>Component</th><th className="n">In</th><th className="n">Out</th><th className="n">Share in</th></tr></thead>
        <tbody>{z.budget_totals_ml.map((r) => <tr key={r.component}><td>{r.component}</td><td className="n">{fmt(r.in_ml, 0)}</td><td className="n">{fmt(r.out_ml, 0)}</td>
          <td className="n muted">{r.in_ml ? `${Math.round((100 * r.in_ml) / tin)}%` : ""}</td></tr>)}</tbody></table>
    </>
  );
}

function AreaChart({ z, labels, width, height }: { z: ZoneStats; labels: string[]; width: number; height: number }) {
  const pad = { l: 38, r: 10, t: 12, b: 22 }, W = width - pad.l - pad.r, H = height - pad.t - pad.b, m = z.months;
  const vals = m.flatMap((x) => [x.area_lt_2m_pct, x.baseline_area_lt_2m_pct]);
  const y0 = Math.max(0, Math.floor(Math.min(...vals) - 1)), y1 = Math.min(100, Math.ceil(Math.max(...vals) + 1));
  const X = (i: number) => pad.l + (i / Math.max(1, m.length - 1)) * W, Y = (v: number) => pad.t + (1 - (v - y0) / Math.max(1e-9, y1 - y0)) * H;
  const line = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const ticks = [y0, (y0 + y1) / 2, y1];
  return (
    <svg width={width} height={height} className="hydro" role="img" aria-label="Share of the zone within 2 m, by month">
      {ticks.map((t) => <g key={t}><line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--hair)" strokeWidth="0.6" /><text x={pad.l - 5} y={Y(t) + 3.5} className="tick" textAnchor="end">{t.toFixed(0)}%</text></g>)}
      <path d={line(m.map((x) => x.baseline_area_lt_2m_pct))} fill="none" stroke="var(--ink)" strokeWidth="1" strokeDasharray="4 3" />
      <path d={line(m.map((x) => x.area_lt_2m_pct))} fill="none" stroke="var(--water-ink)" strokeWidth="1.8" />
      {m.map((x, i) => (i % 4 === 0 ? <text key={i} x={X(i)} y={height - 6} className="tick" textAnchor="middle">{(labels[x.period] ?? x.month).slice(2)}</text> : null))}
      <text x={width - pad.r} y={pad.t + 9} className="tick" textAnchor="end">share within 2 m · dashed baseline</text>
    </svg>
  );
}
