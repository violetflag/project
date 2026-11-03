// Export presets: the original app's fixed H.264 bitrates, plus the Shrink app's compression
// presets (CRF per codec, Opus audio, VFR).
import type { Hw, ShrinkSettings } from "./types";

export type Quality = { id: string; label: string; short: number; kbps: number };
export const QUALITIES: Quality[] = [
  { id: "4k", label: "4K (2160p)", short: 2160, kbps: 32000 },
  { id: "fhd", label: "FHD (1080p)", short: 1080, kbps: 8000 },
  { id: "hd", label: "HD (720p)", short: 720, kbps: 5000 },
  { id: "sd", label: "SD (480p)", short: 480, kbps: 2000 },
];

type Codec = "av1" | "hevc" | "h264";
export type ShrinkPreset = { id: string; label: string; desc: string; crf: Record<Codec, number>; speed: number; abr: number; screen: boolean; acodec: "opus" | "aac" };
export const SHRINK: ShrinkPreset[] = [
  { id: "archive", label: "보관", desc: "원본 대신 보관할 때. 가장 또렷합니다.", crf: { av1: 22, hevc: 20, h264: 18 }, speed: 6, abr: 192, screen: false, acodec: "opus" },
  { id: "balanced", label: "균형", desc: "대부분의 영상에 맞는 기본값. 눈으로 차이를 찾기 어렵습니다.", crf: { av1: 28, hevc: 24, h264: 21 }, speed: 8, abr: 128, screen: false, acodec: "opus" },
  { id: "small", label: "작게", desc: "용량이 먼저일 때. 세밀한 질감이 조금 부드러워집니다.", crf: { av1: 34, hevc: 28, h264: 25 }, speed: 8, abr: 96, screen: false, acodec: "opus" },
  { id: "lecture", label: "강의/CCTV", desc: "움직임이 적은 화면. 바뀌지 않은 프레임은 버립니다.", crf: { av1: 35, hevc: 28, h264: 24 }, speed: 8, abr: 48, screen: true, acodec: "opus" },
];

/** "auto" → AV1 when the GPU can, else H.265 (as in Shrink). */
export function pickCodec(want: string, hw: Hw | null): Codec {
  if (want === "av1" || want === "hevc" || want === "h264") return want;
  return hw?.av1 ? "av1" : "hevc";
}

export function shrinkSettings(p: ShrinkPreset, codec: Codec, container: "mkv" | "mp4"): ShrinkSettings {
  // Opus in MP4 plays poorly in many players; MP4 gets AAC at a matching rate.
  const aac = container === "mp4";
  return {
    codec, crf: p.crf[codec], speed: p.speed, fps: "src", res: "src", denoise: 0,
    acodec: aac ? "aac" : p.acodec, abr: aac ? Math.max(96, Math.round(p.abr * 1.5)) : p.abr,
    container, screen: p.screen, vfr: true,
  };
}

/** Rough size guess in bytes (shown before export). */
export function estimateBytes(mode: string, secs: number, kbps: number, preset?: ShrinkPreset, codec?: Codec, short = 1080): number {
  if (mode === "audio") return secs * 48000 * 2 * 2;
  if (mode === "standard") return (secs * (kbps + 256) * 1000) / 8;
  // Typical bitrates at 1080p for the CRFs above (from Shrink's samples), scaled by pixels.
  const base: Record<string, number> = { archive: 6000, balanced: 2600, small: 1300, lecture: 400 };
  const cf = codec === "h264" ? 1.6 : codec === "hevc" ? 1.15 : 1;
  const px = (short / 1080) ** 2;
  return (secs * ((base[preset?.id ?? "balanced"] * cf * px) + (preset?.abr ?? 128)) * 1000) / 8;
}
