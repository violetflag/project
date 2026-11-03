// Starts an export of a draft (used by the export dialog and the agent).
import { api } from "./api";
import { captionLines, toAss, toSrt } from "./captions";
import { draftDuration, draftWords, outSize, toPlan, uid } from "./edit";
import { pickCodec, QUALITIES, SHRINK, shrinkSettings } from "./presets";
import { assetMap, set, st } from "./store";
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
};

export const DEFAULT_CHOICE: ExportChoice = { mode: "standard", quality: "fhd", preset: "balanced", codec: "auto", container: "mkv", dir: "", name: "" };

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

export async function startExport(d: Draft, c: ExportChoice): Promise<string> {
  if (!d.clips.length) throw new Error("편집본에 클립이 없습니다");
  if (st.exportJob?.state === "running") throw new Error("이미 내보내는 중입니다");
  const q = QUALITIES.find((x) => x.id === c.quality) ?? QUALITIES[1];
  const p = SHRINK.find((x) => x.id === c.preset) ?? SHRINK[1];
  const short = c.mode === "audio" ? 480 : q.short;
  const [w, h] = outSize(d.aspect, short);
  const ass = d.captions && c.mode !== "audio" ? captionFiles(d, w, h).ass : "";
  const shrink = c.mode === "shrink" ? shrinkSettings(p, pickCodec(c.codec, st.info?.hw ?? null), c.container) : null;
  const plan = toPlan(d, assetMap(), { mode: c.mode, short, vbitrate: q.kbps, shrink, out: outPath(d, c), ass });
  const id = uid();
  set({ exportJob: { id, draft: d.id, pct: 0, state: "running", message: "", out: plan.out } });
  try {
    const out = await api.export(id, plan);
    set({ exportJob: { ...st.exportJob!, out } });
    return id;
  } catch (e) {
    set({ exportJob: { ...st.exportJob!, state: "error", message: String(e) } });
    throw e;
  }
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

export const exportSeconds = (d: Draft) => draftDuration(d);
