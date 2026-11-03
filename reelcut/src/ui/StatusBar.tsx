// Bottom status bar: background work (transcription, 360 motion analysis, export queue), save state, GPU.
import { CircleAlert, Cpu, LoaderCircle, Save, Upload } from "lucide-preact";
import { api } from "../api";
import { set, useStore } from "../store";

const hhmm = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export function StatusBar() {
  const s = useStore();
  const as = s.project?.assets ?? [];
  const tr = as.filter((a) => a.tState === "running");
  const errs = as.filter((a) => a.tState === "error");
  const mo = Object.values(s.motion);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const job = s.exportJob;
  const hw = s.info?.hw;
  const enc = hw?.h264 && hw.h264 !== "libx264" ? hw.h264.replace("h264_", "").toUpperCase() : "CPU";
  return (
    <footer class="statusbar" role="status" aria-live="polite">
      {mo.length > 0 && <span class="sb-item"><LoaderCircle size={12} class="spin-i" aria-hidden="true" /> 흔들림 분석 {mo.length}개 · {avg(mo)}%</span>}
      {tr.length > 0 && <span class="sb-item"><LoaderCircle size={12} class="spin-i" aria-hidden="true" /> 받아쓰기 {tr.length}개 · {avg(tr.map((a) => a.tPct ?? 0))}%</span>}
      {errs.length > 0 && <span class="sb-item warn" title={errs.map((a) => `${a.info.name}: ${a.tError}`).join("\n")}><CircleAlert size={12} aria-hidden="true" /> 문제 {errs.length}개</span>}
      {job && (
        <button class="sb-item sb-btn" onClick={() => set({ dialog: "export" })} title="내보내기 창 열기">
          <Upload size={12} aria-hidden="true" />
          {job.state === "running" ? `내보내는 중 ${job.pct.toFixed(0)}%${job.name ? ` · ${job.name}` : ""}` : job.state === "done" ? "내보내기 완료" : job.state === "error" ? "내보내기 실패" : "내보내기 취소됨"}
          {s.exportQueue.length > 0 && ` · 대기 ${s.exportQueue.length}개`}
        </button>
      )}
      {job?.state === "done" && job.result?.path && <button class="sb-item sb-btn" onClick={() => api.reveal(job.result.path)}>폴더에서 보기</button>}
      <span class="spacer" />
      {s.agentBusy && <span class="sb-item"><LoaderCircle size={12} class="spin-i" aria-hidden="true" /> AI: {s.agentStatus}</span>}
      {s.project && s.savedAt > 0 && <span class="sb-item muted" title="편집은 자동으로 저장됩니다"><Save size={12} aria-hidden="true" /> 저장됨 {hhmm(s.savedAt)}</span>}
      {hw && <span class="sb-item muted" title={`그래픽카드: ${hw.gpus.join(", ") || "없음"}\nffmpeg ${hw.ffmpeg_version}`}><Cpu size={12} aria-hidden="true" /> 인코더 {enc}</span>}
    </footer>
  );
}
