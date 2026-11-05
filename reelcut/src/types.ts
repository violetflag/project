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

/** A description of what is on screen from `t` seconds of the file. */
export type SceneNote = { t: number; text: string };
export type BadShot = { from: number; to: number; kind: "blurry" | "shaky" | "dark" };

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
  /** Seconds after the start of the reference recording that this one starts (found from the sound). */
  syncOffset?: number;
  /** The recording it was lined up with. */
  syncTo?: string;
  /** What happens in the picture, for finding moments (written by the AI from what it sees). */
  scenes?: SceneNote[];
  /** Weak stretches found by the shot scan. */
  badShots?: BadShot[];
};

/** Picture placement. x/y: offset of the centre as a fraction of the frame; crops are fractions of the source. */
export type Transform = { x: number; y: number; scale: number; rotation: number; crop_l: number; crop_r: number; crop_t: number; crop_b: number; opacity: number };
/** Colour: exposure in stops, contrast/saturation as factors, temperature in Kelvin (6500 = none), LUT = .cube path. */
export type ColorAdj = {
  exposure: number; contrast: number; saturation: number; temperature: number; lut: string;
  /** Green (−) to magenta (+), and the bright/dark parts, −1…1. */
  tint?: number; highlights?: number; shadows?: number;
  /** Saturation that spares what is already colourful, −1…1. */
  vibrance?: number;
  /** Darker corners, 0…1. */
  vignette?: number;
};
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
  /** People this clip follows, with their head positions (source time, panorama sheet). */
  subjects?: { name: string; marks: { t: number; x: number; y: number }[] }[];
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
  /** Switched off: stays on the timeline but is black and silent. */
  disabled?: boolean;
  /** The look of that dissolve (see TRANSITIONS). */
  xtype?: string;
  /** Moves over the clip: zoom, pan, picture fade. */
  anim?: AnimKey[];
  volKeys?: VolKey[];
  /** The sound was split off to track A1 (the clip itself stays silent). */
  detached?: boolean;
  /** Stabilisation for this clip only (else the media's setting). */
  stab?: Stab;
  /** The 360 view preset last applied (최적/확대/광각/초광각/작은 행성). */
  viewPreset?: ViewPreset;
  /** When the user last set these by hand (ms); the AI leaves them unless asked. */
  userSet?: UserSet;
};

/** A clip on track V2/V3, placed at a timeline time over the main track. */
export type Overlay = {
  id: string; asset: string; track: 2 | 3; at: number; start: number; end: number; speed: number; volume: number;
  anim?: AnimKey[]; volKeys?: VolKey[]; disabled?: boolean;
  view?: View; viewKeys?: ViewKey[]; transform?: Transform; color?: ColorAdj; fadeIn?: number; fadeOut?: number;
};

/** Sound on track A1 (sound split from a clip), A2 (music) or A3 (effects). */
export type MusicClip = {
  id: string; asset: string; start: number; end: number; at: number; volume: number; fadeIn: number; fadeOut: number;
  volKeys?: VolKey[]; disabled?: boolean;
  track?: 1 | 2 | 3; denoise?: boolean;
};
export type Marker = { id: string; t: number; label: string; color: string };

/** Size, place and opacity of a picture at source second `t`. */
export type AnimKey = { t: number; scale: number; x: number; y: number; opacity: number };
/** Loudness factor at source second `t`. */
export type VolKey = { t: number; v: number };

export type CaptionStyle = {
  size: number; color: string; outline: string; position: "bottom" | "middle" | "top"; maxChars: number; font: string;
  /** Black box behind the words instead of an outline. */
  box?: boolean;
  /** Colour of the word being spoken ("" = no highlight). */
  highlight?: string;
  /** The spoken word also grows a little. */
  pop?: boolean;
  bold?: boolean;
  /** Colour behind the words when `box` is on. */
  boxColor?: string;
  /** A block of colour behind the spoken word. */
  markColor?: string;
  /** A word picked out on its own, in `keyColor`. */
  keyword?: "none" | "first" | "last" | "number" | "longest";
  keyColor?: string;
  /** How a line (or each word) comes on screen; "type" shows words as they are spoken. */
  anim?: "none" | "fade" | "rise" | "drop" | "pop" | "type";
  animBy?: "line" | "word";
  /** Rows per line, and where lines end: natural places, by length, or at the end of sentences. */
  lines?: 1 | 2;
  breakBy?: "smart" | "chars" | "sentence";
  align?: "left" | "center" | "right";
  italic?: boolean;
  spacing?: number;
  glow?: boolean;
};

/** Caption changes of one draft, against the spoken words ("asset:word number"). */
export type CapEdits = {
  words?: Record<string, string>;
  /** Before this word: always a new line, or never. */
  breaks?: Record<string, "break" | "join">;
  /** A whole line's own text, by its first word. */
  lineText?: Record<string, string>;
  hidden?: string[];
};
/** A translation of the captions; each item runs from one spoken word to another. */
export type Translation = { lang: string; items: { from: string; to: string; text: string }[] };

export type TextKind = "title" | "subtitle" | "lower" | "pin" | "sticker";
/** A title, place/date pin or sticker on screen from `at` for `dur` seconds (x, y: fractions of the frame; size: % of its height). */
export type TextItem = { id: string; kind: TextKind; at: number; dur: number; text: string; sticker?: string; x?: number; y?: number; size?: number; color?: string; fade?: number };

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
  capEdits?: CapEdits;
  translation?: Translation;
  /** What the captions show when there is a translation. */
  capShow?: "orig" | "tr" | "both";
  /** Titles, pins and stickers. */
  texts?: TextItem[];
  /** Output aspect: 16:9 | 9:16 | 1:1 | 4:5 */
  aspect: string;
  fps: number;
  tracks?: Partial<Record<TrackId, TrackState>>;
  /** Whole-draft effects: even loudness on export. */
  fx?: DraftFx;
  /** In/out range on the timeline (I/O keys), used to export a part. */
  inPoint?: number | null;
  outPoint?: number | null;
  created: number;
  updated: number;
};

/** A guide the AI reads before a kind of job. */
export type Skill = {
  name: string; description: string; triggers?: string[]; body: string;
  /** A merged skill: these skills, done one after another. */
  steps?: ChainStep[];
};
export type ChainStep = { skill: string; label?: string };
/** A merged skill being run, or the last one run, in a conversation. */
export type ChainRun = { name: string; request?: string; steps: { label: string; state: "wait" | "run" | "done" | "fail" | "skip"; note?: string }[] };
/** A choice the AI offers: pressing it sends `prompt` (or the label) as the next request. */
export type ChoiceCard = { id: string; question: string; options: { label: string; detail?: string; meaning?: string; prompt?: string }[]; at: number; used?: boolean; multi?: boolean; recommended?: boolean };

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
  /** Choices the AI has put to the user in this conversation. */
  cards?: ChoiceCard[];
  /** Which connection this conversation uses. */
  chatMode?: "account" | "api";
  /** Model of the last request (sets the context limit). */
  model?: string;
  /** Put away by the user; kept, and listed under 보관함. */
  archived?: boolean;
  /** Skills in force, in the order they were picked; a later one wins over an earlier one. */
  activeSkills?: string[];
  /** Those whose text the AI has already been given (given again after a compaction). */
  skillsSent?: string[];
  /** The last action-log entry (seq) the AI has been told about in this conversation. */
  actionsSeen?: number;
  chain?: ChainRun;
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
  /** What the AI should always keep in mind (added to its instructions), e.g. "our children are twins". */
  aiNotes?: string;
  /** The export dialog's last choices, which AI exports follow too. */
  lastExport?: { loudnorm?: boolean; duck?: boolean; quality?: string; preset?: string; mode?: string; codec?: string; container?: string; srt?: boolean };
  /** Shortcut changes: command id → keys ("" = none). */
  keys?: Record<string, string>;
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
  anim?: { t: number; scale: number; x: number; y: number; opacity: number }[]; vol_keys?: { t: number; v: number }[]; xtype?: string;
  path: string; kind: string; start: number; dur: number; speed: number; volume: number; has_audio: boolean;
  lens: Lens | null; view: View | null; fit: string; fade_in: number; fade_out: number;
  transform?: Transform | null; color?: ColorAdj | null; denoise?: boolean; view_keys?: ViewKey[]; xin?: number;
};
export type PlanOverlay = {
  anim?: { t: number; scale: number; x: number; y: number; opacity: number }[]; vol_keys?: { t: number; v: number }[];
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

// ---------------------------------------------------------------- 2.18: action log (what was done, by whom)

export type ViewPreset = "best" | "zoom" | "wide" | "ultra" | "planet";
export type UserSet = { view?: number; stab?: number; volume?: number };
export type DraftFx = { loudnorm?: boolean; lufs?: number };
export type ActionWho = "user" | "ai" | "system";
export type ActionKind = "quick" | "edit" | "ai" | "export" | "open" | "save" | "backup" | "trash" | "restore" | "undo" | "redo";
/** One line of the project's action log (src/actionlog.ts). */
export type ActionEntry = {
  /** Local time with offset, and the same as ms. */
  t: string; ms: number;
  /** Goes up by one per entry in a project; a coalesced edit keeps its seq. */
  seq: number;
  who: ActionWho; kind: ActionKind; label: string;
  draft?: string | null; clips?: string[]; assets?: string[];
  params?: Record<string, unknown> | null;
  detail?: string;
  /** AI request, conversation and tool that did it. */
  run?: string | null; chat?: string | null; tool?: string | null;
  took?: number; ok: boolean;
  /** undo/redo: the entry it undid or redid. */
  ref?: number;
  /** The undo-step name this entry made (matches Ctrl+Z's label). */
  step?: string;
};
