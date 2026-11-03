// Multi-track timeline. V1 is the magnetic main track (clips follow each other); V2/V3 hold
// pictures placed over it, A1 split-off sound, A2 music, A3 effects, C1 shows the captions.
// Tools: select (move/trim), blade (cut where clicked), roll (move a cut), slip (show another part).
import { Captions, Eye, EyeOff, Headphones, Lock, LockOpen, Volume2, VolumeX } from "lucide-preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fileSrc } from "../api";
import { captionLines } from "../captions";
import { doFillers, doSilence, getPacing, setPacing } from "../commands";
import {
  audioTrack, clipDur, deleteClip, detachAudio, draftDuration, draftWords, fmtTCF, insertClips, is360, isGap, liftClip, moveClip, newClip, newOverlay, overlays, PACING,
  r3, rollEdit, setTransition, silenceCuts, slipClip, speechFromWave, speechFromWords, splitAt, splitItem, starts, timedDur, trackState, uid, updateAudio, updateClip, updateOverlay, xinOf, type Pacing,
} from "../edit";
import { asset, assetMap, draft, editDraft, ensureStrip, loadWave, set, st, toast, useStore, waves } from "../store";
import type { Clip, Draft, MusicClip, Overlay, TrackId } from "../types";
import { player } from "./Viewer";

const H: Record<TrackId, number> = { V3: 46, V2: 46, V1: 66, A1: 40, A2: 40, A3: 40, C1: 26 };
const ORDER: TrackId[] = ["V3", "V2", "V1", "A1", "A2", "A3", "C1"];
const NAME: Record<TrackId, string> = { V3: "V3", V2: "V2", V1: "V1 본편", A1: "A1 소리", A2: "A2 음악", A3: "A3 효과음", C1: "C1 자막" };

function Wave({ asset: id, start, end, w, h = 22 }: { asset: string; start: number; end: number; w: number; h?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wave = waves.get(id);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !wave) return;
    const W = Math.max(1, Math.min(4000, Math.round(w)));
    cv.width = W; cv.height = h;
    const g = cv.getContext("2d")!;
    g.clearRect(0, 0, W, h);
    g.fillStyle = "rgba(160,215,255,0.8)";
    const per = (end - start) / W;
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((start + x * per) * 50), i1 = Math.max(i0 + 1, Math.floor((start + (x + 1) * per) * 50));
      let m = 0;
      for (let i = i0; i < i1 && i < wave.length; i++) m = Math.max(m, wave[i]);
      const hh = (m / 255) * h;
      g.fillRect(x, h - hh, 1, hh);
    }
  }, [wave, start, end, w, h]);
  return wave ? <canvas ref={ref} class="wave" style={{ width: `${w}px`, height: `${h}px` }} aria-hidden="true" /> : null;
}

type Drag = {
  kind: "move" | "trimL" | "trimR" | "scrub" | "imove" | "itrimL" | "itrimR" | "roll" | "slip";
  id?: string; x0: number; moved: boolean; clip?: Clip; item?: Overlay | MusicClip; index?: number; to?: number;
};
type Ghost = { id: string; dx: number; to?: number; patch?: Partial<Clip>; ipatch?: Partial<Overlay & MusicClip>; draft?: Draft };

export function Timeline() {
  const s = useStore();
  const d = draft();
  const [zoom, setZoom] = useState(40); // px per second
  const [pacing, setPac] = useState<Pacing>(getPacing());
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; item?: boolean } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  useEffect(() => {
    const z = (e: Event) => {
      const k = (e as CustomEvent).detail;
      if (k === "fit") { const el = scroller.current, dd = draft(); if (el && dd && draftDuration(dd)) setZoom(Math.max(2, (el.clientWidth - 60) / draftDuration(dd))); }
      else setZoom((x) => Math.max(2, Math.min(400, x * k)));
    };
    window.addEventListener("reelcut:zoom", z);
    return () => window.removeEventListener("reelcut:zoom", z);
  }, []);

  // Waveforms and frame strips for the media in this draft.
  useEffect(() => {
    if (!d) return;
    for (const id of new Set([...d.clips.map((c) => c.asset), ...d.music.map((m) => m.asset), ...overlays(d).map((o) => o.asset)])) {
      const a = asset(id);
      if (!a) continue;
      if (a.info.has_audio && !waves.has(id)) loadWave(a);
      ensureStrip(a);
    }
  }, [d?.clips.length, d?.music.length, d?.overlays?.length, s.project?.assets.length]);

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !player.playing) return;
    const x = s.playhead * zoom;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 60;
  }, [s.playhead]);

  const caps = useMemo(() => (d?.captions ? captionLines(draftWords(d, assetMap()), d.captionStyle.maxChars) : []), [d?.updated, d?.captions, s.project?.assets]);

  // Where silence removal would cut (grey bands), for the "잘릴 무음 미리 보기" view.
  const silence = useMemo(() => {
    if (!d || !s.showSilence) return [] as [number, number][];
    const out: [number, number][] = [];
    const st0 = starts(d);
    d.clips.forEach((c, i) => {
      const a = asset(c.asset);
      if (!a || isGap(c) || a.info.kind === "image") return;
      const sp = a.words?.length ? speechFromWords(a.words, c.start, c.end) : waves.get(a.id) ? speechFromWave(waves.get(a.id)!, c.start, c.end) : null;
      if (!sp) return;
      for (const [x, y] of silenceCuts(c, sp, pacing)) out.push([st0[i] + (x - c.start) / c.speed, st0[i] + (y - c.start) / c.speed]);
    });
    return out;
  }, [d?.updated, s.showSilence, pacing, waves.size]);

  if (!d) return <div class="timeline" />;
  const total = draftDuration(d);
  const st0 = starts(d);
  const width = Math.max(total * zoom + 400, 800);
  const locked = (t: TrackId) => !!trackState(d, t).lock;
  const xToT = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + el.scrollLeft) / zoom);
  };
  const indexAt = (t: number) => {
    let i = 0;
    while (i < d.clips.length && st0[i] + clipDur(d.clips[i]) / 2 < t) i++;
    return i;
  };
  const snapPoints = () => {
    const pts = [0, total, st.playhead, ...d.markers.map((m) => m.t)];
    d.clips.forEach((c, i) => { pts.push(st0[i], st0[i] + clipDur(c)); });
    for (const o of overlays(d)) pts.push(o.at, o.at + timedDur(o));
    for (const m of d.music) pts.push(m.at, m.at + (m.end - m.start));
    if (d.inPoint != null) pts.push(d.inPoint);
    if (d.outPoint != null) pts.push(d.outPoint);
    return pts;
  };
  /** Snaps a timeline time to a nearby edge (within 8 px) when snapping is on. */
  const snapT = (t: number, skipId?: string) => {
    if (!st.snap) return t;
    let best = t, bd = 8 / zoom;
    for (const p of snapPoints()) if (Math.abs(p - t) < bd) { best = p; bd = Math.abs(p - t); }
    void skipId;
    return best;
  };
  const itemById = (id: string) => overlays(d).find((o) => o.id === id) ?? d.music.find((m) => m.id === id);
  const laneOfItem = (x: Overlay | MusicClip): TrackId =>
    overlays(d).some((o) => o.id === x.id) ? ((x as Overlay).track === 3 ? "V3" : "V2") : (`A${audioTrack(x as MusicClip)}` as TrackId);

  // ------------------------------------------------------------------ pointer handling

  const onDown = (e: PointerEvent, kind: Drag["kind"], id?: string, index?: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const clip = id ? d.clips.find((c) => c.id === id) : undefined;
    const item = id ? itemById(id) : undefined;
    // Blade: cut right here.
    if (st.tool === "blade" && (kind === "move" || kind === "imove")) {
      const t = snapT(xToT(e.clientX));
      if (kind === "move" && !locked("V1")) editDraft("자르기", (x) => splitAt(x, t));
      if (kind === "imove" && id && item && !locked(laneOfItem(item))) editDraft("트랙 클립 자르기", (x) => splitItem(x, id, t), st.draftId, false);
      return;
    }
    if (st.tool === "slip" && kind === "move") kind = "slip";
    if (st.tool === "roll" && (kind === "trimL" || kind === "trimR") && index != null) {
      // The cut left of clip i is between i-1 and i; the cut right of it is between i and i+1.
      index = kind === "trimL" ? index : index + 1;
      kind = "roll";
    }
    drag.current = { kind, id, x0: e.clientX, moved: false, clip, item, index };
    if (kind === "scrub") { player.pause(); player.seek(snapT(xToT(e.clientX))); }
    if ((kind === "move" || kind === "slip") && id) set({ selClip: id, selItem: null });
    if (kind === "imove" && id) set({ selItem: id, selClip: null });
  };
  const onMove = (e: PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    const dx = e.clientX - g.x0;
    if (Math.abs(dx) > 4) g.moved = true;
    if (g.kind === "scrub") { player.seek(snapT(xToT(e.clientX))); return; }
    if (!g.moved || !g.id) {
      if (g.kind !== "roll") return;
    }
    const dt = dx / zoom;
    switch (g.kind) {
      case "move":
        if (locked("V1")) return;
        g.to = indexAt(xToT(e.clientX));
        setGhost({ id: g.id!, dx, to: g.to });
        break;
      case "trimL": case "trimR": {
        if (locked("V1") || !g.clip) return;
        const c = g.clip, ds = dt * c.speed;
        const dur = isGap(c) ? 1e9 : asset(c.asset)?.info.duration || 1e9;
        const patch = g.kind === "trimL" ? { start: r3(Math.max(0, Math.min(c.end - 0.1, c.start + ds))) } : { end: r3(Math.min(dur, Math.max(c.start + 0.1, c.end + ds))) };
        if (isGap(c) && g.kind === "trimL") { setGhost({ id: g.id!, dx, patch: { end: r3(Math.max(0.1, c.end - ds)) } }); break; }
        setGhost({ id: g.id!, dx, patch });
        break;
      }
      case "slip": {
        if (locked("V1") || !g.clip) return;
        const a = asset(g.clip.asset);
        if (!a) return;
        const nd = slipClip(d, g.id!, -dt * g.clip.speed, a.info.duration);
        const c = nd.clips.find((x) => x.id === g.id)!;
        setGhost({ id: g.id!, dx: 0, patch: { start: c.start, end: c.end } });
        break;
      }
      case "roll": {
        if (locked("V1") || g.index == null) return;
        setGhost({ id: d.clips[g.index]?.id ?? "", dx: 0, draft: rollEdit(d, g.index, dt, (id) => asset(id)?.info.duration ?? 1e9) });
        break;
      }
      case "imove": {
        const it = g.item!;
        if (locked(laneOfItem(it))) return;
        const at = r3(snapT(Math.max(0, it.at + dt), it.id));
        setGhost({ id: g.id!, dx: 0, ipatch: { at } });
        break;
      }
      case "itrimL": case "itrimR": {
        const it = g.item!;
        if (locked(laneOfItem(it))) return;
        const sp = (it as Overlay).speed || 1;
        const a = asset(it.asset);
        const dur = a?.info.kind === "image" ? 1e9 : a?.info.duration || 1e9;
        if (g.kind === "itrimR") {
          const endT = snapT(it.at + timedDur(it) + dt);
          setGhost({ id: g.id!, dx: 0, ipatch: { end: r3(Math.min(dur, Math.max(it.start + 0.1, it.start + (endT - it.at) * sp))) } });
        } else {
          const at = snapT(Math.max(0, it.at + dt));
          const start = r3(Math.max(0, Math.min(it.end - 0.1, it.start + (at - it.at) * sp)));
          setGhost({ id: g.id!, dx: 0, ipatch: { start, at: r3(it.at + (start - it.start) / sp) } });
        }
        break;
      }
    }
  };
  const onUp = (e: PointerEvent) => {
    const g = drag.current;
    drag.current = null;
    if (!g) return;
    const gh = ghost;
    setGhost(null);
    if (g.kind === "move" && g.id) {
      if (g.moved && g.to != null) {
        const from = d.clips.findIndex((c) => c.id === g.id);
        const to = g.to > from ? g.to - 1 : g.to;
        if (to !== from) editDraft("클립 옮기기", (x) => moveClip(x, from, to));
      } else {
        const i = d.clips.findIndex((c) => c.id === g.id);
        player.pause();
        player.seek(Math.max(st0[i], Math.min(st0[i] + clipDur(d.clips[i]) - 0.01, xToT(e.clientX))));
      }
    } else if ((g.kind === "trimL" || g.kind === "trimR" || g.kind === "slip") && g.id && gh?.patch) {
      editDraft(g.kind === "slip" ? "내용 밀기" : "다듬기", (x) => updateClip(x, g.id!, gh.patch!));
      player.refresh();
    } else if (g.kind === "roll" && gh?.draft) {
      editDraft("편집점 굴리기", () => gh.draft!);
      player.refresh();
    } else if ((g.kind === "imove" || g.kind === "itrimL" || g.kind === "itrimR") && g.id && gh?.ipatch) {
      const isOv = overlays(d).some((o) => o.id === g.id);
      editDraft(g.kind === "imove" ? "트랙 클립 옮기기" : "트랙 클립 다듬기", (x) => (isOv ? updateOverlay(x, g.id!, gh.ipatch as any) : updateAudio(x, g.id!, gh.ipatch as any)), st.draftId, false);
      player.refresh();
    } else if (g.kind === "imove" && g.id && !g.moved) {
      player.pause();
      player.seek(xToT(e.clientX));
    }
  };

  const onDrop = (e: DragEvent, lane: TrackId) => {
    e.preventDefault();
    const ids = (e.dataTransfer?.getData("text/reelcut-assets") || "").split(",").filter(Boolean);
    if (!ids.length) return;
    if (locked(lane)) return toast(`${NAME[lane]} 트랙이 잠겨 있습니다`);
    const t = snapT(xToT(e.clientX));
    const as = ids.map((id) => asset(id)).filter(Boolean) as NonNullable<ReturnType<typeof asset>>[];
    if (lane === "V1") {
      const clips = as.filter((a) => a.info.kind !== "audio").map((a) => newClip(a, 0, a.info.kind === "image" ? 4 : a.info.duration));
      if (!clips.length) return toast("소리 파일은 A2(음악)나 A3(효과음) 트랙에 놓으세요");
      editDraft("클립 넣기", (x) => insertClips(x, clips, indexAt(t)));
    } else if (lane === "V2" || lane === "V3") {
      const vis = as.filter((a) => a.info.kind !== "audio");
      if (!vis.length) return toast("V2·V3에는 영상이나 사진을 놓으세요");
      let at = t;
      const add: Overlay[] = vis.map((a) => { const o = newOverlay(a, at, lane === "V3" ? 3 : 2); at += timedDur(o); return o; });
      editDraft("트랙에 얹기", (x) => ({ ...x, overlays: [...(x.overlays ?? []), ...add] }), st.draftId, false);
      set({ selItem: add[0].id, selClip: null });
    } else if (lane[0] === "A") {
      const tr = Number(lane[1]) as 1 | 2 | 3;
      const snd = as.filter((a) => a.info.has_audio);
      let at = t;
      const add: MusicClip[] = snd.map((a) => {
        const len = tr === 2 ? Math.min(a.info.duration, Math.max(5, total - at)) : a.info.duration;
        const m: MusicClip = { id: uid(), asset: a.id, start: 0, end: r3(len), at: r3(at), volume: tr === 2 ? 0.25 : 1, fadeIn: tr === 2 ? 1 : 0, fadeOut: tr === 2 ? 2 : 0, track: tr };
        at += len;
        return m;
      });
      if (!add.length) return toast("소리가 있는 파일을 놓으세요");
      editDraft(tr === 2 ? "음악 넣기" : "소리 넣기", (x) => ({ ...x, music: [...x.music, ...add] }), st.draftId, false);
    }
  };

  const setTrack = (t: TrackId, p: Partial<{ mute: boolean; hide: boolean; lock: boolean; solo: boolean }>) =>
    editDraft("트랙 설정", (x) => ({ ...x, tracks: { ...(x.tracks ?? {}), [t]: { ...(x.tracks?.[t] ?? {}), ...p } } }), st.draftId, false);

  // ------------------------------------------------------------------ rendering

  const ticks: number[] = [];
  const step = zoom > 160 ? 1 : zoom > 60 ? 2 : zoom > 20 ? 5 : zoom > 8 ? 10 : zoom > 3 ? 30 : 60;
  for (let t = 0; t <= width / zoom; t += step) ticks.push(t);
  const fps = d.fps || 30;

  const clipBox = (c: Clip, i: number) => {
    const a = isGap(c) ? null : asset(c.asset);
    const roll = ghost?.draft;
    const g = ghost?.id === c.id ? ghost : null;
    const cc = roll ? roll.clips[i] : g?.patch ? { ...c, ...g.patch } : c;
    const left = (roll ? starts(roll)[i] : st0[i]) * zoom;
    const w = Math.max(6, clipDur(cc) * zoom);
    const xin = xinOf(d, i);
    const strip = a?.strip ? fileSrc(a.strip) : null;
    const fullW = a ? (a.info.duration / cc.speed) * zoom : 0;
    const bg = strip ? { backgroundImage: `url("${strip}")`, backgroundSize: `${fullW}px 100%`, backgroundPosition: `${-(cc.start / cc.speed) * zoom}px 0` }
      : a?.poster ? { backgroundImage: `url("${fileSrc(a.poster)}")` } : {};
    const cls = `clip ${isGap(c) ? "gap" : ""} ${s.selClip === c.id ? "sel" : ""} ${g && !g.patch && g.to != null ? "dragging" : ""} ${a && is360(a) ? "c360" : ""} ${s.tool}`;
    return (
      <div key={c.id} class={cls} tabIndex={0} role="button" aria-label={`${isGap(c) ? "빈칸" : a?.info.name ?? "없는 미디어"} ${fmtTCF(clipDur(c), fps)}`}
        style={{ left: `${left}px`, width: `${w}px`, transform: g && !g.patch && g.to != null ? `translateX(${g.dx}px)` : undefined, ...(isGap(c) ? {} : bg) }}
        onPointerDown={(e) => onDown(e as any, "move", c.id, i)} onPointerMove={onMove as any} onPointerUp={onUp as any}
        onKeyDown={(e) => { if (e.key === "Enter") set({ selClip: c.id, selItem: null }); }}
        onContextMenu={(e) => { e.preventDefault(); set({ selClip: c.id, selItem: null }); setMenu({ id: c.id, x: e.clientX, y: e.clientY }); }}
        title={isGap(c) ? `빈칸 ${fmtTCF(clipDur(c), fps)}` : `${a?.info.name ?? "?"} · 원본 ${fmtTCF(c.start, fps)}–${fmtTCF(c.end, fps)}${c.speed !== 1 ? ` · ${c.speed}x` : ""}${c.detached ? " · 소리 분리됨" : ""}`}>
        {!isGap(c) && <span class="name">{c.speed !== 1 ? `${c.speed}x · ` : ""}{a?.info.name ?? "없는 미디어"}{c.detached ? " · 소리 분리됨" : ""}</span>}
        {isGap(c) && <span class="name muted">빈칸</span>}
        {!isGap(c) && !c.detached && a?.info.has_audio && <Wave asset={c.asset} start={cc.start} end={cc.end} w={w} />}
        {xin > 0 && <div class="xfade" style={{ width: `${xin * zoom}px` }} title={`디졸브 ${xin.toFixed(2)}초`} />}
        <div class="trim l" onPointerDown={(e) => onDown(e as any, "trimL", c.id, i)} onPointerMove={onMove as any} onPointerUp={onUp as any} />
        <div class="trim r" onPointerDown={(e) => onDown(e as any, "trimR", c.id, i)} onPointerMove={onMove as any} onPointerUp={onUp as any} />
      </div>
    );
  };

  const itemBox = (x: Overlay | MusicClip, lane: TrackId) => {
    const a = asset(x.asset);
    const g = ghost?.id === x.id ? ghost : null;
    const xx = g?.ipatch ? { ...x, ...g.ipatch } : x;
    const left = xx.at * zoom, w = Math.max(6, timedDur(xx as any) * zoom);
    const isV = lane[0] === "V";
    const strip = isV && a?.strip ? fileSrc(a.strip) : null;
    const sp = (xx as Overlay).speed || 1;
    const bg = strip ? { backgroundImage: `url("${strip}")`, backgroundSize: `${(a!.info.duration / sp) * zoom}px 100%`, backgroundPosition: `${-(xx.start / sp) * zoom}px 0` }
      : isV && a?.poster ? { backgroundImage: `url("${fileSrc(a.poster)}")` } : {};
    return (
      <div key={x.id} class={`item ${isV ? "vitem" : "aitem"} lane-${lane} ${s.selItem === x.id ? "sel" : ""} ${s.tool}`} tabIndex={0} role="button"
        aria-label={`${NAME[lane]} ${a?.info.name ?? ""}`}
        style={{ left: `${left}px`, width: `${w}px`, ...bg }}
        onPointerDown={(e) => onDown(e as any, "imove", x.id)} onPointerMove={onMove as any} onPointerUp={onUp as any}
        onKeyDown={(e) => { if (e.key === "Enter") set({ selItem: x.id, selClip: null }); }}
        onContextMenu={(e) => { e.preventDefault(); set({ selItem: x.id, selClip: null }); setMenu({ id: x.id, x: e.clientX, y: e.clientY, item: true }); }}
        title={`${a?.info.name} · ${fmtTCF(xx.at, fps)}부터 ${fmtTCF(timedDur(xx as any), fps)}${isV ? "" : ` · 음량 ${Math.round(x.volume * 100)}%`}`}>
        <span class="name">{a?.info.name}{!isV ? ` · ${Math.round(x.volume * 100)}%` : ""}</span>
        {!isV && a?.info.has_audio && <Wave asset={x.asset} start={xx.start} end={xx.end} w={w} h={20} />}
        <div class="trim l" onPointerDown={(e) => onDown(e as any, "itrimL", x.id)} onPointerMove={onMove as any} onPointerUp={onUp as any} />
        <div class="trim r" onPointerDown={(e) => onDown(e as any, "itrimR", x.id)} onPointerMove={onMove as any} onPointerUp={onUp as any} />
      </div>
    );
  };

  const head = (t: TrackId) => {
    const ts = trackState(d, t);
    const isA = t[0] === "A";
    return (
      <div class={`th th-${t[0]}`} style={{ height: `${H[t]}px` }} key={t}>
        <span class="tname">{NAME[t]}</span>
        <span class="tbtns">
          {isA ? (
            <>
              <button class={`tb ${ts.mute ? "on warn" : ""}`} aria-pressed={!!ts.mute} onClick={() => setTrack(t, { mute: !ts.mute })} title={`${NAME[t]} 소리 끄기 · Mute`} aria-label={`${NAME[t]} 소리 끄기`}>{ts.mute ? <VolumeX size={13} /> : <Volume2 size={13} />}</button>
              <button class={`tb ${ts.solo ? "on" : ""}`} aria-pressed={!!ts.solo} onClick={() => setTrack(t, { solo: !ts.solo })} title={`${NAME[t]}만 듣기 (미리보기) · Solo`} aria-label={`${NAME[t]}만 듣기`}><Headphones size={13} /></button>
            </>
          ) : (
            <button class={`tb ${ts.hide ? "on warn" : ""}`} aria-pressed={!!ts.hide} onClick={() => setTrack(t, { hide: !ts.hide })} title={`${NAME[t]} 숨기기`} aria-label={`${NAME[t]} 숨기기`}>{ts.hide ? <EyeOff size={13} /> : t === "C1" ? <Captions size={13} /> : <Eye size={13} />}</button>
          )}
          {t !== "C1" && <button class={`tb ${ts.lock ? "on" : ""}`} aria-pressed={!!ts.lock} onClick={() => setTrack(t, { lock: !ts.lock })} title={`${NAME[t]} 잠그기 · Lock`} aria-label={`${NAME[t]} 잠그기`}>{ts.lock ? <Lock size={13} /> : <LockOpen size={13} />}</button>}
        </span>
      </div>
    );
  };

  const lane = (t: TrackId) => {
    const ts = trackState(d, t);
    const common = { class: `lane lane-${t} ${ts.lock ? "locked" : ""} ${ts.hide || ts.mute ? "dim" : ""}`, style: { height: `${H[t]}px` }, onDragOver: (e: DragEvent) => e.preventDefault(), onDrop: (e: DragEvent) => onDrop(e, t) };
    if (t === "V1") return (
      <div {...common as any} key={t} onPointerDown={(e: any) => { if (e.target === e.currentTarget) { set({ selClip: null, selItem: null }); onDown(e, "scrub"); } }} onPointerMove={onMove as any} onPointerUp={onUp as any}>
        {d.clips.map((c, i) => clipBox(c, i))}
        {silence.map(([a, b]) => <div class="silence" style={{ left: `${a * zoom}px`, width: `${Math.max(1, (b - a) * zoom)}px` }} title={`잘릴 무음 ${(b - a).toFixed(1)}초`} />)}
        {s.trRanges.map(([a, b]) => <div class="tr-sel" style={{ left: `${a * zoom}px`, width: `${Math.max(2, (b - a) * zoom)}px` }} />)}
        {d.clips.map((c, i) => i > 0 && !isGap(c) && !isGap(d.clips[i - 1]) && (
          <button class={`xbtn ${c.xin ? "on" : ""}`} style={{ left: `${st0[i] * zoom - 7}px` }} title={c.xin ? `디졸브 ${c.xin}초 (눌러서 빼기) · Cross Dissolve` : "디졸브 넣기 (0.5초) · Cross Dissolve"}
            aria-label={c.xin ? "디졸브 빼기" : "디졸브 넣기"} onPointerDown={(e) => e.stopPropagation()} onClick={() => editDraft("디졸브", (x) => setTransition(x, c.id, c.xin ? 0 : 0.5))}>◆</button>
        ))}
        {ghost && ghost.to != null && d.clips.some((c) => c.id === ghost.id) && <div class="drop-at" style={{ left: `${(ghost.to < d.clips.length ? st0[ghost.to] : total) * zoom}px` }} />}
        {!d.clips.length && <div class="lane-hint">여기에 미디어를 끌어다 놓으세요 (본편)</div>}
      </div>
    );
    if (t === "C1") return (
      <div {...common as any} key={t}>
        {caps.map((l) => <div class="cap" style={{ left: `${l.t0 * zoom}px`, width: `${Math.max(4, (l.t1 - l.t0) * zoom)}px` }} title={l.text} onClick={() => player.seek(l.t0)} onDblClick={() => set({ leftTab: "transcript" })}>{l.text}</div>)}
        {!d.captions && <div class="lane-hint">자막 꺼짐 — 위 '자막'을 켜면 받아쓰기로 자막이 생깁니다</div>}
      </div>
    );
    const items: (Overlay | MusicClip)[] = t[0] === "V" ? overlays(d).filter((o) => o.track === (t === "V3" ? 3 : 2)) : d.music.filter((m) => audioTrack(m) === Number(t[1]));
    return (
      <div {...common as any} key={t} onPointerDown={(e: any) => { if (e.target === e.currentTarget) { set({ selClip: null, selItem: null }); onDown(e, "scrub"); } }} onPointerMove={onMove as any} onPointerUp={onUp as any}>
        {items.map((x) => itemBox(x, t))}
        {!items.length && <div class="lane-hint">{t === "V2" || t === "V3" ? "영상·사진을 놓으면 본편 위에 겹칩니다 (화면 속 화면, 로고)" : t === "A1" ? "클립을 오른쪽 클릭 > 소리 분리 (J·L컷)" : t === "A2" ? "배경음악 소리 파일을 놓으세요" : "효과음을 놓으세요"}</div>}
      </div>
    );
  };

  const mClip = menu && !menu.item ? d.clips.find((c) => c.id === menu.id) : null;
  const mi = mClip ? d.clips.indexOf(mClip) : -1;
  const pct = (zoom: number) => Math.round((Math.log(zoom / 2) / Math.log(200)) * 100);
  const fromPct = (p: number) => 2 * Math.pow(200, p / 100);

  return (
    <div class="timeline" onClick={() => setMenu(null)}>
      <div class="tl-tools">
        <label class="inline" title="무음 정리의 세기">
          <span class="muted">무음</span>
          <select value={pacing} onChange={(e) => { const p = (e.target as HTMLSelectElement).value as Pacing; setPac(p); setPacing(p); }} aria-label="무음 정리 세기">
            {(Object.keys(PACING) as Pacing[]).map((k) => <option value={k}>{PACING[k].label}</option>)}
          </select>
        </label>
        <button class="small" disabled={!d.clips.length} onClick={doSilence} title="말 없는 구간 잘라 내기">무음 정리</button>
        <button class={`small ${s.showSilence ? "on" : ""}`} aria-pressed={s.showSilence} onClick={() => set({ showSilence: !s.showSilence })} title="무음 정리로 잘릴 곳을 회색으로 미리 보기">잘릴 곳 보기</button>
        <button class="small" disabled={!d.clips.length} onClick={doFillers} title="'음', '어' 같은 말 잘라 내기 (받아쓰기 필요)">군더더기 말 정리</button>
        <span class="sep" />
        <button class={`small ${d.captions ? "on" : ""}`} aria-pressed={d.captions} onClick={() => editDraft("자막", (x) => ({ ...x, captions: !x.captions }), st.draftId, false)} title="받아쓰기로 자막 켜기/끄기"><Captions size={13} aria-hidden="true" /> 자막</button>
        <button class="small" onClick={() => editDraft("마커", (x) => ({ ...x, markers: [...x.markers, { id: uid(), t: st.playhead, label: `마커 ${x.markers.length + 1}`, color: "#FFB020" }] }), st.draftId, false)} title="재생 위치에 마커 (M)">마커</button>
        {(d.inPoint != null || d.outPoint != null) && <span class="io-badge" title="I/O로 정한 구간 (내보내기에서 이 구간만 고를 수 있습니다)">인·아웃 {fmtTCF(d.inPoint ?? 0, fps)}–{fmtTCF(d.outPoint ?? total, fps)}</span>}
        <span class="spacer" />
        <span class="muted tc">{d.clips.length}개 · {fmtTCF(total, fps)}</span>
        <input class="zoom" type="range" min={0} max={100} value={pct(zoom)} onInput={(e) => setZoom(fromPct(Number((e.target as HTMLInputElement).value)))} aria-label="타임라인 확대" title="확대·축소 (Ctrl+휠, +/−)" />
        <button class="small" onClick={() => { const el = scroller.current; if (el && total) setZoom(Math.max(2, (el.clientWidth - 60) / total)); }} title="전체 맞춤 (Shift+Z)">맞춤</button>
      </div>
      <div class="tl-body">
        <div class="tl-heads">
          <div class="th ruler-h" />
          {ORDER.map(head)}
        </div>
        <div class="tl-scroll" ref={scroller} onWheel={(e) => { if (e.ctrlKey) { e.preventDefault(); setZoom((z) => Math.max(2, Math.min(400, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))); } }}>
          <div class="tl-inner" style={{ width: `${width}px` }}>
            <div class="ruler" onPointerDown={(e) => onDown(e as any, "scrub")} onPointerMove={onMove as any} onPointerUp={onUp as any}>
              {d.inPoint != null && <div class="io-range" style={{ left: `${d.inPoint * zoom}px`, width: `${((d.outPoint ?? total) - d.inPoint) * zoom}px` }} />}
              {d.inPoint == null && d.outPoint != null && <div class="io-range" style={{ left: 0, width: `${d.outPoint * zoom}px` }} />}
              {ticks.map((t) => <span class="tick" style={{ left: `${t * zoom}px` }}>{fmtTCF(t, fps).slice(3, 8)}</span>)}
              {d.markers.map((m) => (
                <span class="marker" style={{ left: `${m.t * zoom}px`, borderColor: m.color }} title={m.label} onPointerDown={(e) => { e.stopPropagation(); player.seek(m.t); }}>{m.label}</span>
              ))}
            </div>
            {ORDER.map(lane)}
            <div class="playhead" style={{ left: `${s.playhead * zoom}px` }}><span class="ph-time">{fmtTCF(s.playhead, fps)}</span></div>
          </div>
        </div>
      </div>
      {menu && (
        <div class="ctx" style={{ left: `${menu.x}px`, top: `${Math.max(8, menu.y - 220)}px` }} role="menu" onClick={(e) => e.stopPropagation()}>
          {mClip ? (
            <>
              {!isGap(mClip) && <button role="menuitem" onClick={() => { set({ sourceId: mClip.asset }); setMenu(null); }}>원본 보기</button>}
              <button role="menuitem" onClick={() => { editDraft("자르기", (x) => splitAt(x, st.playhead)); setMenu(null); }}>재생 위치에서 자르기 <kbd>S</kbd></button>
              {mi > 0 && <button role="menuitem" onClick={() => { editDraft("디졸브", (x) => setTransition(x, mClip.id, mClip.xin ? 0 : 0.5)); setMenu(null); }}>{mClip.xin ? "디졸브 빼기" : "앞 클립과 디졸브 (0.5초)"} <kbd>Ctrl+D</kbd></button>}
              {!isGap(mClip) && !mClip.detached && <button role="menuitem" disabled={mClip.speed !== 1} onClick={() => { editDraft("소리 분리", (x) => detachAudio(x, mClip.id)); setMenu(null); }}>소리 분리 → A1 (J·L컷) <kbd>Ctrl+L</kbd></button>}
              {!isGap(mClip) && <button role="menuitem" onClick={() => {
                const a = asset(mClip.asset)!; const at = st0[mi];
                const o: Overlay = { ...newOverlay(a, at, 2, mClip.start, mClip.end), transform: undefined, view: mClip.view, speed: mClip.speed };
                editDraft("V2로 올리기", (x) => ({ ...liftClip(x, mClip.id), overlays: [...(x.overlays ?? []), o] }), st.draftId, false);
                setMenu(null);
              }}>V2로 올리기 (빈칸 남김)</button>}
              <div class="menu-sep" />
              <button role="menuitem" onClick={() => { editDraft("빈칸 남기고 삭제", (x) => liftClip(x, mClip.id)); set({ selClip: null }); setMenu(null); }}>빈칸 남기고 삭제 <kbd>Shift+Del</kbd></button>
              <button role="menuitem" class="danger" onClick={() => { editDraft("클립 삭제", (x) => deleteClip(x, mClip.id)); set({ selClip: null }); setMenu(null); }}>삭제 (뒤 클립 당기기) <kbd>Del</kbd></button>
            </>
          ) : (
            <>
              <button role="menuitem" onClick={() => { editDraft("트랙 클립 자르기", (x) => splitItem(x, menu.id, st.playhead), st.draftId, false); setMenu(null); }}>재생 위치에서 자르기</button>
              <button role="menuitem" onClick={() => { const it = itemById(menu.id); if (it) player.seek(it.at); setMenu(null); }}>시작으로 이동</button>
              <button role="menuitem" class="danger" onClick={() => { editDraft("트랙 클립 삭제", (x) => ({ ...x, overlays: (x.overlays ?? []).filter((o) => o.id !== menu.id), music: x.music.filter((m) => m.id !== menu.id) }), st.draftId, false); set({ selItem: null }); setMenu(null); }}>삭제</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
