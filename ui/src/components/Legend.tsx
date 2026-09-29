import { useState } from "react";
import { Icon } from "./Icon";
import { PROB_STOPS, WATER_STOPS, rampCss } from "../theme";
import type { Readout } from "./BlockModel";

/** Drawing legend: north arrow (driven by the camera), symbol key, colour ramp. */
export default function Legend({ readout, probability, layerNames = ["Upper aquifer", "Lower aquifer"] }: { readout: React.RefObject<Readout>; probability: boolean; layerNames?: string[] }) {
  const [open, setOpen] = useState(false);
  const stops = probability ? PROB_STOPS : WATER_STOPS;
  const max = probability ? 1 : 6;
  return (
    <div className={`legend ${open ? "" : "shut"}`} aria-label="Legend">
      <button className="lg-title" onClick={() => setOpen((o) => !o)} aria-expanded={open}>Legend<span>{open ? "Hide symbols" : "Symbols"}<Icon name="chevron" size={12} /></span></button>
      <div className="lg-orient">
        <div className="north" ref={(el) => { readout.current.north = el; }}>
          <svg width="34" height="44" viewBox="0 0 34 44" aria-label="North arrow"><path d="M17 3 25 33 17 27 9 33Z" fill="var(--ink)" /><path d="M17 3 9 33 17 27Z" fill="var(--sheet)" stroke="var(--ink)" strokeWidth="1" /><text x="17" y="43" textAnchor="middle" className="n-letter">N</text></svg>
        </div>
      </div>
      <div className="lg-ramp">
        <div className="lg-h">{probability ? "Chance water table is within 2 m of surface" : "Depth to water table, m"}</div>
        <div className="ramp" style={{ background: `linear-gradient(90deg, ${Array.from({ length: 13 }, (_, i) => rampCss(stops, (i / 12) * max)).join(",")})` }} />
        <div className="ramp-ticks num">{(probability ? ["0%", "25%", "50%", "75%", "100%"] : ["0", "1", "2", "3", "4", "5", "6+"]).map((t) => <span key={t}>{t}</span>)}</div>
      </div>
      <ul className="lg-keys mat">
        <li><span className="sw sw-unsat" />Unsaturated, {layerNames[0]}</li>
        <li><span className="sw sw-sat" />Saturated, {layerNames[0]}</li>
        {layerNames.slice(1).map((n, i) => <li key={n}><span className={`sw ${i % 2 ? "sw-hatch" : "sw-cross"}`} />{n}</li>)}
      </ul>
      <ul className="lg-keys">
        <li><svg width="26" height="10"><line x1="1" y1="5" x2="25" y2="5" stroke="var(--ink)" strokeWidth="2" /></svg>Supply channel</li>
        <li><svg width="26" height="10"><line x1="1" y1="5" x2="25" y2="5" stroke="var(--ink)" strokeWidth="4" /></svg>River</li>
        <li><svg width="26" height="10"><line x1="1" y1="5" x2="25" y2="5" stroke="var(--ink)" strokeWidth="1.2" strokeDasharray="4 3" /></svg>Sub-surface drain</li>
        <li><svg width="26" height="12"><path d="M13 2 19 11H7Z" fill="var(--ink)" /></svg>Licensed bore</li>
        <li><svg width="26" height="12"><circle cx="13" cy="6" r="4" fill="none" stroke="var(--ink)" strokeWidth="1.6" /></svg>Monitoring bore</li>
        {!probability && <li><svg width="26" height="10"><line x1="1" y1="5" x2="25" y2="5" stroke="var(--ink)" strokeWidth="1.4" strokeDasharray="5 3" /></svg>Water table 2 m below surface</li>}
        {!probability && <li><svg width="26" height="12"><path d="M2 9q3-7 6 0 3-7 6 0 3-7 6 0 3-7 5 0" fill="none" stroke="var(--red)" strokeWidth="1.4" /></svg>Revision: changed ≥ 0.2 m</li>}
        {!probability && <li><svg width="26" height="12"><path d="M13 2 19 11H7Z" fill="var(--red)" /></svg>Proposed bore, section cut</li>}
      </ul>
    </div>
  );
}
