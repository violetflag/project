// Transcript editing: the draft's words in timeline order. Click to jump, drag to select,
// Delete to cut the selected words out of the video. Double-click fixes a word's text.
// Linked with the timeline both ways (selected words light up on V1, the selected clip's words
// light up here); cut words can be shown struck through and restored; find & replace.
import { Replace, Search, Undo2 } from "lucide-preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { draftWords, fmtTC, insertClips, isFiller, isGap, newClip, removeWords, starts, updateClip, deleteClip, type TWord } from "../edit";
import { asset, assetMap, draft, editDraft, mutate, patchAsset, set, startTranscribe, toast, useStore } from "../store";
import type { Word } from "../types";
import { player } from "./Viewer";

/** Words cut out between two neighbouring clips of the same media, shown struck through. */
type Cut = { kind: "cut"; at: number; prev: string; next: string; words: Word[] };

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
  const [showCuts, setShowCuts] = useState(false);
  const [find, setFind] = useState("");
  const [repl, setRepl] = useState<string | null>(null);
  const down = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setSel(null), [src?.id, d?.id, d?.updated]);
  useEffect(() => {
    const up = () => { down.current = null; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const lo = sel ? Math.min(sel[0], sel[1]) : -1, hi = sel ? Math.max(sel[0], sel[1]) : -1;
  const selected = sel ? words.slice(lo, hi + 1) : [];

  // Selected words → highlighted ranges on the timeline.
  useEffect(() => {
    const rs: [number, number][] = !src && selected.length ? [[selected[0].t0, selected[selected.length - 1].t1]] : [];
    if (JSON.stringify(rs) !== JSON.stringify(s.trRanges)) set({ trRanges: rs });
  }, [lo, hi, src?.id]);
  useEffect(() => () => set({ trRanges: [] }), []);

  const now = src ? player.srcT : s.playhead;
  const cur = words.findIndex((w) => now >= w.t0 && now < w.t1 + 0.05);
  useEffect(() => {
    if (!player.playing || cur < 0) return;
    (box.current?.querySelector(`[data-i="${cur}"]`) as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }, [cur]);
  // The clip selected on the timeline: scroll to its words (not when the click came from here).
  const fromHere = useRef(false);
  useEffect(() => {
    if (!s.selClip) return;
    if (fromHere.current) { fromHere.current = false; return; }
    (box.current?.querySelector(`[data-clip="${s.selClip}"]`) as HTMLElement | null)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [s.selClip]);

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

  const missing = d ? [...new Set(d.clips.filter((c) => !isGap(c)).map((c) => c.asset))].map((id) => asset(id)!).filter((a) => a && a.info.has_audio && !a.words) : [];

  // Cuts between neighbouring clips of the same media.
  const cuts: Cut[] = useMemo(() => {
    if (src || !d || !showCuts) return [];
    const out: Cut[] = [];
    const ss = starts(d);
    for (let i = 1; i < d.clips.length; i++) {
      const p = d.clips[i - 1], n = d.clips[i];
      if (p.asset !== n.asset || isGap(p) || n.start <= p.end + 0.05) continue;
      const ws = (asset(p.asset)?.words ?? []).filter((w) => (w.s + w.e) / 2 >= p.end && (w.s + w.e) / 2 < n.start);
      if (ws.length) out.push({ kind: "cut", at: ss[i], prev: p.id, next: n.id, words: ws });
    }
    return out;
  }, [d?.updated, showCuts, src?.id]);

  const restore = (c: Cut) => {
    editDraft("잘린 말 되살리기", (x) => {
      const p = x.clips.find((y) => y.id === c.prev), n = x.clips.find((y) => y.id === c.next);
      if (!p || !n) return x;
      if (p.speed === n.speed) return deleteClip(updateClip(x, p.id, { end: n.end, fadeOut: n.fadeOut }), n.id);
      return updateClip(x, p.id, { end: n.start });
    });
    player.refresh();
  };

  // Find & replace (word text only; the picture is not touched).
  const fq = find.trim();
  const isHit = (t: string) => !!fq && t.includes(fq);
  const hits = fq ? words.filter((w) => isHit(w.t)).length : 0;
  const replaceAll = () => {
    if (!fq || repl == null) return;
    const ids = new Set(words.map((w) => w.asset));
    let n = 0;
    mutate((p) => ({ ...p, assets: p.assets.map((a) => (ids.has(a.id) && a.words ? { ...a, words: a.words.map((w) => (w.t.includes(fq) ? (n++, { ...w, t: w.t.split(fq).join(repl) }) : w)) } : a)) }));
    toast(`${n}곳을 바꿨습니다 (자막에도 반영)`);
  };

  // Paragraphs at clip changes and long pauses, with cuts placed between them.
  type Para = { start: number; items: (number | Cut)[] };
  const paras: Para[] = [];
  let ci = 0;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    while (ci < cuts.length && cuts[ci].at <= w.t0 + 1e-6) {
      if (!paras.length) paras.push({ start: cuts[ci].at, items: [] });
      paras[paras.length - 1].items.push(cuts[ci++]);
    }
    if (!prev || prev.clip !== w.clip || w.t0 - prev.t1 > 1.2) paras.push({ start: w.t0, items: [] });
    paras[paras.length - 1].items.push(i);
  });

  return (
    <div class="transcript">
      <div class="tr-head">
        {src ? <b>원본 대본: {src.info.name}</b> : <b>편집본 대본</b>}
        <span class="spacer" />
        {!src && <label class="check small" title="같은 영상에서 잘라 낸 말을 줄을 그어 보여 줍니다"><input type="checkbox" checked={showCuts} onChange={(e) => setShowCuts((e.target as HTMLInputElement).checked)} /> 잘린 말 보기</label>}
        {selected.length > 0 && (src ? (
          <button class="small primary" onClick={insertSel}>선택 구간 편집본에 넣기</button>
        ) : (
          <button class="small danger" onClick={cut}>선택한 말 지우기 ({selected.length})</button>
        ))}
      </div>
      <div class="tr-find">
        <Search size={13} aria-hidden="true" />
        <input placeholder="대본에서 찾기" aria-label="대본에서 찾기" value={find} onInput={(e) => setFind((e.target as HTMLInputElement).value)} />
        {fq && <span class="muted">{hits}곳</span>}
        <button class={`icon-btn ${repl != null ? "on" : ""}`} aria-label="바꾸기" title="바꾸기" onClick={() => setRepl(repl == null ? "" : null)}><Replace size={14} /></button>
      </div>
      {repl != null && (
        <div class="tr-find">
          <input placeholder="바꿀 말" aria-label="바꿀 말" value={repl} onInput={(e) => setRepl((e.target as HTMLInputElement).value)} />
          <button class="small" disabled={!fq || !hits} onClick={replaceAll}>모두 바꾸기</button>
        </div>
      )}
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
            {p.items.map((it) => {
              if (typeof it !== "number") return (
                <span class="cutw" title="잘라 낸 말 (눌러서 되살리기)">
                  <s>{it.words.map((w) => w.t).join(" ")}</s>
                  <button class="tb" aria-label="되살리기" onClick={() => restore(it)}><Undo2 size={11} /></button>{" "}
                </span>
              );
              const i = it, w = words[i];
              if (editing === i) {
                return <input class="wedit" autoFocus defaultValue={w.t} size={Math.max(2, w.t.length + 1)} aria-label="단어 고치기"
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
                <span data-i={i} data-clip={w.clip || undefined}
                  class={`w ${i === cur ? "cur" : ""} ${i >= lo && i <= hi ? "sel" : ""} ${isFiller(w.t) ? "filler" : ""} ${!src && s.selClip === w.clip ? "inclip" : ""} ${isHit(w.t) ? "hit" : ""}`}
                  onMouseDown={(e) => { if (e.button !== 0) return; down.current = i; setSel(e.shiftKey && sel ? [sel[0], i] : [i, i]); }}
                  onMouseEnter={() => { if (down.current != null) setSel([down.current, i]); }}
                  onClick={(e) => { if (!e.shiftKey && lo === hi) { player.seek(w.t0 + 0.001); if (!src && w.clip && s.selClip !== w.clip) { fromHere.current = true; set({ selClip: w.clip, selItem: null }); } } }}
                  onDblClick={() => setEditing(i)}
                >{w.t} </span>
              );
            })}
          </p>
        ))}
        {!words.length && !src && !missing.length && <p class="muted pad">편집본에 대사가 있는 클립이 없습니다.</p>}
      </div>
      <div class="muted tip">클릭: 그 위치로 · 끌어서 고른 뒤 Delete: 영상에서 잘라 내기 · 두 번 클릭: 글자 고치기 (자막에 반영)</div>
    </div>
  );
}
