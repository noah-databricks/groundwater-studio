/** Pure grid geometry: contours, revision clouds, section slices. No three.js here. */
export type Pt = [number, number]; // (col, row) in cell-centre units

/** Marching squares over cell-centred values; returns polylines at `level` (NaN cells break lines). */
export function contour(z: (number | null)[][], level: number): Pt[][] {
  const nr = z.length, nc = z[0].length, segs: [Pt, Pt][] = [];
  const v = (r: number, c: number) => { const x = z[r][c]; return x == null ? NaN : x; };
  const lerp = (a: number, b: number) => (level - a) / (b - a);
  for (let r = 0; r < nr - 1; r++) for (let c = 0; c < nc - 1; c++) {
    const a = v(r, c), b = v(r, c + 1), d = v(r + 1, c), e = v(r + 1, c + 1);
    if ([a, b, d, e].some(Number.isNaN)) continue;
    const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (e > level ? 2 : 0) | (d > level ? 1 : 0);
    if (idx === 0 || idx === 15) continue;
    const top: Pt = [c + lerp(a, b), r], right: Pt = [c + 1, r + lerp(b, e)];
    const bot: Pt = [c + lerp(d, e), r + 1], left: Pt = [c, r + lerp(a, d)];
    const table: Record<number, [Pt, Pt][]> = {
      1: [[left, bot]], 2: [[bot, right]], 3: [[left, right]], 4: [[top, right]], 5: [[left, top], [bot, right]],
      6: [[top, bot]], 7: [[left, top]], 8: [[left, top]], 9: [[top, bot]], 10: [[left, bot], [top, right]],
      11: [[top, right]], 12: [[left, right]], 13: [[bot, right]], 14: [[left, bot]],
    };
    table[idx].forEach((s) => segs.push(s));
  }
  return chain(segs);
}

function chain(segs: [Pt, Pt][]): Pt[][] {
  const key = (p: Pt) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const ends = new Map<string, number[]>();
  segs.forEach((s, i) => s.forEach((p) => { const k = key(p); ends.set(k, [...(ends.get(k) || []), i]); }));
  const used = new Set<number>(), lines: Pt[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const line: Pt[] = [segs[i][0], segs[i][1]];
    for (const dir of [1, -1]) {
      for (;;) {
        const tip = dir === 1 ? line[line.length - 1] : line[0];
        const nxt = (ends.get(key(tip)) || []).find((j) => !used.has(j));
        if (nxt === undefined) break;
        used.add(nxt);
        const [p, q] = segs[nxt], other = key(p) === key(tip) ? q : p;
        if (dir === 1) line.push(other); else line.unshift(other);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Scalloped "revision cloud" around a contour line, as drawn by hand on a checked print. */
export function cloud(line: Pt[], arc = 0.9): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [x0, y0] = line[i], [x1, y1] = line[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(len / arc));
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      const ax = x0 + (x1 - x0) * t0, ay = y0 + (y1 - y0) * t0, bx = x0 + (x1 - x0) * t1, by = y0 + (y1 - y0) * t1;
      const nx = -(by - ay), ny = bx - ax, nl = Math.hypot(nx, ny) || 1;
      for (let s = 0; s <= 6; s++) {
        const u = s / 6, bulge = Math.sin(Math.PI * u) * (len / n) * 0.42;
        out.push([ax + (bx - ax) * u + (nx / nl) * bulge, ay + (by - ay) * u + (ny / nl) * bulge]);
      }
    }
  }
  return out;
}

/** Smooth a contour for drawing (Chaikin). */
export function smooth(line: Pt[], passes = 2): Pt[] {
  let p = line;
  for (let k = 0; k < passes; k++) {
    if (p.length < 3) return p;
    const q: Pt[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[i + 1];
      q.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

/** Bilinear sample of a cell-centred grid at fractional (col,row). */
export function sample(z: (number | null)[][], c: number, r: number): number | null {
  const nr = z.length, nc = z[0].length;
  const cc = Math.min(nc - 1, Math.max(0, c)), rr = Math.min(nr - 1, Math.max(0, r));
  const c0 = Math.floor(cc), r0 = Math.floor(rr), c1 = Math.min(nc - 1, c0 + 1), r1 = Math.min(nr - 1, r0 + 1);
  const fx = cc - c0, fy = rr - r0;
  const g = (rq: number, cq: number) => z[rq][cq];
  const vals = [g(r0, c0), g(r0, c1), g(r1, c0), g(r1, c1)];
  if (vals.some((v) => v == null)) return vals.find((v) => v != null) ?? null;
  const [a, b, d, e] = vals as number[];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy;
}

export const niceStep = (span: number, target = 5) => {
  const raw = span / target, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
};
