// Panel sizes of the project screen, in percent of what holds them: AI chat on the left, then the
// editor: media, preview and transcript above the timeline. Remembered on this PC (localStorage).
import { set } from "../store";

export type ViewMode = "default" | "vertical" | "preview";
export type Layout = {
  chat: number; source: number; side: number; upper: number; vSource: number; vPreview: number;
  chatOpen: boolean; sourceOpen: boolean; sideOpen: boolean; view: ViewMode;
};

const DEFAULT: Layout = { chat: 22, source: 21, side: 21, upper: 55, vSource: 45, vPreview: 34, chatOpen: true, sourceOpen: true, sideOpen: true, view: "default" };

const KEY = "reelcut-layout-v2";
function load(): Layout {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEFAULT }; }
}
let current = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode */ } };

export const layout = (): Layout => current;

export function setLayout(p: Partial<Layout>) {
  current = { ...current, ...p };
  save();
  set({});
}

export const setView = (view: ViewMode) => setLayout({ view });

export function resetLayout() {
  current = { ...DEFAULT };
  save();
  set({});
}

export function togglePanel(which: "chat" | "source" | "side") {
  const k = `${which}Open` as "chatOpen" | "sourceOpen" | "sideOpen";
  setLayout({ [k]: !current[k] });
}

/** Opens the AI chat, wherever a request comes from. */
export const openChat = () => setLayout({ chatOpen: true });

/** A drag handle between panels. `axis` x = vertical bar changing a width, y = horizontal bar changing a height. */
export function Splitter({ axis, value, min, max, invert, onChange, label, pct }: { axis: "x" | "y"; value: number; min: number; max: number; pct?: boolean; invert?: boolean; onChange: (v: number) => void; label: string }) {
  const down = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const p0 = axis === "x" ? e.clientX : e.clientY;
    const v0 = value;
    // A size in percent: of the panel that holds this bar.
    const box = el.parentElement!.getBoundingClientRect();
    const per = pct ? 100 / Math.max(1, axis === "x" ? box.width : box.height) : 1;
    const move = (ev: PointerEvent) => {
      const d = ((axis === "x" ? ev.clientX : ev.clientY) - p0) * per;
      const v = Math.max(min, Math.min(max, v0 + (invert ? -d : d)));
      onChange(pct ? Math.round(v * 10) / 10 : Math.round(v));
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const key = (e: KeyboardEvent) => {
    const step = pct ? (e.shiftKey ? 4 : 1) : e.shiftKey ? 40 : 10;
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
