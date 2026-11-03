// Shared shapes. Field names mirror the Rust side (snake_case) where they cross the bridge.

export type VStream = { index: number; width: number; height: number; codec: string };
export type MediaInfo = {
  path: string; name: string; ext: string;
  /** video | audio | image */
  kind: string;
  size: number; duration: number; width: number; height: number; fps: number;
  vcodec: string; acodec: string; channels: number; has_audio: boolean; videos: VStream[];
  djmd: boolean;
  /** none | dual | dfisheye | equirect */
  layout360: string;
  lrf: string | null; created: number; recorded: string; bit_depth: number;
};
export type Lens = { layout: string; swap: boolean; fov: number };
export type View = { yaw: number; pitch: number; roll: number; hfov: number };
export type Word = { s: number; e: number; t: string };
export type Hw = {
  threads: number; gpus: string[]; ffmpeg_version: string; tested: [string, boolean][];
  av1: string | null; hevc: string | null; h264: string | null; has_x265: boolean; has_x264: boolean; has_opus: boolean;
};

export type JobState = "idle" | "running" | "done" | "error" | "cancelled";

export type Asset = {
  id: string;
  info: MediaInfo;
  /** Bin folder ("" = top). */
  folder: string;
  proxy?: string | null;
  proxyState?: JobState;
  proxyPct?: number;
  proxyError?: string;
  lens?: Lens;
  words?: Word[];
  lang?: string;
  tState?: JobState;
  tPct?: number;
  tError?: string;
  strip?: string;
  poster?: string;
  rating?: number;
  note?: string;
};

export type Clip = {
  id: string;
  asset: string;
  /** Source in/out in seconds. */
  start: number;
  end: number;
  speed: number;
  volume: number;
  /** Reframe for 360 sources. */
  view?: View;
  fit?: "fit" | "fill";
  fadeIn?: number;
  fadeOut?: number;
  label?: string;
};

export type MusicClip = { id: string; asset: string; start: number; end: number; at: number; volume: number; fadeIn: number; fadeOut: number };
export type Marker = { id: string; t: number; label: string; color: string };

export type CaptionStyle = { size: number; color: string; outline: string; position: "bottom" | "middle" | "top"; maxChars: number; font: string };

export type Draft = {
  id: string;
  name: string;
  clips: Clip[];
  music: MusicClip[];
  markers: Marker[];
  captions: boolean;
  captionStyle: CaptionStyle;
  /** Output aspect: 16:9 | 9:16 | 1:1 | 4:5 */
  aspect: string;
  fps: number;
  /** Words edited by hand: assetId → replacements by index (text only). */
  created: number;
  updated: number;
};

export type ChatBlock = Record<string, unknown> & { type: string };
export type ChatMsg = { role: "user" | "assistant"; content: ChatBlock[] | string };

export type Project = {
  id: string;
  name: string;
  created: number;
  updated: number;
  assets: Asset[];
  folders: string[];
  drafts: Draft[];
  /** Agent conversation (API message format). */
  chat: ChatMsg[];
};

export type Settings = {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** whisper | qwen */
  engine: string;
  whisperModel: string;
  lang: string;
  exportDir: string;
  autoProxy: boolean;
  autoTranscribe: boolean;
};

export type ShrinkSettings = { codec: string; crf: number; speed: number; fps: string; res: string; denoise: number; acodec: string; abr: number; container: string; screen: boolean; vfr: boolean };

export type Seg = {
  path: string; kind: string; start: number; dur: number; speed: number; volume: number; has_audio: boolean;
  lens: Lens | null; view: View | null; fit: string; fade_in: number; fade_out: number;
};
export type PlanMusic = { path: string; start: number; dur: number; at: number; volume: number; fade_in: number; fade_out: number };
export type Plan = {
  segs: Seg[]; music: PlanMusic[]; width: number; height: number; fps: number; ass: string;
  mode: "standard" | "shrink" | "audio"; vbitrate: number; settings: ShrinkSettings | null; out: string;
};

export type JobEvent = { id: string; kind: string; pct: number; state: JobState; message: string; result: any };
