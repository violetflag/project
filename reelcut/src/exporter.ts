// Starts an export of a draft (used by the export dialog and the agent), runs a queue of
// exports one after another, and tells the user when each one ends.
import { api } from "./api";
import { captionLines, toAss, toSrt } from "./captions";
import { draftDuration, draftWords, outSize, rangeDraft, toPlan, uid } from "./edit";
import { pickCodec, QUALITIES, SHRINK, shrinkSettings } from "./presets";
import { assetMap, set, st, toast } from "./store";
import type { Draft, JobEvent } from "./types";

export type ExportChoice = {
  /** standard | shrink | audio */
  mode: "standard" | "shrink" | "audio";
  quality: string;
  preset: string;
  codec: string;
  container: "mkv" | "mp4";
  dir: string;
  name: string;
  /** Advanced: video bitrate in kbit/s for standard (0 = by quality), AAC kbit/s, fps (0 = the draft's). */
  kbps?: number;
  abr?: number;
  fps?: number;
  loudnorm?: boolean;
  duck?: boolean;
  /** Only the I/O range of the draft. */
  range?: boolean;
  /** Purpose preset that filled this choice (shown as selected). */
  purpose?: string;
};

// Matches the "유튜브 FHD" purpose it starts on.
export const DEFAULT_CHOICE: ExportChoice = { mode: "standard", quality: "fhd", preset: "balanced", codec: "auto", container: "mkv", dir: "", name: "", kbps: 0, abr: 256, fps: 0, loudnorm: true, duck: false, range: false, purpose: "yt-fhd" };

/** Purpose presets: what most people pick from. */
export const PURPOSES: { id: string; label: string; desc: string; aspect?: string; choice: Partial<ExportChoice> }[] = [
  { id: "yt-4k", label: "유튜브 4K", desc: "3840×2160 · H.264 32Mbps", aspect: "16:9", choice: { mode: "standard", quality: "4k", loudnorm: true } },
  { id: "yt-fhd", label: "유튜브 FHD", desc: "1920×1080 · H.264 8Mbps", aspect: "16:9", choice: { mode: "standard", quality: "fhd", loudnorm: true } },
  { id: "shorts", label: "쇼츠·릴스", desc: "1080×1920 세로 · H.264", aspect: "9:16", choice: { mode: "standard", quality: "fhd", loudnorm: true } },
  { id: "insta", label: "인스타 피드", desc: "1080×1350 · H.264", aspect: "4:5", choice: { mode: "standard", quality: "fhd", loudnorm: true } },
  { id: "archive", label: "보관용 고화질", desc: "원본 화질 가깝게 · 고압축 보관", choice: { mode: "shrink", quality: "fhd", preset: "archive" } },
  { id: "small", label: "작은 파일", desc: "공유·메신저용 · AV1/HEVC", choice: { mode: "shrink", quality: "fhd", preset: "small", container: "mp4" } },
  { id: "lecture", label: "강의·CCTV", desc: "움직임 적은 화면 · 가장 작게", choice: { mode: "shrink", quality: "hd", preset: "lecture" } },
  { id: "audio", label: "소리만", desc: "WAV 무손실", choice: { mode: "audio" } },
];

const sep = () => (st.info?.platform === "windows" ? "\\" : "/");
const cleanName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").trim() || "편집본";

export function outPath(d: Draft, c: ExportChoice): string {
  const dir = c.dir || st.settings.exportDir || st.info?.videosDir || ".";
  const ext = c.mode === "audio" ? "wav" : c.mode === "shrink" ? c.container : "mp4";
  return dir.replace(/[\\/]+$/, "") + sep() + cleanName(c.name || `${st.project?.name ?? ""} ${d.name}`) + "." + ext;
}

export function captionFiles(d: Draft, width: number, height: number) {
  const lines = captionLines(draftWords(d, assetMap()), d.captionStyle.maxChars);
  return { lines, ass: toAss(lines, d.captionStyle, width, height), srt: toSrt(lines) };
}

/** The timeline range this choice exports (null = all). */
export function exportRange(d: Draft, c: ExportChoice): [number, number] | null {
  if (!c.range || (d.inPoint == null && d.outPoint == null)) return null;
  return [d.inPoint ?? 0, d.outPoint ?? draftDuration(d)];
}

export function exportSeconds(d: Draft, c?: ExportChoice) {
  const r = c ? exportRange(d, c) : null;
  return r ? r[1] - r[0] : draftDuration(d);
}

export async function startExport(d: Draft, c: ExportChoice): Promise<string> {
  if (!d.clips.length) throw new Error("편집본에 클립이 없습니다");
  if (st.exportJob?.state === "running") throw new Error("이미 내보내는 중입니다");
  const q = QUALITIES.find((x) => x.id === c.quality) ?? QUALITIES[1];
  const p = SHRINK.find((x) => x.id === c.preset) ?? SHRINK[1];
  const short = c.mode === "audio" ? 480 : q.short;
  const [w, h] = outSize(d.aspect, short);
  const range = exportRange(d, c);
  const dd = { ...(range ? rangeDraft(d, range[0], range[1]) : d), fps: c.fps || d.fps };
  const ass = dd.captions && c.mode !== "audio" ? captionFiles(dd, w, h).ass : "";
  const shrink = c.mode === "shrink" ? shrinkSettings(p, pickCodec(c.codec, st.info?.hw ?? null), c.container) : null;
  const plan = toPlan(dd, assetMap(), { mode: c.mode, short, vbitrate: c.kbps || q.kbps, shrink, out: outPath(d, c), ass, loudnorm: c.loudnorm, duck: c.duck, abr: c.abr || 256 });
  const id = uid();
  set({ exportJob: { id, draft: d.id, pct: 0, state: "running", message: "", out: plan.out, name: d.name } });
  try {
    const out = await api.export(id, plan);
    set({ exportJob: { ...st.exportJob!, out } });
    return id;
  } catch (e) {
    set({ exportJob: { ...st.exportJob!, state: "error", message: String(e) } });
    throw e;
  }
}

/** Adds exports to the queue; starts the first one when nothing is running. */
export function enqueue(items: { draftId: string; choice: ExportChoice }[]) {
  set({ exportQueue: [...st.exportQueue, ...items] });
  if (st.exportJob?.state !== "running") runNext();
}

async function runNext() {
  const [next, ...rest] = st.exportQueue;
  if (!next) return;
  set({ exportQueue: rest });
  const d = st.project?.drafts.find((x) => x.id === next.draftId);
  if (!d) return runNext();
  try { await startExport(d, next.choice); } catch (e) { toast(`내보내기 실패: ${d.name} (${String((e as Error)?.message ?? e)})`); runNext(); }
}

/** Called by the job listener when an export ends. */
export function onExportEnd(state: string, name: string, path: string, message: string) {
  const msg = state === "done" ? `내보내기 완료: ${name}` : state === "cancelled" ? `내보내기 취소: ${name}` : `내보내기 실패: ${name}`;
  toast(msg);
  // A system notification too, for when Reelcut is behind other windows.
  try {
    if (typeof Notification !== "undefined" && document.hidden) {
      const show = () => new Notification("Reelcut", { body: state === "done" ? `${msg}\n${path}` : `${msg}\n${message.slice(0, 120)}` });
      if (Notification.permission === "granted") show();
      else if (Notification.permission !== "denied") Notification.requestPermission().then((p) => { if (p === "granted") show(); });
    }
  } catch { /* no notifications */ }
  if (st.exportQueue.length) setTimeout(runNext, 300);
}

/** Export and wait for the end (agent). */
export async function exportAndWait(d: Draft, c: ExportChoice): Promise<JobEvent> {
  await startExport(d, c);
  return new Promise<JobEvent>((res) => {
    const tick = () => {
      const j = st.exportJob;
      if (j && j.state !== "running") res({ id: j.id, kind: "export", pct: j.pct, state: j.state as any, message: j.message, result: j.result });
      else setTimeout(tick, 400);
    };
    setTimeout(tick, 400);
  });
}
