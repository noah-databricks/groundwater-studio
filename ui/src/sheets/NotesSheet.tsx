import { useEffect, useState, type ReactNode } from "react";
import { api, type DataCatalog } from "../api";
import type { Me } from "../types";

/** Sheet 4: general notes, the way a drawing set states its assumptions and sources. */
export default function NotesSheet({ me }: { me: Me | null }) {
  const [d, setD] = useState<DataCatalog | null>(null), [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.data().then(setD).catch((e) => setErr(e.message)); }, []);
  const eng = me?.mf6_version?.replace("mf6: ", "") ?? "6.8.1";
  return (
    <div className="register notes">
      <header className="reg-head"><div><h1>Notes</h1></div></header>
      <div className="reg-cols">
        <ol className="gn">
          <li><b>Engine.</b> Simulations run the USGS MODFLOW {eng} executable unmodified. The binary is held in the Unity Catalog volume <code>mf6_bin</code> and fetched by the app at start-up ({me?.platform ?? "linux"}); FloPy writes and reads the model files.</li>
          <li><b>Data.</b> The Sample district model is assembled from Unity Catalog tables on every run: grid and aquifer properties, boundaries, bores, metered extraction, weather and observed bore levels. All data in this set is synthetic.</li>
          <li><b>Reading as the signed-in user.</b> Inputs are read on your behalf through the SQL warehouse (scope <code>sql</code>). Your grants, row filters and column masks apply. The app's service principal cannot read these tables.</li>
          <li><b>Filing.</b> An issued run is recorded by the app's service principal: model files zipped to the <code>model_runs</code> volume, heads and budgets to Delta tables stamped with your name, and parameters and metrics to MLflow.</li>
          <li><b>Project files.</b> Model packages and scenarios live in the <code>workspace</code> volume. Uploads, downloads, previews and deletes run as you (scope <code>files.files</code>), so the volume's grants decide who can read or change them.</li>
          <li><b>Uncertainty.</b> Ensembles run as a Lakeflow Job on serverless Spark, one MODFLOW realization per task, weighted against observed levels (GLUE). Results are written back to Unity Catalog.</li>
          <li><b>Conventions.</b> Heads in m AHD. Depth to water is measured below the land surface. Every view is drawn to scale: the km bar at the model's nearest corner reads true along both grid axes, and the vertical metre bar carries the stated exaggeration. Redline marks revisions, proposed bores and the section cut.</li>
        </ol>
        <section>
          <h2>Schedule of sources</h2>
          {err && <p className="red">{err}</p>}
          <table className="rev"><thead><tr><th>Table</th><th className="n">Rows</th><th>Description</th></tr></thead>
            <tbody>{d?.tables.map((t) => <tr key={t.table_name}><td><a href={t.url} target="_blank" rel="noreferrer">{t.table_name}</a></td><td className="n">{t.rows?.toLocaleString() ?? "–"}</td><td className="wrap">{t.comment}</td></tr>)}</tbody></table>
          <h2>Column masks, as read by {d?.read_as ?? "you"}</h2>
          <table className="rev"><thead><tr><th>Bore</th><th>Landholder</th><th>Licence</th><th className="n">Entitlement, ML</th></tr></thead>
            <tbody>{d?.masked_sample.map((r) => <tr key={r.bore_id}><td>{r.bore_id}</td><td className={r.landholder.includes("restricted") ? "muted" : ""}>{r.landholder.replace(/\*/g, "").trim()}</td><td className={r.licence_no.includes("restricted") ? "muted" : ""}>{r.licence_no.replace(/\*/g, "").trim()}</td><td className="n">{r.entitlement_ml?.toLocaleString()}</td></tr>)}</tbody></table>
          <p className="muted">Landholder identity and licence numbers are visible only to members of <code>groundwater_data_stewards</code>.</p>
        </section>
      </div>
      <Connect me={me} />
    </div>
  );
}

function Snippet({ children }: { children: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="snippet">
      <pre>{children}</pre>
      <button className="btn small" onClick={() => { navigator.clipboard?.writeText(children).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1400); }); }}>{done ? "Copied" : "Copy"}</button>
    </div>
  );
}

function Item({ title, children }: { title: string; children: ReactNode }) {
  return <div><h3>{title}</h3>{children}</div>;
}

/** The same MODFLOW OS the Studio drives, reached from agents, scripts, jobs and SQL. */
function Connect({ me }: { me: Me | null }) {
  const app = window.location.origin, host = me?.host ?? "https://<workspace>", fq = me ? `${me.catalog}.${me.schema}` : "<catalog>.<schema>";
  return (
    <section className="connect">
      <h2>Use MODFLOW OS from elsewhere</h2>
      <p>Everything the Studio does is also a tool, an API call and a job step. Each acts as whoever calls it, under their Unity Catalog grants, and files into the same tables, so work done by an agent or a job shows up here and in the Register.</p>
      <Item title="Agents, over MCP">
        <p>Genie Code, Claude Code, Codex, Omnigent and other agents connect to <code>{app}/mcp</code> with a workspace OAuth token. The server lists its tools and explains how to work with the model.</p>
        <Snippet>{`claude mcp add --transport http modflow ${app}/mcp \
  --header "Authorization: Bearer $(databricks auth token --host ${host} | jq -r .access_token)"`}</Snippet>
      </Item>
      <Item title="Scripts, over REST">
        <p>Describe a scenario as a base plus edits; the app resolves it to cells, runs MODFLOW 6 and files the run.</p>
        <Snippet>{`curl -s ${app}/api/v1/runs \
  -H "Authorization: Bearer $(databricks auth token --host ${host} | jq -r .access_token)" \
  -H "Content-Type: application/json" -d '{
    "scenario": {"base": "rice-off-the-shallow-flats", "set": {"rain_mult": 0.8}, "line_reaches": ["MC-04"]},
    "label": "Dry year with MC-04 lined"
  }'`}</Snippet>
      </Item>
      <Item title="Pipelines, as a Lakeflow Jobs task">
        <p>Add the <code>modflow-os-scenario-run</code> job as a task (Run Job) in any pipeline{me?.scenario_job_id ? <> (job <a href={`${host}/jobs/${me.scenario_job_id}`} target="_blank" rel="noreferrer">{me.scenario_job_id}</a>)</> : null}. It runs the same engine on serverless compute as the job's identity and publishes the result for downstream tasks as <code>{"{{tasks.<task>.values.run_id}}"}</code>.</p>
        <Snippet>{`- task_key: drought_scenario
  run_job_task:
    job_id: ${me?.scenario_job_id || "<modflow-os-scenario-run job id>"}
    job_parameters:
      scenario: '{"set": {"rain_mult": 0.7}, "line_reaches": ["MC-04", "MC-05"]}'
      label: Weekly drought check`}</Snippet>
      </Item>
      <Item title="Results, in Delta">
        <p>Every run, from any of these, lands in the same tables, keyed by <code>run_id</code> and optionally a <code>study_id</code>.</p>
        <Snippet>{`SELECT r.run_id, r.label, r.origin, r.pct_area_dtw_lt_2m, s.reach, s.seepage_ml
FROM ${fq}.model_runs r
JOIN ${fq}.run_reach_seepage s USING (run_id)
WHERE r.created_at > current_date() - INTERVAL 7 DAYS
ORDER BY r.created_at DESC`}</Snippet>
      </Item>
    </section>
  );
}
