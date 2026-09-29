import { useState, type KeyboardEvent, type PointerEvent } from "react";

/** A side panel's width, dragged from its inner edge (side "left" grows as the pointer moves left), remembered per
 *  browser, arrow keys on the focused edge, double-click to reset. `width` is null while the panel is at its default. */
export function usePanelWidth(key: string, side: "left" | "right", min: number, maxFrac: number, onDrag: (on: boolean) => void) {
  const [width, setWidth] = useState<number | null>(() => { try { const v = Number(localStorage.getItem(key)); return v > 0 ? v : null; } catch { return null; } });
  const clamp = (w: number) => Math.round(Math.max(min, Math.min(window.innerWidth * maxFrac, w)));
  const save = (w: number | null) => { try { if (w == null) localStorage.removeItem(key); else localStorage.setItem(key, String(w)); } catch { /* private window */ } };
  const sign = side === "left" ? -1 : 1;
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width;
    let last = w0;
    onDrag(true);
    const move = (ev: globalThis.PointerEvent) => { last = clamp(w0 + sign * (ev.clientX - x0)); setWidth(last); };
    const up = () => { onDrag(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); save(last); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault(); e.stopPropagation();
    const cur = width ?? (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width;
    const w = clamp(cur + sign * (e.key === "ArrowRight" ? 24 : -24));
    setWidth(w); save(w);
  };
  const onDoubleClick = () => { setWidth(null); save(null); };
  return { width: width == null ? null : clamp(width), handle: { onPointerDown, onKeyDown, onDoubleClick } };
}
