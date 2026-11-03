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
/** Seam stitching of the two lenses (see src-tauri/src/stitch.rs). a = back lens, b = front. */
export type Stitch = {
  on: boolean; fov: number; yaw: number; pitch: number; roll: number;
  gain_a: number[]; gain_b: number[]; calibrated: boolean; before: number; after: number;
  /** Line the lenses up again on every frame (DJI's AI seam, Reelcut's own matching). */
  flow?: boolean;
};
/** 360 stabilisation (see src-tauri/src/motion.rs). */
export type Stab = { mode: "horizon" | "lock" | "smooth" | "off"; strength: number; rs: boolean };
/** What the stabilisation analysis found (gyro in the file, or the picture). */
export type MotionInfo = { source: string; note: string; readout: number; product: string };
export type Lens = { layout: string; swap: boolean; fov: number; stitch?: Stitch | null; stab?: Stab | null };
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
  lens?: Lens;
  /** Seam calibration of a two-lens 360 file is running. */
  stitching?: boolean;
  words?: Word[];
  lang?: string;
  tState?: JobState;
  tPct?: number;
  tError?: string;
  strip?: string;
  poster?: string;
  /** 0–5 stars. */
  rating?: number;
  /** pick = good take, reject = not used. */
  flag?: "pick" | "reject";
  tags?: string[];
  note?: string;
  /** When it was added to the project (ms). */
  added?: number;
  /** Word times were checked against the waveform. */
  refined?: boolean;
};

/** Picture placement. x/y: offset of the centre as a fraction of the frame; crops are fractions of the source. */
export type Transform = { x: number; y: number; scale: number; rotation: number; crop_l: number; crop_r: number; crop_t: number; crop_b: number; opacity: number };
/** Colour: exposure in stops, contrast/saturation as factors, temperature in Kelvin (6500 = none), LUT = .cube path. */
export type ColorAdj = { exposure: number; contrast: number; saturation: number; temperature: number; lut: string };
/** 360 view keyframe; t = source seconds in the media (so splits and trims keep them in place). In a Plan, t is seconds from the segment start in output time. */
export type ViewKey = { t: number; view: View };

export type Clip = {
  id: string;
  /** Asset id, or GAP for an empty stretch (black and silence). */
  asset: string;
  /** Source in/out in seconds. */
  start: number;
  end: number;
  speed: number;
  volume: number;
  /** Reframe for 360 sources. */
  view?: View;
  viewKeys?: ViewKey[];
  fit?: "fit" | "fill";
  fadeIn?: number;
  fadeOut?: number;
  label?: string;
  transform?: Transform;
  color?: ColorAdj;
  /** Noise reduction on the clip's sound. */
  denoise?: boolean;
  /** Cross-dissolve with the previous clip (seconds, 0 = cut). */
  xin?: number;
  /** The sound was split off to track A1 (the clip itself stays silent). */
  detached?: boolean;
};

/** A clip on track V2/V3, placed at a timeline time over the main track. */
export type Overlay = {
  id: string; asset: string; track: 2 | 3; at: number; start: number; end: number; speed: number; volume: number;
  view?: View; viewKeys?: ViewKey[]; transform?: Transform; color?: ColorAdj; fadeIn?: number; fadeOut?: number;
};

/** Sound on track A1 (sound split from a clip), A2 (music) or A3 (effects). */
export type MusicClip = {
  id: string; asset: string; start: number; end: number; at: number; volume: number; fadeIn: number; fadeOut: number;
  track?: 1 | 2 | 3; denoise?: boolean;
};
export type Marker = { id: string; t: number; label: string; color: string };

export type CaptionStyle = { size: number; color: string; outline: string; position: "bottom" | "middle" | "top"; maxChars: number; font: string };

export type TrackId = "V1" | "V2" | "V3" | "A1" | "A2" | "A3" | "C1";
export type TrackState = { mute?: boolean; hide?: boolean; lock?: boolean; solo?: boolean };

export type Draft = {
  id: string;
  name: string;
  /** Main track V1 (magnetic: clips follow each other). */
  clips: Clip[];
  /** Tracks V2/V3. */
  overlays?: Overlay[];
  /** Tracks A1/A2/A3. */
  music: MusicClip[];
  markers: Marker[];
  captions: boolean;
  captionStyle: CaptionStyle;
  /** Output aspect: 16:9 | 9:16 | 1:1 | 4:5 */
  aspect: string;
  fps: number;
  tracks?: Partial<Record<TrackId, TrackState>>;
  /** In/out range on the timeline (I/O keys), used to export a part. */
  inPoint?: number | null;
  outPoint?: number | null;
  created: number;
  updated: number;
};

export type ChatBlock = Record<string, unknown> & { type: string };
export type ChatMsg = { role: "user" | "assistant"; content: ChatBlock[] | string };

/** Where the visible history was compacted: messages before `at` were summarised. */
export type CompactMark = { at: number; from: number; to: number; time: number };

/** One AI conversation (a session) of a project. */
export type ChatSession = {
  id: string;
  title: string;
  created: number;
  updated: number;
  /** Everything shown in the panel (API message format). */
  messages: ChatMsg[];
  /** API mode after a compaction: what is actually sent (summary + recent turns). Absent = `messages`. */
  context?: ChatMsg[];
  /** Claude Code conversation id ("Claude 계정" mode), resumed on the next message. */
  ccSession?: string;
  /** Summary + recent turns to open a fresh Claude Code conversation with (after a compaction). */
  seed?: string;
  /** Which connection this conversation uses. */
  chatMode?: "account" | "api";
  /** Model of the last request (sets the context limit). */
  model?: string;
  /** Context size after the last turn, in tokens. */
  ctxTokens?: number;
  marks?: CompactMark[];
};

export type Project = {
  id: string;
  name: string;
  created: number;
  updated: number;
  assets: Asset[];
  folders: string[];
  drafts: Draft[];
  /** AI conversations, one per session. */
  chats?: ChatSession[];
  activeChat?: string;
  /** Before 2.3: the single conversation (moved into `chats` when the project opens). */
  chat?: ChatMsg[];
  ccSession?: string;
  chatMode?: "account" | "api";
};

export type Settings = {
  /** account = Claude plan through Claude Code (default), api = API key, billed per token */
  aiMode: "account" | "api";
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** whisper | qwen */
  engine: string;
  whisperModel: string;
  lang: string;
  exportDir: string;
  autoTranscribe: boolean;
  /** Export presets saved by the user. */
  exportPresets?: SavedExport[];
  /** Context limits in tokens (Haiku models / all others) and the compaction rule in percent. */
  ctxHaiku?: number;
  ctxOther?: number;
  compactAt?: number;
  compactTo?: number;
};

export type SavedExport = { id: string; label: string; choice: Record<string, unknown> };

/** An AI request kept for reuse (app store "prompts", shared by every project). */
export type SavedPrompt = { id: string; name: string; text: string; created: number; updated: number };

export type ShrinkSettings = { codec: string; crf: number; speed: number; fps: string; res: string; denoise: number; acodec: string; abr: number; container: string; screen: boolean; vfr: boolean };

export type Seg = {
  path: string; kind: string; start: number; dur: number; speed: number; volume: number; has_audio: boolean;
  lens: Lens | null; view: View | null; fit: string; fade_in: number; fade_out: number;
  transform?: Transform | null; color?: ColorAdj | null; denoise?: boolean; view_keys?: ViewKey[]; xin?: number;
};
export type PlanOverlay = {
  path: string; kind: string; start: number; dur: number; speed: number; at: number; track: number; volume: number; has_audio: boolean;
  lens: Lens | null; view: View | null; view_keys: ViewKey[]; transform: Transform | null; color: ColorAdj | null; fade_in: number; fade_out: number;
};
export type PlanMusic = { path: string; start: number; dur: number; at: number; volume: number; fade_in: number; fade_out: number; denoise?: boolean };
export type Plan = {
  segs: Seg[]; music: PlanMusic[]; overlays?: PlanOverlay[]; width: number; height: number; fps: number; ass: string;
  mode: "standard" | "shrink" | "audio"; vbitrate: number; settings: ShrinkSettings | null; out: string;
  loudnorm?: boolean; duck?: boolean; abr?: number;
};

export type JobEvent = { id: string; kind: string; pct: number; state: JobState; message: string; result: any };
