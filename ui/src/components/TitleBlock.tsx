import type { PersistStatus } from "../types";
import { Icon } from "./Icon";

export type Figure = { label: string; value: string; delta?: string | null; range?: string | null };
type Props = {
  title: string; subtitle: string; figures: Figure[]; drawn: string; checked: string; engine: string; runId: string | null;
  date: string; rev: string; status: PersistStatus | null; persisted: boolean; busy: boolean; onIssue?: () => void;
  issueLabel: string; dirty?: boolean; progress?: string; progressFrac?: number; onEnsemble?: () => void; ensembleOpen?: boolean; nextRev?: string; revisions: number; onAck?: () => void; runLabel: string; onRunLabel?: (v: string) => void;
};

/** The sheet's title block: the run record, with every figure carrying its change vs baseline. */
export default function TitleBlock(p: Props) {
  const filed = (ok: boolean | undefined, label: string, href?: string) => (
    <span className={`filed ${ok === undefined ? "wait" : ok ? "" : "bad"}`}>
      {href && ok ? <a href={href} target="_blank" rel="noreferrer">{label}<Icon name="ext" size={11} /></a> : label}
      {ok === undefined ? " …" : ok ? "" : " failed"}
    </span>
  );
  return (
    <section className="tb" aria-label="Title block">
      <div className="tb-title">
        <div className="tb-name">{p.title}</div>
        <div className="tb-sub">{p.subtitle}</div>
      </div>
      <div className="tb-issue">
        {p.onRunLabel && <input className="tb-label" value={p.runLabel} onChange={(e) => p.onRunLabel!(e.target.value)} placeholder="Name this run (optional)" aria-label="Run name" />}
        {p.onIssue && (
          <button className={`issue ${p.dirty ? "go" : ""}`} onClick={p.onIssue} disabled={p.busy} title="Run MODFLOW 6 and file the result (⌘↵)">
            <span className="issue-main"><Icon name="play" size={13} />{p.busy ? "Running…" : p.issueLabel}</span>
            <span className="issue-sub">{p.busy ? p.progress ?? "Solving MODFLOW 6" : `Adds rev ${p.nextRev ?? p.rev.replace(" (next)", "")} to the record`}</span>
            {p.busy && (p.progressFrac != null ? <span className="issue-prog" style={{ transform: `scaleX(${p.progressFrac})` }} /> : <span className="issue-bar" />)}
          </button>
        )}
        {p.onEnsemble && (
          <button className="tb-ens" onClick={p.onEnsemble} title="Run this scenario many times with uncertain parameters on serverless Spark">
            <Icon name="spread" size={12} /><span>{p.ensembleOpen ? "Another ensemble" : "Run as an ensemble"}</span><Icon name="chevron" size={10} /></button>
        )}
      </div>
      <div className="tb-figs">
        {p.figures.map((f) => (
          <div key={f.label} className="tb-cell">
            <div className="tb-l">{f.label}</div>
            <div className="tb-v num">{f.value}{f.delta && <span className={`tb-d ${f.delta === "±0" ? "zero" : ""}`}>{f.delta}</span>}{f.range && <span className="tb-r">{f.range}</span>}</div>
          </div>
        ))}
      </div>
      <div className="tb-meta">
        <div className="tb-cell"><div className="tb-l">Modeller</div><div className="tb-v">{p.drawn}</div></div>
        <div className="tb-cell"><div className="tb-l">Fit to bores, RMSE</div><div className="tb-v num">{p.checked}</div></div>
        <div className="tb-cell"><div className="tb-l">Engine</div><div className="tb-v num">{p.engine}</div></div>
        <div className="tb-cell"><div className="tb-l">Run ID</div><div className="tb-v num">{p.runId ?? <span className="muted">not filed</span>}</div></div>
        <div className="tb-cell"><div className="tb-l">Date</div><div className="tb-v num">{p.date}</div></div>
        <div className="tb-cell"><div className="tb-l">Rev</div><div className="tb-v num">{p.rev}</div></div>
      </div>
      <div className="tb-foot">
        {p.persisted && p.runId ? (
          <span className="tb-filed">Filed: {filed(p.status?.volume?.ok, "model files", p.status?.volume?.ok ? `/api/runs/${p.runId}/archive` : undefined)} · {filed(p.status?.uc?.ok, "Unity Catalog")} · {filed(p.status?.mlflow?.ok, "MLflow", p.status?.mlflow?.url)}</span>
        ) : <span className="tb-filed muted">Preview only. Run and file to add it to the record.</span>}
        {p.revisions > 0 && p.onAck && <button className="link red" onClick={p.onAck}>Clear the change marks</button>}
      </div>
    </section>
  );
}
