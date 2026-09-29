import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Task, UserFiles } from "../types";
import { Icon } from "./Icon";

type Cand = { name: string; label: string; lower: number; upper: number; default: boolean };
type CalResult = {
  method: string; parameters: { name: string; label: string; multiplier: number; lower: number; upper: number; post_lower?: number; post_upper?: number; band?: string; sensitivity?: number; at_bound: boolean }[];
  fit_before: { rmse_m: number; n: number } | null; fit_after: { rmse_m: number; mean_residual_m: number; max_abs_residual_m: number; n: number } | null;
  residuals: { name: string; time: number; observed: number; simulated: number; residual: number }[]; objective_by_iteration: { iteration: number; phi: number }[];
  folder: string; seconds: number; agents: number; observations: number;
};
const x = (v: number) => (v >= 100 || v < 0.01 ? v.toExponential(1) : +v.toPrecision(3)).toString();

/** PEST++ calibration of the open package: observed heads, the multipliers to fit, GLM or IES, then the result. */
export default function Calibration({ name, files, onFilesChanged, onOpenModel, folderUrl }: {
  name: string; files: UserFiles | null; onFilesChanged: () => void; onOpenModel: (pkg: string) => void; folderUrl: (path: string) => string;
}) {
  const [cands, setCands] = useState<Cand[] | { error: string } | null>(null);
  const [pick, setPick] = useState<Record<string, { on: boolean; lower: number; upper: number }>>({});
  const [obs, setObs] = useState("");
  const [method, setMethod] = useState<"glm" | "ies">("glm");
  const [iters, setIters] = useState(8), [reals, setReals] = useState(40);
  const [task, setTask] = useState<Task | null>(null), [res, setRes] = useState<CalResult | null>(null), [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setCands(null); setRes(null); setTask(null);
    api.calParams(name).then((c) => { setCands(c); setPick(Object.fromEntries(c.map((p) => [p.name, { on: p.default, lower: p.lower, upper: p.upper }]))); })
      .catch((e) => setCands({ error: e.message }));
  }, [name]);
  useEffect(() => {
    if (!task || task.status !== "running") return;
    const t = window.setInterval(async () => {
      const nt = await api.task(task.task_id).catch(() => null);
      if (!nt) return;
      setTask(nt);
      if (nt.status === "finished") setRes(await api.taskResult(nt.task_id) as unknown as CalResult);
      if (nt.status === "failed") setErr(nt.error);
    }, 2000);
    return () => window.clearInterval(t);
  }, [task]);
  const csvs = (files?.uploads ?? []).filter((u) => /\.(csv|txt)$/i.test(u.name));
  if (!cands) return <p className="bp-help">Reading what this model can calibrate…</p>;
  if ("error" in cands) return <p className="bp-help">{cands.error}</p>;
  const chosen = cands.filter((c) => pick[c.name]?.on);
  const start = async () => {
    setErr(null); setRes(null);
    try {
      const t = await api.calibrate({ name, observations_file: obs, method, iterations: iters, realizations: reals,
        parameters: chosen.map((c) => ({ name: c.name, lower: pick[c.name].lower, upper: pick[c.name].upper })) });
      setTask(t as unknown as Task);
    } catch (e) { setErr((e as Error).message); }
  };
  const running = task?.status === "running";
  return (
    <div className="cal">
      <div className="cal-sec">
        <div className="scale-lab"><span>Observed heads</span>
          <button className="link small" onClick={() => file.current?.click()}><Icon name="up" size={11} /> Upload CSV</button>
          <input ref={file} type="file" accept=".csv,.txt" hidden onChange={async (e) => {
            const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
            try { const r = await api.agentUpload(f); onFilesChanged(); setObs(r.name); } catch (er) { setErr((er as Error).message); }
          }} /></div>
        <select value={obs} onChange={(e) => setObs(e.target.value)} className="bp-sel" aria-label="Observation file">
          <option value="">Choose a CSV from your uploads…</option>
          {csvs.map((u) => <option key={u.path} value={u.name}>{u.name}</option>)}
        </select>
        <p className="bp-help">Columns: name, layer, row, col (1-based, as in MODFLOW files), time (model time since the start), head, and optionally weight.</p>
      </div>
      <div className="cal-sec">
        <div className="scale-lab"><span>Parameters, as multipliers on today's values</span></div>
        <table className="lu-t cal-p"><thead><tr><th /><th>Parameter</th><th className="n">From ×</th><th className="n">To ×</th></tr></thead>
          <tbody>{cands.map((c) => (
            <tr key={c.name} className={pick[c.name]?.on ? "" : "muted"}>
              <td><input type="checkbox" checked={!!pick[c.name]?.on} onChange={(e) => setPick((p) => ({ ...p, [c.name]: { ...p[c.name], on: e.target.checked } }))} aria-label={`Calibrate ${c.label}`} /></td>
              <td>{c.label}</td>
              <td className="n"><input type="number" step={0.1} min={0.001} value={pick[c.name]?.lower ?? c.lower} onChange={(e) => setPick((p) => ({ ...p, [c.name]: { ...p[c.name], lower: +e.target.value } }))} /></td>
              <td className="n"><input type="number" step={0.5} min={0.001} value={pick[c.name]?.upper ?? c.upper} onChange={(e) => setPick((p) => ({ ...p, [c.name]: { ...p[c.name], upper: +e.target.value } }))} /></td>
            </tr>))}</tbody></table>
      </div>
      <div className="cal-sec cal-run">
        <div className="seg quiet" role="radiogroup" aria-label="Method">
          <button role="radio" aria-checked={method === "glm"} className={method === "glm" ? "on" : ""} onClick={() => setMethod("glm")} title="Gauss-Levenberg-Marquardt: calibrated values, sensitivities, first-order uncertainty">GLM</button>
          <button role="radio" aria-checked={method === "ies"} className={method === "ies" ? "on" : ""} onClick={() => setMethod("ies")} title="Iterative ensemble smoother: a posterior ensemble, better for many parameters">IES</button>
        </div>
        <label className="bt-num"><span>Iterations</span><input type="number" min={1} max={50} value={iters} onChange={(e) => setIters(+e.target.value)} style={{ width: 46 }} /></label>
        {method === "ies" && <label className="bt-num"><span>Ensemble</span><input type="number" min={10} max={500} value={reals} onChange={(e) => setReals(+e.target.value)} style={{ width: 52 }} /></label>}
        <button className="btn small ink" disabled={running || !obs || !chosen.length} onClick={() => void start()}>{running ? "Calibrating…" : "Calibrate with PEST++"}</button>
      </div>
      {running && task && <div className="cal-prog"><span className="ld-line" />{task.stage} · {Math.round(task.elapsed_s ?? 0)} s</div>}
      {err && <p className="bp-help red">{err}</p>}
      {res && (
        <div className="cal-res">
          <dl className="probe-figs">
            <div><dt>Fit before</dt><dd>{res.fit_before ? `${res.fit_before.rmse_m.toFixed(3)} m` : "–"}</dd><dd className="muted">RMSE, {res.observations} obs</dd></div>
            <div><dt>Fit after</dt><dd>{res.fit_after ? `${res.fit_after.rmse_m.toFixed(3)} m` : "–"}</dd><dd className="muted">worst {res.fit_after?.max_abs_residual_m.toFixed(2)} m</dd></div>
          </dl>
          <table className="lu-t cal-p"><thead><tr><th>Parameter</th><th className="n">Calibrated</th><th className="n">{res.method === "ies" ? "P10–P90" : "95% band"}</th></tr></thead>
            <tbody>{res.parameters.map((p) => (
              <tr key={p.name}><td>{p.label}{p.at_bound && <span className="red" title="At its bound: the observations push it past the range you allowed"> · at bound</span>}</td>
                <td className="n num">×{x(p.multiplier)}</td>
                <td className="n num muted" title={p.post_lower != null && p.post_upper != null && p.post_upper / p.post_lower > 10 ? "Wide: the observations barely constrain this parameter" : p.band}>
                  {p.post_lower != null ? `×${x(p.post_lower)}–${x(p.post_upper!)}` : "–"}{p.post_lower != null && p.post_upper! / p.post_lower > 10 ? " · weak" : ""}</td></tr>
            ))}</tbody></table>
          <div className="cal-acts">
            <button className="btn small ink" disabled={saving} onClick={async () => {
              setSaving(true);
              try { const r = await api.calApply({ name, task_id: task!.task_id }); onFilesChanged(); onOpenModel(r.package); } catch (e) { setErr((e as Error).message); }
              setSaving(false);
            }}>{saving ? "Saving…" : "Save a calibrated copy"}</button>
            <a className="link small" href={folderUrl(res.folder)} target="_blank" rel="noreferrer"><Icon name="ext" size={11} /> PEST++ files</a>
            <span className="muted small">{Math.round(res.seconds)} s · {res.agents} agents</span>
          </div>
        </div>
      )}
    </div>
  );
}
