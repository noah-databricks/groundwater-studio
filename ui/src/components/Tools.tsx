import type { ReactNode } from "react";
import type { Crop, Tool } from "../types";
import { CROP_COLORS, CROP_ORDER } from "../lib/scenario";
import { Icon } from "./Icon";

// edits to the scenario, then tools that only read the solved model
const TOOLS: { id: Tool; label: string; icon: string; key: string; tip: string; group: "edit" | "read" }[] = [
  { id: "select", label: "Select", icon: "cursor", key: "V", tip: "Select and inspect a cell", group: "edit" },
  { id: "landuse", label: "Land use", icon: "brush", key: "L", tip: "Paint land use", group: "edit" },
  { id: "channels", label: "Channels", icon: "channel", key: "C", tip: "Line or unline supply-channel reaches", group: "edit" },
  { id: "bores", label: "Bores", icon: "pin", key: "B", tip: "Site or remove proposed bores", group: "edit" },
  { id: "drains", label: "Drains", icon: "drain", key: "R", tip: "Draw a sub-surface interceptor drain", group: "edit" },
  { id: "zones", label: "Zones", icon: "zone", key: "Z", tip: "Draw a zone for its water balance and targeted edits", group: "read" },
  { id: "section", label: "Section", icon: "section", key: "X", tip: "Draw a cross-section along any line", group: "read" },
];
export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.id]));

/** Edit tools for the model canvas: one active tool, its options beside it, undo and redo. */
export default function Tools({ tool, setTool, crop, setCrop, brush, setBrush, crops, canUndo, canRedo, onUndo, onRedo, children }: {
  tool: Tool; setTool: (t: Tool) => void; crop: Crop | "original"; setCrop: (c: Crop | "original") => void;
  brush: number; setBrush: (n: number) => void; crops: { code: Crop; label: string }[];
  canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; children?: ReactNode;
}) {
  const label = (c: Crop) => crops.find((x) => x.code === c)?.label ?? c;
  return (
    <div className="tools" role="toolbar" aria-label="Edit tools">
      {(["edit", "read"] as const).map((grp) => (
        <div key={grp} className="seg" role="radiogroup" aria-label={grp === "edit" ? "Edit tools" : "Analysis tools"}>
          {TOOLS.filter((t) => t.group === grp).map((t) => (
            <button key={t.id} role="radio" aria-checked={tool === t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)} title={`${t.tip} (${t.key})`}>
              <Icon name={t.icon} size={14} />{t.label}
            </button>
          ))}
        </div>
      ))}
      <div className="seg quiet" role="group" aria-label="History">
        <button onClick={onUndo} disabled={!canUndo} aria-label="Undo" title="Undo (⌘Z)"><Icon name="undo" size={14} /></button>
        <button onClick={onRedo} disabled={!canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><Icon name="redo" size={14} /></button>
      </div>
      {tool === "landuse" && (
        <div className="tool-opts" role="group" aria-label="Brush">
          <div className="swatches" role="radiogroup" aria-label="Paint">
            {CROP_ORDER.map((c) => (
              <button key={c} role="radio" aria-checked={crop === c} className={crop === c ? "on" : ""} onClick={() => setCrop(c)}>
                <i style={{ background: CROP_COLORS[c] }} />{label(c)}
              </button>
            ))}
            <button role="radio" aria-checked={crop === "original"} className={crop === "original" ? "on" : ""} onClick={() => setCrop("original")} title="Paint back the land use recorded in Unity Catalog">
              <i className="orig" />Recorded
            </button>
          </div>
          <div className="seg quiet" role="radiogroup" aria-label="Brush size">
            {[1, 3, 5].map((n) => (
              <button key={n} role="radio" aria-checked={brush === n} className={brush === n ? "on" : ""} onClick={() => setBrush(n)} title={`${n}×${n} cells ([ and ] to change)`}>
                <span className="bsz" style={{ width: 3 + n * 2, height: 3 + n * 2 }} />
              </button>
            ))}
          </div>
        </div>
      )}
      {children && tool !== "landuse" && <div className="tool-opts" role="group" aria-label="Tool options">{children}</div>}
    </div>
  );
}
