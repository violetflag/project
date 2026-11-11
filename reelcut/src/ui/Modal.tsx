// Dialog frame: title, close button, Escape and click-outside to close, focus kept inside.
import { X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

export function Modal({ title, onClose, children, wide, footer }: { title: ComponentChildren; onClose: () => void; children: ComponentChildren; wide?: boolean; footer?: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key === "Tab" && box.current) {
        const f = [...box.current.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, textarea, [tabindex='0']")];
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    window.addEventListener("keydown", key, true);
    if (!box.current?.contains(document.activeElement)) box.current?.querySelector<HTMLElement>("[autofocus], input, button.primary, button")?.focus();
    return () => { window.removeEventListener("keydown", key, true); prev?.focus?.(); };
  }, []);
  return (
    <div class="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} ref={box}>
        <div class="modal-head">
          <h2>{title}</h2>
          <button class="icon-btn" aria-label="닫기" onClick={onClose}><X size={16} /></button>
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
