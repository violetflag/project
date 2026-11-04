// Skills: step-by-step guides the AI reads before a kind of job (get_playbook). A few come with the
// app; the user's own are kept in the app store ("skills") and shared by every project. The AI sees
// only the list (name, description, trigger words) in its instructions and reads a guide when needed.
import { PLAYBOOK_360 } from "./playbook";
import { LIBRARY } from "./skills-lib";
import type { ChainRun, ChainStep, Skill } from "./types";

const VLOG = `# 브이로그 편집 순서

영상 여러 개(또는 긴 영상 하나)로 볼 만한 이야기 한 편을 만듭니다.

## 시작하기 전에
- get_project_overview로 무엇이 있는지 봅니다. 촬영 시각이 있으면 시간순으로 정리합니다. 카메라가 여럿이면 시계가 다를 수 있으니, 같은 순간을 찍었으면 sync_media로 맞춥니다.
- 길이와 올릴 곳(유튜브, 쇼츠, 가족 공유)을 모르면 ask_options로 한 번만 묻고, 고른 대로 이어 갑니다. 맨 앞에 기본값을 둡니다(원본의 1/4, 최대 5분).
- 받아쓰기가 없고 말소리가 있으면 transcribe를 먼저 합니다.

## 고르기
1. contact_sheet로 전체를 훑고, 본 것을 save_scene_notes로 남깁니다. 나중에 search_scenes로 찾을 수 있습니다.
2. scan_bad_shots로 흐리거나 흔들린 구간을 확인하고 피합니다.
3. 이야기의 모양을 정합니다: 어디 갔는지 보여 주는 시작, 가장 즐거운 순간들, 마무리. 첫 5초 안에 가장 눈길을 끄는 장면이나 말을 둡니다.
4. 같은 순간을 두 번 쓰지 않습니다. 비슷한 장면이 이어지면 가장 좋은 하나만 남깁니다.
5. 한 컷은 보통 3~10초, 말이 있는 장면은 말이 끝날 때까지. 넓은 장면과 가까운 장면을 번갈아 씁니다.

## 만들기
6. create_draft로 편집본을 만들고 snap_cuts로 컷을 말 틈에 맞춥니다.
7. 사진은 set_motion(zoom_in 등)으로 움직임을 줍니다. 전환은 장소가 바뀔 때만 edit_draft의 transition으로 넣고, 나머지는 컷으로 둡니다.
8. 음악을 넣으면 fit_music으로 길이를 맞추고, 말이 있는 곳은 set_volume_keys로 음악을 줄입니다.
9. 첫머리에 add_text로 제목이나 장소·날짜 핀을 넣습니다. 말이 많으면 set_captions로 자막을 켭니다.
10. auto_color로 색을 맞춥니다. 카메라가 달라 색이 다를 때 특히 좋습니다.

## 끝내기 전 확인
- get_draft로 길이와 순서를 봅니다. view_frames로 첫 컷과 몇 군데를 직접 봅니다.
- 처음 요청과 맞는지 확인하고, 무엇을 했는지와 고칠 만한 점을 짧게 알려 줍니다.
`;

const HIGHLIGHTS = `# 하이라이트·쇼츠 후보 고르기

## 순서
1. 받아쓰기(get_transcript)와 장면 설명(search_scenes, contact_sheet)으로 재미있거나 감동적인 순간을 찾습니다. 말이 있으면 앞뒤 맥락 없이도 이해되는 구간을 고릅니다.
2. scan_bad_shots로 흔들리거나 흐린 구간은 뺍니다.
3. 후보를 세 개 고릅니다(각 15~60초, 서로 다른 순간). 각각 제목과 고른 이유를 한 줄로 적습니다.
4. ask_options로 후보를 보여 줍니다. 각 선택지의 meaning에 시작·끝 시각과 만들 내용을 적어 두면, 고른 것이 그대로 돌아옵니다.
5. 돌아온 후보로 create_draft(aspect 9:16)를 하고, 첫 3초에 가장 눈길을 끄는 순간이 오게 합니다. 자막은 set_captions의 style "pop", 360 영상이면 frame_subject로 사람을 따라갑니다.
`;

const TALK = `# 말하는 영상 다듬기

## 순서
1. 받아쓰기가 없으면 transcribe. 대본을 읽고 어떤 내용인지 파악합니다.
2. 틀린 시작, 같은 말 반복은 대본을 보고 더 나은 쪽만 남깁니다(edit_draft의 remove_range).
3. remove_fillers로 "음", "어"를 지웁니다.
4. remove_silences의 pacing은 보통 normal. 활기 있게 하려면 tight, 차분하면 gentle. 말의 끝이 잘리지 않았는지 view_frames가 아니라 대본 시각으로 확인합니다.
5. set_captions로 자막을 켜고 고유명사 오타가 많으면 알려 줍니다.
`;

const SLIDESHOW = `# 사진으로 영상 만들기

## 순서
1. get_project_overview에서 사진을 촬영 순서로 봅니다. 비슷한 사진은 가장 좋은 것만 씁니다(view_frames로 확인).
2. create_draft로 사진마다 3~5초 클립을 넣습니다.
3. 사진마다 set_motion을 넣되 같은 움직임이 계속되지 않게 zoom_in, pan_right, zoom_out, pan_left를 번갈아 씁니다.
4. 음악을 넣고 fit_music으로 길이를 맞춥니다. 전환은 edit_draft의 transition으로 fade를 짧게(0.5초).
5. add_text로 제목과 날짜를 넣습니다.
`;

export const BUILTIN_SKILLS: Skill[] = [
  { name: "360_auto_edit", description: "360 영상을 사람(쌍둥이 포함) 따라가며 자동 편집", triggers: ["360", "리프레임", "따라가", "쌍둥이"], body: PLAYBOOK_360 },
  { name: "vlog_edit", description: "영상 여러 개로 브이로그 한 편 만들기", triggers: ["브이로그", "vlog", "여행 영상", "나들이"], body: VLOG },
  { name: "highlights", description: "하이라이트·쇼츠 후보를 제안하고 고른 것으로 만들기", triggers: ["하이라이트", "쇼츠", "숏폼", "릴스"], body: HIGHLIGHTS },
  { name: "talk_cleanup", description: "말하는 영상의 군더더기와 무음 다듬기", triggers: ["무음", "군더더기", "강의", "인터뷰"], body: TALK },
  { name: "photo_slideshow", description: "사진으로 음악 있는 영상 만들기", triggers: ["사진", "슬라이드"], body: SLIDESHOW },
  ...LIBRARY,
];

/** A name the app can store: lowercase letters, numbers, - and _ (other languages' letters too). */
export function cleanSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 40);
}

export function findSkill(user: Skill[], name: string): Skill | null {
  const n = cleanSkillName(name);
  return user.find((s) => s.name === n) ?? BUILTIN_SKILLS.find((s) => s.name === n) ?? null;
}

/** Adds or replaces a user's skill; the guides that come with the app keep their names. */
export function upsertSkill(user: Skill[], s: Skill): Skill[] {
  const name = cleanSkillName(s.name);
  if (!name) throw new Error("스킬 이름이 비었습니다");
  if (BUILTIN_SKILLS.some((b) => b.name === name)) throw new Error(`"${name}"은 앱에 들어 있는 이름입니다. 다른 이름을 쓰세요`);
  if (!s.body.trim()) throw new Error("스킬 내용이 비었습니다");
  const next: Skill = { name, description: s.description.replace(/<\/?[a-z_]+>/g, "").trim().slice(0, 200), triggers: (s.triggers ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 16), body: s.body, ...(s.steps?.length ? { steps: s.steps } : {}) };
  return [next, ...user.filter((x) => x.name !== name)];
}

/** The list the AI sees in its instructions; the user's come first so they win over a similar built-in. */
export function skillCatalog(user: Skill[]): string {
  const line = (s: Skill) => `- ${s.name}: ${s.description}${s.steps?.length ? ` [병합 스킬: ${s.steps.map(stepLabel).join(" → ")}. run_merged_skill로 실행]` : ""}${s.triggers?.length ? ` (${s.triggers.join(", ")})` : ""}`;
  return ["## 작업 안내(스킬)", "요청이 아래 작업에 맞으면 시작하기 전에 get_playbook으로 그 안내를 읽고 따르세요. 사용자가 만든 것이 우선입니다.", ...(user.length ? ["사용자가 만든 것:", ...user.map(line)] : []), "앱에 들어 있는 것:", ...BUILTIN_SKILLS.map(line), "사용자가 \"다음에도 이렇게\", \"이 규칙을 기억해\"처럼 말하면 save_skill로 저장합니다."].join("\n");
}

/** A skill as one piece of text, to hand to someone or keep. */
export function skillToText(s: Skill): string {
  return ["---", `name: ${s.name}`, `description: ${s.description}`, `triggers: ${(s.triggers ?? []).join(", ")}`, ...(s.steps?.length ? [`steps: ${s.steps.map((x) => (x.label ? `${x.skill} | ${x.label}` : x.skill)).join(", ")}`] : []), "---", "", s.body].join("\n");
}
export function skillFromText(text: string): Skill {
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("스킬 글은 ---로 시작하는 머리말이 있어야 합니다");
  const field = (k: string) => new RegExp(`^${k}:[ \\t]*(.*)$`, "m").exec(m[1])?.[1].trim() ?? "";
  const name = cleanSkillName(field("name"));
  if (!name) throw new Error("머리말에 name이 없습니다");
  const steps = field("steps").split(",").map((t) => t.trim()).filter(Boolean).map((t) => { const [skill, label] = t.split("|").map((x) => x.trim()); return { skill: cleanSkillName(skill), ...(label ? { label } : {}) }; });
  return { name, description: field("description"), triggers: field("triggers").split(",").map((t) => t.trim()).filter(Boolean), body: m[2].trim(), ...(steps.length ? { steps } : {}) };
}

/** "/a /b what to do" in the chat box: the skills named at the start, and the rest of the text. */
export function parseSkillCommand(text: string, user: Skill[]): { names: string[]; rest: string } {
  const names: string[] = [];
  let rest = text.trim();
  for (;;) {
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(rest);
    const k = m && findSkill(user, m[1]);
    if (!k) return { names, rest };
    names.push(k.name);
    rest = m![2];
  }
}

// ---------------------------------------------------------------- merged skills

export const isChain = (s: Skill | null | undefined) => !!s?.steps?.length;
export const stepLabel = (st: ChainStep) => st.label?.trim() || st.skill;

/** A merged skill from two or more others; a merged skill among them is opened into its own steps. */
export function mergeSkills(o: { name: string; description?: string; triggers?: string[]; steps: ChainStep[] }, user: Skill[]): Skill {
  const steps: ChainStep[] = o.steps.flatMap((x) => {
    const k = findSkill(user, x.skill);
    if (!k) throw new Error(`없는 스킬: ${x.skill}`);
    return k.steps?.length ? k.steps : [{ skill: k.name, ...(x.label?.trim() ? { label: x.label.trim() } : {}) }];
  });
  if (steps.length < 2) throw new Error("합치려면 스킬이 두 개 이상 있어야 합니다");
  const name = cleanSkillName(o.name);
  if (!name) throw new Error("합친 스킬의 이름이 비었습니다");
  if (steps.some((x) => x.skill === name)) throw new Error(`"${name}"은 자기 자신을 단계로 넣을 수 없습니다`);
  const order = steps.map(stepLabel).join(" → ");
  return { name, description: o.description?.trim() || order, triggers: o.triggers ?? [], steps, body: `# ${name}\n\n병합 스킬입니다. run_merged_skill로 실행하면 앱이 차례대로 시킵니다: ${order}` };
}

/** The skills a merged skill runs; a step whose skill has since been removed is an error by name. */
export function chainSkills(chain: Skill, user: Skill[]): { step: ChainStep; skill: Skill }[] {
  return (chain.steps ?? []).map((step, i) => {
    const skill = findSkill(user, step.skill);
    if (!skill) throw new Error(`${i + 1}단계 스킬 "${step.skill}"이 없습니다. 병합 스킬 "${chain.name}"을 고쳐 주세요`);
    return { step, skill };
  });
}

export type StepResult = { ok: boolean; summary: string; items?: unknown[] };

/** Runs steps in order, each given the results of all before it; the first failure stops the rest. */
export async function runChainSteps(labels: string[], runStep: (i: number, prev: string) => Promise<StepResult>, onChange: (states: ChainRun["steps"]) => void): Promise<{ ok: boolean; failed?: number; message: string }> {
  const states: ChainRun["steps"] = labels.map((label) => ({ label, state: "wait" }));
  const show = () => onChange(states.map((x) => ({ ...x })));
  const results: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    states[i].state = "run";
    show();
    let r: StepResult;
    try { r = await runStep(i, results.join("\n")); } catch (e) { r = { ok: false, summary: String((e as Error)?.message ?? e) }; }
    states[i] = { ...states[i], state: r.ok ? "done" : "fail", note: r.summary };
    if (!r.ok) {
      for (let j = i + 1; j < labels.length; j++) states[j].state = "skip";
      show();
      return { ok: false, failed: i, message: `${i + 1}/${labels.length}단계 "${labels[i]}"에서 멈췄습니다: ${r.summary}` };
    }
    results.push(`[${i + 1}. ${labels[i]}] ${r.summary}${r.items?.length ? `\n목록: ${JSON.stringify(r.items)}` : ""}`);
    show();
  }
  return { ok: true, message: `${labels.length}단계를 모두 마쳤습니다.` };
}

/** Tools that change the work: while one step runs, those only a later step's guide names must wait. */
const CHANGES_WORK = new Set(["create_draft", "edit_draft", "delete_draft", "remove_silences", "remove_fillers", "add_markers", "set_captions", "edit_captions", "fix_words", "set_translation", "auto_color", "set_look", "paste_attributes", "set_motion", "set_volume_keys", "fit_music", "add_text", "remove_text", "frame_subject", "trim_to_subjects", "snap_cuts", "multicam_draft", "sync_media", "organize_media", "export_draft"]);
const names = (body: string, tool: string) => new RegExp(`\\b${tool}\\b`).test(body);

/** The later step a tool belongs to, when using it now would be doing that step's job early. */
export function laterStepOf(tool: string, current: Skill, later: { label: string; skill: Skill }[]): string | null {
  if (!CHANGES_WORK.has(tool) || names(current.body, tool)) return null;
  return later.find((x) => names(x.skill.body, tool))?.label ?? null;
}

/** What the AI is told for one step of a merged skill. */
export function chainStepNote(chainName: string, labels: string[], i: number, skill: Skill, request: string, prev: string): string {
  return [
    `<merged-skill>병합 스킬 "${chainName}"의 ${i + 1}/${labels.length}단계 "${labels[i]}"입니다. 이번 차례에는 이 단계의 일만 합니다.`,
    `이 단계의 안내입니다(get_playbook으로 다시 읽을 필요 없습니다):\n${skill.body}`,
    `이번 작업의 전체 목표입니다. 이 단계에 속하는 부분만 참고하세요: ${request || "(따로 없음)"}`,
    prev ? `앞 단계의 결과입니다. 다시 찾지 말고 이것을 그대로 이어서 씁니다:\n${prev}` : "",
    labels[i + 1] ? `다음 단계 "${labels.slice(i + 1).join('", "')}"의 일은 지금 하지 마세요. 앱이 이어서 시키며, 그 단계의 도구는 지금 막혀 있습니다.` : "이것이 마지막 단계입니다.",
    `끝나면 finish_step을 부르세요. ok는 해냈는지, summary는 결과나 못 한 이유입니다. 결과가 여러 개이면(장면 구간 등) 하나씩 items에 넣습니다. 예: [{"asset_id":"…","from":284,"to":299,"note":"둘이 함께"}]. 다음 단계는 이 목록만 받습니다.</merged-skill>`,
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- skills in force together

/** A picked skill goes last, since the later pick wins. */
export const addActive = (list: string[] | undefined, name: string) => [...(list ?? []).filter((x) => x !== name), name];

/** The share of the context skills in force may take, in tokens. */
export const activeBudget = (limit: number) => Math.min(20000, Math.round(limit * 0.1));

/** What the AI needs to be told about the skills in force: the full text only of those it has not read. */
export function activeNote(user: Skill[], active: string[] | undefined, sent: string[] | undefined): { note: string; sent: string[] } {
  const on = (active ?? []).map((n) => findSkill(user, n)).filter((k): k is Skill => !!k && !isChain(k));
  const names = on.map((k) => k.name);
  const off = (sent ?? []).filter((n) => !names.includes(n));
  if (!on.length && !off.length) return { note: "", sent: [] };
  const fresh = on.filter((k) => !sent?.includes(k.name));
  const lines = ["<active-skills>"];
  if (on.length) lines.push(`이 대화에 켜 둔 스킬입니다(고른 순서): ${names.join(", ")}. ${on.length > 1 ? "모두 함께 지킵니다. 규칙이 서로 맞지 않으면 어떤 규칙이 부딪히는지 사용자에게 한 줄로 말하고, 나중에 고른 스킬을 따르세요." : "이 스킬을 지킵니다."}`);
  if (off.length) lines.push(`다음 스킬은 꺼졌습니다. 더는 따르지 마세요: ${off.join(", ")}`);
  for (const k of fresh) lines.push(`## ${k.name}\n${k.body}`);
  lines.push("</active-skills>");
  return { note: lines.join("\n"), sent: names };
}

export type Step = { tool: string; input?: Record<string, unknown> };

/** Tools a batch may not call: itself, and those that wait for the user or read a guide. */
export const NOT_IN_BATCH = new Set(["run_steps", "run_script", "ask_options", "get_playbook", "finish_step", "run_merged_skill"]);
