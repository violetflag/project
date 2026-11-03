import { useEffect, useRef, useState } from "preact/hooks";
import { fileSrc } from "../api";
import {
  clipDur, deleteClip, draftDuration, fmtTC, insertClips, is360, moveClip, newClip, PACING, r3, removeFillers, removeSilences, splitAt, starts, uid, updateClip, type Pacing,
} from "../edit";
import { asset, assetMap, draft, editDraft, loadWave, set, st, toast, useStore, waves } from "../store";
import type { Clip } from "../types";
import { player } from "./Viewer";

function Wave({ c, w }: { c: Clip; w: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wave = waves.get(c.asset);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !wave) return;
    const W = Math.max(1, Math.min(4000, Math.round(w))), H = 22;
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d")!;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(120,200,255,0.75)";
    const per = (c.end - c.start) / W;
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((c.start + x * per) * 50), i1 = Math.max(i0 + 1, Math.floor((c.start + (x + 1) * per) * 50));
      let m = 0;
      for (let i = i0; i < i1 && i < wave.length; i++) m = Math.max(m, wave[i]);
      const h = (m / 255) * H;
      g.fillRect(x, H - h, 1, h);
    }
  }, [wave, c.start, c.end, w]);
  return wave ? <canvas ref={ref} class="wave" style={{ width: `${w}px` }} /> : null;
}

export function Timeline() {
  const s = useStore();
  const d = draft();
  const [zoom, setZoom] = useState(40); // px per second
  const [pacing, setPacing] = useState<Pacing>("normal");
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<null | { kind: "move" | "trimL" | "trimR" | "scrub" | "music"; id?: string; x0: number; moved: boolean; orig?: Clip; to?: number; at0?: number }>(null);
  const [ghost, setGhost] = useState<{ id: string; to: number; dx: number; patch?: Partial<Clip> } | null>(null);

  // Waveforms for the media in this draft.
  useEffect(() => {
    if (!d) return;
    for (const id of new Set([...d.clips.map((c) => c.asset), ...d.music.map((m) => m.asset)])) {
      const a = asset(id);
      if (a && a.info.has_audio && !waves.has(id)) loadWave(a);
    }
  }, [d?.clips.length, d?.music.length]);

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !player.playing) return;
    const x = s.playhead * zoom;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 60;
  }, [s.playhead]);

  if (!d) return <div class="timeline" />;
  const total = draftDuration(d);
  const st0 = starts(d);
  const width = Math.max(total * zoom + 400, 800);
  const xToT = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + el.scrollLeft - 8) / zoom);
  };
  const indexAt = (t: number) => {
    let i = 0;
    while (i < d.clips.length && st0[i] + clipDur(d.clips[i]) / 2 < t) i++;
    return i;
  };

  const onDown = (e: PointerEvent, kind: "move" | "trimL" | "trimR" | "scrub" | "music", id?: string) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const orig = id ? d.clips.find((c) => c.id === id) : undefined;
    const at0 = kind === "music" ? d.music.find((m) => m.id === id)?.at : undefined;
    drag.current = { kind, id, x0: e.clientX, moved: false, orig, at0 };
    if (kind === "scrub") { player.pause(); player.seek(xToT(e.clientX)); }
    if (kind === "move" && id) set({ selClip: id });
  };
  const onMove = (e: PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    const dx = e.clientX - g.x0;
    if (Math.abs(dx) > 4) g.moved = true;
    if (g.kind === "scrub") { player.seek(xToT(e.clientX)); return; }
    if (!g.moved || !g.id) return;
    if (g.kind === "move") {
      g.to = indexAt(xToT(e.clientX));
      setGhost({ id: g.id, to: g.to, dx });
    } else if (g.kind === "music") {
      setGhost({ id: g.id, to: 0, dx });
    } else if (g.orig) {
      const c = g.orig;
      const ds = (dx / zoom) * c.speed;
      const dur = asset(c.asset)?.info.duration || 1e9;
      const patch = g.kind === "trimL" ? { start: r3(Math.max(0, Math.min(c.end - 0.1, c.start + ds))) } : { end: r3(Math.min(dur, Math.max(c.start + 0.1, c.end + ds))) };
      setGhost({ id: g.id, to: 0, dx, patch });
    }
  };
  const onUp = (e: PointerEvent) => {
    const g = drag.current;
    drag.current = null;
    if (!g) return;
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
    } else if ((g.kind === "trimL" || g.kind === "trimR") && g.id && ghost?.patch) {
      editDraft("다듬기", (x) => updateClip(x, g.id!, ghost.patch!));
      player.refresh();
    } else if (g.kind === "music" && g.id && g.moved && g.at0 != null) {
      const at = r3(Math.max(0, g.at0 + (e.clientX - g.x0) / zoom));
      editDraft("음악 옮기기", (x) => ({ ...x, music: x.music.map((m) => (m.id === g.id ? { ...m, at } : m)) }));
    }
    setGhost(null);
  };

  const onDrop = (e: DragEvent, lane: "main" | "music") => {
    e.preventDefault();
    const ids = (e.dataTransfer?.getData("text/reelcut-assets") || "").split(",").filter(Boolean);
    if (!ids.length) return;
    const t = xToT(e.clientX);
    if (lane === "music") {
      const a = asset(ids[0]);
      if (!a) return;
      editDraft("음악 넣기", (x) => ({ ...x, music: [...x.music, { id: uid(), asset: a.id, start: 0, end: Math.min(a.info.duration, Math.max(5, draftDuration(x) - t)), at: r3(t), volume: 0.25, fadeIn: 1, fadeOut: 2 }] }));
      return;
    }
    const clips = ids.map((id) => asset(id)).filter((a) => a && a.info.kind !== "audio").map((a) => newClip(a!, 0, a!.info.kind === "image" ? 4 : a!.info.duration));
    if (!clips.length) return toast("소리 파일은 아래 음악 줄에 놓으세요");
    editDraft("클립 넣기", (x) => insertClips(x, clips, indexAt(t)));
  };

  const doSilence = async () => {
    for (const c of d.clips) { const a = asset(c.asset); if (a && !a.words && a.info.has_audio && !waves.has(a.id)) await loadWave(a); }
    const r = removeSilences(d, assetMap(), waves, pacing);
    if (!r.removed) return toast("잘라 낼 무음이 없습니다");
    editDraft(`무음 정리(${PACING[pacing].label})`, () => r.draft);
    toast(`무음 ${r.removed.toFixed(1)}초를 잘라 냈습니다`);
    player.refresh();
  };
  const doFillers = () => {
    const r = removeFillers(d, assetMap());
    if (!r.count) return toast(d.clips.some((c) => asset(c.asset)?.words) ? "군더더기 말이 없습니다" : "먼저 받아쓰기가 필요합니다");
    editDraft("군더더기 말 정리", () => r.draft);
    toast(`군더더기 말 ${r.count}개를 잘라 냈습니다`);
    player.refresh();
  };

  const ticks: number[] = [];
  const step = zoom > 120 ? 1 : zoom > 40 ? 2 : zoom > 15 ? 5 : zoom > 6 ? 10 : 30;
  for (let t = 0; t <= width / zoom; t += step) ticks.push(t);

  const clipBox = (c: Clip, i: number) => {
    const a = asset(c.asset);
    const g = ghost?.id === c.id ? ghost : null;
    const cc = g?.patch ? { ...c, ...g.patch } : c;
    const left = st0[i] * zoom;
    const w = Math.max(6, clipDur(cc) * zoom);
    return (
      <div
        key={c.id}
        class={`clip ${s.selClip === c.id ? "sel" : ""} ${g && !g.patch ? "dragging" : ""} ${a && is360(a) ? "c360" : ""}`}
        style={{ left: `${left}px`, width: `${w}px`, transform: g && !g.patch ? `translateX(${g.dx}px)` : undefined, backgroundImage: a?.poster ? `url("${fileSrc(a.poster)}")` : undefined }}
        onPointerDown={(e) => onDown(e as any, "move", c.id)}
        onPointerMove={onMove as any}
        onPointerUp={onUp as any}
        title={`${a?.info.name ?? "?"} · 원본 ${fmtTC(c.start, true)}–${fmtTC(c.end, true)}${c.speed !== 1 ? ` · ${c.speed}x` : ""}`}
      >
        <span class="name">{c.speed !== 1 ? `${c.speed}x · ` : ""}{a?.info.name ?? "없는 미디어"}</span>
        <Wave c={cc} w={w} />
        <div class="trim l" onPointerDown={(e) => onDown(e as any, "trimL", c.id)} onPointerMove={onMove as any} onPointerUp={onUp as any} />
        <div class="trim r" onPointerDown={(e) => onDown(e as any, "trimR", c.id)} onPointerMove={onMove as any} onPointerUp={onUp as any} />
      </div>
    );
  };

  return (
    <div class="timeline">
      <div class="tl-tools">
        <button class="small" onClick={() => { editDraft("자르기", (x) => splitAt(x, st.playhead)); }} title="S">✂ 자르기</button>
        <button class="small" disabled={!s.selClip} onClick={() => { const id = st.selClip!; set({ selClip: null }); editDraft("클립 삭제", (x) => deleteClip(x, id)); }} title="Delete">삭제</button>
        <span class="sep" />
        <select value={pacing} onChange={(e) => setPacing((e.target as HTMLSelectElement).value as Pacing)}>
          {(Object.keys(PACING) as Pacing[]).map((k) => <option value={k}>{PACING[k].label}</option>)}
        </select>
        <button class="small" disabled={!d.clips.length} onClick={doSilence}>무음 정리</button>
        <button class="small" disabled={!d.clips.length} onClick={doFillers}>군더더기 말 정리</button>
        <label class="check small"><input type="checkbox" checked={d.captions} onChange={(e) => editDraft("자막", (x) => ({ ...x, captions: (e.target as HTMLInputElement).checked }))} /> 자막</label>
        <button class="small" onClick={() => editDraft("마커", (x) => ({ ...x, markers: [...x.markers, { id: uid(), t: st.playhead, label: `마커 ${x.markers.length + 1}`, color: "#FFB020" }] }))} title="M">마커</button>
        <span class="spacer" />
        <span class="muted">{d.clips.length}개 · {fmtTC(total, true)}</span>
        <button class="small" onClick={() => setZoom((z) => Math.max(2, z / 1.5))}>－</button>
        <button class="small" onClick={() => setZoom((z) => Math.min(400, z * 1.5))}>＋</button>
        <button class="small" onClick={() => { const el = scroller.current; if (el && total) setZoom(Math.max(2, (el.clientWidth - 60) / total)); }}>맞춤</button>
      </div>
      <div class="tl-scroll" ref={scroller} onWheel={(e) => { if (e.ctrlKey) { e.preventDefault(); setZoom((z) => Math.max(2, Math.min(400, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))); } }}>
        <div class="tl-inner" style={{ width: `${width}px` }}>
          <div class="ruler" onPointerDown={(e) => onDown(e as any, "scrub")} onPointerMove={onMove as any} onPointerUp={onUp as any}>
            {ticks.map((t) => <span class="tick" style={{ left: `${t * zoom}px` }}>{fmtTC(t)}</span>)}
            {d.markers.map((m) => (
              <span class="marker" style={{ left: `${m.t * zoom}px`, borderColor: m.color }} title={m.label} onPointerDown={(e) => { e.stopPropagation(); player.seek(m.t); }}>{m.label}</span>
            ))}
          </div>
          <div class="lane main" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, "main")} onPointerDown={(e) => { if (e.target === e.currentTarget) { set({ selClip: null }); onDown(e as any, "scrub"); } }} onPointerMove={onMove as any} onPointerUp={onUp as any}>
            {d.clips.map((c, i) => clipBox(c, i))}
            {ghost && !ghost.patch && ghost.to != null && d.clips.some((c) => c.id === ghost.id) && <div class="drop-at" style={{ left: `${(ghost.to < d.clips.length ? st0[ghost.to] : total) * zoom}px` }} />}
            {!d.clips.length && <div class="lane-hint">여기에 미디어를 끌어다 놓으세요</div>}
          </div>
          <div class="lane music" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, "music")}>
            {d.music.map((m) => {
              const a = asset(m.asset);
              const g = ghost?.id === m.id ? ghost : null;
              return (
                <div class="mclip" style={{ left: `${m.at * zoom}px`, width: `${Math.max(6, (m.end - m.start) * zoom)}px`, transform: g ? `translateX(${g.dx}px)` : undefined }}
                  onPointerDown={(e) => onDown(e as any, "music", m.id)} onPointerMove={onMove as any} onPointerUp={onUp as any} title={a?.info.name}>
                  ♪ {a?.info.name} · {Math.round(m.volume * 100)}%
                </div>
              );
            })}
            {!d.music.length && <div class="lane-hint">배경음악: 소리 파일을 여기에 놓으세요</div>}
          </div>
          <div class="playhead" style={{ left: `${s.playhead * zoom}px` }} />
        </div>
      </div>
    </div>
  );
}
