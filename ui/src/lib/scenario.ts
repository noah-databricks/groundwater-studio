/** Scenario documents: canonical form, the line-diffable file layout, and line / model diffs. */
import type { DrainLine, Fidelity, Crop, Scenario } from "../types";

export const CROP_ORDER: Crop[] = ["rice", "broadacre", "horticulture", "pasture", "dryland"];
// validated categorical set (dataviz validator, light surface); dryland is the neutral ground
export const CROP_COLORS: Record<Crop, string> = {
  rice: "#0a8f86", broadacre: "#c99a12", horticulture: "#7e57c2", pasture: "#5c8f2d", dryland: "#e4dfcf",
};

// one key order everywhere (the server's), so equal settings serialise and diff identically
const KEYS: (keyof Scenario)[] = ["k_mult", "sy", "rain_mult", "et_mult", "deep_drainage_frac", "pumping_mult", "canal_lining_pct", "lined_reaches", "land_use", "extra_bores", "drain_lines"];
export function canonical(s: Scenario): Scenario {
  const out = {} as Record<string, unknown>;
  for (const k of KEYS) out[k] = s[k];
  for (const k of Object.keys(s)) if (!(k in out) && k !== "rain_recharge_frac") out[k] = (s as Record<string, unknown>)[k];
  out.lined_reaches = [...new Set(s.lined_reaches ?? [])].sort();
  out.land_use = [...(s.land_use ?? [])].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  out.extra_bores = (s.extra_bores ?? []).map((b) => ({ row: b.row, col: b.col, layer: b.layer ?? 1, ML_per_year: b.ML_per_year }));
  if (s.drain_lines?.length) out.drain_lines = s.drain_lines.map((d) => ({ name: d.name, cells: d.cells.map(([r, c]) => [r, c]), depth_m: d.depth_m, cond: d.cond ?? 500 }));
  else delete out.drain_lines;
  const f = fidelity(s);
  if (isNative(f)) delete out.fidelity; else out.fidelity = f;
  return out as Scenario;
}

export const NATIVE: Fidelity = { refine: 1, sublayers: 1, nstp: 2, solver: "standard" };
export const REFINE = [1, 2, 3, 4, 5, 6, 8, 10];
export const fidelity = (s: Scenario): Fidelity => ({ ...NATIVE, ...(s.fidelity ?? {}) });
export const isNative = (f: Fidelity) => f.refine === 1 && f.sublayers === 1 && f.nstp === 2 && f.solver === "standard";
export const cellM = (f: Fidelity) => 250 / f.refine;
export const fidelityText = (f: Fidelity) =>
  `${+cellM(f).toFixed(1)} m${f.sublayers > 1 ? ` · ${f.sublayers} layers/aquifer` : ""}${f.nstp !== 2 ? ` · ${f.nstp} steps/month` : ""}${f.solver !== "standard" ? ` · ${f.solver}` : ""}`;
export const same = (a: Scenario, b: Scenario) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function landUseFor(base: Crop[][], s: Scenario): Crop[][] {
  const lu = base.map((r) => [...r]);
  for (const [r, c, k] of s.land_use) if (lu[r]?.[c] !== undefined) lu[r][c] = k;
  return lu;
}

/** Apply painted cells, keeping only overrides that differ from the Unity Catalog map. */
export function paint(s: Scenario, base: Crop[][], cells: { row: number; col: number }[], crop: Crop | "original"): Scenario {
  const m = new Map<string, Crop>(s.land_use.map(([r, c, k]) => [`${r},${c}`, k]));
  for (const { row, col } of cells) {
    const key = `${row},${col}`, to = crop === "original" ? base[row][col] : crop;
    if (to === base[row][col]) m.delete(key); else m.set(key, to);
  }
  const land_use = [...m].map(([k, v]) => { const [r, c] = k.split(",").map(Number); return [r, c, v] as [number, number, Crop]; });
  return canonical({ ...s, land_use });
}

/** The same one-entry-per-line layout the server writes to the volume, so file diffs read like code diffs. */
export function dump(v: unknown, depth = 0): string {
  const pad = " ".repeat(depth + 1);
  if (v && typeof v === "object" && !Array.isArray(v))
    return "{\n" + Object.entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${dump(x, depth + 1)}`).join(",\n") + "\n" + " ".repeat(depth) + "}";
  if (Array.isArray(v) && v.length)
    return "[\n" + v.map((x) => pad + JSON.stringify(x).replace(/,(?=["\d[{-])/g, ", ").replace(/":/g, "\": ")).join(",\n") + "\n" + " ".repeat(depth) + "]";
  return JSON.stringify(v);
}

export type Op = { t: " " | "+" | "-"; a?: number; b?: number; text: string };
/** Myers O(ND) line diff. */
export function diffLines(A: string[], B: string[]): Op[] {
  const N = A.length, M = B.length, max = N + M, off = max;
  const v = new Int32Array(2 * max + 2), trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = true; break; }
    }
  }
  const ops: Op[] = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const px = vv[off + prevK], py = px - prevK;
    while (x > px && y > py) { x--; y--; ops.push({ t: " ", a: x + 1, b: y + 1, text: A[x] }); }
    if (d > 0) {
      if (x === px) { y--; ops.push({ t: "+", b: y + 1, text: B[y] }); }
      else { x--; ops.push({ t: "-", a: x + 1, text: A[x] }); }
    }
  }
  return ops.reverse();
}

export type Hunk = { head: string; ops: Op[] } | { skip: number; ops: Op[] };
export function hunks(ops: Op[], ctx = 3): Hunk[] {
  const keep = ops.map(() => false);
  ops.forEach((o, i) => { if (o.t !== " ") for (let j = Math.max(0, i - ctx); j <= Math.min(ops.length - 1, i + ctx); j++) keep[j] = true; });
  const out: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) { const part: Op[] = []; while (i < ops.length && !keep[i]) part.push(ops[i++]); out.push({ skip: part.length, ops: part }); continue; }
    const part: Op[] = [];
    while (i < ops.length && keep[i]) part.push(ops[i++]);
    const a0 = part.find((o) => o.a)?.a ?? 0, b0 = part.find((o) => o.b)?.b ?? 0;
    const na = part.filter((o) => o.t !== "+").length, nb = part.filter((o) => o.t !== "-").length;
    out.push({ head: `@@ -${a0},${na} +${b0},${nb} @@`, ops: part });
  }
  return out;
}

export type SceneDiff = {
  cells: { row: number; col: number; from: Crop; to: Crop }[];
  lined: string[]; unlined: string[];
  boresAdded: { row: number; col: number }[]; boresRemoved: { row: number; col: number }[];
  drainsAdded: DrainLine[]; drainsRemoved: DrainLine[];
};

/** Cells from a to b in a straight line, the way the server traces a drain or a section (cell centre to cell centre). */
export function line(a: [number, number], b: [number, number]): [number, number][] {
  const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  if (!n) return [[a[0], a[1]]];
  // round half to even, as Python does, so a traced path is the same on both sides
  const rnd = (x: number) => { const f = Math.floor(x), d = x - f; return d > 0.5 + 1e-9 ? f + 1 : d < 0.5 - 1e-9 ? f : f % 2 === 0 ? f : f + 1; };
  return Array.from({ length: n + 1 }, (_, t) => [rnd(a[0] + ((b[0] - a[0]) * t) / n), rnd(a[1] + ((b[1] - a[1]) * t) / n)] as [number, number]);
}
/** A polyline of cells traced into a connected path with no repeats. */
export function trace(pts: [number, number][]): [number, number][] {
  const path: [number, number][] = [];
  const pairs = pts.length > 1 ? pts.slice(1).map((b, i) => [pts[i], b] as const) : [[pts[0], pts[0]] as const];
  for (const [a, b] of pairs) for (const q of line(a, b)) if (!path.length || path[path.length - 1][0] !== q[0] || path[path.length - 1][1] !== q[1]) path.push(q);
  const seen = new Set<string>();
  return path.filter(([r, c]) => { const k = `${r},${c}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
/** Cells whose centre is inside a polygon of fractional [row, col] vertices (even-odd), as the server selects them. */
export function inPolygon(poly: [number, number][], nrow: number, ncol: number): [number, number][] {
  const out: [number, number][] = [];
  for (let r = 0; r < nrow; r++) for (let c = 0; c < ncol; c++) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [r0, c0] = poly[j], [r1, c1] = poly[i];
      if ((r0 > r) !== (r1 > r) && c < c0 + ((r - r0) * (c1 - c0)) / (r1 - r0)) inside = !inside;
    }
    if (inside) out.push([r, c]);
  }
  return out;
}
export function sceneDiff(a: Scenario, b: Scenario, base: Crop[][]): SceneDiff {
  const la = landUseFor(base, a), lb = landUseFor(base, b), cells: SceneDiff["cells"] = [];
  la.forEach((row, r) => row.forEach((k, c) => { if (k !== lb[r][c]) cells.push({ row: r, col: c, from: k, to: lb[r][c] }); }));
  const A = new Set(a.lined_reaches), B = new Set(b.lined_reaches);
  const key = (x: { row: number; col: number; ML_per_year: number }) => `${x.row},${x.col},${x.ML_per_year}`;
  const ka = new Set(a.extra_bores.map(key)), kb = new Set(b.extra_bores.map(key));
  const dk = (x: DrainLine) => JSON.stringify([x.name, x.cells, x.depth_m]);
  const da = new Set((a.drain_lines ?? []).map(dk)), db = new Set((b.drain_lines ?? []).map(dk));
  return {
    cells, lined: [...B].filter((x) => !A.has(x)), unlined: [...A].filter((x) => !B.has(x)),
    boresAdded: b.extra_bores.filter((x) => !ka.has(key(x))), boresRemoved: a.extra_bores.filter((x) => !kb.has(key(x))),
    drainsAdded: (b.drain_lines ?? []).filter((x) => !da.has(dk(x))), drainsRemoved: (a.drain_lines ?? []).filter((x) => !db.has(dk(x))),
  };
}
export const emptyDiff = (d: SceneDiff) => !d.cells.length && !d.lined.length && !d.unlined.length && !d.boresAdded.length && !d.boresRemoved.length
  && !d.drainsAdded.length && !d.drainsRemoved.length;
