import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

type Props = { labels: string[]; value: number; onChange: (i: number) => void; phases?: boolean };
const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/** Stress periods as a scrubbable cue strip. The sample district's periods carry named irrigation phases. */
export default function CueStrip({ labels, value, onChange, phases = true }: Props) {
  const [playing, setPlaying] = useState(false);
  const drag = useRef(false), box = useRef<HTMLDivElement>(null);
  const n = labels.length - 1; // index 0 is the steady-state warm-up period
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => onChange(value >= n ? 1 : value + 1), 420);
    return () => clearInterval(t);
  }, [playing, value, n, onChange]);
  useEffect(() => { if (playing && value >= n) setPlaying(false); }, [playing, value, n]);
  const pick = (x: number) => {
    const r = box.current!.getBoundingClientRect();
    onChange(Math.max(1, Math.min(n, 1 + Math.floor(((x - r.left) / r.width) * n))));
  };
  const cells = labels.slice(1).map((l, i) => {
    const m = /^\d{4}-\d{2}$/.test(l) ? Number(l.slice(5)) : null;
    return { i: i + 1, l, m, irr: m != null && m !== 6 && m !== 7, year: m != null && (m === 1 || i === 0) ? l.slice(0, 4) : "" };
  });
  const runs: { from: number; to: number; irr: boolean }[] = [];
  if (phases) cells.forEach((c) => { const last = runs[runs.length - 1]; if (last && last.irr === c.irr) last.to = c.i; else runs.push({ from: c.i, to: c.i, irr: c.irr }); });

  return (
    <div className="cue">
      <button className="tool icon" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play stress periods"}>
        <Icon name={playing ? "pause" : "play"} />
      </button>
      <div className="cue-body">
        {phases && (
          <div className="cue-phases" aria-hidden style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
            {runs.map((r) => (
              <div key={r.from} className={`phase ${r.irr ? "irr" : "win"}`} style={{ gridColumn: `${r.from} / ${r.to + 1}` }} title={r.irr ? "Irrigation season: supply channels running" : "Winter shutdown: channels dry"}>
                {r.to - r.from >= 3 ? (r.irr ? "Irrigation season" : "Winter shutdown") : r.irr || r.to === r.from ? "" : "Winter"}
              </div>
            ))}
          </div>
        )}
        <div ref={box} className="cue-cells" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }} role="slider" tabIndex={0} aria-label="Stress period" aria-valuemin={1} aria-valuemax={n} aria-valuenow={value}
          aria-valuetext={labels[value]}
          onKeyDown={(e) => { if (e.key === "ArrowRight") onChange(Math.min(n, value + 1)); if (e.key === "ArrowLeft") onChange(Math.max(1, value - 1)); }}
          onPointerDown={(e) => { drag.current = true; (e.target as Element).setPointerCapture(e.pointerId); pick(e.clientX); }}
          onPointerMove={(e) => drag.current && pick(e.clientX)} onPointerUp={() => (drag.current = false)}>
          {cells.map((c) => (
            <div key={c.i} className={`cue-cell ${c.i === value ? "on" : ""} ${c.i < value ? "past" : ""}`}>
              <span>{c.m ? MONTHS[c.m - 1] : c.i}</span>{c.year && <small>{c.year}</small>}
            </div>
          ))}
        </div>
      </div>
      <div className="cue-now num">{/^\d{4}-\d{2}$/.test(labels[value]) ? new Date(`${labels[value]}-15`).toLocaleDateString("en-AU", { month: "short", year: "numeric" }) : labels[value]}</div>
    </div>
  );
}
