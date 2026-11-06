// Captions tab: every line with its text, changed by hand or with the AI (spelling, translation).
import { useMemo, useState } from "preact/hooks";
import { draftCaptions, joinNext, moveWordNext, moveWordPrev, setBreak, setHidden, setLineText, wordKey, type Line } from "../captions";
import { ask } from "../agent";
import { draftWords, fmtTC } from "../edit";
import { assetMap, draft, editDraft, set, useStore } from "../store";
import type { CapEdits, Translation } from "../types";
import { openChat } from "./layout";
import { player } from "./Viewer";

const LANGS = ["영어", "일본어", "중국어", "스페인어", "프랑스어", "독일어", "베트남어", "한국어"];

function runAi(prompt: string) {
  openChat();
  ask(prompt).catch((e) => set({ agentStatus: String(e) }));
}

export function CaptionsPanel() {
  const s = useStore();
  const d = draft();
  const [lang, setLang] = useState("영어");
  const caps = useMemo(() => (d ? draftCaptions(d, draftWords(d, assetMap())) : null), [d?.updated, d?.id, s.project?.assets]);
  if (!d || !caps) return <div class="pane-note muted">편집본을 먼저 여세요.</div>;
  const change = (label: string, e: CapEdits | ((c: CapEdits | undefined) => CapEdits)) =>
    editDraft(label, (x) => ({ ...x, capEdits: typeof e === "function" ? e(x.capEdits) : e }), d.id, false);
  const trOf = (l: Line) => d.translation?.items.find((i) => i.from === l.key);
  const setTr = (l: Line, text: string) => editDraft("번역 고치기", (x) => {
    const t: Translation = x.translation ?? { lang, items: [] };
    return { ...x, translation: { ...t, items: t.items.map((i) => (i.from === l.key ? { ...i, text } : i)) } };
  }, d.id, false);
  return (
    <div class="caps-panel">
      <div class="caps-head">
        <label class="check"><input type="checkbox" checked={d.captions} onChange={(e) => editDraft("자막", (x) => ({ ...x, captions: (e.target as HTMLInputElement).checked }), d.id, false)} /> 자막 켜기</label>
        {d.translation?.items.length ? (
          <label>보이기
            <select value={d.capShow ?? "orig"} onChange={(e) => editDraft("자막 보이기", (x) => ({ ...x, capShow: (e.target as HTMLSelectElement).value as any }), d.id, false)}>
              <option value="orig">원문</option><option value="tr">{d.translation.lang}</option><option value="both">둘 다</option>
            </select>
          </label>
        ) : null}
      </div>
      <div class="caps-ai">
        <button class="small" disabled={s.agentBusy || !caps.lines.length} onClick={() => runAi("이 편집본 자막의 맞춤법과 띄어쓰기를 get_captions로 읽고 edit_captions의 fix_word로 고쳐 줘. 사람 이름이나 말투는 바꾸지 말고, 고친 것을 짧게 알려 줘.")}>맞춤법 고치기 (AI)</button>
        <select value={lang} onChange={(e) => setLang((e.target as HTMLSelectElement).value)} aria-label="번역할 언어">{LANGS.map((l) => <option value={l}>{l}</option>)}</select>
        <button class="small" disabled={s.agentBusy || !caps.lines.length} onClick={() => runAi(`이 편집본 자막을 get_captions로 읽고 ${lang}로 번역해서 set_translation으로 넣어 줘(lang: "${lang}", show: "both"). 줄마다 자연스럽고 짧게.`)}>번역 (AI)</button>
      </div>
      {!caps.lines.length && <p class="pane-note muted">자막으로 쓸 말이 없습니다. 먼저 받아쓰기를 하세요.</p>}
      <div class="caps-list">
        {caps.lines.map((l, i) => {
          const next = caps.lines[i + 1], prev = caps.lines[i - 1], tr = trOf(l);
          const on = s.playhead >= l.t0 && s.playhead < l.t1;
          return (
            <div class={`cap-row ${on ? "on" : ""} ${l.hidden ? "off" : ""}`} key={l.key}>
              <a class="cap-time" onClick={() => player.seek(l.t0)}>{fmtTC(l.t0)}</a>
              <input value={l.text.replace(/\n/g, " ")} aria-label="자막 글" onFocus={() => player.seek(l.t0)}
                onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (v.trim() && v !== l.text.replace(/\n/g, " ")) change("자막 고치기", setLineText(d.capEdits, l, v)); }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !l.words || l.custom) return;
                  // Enter breaks the line at the cursor.
                  const el = e.target as HTMLInputElement;
                  const count = el.value.slice(0, el.selectionStart ?? 0).trim().split(/\s+/).filter(Boolean).length;
                  if (count > 0 && count < l.words.length) change("자막 나누기", setBreak(d.capEdits, wordKey(l.words[count]), "break"));
                }} />
              {tr && <input class="cap-tr" value={tr.text} aria-label={`${d.translation?.lang} 번역`} onChange={(e) => setTr(l, (e.target as HTMLInputElement).value)} />}
              <div class="cap-acts">
                {prev && !l.custom && <button class="tb" title="첫 단어를 앞 줄로" onClick={() => change("단어 앞 줄로", moveWordPrev(d.capEdits, l))}>↤ 단어</button>}
                {next && !l.custom && <button class="tb" title="끝 단어를 다음 줄로" onClick={() => change("단어 다음 줄로", moveWordNext(d.capEdits, l, next))}>단어 ↦</button>}
                {next && <button class="tb" title="다음 줄과 합치기" onClick={() => change("자막 합치기", joinNext(d.capEdits, next))}>합치기</button>}
                <button class="tb" onClick={() => change(l.hidden ? "자막 보이기" : "자막 숨기기", setHidden(d.capEdits, l.key ?? "", !l.hidden))}>{l.hidden ? "보이기" : "숨기기"}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
