// Properties of the selection (Inspector): a main-track clip, a V2/V3 picture, a sound item,
// or — with nothing selected — the draft itself. Sections fold; every number can be dragged on
// its label, typed, or reset.
import { ChevronDown, ChevronRight, Diamond, RotateCcw, Trash2 } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { api, pickLut } from "../api";
import {
  ASPECTS, audioTrack, fitMusic, LOOKS, clipAt, clipDur, DEFAULT_COLOR, DEFAULT_TRANSFORM, DEFAULT_VIEW, detachAudio, fmtTCF, is360, isGap, overlays, parseTC, r3, setTransition, setViewKey, starts,
  MOVE_PRESETS, movePreset, TRANSITIONS, timedDur, uid, updateAudio, updateClip, updateOverlay, viewAt, volAt,
} from "../edit";
import { CAPTION_PRESETS, STICKERS, TEXT_KINDS, textLook } from "../graphics";
import { asset, draft, editDraft, patchAsset, prepare360, st, toast, useStore } from "../store";
import type { Clip, ColorAdj, Draft, MusicClip, Overlay, TextItem, Transform, View, VolKey } from "../types";
import { player } from "./Viewer";
import { Stab360 } from "./Stab360";
import { Stitch360 } from "./Stitch360";

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8];
const OPEN_KEY = "reelcut-inspector-open";
let openState: Record<string, boolean> = (() => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) || "{}"); } catch { return {}; } })();

function Section({ id, title, term, children, defaultOpen = true, extra }: { id: string; title: string; term?: string; children: ComponentChildren; defaultOpen?: boolean; extra?: ComponentChildren }) {
  const [open, setOpen] = useState(openState[id] ?? defaultOpen);
  const toggle = () => { const v = !open; setOpen(v); openState = { ...openState, [id]: v }; try { localStorage.setItem(OPEN_KEY, JSON.stringify(openState)); } catch { /* ignore */ } };
  return (
    <section class="isec">
      <div class="isec-head">
        <button class="isec-toggle" aria-expanded={open} onClick={toggle} title={term ? `${title} · ${term}` : title}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {title}
        </button>
        {extra}
      </div>
      {open && <div class="isec-body">{children}</div>}
    </section>
  );
}

/** Number field: drag the label left/right, type a value, or reset to the default. */
function Num({ label, value, min, max, step, def, unit, onChange, onKey, keyed }: {
  label: string; value: number; min: number; max: number; step: number; def?: number; unit?: string; onChange: (v: number) => void; onKey?: () => void; keyed?: boolean;
}) {
  const round = (v: number) => Math.round(Math.max(min, Math.min(max, v)) / step) * step;
  const down = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, v0 = value;
    let last = value;
    const move = (ev: PointerEvent) => { const v = r3(round(v0 + (ev.clientX - x0) * step * (ev.shiftKey ? 10 : 1))); if (v !== last) { last = v; onChange(v); } };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const changed = def != null && Math.abs(value - def) > step / 2;
  return (
    <div class="num">
      <span class="num-label" onPointerDown={down as any} title={`${label}: 좌우로 끌어서 조절 (Shift: 10배)`}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
      <input type="number" min={min} max={max} step={step} value={r3(value)} aria-label={`${label} 값`} onChange={(e) => onChange(round(Number((e.target as HTMLInputElement).value)))} />
      <span class="num-unit muted">{unit}</span>
      {onKey && <button class={`tb ${keyed ? "on" : ""}`} onClick={onKey} title="재생 위치에 키프레임" aria-label={`${label} 키프레임`}><Diamond size={11} /></button>}
      {def != null && <button class="tb" disabled={!changed} onClick={() => onChange(def)} title="기본값으로" aria-label={`${label} 초기화`}><RotateCcw size={11} /></button>}
    </div>
  );
}

/** Timecode field (HH:MM:SS:FF or seconds). */
function TCField({ label, value, fps, onChange }: { label: string; value: number; fps: number; onChange: (v: number) => void }) {
  return (
    <label class="tcf">
      <span>{label}</span>
      <input key={value} defaultValue={fmtTCF(value, fps)} aria-label={label}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        onBlur={(e) => { const t = parseTC((e.target as HTMLInputElement).value, fps); if (t != null && Math.abs(t - value) > 1e-4) onChange(t); else (e.target as HTMLInputElement).value = fmtTCF(value, fps); }} />
    </label>
  );
}

const dB = (v: number) => (v <= 0 ? "−∞ dB" : `${(20 * Math.log10(v)).toFixed(1)} dB`);

function TransformSec({ t, onChange }: { t: Transform; onChange: (p: Partial<Transform>) => void }) {
  return (
    <Section id="transform" title="변형" term="Transform / Motion">
      <Num label="위치 X" value={t.x * 100} min={-100} max={100} step={0.5} def={0} unit="%" onChange={(v) => onChange({ x: v / 100 })} />
      <Num label="위치 Y" value={t.y * 100} min={-100} max={100} step={0.5} def={0} unit="%" onChange={(v) => onChange({ y: v / 100 })} />
      <Num label="크기" value={t.scale * 100} min={5} max={400} step={1} def={100} unit="%" onChange={(v) => onChange({ scale: v / 100 })} />
      <Num label="회전" value={t.rotation} min={-180} max={180} step={0.5} def={0} unit="°" onChange={(v) => onChange({ rotation: v })} />
      <Num label="불투명도" value={t.opacity * 100} min={0} max={100} step={1} def={100} unit="%" onChange={(v) => onChange({ opacity: v / 100 })} />
      <div class="crop-grid">
        <Num label="자르기 왼쪽" value={t.crop_l * 100} min={0} max={45} step={0.5} def={0} unit="%" onChange={(v) => onChange({ crop_l: v / 100 })} />
        <Num label="자르기 오른쪽" value={t.crop_r * 100} min={0} max={45} step={0.5} def={0} unit="%" onChange={(v) => onChange({ crop_r: v / 100 })} />
        <Num label="자르기 위" value={t.crop_t * 100} min={0} max={45} step={0.5} def={0} unit="%" onChange={(v) => onChange({ crop_t: v / 100 })} />
        <Num label="자르기 아래" value={t.crop_b * 100} min={0} max={45} step={0.5} def={0} unit="%" onChange={(v) => onChange({ crop_b: v / 100 })} />
      </div>
    </Section>
  );
}

function ColorSec({ c, onChange, onAuto }: { c: ColorAdj; onChange: (p: Partial<ColorAdj>) => void; onAuto?: () => void }) {
  return (
    <Section id="color" title="색" term="Color / Lumetri">
      <div class="row lut-row">
        <span class="muted">LUT</span>
        <span class="lut-name" title={c.lut}>{c.lut ? c.lut.split(/[\\/]/).pop() : "없음"}</span>
        <button class="small" onClick={async () => { const f = await pickLut(); if (f) onChange({ lut: f }); }} title="카메라 로그(D-Log M 등)를 일반 색으로 바꾸는 .cube 파일">불러오기</button>
        {c.lut && <button class="tb" onClick={() => onChange({ lut: "" })} aria-label="LUT 빼기" title="LUT 빼기"><Trash2 size={12} /></button>}
      </div>
      <Num label="노출" value={c.exposure} min={-2} max={2} step={0.05} def={0} unit="스톱" onChange={(v) => onChange({ exposure: v })} />
      <Num label="대비" value={c.contrast * 100} min={50} max={200} step={1} def={100} unit="%" onChange={(v) => onChange({ contrast: v / 100 })} />
      <Num label="채도" value={c.saturation * 100} min={0} max={300} step={1} def={100} unit="%" onChange={(v) => onChange({ saturation: v / 100 })} />
      <Num label="색온도" value={c.temperature} min={2500} max={12000} step={50} def={6500} unit="K" onChange={(v) => onChange({ temperature: v })} />
      <Num label="색조" value={(c.tint ?? 0) * 100} min={-100} max={100} step={1} def={0} unit="" onChange={(v) => onChange({ tint: v / 100 })} />
      <Num label="밝은 부분" value={(c.highlights ?? 0) * 100} min={-100} max={100} step={1} def={0} unit="" onChange={(v) => onChange({ highlights: v / 100 })} />
      <Num label="어두운 부분" value={(c.shadows ?? 0) * 100} min={-100} max={100} step={1} def={0} unit="" onChange={(v) => onChange({ shadows: v / 100 })} />
      <Num label="생기" value={(c.vibrance ?? 0) * 100} min={-100} max={100} step={1} def={0} unit="" onChange={(v) => onChange({ vibrance: v / 100 })} />
      <Num label="가장자리 어둡게" value={(c.vignette ?? 0) * 100} min={0} max={100} step={1} def={0} unit="" onChange={(v) => onChange({ vignette: v / 100 })} />
      <label>룩
        <select value="" onChange={(e) => { const l = LOOKS.find((x) => x.id === (e.target as HTMLSelectElement).value); if (l) onChange(l.color); }}>
          <option value="">고르기…</option>
          {LOOKS.map((l) => <option value={l.id}>{l.label}</option>)}
        </select>
      </label>
      {onAuto && <button class="small" onClick={onAuto} title="노출·대비·화이트밸런스를 자동으로 맞춥니다">자동 색 보정</button>}
      <p class="muted tip">미리보기는 근사입니다. LUT, 색온도, 색조, 가장자리는 내보낸 파일에 정확히 반영됩니다.</p>
    </Section>
  );
}

function ViewSec({ view, keys, src, onView, onKeys }: { view?: View; keys?: { t: number; view: View }[]; src: number | null; onView: (v: View) => void; onKeys: (k: { t: number; view: View }[] | undefined) => void }) {
  const cur = src != null ? viewAt(view, keys, src) : view ?? DEFAULT_VIEW;
  const animated = !!keys?.length;
  const setVal = (p: Partial<View>) => {
    const v = { ...cur, ...p };
    if (animated && src != null) onKeys(setViewKey(keys, src, v));
    else onView(v);
  };
  const keyHere = src != null && keys?.some((k) => Math.abs(k.t - src) < 0.05);
  const addKey = () => { if (src == null) return toast("재생 위치를 이 클립 위에 두세요"); onKeys(setViewKey(keys ?? (view ? [] : []), src, cur)); };
  return (
    <Section id="view360" title="360 시점" term="Reframe / Keyframes"
      extra={<button class={`tb ${keyHere ? "on" : ""}`} onClick={addKey} title="재생 위치에 시점 키프레임 (시점이 시간에 따라 움직임)" aria-label="키프레임 넣기"><Diamond size={12} /></button>}>
      <p class="muted tip">화면을 끌어서 바꿀 수도 있습니다.{animated ? " 키프레임이 있으면 재생 위치의 키프레임을 고칩니다." : " ◆로 키프레임을 넣으면 시점이 움직입니다."}</p>
      <Num label="좌우" value={cur.yaw} min={-180} max={180} step={1} def={0} unit="°" onChange={(v) => setVal({ yaw: v })} />
      <Num label="위아래" value={cur.pitch} min={-90} max={90} step={1} def={0} unit="°" onChange={(v) => setVal({ pitch: v })} />
      <Num label="기울기" value={cur.roll} min={-180} max={180} step={1} def={0} unit="°" onChange={(v) => setVal({ roll: v })} />
      <Num label="화각" value={cur.hfov} min={20} max={160} step={1} def={100} unit="°" onChange={(v) => setVal({ hfov: v })} />
      {animated && (
        <div class="keys-list">
          {keys!.map((k) => (
            <div class="row">
              <Diamond size={10} aria-hidden="true" />
              <a onClick={() => { const d = draft(); const hit = d ? clipAt(d, st.playhead) : null; if (d && hit) player.seek(hit.at + (k.t - hit.clip.start) / hit.clip.speed); }}>원본 {k.t.toFixed(2)}초</a>
              <span class="muted">좌우 {Math.round(k.view.yaw)}° · 화각 {Math.round(k.view.hfov)}°</span>
              <button class="tb" aria-label="키프레임 지우기" onClick={() => { const rest = keys!.filter((x) => x !== k); onKeys(rest.length ? rest : undefined); }}><Trash2 size={11} /></button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function ClipView({ d, c }: { d: Draft; c: Clip }) {
  const a = isGap(c) ? null : asset(c.asset);
  const fps = d.fps || 30;
  const i = d.clips.findIndex((x) => x.id === c.id);
  const set1 = (label: string, patch: Partial<Clip>) => { editDraft(label, (x) => updateClip(x, c.id, patch)); player.refresh(); };
  if (isGap(c)) return (
    <div class="inspector">
      <h3>빈칸</h3>
      <TCField label="길이" value={c.end} fps={fps} onChange={(v) => set1("빈칸 길이", { end: r3(Math.max(0.1, v)) })} />
      <p class="muted tip">검은 화면과 무음입니다. 길이를 바꾸면 뒤 클립이 따라 움직입니다.</p>
    </div>
  );
  const hit = clipAt(d, st.playhead);
  const src = hit?.clip.id === c.id ? hit.src : null;
  const t = c.transform ?? DEFAULT_TRANSFORM, col = c.color ?? DEFAULT_COLOR;
  return (
    <div class="inspector">
      <Section id="clip" title="클립" term="Clip">
        <p class="muted">{a?.info.name} · {a?.info.width ? `${a.info.width}×${a.info.height} · ` : ""}타임라인 {fmtTCF(starts(d)[i], fps)}부터</p>
        <div class="row">
          <TCField label="원본 시작" value={c.start} fps={fps} onChange={(v) => set1("다듬기", { start: r3(Math.max(0, Math.min(c.end - 0.1, v))) })} />
          <TCField label="원본 끝" value={c.end} fps={fps} onChange={(v) => set1("다듬기", { end: r3(Math.min(a?.info.duration || 1e9, Math.max(c.start + 0.1, v))) })} />
        </div>
        <p class="muted">길이 {fmtTCF(clipDur(c), fps)}</p>
        {a && a.info.kind !== "audio" && !is360(a) && (
          <label>화면 맞춤
            <select value={c.fit ?? "fit"} onChange={(e) => set1("화면 맞춤", { fit: (e.target as HTMLSelectElement).value as any })}>
              <option value="fit">전체 보이기 (여백)</option>
              <option value="fill">꽉 채우기 (잘림)</option>
            </select>
          </label>
        )}
      </Section>
      <Section id="speed" title="속도" term="Speed / Duration" defaultOpen={false}>
        <div class="row">
          <select value={SPEEDS.includes(c.speed) ? String(c.speed) : "custom"} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v !== "custom") set1("속도", { speed: Number(v) }); }} aria-label="속도 고르기">
            {SPEEDS.map((x) => <option value={String(x)}>{x}x</option>)}
            {!SPEEDS.includes(c.speed) && <option value="custom">{c.speed}x</option>}
          </select>
          <input type="number" min={0.1} max={16} step={0.05} value={c.speed} aria-label="속도 직접 입력" onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); if (v >= 0.1 && v <= 16) set1("속도", { speed: r3(v) }); }} />
          <span class="muted">배</span>
        </div>
      </Section>
      {a && a.info.kind !== "audio" && !is360(a) && <TransformSec t={t} onChange={(p) => set1("변형", { transform: { ...t, ...p } })} />}
      {a && a.info.kind !== "audio" && <ColorSec c={col} onChange={(p) => set1("색", { color: { ...col, ...p } })} onAuto={async () => {
        try {
          const r360 = is360(a);
          const lens = r360 ? { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 } : undefined;
          const r = await api.autoColor(a.info.path, c.start, c.end, lens, r360 ? viewAt(c.view, c.viewKeys, (c.start + c.end) / 2) : undefined);
          set1("자동 색 보정", { color: { ...col, ...r } });
          toast(`자동 색 보정: 노출 ${r.exposure}, 대비 ${r.contrast}, 색온도 ${r.temperature}K`);
        } catch (e) { toast(`색을 맞추지 못했습니다: ${e}`); }
      }} />}
      {a?.info.has_audio && (
        <Section id="audio" title="소리" term="Audio">
          {c.detached ? <p class="muted">소리를 A1 트랙으로 분리했습니다. A1의 소리 클립에서 조절하세요.</p> : (
            <>
              <Num label="음량" value={Math.round(c.volume * 100)} min={0} max={200} step={5} def={100} unit={dB(c.volume)} onChange={(x) => set1("음량", { volume: x / 100 })} />
              <label class="check"><input type="checkbox" checked={!!c.denoise} onChange={(e) => set1("잡음 줄이기", { denoise: (e.target as HTMLInputElement).checked })} /> 잡음 줄이기 (바람·웅웅거림) · Denoise</label>
              <button class="small" disabled={c.speed !== 1} onClick={() => editDraft("소리 분리", (x) => detachAudio(x, c.id))} title="소리를 A1 트랙으로 떼어 따로 늘이거나 줄임 (J·L컷) · Unlink">소리 분리 (J·L컷)</button>
            </>
          )}
          <div class="row">
            <Num label="페이드 인" value={c.fadeIn ?? 0} min={0} max={5} step={0.1} def={0} unit="초" onChange={(v) => set1("페이드", { fadeIn: v })} />
          </div>
          <Num label="페이드 아웃" value={c.fadeOut ?? 0} min={0} max={5} step={0.1} def={0} unit="초" onChange={(v) => set1("페이드", { fadeOut: v })} />
        </Section>
      )}
      <Section id="move" title={`움직임${c.anim?.length ? " (켜짐)" : ""}`} term="Zoom / Ken Burns" defaultOpen={!!c.anim?.length}>
        <div class="row wrap">
          {MOVE_PRESETS.map((m) => <button class="small" onClick={() => set1("움직임", { anim: movePreset(m.id, c.start, c.end) })}>{m.label}</button>)}
          {!!c.anim?.length && <button class="small" onClick={() => set1("움직임 끄기", { anim: undefined })}>끄기</button>}
        </div>
        <p class="muted tip">사진이나 영상을 천천히 확대·이동합니다. 내보낸 파일에도 같은 움직임이 들어갑니다.</p>
      </Section>
      <Section id="volkeys" title={`음량 변화${c.volKeys?.length ? ` (${c.volKeys.length})` : ""}`} term="Volume keyframes" defaultOpen={!!c.volKeys?.length}>
        <VolEditor keys={c.volKeys} at={src ?? c.start} base={c.volume ?? 1} onKeys={(k) => set1("음량 키프레임", { volKeys: k })} />
      </Section>
      {i > 0 && (
        <Section id="transition" title="전환 (앞 클립과)" term="Transition" defaultOpen={!!c.xin}>
          <Num label="디졸브" value={c.xin ?? 0} min={0} max={3} step={0.1} def={0} unit="초" onChange={(v) => editDraft("디졸브", (x) => setTransition(x, c.id, v))} />
          <label>전환 모양
            <select value={c.xtype ?? "fade"} onChange={(e) => set1("전환 모양", { xtype: (e.target as HTMLSelectElement).value })}>
              {TRANSITIONS.map((x) => <option value={x.id}>{x.label}</option>)}
            </select>
          </label>
          <p class="muted tip">0이면 바로 넘어갑니다. 미리보기는 컷으로 보이고, 내보낸 파일에서 겹쳐집니다.</p>
        </Section>
      )}
      {a && is360(a) && (
        <>
          <ViewSec view={c.view} keys={c.viewKeys} src={src} onView={(v) => set1("시점 바꾸기", { view: v })} onKeys={(k) => set1("360 키프레임", { viewKeys: k })} />
          <Section id="lens" title={`렌즈 (${a.info.layout360 === "dual" ? "OSV 두 렌즈" : a.info.layout360 === "dfisheye" ? "두 어안 나란히" : "펼친 360"})`} defaultOpen={false}>
            {a.info.layout360 !== "equirect" ? (
              <>
                <label class="check"><input type="checkbox" checked={a.lens?.swap ?? false} onChange={(e) => { patchAsset(a.id, { lens: { ...a.lens, layout: a.info.layout360, fov: a.lens?.fov ?? 190, swap: (e.target as HTMLInputElement).checked, stitch: a.lens?.stitch ? { ...a.lens.stitch, calibrated: false } : null } }); prepare360(a.id); }} /> 앞뒤 렌즈 바꾸기 (정면이 뒤로 보이면)</label>
                <label>렌즈 화각
                  <select value={String(a.lens?.fov ?? 190)} onChange={(e) => { patchAsset(a.id, { lens: { ...a.lens, layout: a.info.layout360, swap: a.lens?.swap ?? false, fov: Number((e.target as HTMLSelectElement).value), stitch: a.lens?.stitch ? { ...a.lens.stitch, calibrated: false } : null } }); prepare360(a.id); }}>
                    {[180, 185, 190, 195, 200].map((x) => <option value={String(x)}>{x}°</option>)}
                  </select>
                </label>
                <Stitch360 a={a} />
                <Stab360 a={a} />
                <p class="muted tip">.osv 원본은 미리보기에서 바로 이어 붙여 보여 줍니다. 이음매가 겹치거나 벌어지면 화각을 조정하세요.</p>
              </>
            ) : <p class="muted">이미 펼친 360 영상입니다.</p>}
          </Section>
        </>
      )}
    </div>
  );
}

function OverlayView({ d, o }: { d: Draft; o: Overlay }) {
  const a = asset(o.asset);
  const fps = d.fps || 30;
  const up = (label: string, p: Partial<Overlay>) => { editDraft(label, (x) => updateOverlay(x, o.id, p), st.draftId, false); player.refresh(); };
  const t = o.transform ?? DEFAULT_TRANSFORM, col = o.color ?? DEFAULT_COLOR;
  const src = st.playhead >= o.at && st.playhead < o.at + timedDur(o) ? o.start + (st.playhead - o.at) * (o.speed || 1) : null;
  return (
    <div class="inspector">
      <Section id="ov" title={`V${o.track} 트랙 클립`} term="Overlay / Picture-in-Picture">
        <p class="muted">{a?.info.name}</p>
        <TCField label="타임라인 시작" value={o.at} fps={fps} onChange={(v) => up("트랙 클립 옮기기", { at: r3(Math.max(0, v)) })} />
        {a?.info.kind !== "image" ? (
          <div class="row">
            <TCField label="원본 시작" value={o.start} fps={fps} onChange={(v) => up("다듬기", { start: r3(Math.max(0, Math.min(o.end - 0.1, v))) })} />
            <TCField label="원본 끝" value={o.end} fps={fps} onChange={(v) => up("다듬기", { end: r3(Math.min(a?.info.duration || 1e9, Math.max(o.start + 0.1, v))) })} />
          </div>
        ) : <TCField label="길이" value={o.end - o.start} fps={fps} onChange={(v) => up("길이", { end: r3(o.start + Math.max(0.1, v)) })} />}
        <label>트랙
          <select value={String(o.track)} onChange={(e) => up("트랙 바꾸기", { track: Number((e.target as HTMLSelectElement).value) as 2 | 3 })}>
            <option value="2">V2</option><option value="3">V3 (맨 위)</option>
          </select>
        </label>
        <Num label="페이드 인" value={o.fadeIn ?? 0} min={0} max={5} step={0.1} def={0} unit="초" onChange={(v) => up("페이드", { fadeIn: v })} />
        <Num label="페이드 아웃" value={o.fadeOut ?? 0} min={0} max={5} step={0.1} def={0} unit="초" onChange={(v) => up("페이드", { fadeOut: v })} />
      </Section>
      {a && !is360(a) && <TransformSec t={t} onChange={(p) => up("변형", { transform: { ...t, ...p } })} />}
      {a && <ColorSec c={col} onChange={(p) => up("색", { color: { ...col, ...p } })} />}
      {a?.info.has_audio && (
        <Section id="ovaudio" title="소리" term="Audio" defaultOpen={false}>
          <Num label="음량" value={Math.round((o.volume ?? 0) * 100)} min={0} max={200} step={5} def={0} unit={dB(o.volume ?? 0)} onChange={(x) => up("음량", { volume: x / 100 })} />
          <p class="muted tip">V2·V3 클립의 소리는 기본으로 꺼져 있습니다.</p>
        </Section>
      )}
      {a && is360(a) && <ViewSec view={o.view} keys={o.viewKeys} src={src} onView={(v) => up("시점 바꾸기", { view: v })} onKeys={(k) => up("360 키프레임", { viewKeys: k })} />}
    </div>
  );
}

function AudioView({ d, m }: { d: Draft; m: MusicClip }) {
  const a = asset(m.asset);
  const fps = d.fps || 30;
  const up = (label: string, p: Partial<MusicClip>) => editDraft(label, (x) => updateAudio(x, m.id, p), st.draftId, false);
  const tr = audioTrack(m);
  return (
    <div class="inspector">
      <Section id="snd" title={`A${tr} ${tr === 1 ? "소리" : tr === 2 ? "음악" : "효과음"}`} term="Audio Clip">
        <p class="muted">{a?.info.name}</p>
        <TCField label="타임라인 시작" value={m.at} fps={fps} onChange={(v) => up("옮기기", { at: r3(Math.max(0, v)) })} />
        <div class="row">
          <TCField label="원본 시작" value={m.start} fps={fps} onChange={(v) => up("다듬기", { start: r3(Math.max(0, Math.min(m.end - 0.1, v))) })} />
          <TCField label="원본 끝" value={m.end} fps={fps} onChange={(v) => up("다듬기", { end: r3(Math.min(a?.info.duration || 1e9, Math.max(m.start + 0.1, v))) })} />
        </div>
        <Num label="음량" value={Math.round(m.volume * 100)} min={0} max={200} step={5} def={tr === 2 ? 25 : 100} unit={dB(m.volume)} onChange={(x) => up("음량", { volume: x / 100 })} />
        <Num label="페이드 인" value={m.fadeIn} min={0} max={10} step={0.1} def={0} unit="초" onChange={(v) => up("페이드", { fadeIn: v })} />
        <Num label="페이드 아웃" value={m.fadeOut} min={0} max={10} step={0.1} def={0} unit="초" onChange={(v) => up("페이드", { fadeOut: v })} />
        <VolEditor keys={m.volKeys} at={Math.max(m.start, m.start + st.playhead - m.at)} base={m.volume} onKeys={(k) => up("음량 키프레임", { volKeys: k })} />
        {asset(m.asset) && <button class="small" onClick={() => editDraft("음악 길이 맞추기", (x) => fitMusic(x, m.id, asset(m.asset)!.info.duration), st.draftId, false)} title="영상 끝까지 맞게 자르거나 반복하고 끝을 부드럽게 줄입니다">영상 길이에 맞추기</button>}
        <label class="check"><input type="checkbox" checked={!!m.denoise} onChange={(e) => up("잡음 줄이기", { denoise: (e.target as HTMLInputElement).checked })} /> 잡음 줄이기 · Denoise</label>
        <label>트랙
          <select value={String(tr)} onChange={(e) => up("트랙 바꾸기", { track: Number((e.target as HTMLSelectElement).value) as 1 | 2 | 3 })}>
            <option value="1">A1 소리</option><option value="2">A2 음악 (본편이 바뀌어도 그 자리)</option><option value="3">A3 효과음</option>
          </select>
        </label>
      </Section>
    </div>
  );
}

/** Loudness keyframes of a clip or sound: add one at the current spot, change or remove them. */
function VolEditor({ keys, at, base, onKeys }: { keys?: VolKey[]; at: number; base: number; onKeys: (k: VolKey[] | undefined) => void }) {
  const ks = (keys ?? []).slice().sort((a, b) => a.t - b.t);
  const put = (t: number, v: number) => onKeys([...ks.filter((k) => Math.abs(k.t - t) > 0.05), { t: r3(t), v }].sort((a, b) => a.t - b.t));
  return (
    <>
      {ks.map((k) => (
        <div class="row" key={k.t}>
          <span class="muted" style="flex:1">{k.t.toFixed(1)}초</span>
          <input type="number" min={0} max={4} step={0.05} value={k.v} aria-label="음량" style="width:70px" onChange={(e) => put(k.t, Number((e.target as HTMLInputElement).value) || 0)} />
          <button class="tb" aria-label="키프레임 지우기" onClick={() => { const rest = ks.filter((x) => x !== k); onKeys(rest.length ? rest : undefined); }}><Trash2 size={12} /></button>
        </div>
      ))}
      <button class="small" onClick={() => put(at, ks.length ? volAt(ks, at) : base)}>재생 위치에 음량 키 넣기</button>
    </>
  );
}

function DraftView({ d }: { d: Draft }) {
  const addText = (t: Pick<TextItem, "kind" | "text" | "dur" | "sticker">) => editDraft("글자·스티커 넣기", (x) => ({ ...x, texts: [...(x.texts ?? []), { id: uid(), at: Math.round(st.playhead * 100) / 100, ...t }] }), st.draftId, false);
  const setText = (id: string, patch: Partial<TextItem>) => editDraft("글자·스티커", (x) => ({ ...x, texts: (x.texts ?? []).map((y) => (y.id === id ? { ...y, ...patch } : y)) }), st.draftId, false);
  return (
    <div class="inspector">
      <Section id="draft" title="편집본" term="Sequence Settings">
        <label>화면 비율
          <select value={d.aspect} onChange={(e) => editDraft("화면 비율", (x) => ({ ...x, aspect: (e.target as HTMLSelectElement).value }), st.draftId, false)}>
            {ASPECTS.map((x) => <option value={x}>{x}{x === "9:16" ? " (쇼츠·릴스)" : x === "16:9" ? " (유튜브)" : x === "4:5" ? " (인스타 피드)" : ""}</option>)}
          </select>
        </label>
        <label>프레임 레이트
          <select value={String(d.fps)} onChange={(e) => editDraft("프레임 레이트", (x) => ({ ...x, fps: Number((e.target as HTMLSelectElement).value) }), st.draftId, false)}>
            {[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map((x) => <option value={String(x)}>{x}fps</option>)}
          </select>
        </label>
      </Section>
      <Section id="texts" title={`글자·스티커${d.texts?.length ? ` (${d.texts.length})` : ""}`} term="Titles" defaultOpen={false}>
        <div class="row wrap">
          {TEXT_KINDS.map((k) => <button class="small" onClick={() => addText({ kind: k.id, text: k.text, dur: k.dur })}>{k.label}</button>)}
        </div>
        <div class="row wrap">
          {Object.entries(STICKERS).map(([id, k]) => <button class="small" title={`${k.label} 스티커`} onClick={() => addText({ kind: "sticker", text: "", sticker: id, dur: 3 })}>{k.label}</button>)}
        </div>
        {(d.texts ?? []).slice().sort((a, b) => a.at - b.at).map((t) => (
          <div class="text-item" key={t.id}>
            <div class="row">
              <a onClick={() => player.seek(t.at)} title="그 시각으로">{fmtTCF(t.at, d.fps || 30)}</a>
              {t.kind === "sticker" ? <span class="muted" style="flex:1">{STICKERS[t.sticker ?? "star"]?.label} 스티커</span>
                : <input value={t.text} style="flex:1;min-width:0" aria-label="글자" onChange={(e) => setText(t.id, { text: (e.target as HTMLInputElement).value })} />}
              <button class="icon-btn" aria-label="지우기" title="지우기" onClick={() => editDraft("글자 지우기", (x) => ({ ...x, texts: (x.texts ?? []).filter((y) => y.id !== t.id) }), st.draftId, false)}><Trash2 size={13} /></button>
            </div>
            <div class="row">
              <Num label="길이" value={t.dur} min={0.5} max={60} step={0.5} def={4} unit="초" onChange={(v) => setText(t.id, { dur: v })} />
              <Num label="크기" value={textLook(t).size} min={2} max={40} step={0.5} def={textLook({ ...t, size: undefined }).size} unit="%" onChange={(v) => setText(t.id, { size: v })} />
            </div>
            <div class="row">
              <Num label="가로" value={Math.round(textLook(t).x * 100)} min={0} max={100} step={1} def={Math.round(textLook({ ...t, x: undefined }).x * 100)} unit="%" onChange={(v) => setText(t.id, { x: v / 100 })} />
              <Num label="세로" value={Math.round(textLook(t).y * 100)} min={0} max={100} step={1} def={Math.round(textLook({ ...t, y: undefined }).y * 100)} unit="%" onChange={(v) => setText(t.id, { y: v / 100 })} />
              <label>색<input type="color" value={textLook(t).color} onChange={(e) => setText(t.id, { color: (e.target as HTMLInputElement).value })} /></label>
            </div>
          </div>
        ))}
      </Section>
      <Section id="captions" title="자막" term="Captions">
        <label class="check"><input type="checkbox" checked={d.captions} onChange={(e) => editDraft("자막", (x) => ({ ...x, captions: (e.target as HTMLInputElement).checked }), st.draftId, false)} /> 받아쓰기로 자막 넣기</label>
        {d.captions && (
          <>
            <label>자막 모양
              <select value="" onChange={(e) => { const p = CAPTION_PRESETS.find((k) => k.id === (e.target as HTMLSelectElement).value); if (p) editDraft("자막 모양", (x) => ({ ...x, captionStyle: { ...x.captionStyle, ...p.style } }), st.draftId, false); }}>
                <option value="">고르기…</option>
                {CAPTION_PRESETS.map((p) => <option value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <Num label="크기" value={d.captionStyle.size} min={2} max={14} step={0.5} def={6} unit="%" onChange={(v) => editDraft("자막 크기", (x) => ({ ...x, captionStyle: { ...x.captionStyle, size: v } }), st.draftId, false)} />
            <Num label="한 줄 글자" value={d.captionStyle.maxChars} min={6} max={40} step={1} def={18} onChange={(v) => editDraft("자막 줄 길이", (x) => ({ ...x, captionStyle: { ...x.captionStyle, maxChars: v } }), st.draftId, false)} />
            <div class="row">
              <label>위치
                <select value={d.captionStyle.position} onChange={(e) => editDraft("자막 위치", (x) => ({ ...x, captionStyle: { ...x.captionStyle, position: (e.target as HTMLSelectElement).value as any } }), st.draftId, false)}>
                  <option value="bottom">아래</option><option value="middle">가운데</option><option value="top">위</option>
                </select>
              </label>
              <label>글자색<input type="color" value={d.captionStyle.color} onChange={(e) => editDraft("자막 색", (x) => ({ ...x, captionStyle: { ...x.captionStyle, color: (e.target as HTMLInputElement).value } }), st.draftId, false)} /></label>
              <label>테두리<input type="color" value={d.captionStyle.outline} onChange={(e) => editDraft("자막 테두리", (x) => ({ ...x, captionStyle: { ...x.captionStyle, outline: (e.target as HTMLInputElement).value } }), st.draftId, false)} /></label>
            </div>
          </>
        )}
      </Section>
      <Section id="markers" title={`마커 ${d.markers.length ? `(${d.markers.length})` : ""}`} term="Markers">
        {!d.markers.length && <p class="muted">M 키로 재생 위치에 마커를 답니다.</p>}
        {d.markers.slice().sort((a, b) => a.t - b.t).map((m) => (
          <div class="row marker-row" key={m.id}>
            <input type="color" value={m.color} aria-label="마커 색" onChange={(e) => editDraft("마커 색", (x) => ({ ...x, markers: x.markers.map((y) => (y.id === m.id ? { ...y, color: (e.target as HTMLInputElement).value } : y)) }), st.draftId, false)} />
            <a onClick={() => player.seek(m.t)}>{fmtTCF(m.t, d.fps || 30)}</a>
            <input value={m.label} aria-label="마커 이름" onChange={(e) => editDraft("마커 이름", (x) => ({ ...x, markers: x.markers.map((y) => (y.id === m.id ? { ...y, label: (e.target as HTMLInputElement).value } : y)) }), st.draftId, false)} />
            <button class="tb" aria-label="마커 지우기" onClick={() => editDraft("마커 지우기", (x) => ({ ...x, markers: x.markers.filter((y) => y.id !== m.id) }), st.draftId, false)}><Trash2 size={12} /></button>
          </div>
        ))}
      </Section>
      <p class="muted tip">타임라인에서 클립을 누르면 변형·색·소리·360 시점을 바꿀 수 있습니다. 모든 단축키: Ctrl+/</p>
    </div>
  );
}

export function Inspector() {
  const s = useStore();
  const d = draft();
  if (!d) return <div class="inspector" />;
  const c = s.selClip ? d.clips.find((x) => x.id === s.selClip) : null;
  if (c) return <ClipView d={d} c={c} key={c.id} />;
  const o = s.selItem ? overlays(d).find((x) => x.id === s.selItem) : null;
  if (o) return <OverlayView d={d} o={o} key={o.id} />;
  const m = s.selItem ? d.music.find((x) => x.id === s.selItem) : null;
  if (m) return <AudioView d={d} m={m} key={m.id} />;
  return <DraftView d={d} />;
}

