// Preview player. Draft mode plays the main track's clips one after another on their proxies,
// with V2/V3 pictures on top and the A1–A3 sounds; source mode plays one media file with in/out
// marks. 360 media is drawn as a flat view with WebGL (same math as the export).
import { Grid3x3, Layers, Maximize, Pause, Play, Rewind, FastForward, SkipBack, SkipForward } from "lucide-preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fileSrc } from "../api";
import { captionLines } from "../captions";
import {
  audioTrack, clipAt, clipDur, DEFAULT_VIEW, draftDuration, draftWords, fmtTCF, insertClips, is360, isDefaultColor, isGap, newClip, newOverlay, overlays,
  parseTC, setViewKey, starts, timedDur, trackState, updateClip, viewAt,
} from "../edit";
import { Flat360 } from "../gl360";
import { asset, assetMap, draft, editDraft, set, st, toast, useStore } from "../store";
import type { Asset, Clip, ColorAdj, Draft, Overlay, Transform, View } from "../types";

function mediaUrl(a: Asset): string | null {
  if (a.info.kind === "image") return fileSrc(a.info.path);
  if (a.proxy) return fileSrc(a.proxy);
  if (is360(a)) return null;
  return fileSrc(a.info.path);
}

/** CSS look of a transform and colour (an approximation of the export filters). */
export function cssLook(t?: Transform | null, c?: ColorAdj | null): { transform: string; clipPath: string; filter: string; opacity: string } {
  const tr = t ? `translate(${t.x * 100}%, ${t.y * 100}%) rotate(${t.rotation}deg) scale(${t.scale})` : "";
  const clip = t && (t.crop_l || t.crop_r || t.crop_t || t.crop_b) ? `inset(${t.crop_t * 100}% ${t.crop_r * 100}% ${t.crop_b * 100}% ${t.crop_l * 100}%)` : "";
  let f = "";
  if (c && !isDefaultColor(c)) {
    f = `brightness(${Math.pow(2, c.exposure * 0.5).toFixed(3)}) contrast(${c.contrast}) saturate(${c.saturation})`;
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

  attach(v: HTMLVideoElement, img: HTMLImageElement, canvas: HTMLCanvasElement, ov: NonNullable<Player["ov"]>) {
    this.video = v; this.img = img; this.ov = ov;
    try { this.gl = new Flat360(canvas); } catch { this.gl = null; }
    cancelAnimationFrame(this.raf);
    const loop = (ts: number) => { this.frame(ts); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  detach() { cancelAnimationFrame(this.raf); this.pause(); this.video = null; this.stopSounds(); }

  fps() { return st.sourceId ? asset(st.sourceId)?.info.fps || 30 : draft()?.fps || 30; }
  now() { return st.sourceId ? this.srcT : st.playhead; }

  currentAsset(): Asset | null {
    if (st.sourceId) return asset(st.sourceId);
    const d = draft();
    const hit = d && d.clips.length ? clipAt(d, st.playhead) : null;
    return hit && !isGap(hit.clip) && !trackState(d!, "V1").hide ? asset(hit.clip.asset) : null;
  }
  currentView(): View {
    if (this.drag) return this.drag;
    if (st.sourceId) return this.srcView;
    const d = draft();
    const hit = d && d.clips.length ? clipAt(d, st.playhead) : null;
    if (!hit) return DEFAULT_VIEW;
    return viewAt(hit.clip.view, hit.clip.viewKeys, hit.src);
  }

  private load(a: Asset, t: number, rate = 1, vol = 1) {
    const v = this.video!;
    const url = mediaUrl(a);
    if (a.info.kind === "image") { this.url = url ?? ""; this.img!.src = url ?? ""; v.pause(); return; }
    if (!url) { v.removeAttribute("src"); this.url = ""; return; }
    v.playbackRate = Math.min(16, rate * Math.max(1, this.rate));
    v.volume = Math.min(1, Math.max(0, vol));
    v.muted = vol <= 0 || this.rate > 2;
    if (this.url !== url) {
      this.url = url;
      v.src = url;
      const go = () => { v.currentTime = t; if (this.playing && this.rate > 0) v.play().catch(() => {}); v.removeEventListener("loadedmetadata", go); };
      v.addEventListener("loadedmetadata", go);
    } else {
      if (Math.abs(v.currentTime - t) > 0.04) v.currentTime = t;
      if (this.playing && this.rate > 0 && v.paused) v.play().catch(() => {});
    }
  }

  private loadClip(c: Clip, src: number) {
    const d = draft();
    this.clipId = c.id;
    if (isGap(c) || (d && trackState(d, "V1").hide)) { this.video?.pause(); this.video?.removeAttribute("src"); this.url = ""; if (this.img) this.img.src = ""; return; }
    const a = asset(c.asset);
    if (!a) return;
    const muted = c.detached || (d && trackState(d, "A1").mute);
    this.load(a, src, c.speed, muted ? 0 : c.volume);
  }

  toggle() { this.playing ? this.pause() : (this.rate = 1, this.play()); }
  play() {
    if (st.sourceId) {
      const a = asset(st.sourceId);
      if (!a || !this.video) return;
      this.playing = true;
      if (a.info.kind !== "image" && this.rate > 0) { this.video.playbackRate = this.rate; this.video.play().catch(() => {}); }
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
      if (a.info.kind !== "image") this.video.currentTime = this.srcT;
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
          if (ts - this.lastRev > 60) { this.lastRev = ts; this.srcT = Math.max(0, this.srcT + (this.rate * 0.06)); v.currentTime = this.srcT; if (this.srcT <= 0) this.pause(); }
        } else this.srcT = v.currentTime;
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
      const ca = isGap(c) ? null : asset(c.asset);
      let t = st.playhead;
      if (this.clipId !== c.id) this.loadClip(c, hit.src);
      if (!ca || ca.info.kind === "image" || !this.url) {
        t += ((ts - this.last) / 1000) * Math.abs(this.rate);
      } else {
        t = hit.at + (v.currentTime - c.start) / c.speed;
      }
      this.last = ts;
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
    if (a && is360(a) && this.gl && v.readyState >= 2) this.gl.draw(v, this.currentView());
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
      const o = hidden ? null : overlays(d).find((x) => x.track === tr && t >= x.at && t < x.at + timedDur(x)) ?? null;
      const a = o ? asset(o.asset) : null;
      const url = a && a.info.kind !== "audio" && !is360(a) ? mediaUrl(a) : null;
      if (!o || !a || !url) {
        if (el.id) { el.v.pause(); el.v.style.display = "none"; el.i.style.display = "none"; el.id = null; }
        continue;
      }
      const look = cssLook(o.transform, o.color);
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
      if (trackState(d, k).mute || (solo.length && !solo.includes(k))) return false;
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
      el.volume = Math.min(1, m.volume);
      el.playbackRate = Math.max(1, this.rate);
      if (el.paused) el.play().catch(() => {});
    }
  }
  private stopSounds() { for (const el of this.sounds.values()) el.pause(); this.sounds.clear(); }
}

export const player = new Player();

function Scrub({ total, now, marks, onSeek }: { total: number; now: number; marks?: { in?: number | null; out?: number | null; markers?: { t: number; color: string }[] }; onSeek: (t: number) => void }) {
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
  const cref = useRef<HTMLCanvasElement>(null);
  const o2v = useRef<HTMLVideoElement>(null), o2i = useRef<HTMLImageElement>(null), o3v = useRef<HTMLVideoElement>(null), o3i = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; v: View } | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    player.attach(vref.current!, iref.current!, cref.current!, {
      2: { v: o2v.current!, i: o2i.current!, id: null, url: "" },
      3: { v: o3v.current!, i: o3i.current!, id: null, url: "" },
    });
    const fs = () => { const el = box.current; if (!el) return; document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.().catch(() => {}); };
    window.addEventListener("reelcut:fullscreen", fs);
    return () => { player.detach(); window.removeEventListener("reelcut:fullscreen", fs); };
  }, []);

  const d = draft();
  const src = s.sourceId ? asset(s.sourceId) : null;

  const cur = player.currentAsset();
  useEffect(() => {
    player.pause();
    if (src) {
      player.srcT = 0; player.markIn = 0; player.markOut = src.info.duration; player.srcView = { ...DEFAULT_VIEW };
      player.url = "";
      const url = mediaUrl(src);
      if (src.info.kind === "image") iref.current!.src = url ?? "";
      else if (url) { vref.current!.src = url; player.url = url; }
      else vref.current!.removeAttribute("src");
    } else player.refresh();
    bump((x) => x + 1);
  }, [s.sourceId, s.draftId, cur?.proxy]);

  useEffect(() => {
    if (!d || src || player.playing) return;
    const total = draftDuration(d);
    if (st.playhead > total) set({ playhead: total });
    player.refresh();
  }, [d?.updated]);

  const lines = useMemo(() => (d?.captions ? captionLines(draftWords(d, assetMap()), d.captionStyle.maxChars) : []), [d?.updated, d?.captions, s.project?.assets]);
  const line = !src && d?.captions && !trackState(d, "C1").hide ? lines.find((l) => s.playhead >= l.t0 && s.playhead < l.t1) : null;

  const total = src ? src.info.duration : d ? draftDuration(d) : 0;
  const now = src ? player.srcT : s.playhead;
  const hit = !src && d && d.clips.length ? clipAt(d, s.playhead) : null;
  const hitClip = hit && !isGap(hit.clip) ? hit.clip : null;
  const shown = src ?? (hitClip && !trackState(d!, "V1").hide ? asset(hitClip.asset) : null);
  const r360 = !!shown && is360(shown);
  const isImg = shown?.info.kind === "image";
  const fit = hitClip?.fit ?? "fit";
  const aspect = src ? (r360 ? "16 / 9" : src.info.width && src.info.height ? `${src.info.width} / ${src.info.height}` : "16 / 9") : (d?.aspect ?? "16:9").replace(":", " / ");
  const waiting = shown && !mediaUrl(shown);
  const look = !src && hitClip ? cssLook(r360 ? null : hitClip.transform, hitClip.color) : null;
  const lut = !src && hitClip?.color?.lut;
  const fps = src ? src.info.fps || 30 : d?.fps || 30;
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
    commitView({ ...v, hfov: Math.max(20, Math.min(160, Math.round(v.hfov + e.deltaY * 0.05))) });
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
          <canvas ref={cref} class={r360 ? "" : "hidden"} style={look?.filter ? { filter: look.filter } : undefined} />
          <video ref={o2v} crossOrigin="anonymous" class="ov" playsInline muted preload="auto" style={{ display: "none" }} />
          <img ref={o2i} class="ov" alt="" style={{ display: "none" }} />
          <video ref={o3v} crossOrigin="anonymous" class="ov ov3" playsInline muted preload="auto" style={{ display: "none" }} />
          <img ref={o3i} class="ov ov3" alt="" style={{ display: "none" }} />
          {waiting && <div class="overlay">미리보기 파일 만드는 중… {Math.round(shown?.proxyPct ?? 0)}%</div>}
          {!shown && !hitClip && <div class="overlay muted">{d && !d.clips.length ? "미디어를 타임라인에 끌어다 놓거나, 미디어를 두 번 눌러 구간을 골라 넣으세요." : ""}</div>}
          {line && <div class={`caption ${d!.captionStyle.position}`} style={{ fontSize: `${d!.captionStyle.size * 0.9}cqh`, color: d!.captionStyle.color }}>{line.text}</div>}
          {r360 && <div class="hint360">360° · 끌어서 방향, 휠로 화각 · yaw {Math.round(player.currentView().yaw)}° pitch {Math.round(player.currentView().pitch)}° 화각 {Math.round(player.currentView().hfov)}°{hitClip?.viewKeys?.length ? " · 키프레임" : ""}</div>}
          {(lut || ov360) && <div class="hint-r">{lut ? "LUT·색온도는 내보낸 파일에 정확히 반영됩니다" : "360 V2/V3는 내보낸 파일에서 보입니다"}</div>}
          {hit && hitClip?.xin && Math.abs(s.playhead - hit.at) < (hitClip.xin ?? 0) && <div class="hint-r">디졸브 구간 (미리보기는 컷, 내보내기에 반영)</div>}
          {safe}
        </div>
      </div>
      <Scrub total={total} now={now} onSeek={(t) => player.seek(t)}
        marks={src ? { in: player.markIn, out: player.markOut } : { in: d?.inPoint, out: d?.outPoint, markers: d?.markers }} />
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
