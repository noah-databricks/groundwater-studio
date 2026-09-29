import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatRef, Task } from "../types";
import { api, type AgentEnsemble, type AgentItem, type AgentOptions, type AgentSessionRow, type AgentSnapshot, type Elicitation } from "../api";
import { Icon } from "./Icon";
import { Markdown, filesIn } from "./Markdown";

type ModeId = "ask" | "auto" | "read";
const MODES: { id: ModeId; label: string; icon: string; help: string }[] = [
  { id: "ask", label: "Ask", icon: "ask", help: "Asks you before it saves, runs or files anything" },
  { id: "auto", label: "Auto", icon: "bolt", help: "Works without asking; everything it files carries your name" },
  { id: "read", label: "Read only", icon: "eye", help: "Looks and explains; cannot change the record" },
];
const HARNESS: Record<string, string> = { "claude-sdk": "Claude Agent SDK", codex: "Codex", pi: "Pi" };
/** Serving endpoint name to the model's own name: databricks-claude-sonnet-5 → Claude Sonnet 5, databricks-gpt-5-5 → GPT-5.5. */
const pretty = (m: string) => {
  const s = m.replace(/^databricks-/, ""), g = s.match(/^gpt-(\d+)(?:-(\d+))?(.*)$/);
  if (g) return `GPT-${g[1]}${g[2] ? `.${g[2]}` : ""}${g[3].replace(/-/g, " ")}`;
  return s.replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1").replace(/-/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
};
const PICK_KEY = "gs.agent.pick";
const toolName = (n?: string) => (n ?? "").split(/__|\./).pop() ?? "";
const STUDIO = "[Studio]";
const STARTERS = [
  "Which single channel reach would you line first to cut the area within 2 m of the surface, and by how much?",
  "Compare taking rice off the shallow flats against lining MC-05. Open a study and record what you find.",
  "Walk me through the baseline water budget. Where does the water table get its water?",
];
const ago = (t: number) => {
  const m = (Date.now() / 1000 - t) / 60;
  return m < 1 ? "now" : m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${Math.round(m / 60)} h` : new Date(t * 1000).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
};
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function parse(s?: string): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && "result" in v && typeof (v as { result: unknown }).result === "string") return parse((v as { result: string }).result) ?? v;
    return v;
  } catch { return null; }
}
const signed = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(d)}`;

export type Links = { onOpenRun: (id: string) => void; onOpenStudy: (id: string) => void; onOpenScenario: (name: string) => void; onOpenModel: (name: string) => void;
  folderUrl: (path: string) => string | undefined; onOpenEnsemble: (id: string) => void };
/** What the agent just did, for the Studio to follow on the model. `result` is absent while the call is in flight. */
export type Activity = { tool: string; args: Record<string, unknown>; result: Record<string, unknown> | null; first: boolean };

/** A run the agent filed: the same figures the title block shows, and a way onto the model. */
function RunCard({ res, args, shown, onOpen }: { res: Record<string, unknown>; args: Record<string, unknown>; shown: boolean; onOpen: () => void }) {
  const k = res.kpis as Record<string, { value: number; change: number }> | undefined;
  const a = k?.area_dtw_lt_2m_pct, s = k?.canal_seepage_gl, d = k?.median_dtw_m;
  const title = String(args.label || res.description || "Scenario run");
  return (
    <div className="ag-card">
      <div className="ag-card-h">
        <span className="ag-card-ic"><Icon name="play" size={11} /></span>
        <span className="ag-card-t" title={title}>{title}</span>
      </div>
      {a && (
        <dl className="ag-figs">
          <div><dt>Area &lt; 2 m</dt><dd className="num">{a.value.toFixed(1)}%<span className={a.change < 0 ? "good" : a.change > 0 ? "bad" : ""}>{signed(a.change)}</span></dd></div>
          {s && <div><dt>Seepage</dt><dd className="num">{s.value.toFixed(1)} GL<span>{signed(s.change, 2)}</span></dd></div>}
          {d && <div><dt>Median depth</dt><dd className="num">{d.value.toFixed(2)} m<span>{signed(d.change, 2)}</span></dd></div>}
        </dl>
      )}
      <div className="ag-card-f">
        <code>{String(res.run_id)}</code>
        <button className={`ag-pill ${shown ? "on" : ""}`} onClick={onOpen}>{shown ? <><Icon name="follow" size={12} />On the model</> : <><Icon name="cube" size={12} />Show on model</>}</button>
      </div>
    </div>
  );
}

type Att = { name: string; state: "up" | "ok" | "err"; hint?: string; kind?: string; path?: string; err?: string };
const IMG_UP = /\.(png|jpe?g|gif|webp)$/i;
const viewUrl = (path: string) => `/api/volume-file?path=${encodeURIComponent(path)}`;

/** Attachments as the note in a sent message records them. */
function parseAttached(block: string): Att[] {
  return block.split("\n").filter((l) => l.startsWith("- ")).map((l) => {
    const path = l.match(/\(path: (\S+)\)/)?.[1];
    const name = path ? path.split("/").pop()! : (l.match(/"([^"]+)"/)?.[1] ?? l.slice(2, 42));
    const kind = /\[shown to you as an image\]/.test(l) || (path && IMG_UP.test(path)) ? "image" : /^- MODFLOW 6 package/.test(l) ? "model"
      : /scenario/.test(l.slice(0, 30)) ? "scenario" : /^- filed run/.test(l) ? "run" : "file";
    return { name, state: "ok" as const, kind, path, hint: l.slice(2) };
  });
}

/** One attachment: a thumbnail for an image, an icon tile for anything else. */
function AttTile({ a, onRemove }: { a: Att; onRemove?: () => void }) {
  const icon = a.kind === "model" ? "cube" : a.kind === "scenario" ? "file" : a.kind === "run" ? "play" : /\.pdf$/i.test(a.name) ? "note" : "clip";
  const body = a.state === "ok" && a.kind === "image" && a.path
    ? <img src={viewUrl(a.path)} alt={a.name} loading="lazy" />
    : <span className="ag-tile-ic">{a.state === "up" ? <span className="ag-spin" /> : <Icon name={a.state === "err" ? "alert" : icon} size={16} />}</span>;
  const tile = (
    <span className={`ag-tile ${a.kind === "image" ? "img" : ""} ${a.state}`} title={a.state === "err" ? a.err : a.hint}>
      {body}
      {a.kind !== "image" && <span className="ag-tile-n">{a.name.replace(/\.(zip|json)$/, "")}</span>}
      {onRemove && <button onClick={onRemove} aria-label={`Remove ${a.name}`}><Icon name="x" size={9} /></button>}
    </span>
  );
  return !onRemove && a.path ? <a className="ag-tile-link" href={viewUrl(a.path)} target="_blank" rel="noreferrer">{tile}</a> : tile;
}

/** Files the agent made, under the message that mentions them: figures as thumbnails, PDFs as an embedded page. */
function FileGallery({ paths }: { paths: string[] }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const url = (p: string) => viewUrl(p);
  const imgs = paths.filter((p) => IMG.test(p)), pdfs = paths.filter((p) => /\.pdf$/i.test(p)), other = paths.filter((p) => !IMG.test(p) && !/\.pdf$/i.test(p));
  if (!paths.length) return null;
  return (
    <div className="ag-gallery">
      {pdfs.map((p) => <PdfCard key={p} path={p} />)}
      {imgs.length > 0 && (
        <div className={`ag-figs-grid n${Math.min(imgs.length, 2)} ag-gallery-imgs`}>
          {imgs.map((p) => <button key={p} className="ag-fig" onClick={() => setZoom(p)} title={`${p.split("/").pop()} · click to enlarge`}><img src={url(p)} alt={p.split("/").pop()} loading="lazy" /></button>)}
        </div>
      )}
      {other.length > 0 && <ul className="ag-files">{other.map((p) => <li key={p}><a href={url(p)} target="_blank" rel="noreferrer"><Icon name="file" size={13} />{p.split("/").pop()}</a></li>)}</ul>}
      {zoom && (
        <div className="ag-zoom" role="dialog" aria-label={zoom.split("/").pop()} onClick={() => setZoom(null)}>
          <img src={url(zoom)} alt="" />
          <div className="ag-zoom-bar"><span>{zoom.split("/").pop()}</span><a href={url(zoom)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open</a><button onClick={() => setZoom(null)}>Close</button></div>
        </div>
      )}
    </div>
  );
}

/** A PDF the agent made: its first page embedded, with open and download. */
function PdfCard({ path }: { path: string }) {
  const u = viewUrl(path), name = path.split("/").pop() ?? "report.pdf";
  return (
    <div className="ag-pdf">
      <div className="ag-pdf-h"><Icon name="note" size={13} /><span title={name}>{name}</span>
        <a className="ag-pill" href={u} target="_blank" rel="noreferrer"><Icon name="ext" size={12} />Open</a>
        <a className="ag-pill" href={`${u}&download=true`}><Icon name="down" size={12} />Download</a></div>
      <iframe className="ag-pdf-f" src={`${u}#toolbar=0&navpanes=0&view=FitH`} title={name} loading="lazy" />
    </div>
  );
}

/** A MODFLOW 6 package the agent built or solved. */
function PackageCard({ name, tool, res, onOpen }: { name: string; tool: string; res: Record<string, unknown>; onOpen: () => void }) {
  const g = res.grid as { nlay?: number; nrow?: number; ncol?: number } | undefined;
  const d = res.final_depth_to_water_m as { mean: number; min: number } | null | undefined;
  const pk = res.packages as string[] | undefined;
  const meta = [g?.nlay ? `${g.nlay}×${g.nrow}×${g.ncol} grid` : null, tool === "run_model" ? `solved in ${String(res.solve_s)} s` : res.nper ? `${String(res.nper)} stress periods` : null,
    d ? `depth to water ${d.mean.toFixed(2)} m mean` : pk?.length ? pk.join(" ") : null].filter(Boolean).join(" · ");
  return (
    <div className="ag-card">
      <div className="ag-card-h">
        <span className="ag-card-ic"><Icon name={tool === "run_model" ? "play" : "cube"} size={11} /></span>
        <span className="ag-card-t" title={name}>{tool === "run_model" ? "Solved " : tool === "edit_model_file" ? "Edited " : "Built "}{name.replace(/\.zip$/, "")}</span>
      </div>
      <div className="ag-card-f">
        <span className="ag-card-m num" title={meta}>{meta || "MODFLOW 6 package"}</span>
        <button className="ag-pill" onClick={onOpen}><Icon name="cube" size={12} />{tool === "run_model" ? "Show on model" : "Solve and show"}</button>
      </div>
    </div>
  );
}

type Artifact = { name: string; path: string; bytes: number; url: string };
const IMG = /\.(png|jpe?g|gif|svg)$/i;
const kb = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** A Python error as a colleague would report it: the exception's last line (module prefix trimmed), the script line
 *  it came from, and the traceback with the sandbox's long paths cut down to package paths. */
function pyError(err: string) {
  const lines = err.replace(/\r/g, "").split("\n");
  const trace = lines.map((l) => l
    .replace(/"[^"]*\/site-packages\//g, '"').replace(/"\/local_disk0\/[^"]*\/(script|main)\.py"/g, '"script.py"')
    .replace(/"\/(local_disk0|tmp|databricks)\/[^"]*\/([^/"]+)"/g, '"$2"')).join("\n").trim();
  const last = [...lines].reverse().find((l) => /^\s*[\w.]*(Error|Exception|Exit|Interrupt|Warning)\b.*:?/.test(l) && !/^\s*(File|Traceback|\^)/.test(l))
    ?? [...lines].reverse().find((l) => l.trim() && !/^\s*\^+\s*$/.test(l)) ?? err;
  const summary = last.trim().replace(/^([a-z_][\w]*\.)+(?=[A-Z])/, "");
  // the deepest frame in the agent's own script, not in a library
  const own = [...trace.matchAll(/File "script\.py", line (\d+)/g)].pop() ?? [...trace.matchAll(/File "<string>", line (\d+)/g)].pop();
  return { summary, line: own ? Number(own[1]) : null, trace, n: trace.split("\n").length };
}

/** A script the agent ran in the sandbox: its code (folded), what it printed, and the figures and files it made. */
function ScriptCard({ args, res, links, retried }: { args: Record<string, unknown>; res: Record<string, unknown> | null; links: Links; retried?: boolean }) {
  const [code, setCode] = useState(false), [log, setLog] = useState(false), [zoom, setZoom] = useState<Artifact | null>(null), [tb, setTb] = useState(false);
  const src = String(args.code ?? ""), arts = ((res?.artifacts as Artifact[]) ?? []), imgs = arts.filter((a) => IMG.test(a.name)), docs = arts.filter((a) => !IMG.test(a.name));
  const toolErr = typeof res?.result === "string" && /^Error/.test(String(res.result)) ? String(res.result).replace(/^Error:\s*(Error executing tool \w+:\s*)?/, "") : null;
  const stdout = String(res?.stdout ?? "").trim(), err = toolErr ?? (res?.error ? String(res.error) : null), running = !res;
  const title = String(args.title || (imgs.length ? "Figure" : "Analysis"));
  const pe = err ? pyError(err) : null;
  return (
    <div className={`ag-card script ${err ? "failed" : ""} ${err && retried ? "retried" : ""}`}>
      <div className="ag-card-h">
        <span className={`ag-card-ic ${err ? "has-err" : ""}`} title={err ? (retried ? "Stopped with an error; the agent ran it again" : "Stopped with an error") : undefined}>
          {running ? <span className="ag-spin" /> : <Icon name="code" size={11} />}</span>
        <span className="ag-card-t" title={title}>{title}</span>
        <button className="ag-link" onClick={() => setCode((v) => !v)} aria-expanded={code}>{code ? "Hide code" : `Python · ${src.split("\n").length} lines`}</button>
      </div>
      {code && <pre className="ag-code"><code>{src}</code></pre>}
      {imgs.length > 0 && (
        <div className={`ag-figs-grid n${Math.min(imgs.length, 2)}`}>
          {imgs.map((a) => <button key={a.path} className="ag-fig" onClick={() => setZoom(a)} title={`${a.name} · click to enlarge`}><img src={a.url} alt={a.name} loading="lazy" /></button>)}
        </div>
      )}
      {docs.filter((a) => /\.pdf$/i.test(a.name)).slice(0, 1).map((a) => <PdfCard key={a.path} path={a.path} />)}
      {docs.length > 0 && (
        <ul className="ag-files">
          {docs.map((a) => (
            <li key={a.path}><a href={a.url} target="_blank" rel="noreferrer"><Icon name={/\.pdf$/i.test(a.name) ? "note" : "file"} size={13} />{a.name}</a><span className="num">{kb(a.bytes)}</span></li>
          ))}
        </ul>
      )}
      {pe && (
        <div className="ag-pyerr">
          <p className="ag-pyerr-s">{pe.summary}{pe.line ? <span className="ag-pyerr-l"> · line {pe.line} of the script</span> : null}</p>
          {pe.n > 1 && <button className="ag-link" onClick={() => setTb((v) => !v)} aria-expanded={tb}>{tb ? "Hide traceback" : `Traceback · ${pe.n} lines`}</button>}
          {tb && <pre className="ag-code quiet">{pe.trace}</pre>}
        </div>
      )}
      {!err && stdout && (
        <div className="ag-stdout">
          <button className="ag-link" onClick={() => setLog((v) => !v)} aria-expanded={log}>{log ? "Hide output" : "Printed output"}</button>
          {log && <pre className="ag-code">{stdout}</pre>}
        </div>
      )}
      {res && (
        <div className="ag-card-f">
          <span className="ag-card-m num">{running ? "running in the sandbox" : toolErr ? "did not run" : err ? `${retried ? "the agent ran it again below" : "stopped with an error"} · ${String(res.seconds ?? "")} s in the sandbox` : `${arts.length} file${arts.length === 1 ? "" : "s"} · ${String(res.seconds ?? "")} s in the sandbox`}</span>
          {res.folder ? <a className="ag-pill" href={links.folderUrl(String(res.folder))} target="_blank" rel="noreferrer"><Icon name="ext" size={12} />Folder</a> : null}
        </div>
      )}
      {zoom && (
        <div className="ag-zoom" role="dialog" aria-label={zoom.name} onClick={() => setZoom(null)}>
          <img src={zoom.url} alt={zoom.name} />
          <div className="ag-zoom-bar"><span>{zoom.name}</span><a href={zoom.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open</a><button onClick={() => setZoom(null)}>Close</button></div>
        </div>
      )}
    </div>
  );
}

type BatchRow = { label: string; run_id: string; area_lt2m_pct: number; area_change_pp: number; seepage_change_gl: number; median_dtw_change_m: number };
/** A sweep or attribution the agent ran: every run in one table, and how a combined change splits into its edits. */
function BatchCard({ res, links, shownRun }: { res: Record<string, unknown>; links: Links; shownRun: string | null }) {
  const rows = (res.runs as BatchRow[]) ?? [], att = res.attribution as { combined_area_change_pp: number; interaction_pp: number } | undefined;
  const sgn = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(d)}`;
  const best = rows.length ? Math.min(...rows.map((r) => r.area_change_pp)) : 0;
  return (
    <div className="ag-card batch">
      <div className="ag-card-h">
        <span className="ag-card-ic"><Icon name="compare" size={11} /></span>
        <span className="ag-card-t">{att ? "What each edit did" : `${rows.length} runs`}</span>
      </div>
      <div className="md-table ag-batch">
        <table>
          <thead><tr><th>Run</th><th className="n">Area &lt; 2 m</th><th className="n">Δ pp</th><th className="n">Seepage Δ GL</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.run_id} className={r.area_change_pp === best && rows.length > 2 ? "best" : ""}>
                <td title={r.label}>{r.label}</td><td className="n">{r.area_lt2m_pct.toFixed(1)}%</td>
                <td className={`n ${r.area_change_pp < 0 ? "good" : r.area_change_pp > 0 ? "bad" : ""}`}>{sgn(r.area_change_pp)}</td>
                <td className="n">{sgn(r.seepage_change_gl, 2)}</td>
                <td><button className={`ag-link ${shownRun === r.run_id ? "on" : ""}`} onClick={() => links.onOpenRun(r.run_id)} title="Show on model"><Icon name="cube" size={12} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {att && <div className="ag-card-f"><span className="ag-card-m num">Together {sgn(att.combined_area_change_pp)} pp · interaction {sgn(att.interaction_pp, 2)} pp beyond the sum of the parts</span></div>}
    </div>
  );
}

/** A run the agent started in the background: live solver progress, then the run card once it is filed. */
function TaskCard({ args, res, t, links, shownRun }: { args: Record<string, unknown>; res: Record<string, unknown>; t?: Task; links: Links; shownRun: string | null }) {
  if (t?.status === "finished" && t.summary && t.kind === "run_batch")
    return <BatchCard res={t.summary} links={links} shownRun={shownRun} />;
  if (t?.status === "finished" && t.summary && t.run_id)
    return <RunCard res={t.summary} args={args} shown={shownRun === t.run_id} onOpen={() => links.onOpenRun(String(t.run_id))} />;
  const f = (t?.fidelity ?? res.fidelity) as { cell_m?: number; cells?: number; sublayers?: number; nstp?: number; solver?: string } | undefined;
  const frac = t && t.total > 1 ? t.done / t.total : null, el = t?.elapsed_s ?? 0, est = Number(t?.estimate_s ?? res.estimate_s ?? 0);
  return (
    <div className={`ag-card task ${t?.status ?? "running"}`}>
      <div className="ag-card-h">
        <span className="ag-card-ic">{t?.status === "failed" ? <Icon name="alert" size={11} /> : <span className="ag-spin" />}</span>
        <span className="ag-card-t" title={String(args.label ?? "")}>{String(args.label || "Scenario run")}</span>
      </div>
      <div className="ag-task-bar"><span style={{ transform: `scaleX(${frac ?? Math.min(0.95, el / Math.max(est, 1))})` }} /></div>
      <div className="ag-card-f">
        <span className="ag-card-m num">
          {t?.status === "failed" ? `Failed: ${t.error ?? ""}` : `${t ? (/baseline/.test(t.stage) ? "baseline: " : "") + (t.total > 1 ? `${t.done}/${t.total} steps` : t.stage.replace("baseline ", "")) : "queued"} · ${clock(el)} of ~${clock(est)}`}
          {f?.cell_m ? ` · ${+f.cell_m.toFixed(1)} m, ${(f.cells ?? 0).toLocaleString("en-AU")} cells` : ""}
        </span>
      </div>
    </div>
  );
}

/** An ensemble the agent started, with where its Spark job is. */
function EnsembleCard({ args, res, e, links }: { args: Record<string, unknown>; res: Record<string, unknown>; e?: AgentEnsemble; links: Links }) {
  const [, tick] = useState(0);
  const running = !e || e.state === "running";
  useEffect(() => { if (!running) return; const t = window.setInterval(() => tick((x) => x + 1), 1000); return () => window.clearInterval(t); }, [running]);
  const el = e?.started_ms ? ((e.ended_ms ?? Date.now()) - e.started_ms) / 1000 : 0;
  return (
    <div className={`ag-card ens ${e?.state ?? "running"}`}>
      <div className="ag-card-h">
        <span className="ag-card-ic">{running ? <span className="ag-spin" /> : <Icon name={e?.state === "failed" ? "alert" : "check"} size={11} />}</span>
        <span className="ag-card-t" title={String(args.label ?? "")}>{String(args.label || "Ensemble")}</span>
      </div>
      <div className="ag-card-f">
        <span className="ag-card-m num">{String(args.n ?? 64)} members · {running ? `running ${el > 1 ? clock(el) : ""}` : e?.state === "failed" ? "failed" : `finished in ${clock(el)}`}</span>
        {e?.state === "finished" ? <button className="ag-pill" onClick={() => links.onOpenEnsemble(String(res.ensemble_id))}><Icon name="cube" size={12} />Show on model</button>
          : res.url || e?.url ? <a className="ag-pill" href={String(res.url ?? e?.url)} target="_blank" rel="noreferrer"><Icon name="ext" size={12} />Job</a> : null}
      </div>
    </div>
  );
}

const ICON: Record<string, string> = {
  describe_model: "model", describe_data: "info", render_map: "map", find_cells: "search", list_scenarios: "file", get_scenario: "file",
  preview_scenario: "eye", save_scenario: "save", run_scenario: "play", get_run: "list", list_runs: "list", compare_runs: "compare",
  start_ensemble: "spread", get_ensemble: "spread", create_study: "study", list_studies: "study", get_study: "study",
  record_finding: "note", conclude_study: "check", list_models: "folder", inspect_model: "search", read_model_file: "file",
  run_model: "play", write_model: "save", build_model: "cube", edit_model_file: "save", delete_model: "x", delete_scenario: "x", list_ensembles: "spread",
  show_in_studio: "eye", run_python: "code", run_batch: "compare", view_image: "image", get_task: "clock", list_tasks: "clock", estimate_fidelity: "harness", get_run_series: "spread", list_uploads: "clip", read_upload: "clip",
  get_model_build: "cube", edit_model: "brush", inspect_cell: "probe", zone_budget: "zone", get_section: "section", list_zones: "zone", save_zone: "zone", delete_zone: "x",
};
const MAPS: Record<string, string> = { land_use: "land use", depth_to_water: "depth to water", change: "change from baseline", reaches: "channel reaches" };

/** What a tool call did, said the way a colleague would report it. */
function describe(name: string, a: Record<string, unknown>, r: Record<string, unknown> | null, done: boolean): ReactNode {
  const id = (x: unknown) => String(x ?? "").slice(0, 12);
  switch (name) {
    case "describe_model": return done ? "Read the model description" : "Reading the model description";
    case "describe_data": return "Read the data catalogue";
    case "render_map": return <>{done ? "Read" : "Reading"} the {MAPS[String(a.layer ?? "land_use")] ?? String(a.layer)} map</>;
    case "find_cells": return r ? <>Found <b>{String(r.hectares ?? "?")} ha</b> of matching cells</> : "Finding cells";
    case "list_scenarios": return "Listed saved scenarios";
    case "get_scenario": return <>Read scenario <b>{String(a.name ?? "")}</b></>;
    case "preview_scenario": return done ? "Previewed a scenario" : "Previewing a scenario";
    case "save_scenario": return <>{done ? "Saved" : "Saving"} <b>{String(r?.name ?? a.name ?? "").replace(/\.json$/, "")}</b>{r?.version ? ` v${r.version}` : ""}</>;
    case "run_scenario": return <>Running <b>{String(a.label || "a scenario")}</b></>;
    case "get_run": return <>Read run <code>{id(a.run_id)}</code></>;
    case "list_runs": return a.study_id ? "Listed the study's runs" : "Listed filed runs";
    case "compare_runs": return <>Compared {Array.isArray(a.run_ids) ? a.run_ids.length : "the"} runs</>;
    case "start_ensemble": return <>Starting a {String(a.n ?? 64)}-member ensemble</>;
    case "get_ensemble": return <>Checked ensemble <code>{String(a.ensemble_id ?? "")}</code>{r?.status && r.status !== "finished" ? `: ${r.status}` : ""}</>;
    case "create_study": return <>Opened study <b>{String(a.title ?? "")}</b></>;
    case "list_studies": return "Listed studies";
    case "get_study": return <>Read study <code>{String(a.study_id ?? "")}</code></>;
    case "record_finding": return <>Recorded {a.kind === "caveat" ? "a caveat" : a.kind === "conclusion" ? "a conclusion" : "a finding"}</>;
    case "conclude_study": return "Concluded the study";
    case "list_models": return "Listed the models";
    case "inspect_model": return <>Inspected <b>{String(a.name ?? "")}</b></>;
    case "read_model_file": return <>Read <code>{String(a.member ?? "")}</code> in {String(a.name ?? "")}</>;
    case "run_model": return <>Solving <b>{String(a.name ?? "")}</b></>;
    case "write_model": case "build_model": return <>{done ? "Built" : "Building"} model <b>{String(a.name ?? "")}</b></>;
    case "edit_model_file": return <>{done ? "Edited" : "Editing"} <code>{String(a.member ?? "")}</code> in {String(a.name ?? "")}</>;
    case "delete_model": return <>Deleted package <b>{String(a.name ?? "")}</b></>;
    case "delete_scenario": return <>Deleted scenario <b>{String(a.name ?? "")}</b></>;
    case "list_ensembles": return "Listed ensembles";
    case "run_batch": return a.attribute ? "Splitting a combined change into its parts" : <>Running {Array.isArray(a.runs) ? a.runs.length : "several"} scenarios</>;
    case "get_task": return <>Checked task <code>{String(a.task_id ?? "")}</code>{r?.status ? `: ${r.status}` : ""}</>;
    case "list_tasks": return "Listed background tasks";
    case "estimate_fidelity": return <>Estimated a run at <b>{+(250 / Number(a.refine ?? 1)).toFixed(1)} m</b>{r?.estimate_s != null ? `: about ${Math.round(Number(r.estimate_s))} s` : ""}</>;
    case "get_run_series": return <>Read every month of run <code>{id(a.run_id)}</code></>;
    case "run_python": return <>Running Python{a.title ? <>: <b>{String(a.title)}</b></> : ""}</>;
    case "list_uploads": return "Listed your uploads";
    case "read_upload": return <>Read your upload <b>{String(a.name ?? "")}</b></>;
    case "get_model_build": return <>Read the build of <b>{String(a.name ?? "")}</b></>;
    case "edit_model": return <>{done ? "Edited" : "Editing"} <b>{String(a.name ?? "")}</b>{Array.isArray(r?.done) ? `: ${(r!.done as string[]).slice(0, 2).join("; ")}${(r!.done as string[]).length > 2 ? "…" : ""}` : Array.isArray(a.edits) ? ` (${a.edits.length} edit${a.edits.length > 1 ? "s" : ""})` : ""}</>;
    case "inspect_cell": return <>{done ? "Inspected" : "Inspecting"} row {Number(a.row) + 1}, col {Number(a.col) + 1}{r?.dtw_m ? <>: <b>{Number((r.dtw_m as number[])[(r.dtw_m as number[]).length - 1]).toFixed(2)} m</b> to water</> : ""}</>;
    case "zone_budget": {
      const w = (a.where ?? {}) as Record<string, unknown>;
      return <>{done ? "Balanced" : "Balancing"} the water in <b>{w.zone ? String(w.zone) : r?.hectares ? `${Number(r.hectares).toLocaleString("en-AU")} ha` : "a zone"}</b></>;
    }
    case "get_section": return <>{done ? "Cut" : "Cutting"} a section{r?.length_km ? <> of <b>{String(r.length_km)} km</b></> : ""}</>;
    case "list_zones": return "Listed saved zones";
    case "save_zone": return <>Saved zone <b>{String(a.name ?? "")}</b>{r?.hectares ? `, ${Number(r.hectares).toLocaleString("en-AU")} ha` : ""}</>;
    case "delete_zone": return <>Deleted zone <b>{String(a.name ?? "")}</b></>;
    case "view_image": return <>Looked at <b>{String(a.path ?? "").split("/").pop()}</b></>;
    case "show_in_studio": {
      const w = a as Record<string, unknown>;
      const bits = [w.run_id && `run ${String(w.run_id).slice(0, 8)}`, w.model && String(w.model), w.scenario && String(w.scenario), w.view && String(w.view),
        w.overlay && `${String(w.overlay).replace(/_/g, " ")} overlay`, w.panel && String(w.panel), w.bore && `bore ${String(w.bore)}`,
        w.month && `month ${String(w.month)}`, w.section_row && `section at row ${String(w.section_row)}`, Array.isArray(w.section_line) && "a section line",
        Array.isArray(w.cell) && `cell ${Number(w.cell[0]) + 1}, ${Number(w.cell[1]) + 1}`, w.zone && `zone ${String(w.zone)}`,
        Array.isArray(w.cells) && `${w.cells.length} cells`, w.sheet && `${String(w.sheet)} sheet`].filter(Boolean);
      return <>Showed you {bits.join(", ") || "the model"}</>;
    }
    default: return /^[A-Z]/.test(name) ? `Tried ${name}` : name.replace(/_/g, " ") || "Tool call";
  }
}

function ToolRow({ call, out, links, shownRun, ensembles, tasks, retried }: { call: AgentItem; out?: AgentItem; links: Links; shownRun: string | null; ensembles: AgentEnsemble[]; tasks: Task[]; retried?: boolean }) {
  const [open, setOpen] = useState(false);
  const name = toolName(call.data.name), args = parse(call.data.arguments) ?? {}, res = parse(out?.data.output);
  const raw = out?.data.output ?? "";
  const err = !!out && (/^\s*(\{"result":\s*")?Error/.test(raw) || raw.includes("Error executing tool"));
  if (name === "run_batch" && res?.runs && !err) return <BatchCard res={res} links={links} shownRun={shownRun} />;
  if ((name === "run_scenario" || name === "run_batch") && res?.background && res.task_id && !err)
    return <TaskCard args={args} res={res} t={tasks.find((x) => x.task_id === res.task_id)} links={links} shownRun={shownRun} />;
  if (name === "run_scenario" && res?.run_id && !err)
    return <RunCard res={res} args={args} shown={shownRun === res.run_id} onOpen={() => links.onOpenRun(String(res.run_id))} />;
  if (["run_model", "write_model", "build_model", "edit_model_file"].includes(name) && res?.package && !err)
    return <PackageCard name={String(res.package)} tool={name} res={res} onOpen={() => links.onOpenModel(String(res.package))} />;
  if (name === "run_python" && (!out || res))
    return <ScriptCard args={args} res={out ? res : null} links={links} retried={retried} />;
  if (name === "start_ensemble" && res?.ensemble_id && !err)
    return <EnsembleCard args={args} res={res} e={ensembles.find((e) => e.ensemble_id === res.ensemble_id)} links={links} />;
  const what = describe(name, args, res, !!out);
  let act: ReactNode = null;
  if (name === "save_scenario" && res?.name) act = <button className="ag-link" onClick={() => links.onOpenScenario(String(res.name))}>Open</button>;
  else if (["create_study", "record_finding", "conclude_study", "get_study"].includes(name) && (res?.study_id || args.study_id))
    act = <button className="ag-link" onClick={() => links.onOpenStudy(String(res?.study_id ?? args.study_id))}>Study</button>;
  const msg = err ? raw.replace(/^\{"result":\s*"|"\}$/g, "").replace(/^Error:\s*(Error executing tool \w+:\s*)?/, "") : "";
  return (
    <div className={`ag-tool ${err ? "err" : ""} ${out ? "" : "pending"}`}>
      <span className="ag-tool-ic" aria-hidden>{!out ? <span className="ag-spin" /> : <Icon name={err ? "alert" : ICON[name] ?? "harness"} size={13} />}</span>
      <span className="ag-tool-w">
        {err ? <button className="ag-tool-e" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{what} · failed</button> : what}
        {open && <span className="ag-tool-msg">{msg}</span>}
      </span>
      {act}
    </div>
  );
}

/** Calls paired with their outputs in order. Omnigent's MCP proxy records each MODFLOW call twice (once from the
 *  harness, once from the proxy, sometimes reusing another call's id), so ids alone cannot pair them. */
function pairCalls(items: AgentItem[]) {
  const used = new Set<number>(), rows: { it: AgentItem; out?: AgentItem }[] = [];
  items.forEach((it, i) => {
    if (it.type === "message") { rows.push({ it }); return; }
    if (it.type !== "function_call" || String(it.data.name).includes("ToolSearch")) return;
    let out: AgentItem | undefined;
    for (let j = i + 1; j < items.length; j++) {
      const o = items[j];
      if (!used.has(j) && o.type === "function_call_output" && o.data.call_id === it.data.call_id) { used.add(j); out = o; break; }
    }
    const prev = rows[rows.length - 1];
    if (prev && prev.it.type === "function_call" && prev.it.data.name === it.data.name && prev.it.data.arguments === it.data.arguments) {
      rows[rows.length - 1] = { it, out: out ?? prev.out };
      return;
    }
    rows.push({ it, out });
  });
  return rows;
}

function Approval({ el, onResolve }: { el: Elicitation; onResolve: (a: "accept" | "decline") => void }) {
  const p = el.params ?? {};
  const tool = toolName(String(p.tool_name ?? ""));
  const raw = p.arguments ?? p.content_preview;
  const args = (typeof raw === "string" ? parse(raw) : raw) as Record<string, unknown> | null;
  const what = tool === "run_scenario" ? `Run ${String(args?.label || "a scenario")} and file it`
    : tool === "save_scenario" ? `Save scenario ${String(args?.name ?? "")}` : tool === "create_study" ? `Open study “${String(args?.title ?? "")}”`
      : tool ? tool.replace(/_/g, " ")
        : args?.scenario !== undefined && args?.name === undefined ? `Run ${String(args?.label || "a scenario")} and file it`
          : String(p.message ?? "Change the MODFLOW record").replace(/^modflow-mode-\w+:\s*/, "");
  return (
    <div className="ag-ask" role="alert">
      <div className="ag-ask-t"><Icon name="ask" size={14} /><span><b>Approve?</b> {what}</span></div>
      {args && Object.keys(args).length > 0 && <pre>{JSON.stringify(args, null, 1).slice(0, 600)}</pre>}
      <div className="row">
        <button className="ag-btn" onClick={() => onResolve("decline")}>Decline</button>
        <button className="ag-btn primary" onClick={() => onResolve("accept")}>Approve</button>
      </div>
    </div>
  );
}

function StatusIcon({ s }: { s: AgentSessionRow }) {
  if (s.status === "running") return <span className="ag-st"><span className="ag-spin" title="Working" /></span>;
  if (s.waiting) return <span className="ag-st wait" title={`Waiting on ${s.waiting} ensemble${s.waiting > 1 ? "s" : ""}`}><Icon name="hourglass" size={12} /></span>;
  if (s.status === "waiting") return <span className="ag-st ask" title="Waiting for your approval"><Icon name="ask" size={12} /></span>;
  if (s.status === "failed") return <span className="ag-st bad" title="Failed"><Icon name="alert" size={12} /></span>;
  return <span className="ag-st" title="Idle"><Icon name="check" size={12} /></span>;
}

function ThreadList({ sessions, sid, onOpen, onNew, limit }: { sessions: AgentSessionRow[]; sid: string | null; onOpen: (id: string) => void; onNew?: () => void; limit?: number }) {
  const shown = limit ? sessions.slice(0, limit) : sessions;
  return (
    <ul className="ag-tlist">
      {onNew && <li><button className={`ag-thread new ${sid ? "" : "on"}`} onClick={onNew}><span className="ag-st"><Icon name="plus" size={12} /></span><span className="ag-thread-t">New thread</span></button></li>}
      {shown.map((s) => (
        <li key={s.id}>
          <button className={`ag-thread ${s.id === sid ? "on" : ""}`} onClick={() => onOpen(s.id)}>
            <StatusIcon s={s} />
            <span className="ag-thread-t">{s.title}</span>
            <span className="ag-thread-m">{ago(s.updated_at ?? s.created_at)}</span>
            <span className="ag-thread-s">{s.harness ? HARNESS[s.harness] ?? s.harness : ""}{s.llm_model ? ` · ${pretty(s.llm_model)}` : ""}
              {s.status === "running" ? " · working" : s.waiting ? ` · waiting on ${s.waiting} ensemble${s.waiting > 1 ? "s" : ""}` : s.status === "waiting" ? " · needs approval" : ""}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function Agent({ collapsed, onToggle, study, context, links, onFiled, onRunFiled, onActivity, follow, setFollow, shownRun, resizer, inbox, onFilesChanged, prefill, openThread }: {
  prefill?: { n: number; text: string } | null; openThread?: { n: number; id: string } | null;
  resizer?: ReactNode; inbox: { n: number; ref: ChatRef } | null; onFilesChanged: () => void; collapsed: boolean; onToggle: () => void; study: string | null; context: string | null; links: Links; onFiled: () => void;
  onRunFiled: (runId: string) => void; onActivity: (a: Activity) => void; follow: boolean; setFollow: (v: boolean) => void; shownRun: string | null;
}) {
  const [opts, setOpts] = useState<AgentOptions | null>(null), [optErr, setOptErr] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionRow[]>([]), [showThreads, setShowThreads] = useState(false);
  const [sid, setSid] = useState<string | null>(null), [snap, setSnap] = useState<AgentSnapshot | null>(null);
  const [harness, setHarness] = useState(""), [model, setModel] = useState(""), [mode, setMode] = useState<ModeId>("ask");
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const [useStudy, setUseStudy] = useState(true), [since, setSince] = useState<number | null>(null), [, tick] = useState(0);
  const logRef = useRef<HTMLDivElement>(null), seen = useRef<Set<string>>(new Set()), acted = useRef<Set<string>>(new Set());
  const ta = useRef<HTMLTextAreaElement>(null), pinned = useRef(true), fileIn = useRef<HTMLInputElement>(null);
  // files given to the agent: each is filed where it belongs as soon as it is dropped, then noted in the message
  const [att, setAtt] = useState<Att[]>([]);
  const [dropping, setDropping] = useState(false);
  const attach = async (fl: FileList | File[]) => {
    for (const f of Array.from(fl)) {
      setAtt((a) => [...a.filter((x) => x.name !== f.name), { name: f.name, state: "up" }]);
      try {
        const r = await api.agentUpload(f);
        const kind = r.kind === "file" && IMG_UP.test(r.name) ? "image" : r.kind;
        setAtt((a) => a.map((x) => (x.name === f.name ? { name: r.name, state: "ok", hint: r.hint, kind, path: r.path } : x)));
        if (r.kind !== "file") cb.current.onFiled();
        cb.current.onFilesChanged();
      } catch (e) { setAtt((a) => a.map((x) => (x.name === f.name ? { ...x, state: "err", err: (e as Error).message } : x))); }
    }
  };
  // the note tells the agent what each attachment is and where it lives; images also go to the model as images
  const withAttachments = (m: string) => {
    const ok = att.filter((a) => a.state === "ok");
    return ok.length ? `${m}\n\n[Attached files]\n${ok.map((a) => `- ${a.hint}${a.path ? ` (path: ${a.path})` : ""}${a.kind === "image" ? " [shown to you as an image]" : ""}`).join("\n")}` : m;
  };
  const attPaths = () => att.filter((a) => a.state === "ok" && a.path).map((a) => a.path!);
  useEffect(() => {
    if (!inbox) return;
    const r = inbox.ref;
    setAtt((a) => [...a.filter((x) => x.name !== r.name), { name: r.name, state: "ok", hint: r.hint, kind: r.kind, path: r.path }]);
    window.setTimeout(() => ta.current?.focus(), 0);
  }, [inbox?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // the start page can open a new thread with a prompt begun, or reopen an earlier one
  useEffect(() => {
    if (!prefill) return;
    setSid(null); setShowThreads(false); setOutbox([]); setText(prefill.text);
    window.setTimeout(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 50);
  }, [prefill?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // the runtime starts with the app; keep asking until it is up
  useEffect(() => {
    if (opts) return;
    let live = true, t = 0;
    const go = () => api.agentOptions().then((o) => {
      if (!live) return;
      setOpts(o); setOptErr(null);
      let last: string[] = [];
      try { last = (localStorage.getItem(PICK_KEY) ?? "").split("|"); } catch { /* private window */ }
      const h = o.harnesses.find((x) => x.id === last[0]) ?? o.harnesses[0];
      if (h) { setHarness(h.id); setModel(h.models.includes(last[1]) ? last[1] : h.default_model); }
    }).catch((e) => { if (live) { setOptErr(e.message); t = window.setTimeout(go, 5000); } });
    go();
    return () => { live = false; window.clearTimeout(t); };
  }, [opts]);

  // every thread, so work still running elsewhere stays in view
  const refreshThreads = useCallback(() => api.agentSessions().then(setSessions).catch(() => {}), []);
  useEffect(() => {
    refreshThreads();
    const t = window.setInterval(() => { if (!document.hidden) refreshThreads(); }, 8000);
    return () => window.clearInterval(t);
  }, [refreshThreads]);

  // the parent's callbacks change every render; read them through a ref so polling is not restarted (and history replayed)
  const cb = useRef({ onFiled, onRunFiled, onActivity, onFilesChanged }); cb.current = { onFiled, onRunFiled, onActivity, onFilesChanged };
  const load = useCallback(async (id: string, first = false) => {
    const s = await api.agentSession(id);
    setSnap(s); setMode(s.mode);
    for (const { it, out } of pairCalls(s.items)) {
      if (it.type !== "function_call") continue;
      const name = toolName(it.data.name);
      // follow the agent on the model: once as a call starts, once more when its result lands
      const stage = `${it.id}:${out ? "done" : "start"}`, isFirst = !acted.current.has(`${it.id}:start`) && !acted.current.has(`${it.id}:done`);
      if (!acted.current.has(stage)) {
        acted.current.add(stage);
        if (!first) cb.current.onActivity({ tool: name, args: parse(it.data.arguments) ?? {}, result: out ? parse(out.data.output) : null, first: isFirst });
      }
      if (!out) continue;
      const r = parse(out.data.output), key = String(r?.run_id ?? r?.version ?? r?.study_id ?? r?.finding_id ?? r?.package ?? r?.deleted ?? r?.folder ?? "");
      if (!key || seen.current.has(`${name}:${key}`)) continue;
      seen.current.add(`${name}:${key}`);
      if (first) continue; // replaying history: nothing new was filed
      cb.current.onFiled();
      if (name === "run_python") cb.current.onFilesChanged();
      if (name === "run_scenario" && r?.run_id) cb.current.onRunFiled(String(r.run_id));
    }
    // a call waiting for approval is not in the transcript yet; follow it from the approval request
    for (const el of s.pending_elicitations) {
      const k = `el:${String(el.elicitation_id ?? el.id ?? "")}`;
      if (acted.current.has(k)) continue;
      acted.current.add(k);
      const p = el.params ?? {}, raw = p.arguments ?? p.content_preview;
      const args = ((typeof raw === "string" ? parse(raw) : raw) ?? {}) as Record<string, unknown>;
      const tool = toolName(String(p.tool_name ?? "")) || (args.scenario !== undefined && args.name === undefined ? "run_scenario" : "");
      if (!first && tool) cb.current.onActivity({ tool, args, result: null, first: true });
    }
    return s;
  }, []);

  const ens = snap?.ensembles ?? [];
  const runningTasks = (snap?.tasks ?? []).filter((t) => t.status === "running");
  const waitingOn = [...ens.filter((e) => e.state === "running"), ...runningTasks];
  // what the user just did shows at once; polling speeds up until the server has caught up
  const [outbox, setOutbox] = useState<{ id: number; text: string; files: Att[] }[]>([]);
  const [decided, setDecided] = useState<Record<string, "accept" | "decline">>({});
  const poke = useRef<() => void>(() => {}), fastUntil = useRef(0);
  const hurry = () => { fastUntil.current = Date.now() + 12000; poke.current(); };
  useEffect(() => {
    if (!sid) { setSnap(null); return; }
    let live = true, t = 0, first = true;
    const go = async () => {
      try {
        const s = await load(sid, first); first = false;
        const idle = s.status === "idle" && !s.pending_elicitations.length;
        const waits = (s.ensembles ?? []).some((e) => e.state === "running" || !e.told) || (s.tasks ?? []).some((t) => t.status === "running");
        const fast = Date.now() < fastUntil.current;
        if (live) t = window.setTimeout(go, fast ? 600 : idle ? (waits ? 3000 : 6000) : 1500);
      } catch (e) { if (live) { setErr((e as Error).message); t = window.setTimeout(go, 6000); } }
    };
    poke.current = () => { window.clearTimeout(t); if (live) go(); };
    go();
    return () => { live = false; window.clearTimeout(t); poke.current = () => {}; };
  }, [sid, load]);
  // an outgoing message is dropped once the transcript shows it
  useEffect(() => {
    if (!outbox.length || !snap) return;
    const sent = snap.items.filter((it) => it.type === "message" && it.data.role === "user").map((it) => (it.data.content ?? []).map((c) => c.text ?? "").join("").trim());
    setOutbox((o) => o.filter((m) => !sent.some((x) => x.startsWith(m.text.slice(0, 60)))));
    setDecided((d) => Object.fromEntries(Object.entries(d).filter(([k]) => snap.pending_elicitations.some((e) => String(e.elicitation_id ?? e.id ?? "") === k))));
  }, [snap]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = snap?.status === "running" || snap?.status === "waiting";
  const busyish = running || waitingOn.length > 0;
  useEffect(() => { if (busyish) { setSince((v) => v ?? Date.now()); const i = window.setInterval(() => tick((x) => x + 1), 1000); return () => window.clearInterval(i); } setSince(null); }, [busyish]);
  useEffect(() => { const el = logRef.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [snap?.items.length, snap?.pending_elicitations.length, running, waitingOn.length]);

  const hOpt = opts?.harnesses.find((h) => h.id === harness);
  const choose = (h: string, m?: string) => {
    const o = opts?.harnesses.find((x) => x.id === h); if (!o) return;
    const mm = m ?? (o.models.includes(model) ? model : o.default_model);
    setHarness(h); setModel(mm);
    try { localStorage.setItem(PICK_KEY, `${h}|${mm}`); } catch { /* private window */ }
  };
  const start = async (msg?: string) => {
    const m = withAttachments((msg ?? text).trim());
    if (!m.trim() || !harness || !model) return;
    setBusy(true); setErr(null);
    const id = Date.now();
    setOutbox([{ id, text: m.trim(), files: att.filter((a) => a.state === "ok") }]); // shows while the thread is created
    try {
      const full = context ? `${m}\n\n(Studio context: ${context})` : m;
      const r = await api.agentStart({ harness, model, mode, message: full, study_id: useStudy ? study : null, attachments: attPaths() });
      setText(""); setAtt([]); seen.current = new Set(); acted.current = new Set(); pinned.current = true; setSid(r.session_id); setShowThreads(false);
      refreshThreads();
    } catch (e) { setErr((e as Error).message); setOutbox([]); } finally { setBusy(false); }
  };
  const send = async () => {
    if (!sid || (!text.trim() && !att.some((a) => a.state === "ok"))) return;
    const typed = text.trim() || "Here are some files.", t = withAttachments(typed), paths = attPaths(), id = Date.now();
    setOutbox((o) => [...o, { id, text: t.trim(), files: att.filter((a) => a.state === "ok") }]);
    setText(""); setAtt([]); pinned.current = true;
    try { await api.agentSend(sid, t, paths); hurry(); }
    catch (e) { setErr((e as Error).message); setText(typed); setOutbox((o) => o.filter((m) => m.id !== id)); }
  };
  const submit = () => (sid ? send() : start());
  const changeMode = async (m: ModeId) => {
    setMode(m);
    if (sid) try { await api.agentMode(sid, m); } catch (e) { setErr((e as Error).message); }
  };
  const resolve = async (el: Elicitation, action: "accept" | "decline") => {
    if (!sid) return;
    const k = String(el.elicitation_id ?? el.id ?? "");
    setDecided((d) => ({ ...d, [k]: action }));
    try { await api.agentResolve(sid, k, action); hurry(); }
    catch (e) { setErr((e as Error).message); setDecided((d) => { const n = { ...d }; delete n[k]; return n; }); }
  };
  // opening an old thread replays it quietly: history does not move the model
  const openSession = (id: string) => { setOutbox([]); seen.current = new Set(); acted.current = new Set(); pinned.current = true; setSid(id); setShowThreads(false); setErr(null); };
  useEffect(() => { if (openThread) openSession(openThread.id); }, [openThread?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const fresh = () => { setSid(null); setErr(null); setShowThreads(false); setOutbox([]); window.setTimeout(() => ta.current?.focus(), 0); };

  const rows = useMemo(() => pairCalls(snap?.items ?? []), [snap]);
  const provisioning = running && rows.length <= 1;
  const elapsed = since ? Math.round((Date.now() - since) / 1000) : 0;
  const modeHelp = MODES.find((m) => m.id === mode)?.help;
  const active = sessions.filter((s) => s.status === "running" || s.status === "waiting" || s.waiting);
  const pending = rows.filter((r) => r.it.type === "function_call" && !r.out).pop();
  const doing = pending ? describe(toolName(pending.it.data.name), parse(pending.it.data.arguments) ?? {}, null, false) : null;

  if (collapsed) return (
    <aside className="agent rail" aria-label="Agent">
      <button className="ag-rail" onClick={onToggle} aria-label="Open the agent" title="Open the agent">
        <Icon name="agent" size={16} /><span>Agent</span>{active.length > 0 && <span className="ag-spin" aria-label={`${active.length} working`} />}
      </button>
    </aside>
  );

  return (
    <aside className={`agent ${dropping ? "dropping" : ""}`} aria-label="Agent"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={(e) => { e.preventDefault(); setDropping(false); if (e.dataTransfer.files.length) void attach(e.dataTransfer.files); }}>
      {resizer}
      {dropping && <div className="ag-drop"><Icon name="clip" size={18} />Drop files for the agent<span>MODFLOW 6 packages go to your models, scenarios to your scenarios, anything else to your uploads</span></div>}
      <header className="ag-head">
        <button className={`ag-tbtn ${showThreads ? "on" : ""}`} onClick={() => { setShowThreads((v) => !v); refreshThreads(); }} aria-expanded={showThreads}
          title="All your agent threads, including ones still working">
          <Icon name="threads" size={14} />Threads
          {active.length > 0 ? <span className="ag-count busy"><span className="ag-spin sm" />{active.length}</span> : sessions.length > 0 && <span className="ag-count">{sessions.length}</span>}
        </button>
        <div className="ag-hbtn">
          <button className={`ag-pill ${follow ? "on" : ""}`} onClick={() => setFollow(!follow)} aria-pressed={follow}
            title={follow ? "On: the model follows what the agent is looking at, and opens each run it files" : "Off: the model stays where you leave it"}><Icon name="follow" size={12} />Follow</button>
          <button className="ag-icon" onClick={fresh} title="New thread" aria-label="New thread"><Icon name="plus" size={15} /></button>
          <button className="ag-icon" onClick={onToggle} title="Hide the agent" aria-label="Hide the agent"><Icon name="side" size={15} /></button>
        </div>
      </header>
      {sid && snap && !showThreads && (
        <div className="ag-titlebar">
          <b title={snap.title}>{snap.title}</b>
          <span>{HARNESS[snap.harness] ?? snap.harness} · {pretty(snap.llm_model ?? "")} · {MODES.find((m) => m.id === mode)?.label}</span>
        </div>
      )}

      {showThreads && (
        <div className="ag-threads">
          <ThreadList sessions={sessions} sid={sid} onOpen={openSession} onNew={fresh} />
          <p className="ag-muted small">Threads live with the app, so this list can start afresh after the app is redeployed. Everything they filed stays in the record.</p>
        </div>
      )}

      <div className="ag-log" ref={logRef} aria-live="polite" hidden={showThreads}
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {!sid && !outbox.length && (
          <div className="ag-intro">
            <h3>What should we model?</h3>
            <p>It builds and runs scenarios, compares them, opens studies and writes up what they show, using the Studio's MODFLOW tools with your Unity Catalog access. Everything it files carries your name{follow ? ", and the model follows along" : ""}.</p>
            <div className="ag-starters">
              {STARTERS.map((s) => <button key={s} className="ag-starter" disabled={!opts || busy} onClick={() => start(s)}>{s}</button>)}
            </div>
            {sessions.length > 0 && (
              <div className="ag-recent">
                <div className="ag-recent-h">Recent threads{sessions.length > 4 && <button className="ag-link" onClick={() => setShowThreads(true)}>All {sessions.length}</button>}</div>
                <ThreadList sessions={sessions} sid={sid} onOpen={openSession} limit={4} />
              </div>
            )}
          </div>
        )}
        {rows.map(({ it, out }, i) => {
          if (it.type === "function_call") return <ToolRow key={it.id} call={it} out={out} links={links} shownRun={shownRun} ensembles={ens} tasks={snap?.tasks ?? []}
            retried={toolName(it.data.name) === "run_python" && rows.slice(i + 1).some((r) => r.it.type === "function_call" && toolName(r.it.data.name) === "run_python")} />;
          let t = (it.data.content ?? []).map((c) => c.text ?? "").join("");
          let files: Att[] = [];
          if (it.data.role === "user") {
            t = t.replace(/\n\n\(Studio context:[^)]*\)\s*$/, "");
            const cut = t.indexOf("\n\n[Attached files]\n");
            if (cut >= 0) { files = parseAttached(t.slice(cut)); t = t.slice(0, cut); }
            else { const m = t.match(/\n\n\[Attached: [^\]]*\]\s*$/); if (m) t = t.slice(0, m.index); }
          }
          if (!t.trim()) return null;
          if (it.data.role === "user" && t.startsWith(STUDIO)) {
            const img = (it.data.content ?? []).find((c) => (c as { type: string }).type === "input_image") as { image_url?: string; filename?: string } | undefined;
            if (img?.image_url || /view_image/.test(t))
              return <div key={it.id} className="ag-seen"><Icon name="eye" size={12} /><span>Shown to the agent: {img?.filename ?? t.split("/").pop()}</span>{img?.image_url && <img src={img.image_url} alt="" />}</div>;
            return <div key={it.id} className="ag-notice"><Icon name="check" size={12} />{/background runs/.test(t) ? "Background runs finished; the agent picked the thread back up" : /finished/.test(t) ? "Ensembles finished; the agent picked the thread back up" : t.slice(STUDIO.length).split("\n")[0]}</div>;
          }
          return it.data.role === "user"
            ? <div key={it.id} className="ag-msg user">{files.length > 0 && <div className="ag-att sent">{files.map((f) => <AttTile key={f.name} a={f} />)}</div>}<p>{t}</p></div>
            : <div key={it.id} className="ag-msg"><Markdown text={t} /><FileGallery paths={filesIn(t)} /></div>;
        })}
        {snap?.pending_elicitations.map((el, i) => {
          const d = decided[String(el.elicitation_id ?? el.id ?? "")];
          return d ? <div key={i} className="ag-notice"><Icon name={d === "accept" ? "check" : "x"} size={12} />{d === "accept" ? "Approved; carrying on" : "Declined"}</div>
            : <Approval key={i} el={el} onResolve={(a) => resolve(el, a)} />;
        })}
        {outbox.map((m) => {
          const cut = m.text.indexOf("\n\n[Attached files]\n"), body = cut >= 0 ? m.text.slice(0, cut) : m.text;
          return (
            <div key={m.id} className="ag-msg user pending">
              {m.files.length > 0 && <div className="ag-att sent">{m.files.map((f) => <AttTile key={f.name} a={f} />)}</div>}
              <p>{body}</p>
              <span className="ag-queued">{!sid ? "Starting the thread…" : running ? "Queued: it reads this when the current step ends" : "Sending…"}</span>
            </div>
          );
        })}
        {running && (!snap?.pending_elicitations.length || snap.pending_elicitations.every((e) => decided[String(e.elicitation_id ?? e.id ?? "")])) && (
          <div className="ag-status"><span className="ag-spin" /><span className="ag-status-t">{provisioning ? "Starting the harness" : doing ?? "Thinking"}</span><span className="num">{elapsed > 2 ? clock(elapsed) : ""}</span></div>
        )}
        {!running && waitingOn.length > 0 && (
          <div className="ag-wait">
            <span className="ag-wait-ic"><Icon name="hourglass" size={14} /></span>
            <span><b>Waiting on {[runningTasks.length && `${runningTasks.length} background run${runningTasks.length > 1 ? "s" : ""}`,
              waitingOn.length - runningTasks.length && `${waitingOn.length - runningTasks.length} ensemble${waitingOn.length - runningTasks.length > 1 ? "s" : ""}`].filter(Boolean).join(" and ")}{elapsed > 2 ? ` · ${clock(elapsed)}` : ""}</b>
              <span>The agent picks this thread back up when {waitingOn.length > 1 ? "they finish" : "it finishes"}. You can leave and come back.</span></span>
          </div>
        )}
        {snap?.status === "failed" && snap.last_task_error && <p className="ag-err">{typeof snap.last_task_error === "string" ? snap.last_task_error : snap.last_task_error.message ?? "The turn failed."}</p>}
      </div>

      <footer className="ag-foot">
        {err && <p className="ag-err">{err}</p>}
        {optErr && !opts && <p className="ag-muted small">{/starting|reachable/i.test(optErr) ? "The agent runtime is starting with the app…" : optErr}</p>}
        {!sid && study && <label className="ag-ctx"><input type="checkbox" checked={useStudy} onChange={(e) => setUseStudy(e.target.checked)} /> File against the open study</label>}
        <div className="ag-compose">
          {att.length > 0 && (
            <div className="ag-att">
              {att.map((a) => <AttTile key={a.name} a={a} onRemove={() => setAtt((x) => x.filter((y) => y.name !== a.name))} />)}
            </div>
          )}
          <textarea ref={ta} rows={2} value={text} placeholder={sid ? (busyish ? "Add to the thread; it reads this when it is next free" : "Reply, or ask for the next step") : "Ask the agent to model something"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
          <div className="ag-bar">
            <button className="ag-icon clip" onClick={() => fileIn.current?.click()} title="Attach files: data, papers, images, MODFLOW 6 packages (.zip) or scenarios (.json)" aria-label="Attach files"><Icon name="clip" size={15} /></button>
            <input ref={fileIn} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void attach(e.target.files); e.target.value = ""; }} />
            {sid && snap ? (
              <span className="ag-fixed" title="Harness and model are fixed for a thread; start a new one to change them">
                {HARNESS[snap.harness] ?? snap.harness} · {pretty(snap.llm_model ?? "")}
              </span>
            ) : (
              <>
                <label className="ag-sel" title="Harness: the agent program that plans and calls the MODFLOW tools">
                  <Icon name="harness" size={12} />
                  <select value={harness} disabled={!opts} onChange={(e) => choose(e.target.value)} aria-label="Harness">
                    {!opts && <option>Starting…</option>}
                    {opts?.harnesses.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
                  </select>
                </label>
                <label className="ag-sel" title="Model, served through Unity AI Gateway">
                  <Icon name="model" size={12} />
                  <select value={model} disabled={!hOpt} onChange={(e) => choose(harness, e.target.value)} aria-label="Model">
                    {hOpt?.models.map((m) => <option key={m} value={m}>{pretty(m)}</option>)}
                  </select>
                </label>
              </>
            )}
            {running && sid
              ? <button className="ag-go stop" onClick={() => api.agentStop(sid)} aria-label="Stop" title="Stop"><Icon name="stop" size={12} /></button>
              : <button className="ag-go" disabled={busy || att.some((a) => a.state === "up") || (!text.trim() && !att.some((a) => a.state === "ok")) || (!sid && !opts)} onClick={submit} aria-label="Send" title="Send (Enter)"><Icon name="send" size={14} /></button>}
          </div>
        </div>
        <div className="ag-perm">
          <div className="ag-modes" role="radiogroup" aria-label="Permissions">
            {MODES.map((m) => <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? "on" : ""} onClick={() => changeMode(m.id)} title={m.help}><Icon name={m.icon} size={12} />{m.label}</button>)}
          </div>
          <p className="ag-help">{modeHelp}</p>
        </div>
      </footer>
    </aside>
  );
}
