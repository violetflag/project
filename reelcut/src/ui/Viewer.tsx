// Preview player. Draft mode plays the clips of the open draft one after another on their
// proxies; source mode plays one media file with in/out marks. 360 media is drawn as a flat
// view with WebGL (same math as the export).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fileSrc } from "../api";
import { captionLines } from "../captions";
import { clipAt, clipDur, DEFAULT_VIEW, draftDuration, draftWords, fmtTC, insertClips, is360, newClip, starts, updateClip } from "../edit";
import { Flat360 } from "../gl360";
import { asset, assetMap, draft, editDraft, set, st, toast, useStore } from "../store";
import type { Asset, Clip, View } from "../types";

function mediaUrl(a: Asset): string | null {
  if (a.info.kind === "image") return fileSrc(a.info.path);
  if (a.proxy) return fileSrc(a.proxy);
  if (is360(a)) return null;
  return fileSrc(a.info.path);
}

class Player {
  video: HTMLVideoElement | null = null;
  img: HTMLImageElement | null = null;
  music: HTMLAudioElement | null = null;
  gl: Flat360 | null = null;
  playing = false;
  raf = 0;
  last = 0;
  clipId: string | null = null;
  url = "";
  musicId: string | null = null;
  /** Source mode time and marks. */
  srcT = 0;
  markIn = 0;
  markOut = 0;
  srcView: View = { ...DEFAULT_VIEW };
  drag: View | null = null;
  lastPaint = 0;

  attach(v: HTMLVideoElement, img: HTMLImageElement, music: HTMLAudioElement, canvas: HTMLCanvasElement) {
    this.video = v; this.img = img; this.music = music;
    try { this.gl = new Flat360(canvas); } catch { this.gl = null; }
    cancelAnimationFrame(this.raf);
    const loop = (ts: number) => { this.frame(ts); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  detach() { cancelAnimationFrame(this.raf); this.pause(); this.video = null; }

  currentAsset(): Asset | null {
    if (st.sourceId) return asset(st.sourceId);
    const d = draft();
    const hit = d && d.clips.length ? clipAt(d, st.playhead) : null;
    return hit ? asset(hit.clip.asset) : null;
  }
  currentView(): View {
    if (this.drag) return this.drag;
    if (st.sourceId) return this.srcView;
    const d = draft();
    const hit = d && d.clips.length ? clipAt(d, st.playhead) : null;
    return hit?.clip.view ?? DEFAULT_VIEW;
  }

  private load(a: Asset, t: number, rate = 1, vol = 1) {
    const v = this.video!;
    const url = mediaUrl(a);
    if (a.info.kind === "image") { this.url = url ?? ""; this.img!.src = url ?? ""; v.pause(); return; }
    if (!url) { v.removeAttribute("src"); this.url = ""; return; }
    v.playbackRate = rate;
    v.volume = Math.min(1, Math.max(0, vol));
    v.muted = vol <= 0;
    if (this.url !== url) {
      this.url = url;
      v.src = url;
      const go = () => { v.currentTime = t; if (this.playing) v.play().catch(() => {}); v.removeEventListener("loadedmetadata", go); };
      v.addEventListener("loadedmetadata", go);
    } else {
      if (Math.abs(v.currentTime - t) > 0.04) v.currentTime = t;
      if (this.playing && v.paused) v.play().catch(() => {});
    }
  }

  private loadClip(c: Clip, src: number) {
    const a = asset(c.asset);
    if (!a) return;
    this.clipId = c.id;
    this.load(a, src, c.speed, c.volume);
  }

  toggle() { this.playing ? this.pause() : this.play(); }
  play() {
    if (st.sourceId) {
      const a = asset(st.sourceId);
      if (!a || !this.video) return;
      this.playing = true;
      if (a.info.kind !== "image") this.video.play().catch(() => {});
      set({});
      return;
    }
    const d = draft();
    if (!d || !d.clips.length) return;
    if (st.playhead >= draftDuration(d) - 0.05) set({ playhead: 0 });
    this.playing = true;
    const hit = clipAt(d, st.playhead)!;
    this.clipId = null;
    this.loadClip(hit.clip, hit.src);
    this.last = performance.now();
    set({});
  }
  pause() {
    this.playing = false;
    this.video?.pause();
    this.music?.pause();
    set({});
  }
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
  }
  /** Re-sync after the draft changed under the playhead. */
  refresh() {
    const d = draft();
    if (!d || st.sourceId) return;
    const hit = d.clips.length ? clipAt(d, Math.min(st.playhead, draftDuration(d))) : null;
    if (hit) this.loadClip(hit.clip, hit.src);
  }

  private frame(ts: number) {
    const v = this.video;
    if (!v) return;
    const a = this.currentAsset();
    if (st.sourceId) {
      if (a && a.info.kind !== "image") {
        this.srcT = v.currentTime;
        if (this.playing && v.ended) this.pause();
      }
      if (ts - this.lastPaint > 66) { this.lastPaint = ts; set({}); }
    } else if (this.playing) {
      const d = draft();
      if (!d || !d.clips.length) { this.pause(); return; }
      const hit = clipAt(d, st.playhead)!;
      const c = hit.clip;
      const ca = asset(c.asset);
      let t = st.playhead;
      if (this.clipId !== c.id) this.loadClip(c, hit.src);
      if (ca?.info.kind === "image" || !this.url) {
        t += (ts - this.last) / 1000;
      } else {
        t = hit.at + (v.currentTime - c.start) / c.speed;
      }
      this.last = ts;
      const end = hit.at + clipDur(c);
      if (t >= end - 0.015 || (ca?.info.kind !== "image" && v.ended)) {
        const i = hit.index + 1;
        if (i >= d.clips.length) { set({ playhead: draftDuration(d) }); this.pause(); return; }
        const st0 = starts(d)[i];
        set({ playhead: st0 + 0.0005 });
        this.loadClip(d.clips[i], d.clips[i].start);
      } else if (Math.abs(t - st.playhead) > 0.03 || ts - this.lastPaint > 50) {
        this.lastPaint = ts;
        set({ playhead: Math.max(hit.at, t) });
      }
      this.syncMusic(d.music, st.playhead);
    }
    if (a && is360(a) && this.gl && v.readyState >= 2) this.gl.draw(v, this.currentView());
  }

  private syncMusic(music: { id: string; asset: string; start: number; end: number; at: number; volume: number }[], t: number) {
    const m = music.find((x) => t >= x.at && t < x.at + (x.end - x.start));
    const el = this.music!;
    if (!m) { if (!el.paused) el.pause(); this.musicId = null; return; }
    const a = asset(m.asset);
    if (!a) return;
    const want = m.start + (t - m.at);
    if (this.musicId !== m.id) {
      this.musicId = m.id;
      el.src = mediaUrl(a) ?? "";
      el.currentTime = want;
    } else if (Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
    el.volume = Math.min(1, m.volume);
    if (el.paused && this.playing) el.play().catch(() => {});
  }
}

export const player = new Player();

export function Viewer() {
  const s = useStore();
  const vref = useRef<HTMLVideoElement>(null);
  const iref = useRef<HTMLImageElement>(null);
  const mref = useRef<HTMLAudioElement>(null);
  const cref = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; v: View } | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    player.attach(vref.current!, iref.current!, mref.current!, cref.current!);
    return () => player.detach();
  }, []);

  const d = draft();
  const src = s.sourceId ? asset(s.sourceId) : null;

  // Load whatever is under the playhead when the mode, draft or proxy changes.
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

  // The draft changed (an edit, undo, the agent): keep the playhead inside it and show the frame under it.
  useEffect(() => {
    if (!d || src || player.playing) return;
    const total = draftDuration(d);
    if (st.playhead > total) set({ playhead: total });
    player.refresh();
  }, [d?.updated]);

  const lines = useMemo(() => (d?.captions ? captionLines(draftWords(d, assetMap()), d.captionStyle.maxChars) : []), [d?.updated, d?.captions, s.project?.assets]);
  const line = !src && d?.captions ? lines.find((l) => s.playhead >= l.t0 && s.playhead < l.t1) : null;

  const total = src ? src.info.duration : d ? draftDuration(d) : 0;
  const now = src ? player.srcT : s.playhead;
  const hit = !src && d && d.clips.length ? clipAt(d, s.playhead) : null;
  const shown = src ?? (hit ? asset(hit.clip.asset) : null);
  const r360 = !!shown && is360(shown);
  const isImg = shown?.info.kind === "image";
  const fit = hit?.clip.fit ?? "fit";
  const aspect = src ? (r360 ? "16 / 9" : src.info.width && src.info.height ? `${src.info.width} / ${src.info.height}` : "16 / 9") : (d?.aspect ?? "16:9").replace(":", " / ");
  const waiting = shown && !mediaUrl(shown);

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
    if (hit) editDraft("시점 바꾸기", (dd) => updateClip(dd, hit.clip.id, { view: v }));
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

  const addToDraft = () => {
    if (!src || !d) return;
    const c = newClip(src, player.markIn, Math.max(player.markIn + 0.1, player.markOut));
    if (is360(src)) c.view = { ...player.srcView };
    editDraft(`클립 넣기 "${src.info.name}"`, (x) => insertClips(x, [c]));
    toast(`편집본 끝에 넣었습니다 (${fmtTC(c.end - c.start)})`);
  };

  return (
    <div class="viewer">
      <div class="screen-wrap">
        <div class={`screen ${fit === "fill" ? "fill" : ""}`} style={{ aspectRatio: aspect }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel}>
          <video ref={vref} class={r360 || isImg ? "hidden" : ""} playsInline preload="auto" />
          <img ref={iref} class={isImg ? "" : "hidden"} alt="" />
          <canvas ref={cref} class={r360 ? "" : "hidden"} />
          <audio ref={mref} />
          {waiting && <div class="overlay">미리보기 파일 만드는 중… {Math.round(shown?.proxyPct ?? 0)}%</div>}
          {!shown && <div class="overlay muted">{d && !d.clips.length ? "미디어를 타임라인에 끌어다 놓거나, 미디어를 더블클릭해 구간을 골라 넣으세요." : ""}</div>}
          {line && <div class={`caption ${d!.captionStyle.position}`} style={{ fontSize: `${d!.captionStyle.size * 0.9}cqh`, color: d!.captionStyle.color }}>{line.text}</div>}
          {r360 && <div class="hint360">360° · 끌어서 방향, 휠로 화각 · yaw {Math.round(player.currentView().yaw)}° pitch {Math.round(player.currentView().pitch)}° 화각 {Math.round(player.currentView().hfov)}°</div>}
        </div>
      </div>
      <div class="controls">
        {src ? <span class="badge">원본: {src.info.name}</span> : <span class="badge draft">편집본: {d?.name}</span>}
        <button onClick={() => player.seek(src ? 0 : hit ? (hit.index > 0 ? starts(d!)[hit.index - 1] : 0) : 0)} title="앞 클립">⏮</button>
        <button class="play" onClick={() => player.toggle()}>{player.playing ? "⏸" : "▶"}</button>
        <button onClick={() => { if (!src && d && hit) { const ss = starts(d); player.seek(hit.index + 1 < ss.length ? ss[hit.index + 1] + 0.001 : draftDuration(d)); } }} title="다음 클립">⏭</button>
        <span class="time">{fmtTC(now, true)} / {fmtTC(total, true)}</span>
        {src && (
          <>
            <input class="scrub" type="range" min={0} max={total || 1} step={0.01} value={now} onInput={(e) => player.seek(Number((e.target as HTMLInputElement).value))} />
            <button class="small" onClick={() => { player.markIn = player.srcT; if (player.markOut <= player.markIn) player.markOut = src.info.duration; bump((x) => x + 1); }} title="I">시작 [{fmtTC(player.markIn, true)}]</button>
            <button class="small" onClick={() => { player.markOut = Math.max(player.srcT, player.markIn + 0.1); bump((x) => x + 1); }} title="O">끝 [{fmtTC(player.markOut, true)}]</button>
            <button class="small primary" onClick={addToDraft}>편집본에 넣기</button>
            <button class="small" onClick={() => { player.pause(); set({ sourceId: null }); }}>편집본 보기</button>
          </>
        )}
      </div>
    </div>
  );
}
