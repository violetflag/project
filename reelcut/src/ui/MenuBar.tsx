// Menu bar in the title bar (파일 · 편집 · 클립 · 타임라인 · 재생 · 보기 · 도움말), built from COMMANDS.
import { Check } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { COMMANDS, firstKey, type Cmd } from "../commands";
import { useStore } from "../store";

const MENUS: Cmd["menu"][] = ["파일", "편집", "클립", "타임라인", "재생", "보기", "도움말"];

export function MenuBar() {
  useStore();
  const [open, setOpen] = useState<Cmd["menu"] | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!bar.current?.contains(e.target as Node)) setOpen(null); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(null); }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault(); e.stopPropagation();
        const i = MENUS.indexOf(open);
        setOpen(MENUS[(i + (e.key === "ArrowRight" ? 1 : MENUS.length - 1)) % MENUS.length]);
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        const items = [...(bar.current?.querySelectorAll<HTMLButtonElement>(".menu-pop button:not(:disabled)") ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1) + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", key, true); };
  }, [open]);

  return (
    <div class="menubar" ref={bar} role="menubar">
      {MENUS.map((m) => (
        <div class="menu" key={m}>
          <button role="menuitem" aria-haspopup="true" aria-expanded={open === m} class={open === m ? "on" : ""}
            onClick={() => setOpen(open === m ? null : m)} onMouseEnter={() => open && setOpen(m)}>{m}</button>
          {open === m && (
            <div class="menu-pop" role="menu">
              {COMMANDS.filter((c) => c.menu === m).map((c) => (
                <>
                  {c.sep && <div class="menu-sep" role="separator" />}
                  <button role="menuitem" disabled={c.enabled ? !c.enabled() : false} onClick={() => { setOpen(null); c.run(); }}
                    title={c.term ? `${c.label} — ${c.term}` : c.label}>
                    <span class="mk">{c.checked?.() ? <Check size={13} /> : null}</span>
                    <span class="ml">{c.label}</span>
                    <span class="mkey">{firstKey(c)}</span>
                  </button>
                </>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
