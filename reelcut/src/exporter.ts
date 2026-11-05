// Starts an export of a draft (used by the export dialog and the agent), runs a queue of
// exports one after another, and tells the user when each one ends.
import { aiActive, logAction } from "./actionlog";
import { api } from "./api";
import { draftCaptions, toAss, toSrt } from "./captions";
import { draftDuration, draftWords, is360, isGap, outSize, overlays, rangeDraft, toPlan, uid } from "./edit";
import { pickCodec, QUALITIES, SHRINK, shrinkSettings } from "./presets";
import { assetMap, set, st, toast } from "./store";
import type { Asset, Draft, JobEvent } from "./types";

export type ExportChoice = {
  /** Also save the captions as an .srt next to the video. */
  srt?: boolean;
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
  /** Sound only: wav (default) or mp3. */
  audioFormat?: "wav" | "mp3";
  /** Purpose preset that filled this choice (shown as selected). */
  purpose?: string;
};

// 작게, at the footage's own size up to 4K and its own frame rate up to 60: `sourceLimits`.
export const DEFAULT_CHOICE: ExportChoice = { mode: "shrink", quality: "auto", preset: "small", codec: "auto", container: "mp4", dir: "", name: "", kbps: 0, abr: 256, fps: 0, loudnorm: true, duck: false, range: false, purpose: "small" };

/** The short side of the picture a file can fill without being enlarged. A 360 file: its lens decides. */
function sourceShort(a: Asset): number {
  const { width, height, layout360, videos } = a.info;
  if (is360(a)) {
    const lens = layout360 === "dual" ? videos[0]?.width ?? width / 2 : layout360 === "dfisheye" ? height : width / 2;
    return Math.round((lens * 9) / 16);
  }
  return Math.min(width, height);
}

/** What the draft's footage has, at most 4K and 60 fps: the default export never goes above it. */
export function sourceLimits(d: Draft, assets: Map<string, Asset>): { short: number; fps: number } {
  let short = 0, fps = 0;
  for (const c of [...d.clips.filter((x) => !isGap(x) && !x.disabled), ...overlays(d).filter((x) => !x.disabled)]) {
    const a = assets.get(c.asset);
    if (!a || a.info.kind === "audio") continue;
    short = Math.max(short, sourceShort(a));
    if (a.info.kind === "video") fps = Math.max(fps, a.info.fps || 0);
  }
  return { short: short ? Math.min(2160, Math.round(short / 2) * 2) : 1080, fps: fps ? Math.min(60, fps) : d.fps || 30 };
}

/** The quality picked, with "원본 그대로" worked out for this draft. */
export function qualityOf(d: Draft, id: string) {
  const q = QUALITIES.find((x) => x.id === id) ?? QUALITIES.find((x) => x.id === "fhd")!;
  if (q.id !== "auto") return q;
  const { short } = sourceLimits(d, assetMap());
  return { ...q, short, kbps: short >= 2160 ? 32000 : short >= 1440 ? 16000 : short >= 1080 ? 8000 : short >= 720 ? 5000 : 2000 };
}

/** The choices worth remembering between runs of the app: the sound ones. Each export starts from the default otherwise. */
export function rememberedChoice(c: Pick<ExportChoice, "loudnorm" | "duck" | "srt">) {
  return { loudnorm: c.loudnorm, duck: c.duck, srt: c.srt };
}

/** What an AI export of a given quality uses: the user's saved sound choices, else the dialog's defaults. */
export function aiExportSound(saved: { loudnorm?: boolean; duck?: boolean } | undefined): { loudnorm: boolean; duck: boolean } {
  return { loudnorm: saved?.loudnorm ?? !!DEFAULT_CHOICE.loudnorm, duck: saved?.duck ?? !!DEFAULT_CHOICE.duck };
}

/** Purpose presets: what most people pick from. */
export const PURPOSES: { id: string; label: string; desc: string; aspect?: string; choice: Partial<ExportChoice> }[] = [
  { id: "small", label: "작게 (기본)", desc: "원본 화질, 최대 4K·60fps · AV1/HEVC", choice: { mode: "shrink", quality: "auto", preset: "small", container: "mp4" } },
  { id: "yt-4k", label: "유튜브 4K", desc: "3840×2160 · H.264 32Mbps", aspect: "16:9", choice: { mode: "standard", quality: "4k", loudnorm: true } },
  { id: "yt-fhd", label: "유튜브 FHD", desc: "1920×1080 · H.264 8Mbps", aspect: "16:9", choice: { mode: "standard", quality: "fhd", loudnorm: true } },
  { id: "shorts", label: "쇼츠·릴스", desc: "1080×1920 세로 · H.264", aspect: "9:16", choice: { mode: "standard", quality: "fhd", loudnorm: true } },
  { id: "insta", label: "인스타 피드", desc: "1080×1350 · H.264", aspect: "4:5", choice: { mode: "standard", quality: "fhd", loudnorm: true } },
  { id: "archive", label: "보관용 고화질", desc: "원본 화질 가깝게 · 고압축 보관", choice: { mode: "shrink", quality: "fhd", preset: "archive" } },
  { id: "lecture", label: "강의·CCTV", desc: "움직임 적은 화면 · 가장 작게", choice: { mode: "shrink", quality: "hd", preset: "lecture" } },
  { id: "audio", label: "소리만", desc: "WAV 무손실", choice: { mode: "audio", audioFormat: "wav" } },
  { id: "mp3", label: "소리만 MP3", desc: "MP3 320kbps · 작은 파일", choice: { mode: "audio", audioFormat: "mp3" } },
];

const sep = () => (st.info?.platform === "windows" ? "\\" : "/");
const cleanName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").trim() || "편집본";

export function outPath(d: Draft, c: ExportChoice): string {
  const dir = c.dir || st.settings.exportDir || st.info?.videosDir || ".";
  const ext = c.mode === "audio" ? (c.audioFormat === "mp3" ? "mp3" : "wav") : c.mode === "shrink" ? c.container : "mp4";
  return dir.replace(/[\\/]+$/, "") + sep() + cleanName(c.name || `${st.project?.name ?? ""} ${d.name}`) + "." + ext;
}

export function captionFiles(d: Draft, width: number, height: number) {
  const { lines: all, tr } = draftCaptions(d, draftWords(d, assetMap()));
  const lines = all.filter((l) => !l.hidden);
  return { lines, tr, ass: toAss(d.captions ? lines : [], d.captionStyle, width, height, d.texts ?? [], d.captions ? tr : [], d.capShow ?? "orig"), srt: toSrt(lines), trSrt: tr.length ? toSrt(tr) : "" };
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
  const q = qualityOf(d, c.quality);
  const p = SHRINK.find((x) => x.id === c.preset) ?? SHRINK[1];
  const short = c.mode === "audio" ? 480 : q.short;
  const [w, h] = outSize(d.aspect, short);
  const range = exportRange(d, c);
  const dd = { ...(range ? rangeDraft(d, range[0], range[1]) : d), fps: c.fps || sourceLimits(d, assetMap()).fps };
  const ass = (dd.captions || dd.texts?.length) && c.mode !== "audio" ? captionFiles(dd, w, h).ass : "";
  const srts = c.srt && dd.captions ? captionFiles(dd, w, h) : null;
  const shrink = c.mode === "shrink" ? shrinkSettings(p, pickCodec(c.codec, st.info?.hw ?? null), c.container) : null;
  const plan = toPlan(dd, assetMap(), { mode: c.mode, short, vbitrate: c.kbps || q.kbps, shrink, out: outPath(d, c), audioFormat: c.mode === "audio" ? c.audioFormat : undefined, ass, loudnorm: c.loudnorm, duck: c.duck, abr: c.abr || 256 });
  const id = uid();
  set({ exportJob: { id, draft: d.id, pct: 0, state: "running", message: "", out: plan.out, name: d.name } });
  exportStart = { at: Date.now(), draft: d.id, params: { mode: c.mode, quality: c.quality, preset: c.mode === "shrink" ? c.preset : undefined, loudnorm: !!c.loudnorm, duck: !!c.duck, fps: dd.fps, size: `${w}x${h}`, range, out: plan.out } };
  if (st.project) logAction(st.project.id, { who: aiActive() ? "ai" : "user", kind: "export", label: "내보내기 시작", draft: d.id, params: exportStart.params, detail: `${d.name} → ${plan.out}` });
  try {
    const out = await api.export(id, plan);
    set({ exportJob: { ...st.exportJob!, out } });
    if (srts) await api.saveSrt(out, srts.srt).catch((e) => toast(`자막 파일을 저장하지 못했습니다: ${e}`));
    // The translation goes beside it, named by its language (video.영어.srt).
    if (srts?.trSrt) await api.saveSrt(out.replace(/(\.[^.\\/]+)$/, `.${cleanName(dd.translation?.lang ?? "번역")}$1`), srts.trSrt).catch((e) => toast(`번역 자막을 저장하지 못했습니다: ${e}`));
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

/** The running export, for its log line at the end. */
let exportStart: { at: number; draft: string; params: Record<string, unknown> } | null = null;

/** Called by the job listener when an export ends. */
export function onExportEnd(state: string, name: string, path: string, message: string, warnings?: string[]) {
  const msg = state === "done" ? `내보내기 완료: ${name}` : state === "cancelled" ? `내보내기 취소: ${name}` : `내보내기 실패: ${name}`;
  if (st.project) logAction(st.project.id, {
    who: "system", kind: "export", label: msg.split(":")[0], draft: exportStart?.draft ?? null, params: exportStart?.params ?? null, ok: state === "done",
    took: exportStart ? Date.now() - exportStart.at : 0,
    detail: [path, warnings?.length ? `주의: ${warnings.join(" / ")}` : "", message && state !== "done" ? `오류: ${message.slice(0, 600)}` : ""].filter(Boolean).join(" · "),
  });
  exportStart = null;
  toast(warnings?.length ? `${msg}. 주의: ${warnings.join(" / ")}` : msg);
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
