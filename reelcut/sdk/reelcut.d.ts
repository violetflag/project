// The Reelcut scripting API. Scripts run in a sandbox: no network and no direct file access; everything
// goes through `reelcut`. All times are seconds. "Source" time is inside a media file; "timeline" time
// is inside a draft. A script's changes are one undo step, and if it throws they are all taken back.

declare namespace Reelcut {
  type Asset = { id: string; name: string; path: string; kind: "video" | "audio" | "image"; duration: number; width: number; height: number; fps: number; is360: boolean; hasAudio: boolean; hasTranscript: boolean; folder: string; recorded?: string };
  type DraftSummary = { id: string; name: string; aspect: string; duration: number; clips: number; open: boolean };
  type View = { yaw: number; pitch: number; roll: number; hfov: number };
  type ViewKey = View & { t: number };
  type Clip = {
    id: string; asset: string; start: number; end: number; speed: number; volume: number;
    /** Where it starts on the timeline, and how long it lasts there. */
    at: number; dur: number;
    disabled?: boolean; xin?: number; xtype?: string; view?: View; viewKeys?: ViewKey[];
    color?: Record<string, number>; transform?: Record<string, number>; fadeIn?: number; fadeOut?: number;
  };
  type Draft = {
    id: string; name: string; aspect: string; fps: number; duration: number; captions: boolean; captionStyle: Record<string, unknown>;
    clips: Clip[]; overlays: Record<string, unknown>[]; music: Record<string, unknown>[]; markers: { id: string; t: number; label: string; color: string }[]; texts: Record<string, unknown>[];
  };
  type NewClip = { assetId: string; start: number; end: number; speed?: number; view?: View };
  /** The same operations as the edit_draft tool, for example { op: "transition", clip_id, seconds, type }. */
  type EditOp = { op: string; [field: string]: unknown };

  type Word = { key: string; text: string; start: number; end: number };
  type TimelineWord = Word & { asset: string; clip: string; t0: number; t1: number };
  type CaptionLine = { key: string; text: string; t0: number; t1: number; hidden: boolean; words: { key: string; text: string; t0: number; t1: number }[] };
  type CaptionOp = { op: "fix_word" | "set_line" | "break_before" | "join_next" | "move_word_prev" | "hide" | "show"; key: string; text?: string };
  type CaptionStyleChange = { enabled?: boolean; style?: string; anim?: string; anim_by?: string; lines?: 1 | 2; break_by?: string; keyword?: string; key_color?: string; highlight?: string; align?: string; size?: number; position?: string; max_chars?: number };

  type Face = { x: number; y: number; w: number; h: number; score: number; front: number };
  type Loudness = { lufs: number; range: number | null; peak: number | null; series: { t: number; db: number }[] };
  type Beats = { bpm: number; confidence: number; beats: number[] };
  type SoundEvent = { from: number; to: number; kind: "silence" | "loud" | "loud_long"; db: number };
  type FileEntry = { name: string; path: string; dir: boolean; size: number };
}

declare const reelcut: {
  project: {
    assets(): Promise<Reelcut.Asset[]>;
    drafts(): Promise<Reelcut.DraftSummary[]>;
  };
  drafts: {
    /** Without an id: the open draft. */
    get(id?: string): Promise<Reelcut.Draft>;
    /** Makes a draft and opens it. */
    create(o: { name: string; aspect?: string; clips: Reelcut.NewClip[] }): Promise<Reelcut.Draft>;
    edit(id: string | undefined, ops: Reelcut.EditOp[]): Promise<Reelcut.Draft>;
    duplicate(id: string | undefined, name: string): Promise<Reelcut.Draft>;
    open(id: string): Promise<void>;
  };
  transcript: {
    /** Words of a file, in source time. */
    words(assetId: string): Promise<Reelcut.Word[]>;
    /** Words of a draft, in timeline time. */
    draftWords(draftId?: string): Promise<Reelcut.TimelineWord[]>;
    search(query: string): Promise<(Reelcut.Word & { asset: string })[]>;
    /** Corrects words in the transcript itself, everywhere they are used. */
    fix(o: { assetId?: string; replace?: { from: string; to: string }[]; words?: { key: string; text: string }[] }): Promise<string>;
  };
  captions: {
    lines(draftId?: string): Promise<Reelcut.CaptionLine[]>;
    edit(draftId: string | undefined, ops: Reelcut.CaptionOp[]): Promise<string>;
    style(draftId: string | undefined, change: Reelcut.CaptionStyleChange): Promise<string>;
    translate(draftId: string | undefined, lang: string, items: { key: string; text: string }[], show?: "orig" | "tr" | "both"): Promise<string>;
  };
  visual: {
    /** Searches the notes saved about scenes. */
    scenes(query: string): Promise<string>;
    badShots(assetId: string, from?: number, to?: number): Promise<string>;
    /** 360 files only, up to 16 times; x and y on the 960×480 panorama. */
    faces(assetId: string, times: number[]): Promise<{ t: number; faces: Reelcut.Face[] }[]>;
    /** Stretches where a head points at the camera (head direction, not eyes). */
    gaze(assetId: string, from: number, to: number, step?: number): Promise<{ from: number; to: number; faces: number }[]>;
  };
  multicam: {
    sync(assetIds: string[]): Promise<string>;
    /** The input of the multicam_draft tool. */
    draft(o: { name?: string; sound_asset_id?: string; end?: number; aspect?: string; cuts: { at: number; asset_id: string }[] }): Promise<string>;
  };
  analysis: {
    loudness(assetId: string, from?: number, to?: number): Promise<Reelcut.Loudness>;
    /** confidence below about 0.2 means there is no steady beat. */
    beats(assetId: string, from?: number, to?: number): Promise<Reelcut.Beats>;
    sceneCuts(assetId: string, from?: number, to?: number, threshold?: number): Promise<{ t: number; score: number }[]>;
    /** By level only; it does not recognise what a sound is. */
    audioEvents(assetId: string, from?: number, to?: number): Promise<Reelcut.SoundEvent[]>;
  };
  files: {
    /** Only folders holding this project's media and the export folder. */
    list(dir: string): Promise<Reelcut.FileEntry[]>;
    /** A text file in those folders, up to 5 MB. */
    readText(path: string): Promise<string>;
    /** Writes a text file by name into the export folder and returns its path. */
    writeText(name: string, text: string): Promise<string>;
  };
  tools: {
    /** Any other AI tool by name; returns its text. Not available here: exporting, deleting, asking the user, saving skills, another script. */
    call(name: string, input?: Record<string, unknown>): Promise<string>;
  };
};
