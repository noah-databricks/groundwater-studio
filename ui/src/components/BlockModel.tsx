import { Html, Line, OrbitControls, OrthographicCamera } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { cloud, contour, sample, smooth, type Pt } from "../lib/geom";
import { EARTH_STOPS, INK, PROB_STOPS, REDLINE, SHEET, WATER_STOPS, ramp } from "../theme";
const FLY: Record<string, string> = { w: "n", ArrowUp: "n", s: "s", ArrowDown: "s", a: "w", ArrowLeft: "w", d: "e", ArrowRight: "e",
  q: "ccw", e: "cw", "=": "in", "+": "in", "-": "out", _: "out" };
export type CameraCmd = { kind: "zoom"; f: number } | { kind: "reset" } | { kind: "rotate"; deg: number }
  | { kind: "focus"; rows: [number, number]; cols: [number, number] };
import type { Bore, Crop, Reach, SceneModel, Tool, ZoneShape } from "../types";
import { CROP_COLORS, type SceneDiff } from "../lib/scenario";

export const DIFF_ADD = "#1a7f37", DIFF_DEL = "#cf222e";

export type ViewMode = "axo" | "plan";
type Props = {
  model: SceneModel; view: ViewMode; ex: number; section: { on: boolean; row: number; line?: [number, number][] | null };
  onSectionRow: (row: number) => void; selectedBore: string | null; onSelectBore: (id: string) => void;
  placing: boolean; onPlace: (row: number, col: number) => void; showClouds: boolean;
  colorMode: "dtw" | "probability" | "prop"; readout: React.RefObject<Readout | null>;
  cmd?: { n: number; c: CameraCmd } | null;
  /** px covered by overlay panels on the right; the model centres in the remaining space */
  inset: number;
  layerNames?: string[];
  tool?: Tool; crop?: Crop | "original"; brush?: number;
  landUse?: Crop[][] | null; baseLandUse?: Crop[][] | null; onPaint?: (cells: { row: number; col: number }[]) => void;
  /** what the agent is looking at: an overlay and the cells it found */
  overlay?: "land" | "reaches" | null; highlight?: { row: number; col: number }[] | null;
  reaches?: Reach[]; lined?: string[]; hoverReach?: string | null; onHoverReach?: (id: string | null) => void; onToggleReach?: (id: string) => void;
  diff?: SceneDiff | null; onRemoveBore?: (i: number) => void;
  /** cells outlined on the model: the inspected cell, the open zone */
  marks?: { cells: { row: number; col: number }[]; color: string }[];
  /** proposed interceptor drains, and removing one with the drains tool */
  drains?: { name: string; cells: [number, number][]; depth_m?: number; color?: string; label?: string; removable?: boolean }[]; onRemoveDrain?: (name: string) => void;
  /** the grid's rotation from east, degrees counter-clockwise (MODFLOW's ANGROT): turns the north arrow */
  northDeg?: number;
  /** alt-click: pick up a cell (the Build palette's eyedropper) */
  onPick?: (row: number, col: number) => void;
  /** select: click a cell to inspect it; zones, section and drains: a finished drawing */
  onInspect?: (row: number, col: number) => void;
  onDrawZone?: (shape: ZoneShape) => void; onDrawLine?: (kind: "section" | "drains", pts: [number, number][]) => void;
};
const DRAW_TOOLS = new Set<Tool>(["zones", "section", "drains"]);
export const ZONE_INK = "#0b2f5e";
export type Readout = { north: HTMLElement | null };

/* ------------------------------------------------------------------ materials */
type Pattern = "hatch45" | "hatch135" | "cross" | "stipple" | "water";
const PAT: Record<Pattern, number> = { hatch45: 0, hatch135: 1, cross: 2, stipple: 3, water: 4 };
function patternMaterial(fill: string, pattern: Pattern, alpha: number, space: number) {
  // Patterns live in world space on each face (s = distance along the face, t = height), so they
  // stay glued to the model as it orbits. Lines are anti-aliased with fwidth and fade to tone
  // when they get denser than the screen can draw.
  return new THREE.ShaderMaterial({
    uniforms: { uFill: { value: new THREE.Color(fill) }, uInk: { value: new THREE.Color(INK) }, uPat: { value: PAT[pattern] },
      uAlpha: { value: alpha }, uSpace: { value: space } },
    vertexShader: `varying vec3 vW; varying vec3 vN;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform vec3 uFill; uniform vec3 uInk; uniform int uPat; uniform float uAlpha; uniform float uSpace;
      varying vec3 vW; varying vec3 vN;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      float lines(float x){ float w = fwidth(x); float d = abs(fract(x + 0.5) - 0.5);
        return (1.0 - smoothstep(w * 0.55, w * 1.45, d)) * (1.0 - smoothstep(0.22, 0.45, w)); }
      void main(){
        vec3 n = normalize(vN);
        vec2 q = vec2(dot(vW.xz, vec2(-n.z, n.x)), vW.y) / uSpace;
        float ink = 0.0;
        if (uPat == 0) ink = lines(q.x + q.y);
        else if (uPat == 1) ink = lines(q.x - q.y);
        else if (uPat == 2) ink = max(lines((q.x + q.y) * 0.7), lines((q.x - q.y) * 0.7));
        else if (uPat == 3) {
          vec2 g = q * 1.6; vec2 c = floor(g); vec2 o = vec2(hash(c), hash(c + 7.1)) * 0.6 + 0.2;
          float d = length(g - c - o); float w = fwidth(g.x);
          ink = step(0.45, hash(c + 3.3)) * (1.0 - smoothstep(0.1, 0.1 + w * 1.5, d)) * (1.0 - smoothstep(0.25, 0.5, w));
        } else {
          float y = q.y * 1.2; float row = floor(y + 0.5);
          ink = lines(y) * step(fract(q.x * 0.35 + row * 0.37), 0.42);
        }
        vec3 L = normalize(vec3(-0.45, 0.8, 0.35));
        float shade = 0.84 + 0.16 * max(dot(n, L), 0.0);
        gl_FragColor = vec4(mix(uFill * shade, uInk, ink * uAlpha), 1.0);
      }`,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide,
  });
}
const LAYER_PATTERNS: Pattern[] = ["hatch45", "cross", "hatch135", "hatch45"];
const LAYER_FILLS = ["#e9e8e2", "#dcdbd4", "#e9e8e2", "#dcdbd4"];

/* ------------------------------------------------------------------ geometry */
type Built = {
  cx: number; cz: number; datum: number; sx: number; sz: number; sy: number;
  water: THREE.BufferGeometry; faces: { geo: THREE.BufferGeometry; mat: THREE.ShaderMaterial }[];
  strong: Float32Array; hair: Float32Array; wtEdge: Float32Array; landMinor: Float32Array; landMajor: Float32Array;
  isolines: Float32Array; risk: Pt[][]; clouds: Pt[][]; landY: (c: number, r: number) => number;
};

function corners(z: (number | null)[][], vis: (r: number, c: number) => boolean) {
  const nr = z.length, nc = z[0].length, out: (number | null)[][] = [];
  for (let r = 0; r <= nr; r++) {
    const row: (number | null)[] = [];
    for (let c = 0; c <= nc; c++) {
      let s = 0, n = 0;
      for (const [rr, cc] of [[r - 1, c - 1], [r - 1, c], [r, c - 1], [r, c]]) {
        if (rr < 0 || cc < 0 || rr >= nr || cc >= nc || !vis(rr, cc)) continue;
        const v = z[rr][cc]; if (v == null) continue; s += v; n++;
      }
      row.push(n ? s / n : null);
    }
    out.push(row);
  }
  return out;
}

function build(m: SceneModel, cut: { on: boolean; row: number }, colorMode: "dtw" | "probability" | "prop", showClouds: boolean): Built {
  const g = m.grid, nr = g.nrow, nc = g.ncol, dx = g.delr_km, dz = g.delc_km;
  const sx = nc * dx, sz = nr * dz, cx = sx / 2, cz = sz / 2;
  const botmAll = g.botm.flat(2).filter((v): v is number => v != null);
  const datum = Math.min(...botmAll) - 2;
  const Y = (elev: number) => (elev - datum) / 1000;
  const X = (c: number) => c * dx - cx, Z = (r: number) => r * dz - cz;
  const active = (r: number, c: number) => g.top[r][c] != null;
  const vis = (r: number, c: number) => r >= 0 && c >= 0 && r < nr && c < nc && active(r, c) && !(cut.on && r > cut.row);

  const wtClamped = m.wt.map((row, r) => row.map((v, c) => {
    const t = g.top[r][c], b = g.botm[0][r][c];
    if (v == null || t == null || b == null) return v;
    return Math.min(t, Math.max(b, v));
  }));
  const topC = corners(g.top, vis), wtC = corners(wtClamped, vis);
  const botC = g.botm.map((b) => corners(b, vis));
  const colorVal = colorMode === "probability" && m.probability ? m.probability : colorMode === "prop" && m.prop ? m.prop : m.dtw;
  const colC = corners(colorVal, vis);
  const stops = colorMode === "probability" ? PROB_STOPS : colorMode === "prop" && m.prop ? EARTH_STOPS : WATER_STOPS;

  // water table surface (smooth, coloured by depth to water or probability)
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const vid = new Map<number, number>();
  const vtx = (r: number, c: number) => {
    const k = r * (nc + 1) + c;
    if (vid.has(k)) return vid.get(k)!;
    const y = wtC[r][c] ?? topC[r][c] ?? datum;
    pos.push(X(c), Y(y as number), Z(r));
    col.push(...ramp(stops, colC[r][c]));
    vid.set(k, pos.length / 3 - 1); return pos.length / 3 - 1;
  };
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
    if (!vis(r, c)) continue;
    const a = vtx(r, c), b = vtx(r, c + 1), d = vtx(r + 1, c), e = vtx(r + 1, c + 1);
    idx.push(a, d, b, b, d, e);
  }
  const water = new THREE.BufferGeometry();
  water.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  water.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  water.setIndex(idx); water.computeVertexNormals();

  // exposed vertical faces, split into bands
  const bands: { lo: (r: number, c: number) => number | null; hi: (r: number, c: number) => number | null; pat: Pattern; fill: string; alpha: number }[] = [
    { lo: (r, c) => wtC[r][c], hi: (r, c) => topC[r][c], pat: "stipple", fill: "#f6f5f0", alpha: 0.75 },
    { lo: (r, c) => botC[0][r][c], hi: (r, c) => wtC[r][c], pat: "water", fill: "#b8d2ef", alpha: 0.35 },
    ...g.botm.slice(1).map((_, k) => ({ lo: (r: number, c: number) => botC[k + 1][r][c], hi: (r: number, c: number) => botC[k][r][c],
      pat: LAYER_PATTERNS[k % 4], fill: LAYER_FILLS[k % 4], alpha: 0.36 })),
  ];
  const faceBufs = bands.map(() => ({ p: [] as number[], n: [] as number[] }));
  const strong: number[] = [], hair: number[] = [], wtEdge: number[] = [];
  const edges: [number, number, number, number, number, number][] = []; // r0,c0,r1,c1 corners + normal x,z
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
    if (!vis(r, c)) continue;
    if (!vis(r - 1, c)) edges.push([r, c + 1, r, c, 0, -1]);
    if (!vis(r + 1, c)) edges.push([r + 1, c, r + 1, c + 1, 0, 1]);
    if (!vis(r, c - 1)) edges.push([r, c, r + 1, c, -1, 0]);
    if (!vis(r, c + 1)) edges.push([r + 1, c + 1, r, c + 1, 1, 0]);
  }
  for (const [r0, c0, r1, c1, nx, nz] of edges) {
    bands.forEach((b, i) => {
      const lo0 = b.lo(r0, c0), lo1 = b.lo(r1, c1), hi0 = b.hi(r0, c0), hi1 = b.hi(r1, c1);
      if (lo0 == null || lo1 == null || hi0 == null || hi1 == null) return;
      const P = [X(c0), Y(lo0), Z(r0), X(c1), Y(lo1), Z(r1), X(c1), Y(hi1), Z(r1), X(c0), Y(hi0), Z(r0)];
      const f = faceBufs[i];
      f.p.push(...P.slice(0, 3), ...P.slice(3, 6), ...P.slice(6, 9), ...P.slice(0, 3), ...P.slice(6, 9), ...P.slice(9, 12));
      for (let k = 0; k < 6; k++) f.n.push(nx, 0, nz);
    });
    const t0 = topC[r0][c0], t1 = topC[r1][c1], w0 = wtC[r0][c0], w1 = wtC[r1][c1];
    const bb = botC[botC.length - 1], b0 = bb[r0][c0], b1 = bb[r1][c1];
    if (t0 != null && t1 != null) strong.push(X(c0), Y(t0), Z(r0), X(c1), Y(t1), Z(r1));
    if (b0 != null && b1 != null) strong.push(X(c0), Y(b0), Z(r0), X(c1), Y(b1), Z(r1));
    if (w0 != null && w1 != null) wtEdge.push(X(c0), Y(w0), Z(r0), X(c1), Y(w1), Z(r1));
    botC.slice(0, -1).forEach((bc) => { const a = bc[r0][c0], e = bc[r1][c1]; if (a != null && e != null) hair.push(X(c0), Y(a), Z(r0), X(c1), Y(e), Z(r1)); });
  }
  const faces = bands.map((b, i) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(faceBufs[i].p, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(faceBufs[i].n, 3));
    return { geo, mat: patternMaterial(b.fill, b.pat, b.alpha, Math.max(sx, sz) / 60) };
  });

  // land-surface construction grid (hairline, every 5th cell stronger)
  const landMinor: number[] = [], landMajor: number[] = [];
  const lift = 0.0004;
  for (let r = 0; r <= nr; r++) for (let c = 0; c < nc; c++) {
    if (!vis(r, c) && !vis(r - 1, c)) continue;
    const a = topC[r][c], b = topC[r][c + 1]; if (a == null || b == null) continue;
    (r % 5 === 0 ? landMajor : landMinor).push(X(c), Y(a) + lift, Z(r), X(c + 1), Y(b) + lift, Z(r));
  }
  for (let c = 0; c <= nc; c++) for (let r = 0; r < nr; r++) {
    if (!vis(r, c) && !vis(r, c - 1)) continue;
    const a = topC[r][c], b = topC[r + 1][c]; if (a == null || b == null) continue;
    (c % 5 === 0 ? landMajor : landMinor).push(X(c), Y(a) + lift, Z(r), X(c), Y(b) + lift, Z(r + 1));
  }

  // water-table isolines every 0.5 m on the surface
  const isolines: number[] = [];
  const wtVals = wtClamped.flat().filter((v): v is number => v != null);
  const lo = Math.ceil(Math.min(...wtVals) * 2) / 2, hi = Math.max(...wtVals);
  const inView = (p: Pt) => vis(Math.round(p[1]), Math.round(p[0]));
  for (let lv = lo; lv <= hi; lv += 0.5) {
    for (const line of contour(wtClamped, lv)) {
      const sm = smooth(line, 1);
      for (let i = 0; i < sm.length - 1; i++) {
        if (!inView(sm[i]) || !inView(sm[i + 1])) continue;
        isolines.push(X(sm[i][0] + 0.5), Y(lv) + 0.0003, Z(sm[i][1] + 0.5), X(sm[i + 1][0] + 0.5), Y(lv) + 0.0003, Z(sm[i + 1][1] + 0.5));
      }
    }
  }
  const clip = (lines: Pt[][]) => lines.flatMap((l) => {
    const parts: Pt[][] = []; let cur: Pt[] = [];
    for (const q of l) { if (inView([q[0], q[1]])) cur.push(q); else { if (cur.length > 2) parts.push(cur); cur = []; } }
    if (cur.length > 2) parts.push(cur);
    return parts;
  });
  const risk = clip(contour(m.dtw, 2).map((l) => smooth(l, 2)).filter((l) => l.length > 3));
  const absChange = m.change ? m.change.map((row) => row.map((v) => (v == null ? null : Math.abs(v)))) : null;
  const clouds = showClouds && absChange ? clip(contour(absChange, 0.2).filter((l) => l.length > 6).map((l) => cloud(smooth(l, 1), 1.1))) : [];
  const landY = (c: number, r: number) => Y((sample(g.top, c, r) ?? datum) as number) + 0.0012;
  const topMax = Math.max(...(g.top.flat().filter((v): v is number => v != null)));
  return { cx, cz, datum, sx, sz, sy: (topMax - datum) / 1000, water, faces, strong: new Float32Array(strong), hair: new Float32Array(hair),
    wtEdge: new Float32Array(wtEdge), landMinor: new Float32Array(landMinor), landMajor: new Float32Array(landMajor),
    isolines: new Float32Array(isolines), risk, clouds, landY };
}

/* ------------------------------------------------------------------ helpers */
function Segs({ data, color, opacity = 1 }: { data: Float32Array; color: string; opacity?: number }) {
  const geo = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(data, 3)); return g; }, [data]);
  useEffect(() => () => geo.dispose(), [geo]);
  return <lineSegments geometry={geo}><lineBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} /></lineSegments>;
}

function chainCells(cells: { row: number; col: number }[]): { row: number; col: number }[][] {
  const left = cells.map((c) => ({ ...c })), out: { row: number; col: number }[][] = [];
  const d = (a: { row: number; col: number }, b: { row: number; col: number }) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
  while (left.length) {
    // start from the cell with fewest neighbours (an end of the channel)
    left.sort((a, b) => left.filter((x) => d(x, a) === 1).length - left.filter((x) => d(x, b) === 1).length);
    const line = [left.shift()!];
    for (;;) {
      const tip = line[line.length - 1];
      let bi = -1, bd = 9;
      left.forEach((c, i) => { const dd = d(c, tip); if (dd < bd) { bd = dd; bi = i; } });
      if (bi < 0 || bd > 1) break;
      line.push(left.splice(bi, 1)[0]);
    }
    out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ scene */
function Scene(p: Props & { built: Built }) {
  const { built: B, model: m } = p;
  const group = useRef<THREE.Group>(null);
  const exNow = useRef(p.view === "plan" ? 1 : p.ex);
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, size } = useThree();
  const [dragging, setDragging] = useState(false);
  const g = m.grid;

  useEffect(() => () => { B.water.dispose(); B.faces.forEach((f) => { f.geo.dispose(); f.mat.dispose(); }); }, [B]);

  // camera rig: one continuous move between plan and axonometric
  const anim = useRef<{ t0: number; from: THREE.Vector3; to: THREE.Vector3; z0: number; z1: number; up0: THREE.Vector3; up1: THREE.Vector3 } | null>(null);
  useEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    const axo = p.view === "axo" && p.inset > 0;
    cam.setViewOffset(size.width, size.height, axo ? p.inset * 0.95 : p.inset / 2, axo ? -size.height * 0.085 : 0, size.width, size.height);
    cam.updateProjectionMatrix();
  }, [camera, size.width, size.height, p.inset, p.view]);
  const fitZoom = (view: ViewMode) => {
    const w = Math.max(320, size.width - p.inset * 1.5), h = size.height;
    if (view === "plan") return Math.min((size.width - p.inset * 2 - 60) / (B.sx * 1.04), h / (B.sz * 1.35));
    const tall = B.sy * p.ex; // projected height grows with the exaggerated thickness
    return Math.min(w / ((B.sx + B.sz * 0.55) * 0.78), h / ((B.sz * 0.62 + tall * 0.8 + B.sx * 0.25) * 1.08));
  };
  const dirFor = (view: ViewMode) => (view === "plan" ? new THREE.Vector3(0, 1, 0.0001) : new THREE.Vector3(0.62, 0.74, 1.0)).normalize();
  useEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    anim.current = { t0: performance.now(), from: cam.position.clone().normalize(), to: dirFor(p.view), z0: cam.zoom || fitZoom(p.view),
      z1: fitZoom(p.view), up0: cam.up.clone(), up1: p.view === "plan" ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.view, m.key, size.width, size.height, p.inset, p.ex]);

  useEffect(() => {
    if (!p.cmd) return;
    const cam = camera as THREE.OrthographicCamera, c = p.cmd.c;
    if (c.kind === "zoom") { cam.zoom = Math.max(20, Math.min(900, cam.zoom * c.f)); cam.updateProjectionMatrix(); controls.current?.update(); }
    else if (c.kind === "reset") {
      anim.current = { t0: performance.now(), from: cam.position.clone().normalize(), to: dirFor(p.view), z0: cam.zoom, z1: fitZoom(p.view),
        up0: cam.up.clone(), up1: p.view === "plan" ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0) };
    } else if (c.kind === "focus" && controls.current) {
      // glide the view onto a block of cells, keeping the current angle
      const x = ((c.cols[0] + c.cols[1] + 1) / 2) * g.delr_km - B.cx, z = ((c.rows[0] + c.rows[1] + 1) / 2) * g.delc_km - B.cz;
      // close enough to read the place, never so close the rest of the district drops out of view
      const span = Math.max((c.cols[1] - c.cols[0] + 1) * g.delr_km, (c.rows[1] - c.rows[0] + 1) * g.delc_km, Math.max(B.sx, B.sz) * 0.5);
      const z1 = Math.min(fitZoom(p.view) * 1.7, Math.max(fitZoom(p.view), (Math.min(size.width - p.inset, size.height) * 0.8) / span));
      focus.current = { t0: performance.now(), from: controls.current.target.clone(), to: new THREE.Vector3(x, 0, z), z0: cam.zoom, z1 };
    } else if (c.kind === "rotate" && controls.current) {
      const off = cam.position.clone().sub(controls.current.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), (c.deg * Math.PI) / 180);
      cam.position.copy(controls.current.target).add(off); cam.lookAt(controls.current.target); controls.current.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.cmd?.n]);

  const focus = useRef<{ t0: number; from: THREE.Vector3; to: THREE.Vector3; z0: number; z1: number } | null>(null);
  // keyboard flying: W A S D or arrows pan across the ground, Q and E turn, + and − zoom; held keys move smoothly
  const held = useRef(new Set<string>());
  useEffect(() => {
    const own = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return e.metaKey || e.ctrlKey || e.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable || !!t.closest?.("[role=slider]");
    };
    const down = (e: KeyboardEvent) => { const k = FLY[e.key.length === 1 ? e.key.toLowerCase() : e.key]; if (!k || own(e)) return; e.preventDefault(); held.current.add(k); };
    const up = (e: KeyboardEvent) => { const k = FLY[e.key.length === 1 ? e.key.toLowerCase() : e.key]; if (k) held.current.delete(k); };
    const clear = () => held.current.clear();
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", clear);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", clear); };
  }, []);

  useFrame((_, dt) => {
    const cam = camera as THREE.OrthographicCamera;
    const h = held.current, c = controls.current, f = focus.current;
    if (f && c && !anim.current) {
      const k = Math.min(1, (performance.now() - f.t0) / 900), e = 1 - Math.pow(1 - k, 3);
      const tgt = f.from.clone().lerp(f.to, e), mv = tgt.clone().sub(c.target);
      cam.position.add(mv); c.target.copy(tgt);
      cam.zoom = f.z0 + (f.z1 - f.z0) * e; cam.updateProjectionMatrix(); c.update();
      if (k >= 1) focus.current = null;
    }
    if (h.size && c && !anim.current) {
      const t = Math.min(dt, 0.05), fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      const ahead = (Math.abs(fwd.y) > 0.95 ? cam.up.clone() : fwd).setY(0).normalize(); // "up the screen", on the ground
      const right = new THREE.Vector3().crossVectors(ahead, new THREE.Vector3(0, 1, 0)).normalize();
      const mv = new THREE.Vector3();
      if (h.has("n")) mv.add(ahead);
      if (h.has("s")) mv.sub(ahead);
      if (h.has("e")) mv.add(right);
      if (h.has("w")) mv.sub(right);
      if (mv.lengthSq()) { mv.normalize().multiplyScalar((size.width / cam.zoom) * 0.4 * t); cam.position.add(mv); c.target.add(mv); }
      if (h.has("ccw") !== h.has("cw")) {
        const off = cam.position.clone().sub(c.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), (h.has("ccw") ? -1 : 1) * 1.3 * t);
        cam.position.copy(c.target).add(off); cam.lookAt(c.target);
      }
      if (h.has("in") !== h.has("out")) { cam.zoom = Math.max(20, Math.min(900, cam.zoom * Math.exp((h.has("in") ? 1.5 : -1.5) * t))); cam.updateProjectionMatrix(); }
      c.update();
    }
    const target = p.view === "plan" ? 1 : p.ex;
    exNow.current += (target - exNow.current) * 0.12;
    if (group.current) group.current.scale.y = exNow.current;
    const a = anim.current;
    if (a) {
      const t = Math.min(1, (performance.now() - a.t0) / 1100), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const dir = a.from.clone().lerp(a.to, e).normalize();
      cam.position.copy(dir.multiplyScalar(40));
      cam.up.copy(a.up0.clone().lerp(a.up1, e).normalize());
      cam.zoom = a.z0 + (a.z1 - a.z0) * e; cam.lookAt(0, 0, 0); cam.updateProjectionMatrix();
      if (controls.current) { controls.current.target.set(0, 0, 0); controls.current.update(); }
      if (t >= 1) anim.current = null;
    }
    // north arrow + scale bar readouts (written straight to the DOM, no React re-render)
    const ro = p.readout.current;
    if (ro?.north) {
      // true north in the model's own frame: a grid rotated by angrot (counter-clockwise) sees north turned the other way
      const th = ((p.northDeg ?? 0) * Math.PI) / 180;
      const n = new THREE.Vector3(Math.sin(th), 0, -Math.cos(th)).project(cam), o = new THREE.Vector3(0, 0, 0).project(cam);
      const ang = Math.atan2(n.x - o.x, n.y - o.y) * (180 / Math.PI);
      ro.north.style.transform = `rotate(${ang}deg)`;
    }
  });

  const onSurface = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    const x = e.point.x + B.cx, z = e.point.z + B.cz;
    return { col: Math.min(g.ncol - 1, Math.max(0, Math.floor(x / g.delr_km))), row: Math.min(g.nrow - 1, Math.max(0, Math.floor(z / g.delc_km))) };
  };

  const lineMode = !!p.section.line?.length;
  const cutRow = p.section.on && !lineMode && p.view === "axo" ? p.section.row : Infinity;
  const tool = p.tool ?? "select";

  // ---- drawing on the model: zones (a dragged rectangle or a clicked polygon), section lines and drains (clicked polylines)
  // points are cell indices (row, col); cell centres are whole numbers, zone vertices snap to half cells
  const drawing = DRAW_TOOLS.has(tool);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [hoverPt, setHoverPt] = useState<[number, number] | null>(null);
  const [rect, setRect] = useState<[number, number, number, number] | null>(null);
  const rectStart = useRef<[number, number] | null>(null);
  const justRect = useRef(false);
  useEffect(() => { setDraft([]); setRect(null); setHoverPt(null); rectStart.current = null; }, [tool]);
  const frac = (e: ThreeEvent<PointerEvent | MouseEvent>): [number, number] => {
    const r = (e.point.z + B.cz) / g.delc_km - 0.5, c = (e.point.x + B.cx) / g.delr_km - 0.5;
    const snap = tool === "zones" ? (v: number) => Math.round(v * 2) / 2 : Math.round;
    return [Math.max(0, Math.min(g.nrow - 1, snap(r))), Math.max(0, Math.min(g.ncol - 1, snap(c)))];
  };
  const finish = (pts = draft) => {
    if (tool === "zones" && pts.length >= 3) p.onDrawZone?.({ polygon: pts });
    else if ((tool === "section" || tool === "drains") && pts.length >= 2) p.onDrawLine?.(tool, pts);
    else return;
    setDraft([]); setHoverPt(null);
  };
  const finishRef = useRef(finish); finishRef.current = finish;
  const draftRef = useRef(draft); draftRef.current = draft;
  useEffect(() => {
    if (!drawing) return;
    // capture phase, so a drawing in progress takes Enter, Backspace and Escape before the Studio's own shortcuts
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || !draftRef.current.length) return;
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finishRef.current(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft([]); setHoverPt(null); }
      else if (e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); setDraft((d) => d.slice(0, -1)); }
    };
    window.addEventListener("keydown", h, true); return () => window.removeEventListener("keydown", h, true);
  }, [drawing]);
  useEffect(() => {
    if (tool !== "zones") return;
    const up = () => {
      const r = rectRef.current;
      rectStart.current = null;
      if (r) { justRect.current = true; setRect(null); p.onDrawZone?.({ rect: r }); }
    };
    window.addEventListener("pointerup", up); return () => window.removeEventListener("pointerup", up);
  }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps
  const rectRef = useRef(rect); rectRef.current = rect;
  const nearDrain = (row: number, col: number) => {
    let best: string | null = null, bd = 1.1;
    for (const d of p.drains ?? []) if (d.removable !== false) for (const [r, c] of d.cells) { const dd = Math.hypot(r - row, c - col); if (dd < bd) { bd = dd; best = d.name; } }
    return best;
  };
  const [hoverDrain, setHoverDrain] = useState<string | null>(null);
  const drawMove = (e: ThreeEvent<PointerEvent>) => {
    const pt = frac(e);
    if (!hoverPt || hoverPt[0] !== pt[0] || hoverPt[1] !== pt[1]) setHoverPt(pt);
    if (tool === "drains" && !draft.length) { const hd = nearDrain(pt[0], pt[1]); if (hd !== hoverDrain) setHoverDrain(hd); }
    const st = rectStart.current;
    if (tool === "zones" && st && !draft.length && Math.max(Math.abs(pt[0] - st[0]), Math.abs(pt[1] - st[1])) >= 1)
      setRect([Math.round(Math.min(st[0], pt[0])), Math.round(Math.min(st[1], pt[1])), Math.round(Math.max(st[0], pt[0])), Math.round(Math.max(st[1], pt[1]))]);
  };
  const drawClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (justRect.current) { justRect.current = false; return; }
    const pt = frac(e), last = draft[draft.length - 1];
    if (tool === "drains" && !draft.length) { const hd = nearDrain(pt[0], pt[1]); if (hd) { p.onRemoveDrain?.(hd); setHoverDrain(null); return; } }
    if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.6) return; // the second click of a double-click
    if (tool === "zones" && draft.length >= 3 && Math.hypot(pt[0] - draft[0][0], pt[1] - draft[0][1]) < 0.9) { finish(); return; }
    setDraft((d) => [...d, pt]);
  };
  // a polyline draped on the land surface, sampled every half cell so it follows the ground
  const drape3 = (pts: [number, number][], lift = 0.003) => {
    const out: THREE.Vector3[] = [];
    const at = (r: number, c: number) => new THREE.Vector3((c + 0.5) * g.delr_km - B.cx, B.landY(c, r) + lift, (r + 0.5) * g.delc_km - B.cz);
    pts.forEach((q, i) => {
      if (i === 0) { out.push(at(q[0], q[1])); return; }
      const a = pts[i - 1], n = Math.max(1, Math.ceil(Math.hypot(q[0] - a[0], q[1] - a[1]) * 2));
      for (let k = 1; k <= n; k++) out.push(at(a[0] + ((q[0] - a[0]) * k) / n, a[1] + ((q[1] - a[1]) * k) / n));
    });
    return out;
  };

  // ---- land use: one flat quad per cell on the land surface, recoloured in place while painting
  const land = useMemo(() => {
    const pos: number[] = [], idx: number[] = [], at = new Map<number, number>();
    const X = (c: number) => c * g.delr_km - B.cx, Z = (r: number) => r * g.delc_km - B.cz;
    for (let r = 0; r < g.nrow; r++) for (let c = 0; c < g.ncol; c++) {
      if (r > cutRow || g.top[r][c] == null) continue;
      const v = pos.length / 3;
      for (const [dc, dr] of [[0, 0], [1, 0], [0, 1], [1, 1]]) pos.push(X(c + dc), B.landY(c + dc - 0.5, r + dr - 0.5) - 0.0008, Z(r + dr));
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      at.set(r * g.ncol + c, v);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    geo.setIndex(idx);
    return { geo, at };
  }, [B, g, cutRow]);
  useEffect(() => () => land.geo.dispose(), [land]);
  const rgb = useMemo(() => Object.fromEntries(Object.entries(CROP_COLORS).map(([k, v]) => [k, new THREE.Color(v)])) as Record<Crop, THREE.Color>, []);
  const colourCells = (cells: { row: number; col: number; crop: Crop }[]) => {
    const a = land.geo.getAttribute("color") as THREE.BufferAttribute;
    for (const { row, col, crop } of cells) {
      const v = land.at.get(row * g.ncol + col); if (v == null) continue;
      for (let i = 0; i < 4; i++) a.setXYZ(v + i, rgb[crop].r, rgb[crop].g, rgb[crop].b);
    }
    a.needsUpdate = true;
  };
  useEffect(() => {
    if (!p.landUse) return;
    colourCells(p.landUse.flatMap((row, r) => row.map((crop, c) => ({ row: r, col: c, crop }))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.landUse, land]);

  const stroke = useRef<Map<string, { row: number; col: number }> | null>(null);
  const brushRef = useRef<THREE.Group>(null);
  const brushCells = (row: number, col: number) => {
    const n = p.brush ?? 1, h = Math.floor(n / 2), out: { row: number; col: number }[] = [];
    for (let r = row - h; r <= row + h; r++) for (let c = col - h; c <= col + h; c++)
      if (r >= 0 && c >= 0 && r < g.nrow && c < g.ncol && r <= cutRow && g.top[r][c] != null) out.push({ row: r, col: c });
    return out;
  };
  const [, strokeTick] = useState(0);
  const dab = (row: number, col: number) => {
    if (stroke.current && tool === "paint") {
      const n0 = stroke.current.size;
      brushCells(row, col).forEach((x) => stroke.current!.set(`${x.row},${x.col}`, x));
      if (stroke.current.size !== n0) strokeTick((t) => t + 1);
      return;
    }
    if (!stroke.current || !p.crop || !p.baseLandUse) return;
    const cells = brushCells(row, col);
    cells.forEach((x) => stroke.current!.set(`${x.row},${x.col}`, x));
    colourCells(cells.map((x) => ({ ...x, crop: p.crop === "original" ? p.baseLandUse![x.row][x.col] : (p.crop as Crop) })));
  };
  const endStroke = () => {
    if (!stroke.current) return;
    const cells = [...stroke.current.values()]; stroke.current = null;
    if (cells.length) p.onPaint?.(cells);
  };
  useEffect(() => { window.addEventListener("pointerup", endStroke); return () => window.removeEventListener("pointerup", endStroke); });
  // the brush footprint is draped on the land surface along cell edges, just above the land-use layer
  const brushEdge = useMemo(() => { const g2 = new THREE.BufferGeometry(); g2.setAttribute("position", new THREE.BufferAttribute(new Float32Array(41 * 3), 3)); return g2; }, []);
  useEffect(() => () => brushEdge.dispose(), [brushEdge]);
  const drape = (r0: number, c0: number, r1: number, c1: number) => {
    const X = (c: number) => c * g.delr_km - B.cx, Z = (r: number) => r * g.delc_km - B.cz;
    const at = (c: number, r: number) => [X(c), B.landY(c - 0.5, r - 0.5) - 0.0005, Z(r)];
    const pts: number[] = [];
    for (let c = c0; c <= c1; c++) pts.push(...at(c, r0));
    for (let r = r0 + 1; r <= r1; r++) pts.push(...at(c1, r));
    for (let c = c1 - 1; c >= c0; c--) pts.push(...at(c, r1));
    for (let r = r1 - 1; r >= r0; r--) pts.push(...at(c0, r));
    return pts;
  };
  const brushFill = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(81 * 18), 3));
    return geo;
  }, []);
  useEffect(() => () => brushFill.dispose(), [brushFill]);
  const moveBrush = (row: number, col: number) => {
    const b = brushRef.current; if (!b) return;
    const h = Math.floor((p.brush ?? 1) / 2);
    const r0 = Math.max(0, row - h), c0 = Math.max(0, col - h), r1 = Math.min(g.nrow, row + h + 1), c1 = Math.min(g.ncol, col + h + 1);
    const edge = drape(r0, c0, r1, c1), ea = brushEdge.getAttribute("position") as THREE.BufferAttribute;
    (ea.array as Float32Array).set(edge); ea.needsUpdate = true; brushEdge.setDrawRange(0, edge.length / 3); brushEdge.computeBoundingSphere();
    const a = brushFill.getAttribute("position") as THREE.BufferAttribute, X = (c: number) => c * g.delr_km - B.cx, Z = (r: number) => r * g.delc_km - B.cz;
    let i = 0;
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++)
      for (const [dc, dr] of [[0, 0], [0, 1], [1, 0], [1, 0], [0, 1], [1, 1]]) a.setXYZ(i++, X(c + dc), B.landY(c + dc - 0.5, r + dr - 0.5) - 0.0006, Z(r + dr));
    a.needsUpdate = true; brushFill.setDrawRange(0, i); brushFill.computeBoundingSphere(); b.visible = true;
  };

  // ---- channel reaches: snap the pointer to the nearest reach within a cell and a half
  const nearestReach = (row: number, col: number) => {
    let best: string | null = null, bd = 1.6;
    for (const rc of p.reaches ?? []) for (const x of rc.cells) {
      if (x.row > cutRow) continue;
      const d = Math.hypot(x.row - row, x.col - col); if (d < bd) { bd = d; best = rc.id; }
    }
    return best;
  };
  const ghostRef = useRef<THREE.Group>(null);
  const [hoverProp, setHoverProp] = useState<string | null>(null);
  const nearestProposed = (row: number, col: number) => {
    let best: string | null = null, bd = 1.3;
    for (const b of m.bores) if (b.bore_type === "proposed") { const d = Math.hypot(b.row - row, b.col - col); if (d < bd) { bd = d; best = b.bore_id; } }
    return best;
  };
  const moveGhost = (row: number, col: number) => {
    const gh = ghostRef.current; if (!gh) return;
    const hit = nearestProposed(row, col);
    if (hit !== hoverProp) setHoverProp(hit);
    gh.visible = !hit;
    gh.position.set((col + 0.5) * g.delr_km - B.cx, B.landY(col, row), (row + 0.5) * g.delc_km - B.cz);
  };
  const hoverRef = useRef<string | null>(null);
  const setHover = (id: string | null) => { if (hoverRef.current !== id) { hoverRef.current = id; p.onHoverReach?.(id); } };
  const reachLines = useMemo(() => (p.reaches ?? []).map((rc, i, all) => {
    const cells = rc.cells.filter((x) => x.row <= cutRow);
    const nx = all[i + 1];
    if (nx && nx.channel === rc.channel && cells.length) {
      const a = cells[cells.length - 1], b = nx.cells[0];
      if (b.row <= cutRow && Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col)) <= 1) cells.push(b);
    }
    return { id: rc.id, cells, mid: rc.cells[Math.floor(rc.cells.length / 2)] };
  }).filter((x) => x.cells.length > 1), [p.reaches, cutRow]);

  // ---- redline boundary around painted cells (cells that differ from the Unity Catalog land-use map)
  const outline = (on: (r: number, c: number) => boolean) => {
    const seg: number[] = [], X = (c: number) => c * g.delr_km - B.cx, Z = (r: number) => r * g.delc_km - B.cz;
    const y = (c: number, r: number) => B.landY(c - 0.5, r - 0.5) + 0.0014;
    const vis = (r: number, c: number) => r >= 0 && c >= 0 && r < g.nrow && c < g.ncol && r <= cutRow && on(r, c);
    for (let r = 0; r < g.nrow; r++) for (let c = 0; c < g.ncol; c++) {
      if (!vis(r, c)) continue;
      if (!vis(r - 1, c)) seg.push(X(c), y(c, r), Z(r), X(c + 1), y(c + 1, r), Z(r));
      if (!vis(r + 1, c)) seg.push(X(c), y(c, r + 1), Z(r + 1), X(c + 1), y(c + 1, r + 1), Z(r + 1));
      if (!vis(r, c - 1)) seg.push(X(c), y(c, r), Z(r), X(c), y(c, r + 1), Z(r + 1));
      if (!vis(r, c + 1)) seg.push(X(c + 1), y(c + 1, r), Z(r), X(c + 1), y(c + 1, r + 1), Z(r + 1));
    }
    return new Float32Array(seg);
  };
  const found = useMemo(() => {
    if (!p.highlight?.length) return new Float32Array();
    const on = new Set(p.highlight.map((c) => c.row * 10000 + c.col));
    return outline((r, c) => on.has(r * 10000 + c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.highlight, B, cutRow]);
  const painted = useMemo(() => (p.landUse && p.baseLandUse ? outline((r, c) => p.landUse![r][c] !== p.baseLandUse![r][c]) : new Float32Array()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.landUse, p.baseLandUse, B, cutRow]);
  const diffCells = useMemo(() => {
    if (!p.diff?.cells.length) return null;
    const set = new Set(p.diff.cells.map((x) => x.row * g.ncol + x.col));
    return outline((r, c) => set.has(r * g.ncol + c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.diff, B, cutRow]);
  const markSegs = useMemo(() => (p.marks ?? []).map((m) => {
    const on = new Set(m.cells.map((c) => c.row * 10000 + c.col));
    return { color: m.color, data: outline((r, c) => on.has(r * 10000 + c)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [p.marks, B, cutRow]);
  const rectSegs = useMemo(() => (rect ? outline((r, c) => r >= rect[0] && r <= rect[2] && c >= rect[1] && c <= rect[3]) : new Float32Array()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rect, B, cutRow]);
  // the diff paints only the repainted cells, in their new crop, so the change reads at a glance
  const diffGeo = useMemo(() => {
    if (!p.diff?.cells.length) return null;
    const pos: number[] = [], col: number[] = [], X = (c: number) => c * g.delr_km - B.cx, Z = (r: number) => r * g.delc_km - B.cz;
    for (const d of p.diff.cells) {
      if (d.row > cutRow) continue;
      const q = [[0, 0], [1, 0], [0, 1], [1, 0], [1, 1], [0, 1]], k = rgb[d.to];
      for (const [dc, dr] of q) { pos.push(X(d.col + dc), B.landY(d.col + dc - 0.5, d.row + dr - 0.5) - 0.0006, Z(d.row + dr)); col.push(k.r, k.g, k.b); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    return geo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.diff, B, cutRow]);
  useEffect(() => () => diffGeo?.dispose(), [diffGeo]);
  const showLand = tool === "landuse" || p.overlay === "land";
  const showReaches = tool === "channels" || p.overlay === "reaches";
  const lined = new Set(p.lined ?? []);
  const channels = useMemo(() => {
    const keep = (cells: { row: number; col: number }[]) => cells.filter((c) => c.row <= cutRow);
    return { canal: chainCells(keep(m.features.canal)), river: chainCells(keep(m.features.river)), drain: chainCells(keep(m.features.drain)) };
  }, [m.features, cutRow]);
  const pts3 = (cells: { row: number; col: number }[]) =>
    cells.map((c) => new THREE.Vector3((c.col + 0.5) * g.delr_km - B.cx, B.landY(c.col, c.row) + 0.0006, (c.row + 0.5) * g.delc_km - B.cz));
  const onVisible = (b: { row: number }) => b.row <= cutRow;
  const cutOn = p.section.on && !lineMode && p.view === "axo";
  const off = Math.max(B.sx, B.sz) * 0.022; // label offset scales with the model

  const boreGeom = (b: Bore) => {
    const land = (g.top[b.row][b.col] ?? B.datum) as number;
    const lay = Math.min(b.layer, g.nlay - 1);
    const bot = (g.botm[lay][b.row][b.col] ?? land - 10) as number;
    const screenBot = bot + ((lay === 0 ? land : (g.botm[lay - 1][b.row][b.col] as number)) - bot) * 0.25;
    return { x: (b.col + 0.5) * g.delr_km - B.cx, z: (b.row + 0.5) * g.delc_km - B.cz, y0: (screenBot - B.datum) / 1000, y1: (land - B.datum) / 1000 };
  };

  return (
    <>
      <OrthographicCamera makeDefault position={[25, 30, 40]} zoom={fitZoom(p.view)} near={-200} far={400} />
      <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.12} enabled={!dragging}
        minZoom={20} maxZoom={900} maxPolarAngle={Math.PI / 2.05}
        mouseButtons={tool === "landuse" || tool === "zones" || tool === "paint" ? { LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }} />
      <hemisphereLight args={["#ffffff", "#c9c9c2", 1.35]} />
      <directionalLight position={[-6, 12, -4]} intensity={1.1} />

      <group ref={group}>
        <mesh geometry={B.water}>
          <meshLambertMaterial vertexColors polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
        </mesh>
        {/* tools pick on the land surface, where their marks are drawn, so the pointer and the mark agree at any tilt */}
        <mesh geometry={land.geo} visible={false}
          onPointerDown={(e) => {
            justRect.current = false;
            if (e.altKey && p.onPick && e.button === 0) { e.stopPropagation(); const { row, col } = onSurface(e); p.onPick(row, col); return; }
            if (tool === "zones" && e.button === 0 && !draft.length) rectStart.current = frac(e);
            if (tool === "paint" && e.button === 0) { e.stopPropagation(); stroke.current = new Map(); const { row, col } = onSurface(e); dab(row, col); }
          }}
          onPointerMove={(e) => {
            if (drawing) { drawMove(e); return; }
            const { row, col } = onSurface(e);
            if (tool === "paint") { moveBrush(row, col); if (stroke.current) dab(row, col); return; }
            if (tool === "channels") setHover(nearestReach(row, col));
            if (tool === "bores") moveGhost(row, col);
          }}
          onPointerOut={() => { if (brushRef.current && tool === "paint") brushRef.current.visible = false; if (tool === "channels") setHover(null); if (ghostRef.current) ghostRef.current.visible = false; setHoverProp(null); setHoverPt(null); }}
          onDoubleClick={(e) => { if (drawing) { e.stopPropagation(); finish(); } }}
          onClick={(e) => {
            if (drawing) { if (e.delta <= 4 || justRect.current) drawClick(e); return; }
            if (e.delta > 4) return;
            if (tool === "channels") { e.stopPropagation(); const { row, col } = onSurface(e); const id = nearestReach(row, col); if (id) p.onToggleReach?.(id); return; }
            if (tool === "select") { const { row, col } = onSurface(e); p.onInspect?.(row, col); return; }
            if (!p.placing) return; e.stopPropagation(); const { row, col } = onSurface(e);
            const hit = nearestProposed(row, col);
            if (hit) { p.onRemoveBore?.(Number(hit.slice(1)) - 1); setHoverProp(null); } else p.onPlace(row, col);
          }} />
        {B.faces.map((f, i) => <mesh key={i} geometry={f.geo} material={f.mat} />)}
        {showLand && (
          <mesh geometry={land.geo}
            onPointerDown={(e) => { if (tool !== "landuse" || e.button !== 0) return; e.stopPropagation(); stroke.current = new Map(); const { row, col } = onSurface(e); dab(row, col); }}
            onPointerMove={(e) => { if (tool !== "landuse") return; const { row, col } = onSurface(e); moveBrush(row, col); if (stroke.current) dab(row, col); }}
            onPointerOut={() => { if (brushRef.current) brushRef.current.visible = false; }}>
            <meshBasicMaterial vertexColors transparent opacity={0.92} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
          </mesh>
        )}
        {tool === "paint" && stroke.current && stroke.current.size > 0 && (
          <Segs data={outline((r, c) => !!stroke.current?.has(`${r},${c}`))} color={INK} opacity={1} />
        )}
        {(tool === "landuse" || tool === "paint") && (
          <group ref={brushRef} visible={false}>
            <mesh geometry={brushFill} renderOrder={5}>
              <meshBasicMaterial color={tool === "paint" || p.crop === "original" || !p.crop ? SHEET : CROP_COLORS[p.crop as Crop]} transparent opacity={0.6} depthTest={false} side={THREE.DoubleSide} />
            </mesh>
            <lineLoop geometry={brushEdge} renderOrder={6}><lineBasicMaterial color={INK} depthTest={false} /></lineLoop>
          </group>
        )}
        {tool === "bores" && (
          <group ref={ghostRef} visible={false}>
            <mesh position={[0, 0.0015, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={6}>
              <circleGeometry args={[0.15, 3]} /><meshBasicMaterial color={REDLINE} transparent opacity={0.5} side={THREE.DoubleSide} depthTest={false} />
            </mesh>
            <mesh position={[0, 0.0015, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={6}>
              <ringGeometry args={[0.24, 0.265, 40]} /><meshBasicMaterial color={REDLINE} transparent opacity={0.8} side={THREE.DoubleSide} depthTest={false} />
            </mesh>
          </group>
        )}
        {!p.diff && painted.length > 0 && <Segs data={painted} color={REDLINE} opacity={0.95} />}
        {found.length > 0 && <Segs data={found} color={INK} opacity={1} />}
        {markSegs.map((m, i) => m.data.length > 0 && <Segs key={`mk${i}`} data={m.data} color={m.color} opacity={1} />)}
        {rectSegs.length > 0 && <Segs data={rectSegs} color={ZONE_INK} opacity={1} />}
        {draft.length + (hoverPt ? 1 : 0) > 1 && (
          <Line points={drape3(hoverPt ? [...draft, hoverPt] : draft)} color={tool === "zones" ? ZONE_INK : REDLINE} lineWidth={2.2}
            dashed={tool === "section"} dashSize={B.sx * 0.02} gapSize={B.sx * 0.008} depthTest={false} renderOrder={7} />
        )}
        {tool === "zones" && draft.length > 2 && hoverPt && <Line points={drape3([hoverPt, draft[0]])} color={ZONE_INK} lineWidth={1} dashed dashSize={0.05} gapSize={0.05} depthTest={false} renderOrder={7} />}
        {draft.map((q, i) => (
          <mesh key={`dv${i}`} position={[(q[1] + 0.5) * g.delr_km - B.cx, B.landY(q[1], q[0]) + 0.004, (q[0] + 0.5) * g.delc_km - B.cz]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={8}>
            <circleGeometry args={[i === 0 && tool === "zones" && draft.length > 2 ? 0.1 : 0.06, 16]} /><meshBasicMaterial color={tool === "zones" ? ZONE_INK : REDLINE} depthTest={false} />
          </mesh>
        ))}
        {(p.drains ?? []).map((d) => {
          const dd = p.diff, color = d.color ?? (dd?.drainsAdded.some((x) => x.name === d.name) ? DIFF_ADD : !dd ? REDLINE : INK);
          const hot = tool === "drains" && hoverDrain === d.name;
          const pts = pts3(d.cells.filter(([r]) => r <= cutRow).map(([row, col]) => ({ row, col })));
          return pts.length < 2 ? null : <Line key={`pd${d.name}`} points={pts} color={color} lineWidth={hot ? 5 : 3} dashed dashSize={0.1} gapSize={0.05} />;
        })}
        {p.diff?.drainsRemoved.filter((d) => d.cells.length > 1).map((d) => <Line key={`rd${d.name}`} points={pts3(d.cells.map(([row, col]) => ({ row, col })))} color={DIFF_DEL} lineWidth={3} dashed dashSize={0.1} gapSize={0.05} />)}
        {diffGeo && <mesh geometry={diffGeo}><meshBasicMaterial vertexColors side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} /></mesh>}
        {diffCells && <Segs data={diffCells} color={DIFF_ADD} opacity={1} />}
        <Segs data={B.strong} color={INK} opacity={0.95} />
        <Segs data={B.hair} color={INK} opacity={0.35} />
        <Segs data={B.wtEdge} color="#0b2f5e" opacity={0.9} />
        <Segs data={B.landMinor} color={INK} opacity={0.1} />
        <Segs data={B.landMajor} color={INK} opacity={0.26} />
        <Segs data={B.isolines} color="#ffffff" opacity={0.55} />

        {reachLines.length ? reachLines.map((rl) => {
          const on = lined.has(rl.id), hot = p.hoverReach === rl.id;
          const d = p.diff, color = d?.lined.includes(rl.id) ? DIFF_ADD : d?.unlined.includes(rl.id) ? DIFF_DEL : on && !d ? REDLINE : INK;
          return <Line key={rl.id} points={pts3(rl.cells)} color={color} lineWidth={hot ? 5 : color !== INK ? 3.4 : 2} />;
        }) : channels.canal.map((c, i) => c.length > 1 && <Line key={`c${i}`} points={pts3(c)} color={INK} lineWidth={2} />)}
        {channels.river.map((c, i) => c.length > 1 && <Line key={`r${i}`} points={pts3(c)} color={INK} lineWidth={4} />)}
        {channels.drain.map((c, i) => c.length > 1 && <Line key={`d${i}`} points={pts3(c)} color={INK} lineWidth={1.2} dashed dashSize={0.12} gapSize={0.08} />)}
        {B.risk.map((l, i) => (
          <Line key={`k${i}`} dashed dashSize={0.1} gapSize={0.07} color={INK} lineWidth={1.4}
            points={l.map(([c, r]) => new THREE.Vector3((c + 0.5) * g.delr_km - B.cx, B.landY(c + 0.5, r + 0.5) + 0.001, (r + 0.5) * g.delc_km - B.cz))} />
        ))}
        {B.clouds.map((l, i) => (
          <Line key={`v${i}`} color={REDLINE} lineWidth={1.6}
            points={l.map(([c, r]) => new THREE.Vector3((c + 0.5) * g.delr_km - B.cx, B.landY(c + 0.5, r + 0.5) + 0.0016, (r + 0.5) * g.delc_km - B.cz))} />
        ))}

        {m.bores.filter(onVisible).map((b) => {
          const q = boreGeom(b), prop = b.bore_type === "proposed", mon = b.bore_type === "monitoring";
          const color = prop ? REDLINE : INK, sel = p.selectedBore === b.bore_id;
          return (
            <group key={b.bore_id}>
              <mesh position={[q.x, (q.y0 + q.y1) / 2 + 0.002, q.z]}>
                <cylinderGeometry args={[mon ? 0.012 : 0.02, mon ? 0.012 : 0.02, q.y1 - q.y0 + 0.004, 6]} />
                <meshBasicMaterial color={color} />
              </mesh>
              <mesh position={[q.x, q.y1 + 0.0015, q.z]} rotation={[-Math.PI / 2, 0, 0]}>
                {mon ? <ringGeometry args={[sel ? 0.1 : 0.065, sel ? 0.135 : 0.095, 32]} /> : <circleGeometry args={[prop ? 0.15 : 0.07, 3]} />}
                <meshBasicMaterial color={color} side={THREE.DoubleSide} />
              </mesh>
              <mesh position={[q.x, (q.y0 + q.y1) / 2, q.z]} visible={false}
                onClick={(e) => { if (p.placing || tool !== "select") return; e.stopPropagation(); if (mon) p.onSelectBore(b.bore_id); }}
                onPointerOver={() => (document.body.style.cursor = mon ? "pointer" : "")} onPointerOut={() => (document.body.style.cursor = "")}>
                <cylinderGeometry args={[0.13, 0.13, Math.max(0.02, q.y1 - q.y0), 8]} />
              </mesh>
            </group>
          );
        })}

        {p.section.on && lineMode && (
          <Line points={drape3(p.section.line!, 0.0025)} color={REDLINE} lineWidth={2.2} dashed dashSize={B.sx * 0.027} gapSize={B.sx * 0.008} depthTest={false} renderOrder={5} />
        )}
        {p.section.on && !lineMode && (() => {
          const r = p.section.row, z = (r + 0.5) * g.delc_km - B.cz;
          const pts = Array.from({ length: g.ncol }, (_, c) => new THREE.Vector3((c + 0.5) * g.delr_km - B.cx, B.landY(c, r) + 0.0025, z));
          return (
            <group>
              <Line points={pts} color={REDLINE} lineWidth={2.2} dashed dashSize={B.sx * 0.027} gapSize={B.sx * 0.008} depthTest={false} renderOrder={5} />
              <mesh position={[0, B.landY(g.ncol / 2, r) + 0.002, z]} rotation={[-Math.PI / 2, 0, 0]}
                onPointerDown={(e) => { e.stopPropagation(); setDragging(true); (e.target as Element)?.setPointerCapture?.(e.pointerId); }}
                onPointerOver={() => (document.body.style.cursor = "ns-resize")} onPointerOut={() => !dragging && (document.body.style.cursor = "")}>
                <planeGeometry args={[B.sx, g.delc_km * 1.6]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            </group>
          );
        })()}

      {/* drag plane for the section line */}
      {dragging && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, B.landY(g.ncol / 2, p.section.row), 0]}
          onPointerMove={(e) => { const { row } = onSurface(e); if (row !== p.section.row) p.onSectionRow(Math.max(1, Math.min(g.nrow - 2, row))); }}
          onPointerUp={() => { setDragging(false); document.body.style.cursor = ""; }}>
          <planeGeometry args={[B.sx * 4, B.sz * 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      {(showReaches || p.hoverReach) && reachLines.map((rl) => {
        if (!showReaches && p.hoverReach !== rl.id) return null;
        const hot = p.hoverReach === rl.id, on = lined.has(rl.id);
        return (
          <Html key={`t${rl.id}`} position={[(rl.mid.col + 0.5) * g.delr_km - B.cx, B.landY(rl.mid.col, rl.mid.row), (rl.mid.row + 0.5) * g.delc_km - B.cz]}
            center zIndexRange={[4, 0]} className={`reach-tag ${on ? "on" : ""} ${hot ? "hot" : ""}`}>
            {hot && tool === "channels" ? `${on ? "Unline" : "Line"} ${rl.id}` : rl.id}
          </Html>
        );
      })}
      {p.diff && [...p.diff.boresAdded.map((b) => ({ b, add: true })), ...p.diff.boresRemoved.map((b) => ({ b, add: false }))].map(({ b, add }, i) => (
        <mesh key={`db${i}`} position={[(b.col + 0.5) * g.delr_km - B.cx, B.landY(b.col, b.row) + 0.003, (b.row + 0.5) * g.delc_km - B.cz]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.16, 0.22, 32]} /><meshBasicMaterial color={add ? DIFF_ADD : DIFF_DEL} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {p.section.on && lineMode && (() => {
        const L = p.section.line!, a = L[0], b = L[L.length - 1];
        return <>
          <Html position={[(a[1] + 0.5) * g.delr_km - B.cx, B.landY(a[1], a[0]) + 0.004, (a[0] + 0.5) * g.delc_km - B.cz]} center zIndexRange={[4, 0]} className="sec-tag">A</Html>
          <Html position={[(b[1] + 0.5) * g.delr_km - B.cx, B.landY(b[1], b[0]) + 0.004, (b[0] + 0.5) * g.delc_km - B.cz]} center zIndexRange={[4, 0]} className="sec-tag">A′</Html>
        </>;
      })()}
      {(p.drains ?? []).map((d) => {
        const m = d.cells[Math.floor(d.cells.length / 2)];
        if (!m || m[0] > cutRow) return null;
        const hot = tool === "drains" && hoverDrain === d.name;
        return <Html key={`dt${d.name}`} position={[(m[1] + 0.5) * g.delr_km - B.cx, B.landY(m[1], m[0]), (m[0] + 0.5) * g.delc_km - B.cz]} center zIndexRange={[4, 0]}
          className={`bore-tag ${d.color ? "" : "red"} ${hot ? "hot" : ""}`}>{hot ? `Remove ${d.name}` : d.label ?? `${d.name} · ${d.depth_m} m`}</Html>;
      })}
      {p.section.on && !lineMode && (
        <>
          <Html position={[-B.cx - off, B.landY(0, p.section.row), (p.section.row + 0.5) * g.delc_km - B.cz]} center zIndexRange={[4, 0]} className="sec-tag">A</Html>
          <Html position={[B.cx + off, B.landY(g.ncol - 1, p.section.row), (p.section.row + 0.5) * g.delc_km - B.cz]} center zIndexRange={[4, 0]} className="sec-tag">A′</Html>
        </>
      )}
      {p.view === "axo" && (() => {
        const r = cutOn ? p.section.row + 1 : g.nrow, c = Math.round(g.ncol * 0.2), z = r * g.delc_km - B.cz + 0.001;
        const layerMid = (k: number) => {
          const topv = (k === 0 ? g.top : g.botm[k - 1])[Math.min(r, g.nrow - 1)][c], botv = g.botm[k][Math.min(r, g.nrow - 1)][c];
          return topv == null || botv == null ? null : ((topv + botv) / 2 - B.datum) / 1000;
        };
        return g.botm.map((_, k) => {
          const y = layerMid(k);
          return y == null ? null : <Html key={`ln${k}`} position={[(c + 0.5) * g.delr_km - B.cx, y, z]} center zIndexRange={[4, 0]} className="layer-tag">{`L${k + 1} · ${p.layerNames?.[k] ?? `Layer ${k + 1}`}`}</Html>;
        });
      })()}
      {m.bores.filter((b) => b.bore_type === "proposed" || b.bore_id === p.selectedBore).filter(onVisible).map((b) => {
        const q = boreGeom(b), rm = tool === "bores" && hoverProp === b.bore_id;
        return <Html key={`l${b.bore_id}`} position={[q.x, q.y1 + 0.0015, q.z]} center zIndexRange={[4, 0]} className={`bore-tag ${b.bore_type === "proposed" ? "red" : ""} ${rm ? "hot" : ""}`}>{rm ? `Remove ${b.bore_id}` : b.bore_id}</Html>;
      })}
      <ScaleBars B={B} front={cutOn ? (p.section.row + 1) * g.delc_km - B.cz : B.cz} plan={p.view === "plan"} off={off} ex={p.ex} />
      {Array.from({ length: Math.floor(g.ncol / 10) + 1 }, (_, i) => i * 10).map((c) => (
        <Html key={`cc${c}`} position={[(c + 0.5) * g.delr_km - B.cx, B.landY(Math.min(c, g.ncol - 1), 0), -B.cz - off]} center zIndexRange={[4, 0]} className="idx">{c + 1}</Html>
      ))}
      {Array.from({ length: Math.floor(g.nrow / 10) }, (_, i) => (i + 1) * 10 - 1).filter((r) => r <= cutRow && !(p.section.on && Math.abs(r - p.section.row) < 4)).map((r) => (
        <Html key={`rr${r}`} position={[-B.cx - off, B.landY(0, Math.min(r, g.nrow - 1)), (r + 0.5) * g.delc_km - B.cz]} center zIndexRange={[4, 0]} className="idx">{r + 1}</Html>
      ))}
      </group>
    </>
  );
}

/** True scale drawn in the model itself, off the south-west corner: a chequered km bar along the
 *  south edge (it foreshortens exactly as the ground does; upright in axonometric, flat in plan) and a
 *  vertical metre bar scaled by the same exaggeration as the strata. */
function ScaleBars({ B, front, plan, off, ex }: { B: Built; front: number; plan: boolean; off: number; ex: number }) {
  const km = [0.5, 1, 2, 5, 10, 20, 50].find((k) => k >= B.sx * 0.16) ?? 50;
  const m = [1, 2, 5, 10, 20, 50, 100, 200].find((h) => h >= B.sy * 1000 * 0.3) ?? 200;
  const x0 = -B.cx, z0 = front + off * 0.9, n = 4, seg = km / n;
  const w = plan ? off * 0.32 : (off * 0.32) / ex; // ribbon height, undoing the group's vertical stretch
  const cellPos = (i: number): [number, number, number] => plan ? [x0 + seg * (i + 0.5), 0.0005, z0] : [x0 + seg * (i + 0.5), w / 2, z0];
  const rot: [number, number, number] = plan ? [-Math.PI / 2, 0, 0] : [0, 0, 0];
  const box: [number, number, number][] = plan
    ? [[x0, 0.0006, z0 - w / 2], [x0 + km, 0.0006, z0 - w / 2], [x0 + km, 0.0006, z0 + w / 2], [x0, 0.0006, z0 + w / 2], [x0, 0.0006, z0 - w / 2]]
    : [[x0, 0, z0 + 0.001], [x0 + km, 0, z0 + 0.001], [x0 + km, w, z0 + 0.001], [x0, w, z0 + 0.001], [x0, 0, z0 + 0.001]];
  const h = m / 1000, xv = x0 + km, zv = z0 + 0.001;
  return (
    <group>
      {Array.from({ length: n }, (_, i) => (
        <mesh key={i} position={cellPos(i)} rotation={rot}><planeGeometry args={[seg, w]} /><meshBasicMaterial color={i % 2 ? SHEET : INK} side={THREE.DoubleSide} /></mesh>
      ))}
      <Line points={box} color={INK} lineWidth={1} />
      <Html position={[x0, 0, z0 + (plan ? w * 2.2 : 0)]} zIndexRange={[4, 0]} className="idx sb-l">0</Html>
      <Html position={[x0 + km, 0, z0 + (plan ? w * 2.2 : 0)]} zIndexRange={[4, 0]} className="idx sb-l">{`${km} km`}</Html>
      {!plan && (
        <>
          <Line points={[[xv, 0, zv], [xv, h, zv]]} color={INK} lineWidth={1.6} />
          {[0, h / 2, h].map((y, i) => <Line key={i} points={[[xv, y, zv], [xv + off * (i === 1 ? 0.12 : 0.22), y, zv]]} color={INK} lineWidth={1.2} />)}
          <Html position={[xv + off * 0.3, h, zv]} zIndexRange={[4, 0]} className="idx sb-v">{`${m} m`}</Html>
        </>
      )}
    </group>
  );
}

export default function BlockModel(p: Props) {
  const cutOn = p.section.on && !p.section.line?.length && p.view === "axo";
  const built = useMemo(() => build(p.model, { on: cutOn, row: p.section.row }, p.colorMode, p.showClouds),
    [p.model, cutOn, p.section.row, p.colorMode, p.showClouds]);
  return (
    <Canvas dpr={[1, 2]} gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      style={{ background: SHEET, cursor: p.tool === "landuse" || p.tool === "paint" || (p.tool && DRAW_TOOLS.has(p.tool)) ? "crosshair" : p.placing ? "copy" : p.tool === "channels" && p.hoverReach ? "pointer" : undefined }}
      onContextMenu={(e) => e.preventDefault()} onPointerMissed={() => (document.body.style.cursor = "")}>
      <Scene {...p} built={built} />
    </Canvas>
  );
}
