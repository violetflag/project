// The top toolbar's quick buttons (2.18): work without the AI, apply to the selected clip (or the whole
// draft with Shift or when nothing is selected), each click is one undo step and goes in the action log
// the AI reads. The 360 group shows only for drafts with 360 clips and folds into "더보기" when narrow.
import { Aperture, ChevronDown, Ellipsis, Expand, Focus, Gauge, Globe, LensConvex, LoaderCircle, Route, Ruler, ScanEye, Vibrate, ZoomIn } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { actionList, runAction, type ActionDef } from "../actions";
import { keyLabel } from "../commands";
import { is360, isGap } from "../edit";
import "../quick";
import "../quick360";
import { STRENGTHS } from "../quick";
import { assetMap, draft, toast, useStore } from "../store";
import type { Draft } from "../types";

const ICONS: Record<string, any> = { Ruler, Vibrate, Gauge, Focus, ZoomIn, Expand, Aperture, Globe, LensConvex, ScanEye, Route };

function useWidth() {
  const [w, setW] = useState(typeof window === "undefined" ? 1600 : window.innerWidth);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return w;
}

/** Closes a popup on a click outside it or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return ref;
}

const has360 = (d: Draft) => { const am = assetMap(); return d.clips.some((c) => !isGap(c) && is360(am.get(c.asset))); };

export function QuickBar() {
  const s = useStore();
  const w = useWidth();
  const [busy, setBusy] = useState("");
  const [menu, setMenu] = useState<"" | "stab" | "more">("");
  const close = () => setMenu("");
  const stabRef = useDismiss(menu === "stab", close);
  const moreRef = useDismiss(menu === "more", close);
  const d = draft();
  if (!d || s.sourceId) return null;

  const sel = s.selClip && d.clips.some((c) => c.id === s.selClip);
  const scopeText = sel ? "선택한 클립" : "편집본 전체";
  const all = actionList();
  const basic = all.filter((a) => a.group === "기본");
  const v360 = has360(d) ? all.filter((a) => a.group === "360") : [];
  const labels = w >= 1400;
  const fold = w < 1100;

  const run = async (a: ActionDef, shift: boolean, params: Record<string, unknown> = {}) => {
    close();
    setBusy(a.id);
    try {
      await runAction(a.id, { scope: shift ? "draft" : "selection", params: shift && a.id === "reframe" ? { ...params, force: true } : params });
    } catch (e) {
      toast(`${a.label}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy("");
    }
  };
  const tip = (a: ActionDef) => `${a.label}${a.key ? ` (${keyLabel(a.key)})` : ""}\n${a.tooltip ?? ""}\n적용: ${scopeText} · Shift+클릭: 편집본 전체`;
  const off = (a: ActionDef) => !!busy || (a.enabled ? !a.enabled(d, { kind: "draft" }) : false);

  const btn = (a: ActionDef, withLabel = labels) => {
    const I = ICONS[a.icon ?? ""] ?? Focus;
    return (
      <button class={withLabel ? "qb-btn" : "icon-btn"} disabled={off(a)} title={tip(a)} aria-label={a.label} onClick={(e) => run(a, e.shiftKey)}>
        {busy === a.id ? <LoaderCircle size={16} class="spin-i" aria-hidden="true" /> : <I size={16} aria-hidden="true" />}
        {withLabel && <span>{a.label}</span>}
      </button>
    );
  };

  const stab = basic.find((a) => a.id === "stab");
  return (
    <div class="quickbar" role="group" aria-label="빠른 작업">
      {basic.map((a) => a.id !== "stab" ? btn(a) : (
        <div class="qb-split" ref={stabRef}>
          {btn(a)}
          <button class="icon-btn qb-arrow" disabled={off(a)} aria-label="흔들림 줄이기 세기" aria-haspopup="menu" aria-expanded={menu === "stab"} title="세기 고르기: 약·보통·강·방향 고정·끄기" onClick={() => setMenu(menu === "stab" ? "" : "stab")}>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {menu === "stab" && stab && (
            <div class="menu-pop qb-pop" role="menu">
              {STRENGTHS.map((x) => <button role="menuitem" onClick={(e) => run(stab, e.shiftKey, { strength: x.v })}><span class="mk" /><span class="ml">{x.label}</span><span class="mkey">{x.v === 1 ? "기본" : ""}</span></button>)}
              <div class="menu-sep" role="separator" />
              <button role="menuitem" onClick={(e) => run(stab, e.shiftKey, { mode: "lock" })} title="카메라가 돌아도 보는 방향을 그대로 둡니다"><span class="mk" /><span class="ml">방향 고정</span><span class="mkey" /></button>
              <button role="menuitem" onClick={(e) => run(stab, e.shiftKey, { mode: "off" })}><span class="mk" /><span class="ml">끄기</span><span class="mkey" /></button>
            </div>
          )}
        </div>
      ))}
      {v360.length > 0 && <span class="sep" />}
      {v360.length > 0 && !fold && v360.map((a) => btn(a))}
      {v360.length > 0 && fold && (
        <div class="qb-split" ref={moreRef}>
          <button class="icon-btn" aria-label="360 버튼 더보기" aria-haspopup="menu" aria-expanded={menu === "more"} title="360 화각·왜곡 보정·시점 버튼" onClick={() => setMenu(menu === "more" ? "" : "more")}><Ellipsis size={16} aria-hidden="true" /></button>
          {menu === "more" && (
            <div class="menu-pop qb-pop" role="menu">
              {v360.map((a) => {
                const I = ICONS[a.icon ?? ""] ?? Focus;
                return (
                  <button role="menuitem" disabled={off(a)} title={tip(a)} onClick={(e) => run(a, e.shiftKey)}>
                    <span class="mk"><I size={13} aria-hidden="true" /></span><span class="ml">{a.label}</span><span class="mkey">{a.key ? keyLabel(a.key) : ""}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
