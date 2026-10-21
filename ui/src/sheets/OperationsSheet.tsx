import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import type { FieldNote, Outlook, OutlookBore } from "../types";

const SEASONS = ["dry", "average", "wet"] as const;
const SEASON_LABEL: Record<string, string> = { dry: "Dry year", average: "Average year", wet: "Wet year" };
const fmt = (v: number | null | undefined, d = 2) => (v == null ? "–" : v.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d }));
const when = (t: string) => new Date(t).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const STATUS: Record<string, string> = { noted: "Noted", acknowledged: "Acknowledged", inspect: "Inspection booked", resolved: "Resolved" };

/** The latest seasonal outlook for operations, served from Lakebase, with field notes written back to it. */
export default function OperationsSheet({ onShow, genieUrl }: { onShow: (runId: string, bore?: string) => void; genieUrl?: string }) {
  const [o, setO] = useState<Outlook | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [season, setSeason] = useState<string>("dry");
  const [draft, setDraft] = useState<{ bore: string; status: string; note: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => { api.outlook().then((x) => { setO(x); setErr(null); }).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { load(); const t = window.setInterval(load, 30000); return () => window.clearInterval(t); }, [load]);

  const bores = useMemo(() => (o?.bores ?? []).filter((b) => b.season === season), [o, season]);
  const reaches = useMemo(() => (o?.reaches ?? []).filter((r) => r.season === season).slice(0, 8), [o, season]);
  const notesFor = (b: string) => (o?.notes ?? []).filter((n) => n.bore_id === b);
  const run = bores[0] ?? reaches[0];
  const have = new Set((o?.bores ?? []).map((b) => b.season));
  const counts = (s: string) => (o?.bores ?? []).filter((b) => b.season === s && b.risk !== "normal").length;

  const save = async () => {
    if (!draft?.note.trim()) return;
    setSaving(true);
    try { await api.addNote(draft.bore, season, draft.status, draft.note); setDraft(null); load(); }
    catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <div className="register ops">
      <header className="reg-head">
        <div><h1>Operations</h1><p>The latest seasonal outlook: monitoring bores ranked by shallow water-table risk and the leakiest supply-channel
          reaches, for each season. Refreshed by the outlook job when new telemetry lands, and served from Lakebase.</p></div>
        <div className="ops-acts">
          {genieUrl && <a className="btn small" href={genieUrl} target="_blank" rel="noreferrer"><Icon name="chat" size={12} />Ask Genie</a>}
          <button className="btn small" onClick={load}>Refresh</button>
        </div>
      </header>
      {err && <p className="red">{err}</p>}
      {o && !o.available && <p className="muted">{o.reason ?? "Lakebase is not set up for this install."}</p>}
      {o?.available && !o.bores.length && (
        <p className="muted">No outlook yet. {o.reason ? `(${o.reason}) ` : ""}It appears after the outlook job has run: drop new telemetry into the
          landing volume, or run the job from Lakeflow Jobs.</p>
      )}
      {o?.available && o.bores.length > 0 && (
        <>
          <div className="ops-bar">
            <div className="seg" role="radiogroup" aria-label="Season">
              {SEASONS.map((s) => (
                <button key={s} role="radio" aria-checked={season === s} className={season === s ? "on" : ""} disabled={!have.has(s)} onClick={() => setSeason(s)}>
                  {SEASON_LABEL[s]}{have.has(s) && counts(s) > 0 && <span className="ops-count">{counts(s)}</span>}
                </button>
              ))}
            </div>
            {run && <span className="muted small">{run.run_label} · filed {when(run.run_at)} · <button className="link small" onClick={() => onShow(run.run_id)}>Open the run on the model</button></span>}
          </div>
          <div className="ops-cols">
            <section>
              <h2>Monitoring bores</h2>
              <table className="rev">
                <thead><tr><th>Bore</th><th>Risk</th><th className="n">Shallowest, m</th><th className="n">Final, m</th><th className="n">Months within 2 m</th><th>Field notes</th><th /></tr></thead>
                <tbody>
                  {bores.map((b: OutlookBore) => {
                    const ns = notesFor(b.bore_id);
                    return (
                      <tr key={b.bore_id} className={`risk-${b.risk}`}>
                        <td><b>{b.bore_id}</b></td>
                        <td><span className={`ops-risk ${b.risk}`}>{b.risk}</span></td>
                        <td className="n">{fmt(b.min_depth_m)}</td><td className="n">{fmt(b.final_depth_m)}</td><td className="n">{b.months_within_2m}</td>
                        <td className="wrap small">{ns.length ? <span title={ns.map((n: FieldNote) => `${STATUS[n.status] ?? n.status}: ${n.note} (${n.author.split("@")[0]})`).join("\n")}>
                          {STATUS[ns[0].status] ?? ns[0].status} · {ns[0].note.slice(0, 60)}{ns.length > 1 ? ` (+${ns.length - 1})` : ""}</span> : <span className="muted">–</span>}</td>
                        <td className="ops-row-acts">
                          <button className="link small" onClick={() => onShow(b.run_id, b.bore_id)}>Hydrograph</button>
                          <button className="link small" onClick={() => setDraft({ bore: b.bore_id, status: b.risk === "high" ? "inspect" : "acknowledged", note: "" })}>Add note</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {draft && (
                <div className="ops-note">
                  <b>Note on {draft.bore}</b>
                  <div className="seg quiet" role="radiogroup" aria-label="Status">
                    {Object.entries(STATUS).map(([k, v]) => <button key={k} role="radio" aria-checked={draft.status === k} className={draft.status === k ? "on" : ""} onClick={() => setDraft({ ...draft, status: k })}>{v}</button>)}
                  </div>
                  <textarea rows={2} autoFocus value={draft.note} placeholder="What was seen or decided" onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
                  <div className="row"><button className="btn small" onClick={() => setDraft(null)}>Cancel</button><button className="btn small ink" disabled={saving || !draft.note.trim()} onClick={save}>{saving ? "Saving…" : "Save note"}</button></div>
                </div>
              )}
            </section>
            <section>
              <h2>Leakiest channel reaches</h2>
              <table className="rev">
                <thead><tr><th className="n">#</th><th>Reach</th><th className="n">Seepage, ML</th><th>Lined</th></tr></thead>
                <tbody>{reaches.map((r) => <tr key={r.reach}><td className="n">{r.seepage_rank}</td><td><b>{r.reach}</b></td><td className="n">{fmt(r.seepage_ml, 0)}</td><td>{r.lined ? "yes" : "no"}</td></tr>)}</tbody>
              </table>
              <h2>Recent field notes</h2>
              {(o.notes ?? []).length ? (
                <ol className="ops-notes">
                  {o.notes.slice(0, 8).map((n) => <li key={n.note_id}><b>{n.bore_id}</b> · {STATUS[n.status] ?? n.status} · {n.note}<div className="muted small">{n.author.split("@")[0]}, {when(n.created_at)}</div></li>)}
                </ol>
              ) : <p className="muted small">None yet.</p>}
            </section>
          </div>
          <p className="muted small ops-src">Served from Lakebase: synced from the gold outlook tables in Unity Catalog ({o.schema}); notes are written to Postgres by the app.</p>
        </>
      )}
    </div>
  );
}
