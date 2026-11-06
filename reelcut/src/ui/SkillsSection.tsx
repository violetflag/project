// Skills in settings: the user's own (written here, by the AI, or pasted in) and those that come with the app.
import { openChat } from "./layout";
import { useState } from "preact/hooks";
import { ask } from "../agent";
import { BUILTIN_SKILLS, cleanSkillName, isChain, mergeSkills, skillFromText, skillToText, upsertSkill } from "../skills";
import { saveSkills, set, st, toast, useStore } from "../store";
import type { ChainStep, Skill } from "../types";

const copy = (s: Skill) => navigator.clipboard.writeText(skillToText(s)).then(() => toast("스킬을 글로 복사했습니다"));

/** The steps of a merged skill: added from the list, moved, named, taken out. */
function StepsEditor({ steps, onChange }: { steps: ChainStep[]; onChange: (s: ChainStep[]) => void }) {
  const s = useStore();
  const move = (i: number, by: number) => { const n = [...steps]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x); onChange(n); };
  return (
    <div class="steps-editor">
      {steps.map((x, i) => (
        <div class="row step-row" key={`${x.skill}-${i}`}>
          <span class="step-no">{i + 1}</span>
          <input value={x.label ?? ""} placeholder={x.skill} aria-label={`${i + 1}단계 이름`} onInput={(e) => onChange(steps.map((y, j) => (j === i ? { ...y, label: (e.target as HTMLInputElement).value } : y)))} />
          <span class="muted step-skill">{x.skill}</span>
          <button class="tb" disabled={i === 0} aria-label={`${i + 1}단계 위로`} onClick={() => move(i, -1)}>↑</button>
          <button class="tb" disabled={i === steps.length - 1} aria-label={`${i + 1}단계 아래로`} onClick={() => move(i, 1)}>↓</button>
          <button class="tb" aria-label={`${i + 1}단계 빼기`} onClick={() => onChange(steps.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <label>단계 더하기
        <select value="" onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) onChange([...steps, { skill: v }]); (e.target as HTMLSelectElement).value = ""; }}>
          <option value="">스킬 고르기…</option>
          {[...s.skills, ...BUILTIN_SKILLS].filter((k) => !isChain(k)).map((k) => <option value={k.name}>{k.name} · {k.description}</option>)}
        </select>
      </label>
    </div>
  );
}

export function SkillsSection() {
  const s = useStore();
  const [draft, setDraft] = useState<Skill | null>(null);
  const [paste, setPaste] = useState("");
  const [idea, setIdea] = useState("");
  const [q, setQ] = useState("");
  const [merge, setMerge] = useState<{ name: string; description: string; steps: ChainStep[] } | null>(null);
  const add = (k: Skill) => { try { saveSkills(upsertSkill(s.skills, k)); return true; } catch (e) { toast(String((e as Error).message ?? e)); return false; } };
  const edit = (name: string, patch: Partial<Skill>) => saveSkills(s.skills.map((x) => (x.name === name ? { ...x, ...patch } : x)));
  const ql = q.trim().toLowerCase();
  const list = BUILTIN_SKILLS.filter((k) => !ql || k.name.includes(ql) || k.description.toLowerCase().includes(ql) || k.triggers?.some((t) => t.toLowerCase().includes(ql)));
  return (
    <>
      <h3 class="sub">AI 스킬 (작업 안내)</h3>
      <p class="muted">AI가 일을 시작하기 전에 읽는 안내입니다. 대화에서 /이름 으로 바로 부를 수 있고, "다음에도 이렇게 해 줘"라고 말하면 AI가 저장합니다.</p>
      <h4 class="sub2">내 스킬 {s.skills.length ? `(${s.skills.length})` : ""}</h4>
      {!s.skills.length && <p class="muted">내가 만든 스킬이 아직 없습니다.</p>}
      {s.skills.map((k) => (
        <details class="skill-row" key={k.name}>
          <summary><b>{k.name}</b> <span class="muted">{k.description}</span></summary>
          <label>설명<input value={k.description} onChange={(e) => edit(k.name, { description: (e.target as HTMLInputElement).value })} /></label>
          <label>떠올릴 말 (쉼표로)<input value={(k.triggers ?? []).join(", ")} onChange={(e) => edit(k.name, { triggers: (e.target as HTMLInputElement).value.split(",").map((t) => t.trim()).filter(Boolean) })} /></label>
          {isChain(k)
            ? <StepsEditor steps={k.steps!} onChange={(steps) => { if (steps.length >= 2) edit(k.name, { steps, body: mergeSkills({ ...k, steps }, s.skills.filter((x) => x.name !== k.name)).body }); else toast("병합 스킬에는 두 단계 이상이 필요합니다"); }} />
            : <label>내용<textarea rows={8} value={k.body} onChange={(e) => edit(k.name, { body: (e.target as HTMLTextAreaElement).value })} /></label>}
          <div class="row">
            <button class="small" onClick={() => copy(k)}>글로 복사</button>
            <button class="small danger" onClick={() => { if (confirm(`스킬 "${k.name}"을 지울까요?`)) saveSkills(s.skills.filter((x) => x.name !== k.name)); }}>지우기</button>
          </div>
        </details>
      ))}
      <div class="row skill-make">
        <button class="small primary" onClick={() => setDraft({ name: "", description: "", triggers: [], body: "" })}>새 스킬 쓰기</button>
        <button class="small" onClick={() => setMerge({ name: "", description: "", steps: [] })}>스킬 합치기</button>
      </div>
      {draft && (
        <div class="skill-form">
          <label>이름<input autoFocus value={draft.name} placeholder="twins_shorts" onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })} /></label>
          <label>설명 (언제 쓰는지 한 줄)<input value={draft.description} onInput={(e) => setDraft({ ...draft, description: (e.target as HTMLInputElement).value })} /></label>
          <label>떠올릴 말 (쉼표로)<input value={(draft.triggers ?? []).join(", ")} onInput={(e) => setDraft({ ...draft, triggers: (e.target as HTMLInputElement).value.split(",").map((t) => t.trim()) })} /></label>
          <label>내용 (AI가 따를 순서)<textarea rows={8} value={draft.body} onInput={(e) => setDraft({ ...draft, body: (e.target as HTMLTextAreaElement).value })} /></label>
          <div class="row">
            <button class="small" onClick={() => setDraft(null)}>취소</button>
            <button class="small primary" disabled={!cleanSkillName(draft.name) || !draft.body.trim()} onClick={() => { if (add(draft)) { setDraft(null); toast("스킬을 저장했습니다"); } }}>저장</button>
          </div>
        </div>
      )}
      {merge && (
        <div class="skill-form">
          <label>합친 스킬 이름<input autoFocus value={merge.name} placeholder="twins_short" onInput={(e) => setMerge({ ...merge, name: (e.target as HTMLInputElement).value })} /></label>
          <label>설명 (없으면 단계 순서)<input value={merge.description} onInput={(e) => setMerge({ ...merge, description: (e.target as HTMLInputElement).value })} /></label>
          <p class="muted tip">앞 단계를 끝까지 마친 뒤 그 결과로 다음 단계를 합니다. 한 단계가 실패하면 거기서 멈춥니다.</p>
          <StepsEditor steps={merge.steps} onChange={(steps) => setMerge({ ...merge, steps })} />
          <div class="row">
            <button class="small" onClick={() => setMerge(null)}>취소</button>
            <button class="small primary" disabled={merge.steps.length < 2 || !cleanSkillName(merge.name)} onClick={() => { try { if (add(mergeSkills(merge, s.skills))) { setMerge(null); toast("병합 스킬을 저장했습니다"); } } catch (e) { toast(String((e as Error).message ?? e)); } }}>저장</button>
          </div>
        </div>
      )}
      <label>AI에게 맡기기
        <textarea rows={2} value={idea} placeholder="예: 쌍둥이 쇼츠는 세로 15초, 둘 다 나오게, 자막은 pop" onInput={(e) => setIdea((e.target as HTMLTextAreaElement).value)} />
      </label>
      <button class="small" disabled={!idea.trim() || !s.project || s.agentBusy} title={s.project ? "" : "프로젝트를 열면 쓸 수 있습니다"} onClick={() => {
        const want = idea.trim();
        setIdea("");
        set({ route: "project" });
        openChat();
        ask(`get_playbook으로 make_skill 안내를 읽고, 다음 내용을 스킬로 만들어 저장해 줘: ${want}`).catch((e) => toast(String(e)));
      }}>AI로 스킬 만들기</button>
      <label>받은 스킬 글 붙여넣기
        <textarea rows={2} value={paste} placeholder={"---\nname: ...\n---\n내용"} onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)} />
      </label>
      <button class="small" disabled={!paste.trim()} onClick={() => { try { if (add(skillFromText(paste))) { setPaste(""); toast("스킬을 넣었습니다"); } } catch (e) { toast(String((e as Error).message ?? e)); } }}>스킬 넣기</button>
      <h4 class="sub2">앱에 들어 있는 스킬 ({BUILTIN_SKILLS.length})</h4>
      <input class="search" placeholder="스킬 찾기" aria-label="스킬 찾기" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="skill-lib">
        {list.map((k) => (
          <details class="skill-row" key={k.name}>
            <summary><b>{k.name}</b> <span class="muted">{k.description}</span></summary>
            <pre class="skill-body">{k.body}</pre>
            <button class="small" onClick={() => { const name = cleanSkillName(`${k.name}_my`); if (st.skills.some((x) => x.name === name)) return toast(`"${name}"이 이미 있습니다`); if (add({ ...k, name })) toast(`"${name}"으로 복사했습니다. 내 스킬에서 고치세요`); }}>복사해서 고치기</button>
          </details>
        ))}
      </div>
    </>
  );
}
