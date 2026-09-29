import { useEffect, useState } from "react";
import { api, type EnsembleRow, type JobRow } from "../api";
import type { Me } from "../types";
import { Icon } from "../components/Icon";

const fmt = (v: number | null | undefined, d = 1) => (v == null ? "–" : v.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d }));
const ACTIVE = ["PENDING", "QUEUED", "RUNNING", "BLOCKED", "TERMINATING"];

/** Every ensemble: what it was of, how many realizations were kept, the range of the result, and a way onto the model. */
export default function EnsemblesTable({ me, onOpen, onOpenStudy }: { me: Me | null; onOpen: (id: string) => void; onOpenStudy: (id: string) => void }) {
  const [d, setD] = useState<{ completed: EnsembleRow[]; jobs: JobRow[] } | null>(null), [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.ensembles().then((x) => live && setD(x)).catch((e) => live && setErr(e.message));
    load(); const t = window.setInterval(load, 15000);
    return () => { live = false; window.clearInterval(t); };
  }, []);
  const running = d?.jobs.filter((j) => ACTIVE.includes(j.life_cycle) && j.ensemble_id) ?? [];
  return (
    <>
      <div className="st-bar"><h2>Ensembles</h2></div>
      <p className="st-intro">Each ensemble solves one scenario many times with uncertain parameters, keeps the realizations that fit the observed bore levels, and weights them by fit. Run one from the Model sheet (under Run and file) or ask the agent.</p>
      {err && <p className="red">{err}</p>}
      <table className="rev">
        <thead><tr><th>Ensemble</th><th>Filed</th><th className="n">Kept</th><th className="n">Area &lt; 2 m</th><th className="n">P10–P90</th><th className="n">Peak month</th><th /></tr></thead>
        <tbody>
          {running.map((j) => (
            <tr key={j.job_run_id} className="muted"><td className="rg-run"><span>{j.label || j.ensemble_id}</span><span className="rg-sub">{j.life_cycle.toLowerCase()} on serverless Spark</span></td>
              <td className="rg-filed"><span>{j.run_by?.split("@")[0]}</span></td><td className="n">{j.n}</td><td /><td /><td />
              <td className="rg-acts"><a href={j.url} target="_blank" rel="noreferrer"><Icon name="ext" size={13} />Job</a></td></tr>
          ))}
          {d?.completed.map((e) => (
            <tr key={e.ensemble_id}>
              <td className="rg-run"><button className="rg-open" onClick={() => onOpen(e.ensemble_id)} title="Open this ensemble on the model">{e.label || e.ensemble_id}</button>
                <span className="rg-sub">{e.scenario_name ?? "unsaved scenario"}{e.study_id && <> · <button className="link small" onClick={() => onOpenStudy(e.study_id!)}>study</button></>}</span></td>
              <td className="rg-filed"><span>{e.run_by?.split("@")[0]}</span><span className="rg-sub">{new Date(e.created_at.replace(" ", "T") + "Z").toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span></td>
              <td className="n">{e.n_behavioural}/{e.n_realizations}</td><td className="n">{fmt(e.mean_pct_area_dtw_lt_2m)}%</td>
              <td className="n">{e.p10_pct_area_dtw_lt_2m != null ? `${fmt(e.p10_pct_area_dtw_lt_2m)}–${fmt(e.p90_pct_area_dtw_lt_2m)}` : `–${fmt(e.p90_pct_area_dtw_lt_2m)}`}</td>
              <td className="n">{e.peak_mean_pct_area_dtw_lt_2m != null ? `${fmt(e.peak_mean_pct_area_dtw_lt_2m)}%` : "–"}</td>
              <td className="rg-acts">
                <button className="link small" onClick={() => onOpen(e.ensemble_id)}><Icon name="cube" size={13} />On model</button>
                {e.mlflow_run_id && me && <a href={`${me.host}/ml/experiments/${me.experiment_id}/runs/${e.mlflow_run_id}`} target="_blank" rel="noreferrer"><Icon name="ext" size={13} />MLflow</a>}
              </td>
            </tr>
          ))}
          {d && !d.completed.length && !running.length && <tr><td colSpan={7} className="muted">No ensembles yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
