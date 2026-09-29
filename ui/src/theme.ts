/** Drawing-sheet palette. CSS custom properties in styles.css mirror these; WebGL needs concrete values. */
export const INK = "#15171a";
export const INK_2 = "#4a4d52";
export const INK_3 = "#8b8f94";
export const SHEET = "#fbfbf8";
export const HAIR = "#d5d5cf";
export const REDLINE = "#d0322d";
/** One hydraulic-blue ramp; darkest = shallowest water table (the salinity-risk end). */
export const WATER_STOPS: [number, string][] = [
  [0, "#0b2f5e"], [1, "#154f98"], [2, "#2a72c9"], [3, "#6ea4e2"], [4.5, "#aecdf0"], [6, "#dde9f7"],
];
/** Earth ramp for aquifer properties while they are edited (low to high). */
export const EARTH_STOPS: [number, string][] = [[0, "#f3eee0"], [0.3, "#e1c996"], [0.6, "#bf8f4b"], [0.85, "#8a5a24"], [1, "#4f3312"]];
export const PROB_STOPS: [number, string][] = [
  [0, "#eef3f9"], [0.25, "#b9d1ee"], [0.5, "#6ea4e2"], [0.75, "#2a72c9"], [1, "#0b2f5e"],
];

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function ramp(stops: [number, string][], v: number | null): [number, number, number] {
  if (v == null || !Number.isFinite(v)) return [0.85, 0.85, 0.83];
  if (v <= stops[0][0]) return hexToRgb(stops[0][1]).map((c) => c / 255) as [number, number, number];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const t = (v - a) / (b - a), x = hexToRgb(ca), y = hexToRgb(cb);
      return [0, 1, 2].map((k) => (x[k] + (y[k] - x[k]) * t) / 255) as [number, number, number];
    }
  }
  return hexToRgb(stops[stops.length - 1][1]).map((c) => c / 255) as [number, number, number];
}
export const rampCss = (stops: [number, string][], v: number | null) => {
  const [r, g, b] = ramp(stops, v);
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
};
