// Export in three steps: ① what it is for (purpose presets) ② quality ③ where — with the
// detailed settings folded under "고급", saved presets, the I/O range and a queue.
import { ChevronDown, ChevronRight, ListChecks, Save, Trash2 } from "lucide-preact";
import { useState } from "preact/hooks";
import { api, pickFolder } from "../api";
import { draftDuration, fmtTC, fmtTCF, outSize, uid } from "../edit";
import { DEFAULT_CHOICE, rememberedChoice, enqueue, exportRange, exportSeconds, outPath, PURPOSES, startExport, type ExportChoice } from "../exporter";
import { estimateBytes, pickCodec, QUALITIES, SHRINK } from "../presets";
import { editDraft, saveSettings, set, st, toast, useStore } from "../store";
import type { Draft } from "../types";
import { Modal } from "./Modal";

const fmtBytes = (b: number) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + " GB" : (b / 1024 ** 2).toFixed(b >= 100 * 1024 ** 2 ? 0 : 1) + " MB");
const CODEC_NAME: Record<string, string> = { av1: "AV1", hevc: "H.265(HEVC)", h264: "H.264" };

let lastChoice: ExportChoice = { ...DEFAULT_CHOICE };

export function ExportDialog({ draft: d, onClose }: { draft: Draft; onClose: () => void }) {
  const s = useStore();
  const [c, setC] = useState<ExportChoice>({ ...lastChoice, ...s.settings.lastExport as Partial<ExportChoice>, name: "", range: d.inPoint != null || d.outPoint != null ? lastChoice.range : false });
  const [adv, setAdv] = useState(false);
  const [multi, setMulti] = useState<string[]>([]);
  const [saveName, setSaveName] = useState<string | null>(null);
  const up = (p: Partial<ExportChoice>) => { const n = { ...c, ...p }; setC(n); lastChoice = { ...n, name: "" }; saveSettings({ lastExport: rememberedChoice(n) }); };
  const job = s.exportJob && s.exportJob.draft === d.id ? s.exportJob : null;
  const secs = exportSeconds(d, c);
  const q = QUALITIES.find((x) => x.id === c.quality)!;
  const preset = SHRINK.find((x) => x.id === c.preset)!;
  const codec = pickCodec(c.codec, s.info?.hw ?? null);
  const [w, h] = outSize(d.aspect, q.short);
  const est = estimateBytes(c.mode, secs, c.kbps || q.kbps, preset, codec, q.short);
  const path = outPath(d, c);
  const purpose = PURPOSES.find((p) => p.id === c.purpose);
  const aspectMismatch = purpose?.aspect && purpose.aspect !== d.aspect;
  const hasIO = d.inPoint != null || d.outPoint != null;
  const range = exportRange(d, c);
  const saved = s.settings.exportPresets ?? [];

  const go = async () => {
    try {
      if (multi.length) {
        enqueue([d.id, ...multi.filter((x) => x !== d.id)].map((id) => ({ draftId: id, choice: { ...c, name: id === d.id ? c.name : "" } })));
        toast(`${multi.length + 1}개 편집본을 차례로 내보냅니다`);
      } else await startExport(d, c);
    } catch (e) { toast(String((e as Error)?.message ?? e)); }
  };

  if (job) {
    const done = job.state === "done";
    return (
      <Modal title={done ? "내보내기 완료" : job.state === "running" ? "내보내는 중…" : job.state === "cancelled" ? "취소했습니다" : "내보내기 실패"} onClose={() => { if (job.state !== "running") set({ exportJob: null }); onClose(); }}
        footer={<>
          {job.state === "running" && <button onClick={() => api.cancel("export")}>취소</button>}
          {done && <button onClick={() => api.reveal(job.result.path)}>폴더에서 보기</button>}
          {job.state !== "running" && <button onClick={() => set({ exportJob: null })}>다시 설정</button>}
          <button class="primary" onClick={() => { if (job.state !== "running") set({ exportJob: null }); onClose(); }}>{job.state === "running" ? "닫기 (계속 진행)" : "닫기"}</button>
        </>}>
        <p class="muted path">{job.result?.path ?? job.out}</p>
        {job.state === "running" && (
          <>
            <div class="bar" role="progressbar" aria-valuenow={job.pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${job.pct}%` }} /></div>
            <p>{job.pct.toFixed(0)}%{job.left != null && job.left >= 0 ? ` · 남은 시간 약 ${fmtTC(job.left)}` : ""}{s.exportQueue.length ? ` · 대기 ${s.exportQueue.length}개` : ""}</p>
            <p class="muted">창을 닫아도 계속됩니다. 아래 상태줄에서 진행을 볼 수 있습니다.</p>
          </>
        )}
        {done && <p>{fmtBytes(job.result.size)} · 영상 길이 {fmtTC(job.result.duration)} · 걸린 시간 {fmtTC(job.result.seconds)}{job.message ? <><br /><span class="warn">{job.message}</span></> : null}</p>}
        {job.state === "error" && <pre class="errbox">{job.message.slice(-1500)}</pre>}
      </Modal>
    );
  }

  return (
    <Modal title={<>내보내기 · {d.name} <span class="muted">({fmtTC(secs)}{range ? " 구간" : ""})</span></>} onClose={onClose} wide
      footer={<>
        <span class="muted est">예상 크기 약 <b>{fmtBytes(est * (1 + multi.length))}</b>{c.mode !== "audio" && <> · {w}×{h} · {c.fps || d.fps}fps</>}</span>
        <span class="spacer" />
        <button onClick={onClose}>취소</button>
        <button class="primary" onClick={go}>{multi.length ? `${multi.length + 1}개 내보내기` : "내보내기"}</button>
      </>}>
      <h3 class="step">① 용도</h3>
      <div class="purposes">
        {PURPOSES.map((p) => (
          <button class={`purpose ${c.purpose === p.id ? "on" : ""}`} aria-pressed={c.purpose === p.id} onClick={() => up({ ...DEFAULT_CHOICE, ...p.choice, dir: c.dir, name: c.name, range: c.range, purpose: p.id })}>
            <b>{p.label}</b><span class="muted">{p.desc}</span>
          </button>
        ))}
        {saved.map((p) => (
          <div class={`purpose saved ${c.purpose === p.id ? "on" : ""}`}>
            <button class="purpose-in" onClick={() => up({ ...DEFAULT_CHOICE, ...(p.choice as any), name: c.name, purpose: p.id })}><b>{p.label}</b><span class="muted">내 설정</span></button>
            <button class="tb" aria-label={`${p.label} 지우기`} onClick={() => saveSettings({ exportPresets: saved.filter((x) => x.id !== p.id) })}><Trash2 size={12} /></button>
          </div>
        ))}
      </div>
      {aspectMismatch && (
        <p class="warn">이 편집본은 {d.aspect}입니다. {purpose!.label}는 보통 {purpose!.aspect}입니다.
          {" "}<button class="small" onClick={() => editDraft("화면 비율", (x) => ({ ...x, aspect: purpose!.aspect! }), d.id, false)}>편집본을 {purpose!.aspect}로 바꾸기</button></p>
      )}

      {c.mode !== "audio" && (
        <>
          <h3 class="step">② 화질</h3>
          <div class="opts q4" role="radiogroup" aria-label="해상도">
            {QUALITIES.map((x) => (
              <label class={`opt ${c.quality === x.id ? "on" : ""}`}>
                <input type="radio" checked={c.quality === x.id} onChange={() => up({ quality: x.id })} />
                <b>{x.label}</b>
                <span class="muted">{outSize(d.aspect, x.short).join("×")}{c.mode === "standard" ? ` · ${x.kbps / 1000}Mbps` : ""}</span>
              </label>
            ))}
          </div>
          {c.mode === "shrink" && (
            <div class="shrink-row">
              <div class="opts" role="radiogroup" aria-label="압축 정도">
                {SHRINK.map((p) => (
                  <label class={`opt slim ${c.preset === p.id ? "on" : ""}`} title={p.desc}>
                    <input type="radio" checked={c.preset === p.id} onChange={() => up({ preset: p.id })} />
                    <b>{p.label}</b>
                  </label>
                ))}
              </div>
              <p class="muted">{preset.desc} · {CODEC_NAME[codec]} CRF {preset.crf[codec]} · 가변 프레임 · {c.container === "mp4" ? "AAC" : "Opus"}</p>
            </div>
          )}
        </>
      )}

      <h3 class="step">③ 저장</h3>
      <div class="row">
        <label style="flex:1">파일 이름
          <input value={c.name} placeholder={path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "")} onInput={(e) => up({ name: (e.target as HTMLInputElement).value })} />
        </label>
      </div>
      <div class="row">
        <span class="muted path" style="flex:1">{path}</span>
        <button class="small" onClick={async () => { const f = await pickFolder(); if (f) up({ dir: f }); }}>폴더 바꾸기</button>
      </div>
      <div class="row">
        <label class="check"><input type="checkbox" disabled={!hasIO} checked={!!c.range && hasIO} onChange={(e) => up({ range: (e.target as HTMLInputElement).checked })} />
          인·아웃 구간만{hasIO ? ` (${fmtTCF(d.inPoint ?? 0, d.fps)}–${fmtTCF(d.outPoint ?? draftDuration(d), d.fps)})` : " (타임라인에서 I·O로 정하세요)"}</label>
      </div>

      <button class="fold" aria-expanded={adv} onClick={() => setAdv(!adv)}>{adv ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 고급 설정</button>
      {adv && (
        <div class="adv">
          {c.mode === "standard" && (
            <div class="row">
              <label>영상 비트레이트
                <span class="row"><input type="number" min={0} max={200000} step={500} value={c.kbps || q.kbps} onChange={(e) => up({ kbps: Number((e.target as HTMLInputElement).value) })} /> <span class="muted">kbps</span></span>
              </label>
              <label>소리 비트레이트
                <select value={String(c.abr || 256)} onChange={(e) => up({ abr: Number((e.target as HTMLSelectElement).value) })}>
                  {[128, 192, 256, 320].map((x) => <option value={String(x)}>AAC {x}k</option>)}
                </select>
              </label>
            </div>
          )}
          {c.mode === "shrink" && (
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
          )}
          {c.mode !== "audio" && (
            <label>프레임 레이트
              <select value={String(c.fps || 0)} onChange={(e) => up({ fps: Number((e.target as HTMLSelectElement).value) })}>
                <option value="0">편집본과 같게 ({d.fps}fps)</option>
                {[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map((x) => <option value={String(x)}>{x}fps</option>)}
              </select>
            </label>
          )}
          {d?.captions && <label class="check"><input type="checkbox" checked={!!c.srt} onChange={(e) => up({ srt: (e.target as HTMLInputElement).checked })} /> 자막 파일(SRT)도 같이 저장</label>}
          <label class="check"><input type="checkbox" checked={!!c.loudnorm} onChange={(e) => up({ loudnorm: (e.target as HTMLInputElement).checked })} /> 소리 크기 맞추기 (−14 LUFS, 유튜브 기준) · Loudness Normalize</label>
          <label class="check"><input type="checkbox" checked={!!c.duck} disabled={!d.music.length} onChange={(e) => up({ duck: (e.target as HTMLInputElement).checked })} /> 말할 때 음악 자동으로 줄이기 · Ducking</label>
          <div class="row">
            {saveName == null ? (
              <button class="small" onClick={() => setSaveName("")}><Save size={13} aria-hidden="true" /> 이 설정을 내 프리셋으로 저장</button>
            ) : (
              <>
                <input autoFocus placeholder="프리셋 이름" value={saveName} onInput={(e) => setSaveName((e.target as HTMLInputElement).value)} aria-label="프리셋 이름" />
                <button class="small primary" disabled={!saveName.trim()} onClick={() => { const id = "u-" + uid(); saveSettings({ exportPresets: [...saved, { id, label: saveName.trim(), choice: { ...c, name: "", purpose: id } }] }); up({ purpose: id }); setSaveName(null); toast("프리셋을 저장했습니다"); }}>저장</button>
                <button class="small" onClick={() => setSaveName(null)}>취소</button>
              </>
            )}
          </div>
          {st.project!.drafts.length > 1 && (
            <div class="multi">
              <p><ListChecks size={14} aria-hidden="true" /> 다른 편집본도 같은 설정으로 이어서 내보내기 (대기열)</p>
              {st.project!.drafts.filter((x) => x.id !== d.id).map((x) => (
                <label class="check"><input type="checkbox" checked={multi.includes(x.id)} disabled={!x.clips.length} onChange={(e) => setMulti((e.target as HTMLInputElement).checked ? [...multi, x.id] : multi.filter((y) => y !== x.id))} /> {x.name} <span class="muted">{fmtTC(draftDuration(x))}</span></label>
              ))}
            </div>
          )}
        </div>
      )}
      <p class="muted">
        {d.captions && c.mode !== "audio" && <>자막 포함 · </>}
        {d.clips.some((x) => st.project?.assets.find((a) => a.id === x.asset)?.info.layout360 !== "none" && x.asset !== "__gap") && <>360 클립은 정한 시점으로 펼쳐서 내보냄 · </>}
        {(d.overlays?.length ?? 0) > 0 && <>V2·V3 포함 · </>}
        끝나면 알려 드립니다
      </p>
    </Modal>
  );
}
