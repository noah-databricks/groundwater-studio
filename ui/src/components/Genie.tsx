import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { GenieAnswer } from "../types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

const SAMPLES = [
  "Which filed runs cut the area within 2 m of the surface the most, and by how much?",
  "Which monitoring bores are most at risk in the dry-year outlook?",
  "How much channel seepage did lining MC-05 save over the simulation?",
  "What did the latest ensemble give for the share within 2 m, P10 to P90?",
];

const cell = (v: string | null) => {
  if (v == null) return "–";
  const n = Number(v);
  return v !== "" && Number.isFinite(n) && !/^\d{4}-\d{2}/.test(v) ? n.toLocaleString("en-AU", { maximumFractionDigits: 2 }) : v;
};

/** Genie's answer: what it said, the SQL it wrote and ran as you, and the rows it got back. */
export function GenieResult({ a, maxRows = 50, sqlOpen = false }: { a: GenieAnswer; maxRows?: number; sqlOpen?: boolean }) {
  if (a.status === "pending") return <p className="muted small gn-pending"><span className="ag-spin" /> Genie is working on it</p>;
  if (a.error) return <p className="red small">Genie could not answer: {a.error}</p>;
  const rows = (a.rows ?? []).slice(0, maxRows), cols = a.columns ?? [];
  const num = cols.map((_, j) => rows.length > 0 && rows.every((r) => r[j] == null || (r[j] !== "" && Number.isFinite(Number(r[j])) && !/^\d{4}-\d{2}/.test(String(r[j])))));
  return (
    <div className="gn-res">
      {a.text && <div className="gn-text"><Markdown text={a.text} /></div>}
      {cols.length > 0 && (
        <div className="gn-table">
          <table className="rev">
            <thead><tr>{cols.map((c, j) => <th key={c} className={num[j] ? "n" : ""}>{c.replace(/_/g, " ")}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={num[j] ? "n" : ""}>{cell(v)}</td>)}</tr>)}</tbody>
          </table>
          {(a.row_count ?? 0) > rows.length && <p className="muted small">First {rows.length} of {a.row_count} rows</p>}
        </div>
      )}
      {a.sql && (
        <details className="gn-sql" open={sqlOpen}>
          <summary>SQL Genie ran as you{a.query_description ? `: ${a.query_description}` : ""}</summary>
          <pre>{a.sql}</pre>
        </details>
      )}
    </div>
  );
}

type Turn = { q: string; a: GenieAnswer | null; err?: string };

/** Ask the district's Genie Agent about what is on record. Separate from the modelling agent, same governed tables. */
export function GeniePanel({ url }: { url?: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const conv = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [turns]);

  const settle = async (i: number, a: GenieAnswer) => {
    let cur = a;
    for (let n = 0; cur.status === "pending" && n < 12; n++) {
      setTurns((t) => t.map((x, k) => (k === i ? { ...x, a: cur } : x)));
      cur = await api.geniePoll(cur.conversation_id, cur.message_id);
    }
    setTurns((t) => t.map((x, k) => (k === i ? { ...x, a: cur } : x)));
  };
  const ask = async (q: string) => {
    q = q.trim();
    if (!q || busy) return;
    setBusy(true); setText("");
    const i = turns.length;
    setTurns((t) => [...t, { q, a: null }]);
    try {
      const a = await api.genieAsk(q, conv.current);
      conv.current = a.conversation_id;
      await settle(i, a);
    } catch (e) {
      setTurns((t) => t.map((x, k) => (k === i ? { ...x, err: (e as Error).message } : x)));
    } finally { setBusy(false); }
  };
  const fresh = () => { conv.current = null; setTurns([]); };

  return (
    <div className="gn">
      <div className="gn-head">
        <div>
          <h2>Ask Genie</h2>
          <p className="muted">Questions about what is on record: runs, ensembles, studies, the seasonal outlook and the telemetry.
            Genie writes the SQL and runs it as you, under your Unity Catalog access. To test a change, run a scenario or ask the agent.</p>
        </div>
        <div className="gn-acts">
          {turns.length > 0 && <button className="btn small" onClick={fresh}>New conversation</button>}
          {url && <a className="btn small" href={url} target="_blank" rel="noreferrer"><Icon name="ext" size={12} />Open in Genie</a>}
        </div>
      </div>
      {!turns.length && (
        <div className="gn-samples">
          {SAMPLES.map((q) => <button key={q} className="gn-sample" onClick={() => void ask(q)}>{q}</button>)}
        </div>
      )}
      <div className="gn-turns">
        {turns.map((t, i) => (
          <div key={i} className="gn-turn">
            <div className="gn-q">{t.q}</div>
            {t.err ? <p className="red small">{t.err}</p> : t.a ? <GenieResult a={t.a} /> : <p className="muted small gn-pending"><span className="ag-spin" /> Asking Genie</p>}
            {t.a?.suggested_questions && i === turns.length - 1 && !busy && (
              <div className="gn-follow">{t.a.suggested_questions.map((q) => <button key={q} className="gn-sample small" onClick={() => void ask(q)}>{q}</button>)}</div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="gn-ask" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={turns.length ? "Ask a follow-up" : "Ask about runs, the outlook or the telemetry"} aria-label="Question for Genie" disabled={busy} />
        <button className="btn ink" disabled={busy || !text.trim()}>{busy ? "Asking…" : "Ask"}</button>
      </form>
    </div>
  );
}
