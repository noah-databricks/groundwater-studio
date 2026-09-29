import { rev } from "../lib/rev";
import type { RunRow } from "../api";
import { source } from "../api";
import type { Me } from "../types";
import { Icon } from "../components/Icon";

const when = (t: string) => { const d = new Date(t.replace(" ", "T") + "Z"); return Number.isNaN(+d) ? t : d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); };
const fmt = (v: number | null | undefined, d = 1) => (v == null ? "–" : v.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d }));

/** Every filed run, newest first: a revision letter, who or what filed it, the headline figures and its files. */
export default function RegisterSheet({ runs, me, onLoadRun, onRefresh, onOpenStudy }: {
  runs: RunRow[]; me: Me | null; onLoadRun: (r: RunRow) => void; onRefresh: () => void; onOpenStudy: (id: string) => void;
}) {
  const letter = (i: number) => rev(runs.length - 1 - i);
  return (
    <>
      <div className="st-bar"><h2>All runs</h2><button className="btn small" onClick={onRefresh}>Refresh</button></div>
      <table className="rev">
        <thead><tr><th>Rev</th><th>Run</th><th>Filed</th><th className="n">Area &lt; 2 m</th><th className="n">Seepage GL</th><th className="n">Extraction GL</th><th className="n">Fit m</th><th /></tr></thead>
        <tbody>
          {runs.map((r, i) => (
            <tr key={r.run_id}>
              <td className="rev-l">{letter(i)}</td>
              <td className="rg-run">
                <button className="rg-open" onClick={() => onLoadRun(r)} title="Open this run on the model">{r.label || r.run_id}</button>
                <span className="rg-sub">
                  {r.scenario_name ? `${r.scenario_name.replace(/\.json$/, "").replace(/-/g, " ")} v${r.scenario_version}` : "unsaved scenario"}
                  {r.study_id && <> · <button className="link small" onClick={() => onOpenStudy(r.study_id!)}>study</button></>}
                </span>
              </td>
              <td className="rg-filed">
                <span className={`src src-${source(r.origin).kind}`}>{source(r.origin).label}</span>
                <span className="rg-sub">{r.run_by.split("@")[0]} · {when(r.created_at)}</span>
              </td>
              <td className="n">{fmt(r.pct_area_dtw_lt_2m)}%</td><td className="n">{fmt((r.canal_seepage_ml ?? 0) / 1000)}</td>
              <td className="n">{fmt((r.bore_extraction_ml ?? 0) / 1000)}</td><td className="n">{fmt(r.rmse_m, 2)}</td>
              <td className="rg-acts">
                {r.archive_path && <a href={`/api/runs/${r.run_id}/archive`} title="Download the MODFLOW 6 model files"><Icon name="down" size={13} />Files</a>}
                {r.mlflow_run_id && me && <a href={`${me.host}/ml/experiments/${me.experiment_id}/runs/${r.mlflow_run_id}`} target="_blank" rel="noreferrer" title="Open the MLflow run"><Icon name="ext" size={13} />MLflow</a>}
              </td>
            </tr>
          ))}
          {!runs.length && <tr><td colSpan={8} className="muted">Nothing filed yet. Run and file a scenario from the Model sheet, or ask the agent.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
