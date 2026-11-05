// Preview player. Draft mode plays the main track's clips one after another straight from their
// files, with V2/V3 pictures on top and the A1–A3 sounds; source mode plays one media file with
// in/out marks. Files the WebView cannot decode (an Osmo .osv, 10-bit HEVC…) play through the live
// preview: ffmpeg streams them from the asked time (an .osv's lenses stitched into a sphere), and
// while paused a single decoded frame stands in. 360 media is drawn as a flat view with WebGL.
import { fovMax } from "../proj";
import { Grid3x3, Layers, Maximize, Pause, Play, Rewind, FastForward, SkipBack, SkipForward, SplitSquareHorizontal } from "lucide-preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, fileSrc } from "../api";
import { draftCaptions } from "../captions";
import { CaptionView } from "./CaptionView";
import {
  animAt, audioTrack, clipAt, clipDur, DEFAULT_TRANSFORM, DEFAULT_VIEW, draftDuration, draftWords, fmtTCF, insertClips, is360, isDefaultColor, isGap, newClip, newOverlay, overlays,
  parseTC, stabFor, transitionLook, xinOf, playableInWebView, previewSource, setViewKey, starts, timedDur, trackState, updateClip, viewAt, volAt,
  lensFor,
} from "../edit";
import { Flat360, type LensShape, type Proj, plainLens } from "../gl360";
import { STICKERS, stickerSvgPath, textLook } from "../graphics";
import { analyzeMotion, asset, assetMap, draft, editDraft, set, st, toast, useStore } from "../store";
import type { Asset, Clip, ColorAdj, Draft, Overlay, Transform, View } from "../types";

/** Files the WebView started but could not decode; they go through the live preview from then on. */
const failed = new Set<string>();
/** Files even the live preview could not open. */
const liveFailed = new Set<string>();
let hevc: boolean | null = null;
function webHevc(): boolean {
  if (hevc == null) {
    try { hevc = document.createElement("video").canPlayType('video/mp4; codecs="hvc1.2.4.L153.B0"') !== ""; } catch { hevc = false; }
  }
  return hevc;
}

/** How the preview shows a file (straight from the file, or the live stream). */
export function srcOf(a: Asset) {
  return previewSource(a, failed.has(a.info.path) || !playableInWebView(a.info, webHevc()));
}

/** A URL the WebView plays itself; null for files that go through the live preview. */
function mediaUrl(a: Asset): string | null {
  if (a.info.kind === "image") return fileSrc(a.info.path);
  const p = srcOf(a);
  return p.live ? null : fileSrc(p.path);
}

/** Width of the blend at the seam, degrees (src-tauri/src/stitch.rs `blend_width`). */
const blendWidth = (fov: number) => Math.max(0.5, Math.min(20, (fov - 180) * 0.5));

function projOf(a: Asset): Proj {
  const p = srcOf(a);
  // A live stitched recording comes as its two lenses; they are joined here, as the export joins them.
  const layout = a.lens?.layout && a.lens.layout !== "none" ? a.lens.layout : a.info.layout360;
  if (p.live && (layout === "dual" || layout === "dfisheye") && a.lens?.stitch?.on !== false) {
    const s = a.lens?.stitch;
    const fov = Math.max(181, Math.min(260, s && s.fov >= 90 ? s.fov : a.lens?.fov ?? 190));
    const shape = (c?: any): LensShape => c ? { fu: c.fx / c.size, fv: c.fy / c.size, cu: (c.cx + 0.5) / c.size, cv: (c.cy + 0.5) / c.size, k: c.k } : plainLens(fov);
    const f = layout === "dual" ? (s?.factory as any[] | undefined) : undefined;
    // The band lined up on each frame (src-tauri/src/pano.rs `Strip`); none for a plain blend.
    const band = s?.seam === "plain" ? 0 : (Math.max(0.5, ((fov - 180) / 2) * 0.7) * Math.PI) / 180;
    return { kind: "lenses", back: shape(f?.[0]), front: shape(f?.[1]), yaw: s?.yaw ?? 0, pitch: s?.pitch ?? 0, roll: s?.roll ?? 0, blend: blendWidth(fov), band, fov, every: Math.max(1, Math.round((a.info.fps || 30) * 0.1)) };
  }
  return p.proj === "dfisheye" ? { kind: "dfisheye", fov: p.fov, swap: p.swap } : { kind: "equirect" };
}

/** Text shown over the viewer for a file that cannot be shown at all. */
export const NO_PREVIEW = "이 파일은 미리보기를 할 수 없습니다. 편집과 내보내기는 그대로 됩니다.";

/** CSS look of a transform and colour (an approximation of the export filters). */
export function cssLook(t?: Transform | null, c?: ColorAdj | null): { transform: string; clipPath: string; filter: string; opacity: string } {
  const tr = t ? `translate(${t.x * 100}%, ${t.y * 100}%) rotate(${t.rotation}deg) scale(${t.flip_h ? -t.scale : t.scale}, ${t.flip_v ? -t.scale : t.scale})` : "";
  const clip = t && (t.crop_l || t.crop_r || t.crop_t || t.crop_b) ? `inset(${t.crop_t * 100}% ${t.crop_r * 100}% ${t.crop_b * 100}% ${t.crop_l * 100}%)` : "";
  let f = "";
  if (c && !isDefaultColor(c)) {
    const lift = 1 + (c.shadows ?? 0) * 0.08 + (c.highlights ?? 0) * 0.05;
    f = `brightness(${(Math.pow(2, c.exposure * 0.5) * lift).toFixed(3)}) contrast(${c.contrast}) saturate(${(c.saturation * (1 + (c.vibrance ?? 0) * 0.4)).toFixed(3)})`;
    if (c.temperature < 6400) f += ` sepia(${Math.min(0.6, (6500 - c.temperature) / 7000).toFixed(3)})`;
    if (c.temperature > 6600) f += ` hue-rotate(${Math.min(20, (c.temperature - 6500) / 300).toFixed(1)}deg) saturate(0.95)`;
  }
  return { transform: tr, clipPath: clip, filter: f, opacity: t ? String(t.opacity) : "" };
}

class Player {
  video: HTMLVideoElement | null = null;
  img: HTMLImageElement | null = null;
  gl: Flat360 | null = null;
  /** V2 and V3 preview elements. */
  ov: Record<2 | 3, { v: HTMLVideoElement; i: HTMLImageElement; id: string | null; url: string }> | null = null;
  /** One audio element per sound item that is playing (A1–A3). */
  sounds = new Map<string, HTMLAudioElement>();
  playing = false;
  /** J/K/L: 1, 2, 4, 8 forward, -1… backward. */
  rate = 1;
  raf = 0;
  last = 0;
  clipId: string | null = null;
  url = "";
  srcT = 0;
  markIn = 0;
  markOut = 0;
  srcView: View = { ...DEFAULT_VIEW };
  drag: View | null = null;
  lastPaint = 0;
  lastRev = 0;
  /** The file the main video element is on. */
  path = "";
  private slowT: any;
  /** Live preview: the stream's time 0 is `base` seconds into the file; `liveKey` = file@speed. */
  base = 0;
  liveKey = "";
  private liveGen = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  /** A decoded still frame stands in for the picture (live files while paused, or until the stream runs). */
  still: HTMLImageElement | null = null;
  stillOn = false;
  private stillGen = 0;
  private stillT: any;
  /** When the stream for the latest play/seek was asked for, and how long its first picture took. */
  private askedAt = 0;
  lastOpenMs = 0;
  private stillAt = 0;
  /** Stabilising turns of 360 files, by file + settings (null = not analysed yet, asked at `at`). */
  private tracks = new Map<string, { fps: number; q: Float32Array | null; at: number }>();
  private analysed = new Set<string>();

  attach(v: HTMLVideoElement, img: HTMLImageElement, still: HTMLImageElement, canvas: HTMLCanvasElement, ov: NonNullable<Player["ov"]>) {
    this.video = v; this.img = img; this.still = still; this.ov = ov;
    this.watchFrames(v);
    try { this.gl = new Flat360(canvas); } catch { this.gl = null; }
    v.onerror = () => this.failed();
    // A codec the WebView lacks (e.g. HEVC without the system extension) can still play its sound.
    v.onloadedmetadata = () => { if (!this.liveKey && this.url && this.currentAsset()?.info.kind === "video" && v.videoWidth === 0) this.failed(); };
    // The stream runs: its picture replaces the still.
    v.ontimeupdate = () => {
      if (this.liveKey && this.stillOn && v.currentTime > 0) {
        this.stillOn = false;
        this.lastOpenMs = Math.round(performance.now() - this.askedAt);
        set({});
      }
    };
    still.onerror = () => { if (still.getAttribute("src")) { liveFailed.add(this.path); set({}); } };
    still.onload = () => set({});
    cancelAnimationFrame(this.raf);
    const loop = (ts: number) => { this.frame(ts); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  detach() { cancelAnimationFrame(this.raf); this.pause(); this.video = null; this.stopSounds(); }

  /** The video element could not play what it was given. */
  private failed() {
    const path = this.path;
    if (!path || !this.url) return;
    if (this.liveKey) { liveFailed.add(path); this.stopLive(); set({}); return; }
    // Not decodable here after all: from now on this file goes through the live preview.
    failed.add(path);
    this.url = "";
    if (st.sourceId) { const a = asset(st.sourceId); if (a) this.show(a, this.srcT); } else this.refresh();
    set({});
  }
  /** Points the main video at a file and gives up on it if nothing plays within a while. */
  private setSrc(url: string, path: string) {
    const v = this.video!;
    this.url = url;
    this.path = path;
    v.src = url;
    clearTimeout(this.slowT);
    this.slowT = setTimeout(() => { if (this.url === url && !this.liveKey && v.readyState < 2) this.failed(); }, 10000);
  }
  /** Where the main video is, in seconds of its file. */
  pos() { return this.base + (this.video?.currentTime ?? 0); }
  /** The time of the frame on screen: the turn for it must not lag the picture (same frame as the export). */
  private shownAt = -1;
  private frameCallbacks = false;
  private drawFrame: (() => void) | null = null;
  private watchFrames(v: HTMLVideoElement) {
    const rv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, m: { mediaTime: number }) => void) => number };
    if (!rv.requestVideoFrameCallback) return;
    this.frameCallbacks = true;
    const each = (_: number, m: { mediaTime: number }) => {
      this.shownAt = m.mediaTime;
      // Drawn here, not on the next screen refresh: by then the video may hold a newer picture than
      // the one this turn belongs to, and a turn one frame off shakes the view.
      this.drawFrame?.();
      rv.requestVideoFrameCallback!(each);
    };
    rv.requestVideoFrameCallback(each);
  }
  /** A live file whose stream has not shown its first picture yet. */
  waitingLive() { return !!this.liveKey && this.stillOn; }

  /** Stops the live stream (paused, or moved to a file the WebView plays); the last picture stays. */
  stopLive() {
    if (!this.liveKey) return;
    this.liveKey = "";
    this.liveGen++;
    this.video?.pause();
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    api.liveStop("main").catch(() => {});
  }

  /**
   * The turn the export applies to this moment, so the preview looks the same way (level and
   * stabilised). Fetched once per file and settings; a recording with a gyro is analysed by itself.
   */
  stabOf(a: Asset, t: number, frame?: number | null): Float32Array | null {
    if (a.info.layout360 !== "dual" && a.info.layout360 !== "dfisheye") return null;
    // The clip's own setting first, as the export does.
    const d0 = st.sourceId ? null : draft();
    const on = d0 && d0.clips.length ? clipAt(d0, st.playhead) : null;
    const stab = on && on.clip.asset === a.id ? stabFor(on.clip, a) : a.lens?.stab ?? null;
    const lens = { ...(a.lens ?? { layout: a.info.layout360, swap: false, fov: 190 }), ...(stab ? { stab } : {}) };
    if (lens.stab?.mode === "off") return null;
    const key = `${a.info.path}|${JSON.stringify(lens.stab ?? null)}|${st.motionRev}`;
    let tr = this.tracks.get(key);
    if (!tr || (!tr.q && performance.now() - tr.at > 15000)) {
      tr = { fps: 30, q: null, at: performance.now() };
      this.tracks.set(key, tr);
      const entry = tr;
      api.motionTrack(a.info.path, { ...lens, layout: a.info.layout360 }).then((r) => {
        if (r) {
          const bin = atob(r.quats);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          entry.fps = r.fps;
          entry.q = new Float32Array(bytes.buffer);
          set({});
        } else if (!this.analysed.has(a.info.path)) {
          this.analysed.add(a.info.path);
          analyzeMotion(a.id);
        }
      }).catch(() => {});
    }
    if (!tr.q) return null;
    const n = tr.q.length / 4;
    const k = Math.max(0, Math.min(n - 1, frame ?? Math.round(t * tr.fps)));
    return tr.q.subarray(k * 4, k * 4 + 4);
  }

  /** One decoded frame of a live file at `t` (asked for a moment after the last move). */
  private showStill(a: Asset, t: number) {
    this.stillOn = true;
    this.stillAt = t;
    this.path = a.info.path;
    clearTimeout(this.stillT);
    const gen = ++this.stillGen;
    this.stillT = setTimeout(async () => {
      try {
        const url = await api.liveUrl({ slot: "main", info: a.info, lens: a.lens ?? null, t, kind: "frame" });
        if (gen === this.stillGen && this.still) this.still.src = url;
      } catch { /* the next move asks again */ }
    }, 50);
  }

  /** A file the WebView cannot play: the stream from `t` while playing forward, else a still. */
  private loadLive(a: Asset, t: number, speed: number) {
    const v = this.video!;
    if (!this.playing || this.rate <= 0) {
      this.stopLive();
      this.showStill(a, t);
      return;
    }
    const key = `${a.info.path}@${speed}`;
    if (this.liveKey === key && Math.abs(this.pos() - t) < 0.35) {
      if (v.paused) v.play().catch(() => {});
      return;
    }
    // Keep showing a picture until the stream's first frame arrives.
    if (!this.stillOn || this.path !== a.info.path) this.showStill(a, t);
    this.liveKey = key;
    this.base = t;
    this.path = a.info.path;
    this.askedAt = performance.now();
    clearTimeout(this.slowT);
    v.pause();
    v.removeAttribute("src");
    v.load();
    this.url = "live";
    const gen = ++this.liveGen;
    api.liveUrl({ slot: "main", info: a.info, lens: a.lens ?? null, t, kind: "stream", rate: speed }).then((url) => {
      if (gen !== this.liveGen || !this.video) return;
      this.url = url;
      this.feed(v, url, a, t, gen);
      v.playbackRate = speed;
      v.play().catch(() => {});
    }).catch(() => { liveFailed.add(a.info.path); set({}); });
  }

  /**
   * Plays a live stream through Media Source Extensions: the stream has no length, and a plain
   * src would end after the first fragment, so the element is told the rest of the file's length.
   */
  private feed(v: HTMLVideoElement, url: string, a: Asset, t: number, gen: number) {
    const ms = new MediaSource();
    v.src = URL.createObjectURL(ms);
    const once = (sb: SourceBuffer) => new Promise((r) => sb.addEventListener("updateend", r, { once: true }));
    ms.addEventListener("sourceopen", async () => {
      try {
        URL.revokeObjectURL(v.src);
        const sb = ms.addSourceBuffer(`video/mp4; codecs="avc1.640028${a.info.has_audio ? ", mp4a.40.2" : ""}"`);
        ms.duration = Math.max(0.5, a.info.duration - t);
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const rd = res.body.getReader();
        this.reader = rd;
        let first = true;
        for (;;) {
          const { done, value } = await rd.read();
          if (done || gen !== this.liveGen) break;
          try { sb.appendBuffer(value); } catch {
            // Full: drop what has already played, then try once more.
            if (v.currentTime > 6) { sb.remove(0, v.currentTime - 4); await once(sb); }
            sb.appendBuffer(value);
          }
          await once(sb);
          // The first picture may sit a few ms after 0 (audio priming); start there.
          if (first && sb.buffered.length && sb.buffered.start(0) > v.currentTime) { v.currentTime = sb.buffered.start(0); first = false; }
          else if (sb.buffered.length) first = false;
        }
        if (gen === this.liveGen && ms.readyState === "open") ms.endOfStream();
      } catch (e) {
        if (gen === this.liveGen) { console.warn("live preview", e); liveFailed.add(a.info.path); this.stopLive(); set({}); }
      }
    }, { once: true });
  }

  fps() { return st.sourceId ? asset(st.sourceId)?.info.fps || 30 : draft()?.fps || 30; }
  now() { return st.sourceId ? this.srcT : st.playhead; }

  currentAsset(): Asset | null {
    if (st.sourceId) return asset(st.sourceId);
    const d = draft();
    const hit = d && d.clips.length ? clipAt(d, st.playhead) : null;
    return hit && !isGap(hit.clip) && !hit.clip.disabled && !trackState(d!, "V1").hide ? asset(hit.clip.asset) : null;
  }
  currentView(): View {
    if (this.drag) return this.drag;
    if (st.sourceId) return this.srcView;
    const d = draft();
    const hit = d && d.clips.length ? clipAt(d, st.playhead) : null;
    if (!hit) return DEFAULT_VIEW;
    return viewAt(hit.clip.view, hit.clip.viewKeys, hit.src);
  }

  /** Volume above 1 (a clip made louder) goes through WebAudio; the element itself stops at 1. */
  private audio: { ctx: AudioContext; gain: GainNode } | null = null;
  private setVolume(v: HTMLVideoElement, vol: number) {
    const x = Math.max(0, vol);
    if (x <= 1 && !this.audio) { v.volume = x; return; }
    try {
      if (!this.audio) {
        const ctx = new AudioContext(), gain = ctx.createGain();
        ctx.createMediaElementSource(v).connect(gain);
        gain.connect(ctx.destination);
        this.audio = { ctx, gain };
      }
      if (this.audio.ctx.state === "suspended") this.audio.ctx.resume().catch(() => {});
      v.volume = 1;
      this.audio.gain.gain.value = x;
    } catch { v.volume = Math.min(1, x); }
  }

  /** Shows file `a` at `t` seconds (playing on if the player plays). */
  show(a: Asset, t: number, rate = 1, vol = 1) {
    const v = this.video!;
    if (a.info.kind === "image") { this.stopLive(); this.stillOn = false; const url = fileSrc(a.info.path); this.url = url; this.img!.src = url; v.pause(); return; }
    const speed = Math.min(16, rate * Math.max(1, this.rate));
    this.setVolume(v, vol);
    v.muted = vol <= 0 || this.rate > 2;
    const url = mediaUrl(a);
    if (!url) { this.loadLive(a, t, speed); return; }
    this.stopLive();
    this.stillOn = false;
    this.base = 0;
    v.playbackRate = speed;
    if (this.url !== url) {
      this.setSrc(url, a.info.path);
      const go = () => { v.currentTime = t; if (this.playing && this.rate > 0) v.play().catch(() => {}); v.removeEventListener("loadedmetadata", go); };
      v.addEventListener("loadedmetadata", go);
    } else {
      if (Math.abs(v.currentTime - t) > 0.04) v.currentTime = t;
      if (this.playing && this.rate > 0 && v.paused) v.play().catch(() => {});
    }
  }

  /** The outgoing picture at a transition, frozen over the incoming clip for the preview. */
  xf: { type?: string; at: number; dur: number } | null = null;
  xfCanvas: HTMLCanvasElement | null = null;
  private snapshot(c: Clip) {
    const d = draft();
    const prevId = this.lastClip;
    this.lastClip = c.id;
    if (!d || !this.playing || !c.xin || !prevId || !this.xfCanvas || !this.video) return;
    const i = d.clips.findIndex((x) => x.id === c.id);
    if (i <= 0 || d.clips[i - 1].id !== prevId) return;
    const cv = this.xfCanvas;
    const src = ([this.still, this.gl?.canvas, this.img, this.video] as (HTMLElement & CanvasImageSource)[]).find((p) => p && !p.classList.contains("hidden")) ?? this.video;
    try {
      const box = cv.parentElement!.getBoundingClientRect();
      cv.width = Math.max(2, Math.round(box.width));
      cv.height = Math.max(2, Math.round(box.height));
      cv.getContext("2d")!.drawImage(src as CanvasImageSource, 0, 0, cv.width, cv.height);
      this.xf = { type: c.xtype, at: starts(d)[i], dur: xinOf(d, i) };
    } catch { this.xf = null; }
  }
  private lastClip: string | null = null;

  private loadClip(c: Clip, src: number) {
    const d = draft();
    this.clipId = c.id;
    this.snapshot(c);
    if (isGap(c) || c.disabled || (d && trackState(d, "V1").hide)) { this.stopLive(); this.stillOn = false; this.video?.pause(); this.video?.removeAttribute("src"); this.url = ""; if (this.img) this.img.src = ""; return; }
    const a = asset(c.asset);
    if (!a) return;
    const muted = c.detached || (d && trackState(d, "A1").mute);
    this.show(a, src, c.speed, muted ? 0 : c.volume);
  }

  toggle() { this.playing ? this.pause() : (this.rate = 1, this.play()); }
  play() {
    if (st.sourceId) {
      const a = asset(st.sourceId);
      if (!a || !this.video) return;
      this.playing = true;
      if (a.info.kind !== "image" && this.rate > 0) this.show(a, this.srcT);
      set({});
      return;
    }
    const d = draft();
    if (!d || !d.clips.length) return;
    if (this.rate > 0 && st.playhead >= draftDuration(d) - 0.05) set({ playhead: 0 });
    this.playing = true;
    const hit = clipAt(d, st.playhead)!;
    this.clipId = null;
    if (this.rate > 0) this.loadClip(hit.clip, hit.src);
    else this.video?.pause();
    this.last = performance.now();
    set({});
  }
  pause() {
    this.playing = false;
    this.video?.pause();
    this.stopLive();
    this.stopSounds();
    for (const o of Object.values(this.ov ?? {})) o.v.pause();
    set({});
  }
  /** J (-1), K (0), L (+1): each press doubles the speed in that direction. */
  shuttle(dir: -1 | 0 | 1) {
    if (dir === 0) { this.rate = 1; this.pause(); return; }
    if (!this.playing) this.rate = dir;
    else if (Math.sign(this.rate) !== dir) this.rate = dir;
    else this.rate = Math.max(-8, Math.min(8, this.rate * 2));
    if (this.video) this.video.playbackRate = Math.abs(this.rate);
    this.clipId = null;
    this.play();
  }
  step(frames: number) { this.pause(); this.seek(this.now() + frames / this.fps()); }
  nudge(secs: number) { this.seek(this.now() + secs); }

  seek(t: number) {
    if (st.sourceId) {
      const a = asset(st.sourceId);
      if (!a || !this.video) return;
      this.srcT = Math.max(0, Math.min(a.info.duration, t));
      if (a.info.kind !== "image") this.show(a, this.srcT);
      set({});
      return;
    }
    const d = draft();
    if (!d) return;
    const T = Math.max(0, Math.min(draftDuration(d), t));
    set({ playhead: T });
    const hit = d.clips.length ? clipAt(d, T) : null;
    if (hit && this.video) this.loadClip(hit.clip, hit.src);
    this.syncLayers(d, T, true);
  }
  /** Re-sync after the draft changed under the playhead. */
  refresh() {
    const d = draft();
    if (!d || st.sourceId) return;
    const hit = d.clips.length ? clipAt(d, Math.min(st.playhead, draftDuration(d))) : null;
    if (hit) this.loadClip(hit.clip, hit.src);
    this.syncLayers(d, st.playhead, true);
  }

  private frame(ts: number) {
    const v = this.video;
    if (!v) return;
    const a = this.currentAsset();
    if (st.sourceId) {
      if (a && a.info.kind !== "image") {
        if (this.playing && this.rate < 0) {
          if (ts - this.lastRev > 60) { this.lastRev = ts; this.srcT = Math.max(0, this.srcT + (this.rate * 0.06)); this.show(a, this.srcT); if (this.srcT <= 0) this.pause(); }
        } else if (this.playing && !this.waitingLive()) this.srcT = this.pos();
        if (this.playing && v.ended) this.pause();
      }
      if (ts - this.lastPaint > 66) { this.lastPaint = ts; set({}); }
    } else if (this.playing) {
      const d = draft();
      if (!d || !d.clips.length) { this.pause(); return; }
      if (this.rate < 0) {
        // Backward: step the playhead back on a timer (video elements cannot play in reverse).
        if (ts - this.lastRev > 60) {
          this.lastRev = ts;
          const t = st.playhead + this.rate * 0.06;
          if (t <= 0) { this.seek(0); this.pause(); return; }
          this.seek(t);
        }
        return;
      }
      const hit = clipAt(d, st.playhead)!;
      const c = hit.clip;
      const ca = isGap(c) || c.disabled ? null : asset(c.asset);
      let t = st.playhead;
      if (this.clipId !== c.id) this.loadClip(c, hit.src);
      if (!ca || ca.info.kind === "image" || !this.url) {
        t += ((ts - this.last) / 1000) * Math.abs(this.rate);
      } else if (!this.waitingLive()) {
        t = hit.at + (this.pos() - c.start) / c.speed;
      }
      this.last = ts;
      if (c.volKeys?.length && !c.detached && !trackState(d, "A1").mute) this.setVolume(v, volAt(c.volKeys, hit.src));
      const ss = starts(d);
      const end = hit.index + 1 < d.clips.length ? ss[hit.index + 1] : hit.at + clipDur(c);
      if (t >= end - 0.015 || (ca && ca.info.kind !== "image" && v.ended)) {
        const i = hit.index + 1;
        if (i >= d.clips.length) { set({ playhead: draftDuration(d) }); this.pause(); return; }
        set({ playhead: ss[i] + 0.0005 });
        this.loadClip(d.clips[i], d.clips[i].start);
      } else if (Math.abs(t - st.playhead) > 0.03 || ts - this.lastPaint > 50) {
        this.lastPaint = ts;
        set({ playhead: Math.max(hit.at, t) });
      }
      this.syncLayers(d, st.playhead, false);
    }
    if (a && is360(a) && this.gl) {
      const s = this.still;
      if (this.stillOn) { if (s && s.complete && s.naturalWidth) this.gl.draw(s, this.currentView(), projOf(a), this.stabOf(a, this.stillAt)); }
      else if (v.readyState >= 2) {
        const gl = this.gl;
        if (this.playing && this.rate > 0 && this.frameCallbacks && this.shownAt >= 0) {
          this.drawFrame = () => {
            if (!this.playing || this.stillOn) return;
            const at = this.base + this.shownAt;
            gl.draw(v, this.currentView(), projOf(a), (frame) => {
              (window as any).__stabSync?.push([frame, at, performance.now()]);
              return this.stabOf(a, at, frame);
            });
          };
        } else {
          this.drawFrame = null;
          const at = this.playing && this.shownAt >= 0 ? this.base + this.shownAt : this.pos();
          gl.draw(v, this.currentView(), projOf(a), (frame) => this.stabOf(a, at, frame));
        }
      }
    }
  }

  // ------------------------------------------------------------ V2/V3 and A1–A3

  private syncLayers(d: Draft, t: number, hard: boolean) {
    this.syncOverlays(d, t, hard);
    this.syncSounds(d, t, hard);
  }

  private syncOverlays(d: Draft, t: number, hard: boolean) {
    if (!this.ov) return;
    for (const tr of [2, 3] as const) {
      const el = this.ov[tr];
      const hidden = trackState(d, tr === 3 ? "V3" : "V2").hide;
      const o = hidden ? null : overlays(d).find((x) => x.track === tr && !x.disabled && t >= x.at && t < x.at + timedDur(x)) ?? null;
      const a = o ? asset(o.asset) : null;
      const url = a && a.info.kind !== "audio" && !is360(a) ? mediaUrl(a) : null;
      if (!o || !a || !url) {
        if (el.id) { el.v.pause(); el.v.style.display = "none"; el.i.style.display = "none"; el.id = null; }
        continue;
      }
      const oSrc = o.start + (t - o.at) * (o.speed || 1);
      const look = cssLook(o.anim?.length ? { ...(o.transform ?? DEFAULT_TRANSFORM), ...animAt(o.anim, oSrc) } : o.transform, o.color);
      const target = a.info.kind === "image" ? el.i : el.v;
      const other = a.info.kind === "image" ? el.v : el.i;
      other.style.display = "none";
      target.style.display = "";
      Object.assign(target.style, { transform: look.transform, clipPath: look.clipPath, filter: look.filter, opacity: look.opacity || "1" });
      el.id = o.id;
      if (a.info.kind === "image") { if (el.url !== url) { el.url = url; el.i.src = url; } continue; }
      const want = o.start + (t - o.at) * (o.speed || 1);
      const v = el.v;
      if (el.url !== url) { el.url = url; v.src = url; v.muted = true; }
      v.muted = (o.volume ?? 0) <= 0 || !!trackState(d, tr === 3 ? "V3" : "V2").mute;
      v.volume = Math.min(1, o.volume ?? 0);
      v.playbackRate = (o.speed || 1) * Math.max(1, this.rate);
      if (hard || Math.abs(v.currentTime - want) > 0.3) { try { v.currentTime = want; } catch { /* not loaded yet */ } }
      if (this.playing && this.rate > 0 && v.paused) v.play().catch(() => {});
      if ((!this.playing || this.rate < 0) && !v.paused) v.pause();
    }
  }

  private syncSounds(d: Draft, t: number, hard: boolean) {
    const solo = (["A1", "A2", "A3"] as const).filter((k) => trackState(d, k).solo);
    const active = this.playing && this.rate > 0 ? d.music.filter((m) => {
      const k = `A${audioTrack(m)}` as "A1" | "A2" | "A3";
      if (m.disabled || trackState(d, k).mute || (solo.length && !solo.includes(k))) return false;
      return t >= m.at && t < m.at + (m.end - m.start);
    }) : [];
    for (const [id, el] of this.sounds) if (!active.some((m) => m.id === id)) { el.pause(); this.sounds.delete(id); }
    for (const m of active) {
      const a = asset(m.asset);
      if (!a) continue;
      let el = this.sounds.get(m.id);
      const want = m.start + (t - m.at);
      if (!el) {
        el = new Audio(mediaUrl(a) ?? "");
        el.currentTime = want;
        this.sounds.set(m.id, el);
      } else if (hard || Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
      el.volume = Math.min(1, m.volKeys?.length ? volAt(m.volKeys, want) : m.volume);
      el.playbackRate = Math.max(1, this.rate);
      if (el.paused) el.play().catch(() => {});
    }
  }
  private stopSounds() { for (const el of this.sounds.values()) el.pause(); this.sounds.clear(); }
}

export const player = new Player();

function Scrub({ total, now, marks, onSeek }: { total: number; now: number; marks?: { in?: number | null; out?: number | null; markers?: { t: number; color: string }[]; bad?: { from: number; to: number; kind: string }[] }; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const tOf = (x: number) => { const r = ref.current!.getBoundingClientRect(); return Math.max(0, Math.min(total, ((x - r.left) / r.width) * total)); };
  const pct = (t: number) => `${total ? (t / total) * 100 : 0}%`;
  const down = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    player.pause();
    onSeek(tOf(e.clientX));
  };
  return (
    <div class="scrub" ref={ref} role="slider" aria-label="재생 위치" aria-valuemin={0} aria-valuemax={total} aria-valuenow={now} tabIndex={0}
      onPointerDown={down as any} onPointerMove={(e) => { if ((e as PointerEvent).buttons) onSeek(tOf((e as PointerEvent).clientX)); }}>
      <div class="scrub-track" />
      {marks?.in != null && marks?.out != null && <div class="scrub-range" style={{ left: pct(marks.in), width: `calc(${pct(marks.out)} - ${pct(marks.in)})` }} />}
      {marks?.in != null && marks.out == null && <div class="scrub-range" style={{ left: pct(marks.in), right: 0 }} />}
      {marks?.bad?.map((b) => <div class={`scrub-bad ${b.kind}`} title={{ blurry: "흐림", shaky: "흔들림", dark: "어두움" }[b.kind]} style={{ left: pct(b.from), width: `calc(${pct(b.to)} - ${pct(b.from)})` }} />)}
      {marks?.markers?.map((m) => <span class="scrub-marker" style={{ left: pct(m.t), background: m.color }} />)}
      <div class="scrub-fill" style={{ width: pct(now) }} />
      <div class="scrub-head" style={{ left: pct(now) }} />
    </div>
  );
}

function TC({ value, fps, onJump }: { value: number; fps: number; onJump: (t: number) => void }) {
  const [edit, setEdit] = useState(false);
  if (edit) return (
    <input class="tc-input" autoFocus defaultValue={fmtTCF(value, fps)} aria-label="이동할 시간"
      onKeyDown={(e) => {
        if (e.key === "Enter") { const t = parseTC((e.target as HTMLInputElement).value, fps); if (t != null) onJump(t); setEdit(false); }
        if (e.key === "Escape") setEdit(false);
      }} onBlur={() => setEdit(false)} />
  );
  return <button class="tc" onClick={() => setEdit(true)} title="눌러서 시간 입력 (시:분:초:프레임)">{fmtTCF(value, fps)}</button>;
}

export function Viewer() {
  const s = useStore();
  const box = useRef<HTMLDivElement>(null);
  const vref = useRef<HTMLVideoElement>(null);
  const iref = useRef<HTMLImageElement>(null);
  const sref = useRef<HTMLImageElement>(null);
  const xref = useRef<HTMLCanvasElement>(null);
  const cref = useRef<HTMLCanvasElement>(null);
  const o2v = useRef<HTMLVideoElement>(null), o2i = useRef<HTMLImageElement>(null), o3v = useRef<HTMLVideoElement>(null), o3i = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; v: View } | null>(null);
  const [, bump] = useState(0);
  // 내보내기 미리 확인: this moment as the export draws it, over the preview, with a boundary to drag.
  const [cmp, setCmp] = useState<{ url: string; pct: number; at: number } | null>(null);
  const [cmpBusy, setCmpBusy] = useState(false);

  useEffect(() => {
    player.xfCanvas = xref.current;
    player.attach(vref.current!, iref.current!, sref.current!, cref.current!, {
      2: { v: o2v.current!, i: o2i.current!, id: null, url: "" },
      3: { v: o3v.current!, i: o3i.current!, id: null, url: "" },
    });
    const fs = () => { const el = box.current; if (!el) return; document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.().catch(() => {}); };
    window.addEventListener("reelcut:fullscreen", fs);
    return () => { player.detach(); window.removeEventListener("reelcut:fullscreen", fs); };
  }, []);

  const d = draft();
  const src = s.sourceId ? asset(s.sourceId) : null;

  useEffect(() => {
    player.pause();
    if (src) {
      player.srcT = 0; player.markIn = 0; player.markOut = src.info.duration; player.srcView = { ...DEFAULT_VIEW };
      player.url = "";
      player.show(src, 0);
    } else player.refresh();
    bump((x) => x + 1);
  }, [s.sourceId, s.draftId]);

  useEffect(() => {
    if (!d || src || player.playing) return;
    const total = draftDuration(d);
    if (st.playhead > total) set({ playhead: total });
    player.refresh();
  }, [d?.updated]);

  const caps = useMemo(() => (d?.captions ? draftCaptions(d, draftWords(d, assetMap())) : null), [d?.updated, d?.captions, s.project?.assets]);
  const capOn = !src && d?.captions && !trackState(d, "C1").hide;
  const line = capOn ? caps?.lines.find((l) => !l.hidden && s.playhead >= l.t0 && s.playhead < l.t1) : null;
  const trLine = capOn ? caps?.tr.find((l) => s.playhead >= l.t0 && s.playhead < l.t1) : null;

  const total = src ? src.info.duration : d ? draftDuration(d) : 0;
  const now = src ? player.srcT : s.playhead;
  const hit = !src && d && d.clips.length ? clipAt(d, s.playhead) : null;
  const hitClip = hit && !isGap(hit.clip) && !hit.clip.disabled ? hit.clip : null;
  const xfNow = !src && player.playing && player.xf && s.playhead >= player.xf.at && s.playhead < player.xf.at + player.xf.dur ? player.xf : null;
  const xfLook = xfNow ? transitionLook(xfNow.type, (s.playhead - xfNow.at) / xfNow.dur) : null;
  const shown = src ?? (hitClip && !trackState(d!, "V1").hide ? asset(hitClip.asset) : null);
  const r360 = !!shown && is360(shown);
  const isImg = shown?.info.kind === "image";
  const fit = hitClip?.fit ?? "fit";
  const aspect = src ? (r360 ? "16 / 9" : src.info.width && src.info.height ? `${src.info.width} / ${src.info.height}` : "16 / 9") : (d?.aspect ?? "16:9").replace(":", " / ");
  const shownSrc = shown && shown.info.kind === "video" ? srcOf(shown) : null;
  const noPreview = !!shownSrc && liveFailed.has(shownSrc.path);
  const fish = !!shownSrc && r360 && shownSrc.proj === "dfisheye";
  const liveFlat = !!shownSrc?.live && !r360;
  const opening = !!shownSrc?.live && !noPreview && player.stillOn && !sref.current?.naturalWidth;
  const moving = !src && hit && hitClip?.anim?.length ? animAt(hitClip.anim, hit.src) : null;
  const look = !src && hitClip ? cssLook(moving ? { ...(hitClip.transform ?? DEFAULT_TRANSFORM), ...moving } : r360 ? null : hitClip.transform, hitClip.color) : null;
  const lut = !src && hitClip?.color?.lut;
  const fps = src ? src.info.fps || 30 : d?.fps || 30;
  useEffect(() => {
    if (cmp && (player.playing || src || Math.abs(s.playhead - cmp.at) > 1e-3)) setCmp(null);
  }, [s.playhead, s.draftId, s.sourceId, d?.updated, player.playing]);
  const compare = async () => {
    if (cmp) return setCmp(null);
    if (!hit || !hitClip || !shown) return;
    player.pause();
    setCmpBusy(true);
    try {
      const [w, h] = (d?.aspect ?? "16:9").split(":").map(Number);
      const [b64] = await api.frames(shown.info.path, [hit.src], w >= h ? 1280 : 720, player.currentView(), lensFor(hitClip, shown), w / h || 16 / 9);
      if (b64) setCmp({ url: `data:image/jpeg;base64,${b64}`, pct: 50, at: st.playhead });
    } catch (e) {
      toast(`내보낼 화면을 만들지 못했습니다: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setCmpBusy(false);
    }
  };
  const ov360 = !src && d ? overlays(d).some((o) => s.playhead >= o.at && s.playhead < o.at + timedDur(o) && is360(asset(o.asset) ?? undefined)) : false;

  const onDown = (e: PointerEvent) => {
    if (!r360) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, v: { ...player.currentView() } };
  };
  const onMove = (e: PointerEvent) => {
    const g = dragRef.current;
    if (!g) return;
    const w = (e.currentTarget as HTMLElement).clientWidth;
    const k = g.v.hfov / w;
    let yaw = g.v.yaw - (e.clientX - g.x) * k;
    yaw = ((((yaw + 180) % 360) + 360) % 360) - 180;
    const pitch = Math.max(-90, Math.min(90, g.v.pitch + (e.clientY - g.y) * k));
    player.drag = { ...g.v, yaw: Math.round(yaw * 10) / 10, pitch: Math.round(pitch * 10) / 10 };
  };
  const commitView = (v: View) => {
    if (src) { player.srcView = v; bump((x) => x + 1); return; }
    if (!hit) return;
    // With keyframes, dragging sets the keyframe under the playhead; without, it changes the whole clip.
    if (hit.clip.viewKeys?.length) editDraft("360 키프레임", (dd) => updateClip(dd, hit.clip.id, { viewKeys: setViewKey(hit.clip.viewKeys, hit.src, v) }));
    else editDraft("시점 바꾸기", (dd) => updateClip(dd, hit.clip.id, { view: v }));
  };
  const onUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    const v = player.drag;
    player.drag = null;
    if (v) commitView(v);
  };
  const onWheel = (e: WheelEvent) => {
    if (!r360) return;
    e.preventDefault();
    const v = player.currentView();
    commitView({ ...v, hfov: Math.max(20, Math.min(fovMax(v.dist ?? 0), Math.round(v.hfov + e.deltaY * 0.05))) });
  };

  const srcClip = () => {
    if (!src) return null;
    const c = newClip(src, player.markIn, Math.max(player.markIn + 0.1, player.markOut));
    if (is360(src)) c.view = { ...player.srcView };
    return c;
  };
  const addEnd = () => { const c = srcClip(); if (!c || !d) return; editDraft(`클립 넣기 "${src!.info.name}"`, (x) => insertClips(x, [c])); toast("편집본 끝에 넣었습니다"); };
  const addAtPlayhead = () => {
    const c = srcClip(); if (!c || !d) return;
    const h = d.clips.length ? clipAt(d, st.playhead) : null;
    const i = !h ? 0 : st.playhead - h.at < clipDur(h.clip) / 2 ? h.index : h.index + 1;
    editDraft(`끼워 넣기 "${src!.info.name}"`, (x) => insertClips(x, [c], i));
    toast("편집본 재생 위치에 끼워 넣었습니다");
  };
  const addOverlay = () => {
    if (!src || !d) return;
    const o: Overlay = { ...newOverlay(src, st.playhead, 2, player.markIn, Math.max(player.markIn + 0.1, player.markOut)) };
    editDraft(`V2에 얹기 "${src.info.name}"`, (x) => ({ ...x, overlays: [...(x.overlays ?? []), o] }), st.draftId, false);
    set({ selItem: o.id, selClip: null });
    toast("V2 트랙의 재생 위치에 얹었습니다 (화면 속 화면)");
  };

  const safe = s.showSafe && (
    <div class="safe" aria-hidden="true">
      <div class="safe-action" /><div class="safe-title" />
      <div class="third v1" /><div class="third v2" /><div class="third h1" /><div class="third h2" />
    </div>
  );

  return (
    <div class="viewer" ref={box}>
      <div class="screen-wrap">
        <div class={`screen ${fit === "fill" ? "fill" : ""}`} style={{ aspectRatio: aspect }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel}>
          {/* crossOrigin: media comes from asset.localhost; without CORS WebGL may not read it (360 view). */}
          <video ref={vref} crossOrigin="anonymous" class={r360 || isImg ? "hidden" : ""} playsInline preload="auto" style={look ? { transform: look.transform, clipPath: look.clipPath, filter: look.filter, opacity: look.opacity } : undefined} />
          <img ref={iref} class={isImg ? "" : "hidden"} alt="" style={look ? { transform: look.transform, clipPath: look.clipPath, filter: look.filter, opacity: look.opacity } : undefined} />
          {/* A decoded frame of a live file while paused (360 ones are drawn through the canvas). */}
          <img ref={sref} crossOrigin="anonymous" class={liveFlat && player.stillOn ? "" : "hidden"} alt="" style={look ? { transform: look.transform, clipPath: look.clipPath, filter: look.filter, opacity: look.opacity } : undefined} />
          <canvas ref={cref} class={r360 ? "" : "hidden"} style={look ? { filter: look.filter, transform: moving ? look.transform : undefined, opacity: moving ? look.opacity : undefined } : undefined} />
          <video ref={o2v} crossOrigin="anonymous" class="ov" playsInline muted preload="auto" style={{ display: "none" }} />
          <img ref={o2i} class="ov" alt="" style={{ display: "none" }} />
          <video ref={o3v} crossOrigin="anonymous" class="ov ov3" playsInline muted preload="auto" style={{ display: "none" }} />
          <img ref={o3i} class="ov ov3" alt="" style={{ display: "none" }} />
          {noPreview && <div class="overlay no-preview" role="note">{NO_PREVIEW}</div>}
          {!shown && !hitClip && <div class="overlay muted">{d && !d.clips.length ? "미디어를 타임라인에 끌어다 놓거나, 미디어를 두 번 눌러 구간을 골라 넣으세요." : ""}</div>}
          {d && (line || trLine) && <CaptionView line={line ?? null} tr={trLine ?? null} st={d.captionStyle} show={d.capShow ?? "orig"} t={s.playhead} />}
          {!src && (d?.texts ?? []).filter((t) => s.playhead >= t.at && s.playhead < t.at + t.dur && !trackState(d!, "C1").hide).map((t) => {
            const l = textLook(t);
            const pos = { left: `${l.x * 100}%`, top: `${l.y * 100}%`, transform: l.align === "left" ? "translateY(-50%)" : "translate(-50%, -50%)" };
            if (t.kind === "sticker") {
              const sk = STICKERS[t.sticker ?? "star"] ?? STICKERS.star;
              return <svg class="stk" viewBox="0 0 100 100" style={{ ...pos, transform: "translate(-50%, -50%)", height: `${l.size}cqh`, width: `${l.size}cqh` }} aria-hidden="true"><path d={stickerSvgPath(t.sticker ?? "star")} fill={sk.ring ? "none" : l.color} stroke={sk.ring ? l.color : "#000"} stroke-width={sk.ring ? 7 : 2} /></svg>;
            }
            return (
              <div class={`txt ${l.box ? "boxed" : ""}`} style={{ ...pos, fontSize: `${l.size * 0.9}cqh`, color: l.color, fontWeight: l.bold ? 700 : 400 }}>
                {t.kind === "pin" && <svg viewBox="0 0 100 100" class="pin" aria-hidden="true"><path d={stickerSvgPath("pin")} fill={STICKERS.pin.color} fill-rule="evenodd" /></svg>}
                <span>{t.text}</span>
              </div>
            );
          })}
          {r360 && <div class="hint360">360° · 끌어서 방향, 휠로 화각 · yaw {Math.round(player.currentView().yaw)}° pitch {Math.round(player.currentView().pitch)}° 화각 {Math.round(player.currentView().hfov)}°{hitClip?.viewKeys?.length ? " · 키프레임" : ""}{fish ? " · 미리보기는 이음새 맞춤 전 (내보낸 파일에 적용)" : shownSrc?.live ? " · 원본 실시간 스티칭" : ""}</div>}
          {opening && <div class="hint-r info">원본 여는 중…</div>}
          {(lut || ov360) && <div class="hint-r">{lut ? "LUT·색온도는 내보낸 파일에 정확히 반영됩니다" : "360 V2/V3는 내보낸 파일에서 보입니다"}</div>}
          <canvas ref={xref} class="xf" style={xfLook && !xfLook.hide ? { display: "block", opacity: xfLook.opacity, clipPath: xfLook.clipPath, transform: xfLook.transform, filter: xfLook.filter, WebkitMaskImage: xfLook.mask, maskImage: xfLook.mask } : { display: "none" }} />
          {xfLook?.veil && <div class="xf-veil" style={{ background: xfLook.veil.color, opacity: xfLook.veil.opacity }} />}
          {!player.playing && hit && hitClip?.xin && s.playhead - hit.at < (hitClip.xin ?? 0) && <div class="hint-r info">전환 구간: 재생하면 보입니다</div>}
          {safe}
          {cmp && (
            <>
              <img class="cmp-shot" src={cmp.url} alt="내보낼 화면" style={{ clipPath: `inset(0 0 0 ${cmp.pct}%)` }} />
              <div class="cmp-line" style={{ left: `${cmp.pct}%` }} />
              <span class="cmp-tag l">미리보기</span>
              <span class="cmp-tag r">내보내기</span>
              <input class="cmp-range" type="range" min={0} max={100} value={cmp.pct} aria-label="미리보기와 내보내기의 경계"
                onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}
                onInput={(e) => setCmp({ ...cmp, pct: Number((e.target as HTMLInputElement).value) })} />
            </>
          )}
        </div>
      </div>
      <Scrub total={total} now={now} onSeek={(t) => player.seek(t)}
        marks={src ? { in: player.markIn, out: player.markOut, bad: src.badShots } : { in: d?.inPoint, out: d?.outPoint, markers: d?.markers }} />
      <div class="controls">
        {src ? <span class="badge" title={src.info.path}>원본: {src.info.name}</span> : <span class="badge draft">편집본: {d?.name}</span>}
        <span class="spacer" />
        <button class="icon-btn" onClick={() => { if (src) return player.seek(0); if (d && hit) player.seek(hit.index > 0 ? starts(d)[hit.index - 1] : 0); }} title="앞 클립 (↑)" aria-label="앞 클립"><SkipBack size={16} /></button>
        <button class="icon-btn" onClick={() => player.shuttle(-1)} title="뒤로 재생 (J, 누를수록 빠르게)" aria-label="뒤로 재생"><Rewind size={16} /></button>
        <button class="icon-btn play" onClick={() => player.toggle()} title="재생 / 멈춤 (Space, K)" aria-label={player.playing ? "멈춤" : "재생"}>{player.playing ? <Pause size={18} /> : <Play size={18} />}</button>
        <button class="icon-btn" onClick={() => player.shuttle(1)} title="앞으로 빠르게 (L)" aria-label="빠르게 재생"><FastForward size={16} /></button>
        <button class="icon-btn" onClick={() => { if (!src && d && hit) { const ss = starts(d); player.seek(hit.index + 1 < ss.length ? ss[hit.index + 1] + 0.001 : draftDuration(d)); } }} title="다음 클립 (↓)" aria-label="다음 클립"><SkipForward size={16} /></button>
        {player.playing && player.rate !== 1 && <span class="rate">{player.rate > 0 ? `${player.rate}×` : `◀ ${-player.rate}×`}</span>}
        <span class="time"><TC value={now} fps={fps} onJump={(t) => player.seek(t)} /> <span class="muted">/ {fmtTCF(total, fps)}</span></span>
        <span class="spacer" />
        {!src && r360 && (
          <button class={`icon-btn ${cmp ? "on" : ""}`} disabled={cmpBusy || !hitClip} aria-pressed={!!cmp} onClick={compare} title="내보내기 미리 확인: 이 장면을 내보낼 화면으로 그려 미리보기와 밀어 가며 비교합니다" aria-label="내보내기 미리 확인">
            <SplitSquareHorizontal size={16} class={cmpBusy ? "spin-i" : undefined} aria-hidden="true" />
          </button>
        )}
        <button class={`icon-btn ${s.showSafe ? "on" : ""}`} onClick={() => set({ showSafe: !s.showSafe })} title="안전 영역·3분할 격자 · Safe Margins" aria-label="안전 영역" aria-pressed={s.showSafe}><Grid3x3 size={16} /></button>
        <button class="icon-btn" onClick={() => window.dispatchEvent(new Event("reelcut:fullscreen"))} title="전체 화면 (F)" aria-label="전체 화면"><Maximize size={16} /></button>
      </div>
      {src && (
        <div class="controls src">
          <button class="small" onClick={() => { player.markIn = player.srcT; if (player.markOut <= player.markIn) player.markOut = src.info.duration; bump((x) => x + 1); }} title="인 점 (I)">인 [{fmtTCF(player.markIn, fps)}]</button>
          <button class="small" onClick={() => { player.markOut = Math.max(player.srcT, player.markIn + 0.1); bump((x) => x + 1); }} title="아웃 점 (O)">아웃 [{fmtTCF(player.markOut, fps)}]</button>
          <span class="spacer" />
          <button class="small primary" onClick={addEnd} title="편집본 끝에 붙이기 · Append">끝에 넣기</button>
          <button class="small" onClick={addAtPlayhead} title="편집본 재생 위치에 끼워 넣기 · Insert">재생 위치에 끼워 넣기</button>
          {src.info.kind !== "audio" && <button class="small" onClick={addOverlay} title="V2 트랙에 화면 속 화면으로 얹기 · Overlay / Picture-in-Picture"><Layers size={13} aria-hidden="true" /> V2에 얹기</button>}
          <button class="small" onClick={() => { player.pause(); set({ sourceId: null }); }}>편집본 보기</button>
        </div>
      )}
    </div>
  );
}
