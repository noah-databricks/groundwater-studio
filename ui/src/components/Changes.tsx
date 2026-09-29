import { useMemo, useState } from "react";
import { diffLines, dump, fidelity, fidelityText, hunks, isNative, type SceneDiff } from "../lib/scenario";
import type { Scenario } from "../types";
import { Icon } from "./Icon";

export type Compare = {
  path: string; fromLabel: string; toLabel: string; from: Scenario; to: Scenario;
  summary?: string; by?: string; at?: string; restore?: { version: number };
};

const PARAMS: { key: keyof Scenario; label: string; fmt: (v: number) => string }[] = [
  { key: "rain_mult", label: "Rainfall", fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "deep_drainage_frac", label: "On-farm deep drainage", fmt: (v) => `${Math.round(v * 100)}% of applied` },
  { key: "et_mult", label: "Reference ET₀", fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "pumping_mult", label: "Licensed extraction", fmt: (v) => `${Math.round(v * 100)}% of metered` },
  { key: "k_mult", label: "Hydraulic conductivity", fmt: (v) => `×${v.toFixed(2)}` },
  { key: "sy", label: "Specific yield", fmt: (v) => v.toFixed(3) },
  { key: "canal_lining_pct", label: "Blanket channel lining", fmt: (v) => `${v}%` },
];
const CROP: Record<string, string> = { rice: "rice", broadacre: "broadacre", horticulture: "horticulture", pasture: "pasture", dryland: "dryland" };
const ha = (cells: number) => `${Math.round(cells * 6.25).toLocaleString("en-AU")} ha`;

/** What changed between two versions of a scenario, in the modeller's terms first, with the file diff one click away. */
export default function Changes({ c, scene, onRestore, height }: { c: Compare; scene: SceneDiff; onRestore?: () => void; height: number }) {
  const [showFile, setShowFile] = useState(false);
  const [full, setFull] = useState<Record<number, boolean>>({});
  const ops = useMemo(() => diffLines(dump(c.from).split("\n"), dump(c.to).split("\n")), [c.from, c.to]);
  const hs = useMemo(() => hunks(ops), [ops]);
  const add = ops.filter((o) => o.t === "+").length, del = ops.filter((o) => o.t === "-").length;

  // land use, grouped by what each cell was and became
  const moves = useMemo(() => {
    const m = new Map<string, number>();
    scene.cells.forEach((x) => m.set(`${x.from}→${x.to}`, (m.get(`${x.from}→${x.to}`) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [scene.cells]);
  const params = PARAMS.filter((p) => Math.abs((c.from[p.key] as number) - (c.to[p.key] as number)) > 1e-9);
  const fa = fidelity(c.from), fb = fidelity(c.to), fidChanged = JSON.stringify(fa) !== JSON.stringify(fb);
  const nothing = !moves.length && !params.length && !scene.lined.length && !scene.unlined.length && !scene.boresAdded.length && !scene.boresRemoved.length
    && !scene.drainsAdded.length && !scene.drainsRemoved.length && !fidChanged;

  return (
    <div className="det chg">
      <div className="chg-head">
        <div className="chg-title">
          <div className="chg-vs"><b>{c.fromLabel}</b><Icon name="chevron" size={11} /><b>{c.toLabel}</b></div>
          {c.summary && <div className="chg-msg">{c.summary}</div>}
          {(c.by || c.at) && <div className="chg-by">{[c.by?.split("@")[0].replace(".", " "), c.at && new Date(c.at).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })].filter(Boolean).join(" · ")}</div>}
        </div>
        {c.restore && onRestore && <button className="btn small" onClick={onRestore}>Restore v{c.restore.version}</button>}
      </div>

      <div className="chg-body" style={{ maxHeight: height }}>
        {nothing ? <p className="chg-none">No changes.</p> : (
          <ul className="chg-list">
            {moves.length > 0 && (
              <li><span className="chg-ic"><Icon name="brush" size={13} /></span>
                <div><b>Land use repainted, {ha(scene.cells.length)}</b>
                  <ul className="chg-sub">{moves.slice(0, 6).map(([k, n]) => { const [f, t] = k.split("→"); return <li key={k}><span className="num chg-ha">{ha(n)}</span>{CROP[f] ?? f} <Icon name="chevron" size={9} /> {CROP[t] ?? t}</li>; })}
                    {moves.length > 6 && <li className="muted">and {moves.length - 6} other changes</li>}</ul></div></li>
            )}
            {(scene.lined.length > 0 || scene.unlined.length > 0) && (
              <li><span className="chg-ic"><Icon name="channel" size={13} /></span>
                <div><b>Supply channels</b><ul className="chg-sub">
                  {scene.lined.length > 0 && <li><span className="chg-tag add">lined</span>{scene.lined.join(", ")}</li>}
                  {scene.unlined.length > 0 && <li><span className="chg-tag del">unlined</span>{scene.unlined.join(", ")}</li>}</ul></div></li>
            )}
            {(scene.boresAdded.length > 0 || scene.boresRemoved.length > 0) && (
              <li><span className="chg-ic"><Icon name="pin" size={13} /></span>
                <div><b>Proposed bores</b><ul className="chg-sub">
                  {scene.boresAdded.map((b, i) => <li key={`a${i}`}><span className="chg-tag add">added</span>row {b.row + 1}, col {b.col + 1}{"ML_per_year" in b ? `, ${Number((b as { ML_per_year: number }).ML_per_year).toLocaleString("en-AU")} ML/yr` : ""}</li>)}
                  {scene.boresRemoved.map((b, i) => <li key={`r${i}`}><span className="chg-tag del">removed</span>row {b.row + 1}, col {b.col + 1}</li>)}</ul></div></li>
            )}
            {(scene.drainsAdded.length > 0 || scene.drainsRemoved.length > 0) && (
              <li><span className="chg-ic"><Icon name="drain" size={13} /></span>
                <div><b>Interceptor drains</b><ul className="chg-sub">
                  {scene.drainsAdded.map((d) => <li key={`a${d.name}`}><span className="chg-tag add">added</span>{d.name}, {(d.cells.length * 0.25).toFixed(2)} km at {d.depth_m} m</li>)}
                  {scene.drainsRemoved.map((d) => <li key={`r${d.name}`}><span className="chg-tag del">removed</span>{d.name}</li>)}</ul></div></li>
            )}
            {params.length > 0 && (
              <li><span className="chg-ic"><Icon name="harness" size={13} /></span>
                <div><b>Parameters</b><ul className="chg-sub">
                  {params.map((p) => <li key={p.key}>{p.label} <span className="num chg-from">{p.fmt(c.from[p.key] as number)}</span> <Icon name="chevron" size={9} /> <span className="num chg-to">{p.fmt(c.to[p.key] as number)}</span></li>)}</ul></div></li>
            )}
            {fidChanged && (
              <li><span className="chg-ic"><Icon name="cube" size={13} /></span>
                <div><b>Resolution and solver</b><ul className="chg-sub"><li>{isNative(fa) ? "native 250 m" : fidelityText(fa)} <Icon name="chevron" size={9} /> {isNative(fb) ? "native 250 m" : fidelityText(fb)}</li></ul></div></li>
            )}
          </ul>
        )}

        <div className="chg-file">
          <button className="chg-file-h" onClick={() => setShowFile((v) => !v)} aria-expanded={showFile}>
            <Icon name="chevron" size={11} /><span className="num">{c.path.split("/").pop()}</span>
            <span className="chg-stat num"><span className="add">+{add}</span><span className="del">−{del}</span></span>
          </button>
          {showFile && (!add && !del ? <div className="chg-none">No changes to the file.</div> : (
            <div className="dv">
              {hs.map((h, i) => "skip" in h && !full[i] ? (
                <button key={i} className="dv-skip" onClick={() => setFull((f) => ({ ...f, [i]: true }))}>{h.skip} unchanged line{h.skip > 1 ? "s" : ""}</button>
              ) : (
                <div key={i}>
                  {"head" in h && <div className="dv-hunk num">{h.head}</div>}
                  {h.ops.map((o, j) => (
                    <div key={j} className={`dv-l ${o.t === "+" ? "add" : o.t === "-" ? "del" : ""}`}>
                      <span className="dv-n num">{o.t === "-" ? o.a ?? "" : o.b ?? ""}</span><span className="dv-s">{o.t === " " ? "" : o.t === "-" ? "−" : "+"}</span><span className="dv-c">{o.text}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
