import { useState } from "preact/hooks";
import { api, pickFolder } from "../api";
import { draftDuration, fmtTC, outSize } from "../edit";
import { DEFAULT_CHOICE, outPath, startExport, type ExportChoice } from "../exporter";
import { estimateBytes, pickCodec, QUALITIES, SHRINK } from "../presets";
import { set, st, toast, useStore } from "../store";
import type { Draft } from "../types";

const fmtBytes = (b: number) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + " GB" : (b / 1024 ** 2).toFixed(b >= 100 * 1024 ** 2 ? 0 : 1) + " MB");
const CODEC_NAME: Record<string, string> = { av1: "AV1", hevc: "H.265(HEVC)", h264: "H.264" };

let lastChoice: ExportChoice = { ...DEFAULT_CHOICE };

export function ExportDialog({ draft: d, onClose }: { draft: Draft; onClose: () => void }) {
  const s = useStore();
  const [c, setC] = useState<ExportChoice>({ ...lastChoice, name: "" });
  const up = (p: Partial<ExportChoice>) => { const n = { ...c, ...p }; setC(n); lastChoice = { ...n, name: "" }; };
  const job = s.exportJob && s.exportJob.draft === d.id ? s.exportJob : null;
  const secs = draftDuration(d);
  const q = QUALITIES.find((x) => x.id === c.quality)!;
  const preset = SHRINK.find((x) => x.id === c.preset)!;
  const codec = pickCodec(c.codec, s.info?.hw ?? null);
  const [w, h] = outSize(d.aspect, q.short);
  const est = estimateBytes(c.mode, secs, q.kbps, preset, codec, q.short);
  const path = outPath(d, c);

  const go = async () => {
    try { await startExport(d, c); } catch (e) { toast(String((e as Error)?.message ?? e)); }
  };

  if (job) {
    const done = job.state === "done";
    return (
      <div class="modal-bg">
        <div class="modal">
          <h2>{done ? "내보내기 완료" : job.state === "running" ? "내보내는 중…" : job.state === "cancelled" ? "취소했습니다" : "내보내기 실패"}</h2>
          <p class="muted path">{job.result?.path ?? job.out}</p>
          {job.state === "running" && (
            <>
              <div class="bar"><div style={{ width: `${job.pct}%` }} /></div>
              <p>{job.pct.toFixed(0)}%{job.left != null && job.left >= 0 ? ` · 남은 시간 약 ${fmtTC(job.left)}` : ""}</p>
            </>
          )}
          {done && (
            <p>{fmtBytes(job.result.size)} · 영상 길이 {fmtTC(job.result.duration)} · 걸린 시간 {fmtTC(job.result.seconds)}{job.message ? <><br /><span class="warn">{job.message}</span></> : null}</p>
          )}
          {(job.state === "error") && <pre class="errbox">{job.message.slice(-1500)}</pre>}
          <div class="row end">
            {job.state === "running" && <button onClick={() => api.cancel("export")}>취소</button>}
            {done && <button onClick={() => api.reveal(job.result.path)}>폴더에서 보기</button>}
            {job.state !== "running" && <button onClick={() => set({ exportJob: null })}>다시 설정</button>}
            <button class="primary" onClick={() => { if (job.state !== "running") set({ exportJob: null }); onClose(); }}>{job.state === "running" ? "닫기 (계속 진행)" : "닫기"}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal export">
        <h2>내보내기 · {d.name} ({fmtTC(secs)})</h2>
        <div class="tabs">
          <button class={c.mode === "standard" ? "on" : ""} onClick={() => up({ mode: "standard" })}>일반 (MP4)</button>
          <button class={c.mode === "shrink" ? "on" : ""} onClick={() => up({ mode: "shrink" })}>고압축 (작은 파일)</button>
          <button class={c.mode === "audio" ? "on" : ""} onClick={() => up({ mode: "audio" })}>소리만 (WAV)</button>
        </div>
        {c.mode !== "audio" && (
          <div class="opts">
            {QUALITIES.map((x) => (
              <label class={`opt ${c.quality === x.id ? "on" : ""}`}>
                <input type="radio" checked={c.quality === x.id} onChange={() => up({ quality: x.id })} />
                <b>{x.label}</b>
                <span class="muted">{outSize(d.aspect, x.short).join("×")}{c.mode === "standard" ? ` · ${x.kbps / 1000}Mbps` : ""}</span>
              </label>
            ))}
          </div>
        )}
        {c.mode === "shrink" && (
          <>
            <div class="opts">
              {SHRINK.map((p) => (
                <label class={`opt ${c.preset === p.id ? "on" : ""}`}>
                  <input type="radio" checked={c.preset === p.id} onChange={() => up({ preset: p.id })} />
                  <b>{p.label}</b>
                  <span class="muted">{p.desc}</span>
                </label>
              ))}
            </div>
            <div class="row">
              <label>코덱
                <select value={c.codec} onChange={(e) => up({ codec: (e.target as HTMLSelectElement).value })}>
                  <option value="auto">자동 ({CODEC_NAME[pickCodec("auto", s.info?.hw ?? null)]})</option>
                  <option value="av1" disabled={!s.info?.hw.av1}>AV1{s.info?.hw.av1 ? "" : " (이 PC 미지원)"}</option>
                  <option value="hevc">H.265(HEVC)</option>
                  <option value="h264">H.264 (호환성 최고)</option>
                </select>
              </label>
              <label>파일 형식
                <select value={c.container} onChange={(e) => up({ container: (e.target as HTMLSelectElement).value as any })}>
                  <option value="mkv">MKV (Opus 소리)</option>
                  <option value="mp4">MP4 (AAC 소리)</option>
                </select>
              </label>
            </div>
            <p class="muted">{CODEC_NAME[codec]} CRF {preset.crf[codec]} · 가변 프레임 · {c.container === "mp4" ? "AAC" : "Opus"} {c.container === "mp4" ? Math.max(96, Math.round(preset.abr * 1.5)) : preset.abr}k{preset.screen ? " · 멈춘 화면 프레임 버림" : ""}</p>
          </>
        )}
        <div class="row">
          <label style="flex:1">파일 이름
            <input value={c.name} placeholder={path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "")} onInput={(e) => up({ name: (e.target as HTMLInputElement).value })} />
          </label>
        </div>
        <div class="row">
          <span class="muted path" style="flex:1">{path}</span>
          <button class="small" onClick={async () => { const f = await pickFolder(); if (f) up({ dir: f }); }}>폴더 바꾸기</button>
        </div>
        <p>
          예상 크기 약 <b>{fmtBytes(est)}</b>
          {c.mode !== "audio" && <> · {w}×{h} · {d.fps}fps</>}
          {d.captions && c.mode !== "audio" && <> · 자막 포함</>}
          {d.clips.some((x) => st.project?.assets.find((a) => a.id === x.asset)?.info.layout360 !== "none") && <> · 360 클립은 정한 시점으로 펼쳐서 내보냄</>}
        </p>
        <div class="row end">
          <button onClick={onClose}>취소</button>
          <button class="primary" onClick={go}>내보내기</button>
        </div>
      </div>
    </div>
  );
}
