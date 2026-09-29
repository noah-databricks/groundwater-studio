/** The model buildkit on the client: a MODFLOW 6 package as an editable document (see app/buildkit.py). */
import { trace } from "./scenario";

export type Packed = { z: string; shape: number[] };
export type BType = "chd" | "wel" | "riv" | "drn" | "ghb";
export type BFeature = {
  id: string; type: BType; pkg: string; label: string; cells: [number, number, number][]; schedule: string | null;
  head?: number[]; rate?: number[]; stage?: number[]; rbot?: number[]; cond?: number[]; elev?: number[]; bhead?: number[];
  drawn?: Record<string, unknown>;
};
export type Override = { from: number; to: number; factor: number; label?: string };
export type Schedule = { kind: "months" | "series"; factors: number[]; onoff: boolean; overrides: Override[]; imported?: boolean };
export type Period = { perlen: number; nstp: number; tsmult: number; steady: boolean };
export type Flux = { rate_mm_yr: Packed; schedule: string | null; pname?: string; surface?: Packed; depth?: Packed };
export type BuildDoc = {
  format: string; name: string; editable: boolean; why_not: string | null; locked: { what: string; reason: string }[];
  model_name: string; time_units: string; length_units: string;
  grid: { nlay: number; nrow: number; ncol: number; delr: number[]; delc: number[] };
  arrays: Record<string, Packed>; time: { start: string | null; periods: Period[] }; solver: string;
  schedules: Record<string, Schedule>; boundaries: BFeature[]; recharge: Flux | null; et: Flux | null;
  obs: { name: string; cell: [number, number, number] }[]; base_sha: string;
  georef?: { xorigin: number; yorigin: number; angrot: number; epsg: number | null };
  /** packages kept as uploaded, and where they act (drawn on the model, not editable in the palette) */
  display?: { type: string; name: string; file: string; cells: [number, number, number][] }[];
  engine?: string; convertible?: boolean;
  [k: string]: unknown;
};
/** Decoded arrays: 3D ones flat [layer][row][col]; "top" and the recharge/ET grids 2D. Edits replace an array, never mutate it. */
export type Arrays = Record<string, Float32Array>;
export type Build = { doc: BuildDoc; arr: Arrays; dirty: Set<string> };

export const PROPS: { key: string; label: string; unit: string; log?: boolean; layered: boolean }[] = [
  { key: "k", label: "Conductivity K", unit: "m/d", log: true, layered: true },
  { key: "k33", label: "Vertical K", unit: "m/d", log: true, layered: true },
  { key: "sy", label: "Specific yield", unit: "", layered: true },
  { key: "ss", label: "Specific storage", unit: "1/m", log: true, layered: true },
  { key: "strt", label: "Starting head", unit: "m", layered: true },
  { key: "top", label: "Top", unit: "m", layered: false },
  { key: "botm", label: "Layer bottom", unit: "m", layered: true },
  { key: "rch", label: "Recharge", unit: "mm/yr", layered: false },
  { key: "evt", label: "ET rate", unit: "mm/yr", layered: false },
  { key: "evt_depth", label: "ET extinction depth", unit: "m", layered: false },
];
export const TYPE_LABEL: Record<BType, string> = { chd: "Fixed head", wel: "Well", riv: "River", drn: "Drain", ghb: "General head" };
export const LEVEL: Set<BType> = new Set(["chd", "riv", "drn", "ghb"]);
const FLUX_KEYS: Record<string, [keyof BuildDoc, string]> = { rch: ["recharge", "rate_mm_yr"], evt: ["et", "rate_mm_yr"], evt_depth: ["et", "depth"], evt_surface: ["et", "surface"] };

// ---- packing: zlib (the browser calls it "deflate") + base64 of little-endian float32
async function inflate(b64: string): Promise<Uint8Array> {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const s = new Blob([bin]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function deflate(bytes: Uint8Array): Promise<string> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  const out = new Uint8Array(await new Response(s).arrayBuffer());
  let bin = "";
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(bin);
}
export async function unpack(p: Packed): Promise<Float32Array> { const b = await inflate(p.z); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); }
export async function pack(a: Float32Array, shape: number[]): Promise<Packed> { return { z: await deflate(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)), shape }; }

export async function open(doc: BuildDoc): Promise<Build> {
  const arr: Arrays = {};
  if (!doc.editable) return { doc, arr, dirty: new Set() };  // classic and DISV packages: nothing to decode, only why
  await Promise.all(Object.entries(doc.arrays ?? {}).map(async ([k, v]) => { arr[k] = await unpack(v); }));
  for (const [k, [sec, f]] of Object.entries(FLUX_KEYS)) {
    const e = doc[sec] as Flux | null; const v = e?.[f as keyof Flux] as Packed | undefined;
    if (v) arr[k] = await unpack(v);
  }
  return { doc, arr, dirty: new Set() };
}
/** The document as the server wants it: only edited arrays are re-packed, so unchanged parts keep their exact bytes. */
export async function toDoc(b: Build): Promise<BuildDoc> {
  const d: BuildDoc = { ...b.doc, arrays: { ...b.doc.arrays } };
  const { nlay, nrow, ncol } = d.grid;
  for (const k of b.dirty) {
    const a = b.arr[k];
    if (!a) continue;
    if (k in FLUX_KEYS) {
      const [sec, f] = FLUX_KEYS[k];
      const e = { ...(d[sec] as Flux) } as Flux; (e as Record<string, unknown>)[f] = await pack(a, [nrow, ncol]); (d as Record<string, unknown>)[sec] = e;
    } else d.arrays[k] = await pack(a, k === "top" ? [nrow, ncol] : [nlay, nrow, ncol]);
  }
  return d;
}

// ---- reading and writing cells
export const at = (b: Build, key: string, layer: number, r: number, c: number) => {
  const { nrow, ncol } = b.doc.grid, a = b.arr[key];
  if (!a) return null;
  return a.length === nrow * ncol ? a[r * ncol + c] : a[(layer * nrow + r) * ncol + c];
};
export function layer2d(b: Build, key: string, layer: number): (number | null)[][] {
  const { nrow, ncol } = b.doc.grid, a = b.arr[key];
  const act = b.arr.idomain;
  if (!a) return [];
  const off = a.length === nrow * ncol ? 0 : layer * nrow * ncol;
  return Array.from({ length: nrow }, (_, r) => Array.from({ length: ncol }, (_, c) => (act && act[(layer * nrow + r) * ncol + c] <= 0 ? null : a[off + r * ncol + c])));
}
export type Mode = "set" | "multiply" | "add";
/** A new Build with cells of one property changed (copy-on-write, so undo keeps the old array). */
export function paintProp(b: Build, key: string, layers: number[], cells: { row: number; col: number }[], mode: Mode, value: number): Build {
  const { nlay, nrow, ncol } = b.doc.grid;
  let src = b.arr[key];
  let doc = b.doc;
  if (!src && key in FLUX_KEYS) {  // first recharge or ET painted: the package appears
    const [sec] = FLUX_KEYS[key];
    src = new Float32Array(nrow * ncol).fill(key === "evt_depth" ? 2 : 0);
    if (!doc[sec]) doc = { ...doc, [sec]: { rate_mm_yr: { z: "", shape: [nrow, ncol] }, schedule: null } as Flux };
  }
  if (!src) return b;
  const a = new Float32Array(src), flat = a.length === nrow * ncol;
  const f = (v: number) => (mode === "multiply" ? v * value : mode === "add" ? v + value : value);
  for (const L of flat ? [0] : layers) for (const { row, col } of cells) {
    if (L >= nlay || row >= nrow || col >= ncol) continue;
    const i = (flat ? 0 : L * nrow * ncol) + row * ncol + col;
    a[i] = f(a[i]);
  }
  const dirty = new Set(b.dirty); dirty.add(key);
  const arr = { ...b.arr, [key]: a };
  // new ET needs its depth and surface too
  if (key === "evt" && !b.arr.evt_depth) { arr.evt_depth = new Float32Array(nrow * ncol).fill(2); dirty.add("evt_depth"); }
  if (key === "evt" && !b.arr.evt_surface) { arr.evt_surface = new Float32Array(b.arr.top); dirty.add("evt_surface"); }
  return { doc, arr, dirty };
}
export const withDoc = (b: Build, doc: BuildDoc): Build => ({ ...b, doc });

// ---- features
export function nextId(doc: BuildDoc, prefix: string) {
  const taken = new Set(doc.boundaries.map((x) => x.id)); let i = 1;
  while (taken.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}
const pkgOf = (doc: BuildDoc, t: BType) => doc.boundaries.find((x) => x.type === t)?.pkg ?? t;
export function addWell(b: Build, row: number, col: number, layers: number[], rate: number, schedule: string | null): Build {
  const id = nextId(b.doc, "W");
  const f: BFeature = { id, type: "wel", pkg: pkgOf(b.doc, "wel"), label: "", cells: layers.map((L) => [L, row, col]), rate: layers.map(() => rate / layers.length), schedule, drawn: { rate, layers } };
  return withDoc(b, { ...b.doc, boundaries: [...b.doc.boundaries, f] });
}
export function addHeads(b: Build, cells: [number, number][], layers: number[], head: number, mode: "abs" | "below_top", schedule: string | null): Build {
  const id = nextId(b.doc, "H"), all: [number, number, number][] = layers.flatMap((L) => cells.map(([r, c]) => [L, r, c] as [number, number, number]));
  const heads = all.map(([, r, c]) => (mode === "below_top" ? (at(b, "top", 0, r, c) ?? 0) - head : head));
  const f: BFeature = { id, type: "chd", pkg: pkgOf(b.doc, "chd"), label: "", cells: all, head: heads, schedule, drawn: { head, head_mode: mode, layers } };
  return withDoc(b, { ...b.doc, boundaries: [...b.doc.boundaries, f] });
}
export function addGhb(b: Build, cells: [number, number][], layers: number[], head: number, mode: "abs" | "below_top", cond: number, schedule: string | null): Build {
  const id = nextId(b.doc, "G"), all: [number, number, number][] = layers.flatMap((L) => cells.map(([r, c]) => [L, r, c] as [number, number, number]));
  const f: BFeature = { id, type: "ghb", pkg: pkgOf(b.doc, "ghb"), label: "", cells: all, schedule,
    bhead: all.map(([, r, c]) => (mode === "below_top" ? (at(b, "top", 0, r, c) ?? 0) - head : head)), cond: all.map(() => cond), drawn: { head, head_mode: mode, layers, cond } };
  return withDoc(b, { ...b.doc, boundaries: [...b.doc.boundaries, f] });
}
/** A model cell's centre in world coordinates (the grid's origin and rotation applied), and lat/long for UTM systems. */
export function worldOf(b: Build, row: number, col: number): { x: number; y: number } | null {
  const g = b.doc.georef;
  if (!g || !(g.xorigin || g.yorigin || g.angrot)) return null;
  const { delr, delc, nrow } = b.doc.grid;
  const lx = delr.slice(0, col).reduce((a, x) => a + x, 0) + delr[col] / 2;
  const ly = delc.slice(row + 1, nrow).reduce((a, x) => a + x, 0) + delc[row] / 2;  // row 0 is the north edge
  const th = (g.angrot * Math.PI) / 180;
  return { x: g.xorigin + lx * Math.cos(th) - ly * Math.sin(th), y: g.yorigin + lx * Math.sin(th) + ly * Math.cos(th) };
}
export function addLine(b: Build, kind: "riv" | "drn", pts: [number, number][], layer: number, o: { stage_start?: number; stage_end?: number; bed_depth?: number; elev?: number; elev_mode?: "abs" | "below_top"; cond: number }, schedule: string | null): Build {
  const rc = trace(pts), n = rc.length, id = nextId(b.doc, kind === "riv" ? "RV" : "D");
  const cells = rc.map(([r, c]) => [layer, r, c] as [number, number, number]);
  let f: BFeature;
  if (kind === "riv") {
    const s0 = o.stage_start ?? 0, s1 = o.stage_end ?? s0;
    const stage = rc.map((_, i) => +(s0 + ((s1 - s0) * i) / Math.max(1, n - 1)).toFixed(4));
    f = { id, type: "riv", pkg: pkgOf(b.doc, "riv"), label: "", cells, stage, rbot: stage.map((s) => +(s - (o.bed_depth ?? 1)).toFixed(4)), cond: rc.map(() => o.cond), schedule, drawn: { ...o, points: pts } };
  } else {
    const elev = rc.map(([r, c]) => (o.elev_mode === "abs" ? o.elev ?? 0 : +((at(b, "top", 0, r, c) ?? 0) - (o.elev ?? 1.5)).toFixed(4)));
    f = { id, type: "drn", pkg: pkgOf(b.doc, "drn"), label: "", cells, elev, cond: rc.map(() => o.cond), schedule, drawn: { ...o, points: pts } };
  }
  return withDoc(b, { ...b.doc, boundaries: [...b.doc.boundaries, f] });
}
export const removeFeature = (b: Build, id: string): Build =>
  withDoc(b, { ...b.doc, boundaries: b.doc.boundaries.filter((x) => x.id !== id), obs: b.doc.obs.filter((o) => o.name !== id) });
export const updateFeature = (b: Build, id: string, patch: Partial<BFeature>): Build =>
  withDoc(b, { ...b.doc, boundaries: b.doc.boundaries.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
export const setRate = (f: BFeature, rate: number): Partial<BFeature> => ({ rate: f.cells.map(() => rate / f.cells.length), drawn: { ...(f.drawn ?? {}), rate } });
export const featureTotal = (f: BFeature) => (f.type === "wel" ? (f.rate ?? []).reduce((a, x) => a + x, 0) : null);

// ---- schedules and time
export const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
export const PRESETS: Record<string, { factors: number[]; onoff: boolean }> = {
  "Irrigation season": { factors: [1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1], onoff: true },
  "Wet winter": { factors: [0.4, 0.4, 0.6, 1, 1.4, 1.7, 1.8, 1.6, 1.2, 0.8, 0.6, 0.5], onoff: false },
  "Dry summer": { factors: [0.2, 0.2, 0.4, 0.8, 1.2, 1.5, 1.6, 1.5, 1.2, 0.8, 0.4, 0.2], onoff: false },
  "Summer demand": { factors: [1.8, 1.7, 1.4, 1, 0.6, 0.4, 0.4, 0.5, 0.8, 1.1, 1.4, 1.7], onoff: false },
  Flat: { factors: Array(12).fill(1), onoff: false },
};
const DAYS: Record<string, number> = { days: 1, years: 365.25, hours: 1 / 24, minutes: 1 / 1440, seconds: 1 / 86400 };
/** Calendar month (1-12) at the middle of each period, null for steady-state periods (as the server computes it). */
export function periodMonths(doc: BuildDoc): (number | null)[] {
  const [y, m] = (doc.time.start ?? "2025-01").split("-").map(Number);
  const t0 = Date.UTC(y, m - 1, 1), per = DAYS[doc.time_units] ?? 1;
  let el = 0;
  return doc.time.periods.map((p) => {
    if (p.steady) return null;
    const d = p.perlen * per, mid = new Date(t0 + (el + d / 2) * 864e5);
    el += d;
    return mid.getUTCMonth() + 1;
  });
}
export function periodLabels(doc: BuildDoc): string[] {
  if (!doc.time.start) {  // no calendar in the model: say where each period ends, never invent dates
    let el = 0;
    return doc.time.periods.map((p, i) => { el += p.perlen; return `P${i + 1} · ${+el.toFixed(1)} ${doc.time_units === "days" ? "d" : doc.time_units}`; });
  }
  const mon = periodMonths(doc), [y, m] = doc.time.start.split("-").map(Number), per = DAYS[doc.time_units] ?? 1;
  let el = 0;
  return doc.time.periods.map((p, i) => {
    if (p.steady) return i === 0 ? "steady start" : "steady";
    const d = new Date(Date.UTC(y, m - 1, 1) + (el + (p.perlen * per) / 2) * 864e5); el += p.perlen * per;
    return mon[i] ? d.toLocaleDateString("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" }) : `P${i + 1}`;
  });
}
export function factorsOf(doc: BuildDoc, name: string | null): number[] {
  const n = doc.time.periods.length;
  if (!name) return Array(n).fill(1);
  const s = doc.schedules[name];
  if (!s) return Array(n).fill(1);
  let f: number[];
  if (s.kind === "series") { f = s.factors.slice(0, n); while (f.length < n) f.push(f[f.length - 1] ?? 1); }
  else { const mean = s.factors.reduce((a, x) => a + x, 0) / 12; f = periodMonths(doc).map((mo) => (mo == null ? mean : s.factors[mo - 1])); }
  for (const o of s.overrides ?? []) for (let p = Math.max(0, o.from); p <= Math.min(n - 1, o.to); p++) f[p] *= o.factor;
  return f;
}
export function usedBy(doc: BuildDoc, name: string): string[] {
  return [...doc.boundaries.filter((x) => x.schedule === name).map((x) => x.id), ...(doc.recharge?.schedule === name ? ["recharge"] : []), ...(doc.et?.schedule === name ? ["ET"] : [])];
}
export function setTime(doc: BuildDoc, o: { transient: boolean; start: string; period: "month" | "week" | number; count: number; nstp: number; steadyFirst: boolean }): BuildDoc {
  if (!o.transient) return { ...doc, time: { start: o.start, periods: [{ perlen: 1, nstp: 1, tsmult: 1, steady: true }] } };
  const [y, m] = o.start.split("-").map(Number), toUnits = 1 / (DAYS[doc.time_units] ?? 1), per: Period[] = [];
  if (o.steadyFirst) per.push({ perlen: 1, nstp: 1, tsmult: 1, steady: true });
  for (let i = 0; i < o.count; i++) {
    const days = o.period === "month" ? new Date(Date.UTC(y, m - 1 + i + 1, 0)).getUTCDate() : o.period === "week" ? 7 : o.period;
    per.push({ perlen: +(days * toUnits).toPrecision(10), nstp: o.nstp, tsmult: 1, steady: false });
  }
  return { ...doc, time: { start: o.start, periods: per } };
}
/** Whether the periods follow a pattern the Time panel can reproduce exactly (an optional steady warm-up, then equal
 *  months, weeks or days). Anything else is shown as uploaded, so a stray click cannot rewrite a model's schedule. */
export function timeRegular(doc: BuildDoc): boolean {
  const p = doc.time.periods, d = DAYS[doc.time_units] ?? 1;
  const rest = p[0]?.steady && p[0].perlen <= 1 ? p.slice(1) : p;
  if (rest.length <= 1 || rest.some((x) => x.steady)) return rest.length <= 1 && !!p[0]?.steady;
  const n = rest[0].nstp, len = rest.map((x) => x.perlen * d);
  const monthly = len.every((v) => v >= 28 && v <= 31), equal = len.every((v) => Math.abs(v - len[0]) < 1e-6);
  return rest.every((x) => x.nstp === n) && (monthly ? !!doc.time.start : equal);
}
/** How the document's time reads back into the Time panel's controls. */
export function timeSetup(doc: BuildDoc) {
  const p = doc.time.periods, tr = p.filter((x) => !x.steady), d = (DAYS[doc.time_units] ?? 1);
  const len = tr.length ? tr[0].perlen * d : 30;
  const period: "month" | "week" | number = tr.every((x) => x.perlen * d >= 28 && x.perlen * d <= 31) ? "month" : tr.every((x) => Math.abs(x.perlen * d - 7) < 1e-6) ? "week" : Math.round(len);
  return { transient: tr.length > 0, start: doc.time.start ?? "2025-01", period, count: tr.length || 12, nstp: tr[0]?.nstp ?? 2, steadyFirst: !!p[0]?.steady && tr.length > 0 };
}

// ---- what the 3D view draws while a package is being built
import type { Bore, SceneModel, UploadedRun } from "../types";
export function buildScene(b: Build, run: UploadedRun | null, period: number, o: { layer: number; color: string | null; showInactive: boolean; boreMode: "wel" | "obs" | null }): SceneModel {
  const { nlay, nrow, ncol, delr, delc } = b.doc.grid, n = nrow * ncol, act = b.arr.idomain;
  const anyActive = (r: number, c: number) => { if (!act) return true; for (let L = 0; L < nlay; L++) if (act[L * n + r * ncol + c] > 0) return true; return false; };
  const top = Array.from({ length: nrow }, (_, r) => Array.from({ length: ncol }, (_, c) => (o.showInactive || anyActive(r, c) ? b.arr.top[r * ncol + c] : null)));
  const botm = Array.from({ length: nlay }, (_, L) => Array.from({ length: nrow }, (_, r) => Array.from({ length: ncol }, (_, c) => (top[r][c] == null ? null : b.arr.botm[L * n + r * ncol + c]))));
  const grid = { nlay, nrow, ncol, delr_km: delr.reduce((a, x) => a + x, 0) / ncol / 1000, delc_km: delc.reduce((a, x) => a + x, 0) / nrow / 1000, top, botm };
  // the last solve when it is of this grid, else the starting heads
  const fits = run && run.grid.nrow === nrow && run.grid.ncol === ncol && run.grid.nlay === nlay;
  const p = fits ? Math.min(period, run!.wt.length - 1) : 0;
  const wt = fits ? run!.wt[p].map((row, r) => row.map((v, c) => (top[r][c] == null ? null : v)))
    : top.map((row, r) => row.map((t, c) => (t == null ? null : Math.min(t, b.arr.strt[r * ncol + c]))));
  const dtw = wt.map((row, r) => row.map((v, c) => (v == null || top[r][c] == null ? null : (top[r][c] as number) - v)));
  let prop: (number | null)[][] | null = null;
  if (o.color === "idomain" && act) prop = top.map((row, r) => row.map((_, c) => (act[o.layer * n + r * ncol + c] > 0 ? 0.55 : 0.02)));
  else if (o.color && b.arr[o.color]) {
    const meta = PROPS.find((x) => x.key === o.color), vals = layer2d(b, o.color, o.layer);
    const f = (v: number) => (meta?.log ? Math.log10(Math.max(v, 1e-12)) : v);
    const xs = vals.flat().filter((v): v is number => v != null).map(f);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    prop = vals.map((row) => row.map((v) => (v == null ? null : hi > lo ? (f(v) - lo) / (hi - lo) : 0.5)));
  }
  const wells: Bore[] = b.doc.boundaries.filter((x) => x.type === "wel").map((x, i) => ({ bore_id: o.boreMode === "wel" ? `P${i + 1}` : x.id, bore_type: o.boreMode === "wel" ? "proposed" : "production", layer: x.cells[0][0], row: x.cells[0][1], col: x.cells[0][2] }));
  const obs: Bore[] = b.doc.obs.map((x, i) => ({ bore_id: o.boreMode === "obs" ? `P${i + 1}` : x.name, bore_type: o.boreMode === "obs" ? "proposed" : "monitoring", layer: x.cell[0], row: x.cell[1], col: x.cell[2] }));
  return { key: `b:${b.doc.name}:${nlay}x${nrow}x${ncol}`, grid, wt, dtw, features: { river: [], canal: [], drain: [], chd: [] }, bores: [...wells, ...obs], change: null, prop };
}
/** The range of the property drawn, for the legend. */
export function propRange(b: Build, key: string, layer: number): [number, number] | null {
  const xs = layer2d(b, key, layer).flat().filter((v): v is number => v != null);
  return xs.length ? [Math.min(...xs), Math.max(...xs)] : null;
}
