import { rev as revL } from "../lib/rev";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { api, source, type RunRow, type StudyDetail, type StudyRow } from "../api";

const fmt = (v: number | null | undefined, d = 1) => (v == null ? "–" : v.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d }));
const when = (t: string) => new Date(t).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export const ALL_RUNS = "all-runs";
export const ALL_ENSEMBLES = "all-ensembles";

/** The record: every filed run, and the studies that group runs around a question, whoever filed them. */
export default function StudiesSheet({ runs, open, onOpen, onLoadRun, register, ensembles, onOpenEnsemble, draftRequest = 0 }: {
  onOpenEnsemble: (id: string) => void; runs: RunRow[]; open: string | null; onOpen: (id: string | null) => void; onLoadRun: (r: RunRow) => void; register: ReactNode; ensembles: ReactNode; draftRequest?: number;
}) {
  const [list, setList] = useState<StudyRow[] | null>(null);
  const [d, setD] = useState<StudyDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; question: string } | null>(null);
  useEffect(() => { if (draftRequest) setDraft({ title: "", question: "" }); }, [draftRequest]);
  const refresh = useCallback(() => { api.studies().then((l) => { setList(l); setErr(null); }).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!open) onOpen(ALL_RUNS);
  }, [open, onOpen]);
  useEffect(() => {
    if (!open || open === ALL_RUNS || open === ALL_ENSEMBLES) { setD(null); return; }
    let live = true;
    const load = () => api.study(open).then((x) => live && setD(x)).catch((e) => live && setErr(e.message));
    load();
    const t = window.setInterval(load, 8000); // agents and jobs file into open studies while you watch
    return () => { live = false; window.clearInterval(t); };
  }, [open]);

  const rev = (id: string) => {
    const i = runs.findIndex((r) => r.run_id === id);
    return i < 0 ? id.slice(0, 6) : revL(runs.length - 1 - i);
  };
  const openRun = (id: string) => { const r = runs.find((x) => x.run_id === id); if (r) onLoadRun(r); };
  const create = async () => {
    if (!draft?.title.trim() || !draft.question.trim()) return;
    const s = await api.createStudy(draft.title.trim(), draft.question.trim());
    setDraft(null); refresh(); onOpen(s.study_id);
  };

  return (
    <div className="register studies">
      <header className="reg-head">
        <div><h1>Record</h1><p>Every run filed from the Studio, the agent, MCP clients and scheduled jobs. A study groups runs around one question, with the findings they support.</p></div>
        <button className="btn" onClick={() => setDraft({ title: "", question: "" })}>New study</button>
      </header>
      {err && <p className="red">{err}</p>}
      <div className="st-cols">
        <ol className="st-list" aria-label="Runs and studies">
          <li>
            <button className={open === ALL_RUNS ? "on" : ""} onClick={() => onOpen(ALL_RUNS)}>
              <span className="st-t"><Icon name="list" size={14} />All runs</span>
              <span className="st-m">{runs.length} filed · newest first</span>
            </button>
          </li>
          <li>
            <button className={open === ALL_ENSEMBLES ? "on" : ""} onClick={() => onOpen(ALL_ENSEMBLES)}>
              <span className="st-t"><Icon name="spread" size={14} />Ensembles</span>
              <span className="st-m">uncertainty for a scenario, on Spark</span>
            </button>
          </li>
          <li className="st-sec">Studies</li>
          {draft && (
            <li className="st-new">
              <input autoFocus placeholder="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              <textarea placeholder="The question the study answers" rows={3} value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} />
              <div className="row"><button className="btn small" onClick={() => setDraft(null)}>Cancel</button><button className="btn small ink" onClick={create}>Open study</button></div>
            </li>
          )}
          {list?.map((s) => (
            <li key={s.study_id}>
              <button className={open === s.study_id ? "on" : ""} onClick={() => onOpen(s.study_id)}>
                <span className="st-t">{s.title}</span>
                <span className="st-m"><span className={`st-status ${s.status}`}>{s.status}</span> · {s.n_runs} run{s.n_runs === 1 ? "" : "s"} · {s.n_findings} finding{s.n_findings === 1 ? "" : "s"} · {source(s.origin).label}</span>
              </button>
            </li>
          ))}
          {list && !list.length && !draft && <li className="muted st-empty">No studies yet. Open one here, or ask the agent a question that needs more than one run.</li>}
        </ol>
        {open === ALL_RUNS && <article className="st-detail wide">{register}</article>}
        {open === ALL_ENSEMBLES && <article className="st-detail wide">{ensembles}</article>}
        {d && open !== ALL_RUNS && open !== ALL_ENSEMBLES && (
          <article className="st-detail">
            <div className="st-q"><span className="st-k">Question</span><p>{d.study.question}</p>
              <div className="muted small">Opened by {d.study.created_by.split("@")[0]} via {source(d.study.origin).label}, {when(d.study.created_at)} · {d.study.study_id}</div></div>
            {d.study.conclusion && <div className="st-concl"><span className="st-k">Conclusion</span><p>{d.study.conclusion}</p></div>}
            <h2>Findings</h2>
            {d.findings.length ? (
              <ol className="gn st-f">
                {d.findings.map((f) => (
                  <li key={f.finding_id}>
                    <span className={`st-kind ${f.kind}`}>{f.kind}</span> {f.text}
                    <div className="st-cite">
                      {f.run_ids.map((id) => id.startsWith("ens-")
                        ? <button key={id} className="rev-chip" onClick={() => onOpenEnsemble(id)} title={`Open ensemble ${id} on the model sheet`}>Ensemble</button>
                        : <button key={id} className="rev-chip" onClick={() => openRun(id)} title={`Open run ${id} on the model sheet`}>Rev {rev(id)}</button>)}
                      <span className="muted small">{source(f.origin).label}, {when(f.created_at)}</span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className="muted">Nothing recorded yet.</p>}
            <h2>Runs filed against it</h2>
            <table className="rev">
              <thead><tr><th>Rev</th><th>Description</th><th>Source</th><th className="n">Area &lt; 2 m</th><th className="n">Seepage, GL</th><th className="n">Extraction, GL</th><th className="n">Fit, m</th><th /></tr></thead>
              <tbody>
                {d.runs.map((r) => (
                  <tr key={r.run_id}>
                    <td className="rev-l">{rev(r.run_id)}</td><td>{r.label || "–"}</td><td>{source(r.origin).label}</td>
                    <td className="n">{fmt(r.pct_area_dtw_lt_2m)}%</td><td className="n">{fmt((r.canal_seepage_ml ?? 0) / 1000)}</td>
                    <td className="n">{fmt((r.bore_extraction_ml ?? 0) / 1000)}</td><td className="n">{fmt(r.rmse_m, 2)}</td>
                    <td>{runs.some((x) => x.run_id === r.run_id) && <button className="link" onClick={() => openRun(r.run_id)}>Open</button>}</td>
                  </tr>
                ))}
                {!d.runs.length && <tr><td colSpan={8} className="muted">No runs filed against this study yet.</td></tr>}
              </tbody>
            </table>
          </article>
        )}
      </div>
    </div>
  );
}
