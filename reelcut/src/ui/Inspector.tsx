import { ASPECTS, DEFAULT_VIEW, clipDur, fmtTC, is360, r3, updateClip } from "../edit";
import { asset, draft, editDraft, patchAsset, startProxy, useStore } from "../store";
import type { Clip, View } from "../types";
import { player } from "./Viewer";

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8];

function Num({ label, value, min, max, step, onChange, unit }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label class="num">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
      <input type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
      {unit && <span class="muted">{unit}</span>}
    </label>
  );
}

export function Inspector() {
  const s = useStore();
  const d = draft();
  if (!d) return <div class="inspector" />;
  const c = d.clips.find((x) => x.id === s.selClip);
  const set = (label: string, patch: Partial<Clip>) => { editDraft(label, (x) => updateClip(x, c!.id, patch)); player.refresh(); };

  if (c) {
    const a = asset(c.asset);
    const v: View = c.view ?? DEFAULT_VIEW;
    const setView = (p: Partial<View>) => set("시점 바꾸기", { view: { ...v, ...p } });
    return (
      <div class="inspector">
        <h3>클립</h3>
        <p class="muted">{a?.info.name} · 원본 {fmtTC(c.start, true)}–{fmtTC(c.end, true)} · 길이 {fmtTC(clipDur(c), true)}</p>
        <div class="row">
          <label>시작(초)<input type="number" step={0.1} value={r3(c.start)} onChange={(e) => set("다듬기", { start: Math.max(0, Math.min(c.end - 0.1, Number((e.target as HTMLInputElement).value))) })} /></label>
          <label>끝(초)<input type="number" step={0.1} value={r3(c.end)} onChange={(e) => set("다듬기", { end: Math.min(a?.info.duration || 1e9, Math.max(c.start + 0.1, Number((e.target as HTMLInputElement).value))) })} /></label>
        </div>
        <label>속도
          <select value={String(c.speed)} onChange={(e) => set("속도", { speed: Number((e.target as HTMLSelectElement).value) })}>
            {SPEEDS.map((x) => <option value={String(x)}>{x}x</option>)}
          </select>
        </label>
        <Num label="음량" value={Math.round(c.volume * 100)} min={0} max={200} step={5} unit="%" onChange={(x) => set("음량", { volume: x / 100 })} />
        <div class="row">
          <label>페이드 인<input type="number" min={0} max={5} step={0.1} value={c.fadeIn ?? 0} onChange={(e) => set("페이드", { fadeIn: Number((e.target as HTMLInputElement).value) })} /></label>
          <label>페이드 아웃<input type="number" min={0} max={5} step={0.1} value={c.fadeOut ?? 0} onChange={(e) => set("페이드", { fadeOut: Number((e.target as HTMLInputElement).value) })} /></label>
        </div>
        {a && a.info.kind !== "audio" && !is360(a) && (
          <label>화면 맞춤
            <select value={c.fit ?? "fit"} onChange={(e) => set("화면 맞춤", { fit: (e.target as HTMLSelectElement).value as any })}>
              <option value="fit">전체 보이기 (여백)</option>
              <option value="fill">꽉 채우기 (잘림)</option>
            </select>
          </label>
        )}
        {a && is360(a) && (
          <>
            <h3>360 시점</h3>
            <p class="muted">화면을 끌어서 바꿀 수도 있습니다.</p>
            <Num label="좌우(yaw)" value={v.yaw} min={-180} max={180} step={1} unit="°" onChange={(x) => setView({ yaw: x })} />
            <Num label="위아래(pitch)" value={v.pitch} min={-90} max={90} step={1} unit="°" onChange={(x) => setView({ pitch: x })} />
            <Num label="기울기(roll)" value={v.roll} min={-180} max={180} step={1} unit="°" onChange={(x) => setView({ roll: x })} />
            <Num label="화각" value={v.hfov} min={20} max={160} step={1} unit="°" onChange={(x) => setView({ hfov: x })} />
            <button class="small" onClick={() => set("시점 초기화", { view: { ...DEFAULT_VIEW } })}>정면으로</button>
            <h3>렌즈 ({a.info.layout360 === "dual" ? "OSV 두 렌즈" : a.info.layout360 === "dfisheye" ? "두 어안 나란히" : "펼친 360"})</h3>
            {a.info.layout360 !== "equirect" && (
              <>
                <label class="check"><input type="checkbox" checked={a.lens?.swap ?? false} onChange={(e) => { patchAsset(a.id, { lens: { layout: a.info.layout360, fov: a.lens?.fov ?? 190, swap: (e.target as HTMLInputElement).checked }, proxy: null }); startProxy(a.id); }} /> 앞뒤 렌즈 바꾸기 (정면이 뒤로 보이면)</label>
                <label>렌즈 화각
                  <select value={String(a.lens?.fov ?? 190)} onChange={(e) => { patchAsset(a.id, { lens: { layout: a.info.layout360, swap: a.lens?.swap ?? false, fov: Number((e.target as HTMLSelectElement).value) }, proxy: null }); startProxy(a.id); }}>
                    {[180, 185, 190, 195, 200].map((x) => <option value={String(x)}>{x}°</option>)}
                  </select>
                </label>
                <p class="muted">바꾸면 미리보기 파일을 다시 만듭니다. 이음매가 겹치거나 벌어지면 화각을 조정하세요.</p>
              </>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div class="inspector">
      <h3>편집본</h3>
      <label>화면 비율
        <select value={d.aspect} onChange={(e) => editDraft("화면 비율", (x) => ({ ...x, aspect: (e.target as HTMLSelectElement).value }))}>
          {ASPECTS.map((x) => <option value={x}>{x}{x === "9:16" ? " (쇼츠·릴스)" : x === "16:9" ? " (유튜브)" : ""}</option>)}
        </select>
      </label>
      <label>프레임 레이트
        <select value={String(d.fps)} onChange={(e) => editDraft("프레임 레이트", (x) => ({ ...x, fps: Number((e.target as HTMLSelectElement).value) }))}>
          {[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map((x) => <option value={String(x)}>{x}fps</option>)}
        </select>
      </label>
      <h3>자막</h3>
      <label class="check"><input type="checkbox" checked={d.captions} onChange={(e) => editDraft("자막", (x) => ({ ...x, captions: (e.target as HTMLInputElement).checked }))} /> 받아쓰기로 자막 넣기</label>
      {d.captions && (
        <>
          <Num label="크기" value={d.captionStyle.size} min={2} max={14} step={0.5} unit="%" onChange={(v) => editDraft("자막 크기", (x) => ({ ...x, captionStyle: { ...x.captionStyle, size: v } }))} />
          <Num label="한 줄 글자" value={d.captionStyle.maxChars} min={6} max={40} step={1} onChange={(v) => editDraft("자막 줄 길이", (x) => ({ ...x, captionStyle: { ...x.captionStyle, maxChars: v } }))} />
          <div class="row">
            <label>위치
              <select value={d.captionStyle.position} onChange={(e) => editDraft("자막 위치", (x) => ({ ...x, captionStyle: { ...x.captionStyle, position: (e.target as HTMLSelectElement).value as any } }))}>
                <option value="bottom">아래</option><option value="middle">가운데</option><option value="top">위</option>
              </select>
            </label>
            <label>글자색<input type="color" value={d.captionStyle.color} onChange={(e) => editDraft("자막 색", (x) => ({ ...x, captionStyle: { ...x.captionStyle, color: (e.target as HTMLInputElement).value } }))} /></label>
            <label>테두리<input type="color" value={d.captionStyle.outline} onChange={(e) => editDraft("자막 테두리", (x) => ({ ...x, captionStyle: { ...x.captionStyle, outline: (e.target as HTMLInputElement).value } }))} /></label>
          </div>
        </>
      )}
      <h3>배경음악</h3>
      {!d.music.length && <p class="muted">소리 파일을 타임라인 아래 줄에 끌어다 놓으세요.</p>}
      {d.music.map((m) => (
        <div class="music-row" key={m.id}>
          <span>♪ {asset(m.asset)?.info.name}</span>
          <Num label="음량" value={Math.round(m.volume * 100)} min={0} max={150} step={5} unit="%" onChange={(v) => editDraft("음악 음량", (x) => ({ ...x, music: x.music.map((y) => (y.id === m.id ? { ...y, volume: v / 100 } : y)) }))} />
          <button class="small" onClick={() => editDraft("음악 빼기", (x) => ({ ...x, music: x.music.filter((y) => y.id !== m.id) }))}>빼기</button>
        </div>
      ))}
      <h3>마커</h3>
      {!d.markers.length && <p class="muted">M 키로 재생 위치에 마커를 답니다.</p>}
      {d.markers.slice().sort((a, b) => a.t - b.t).map((m) => (
        <div class="row marker-row" key={m.id}>
          <a onClick={() => player.seek(m.t)}>{fmtTC(m.t, true)}</a>
          <input value={m.label} onChange={(e) => editDraft("마커 이름", (x) => ({ ...x, markers: x.markers.map((y) => (y.id === m.id ? { ...y, label: (e.target as HTMLInputElement).value } : y)) }))} />
          <button class="small" onClick={() => editDraft("마커 지우기", (x) => ({ ...x, markers: x.markers.filter((y) => y.id !== m.id) }))}>✕</button>
        </div>
      ))}
      <p class="muted tip">클립을 누르면 속도·음량·360 시점을 바꿀 수 있습니다.<br />단축키: Space 재생 · S 자르기 · Delete 지우기 · M 마커 · Ctrl+Z 되돌리기 · Ctrl+E 내보내기</p>
    </div>
  );
}
