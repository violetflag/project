// Transcript editing: the draft's words in timeline order. Click to jump, drag to select,
// Delete to cut the selected words out of the video. Double-click fixes a word's text.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { draftWords, fmtTC, insertClips, isFiller, newClip, removeWords, type TWord } from "../edit";
import { asset, assetMap, draft, editDraft, patchAsset, startTranscribe, toast, useStore } from "../store";
import { player } from "./Viewer";

export function Transcript() {
  const s = useStore();
  const d = draft();
  const src = s.sourceId ? asset(s.sourceId) : null;
  const words: TWord[] = useMemo(() => {
    if (src) return (src.words ?? []).map((w, wi) => ({ ...w, clip: "", ci: 0, wi, asset: src.id, t0: w.s, t1: w.e }));
    return d ? draftWords(d, assetMap()) : [];
  }, [src?.id, src?.words, d?.updated, d?.id, s.project?.assets]);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const down = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setSel(null), [src?.id, d?.id, d?.updated]);
  useEffect(() => {
    const up = () => { down.current = null; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const now = src ? player.srcT : s.playhead;
  const cur = words.findIndex((w) => now >= w.t0 && now < w.t1 + 0.05);
  useEffect(() => {
    if (!player.playing || cur < 0) return;
    const el = box.current?.querySelector(`[data-i="${cur}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const lo = sel ? Math.min(sel[0], sel[1]) : -1, hi = sel ? Math.max(sel[0], sel[1]) : -1;
  const selected = sel ? words.slice(lo, hi + 1) : [];

  const cut = () => {
    if (!d || !selected.length) return;
    editDraft(`대본에서 지우기 "${selected.map((w) => w.t).join(" ").slice(0, 20)}"`, (x) => removeWords(x, selected, words));
    setSel(null);
    player.refresh();
  };
  const insertSel = () => {
    if (!src || !d || !selected.length) return;
    const c = newClip(src, Math.max(0, selected[0].s - 0.15), Math.min(src.info.duration, selected[selected.length - 1].e + 0.2));
    editDraft("대본에서 넣기", (x) => insertClips(x, [c]));
    toast("선택한 대사 구간을 편집본 끝에 넣었습니다");
    setSel(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel && !src) { e.preventDefault(); e.stopPropagation(); cut(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const missing = d ? [...new Set(d.clips.map((c) => c.asset))].map((id) => asset(id)!).filter((a) => a && a.info.has_audio && !a.words) : [];

  // Group into paragraphs at clip changes and long pauses.
  const paras: { start: number; items: number[] }[] = [];
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (!prev || prev.clip !== w.clip || w.t0 - prev.t1 > 1.2) paras.push({ start: w.t0, items: [] });
    paras[paras.length - 1].items.push(i);
  });

  return (
    <div class="transcript">
      <div class="tr-head">
        {src ? <b>원본 대본: {src.info.name}</b> : <b>편집본 대본</b>}
        <span class="spacer" />
        {selected.length > 0 && (src ? (
          <button class="small primary" onClick={insertSel}>선택 구간 편집본에 넣기</button>
        ) : (
          <button class="small danger" onClick={cut}>선택한 말 지우기 ({selected.length})</button>
        ))}
      </div>
      {src && !src.words && (
        <div class="pad">
          {src.tState === "running" ? <p>받아쓰는 중… {Math.round(src.tPct ?? 0)}%</p> : src.info.has_audio ? <button onClick={() => startTranscribe(src.id)}>받아쓰기 시작</button> : <p class="muted">소리가 없는 파일입니다.</p>}
          {src.tError && <p class="warn">{src.tError}</p>}
        </div>
      )}
      {!src && missing.length > 0 && (
        <div class="pad note">
          받아쓰기가 없는 클립 {missing.length}개
          {missing.some((a) => a.tState === "running") ? " (받아쓰는 중…)" : <button class="small" onClick={() => missing.forEach((a) => startTranscribe(a.id))}>모두 받아쓰기</button>}
          {missing.find((a) => a.tError) && <p class="warn">{missing.find((a) => a.tError)!.tError}</p>}
        </div>
      )}
      <div class="words" ref={box}>
        {paras.map((p) => (
          <p>
            <span class="ts" onClick={() => player.seek(p.start)}>{fmtTC(p.start)}</span>
            {p.items.map((i) => {
              const w = words[i];
              if (editing === i) {
                return <input class="wedit" autoFocus defaultValue={w.t} size={Math.max(2, w.t.length + 1)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const v = (e.target as HTMLInputElement).value.trim();
                      const a = asset(w.asset);
                      if (a?.words && v) patchAsset(a.id, { words: a.words.map((x, k) => (k === w.wi ? { ...x, t: v } : x)) });
                      setEditing(null);
                    }
                    if (e.key === "Escape") setEditing(null);
                  }} onBlur={() => setEditing(null)} />;
              }
              return (
                <span data-i={i}
                  class={`w ${i === cur ? "cur" : ""} ${i >= lo && i <= hi ? "sel" : ""} ${isFiller(w.t) ? "filler" : ""}`}
                  onMouseDown={(e) => { if (e.button !== 0) return; down.current = i; setSel(e.shiftKey && sel ? [sel[0], i] : [i, i]); }}
                  onMouseEnter={() => { if (down.current != null) setSel([down.current, i]); }}
                  onClick={(e) => { if (!e.shiftKey && lo === hi) player.seek(w.t0 + 0.001); }}
                  onDblClick={() => setEditing(i)}
                >{w.t} </span>
              );
            })}
          </p>
        ))}
        {!words.length && !src && !missing.length && <p class="muted pad">편집본에 대사가 있는 클립이 없습니다.</p>}
      </div>
      <div class="muted tip">클릭: 그 위치로 · 끌어서 선택 후 Delete: 영상에서 잘라 내기 · 두 번 클릭: 글자 고치기(자막에 반영)</div>
    </div>
  );
}
