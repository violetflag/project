// Panel sizes of the project screen: draggable splitters, collapsible side panels and three
// arrangements (편집 / 대본 / 360). Sizes are remembered on this PC (localStorage).
import { set, st, type Workspace } from "../store";

export type Layout = { left: number; right: number; timeline: number; leftOpen: boolean; rightOpen: boolean };

const PRESETS: Record<Workspace, Layout & { leftTab: "media" | "transcript"; rightTab: "inspect" | "agent" }> = {
  edit: { left: 300, right: 340, timeline: 300, leftOpen: true, rightOpen: true, leftTab: "media", rightTab: "inspect" },
  transcript: { left: 520, right: 340, timeline: 220, leftOpen: true, rightOpen: true, leftTab: "transcript", rightTab: "inspect" },
  r360: { left: 260, right: 380, timeline: 240, leftOpen: true, rightOpen: true, leftTab: "media", rightTab: "inspect" },
};

const KEY = "reelcut-layout-v1";
function load(): Record<Workspace, Layout> {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { edit: { ...PRESETS.edit, ...s.edit }, transcript: { ...PRESETS.transcript, ...s.transcript }, r360: { ...PRESETS.r360, ...s.r360 } };
  } catch {
    return { edit: { ...PRESETS.edit }, transcript: { ...PRESETS.transcript }, r360: { ...PRESETS.r360 } };
  }
}
const layouts = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(layouts)); } catch { /* private mode */ } };

export const layout = (): Layout => layouts[st.workspace];

export function setLayout(p: Partial<Layout>) {
  Object.assign(layouts[st.workspace], p);
  save();
  set({});
}

export function applyWorkspace(w: Workspace, reset = false) {
  if (reset) {
    const { leftTab, rightTab, ...l } = PRESETS[w];
    layouts[w] = { ...l };
    save();
  }
  set({ workspace: w, leftTab: PRESETS[w].leftTab, rightTab: PRESETS[w].rightTab });
}

export function togglePanel(side: "left" | "right") {
  const l = layout();
  setLayout(side === "left" ? { leftOpen: !l.leftOpen } : { rightOpen: !l.rightOpen });
}

/** A drag handle between panels. `axis` x = vertical bar changing a width, y = horizontal bar changing a height. */
export function Splitter({ axis, value, min, max, invert, onChange, label }: { axis: "x" | "y"; value: number; min: number; max: number; invert?: boolean; onChange: (v: number) => void; label: string }) {
  const down = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const p0 = axis === "x" ? e.clientX : e.clientY;
    const v0 = value;
    const move = (ev: PointerEvent) => {
      const d = (axis === "x" ? ev.clientX : ev.clientY) - p0;
      onChange(Math.round(Math.max(min, Math.min(max, v0 + (invert ? -d : d)))));
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10;
    const dec = axis === "x" ? "ArrowLeft" : "ArrowUp", inc = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (e.key === dec || e.key === inc) {
      e.preventDefault();
      e.stopPropagation();
      const d = (e.key === inc ? step : -step) * (invert ? -1 : 1);
      onChange(Math.max(min, Math.min(max, value + d)));
    }
  };
  return (
    <div class={`splitter ${axis}`} role="separator" aria-orientation={axis === "x" ? "vertical" : "horizontal"} aria-label={label}
      aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0} onPointerDown={down as any} onKeyDown={key as any} title={`${label} (끌어서 크기 조절)`} />
  );
}
