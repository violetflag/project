// The editing agent: a tool-use loop against the Claude Messages API (called from Rust).
// The transcript is append-only (preserved thinking): `system` and `tools` never change, the
// project state goes into each user turn, and every response's content is kept as returned.
import { api, onEvent } from "./api";
import {
  clipDur, cutSource, DEFAULT_COLOR, DEFAULT_TRANSFORM, deleteClip, detachAudio, draftDuration, draftWords, fmtTC, insertClips, is360, isDefaultColor, isDefaultTransform, isFiller, isGap, moveClip,
  newClip, newDraft, newGap, newOverlay, r3, removeFillers, removeItem, removeRange, removeSilences, setTransition, splitAt, speechFromWave, speechFromWords, starts, transcriptText, uid, updateClip, updateOverlay, viewAt,
  fitMusic, movePreset, overlays,
  LOOKS, multicamDraft,
  GAZE_MIN_FACE_360,
  splitOutName,
  gazeSpans,
  pasteAttrs,
  type Pacing, mergeScenes, searchScenes,
} from "./edit";
import { exportAndWait } from "./exporter";
import { CAPTION_PRESETS, TEXT_KINDS } from "./graphics";
import { applyVerdicts, badSpans, capView, cleanKeys, easePitch, frameGroup, frameSubject, lookSummary, normView, percentOk, sampleKeys, saneMarks, snapRanges, subjectLooks, thinMarks, type Mark, type Subject, type SubjectLook } from "./framing";
import { activeBudget, activeNote, addActive, BUILTIN_SKILLS, chainSkills, chainStepNote, cleanSkillName, cleanSummary, findSkill, isChain, laterStepOf, looksForPeople, mergeSkills, NOT_IN_BATCH, panoramaTimes, parseSkillCommand, rangeFromText, runChainSteps, skillCatalog, stepLabel, upsertSkill, type Step, type StepResult } from "./skills";
import { compactBudget, ctxLimit, estTokens, fmtK, needsCompaction, newSession, recentWithin, seedText, SUMMARY_REQUEST, titleFrom } from "./chats";
import { activeChat, asset, assetMap, editDraft, saveSkills, syncAssets, loadWave, mutate, mutateChat, patchAsset, saveNow, scanShots, set, setDrafts, startTranscribe, st, toast, waitJob, waves } from "./store";
import SDK_TYPES from "../sdk/reelcut.d.ts?raw";
import { LEVEL_VIEW_RULE, PEOPLE_360_RULE } from "./playbook";
import { runScript, stopScript } from "./script";
import { captionLines, draftCaptions, joinNext, moveWordPrev, setBreak, setHidden, setLineText, wordKey } from "./captions";
import type { AnimKey, Asset, ChatBlock, Clip, ChoiceCard, ChatMsg, ChatSession, Draft, Skill, TextItem, View, ViewKey, VolKey } from "./types";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];
export const EFFORTS = [
  { id: "low", label: "낮음" }, { id: "medium", label: "보통" }, { id: "high", label: "높음" }, { id: "xhigh", label: "매우 높음" }, { id: "max", label: "최대" },
];

const SYSTEM = `당신은 Reelcut의 영상 편집 에이전트입니다. Reelcut은 한 사람이 자기 PC에서 쓰는 영상 편집 앱입니다.
사용자는 한국어로 말합니다. 항상 한국어로, 짧고 분명하게 답하세요.

## 앱의 구조
- 프로젝트 안에 미디어(영상·소리·사진)와 편집본(draft)이 있습니다.
- 편집본의 본편 트랙(V1)은 클립을 순서대로 이어 붙인 것입니다. 클립은 미디어의 [start, end) 구간(원본 초)이고, 속도·음량·360 시점(yaw/pitch/roll/hfov)·변형(위치/크기/회전/자르기/불투명도)·색(노출/대비/채도/색온도/LUT)·앞 클립과의 디졸브(xin 초)를 가집니다. 빈칸(gap) 클립도 있습니다.
- V2/V3 트랙에는 본편 위에 겹치는 영상·사진(화면 속 화면, 로고)이 타임라인 시간(at)에 놓입니다.
- 소리 트랙: A1(클립에서 분리한 소리, J·L컷), A2(배경음악), A3(효과음). 마커, 받아쓰기 자막(captions)이 있습니다.
- 본편이 바뀌면 V2/V3·A1·A3는 그 위의 그림을 따라 움직이고, A2 음악은 그 자리에 남습니다.
- DJI Osmo 360 파일(.osv, .lrf/.lrv)은 360 영상입니다. 360 클립은 view로 어느 방향을 볼지 정합니다 (yaw: 좌우 -180~180, pitch: 위아래 -90~90, hfov: 화각 20~160, 기본 100).
- 360 클립은 시점을 한 개(view)만 두지 않고 시점 키프레임(view_keys: 원본 시간 t마다 yaw/pitch/roll/hfov)으로 움직일 수 있습니다. 키 사이는 부드럽게 이어집니다(과하게 튀지 않는 곡선). 사람을 따라가는 화면은 frame_subject로 0.1초 간격 키프레임을 만드세요. yaw·roll은 범위를 벗어나도 앱이 -180~180으로 맞춥니다.
- 360 영상을 자동 편집해 달라는 요청이면 먼저 get_playbook으로 작업 순서(360 자동편집)를 읽고 따르세요.
- ${PEOPLE_360_RULE}
- ${LEVEL_VIEW_RULE}
- 시간 단위는 모두 초입니다. 원본 시간(source)과 편집본 타임라인 시간(timeline)을 구분하세요.

## 일하는 방법
- 먼저 get_project_overview로 무엇이 있는지 보고, 대사가 있으면 get_transcript로 내용을 읽으세요. 화면이 중요하면 view_frames나 contact_sheet로 직접 보세요. 보지 않은 장면을 추측해서 설명하지 마세요.
- 받아쓰기가 없는 영상은 transcribe로 먼저 받아쓰기를 하세요.
- 편집은 create_draft(새 편집본) 또는 edit_draft(기존 편집본 수정)로 합니다. 사용자가 새로 만들어 달라고 하지 않으면 지금 열린 편집본을 고칩니다. 크게 바꿀 때는 새 편집본을 만들어 원래 것을 남기는 편이 안전합니다.
- 무음 정리는 remove_silences(pacing: gentle/normal/tight/jump_cut), "음·어" 같은 군더더기 말은 remove_fillers를 쓰세요.
- 모든 편집은 사용자가 되돌리기(Ctrl+Z)로 취소할 수 있습니다.
- 내보내기(export_draft)는 사용자가 요청했을 때만 하세요.
- 끝나면 무엇을 했는지 2~4문장으로 알려 주세요. 편집본 길이, 잘라 낸 양처럼 확인한 숫자를 말하세요.`;

const num = { type: "number" };
const str = { type: "string" };
const allow_steep = { type: "boolean", description: "사용자가 내려다보는 장면이나 넓은 화각을 직접 요청했을 때만 켭니다. 켜지 않으면 시점이 수평 가까이로 맞춰집니다." };
const viewSchema = { type: "object", properties: { yaw: num, pitch: num, roll: num, hfov: num }, description: "360 시점 (도)" };
const viewKeysSchema = { type: "array", items: { type: "object", properties: { t: { ...num, description: "원본 시간(초)" }, yaw: num, pitch: num, roll: num, hfov: num }, required: ["t"] }, description: "시점 키프레임 (키 사이는 부드럽게 이어짐)" };
const draftId = { ...str, description: "편집본 id. 비우면 지금 열린 편집본" };

export const TOOLS = [
  { name: "get_project_overview", description: "프로젝트의 미디어 목록(id, 이름, 길이, 360 여부, 받아쓰기 상태)과 편집본 목록을 봅니다.", input_schema: { type: "object", properties: {} } },
  {
    name: "get_transcript", description: "받아쓰기 내용을 시간과 함께 읽습니다. asset_id를 주면 원본 시간, draft_id를 주거나 둘 다 비우면 열린 편집본의 타임라인 시간입니다.",
    input_schema: { type: "object", properties: { asset_id: str, draft_id: str, from: num, to: num } },
  },
  {
    name: "search_transcript", description: "모든 미디어의 받아쓰기에서 말(단어·구절)을 찾습니다. 찾은 위치를 원본 시간으로 돌려줍니다.",
    input_schema: { type: "object", properties: { query: str }, required: ["query"] },
  },
  {
    name: "view_frames", description: "미디어의 특정 원본 시간 장면을 이미지로 봅니다 (최대 8장). 360 영상은 view로 볼 방향을 정할 수 있습니다(없으면 정면).",
    input_schema: { type: "object", properties: { asset_id: str, times: { type: "array", items: num }, view: viewSchema }, required: ["asset_id", "times"] },
  },
  {
    name: "contact_sheet", description: "미디어를 일정 간격으로 찍은 장면을 한 장의 격자 이미지로 봅니다(각 칸에 원본 시간 표시). 긴 영상을 훑을 때 씁니다.",
    input_schema: { type: "object", properties: { asset_id: str, start: num, every: { ...num, description: "간격(초)" }, cols: num, rows: num }, required: ["asset_id"] },
  },
  {
    name: "create_draft", description: "새 편집본을 만들고 엽니다. clips는 순서대로 이어 붙일 원본 구간입니다.",
    input_schema: {
      type: "object",
      properties: {
        name: str, aspect: { type: "string", enum: ["16:9", "9:16", "1:1", "4:5"] }, allow_steep,
        clips: { type: "array", items: { type: "object", properties: { asset_id: str, start: num, end: num, speed: num, view: viewSchema, view_keys: viewKeysSchema }, required: ["asset_id", "start", "end"] } },
      },
      required: ["name", "clips"],
    },
  },
  { name: "get_draft", description: "편집본의 클립 목록(id, 미디어, 원본 구간, 타임라인 구간, 속도, 시점), 음악, 마커, 자막 설정을 봅니다.", input_schema: { type: "object", properties: { draft_id: draftId } } },
  {
    name: "edit_draft",
    description: `편집본을 고칩니다. ops를 순서대로 적용합니다. op 종류:
- {op:"insert", asset_id, start, end, index?, speed?, view?, view_keys?}: 클립 넣기 (index 없으면 맨 뒤)
- {op:"delete", clip_id}
- {op:"trim", clip_id, start?, end?}: 원본 구간 바꾸기
- {op:"move", clip_id, index}
- {op:"split", time}: 타임라인 시간에서 자르기
- {op:"remove_range", from, to}: 타임라인 구간 지우기
- {op:"cut_source", clip_id, ranges:[[s,e],…]}: 클립 안의 원본 구간들 지우기
- {op:"set", clip_id, speed?, volume?, view?, fit?("fit"|"fill"), fade_in?, fade_out?, denoise?, transform?:{x,y,scale,rotation,crop_l,crop_r,crop_t,crop_b,opacity}, color?:{exposure,contrast,saturation,temperature}}
  (x/y: 화면 대비 중심 이동 -1~1, scale 1=원래, exposure 스톱 -2~2, contrast/saturation 1=그대로, temperature 6500=그대로)
- {op:"set_view_keys", clip_id, keys:[{t,yaw,pitch,roll,hfov},…], merge?}: 360 클립의 시점 키프레임 (t=원본 초, 키 사이는 부드럽게). merge=true면 기존 키에 더하고 같은 시각은 바꿈. 사람 따라가기는 frame_subject가 더 쉽습니다
- {op:"clear_view_keys", clip_id}: 시점 키프레임 지우기
- {op:"transition", clip_id, seconds, type}: 이 클립과 앞 클립 사이 전환 (0이면 컷). type: fade(디졸브), dissolve, fadeblack, fadewhite, fadegrays, distance, wipeleft/right/up/down, slideleft/right/up/down, smoothleft/right, circleopen, circleclose, circlecrop, rectcrop, vertopen, horzopen, radial, diagtl, diagbr, squeezeh, zoomin, pixelize
- {op:"set_enabled", item_id, enabled}: 클립·V2/V3·소리를 끄고 켭니다. 끈 클립은 자리를 차지한 채 검은 화면과 무음이 됩니다
- {op:"gap", index, seconds}: 빈칸(검은 화면·무음) 넣기
- {op:"detach_audio", clip_id}: 클립 소리를 A1으로 분리
- {op:"rename", name} / {op:"aspect", aspect}
- {op:"add_music", asset_id, start?, end?, at?, volume?, track?}: 소리 넣기. track 2=배경음악(기본, volume 기본 0.25), 3=효과음, 1=대사
- {op:"clear_music"}
- {op:"add_overlay", asset_id, at, start?, end?, track?(2|3), transform?, volume?}: 본편 위에 겹치기 (기본: 오른쪽 위 40% 크기)
- {op:"set_overlay", overlay_id, at?, start?, end?, transform?, volume?}
- {op:"remove_item", id}: V2/V3 또는 소리 클립 지우기`,
    input_schema: { type: "object", properties: { draft_id: draftId, allow_steep, ops: { type: "array", items: { type: "object" } } }, required: ["ops"] },
  },
  {
    name: "remove_silences", description: "편집본의 말 없는 구간을 잘라 냅니다. 받아쓰기가 있으면 단어 기준, 없으면 소리 크기 기준입니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, pacing: { type: "string", enum: ["gentle", "normal", "tight", "jump_cut"] } }, required: ["pacing"] },
  },
  { name: "remove_fillers", description: "편집본에서 '음', '어' 같은 군더더기 말을 잘라 냅니다 (받아쓰기 필요).", input_schema: { type: "object", properties: { draft_id: draftId } } },
  {
    name: "add_markers", description: "편집본 타임라인에 마커를 답니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, markers: { type: "array", items: { type: "object", properties: { time: num, label: str, color: str }, required: ["time", "label"] } } }, required: ["markers"] },
  },
  {
    name: "get_captions", description: "편집본의 자막을 줄마다 읽습니다. 줄마다 key(첫 단어), 시간, 글, 단어별 key, 번역이 나옵니다. edit_captions와 set_translation은 이 key를 씁니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, from: { ...num, description: "타임라인 초부터" }, to: { ...num, description: "타임라인 초까지" } } },
  },
  {
    name: "edit_captions", description: "이 편집본의 자막만 고칩니다(대본은 그대로). ops를 차례로 적용합니다: {op:\"fix_word\", key, text} 단어 고치기, {op:\"set_line\", key, text} 줄 전체 글, {op:\"break_before\", key} 이 단어부터 새 줄, {op:\"join_next\", key} 이 줄과 다음 줄 합치기(key는 줄 key), {op:\"move_word_prev\", key} 이 줄의 첫 단어를 앞 줄로, {op:\"hide\", key}, {op:\"show\", key}.",
    input_schema: { type: "object", properties: { draft_id: draftId, ops: { type: "array", items: { type: "object", properties: { op: str, key: str, text: str }, required: ["op", "key"] } } }, required: ["ops"] },
  },
  {
    name: "fix_words", description: "받아쓰기의 단어를 고칩니다. 모든 편집본의 대본과 자막에 반영됩니다. 잘못 들은 이름처럼 어디서나 틀린 말에 쓰세요. replace: 찾을 말과 바꿀 말, 또는 words: 단어 key와 글.",
    input_schema: { type: "object", properties: { asset_id: { ...str, description: "없으면 모든 미디어" }, replace: { type: "array", items: { type: "object", properties: { from: str, to: str }, required: ["from", "to"] } }, words: { type: "array", items: { type: "object", properties: { key: str, text: str }, required: ["key", "text"] } } } },
  },
  {
    name: "set_translation", description: "자막의 번역을 넣습니다. lang은 언어 이름, items는 get_captions의 줄 key와 번역 글. 여러 번 나눠 넣어도 합쳐집니다. show: orig(원문만), tr(번역만), both(둘 다). 내보낼 때 SRT를 켜면 번역 자막 파일도 따로 저장됩니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, lang: str, show: { type: "string", enum: ["orig", "tr", "both"] }, items: { type: "array", items: { type: "object", properties: { key: str, text: str }, required: ["key", "text"] } } }, required: ["lang", "items"] },
  },
  {
    name: "set_captions", description: "받아쓰기로 만든 자막을 켜고 끄거나 모양을 바꿉니다. style의 값 뒤에 anim, keyword, lines 같은 항목을 주면 그 항목만 바뀝니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, enabled: { type: "boolean" }, style: { type: "string", enum: CAPTION_PRESETS.map((p) => p.id), description: CAPTION_PRESETS.map((p) => `${p.id}: ${p.label}`).join(", ") }, anim: { type: "string", enum: ["none", "fade", "rise", "drop", "pop", "type"], description: "나타나는 방식 (type: 말하는 대로 한 단어씩)" }, anim_by: { type: "string", enum: ["line", "word"] }, lines: { type: "number", enum: [1, 2] }, break_by: { type: "string", enum: ["smart", "chars", "sentence"], description: "줄 끝: 말이 끊기는 곳, 글자 수, 문장" }, keyword: { type: "string", enum: ["none", "first", "last", "number", "longest"], description: "따로 강조할 단어" }, key_color: str, highlight: { ...str, description: "말하는 단어 색 (#RRGGBB, 빈 글이면 끔)" }, align: { type: "string", enum: ["left", "center", "right"] }, size: { ...num, description: "화면 높이 대비 % (기본 6)" }, position: { type: "string", enum: ["bottom", "middle", "top"] }, max_chars: num }, required: ["enabled"] },
  },
  {
    name: "sync_media", description: "같은 순간을 찍은 영상들(휴대폰, 360 카메라, 마이크)을 소리로 맞춥니다. 첫 번째가 기준입니다. 각 미디어가 기준보다 몇 초 뒤에 시작했는지와 확실한 정도(0~1)를 돌려주고 저장합니다.",
    input_schema: { type: "object", properties: { asset_ids: { type: "array", items: str } }, required: ["asset_ids"] },
  },
  {
    name: "multicam_draft", description: "sync_media로 맞춘 영상들로 멀티캠 편집본을 만듭니다. cuts: [{at(기준 시각 초), asset_id}] 순서대로 그 시각부터 해당 카메라 화면으로 바꿉니다. 소리는 sound_asset_id 하나를 끝까지 씁니다(A1). end는 끝나는 기준 시각.",
    input_schema: { type: "object", properties: { name: str, sound_asset_id: str, end: num, aspect: str, cuts: { type: "array", items: { type: "object", properties: { at: num, asset_id: str }, required: ["at", "asset_id"] } } }, required: ["sound_asset_id", "end", "cuts"] },
  },
  {
    name: "auto_color", description: "클립의 노출·대비·화이트밸런스를 자동으로 맞춥니다(클립마다 다섯 장면을 보고 계산, 부드럽게). clip_ids가 없으면 편집본 전체. 휴대폰과 360 영상의 색을 비슷하게 맞출 때도 좋습니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, clip_ids: { type: "array", items: str } } },
  },
  {
    name: "set_look", description: "클립에 색 룩을 입힙니다: warm(따뜻한 필름), cool(시원하게), vivid(생생하게), soft(부드럽게), bw(흑백), none(원래대로). 세부 값은 color로 직접 줄 수 있습니다: exposure, contrast, saturation, temperature, tint, highlights, shadows, vibrance, vignette.",
    input_schema: { type: "object", properties: { draft_id: draftId, clip_ids: { type: "array", items: str }, look: { type: "string", enum: ["warm", "cool", "vivid", "soft", "bw", "none"] }, color: { type: "object", properties: { exposure: num, contrast: num, saturation: num, temperature: num, tint: num, highlights: num, shadows: num, vibrance: num, vignette: num } } } },
  },
  {
    name: "paste_attributes", description: "한 클립의 설정을 다른 클립들로 복사합니다. attrs: color(색), transform(위치·크기), motion(움직임), speed, sound(음량·잡음), fades, transition, view(360 시점). to_clip_ids가 없으면 편집본의 모든 클립.",
    input_schema: { type: "object", properties: { draft_id: draftId, from_clip_id: str, to_clip_ids: { type: "array", items: str }, attrs: { type: "array", items: str } }, required: ["from_clip_id", "attrs"] },
  },
  {
    name: "set_motion", description: "클립이나 V2/V3 그림에 움직임을 넣습니다. preset: zoom_in(천천히 확대), zoom_out, pan_right, pan_left, none(끄기) — 사진에 생동감을 줄 때 좋습니다. 직접 하려면 keys: [{t(원본 초), scale, x, y(화면 비율 이동), opacity}]. 키 사이는 부드럽게 이어집니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, item_id: str, preset: { type: "string", enum: ["zoom_in", "zoom_out", "pan_right", "pan_left", "none"] }, amount: { ...num, description: "확대 정도(기본 0.15 = 15%)" }, keys: { type: "array", items: { type: "object", properties: { t: num, scale: num, x: num, y: num, opacity: num }, required: ["t"] } } }, required: ["item_id"] },
  },
  {
    name: "set_volume_keys", description: "클립·소리의 음량을 시간에 따라 바꿉니다(음악을 말할 때만 줄이기 등). keys: [{t(원본 초), v(1=원래 크기)}]. 빈 목록이면 끕니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, item_id: str, keys: { type: "array", items: { type: "object", properties: { t: num, v: num }, required: ["t", "v"] } } }, required: ["item_id", "keys"] },
  },
  {
    name: "fit_music", description: "음악을 영상 끝까지 길이에 맞춥니다: 길면 자르고 끝을 부드럽게 줄이며, 짧으면 반복합니다. music_id는 get_draft의 소리 목록에 있습니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, music_id: str, fade: { ...num, description: "끝 페이드 초(기본 2)" } }, required: ["music_id"] },
  },
  {
    name: "add_text", description: "제목, 작은 제목, 설명 막대(lower), 장소·날짜 핀(pin), 스티커(sticker)를 화면에 올립니다. 내보낸 파일에 그대로 들어갑니다. at=편집본 시각(초), dur=길이. x·y는 화면 비율(0~1), size는 화면 높이 대비 %(비우면 종류별 기본값). 스티커 sticker: heart, star, pin, arrow, bubble, circle. 촬영 날짜는 get_project_overview의 '촬영'에서 읽어 핀 글자에 넣으세요.",
    input_schema: {
      type: "object",
      properties: { draft_id: draftId, items: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["title", "subtitle", "lower", "pin", "sticker"] }, text: str, sticker: str, at: num, dur: num, x: num, y: num, size: num, color: str }, required: ["kind", "at"] } } },
      required: ["items"],
    },
  },
  { name: "remove_text", description: "add_text로 올린 글자·스티커를 지웁니다. ids가 없으면 전부 지웁니다. 지금 있는 항목은 get_draft에 나옵니다.", input_schema: { type: "object", properties: { draft_id: draftId, ids: { type: "array", items: str } } } },
  { name: "transcribe", description: "미디어를 받아쓰기합니다 (끝날 때까지 기다림).", input_schema: { type: "object", properties: { asset_ids: { type: "array", items: str } }, required: ["asset_ids"] } },
  {
    name: "get_playbook", description: "작업 안내(스킬)를 읽습니다. 어떤 안내가 있는지는 지침의 '작업 안내(스킬)' 목록에 있습니다.",
    input_schema: { type: "object", properties: { name: str }, required: ["name"] },
  },
  {
    name: "save_skill", description: "사용자의 규칙이나 작업 순서를 스킬로 저장합니다. 모든 프로젝트와 새 대화에서 쓸 수 있습니다. 사용자가 '다음에도 이렇게', '이 규칙 기억해'라고 할 때 씁니다. body는 앞으로의 자신이 따를 수 있게 구체적으로 적으세요. 같은 이름이면 고칩니다.",
    input_schema: { type: "object", properties: { name: { ...str, description: "짧은 이름(영문·한글, 띄어쓰기 없이)" }, description: { ...str, description: "무엇을 하는 스킬인지 한 줄" }, triggers: { type: "array", items: str, description: "이 스킬을 떠올릴 말" }, body: str }, required: ["name", "description", "body"] },
  },
  {
    name: "merge_skills", description: "스킬 둘 이상을 차례로 하는 병합 스킬 하나로 합쳐 저장합니다. steps는 순서대로, label은 단계 이름(없으면 스킬 이름).",
    input_schema: { type: "object", properties: { name: str, description: str, triggers: { type: "array", items: str }, steps: { type: "array", items: { type: "object", properties: { skill: str, label: str }, required: ["skill"] } } }, required: ["name", "steps"] },
  },
  {
    name: "run_merged_skill", description: "병합 스킬을 실행합니다. 이 도구를 부른 뒤 바로 차례를 끝내세요. 그러면 앱이 단계마다 하나씩 차례로 시킵니다. request에는 사용자의 요청을 그대로 적습니다.",
    input_schema: { type: "object", properties: { name: str, request: str }, required: ["name"] },
  },
  {
    name: "finish_step", description: "병합 스킬의 지금 단계를 끝내고 결과를 알립니다. ok는 해냈는지, summary는 결과나 못 한 이유입니다. 결과가 여러 개이면(장면 구간 등) items에 하나씩 넣습니다. 다음 단계에 그대로 넘어갑니다. 부른 뒤 차례를 끝내세요.",
    input_schema: { type: "object", properties: { ok: { type: "boolean" }, summary: str, items: { type: "array", items: { type: "object" } } }, required: ["ok", "summary"] },
  },
  { name: "delete_skill", description: "사용자가 만든 스킬을 지웁니다.", input_schema: { type: "object", properties: { name: str }, required: ["name"] } },
  {
    name: "ask_options", description: "사용자에게 고를 수 있는 카드를 보여 주고, 고를 때까지 기다렸다가 고른 것을 돌려줍니다(하이라이트 후보, 길이 선택, 대상이 애매할 때). 차례를 끝내지 말고 결과를 받아 이어서 작업하세요. 추천하는 것을 맨 앞에 두면 추천으로 표시됩니다. 선택지마다 meaning에 고르면 무엇을 할지(시각까지 구체적으로) 적으세요. 그 글이 그대로 돌아옵니다. multi_select를 켜면 여러 개를 고를 수 있습니다.",
    input_schema: { type: "object", properties: { question: str, multi_select: { type: "boolean" }, recommended: { type: "boolean", description: "첫 번째를 추천으로 표시 (기본 켬)" }, options: { type: "array", items: { type: "object", properties: { label: str, detail: str, meaning: str }, required: ["label", "meaning"] } } }, required: ["question", "options"] },
  },
  {
    name: "run_script", description: "TypeScript 스크립트를 실행합니다. 반복, 계산, 조건이 필요하거나 도구를 여러 번 부를 일에 씁니다(예: 박자마다 컷, 편집본 여러 개). 쓰기 전에 get_sdk_types로 reelcut API를 읽으세요. 코드는 함수 본문입니다: await를 바로 쓰고 return으로 결과를 돌려주며 console.log도 돌아옵니다. import, 인터넷, 파일 직접 접근은 안 되고 전부 reelcut을 거칩니다. 바뀐 것은 되돌리기 한 번으로 돌아가고, 실패하거나 시간을 넘기면 모두 되돌립니다. 내보내기, 지우기, 사용자에게 묻기는 스크립트 밖에서 하세요.",
    input_schema: { type: "object", properties: { script: str, summary: { ...str, description: "무엇을 하는지 한 줄" }, timeout_seconds: { ...num, description: "기본 60, 최대 600" }, max_result_bytes: { ...num, description: "돌려받을 결과 크기, 기본 20000" } }, required: ["script", "summary"] },
  },
  { name: "get_sdk_types", description: "run_script에서 쓰는 reelcut API의 타입 선언(.d.ts)을 읽습니다.", input_schema: { type: "object", properties: {} } },
  {
    name: "run_steps", description: "여러 도구를 한 번에 차례로 실행합니다(예: 클립마다 같은 작업). steps: [{tool, input}], 앞 단계가 실패하면 멈춥니다(stop_on_error 기본 켬). 그림을 돌려주는 도구의 그림은 빠지고 글만 돌아옵니다. 그림을 봐야 하면 따로 부르세요. ask_options, get_playbook은 넣을 수 없습니다.",
    input_schema: { type: "object", properties: { stop_on_error: { type: "boolean" }, steps: { type: "array", items: { type: "object", properties: { tool: str, input: { type: "object" } }, required: ["tool"] } } }, required: ["steps"] },
  },
  {
    name: "equirect_sheet", description: "360 영상의 특정 원본 시간을 '수평으로 펴 놓은 파노라마'(가로 0~960 = 방위 -180~180°, 480 = 정면, 세로 240 = 수평선)로 봅니다. 좌표 격자가 그려져 있어 사람 머리의 [x,y]를 읽을 때 씁니다 (최대 6장).",
    input_schema: { type: "object", properties: { asset_id: str, times: { type: "array", items: num }, width: { ...num, description: "그림 가로 픽셀(기본 960)" } }, required: ["asset_id", "times"] },
  },
  {
    name: "frame_subject", description: "사람(머리) 위치 표시를 따라가는 시점 키프레임을 만듭니다. 한 사람이면 marks에 equirect_sheet에서 읽은 [원본 초, x, y] 목록(빠르면 1초, 보통 2.5초 간격). 여러 사람을 함께 화면에 담으려면(쌍둥이 등) subjects에 사람마다 이름과 marks를 넣으세요. 화면이 모두의 가운데를 보고, 한도(16:9는 100°, 9:16은 70°) 안에서 모두 들어오도록 화각을 조금 넓힙니다. 시점은 수평 가까이(±25°)를 지킵니다. 0.1초 간격 키프레임으로 부드럽게 이어서 클립에 넣고, 가장 높은 머리가 화면 위에서 1/3 지점에 오게 합니다. 결과에 사람마다 화면 안에 있었던 비율과, 너무 멀리 떨어져 한 화면에 못 담은 구간을 알려 줍니다.",
    input_schema: {
      type: "object",
      properties: {
        draft_id: draftId, clip_id: str,
        marks: { type: "array", items: { type: "array", items: num }, description: "한 사람: [[t,x,y], …] 또는 [t,x,y,hfov]. t=원본 초, x 0~960, y 0~480(수평선 240), 머리 위치" },
        subjects: {
          type: "array", description: "여러 사람을 함께: [{name:\"첫째\", marks:[[t,x,y],…]}, {name:\"둘째\", marks:[…]}]. 사람마다 다른 시각에 찍어도 됩니다. 3초 안에 표시가 없는 사람은 그 순간 빼고 나머지를 담습니다.",
          items: { type: "object", properties: { name: str, marks: { type: "array", items: { type: "array", items: num } } }, required: ["marks"] },
        },
        track: { type: "boolean", description: "표시를 시작점으로 얼굴·머리를 자동 추적해 0.2초 단위로 다듬습니다(기본 켬, 구간 3분 이하). 표시가 몇 개뿐이어도 따라갑니다." },
        allow_steep,
        hfov: { ...num, description: "화각. 보통 비워 둡니다(16:9는 90, 9:16은 62. 최대 100, 70)" }, headroom: { ...num, description: "머리 위 여백 비율(기본 0.33)" },
        step: { ...num, description: "키 간격 초(기본 0.1)" }, smooth: { ...num, description: "부드럽게 하는 정도 초(기본 0.4, 0이면 끔)" },
        from: num, to: num,
      },
      required: ["clip_id"],
    },
  },
  {
    name: "get_view_keys", description: "클립의 시점 키프레임을 봅니다 (많으면 고르게 줄여서 최대 max개, 기본 60).",
    input_schema: { type: "object", properties: { draft_id: draftId, clip_id: str, max: num }, required: ["clip_id"] },
  },
  {
    name: "save_scene_notes", description: "미디어의 장면 설명을 저장합니다. 나중에 search_scenes와 앱의 미디어 검색창으로 찾을 수 있습니다. contact_sheet·equirect_sheet로 본 내용을 시각과 함께 짧게(누가, 어디서, 무엇을) 적으세요. 같은 초의 설명은 새것으로 바뀝니다.",
    input_schema: { type: "object", properties: { asset_id: str, notes: { type: "array", items: { type: "object", properties: { t: num, text: str }, required: ["t", "text"] } } }, required: ["asset_id", "notes"] },
  },
  {
    name: "search_scenes", description: "저장한 장면 설명에서 찾습니다(모든 미디어). 예: '미끄럼틀', '기린 앞 아이들'. 설명이 없는 미디어가 있으면 결과에 알려 줍니다. 그럴 때는 contact_sheet로 훑고 save_scene_notes로 저장한 뒤 다시 찾으세요.",
    input_schema: { type: "object", properties: { query: str }, required: ["query"] },
  },
  {
    name: "scan_bad_shots", description: "흐리거나 흔들리거나 너무 어두운 구간을 자동으로 찾습니다(그 녹화 자체와 비교해서 판단). 결과는 미디어에 저장되어 원본 보기의 재생 막대에 표시됩니다. 하이라이트를 고를 때 이 구간을 피하세요. 긴 영상은 from·to로 범위를 줄이면 빠릅니다.",
    input_schema: { type: "object", properties: { asset_id: str, from: num, to: num }, required: ["asset_id"] },
  },
  {
    name: "scan_gaze", description: "구간에서 얼굴이 카메라 쪽을 향한 구간을 찾습니다(일반 영상과 360 모두). 눈동자가 아니라 머리 방향을 잽니다. 원본 시각으로 돌려줍니다. step은 살펴보는 간격(초, 기본 2).",
    input_schema: { type: "object", properties: { asset_id: str, from: num, to: num, step: num }, required: ["asset_id", "from", "to"] },
  },
  {
    name: "measure_loudness", description: "구간의 소리 크기를 잽니다: LUFS(전체 크기), 범위, 최고점, 10초마다의 크기. 내보낼 때 몇 LUFS일지나 소리가 작은 곳을 볼 때 씁니다.",
    input_schema: { type: "object", properties: { asset_id: str, start: num, end: num }, required: ["asset_id"] },
  },
  {
    name: "find_beats", description: "음악의 박자를 찾습니다: BPM, 확실한 정도(0~1, 0.2 아래면 일정한 박자가 없음), 박자 시각(원본 초). 음악에 맞춰 자를 때 씁니다.",
    input_schema: { type: "object", properties: { asset_id: str, start: num, end: num }, required: ["asset_id"] },
  },
  {
    name: "find_scene_cuts", description: "화면이 갑자기 바뀌는 곳을 찾습니다(원본 초와 점수). threshold 기본 0.3, 낮을수록 많이 찾습니다. 360 영상은 한쪽 렌즈 기준입니다.",
    input_schema: { type: "object", properties: { asset_id: str, start: num, end: num, threshold: num }, required: ["asset_id"] },
  },
  {
    name: "find_audio_events", description: "소리 크기로 눈에 띄는 구간을 찾습니다: silence(조용함), loud(잠깐 큰 소리), loud_long(오래 큰 소리). 소리의 크기만 재므로 웃음이나 박수 같은 소리의 종류는 구별하지 못합니다.",
    input_schema: { type: "object", properties: { asset_id: str, start: num, end: num }, required: ["asset_id"] },
  },
  {
    name: "organize_media", description: "미디어를 폴더로 옮깁니다(파일은 그대로, 앱 안의 분류만). folder가 빈 글이면 맨 위로.",
    input_schema: { type: "object", properties: { moves: { type: "array", items: { type: "object", properties: { asset_id: str, folder: str }, required: ["asset_id", "folder"] } } }, required: ["moves"] },
  },
  {
    name: "find_faces", description: "360 영상의 특정 원본 시각들에서 얼굴을 자동으로 찾습니다(내장 얼굴 인식, 최대 16곳). 수평 파노라마 좌표로 x, y, 크기를 돌려줍니다. 머리 위치를 눈으로 읽는 대신 정확한 값을 얻을 때 씁니다. 뒤돈 얼굴은 안 잡히니 equirect_sheet와 함께 보세요. 어른은 얼굴이 크고 위쪽, 어린아이는 작고 아래쪽에 있는 경우가 많습니다.",
    input_schema: { type: "object", properties: { asset_id: str, times: { type: "array", items: num } }, required: ["asset_id", "times"] },
  },
  {
    name: "track_people", description: "사람을 구간 내내 자동으로 따라가 위치 표시를 돌려줍니다. subjects마다 시작 위치 seeds([t,x,y], find_faces나 equirect_sheet에서 읽은 값) 하나 이상을 주면 앞뒤로 추적합니다(한 번에 3분까지). 돌려준 marks는 frame_subject에 그대로 넣을 수 있습니다. frame_subject의 track(기본 켬)을 쓰면 이 도구를 따로 부르지 않아도 됩니다.",
    input_schema: {
      type: "object",
      properties: { asset_id: str, from: num, to: num, subjects: { type: "array", items: { type: "object", properties: { name: str, seeds: { type: "array", items: { type: "array", items: num } } }, required: ["seeds"] } } },
      required: ["asset_id", "from", "to", "subjects"],
    },
  },
  {
    name: "trim_to_subjects", description: "따라갈 사람이 모두 화면 안에 있지 않은 부분을 편집본에서 빼고, 모두 나오는 비율을 전과 후로 알려 줍니다. check_framing 사진을 보고 판단한 것을 넣으세요: not_ok_times는 빠졌거나 어른이 화면을 차지한 원본 시각, ok_times는 괜찮은 시각(자동 판단이 틀렸을 때). apply가 false면 비율만 알려 줍니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, clip_ids: { type: "array", items: str }, not_ok_times: { type: "array", items: num }, ok_times: { type: "array", items: num }, apply: { type: "boolean" } } },
  },
  {
    name: "check_framing", description: "클립의 시점 키프레임으로 실제 잡히는 화면을 확인합니다. times를 안 주면 문제가 있는 곳과 클립 전체에서 고릅니다. 머리가 위 1/3 선 근처인지, 잘리지 않았는지 보세요. frame_subject의 subjects로 사람을 정한 클립이면 1초쯤마다 얼굴 인식과 추적으로 누가 화면 안에 있는지, 다른 사람이 크게 나오는지 재서 비율과 함께 알려 줍니다. 쌍둥이처럼 둘을 담을 때는 둘 다 화면에 있는지 사진으로 직접 확인하세요.",
    input_schema: { type: "object", properties: { draft_id: draftId, clip_id: str, times: { type: "array", items: num } }, required: ["clip_id"] },
  },
  {
    name: "snap_cuts", description: "편집본 클립의 시작·끝을 가까운 말 없는 틈(±1.5초 안)으로 옮겨 말 중간에서 끊기지 않게 합니다. 받아쓰기가 있으면 단어 사이, 없으면 소리 크기 기준입니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, clip_ids: { type: "array", items: str }, reach: { ...num, description: "옮길 수 있는 최대 거리 초(기본 1.5)" } } },
  },
  { name: "delete_draft", description: "편집본을 지웁니다 (마지막 하나는 지울 수 없고, Ctrl+Z로 되돌릴 수 있습니다).", input_schema: { type: "object", properties: { draft_id: str }, required: ["draft_id"] } },
  {
    name: "export_draft", description: "편집본을 파일로 내보냅니다 (끝날 때까지 기다림). preset: fhd/4k/hd/sd는 일반 H.264 MP4, shrink_balanced/shrink_small/shrink_archive/shrink_lecture는 크기를 많이 줄이는 고압축(AV1/HEVC), audio는 WAV 소리만.",
    input_schema: { type: "object", properties: { srt: { type: "boolean", description: "자막 파일(SRT)도 같이 저장" }, draft_id: draftId, preset: { type: "string", enum: ["4k", "fhd", "hd", "sd", "shrink_archive", "shrink_balanced", "shrink_small", "shrink_lecture", "audio"] }, file_name: { ...str, description: "파일 이름이나 전체 경로. 전체 경로의 폴더가 있으면 거기에, 없으면 내보내기 폴더에 저장합니다. 같은 이름이 있으면 덮어쓰지 않고 번호를 붙입니다." } }, required: ["preset"] },
  },
];

// ---------------------------------------------------------------- tool implementations

type Out = string | ChatBlock[];

function getDraft(id?: string): Draft {
  const d = st.project?.drafts.find((x) => x.id === (id || st.draftId));
  if (!d) throw new Error(`편집본을 찾을 수 없습니다: ${id ?? "(열린 편집본 없음)"}`);
  return d;
}
function getAsset(id: string): Asset {
  const a = asset(id);
  if (!a) throw new Error(`미디어를 찾을 수 없습니다: ${id}`);
  return a;
}
const tState = (a: Asset) => (a.words ? `있음(${a.words.length}단어)` : a.tState === "running" ? "진행 중" : !a.info.has_audio ? "소리 없음" : "없음");

function overview(): string {
  const p = st.project!;
  const lines = [`프로젝트: ${p.name}`, `열린 편집본: ${st.draftId}`, "", "미디어:"];
  for (const a of p.assets) {
    const i = a.info;
    lines.push(`- ${a.id} | ${i.name} | ${i.kind} | ${fmtTC(i.duration)} (${r3(i.duration)}초)${i.kind === "video" ? ` | ${i.width}x${i.height} ${Math.round(i.fps)}fps` : ""}${is360(a) ? ` | 360(${i.layout360})` : ""} | 받아쓰기 ${tState(a)}${a.folder ? ` | 폴더 ${a.folder}` : ""}${i.recorded ? ` | 촬영 ${i.recorded}` : ""}`);
  }
  lines.push("", "편집본:");
  for (const d of p.drafts) lines.push(`- ${d.id} | ${d.name} | 클립 ${d.clips.length}개 | ${fmtTC(draftDuration(d))} | ${d.aspect}`);
  return lines.join("\n");
}

/** Views the AI just set are held near level, unless the user asked for steep or wide ones. Clips it did not touch stay as they are. */
function capAiViews(before: Draft, after: Draft, free: boolean): Draft {
  if (free) return after;
  const [w, h] = after.aspect.split(":").map(Number);
  const aspect = w / h || 16 / 9;
  return { ...after, clips: after.clips.map((c) => (before.clips.includes(c) ? c : {
    ...c,
    ...(c.view ? { view: capView(c.view, aspect) } : {}),
    ...(c.viewKeys ? { viewKeys: c.viewKeys.map((k) => ({ ...k, view: capView(k.view, aspect) })) } : {}),
  })) };
}

function draftInfo(d: Draft): string {
  const am = assetMap();
  const stt = starts(d);
  const lines = [`편집본 ${d.id} "${d.name}" | 비율 ${d.aspect} | 길이 ${r3(draftDuration(d))}초 | 자막 ${d.captions ? "켬" : "끔"}`, "클립 (순서 | id | 미디어 | 원본 구간 | 타임라인 구간 | 속도 | 음량 | 시점):"];
  d.clips.forEach((c, i) => {
    if (isGap(c)) { lines.push(`${i} | ${c.id} | (빈칸) | - | ${r3(stt[i])}–${r3(stt[i] + clipDur(c))} | - | - | -`); return; }
    const a = am.get(c.asset);
    const extra = [c.xin ? `전환 ${c.xtype ?? "fade"} ${c.xin}초` : "", c.disabled ? "꺼짐" : "", c.transform && !isDefaultTransform(c.transform) ? `변형 ${JSON.stringify(c.transform)}` : "", c.color && !isDefaultColor(c.color) ? `색 ${JSON.stringify(c.color)}` : "", c.detached ? "소리 분리됨" : "", c.viewKeys?.length ? `시점 키프레임 ${c.viewKeys.length}개(원본 ${c.viewKeys[0].t}–${c.viewKeys[c.viewKeys.length - 1].t}초)` : ""].filter(Boolean).join(", ");
    lines.push(`${i} | ${c.id} | ${a?.info.name ?? "?"}(${c.asset}) | ${r3(c.start)}–${r3(c.end)} | ${r3(stt[i])}–${r3(stt[i] + clipDur(c))} | ${c.speed}x | ${c.volume} | ${c.view ? `yaw ${c.view.yaw} pitch ${c.view.pitch} hfov ${c.view.hfov}` : "-"}${extra ? ` | ${extra}` : ""}`);
  });
  const ov = d.overlays ?? [];
  if (ov.length) lines.push("V2/V3:", ...ov.map((o) => `- ${o.id} | V${o.track} | ${am.get(o.asset)?.info.name} | 원본 ${o.start}–${o.end} | 타임라인 ${o.at}부터 | 변형 ${JSON.stringify(o.transform ?? {})}`));
  if (d.music.length) lines.push("소리 (A1 대사 / A2 음악 / A3 효과음):", ...d.music.map((m) => `- ${m.id} | A${m.track ?? 2} | ${am.get(m.asset)?.info.name} | 원본 ${m.start}–${m.end} | 타임라인 ${m.at}부터 | 음량 ${m.volume}`));
  if (d.markers.length) lines.push("마커:", ...d.markers.map((m) => `- ${r3(m.t)}초 ${m.label}`));
  if (d.texts?.length) lines.push("글자·스티커:", ...d.texts.map((t) => `- ${t.id} | ${t.kind}${t.sticker ? ` ${t.sticker}` : ""} | ${r3(t.at)}–${r3(t.at + t.dur)}초 | ${t.text}`));
  return lines.join("\n");
}

const img = (b64: string): ChatBlock => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });

/** Keys from the AI: {t,yaw,…} or {t,view:{…}}; missing angles inherit `base`; always normalised. */
function parseKeys(raw: any, base?: View): ViewKey[] {
  if (!Array.isArray(raw)) throw new Error("keys는 배열이어야 합니다");
  return cleanKeys(raw.map((k: any) => ({ t: Number(k?.t), view: normView(k?.view ?? k, base) })));
}

/** Speech runs (source seconds) of an asset between s0 and s1, from its words or else its waveform. */
function speechRuns(words: Asset["words"], wave: ArrayLike<number> | undefined, s0: number, s1: number): [number, number][] | null {
  if (words?.length) return speechFromWords(words, s0, s1);
  return wave ? speechFromWave(wave, s0, s1) : null;
}

function applyOps(d: Draft, ops: any[]): Draft {
  for (const o of ops) {
    switch (o.op) {
      case "insert": {
        const a = getAsset(o.asset_id);
        const c = newClip(a, Number(o.start ?? 0), Number(o.end ?? a.info.duration));
        if (o.speed) c.speed = Number(o.speed);
        if (o.view && is360(a)) c.view = normView(o.view, c.view);
        if (o.view_keys?.length && is360(a)) c.viewKeys = parseKeys(o.view_keys, c.view);
        d = insertClips(d, [c], o.index ?? d.clips.length);
        break;
      }
      case "delete": d = deleteClip(d, o.clip_id); break;
      case "trim": {
        const c = d.clips.find((x) => x.id === o.clip_id);
        if (!c) throw new Error(`클립 없음: ${o.clip_id}`);
        const dur = asset(c.asset)?.info.duration ?? 1e9;
        const s = Math.max(0, o.start ?? c.start), e = Math.min(dur || 1e9, o.end ?? c.end);
        if (e - s < 0.05) throw new Error("구간이 너무 짧습니다");
        d = updateClip(d, c.id, { start: r3(s), end: r3(e) });
        break;
      }
      case "move": d = moveClip(d, d.clips.findIndex((x) => x.id === o.clip_id), Number(o.index)); break;
      case "split": d = splitAt(d, Number(o.time)); break;
      case "remove_range": d = removeRange(d, Number(o.from), Number(o.to)); break;
      case "cut_source": d = cutSource(d, { [o.clip_id]: o.ranges }); break;
      case "set": {
        const c = d.clips.find((x) => x.id === o.clip_id);
        if (!c) throw new Error(`클립 없음: ${o.clip_id}`);
        d = updateClip(d, c.id, {
          ...(o.speed != null ? { speed: Math.min(16, Math.max(0.1, Number(o.speed))) } : {}),
          ...(o.volume != null ? { volume: Math.min(4, Math.max(0, Number(o.volume))) } : {}),
          ...(o.view ? { view: normView(o.view, c.view) } : {}),
          ...(o.fit ? { fit: o.fit } : {}),
          ...(o.fade_in != null ? { fadeIn: Number(o.fade_in) } : {}),
          ...(o.fade_out != null ? { fadeOut: Number(o.fade_out) } : {}),
          ...(o.denoise != null ? { denoise: !!o.denoise } : {}),
          ...(o.transform ? { transform: { ...DEFAULT_TRANSFORM, ...(c.transform ?? {}), ...o.transform } } : {}),
          ...(o.color ? { color: { ...DEFAULT_COLOR, ...(c.color ?? {}), ...o.color } } : {}),
        });
        break;
      }
      case "set_view_keys": {
        const c = d.clips.find((x) => x.id === o.clip_id);
        if (!c) throw new Error(`클립 없음: ${o.clip_id}`);
        if (!is360(getAsset(c.asset))) throw new Error("360 영상 클립이 아닙니다");
        const ks = parseKeys(o.keys, c.view);
        d = updateClip(d, c.id, { viewKeys: cleanKeys(o.merge ? [...(c.viewKeys ?? []).filter((k) => !ks.some((n) => Math.abs(n.t - k.t) < 0.001)), ...ks] : ks) });
        break;
      }
      case "clear_view_keys": d = updateClip(d, o.clip_id, { viewKeys: undefined }); break;
      case "set_enabled": {
        const flip = <T extends { id: string; disabled?: boolean }>(x: T) => (x.id === o.item_id ? { ...x, disabled: o.enabled === false } : x);
        d = { ...d, clips: d.clips.map(flip), overlays: (d.overlays ?? []).map(flip), music: d.music.map(flip) };
        break;
      }
      case "transition": d = setTransition(d, o.clip_id, Number(o.seconds ?? 0.5)); if (o.type) d = updateClip(d, o.clip_id, { xtype: String(o.type) }); break;
      case "gap": d = insertClips(d, [newGap(Number(o.seconds ?? 1))], o.index ?? d.clips.length); break;
      case "detach_audio": d = detachAudio(d, o.clip_id); break;
      case "rename": d = { ...d, name: String(o.name) }; break;
      case "aspect": d = { ...d, aspect: String(o.aspect) }; break;
      case "add_music": {
        const a = getAsset(o.asset_id);
        const total = draftDuration(d);
        const track = ([1, 2, 3].includes(Number(o.track)) ? Number(o.track) : 2) as 1 | 2 | 3;
        const start = Number(o.start ?? 0), at = Number(o.at ?? 0);
        const end = Number(o.end ?? (track === 2 ? Math.min(a.info.duration, start + Math.max(1, total - at)) : a.info.duration));
        d = { ...d, music: [...d.music, { id: uid(), asset: a.id, start, end, at, volume: Number(o.volume ?? (track === 2 ? 0.25 : 1)), fadeIn: track === 2 ? 1 : 0, fadeOut: track === 2 ? 2 : 0, track }] };
        break;
      }
      case "clear_music": d = { ...d, music: d.music.filter((m) => (m.track ?? 2) !== 2) }; break;
      case "add_overlay": {
        const a = getAsset(o.asset_id);
        const ov = newOverlay(a, Number(o.at ?? 0), o.track === 3 ? 3 : 2, Number(o.start ?? 0), Number(o.end ?? (a.info.kind === "image" ? 4 : a.info.duration)));
        if (o.transform) ov.transform = { ...DEFAULT_TRANSFORM, ...o.transform };
        if (o.volume != null) ov.volume = Number(o.volume);
        d = { ...d, overlays: [...(d.overlays ?? []), ov] };
        break;
      }
      case "set_overlay": {
        const x = (d.overlays ?? []).find((y) => y.id === o.overlay_id);
        if (!x) throw new Error(`V2/V3 클립 없음: ${o.overlay_id}`);
        d = updateOverlay(d, x.id, {
          ...(o.at != null ? { at: Number(o.at) } : {}), ...(o.start != null ? { start: Number(o.start) } : {}), ...(o.end != null ? { end: Number(o.end) } : {}),
          ...(o.volume != null ? { volume: Number(o.volume) } : {}), ...(o.transform ? { transform: { ...DEFAULT_TRANSFORM, ...(x.transform ?? {}), ...o.transform } } : {}),
        });
        break;
      }
      case "remove_item": d = removeItem(d, o.id); break;
      default: throw new Error(`알 수 없는 op: ${o.op}`);
    }
  }
  return d;
}

async function run(name: string, inp: any): Promise<Out> {
  const p = st.project;
  if (!p) throw new Error("열린 프로젝트가 없습니다");
  if (name === "find_faces" || name === "equirect_sheet" || name === "track_people") sawPanorama = true;
  const waitFor = stepNow && laterStepOf(name, stepNow.current, stepNow.later);
  if (waitFor) throw new Error(`${name}은 다음 단계 "${waitFor}"의 일입니다. 지금은 쓸 수 없습니다. 이 단계의 결과를 finish_step으로 넘기세요.`);
  switch (name) {
    case "get_project_overview": return overview();
    case "get_transcript": {
      if (inp.asset_id) {
        const a = getAsset(inp.asset_id);
        if (!a.words) return `받아쓰기가 없습니다 (${tState(a)}). transcribe를 먼저 하세요.`;
        const ws = a.words.filter((w) => w.e >= (inp.from ?? 0) && w.s <= (inp.to ?? 1e9)).map((w, wi) => ({ ...w, clip: "", ci: 0, wi, asset: a.id, t0: w.s, t1: w.e }));
        return `${a.info.name} (원본 시간)\n` + transcriptText(ws);
      }
      const d = getDraft(inp.draft_id);
      const ws = draftWords(d, assetMap()).filter((w) => w.t1 >= (inp.from ?? 0) && w.t0 <= (inp.to ?? 1e9));
      return ws.length ? `편집본 "${d.name}" (타임라인 시간)\n` + transcriptText(ws) : "이 편집본의 클립에는 받아쓰기가 없습니다.";
    }
    case "search_transcript": {
      const q = String(inp.query).replace(/\s+/g, "");
      const hits: string[] = [];
      for (const a of p.assets) {
        if (!a.words) continue;
        const flat = a.words.map((w) => w.t.replace(/\s+/g, ""));
        for (let i = 0; i < flat.length && hits.length < 40; i++) {
          let acc = "";
          for (let j = i; j < Math.min(flat.length, i + 12); j++) {
            acc += flat[j];
            if (acc.includes(q)) {
              const ctx = a.words.slice(Math.max(0, i - 6), Math.min(a.words.length, j + 7)).map((w) => w.t).join(" ");
              hits.push(`${a.id} | ${a.info.name} | ${r3(a.words[i].s)}–${r3(a.words[j].e)}초 | …${ctx}…`);
              i = j;
              break;
            }
            if (acc.length > q.length + 20) break;
          }
        }
      }
      return hits.length ? hits.join("\n") : "찾지 못했습니다.";
    }
    case "view_frames": {
      const a = getAsset(inp.asset_id);
      const times = (inp.times as number[]).slice(0, 8);
      const r360 = is360(a);
      // 360: a flat view straight from the original (an .osv's two lens tracks put side by side).
      const lens = r360 ? { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 } : undefined;
      const shots = await api.frames(a.info.path, times, 768, r360 ? normView(inp.view) : undefined, lens);
      const pics: ChatBlock[] = shots.flatMap((b, i) => [{ type: "text", text: `${a.info.name} ${r3(times[i])}초` }, img(b)]);
      return r360 ? [{ type: "text", text: `한 방향만 보이는 사진입니다. ${PEOPLE_360_RULE}` }, ...pics] : pics;
    }
    case "contact_sheet": {
      const a = getAsset(inp.asset_id);
      const cols = Math.min(6, inp.cols ?? 5), rows = Math.min(6, inp.rows ?? 4);
      const start = inp.start ?? 0;
      const every = inp.every ?? Math.max(1, (a.info.duration - start) / (cols * rows));
      // An .osv's .lrf (both lenses side by side) reads quicker than the full-size original.
      const path = a.info.layout360 === "dual" && a.info.lrf ? a.info.lrf : a.info.path;
      const b = await api.contactSheet(path, start, every, cols, rows, 240);
      return [{ type: "text", text: `${a.info.name}: ${r3(start)}초부터 ${r3(every)}초 간격, ${cols}×${rows}칸 (왼쪽 위부터 오른쪽으로)${is360(a) ? "" + PEOPLE_360_RULE + " — 360 원본의 어안 렌즈 그림이라 둥글게 휘어 보입니다. 특정 방향은 view_frames로 보세요" : ""}` }, img(b)];
    }
    case "create_draft": {
      let d = newDraft(String(inp.name || "새 편집본"), inp.aspect || "16:9");
      d = capAiViews(d, applyOps(d, (inp.clips ?? []).map((c: any) => ({ op: "insert", ...c }))), !!inp.allow_steep);
      setDrafts(`AI: 편집본 만들기 "${d.name}"`, [...p.drafts, d], d.id);
      set({ playhead: 0, sourceId: null });
      return `만들었습니다.\n` + draftInfo(d);
    }
    case "get_draft": return draftInfo(getDraft(inp.draft_id));
    case "edit_draft": {
      const d0 = getDraft(inp.draft_id);
      const d = capAiViews(d0, applyOps(d0, inp.ops ?? []), !!inp.allow_steep);
      editDraft(`AI: 편집본 수정`, () => d, d0.id);
      return `적용했습니다. 길이 ${r3(draftDuration(d0))}초 → ${r3(draftDuration(d))}초\n` + draftInfo(d);
    }
    case "get_playbook": {
      const s = findSkill(st.skills, String(inp.name ?? ""));
      if (!s) throw new Error(`없는 안내: ${inp.name}. 있는 것: ${[...st.skills, ...BUILTIN_SKILLS].map((x) => x.name).join(", ")}`);
      return s.body;
    }
    case "save_skill": {
      const next = upsertSkill(st.skills, { name: String(inp.name ?? ""), description: String(inp.description ?? ""), triggers: inp.triggers, body: String(inp.body ?? "") });
      await saveSkills(next);
      return `스킬 "${next[0].name}"을 저장했습니다. 사용자가 설정 > AI 편집에서 보고 고칠 수 있습니다.`;
    }
    case "merge_skills": {
      const k = mergeSkills({ name: String(inp.name ?? ""), description: inp.description, triggers: inp.triggers, steps: inp.steps ?? [] }, st.skills);
      await saveSkills(upsertSkill(st.skills, k));
      return `병합 스킬 "${k.name}"을 저장했습니다: ${k.steps!.map(stepLabel).join(" → ")}. 실행하려면 run_merged_skill을 부르세요.`;
    }
    case "run_merged_skill": {
      const k = findSkill(st.skills, String(inp.name ?? ""));
      if (!isChain(k)) throw new Error(`병합 스킬이 아닙니다: ${inp.name}`);
      chainSkills(k!, st.skills);
      pendingChain = { skill: k!, request: String(inp.request ?? "") };
      return `"${k!.name}"을 준비했습니다. 지금 바로 차례를 끝내세요. 앱이 ${k!.steps!.length}단계를 차례로 시킵니다.`;
    }
    case "finish_step": {
      if (!chainRunning) return "지금은 병합 스킬을 실행하는 중이 아닙니다.";
      // A step that looks for people in 360 footage cannot end before the whole panorama has been searched:
      // what it reports may rest on a fisheye or one-way picture, however it is worded.
      const round = (st.project?.assets ?? []).filter(is360);
      if (!sawPanorama && round.length && stepNow && looksForPeople(stepNow.current)) {
        sawPanorama = true;
        const asked = rangeFromText(stepNow?.request ?? "");
        const found: string[] = [];
        for (const a of round.slice(0, 4)) {
          const [from, to] = asked ? [Math.max(0, asked[0]), Math.min(a.info.duration, asked[1])] : [0, a.info.duration];
          if (to <= from) continue;
          found.push(`${a.id} ${a.info.name}:\n${String(await run("find_faces", { asset_id: a.id, times: panoramaTimes(from, to) }))}`);
        }
        return `아직 이 단계를 끝내지 않았습니다. ${PEOPLE_360_RULE} 파노라마를 보지 않아서 앱이 find_faces를 돌렸습니다:\n${found.join("\n")}\n얼굴이 있는 시각을 equirect_sheet로 보고, 앞에서 판단한 것을 고친 뒤 finish_step을 다시 부르세요.`;
      }
      stepReport = { ok: inp.ok !== false, summary: cleanSummary(String(inp.summary ?? "")), items: Array.isArray(inp.items) ? inp.items : undefined };
      return "기록했습니다. 차례를 끝내세요.";
    }
    case "delete_skill": {
      const n = cleanSkillName(String(inp.name ?? ""));
      if (!st.skills.some((s) => s.name === n)) throw new Error(`사용자가 만든 스킬 중에 "${n}"이 없습니다`);
      await saveSkills(st.skills.filter((s) => s.name !== n));
      return `스킬 "${n}"을 지웠습니다.`;
    }
    case "ask_options": {
      const card: ChoiceCard = { id: uid(), question: String(inp.question ?? ""), multi: !!inp.multi_select, recommended: inp.recommended !== false, options: (inp.options ?? []).slice(0, 8).map((o: any) => ({ label: String(o.label), detail: o.detail ? String(o.detail) : undefined, meaning: o.meaning ? String(o.meaning) : undefined })), at: Date.now() };
      if (!card.options.length) throw new Error("options가 비었습니다");
      const sid = activeChat()?.id;
      mutateChat((c) => ({ ...c, cards: [...(c.cards ?? []), card] }), sid);
      set({ agentStatus: "고르기를 기다리는 중…" });
      return await new Promise<string>((res) => waiting.set(card.id, res));
    }
    case "get_sdk_types": return SDK_TYPES;
    case "run_script": {
      const secs = Math.max(1, Math.min(Number(inp.timeout_seconds) || 60, 600));
      const max = Math.max(200, Number(inp.max_result_bytes) || 20000);
      const textOf = (out: Out) => (typeof out === "string" ? out : out.filter((b) => b.type === "text").map((b) => String(b.text)).join(" "));
      const clip = (t: string) => (t.length > max ? `${t.slice(0, max)}\n… (${t.length}자 중 ${max}자까지)` : t);
      try {
        const r = await runScript(String(inp.script ?? ""), { summary: String(inp.summary ?? ""), timeoutMs: secs * 1000, call: async (name, input) => textOf(await run(name.replace(/^mcp__\w+__/, ""), input)) });
        const parts = [`완료. ${r.changed ? "바뀐 것은 되돌리기 한 번으로 돌아갑니다." : "바뀐 것은 없습니다."}`];
        if (r.logs.length) parts.push(`console:\n${r.logs.join("\n")}`);
        if (r.value !== undefined) parts.push(`결과:\n${JSON.stringify(r.value)}`);
        return clip(parts.join("\n"));
      } catch (e) {
        const logs: string[] = (e as any).logs ?? [];
        throw new Error(clip(`${(e as Error).message ?? e}${logs.length ? `\nconsole:\n${logs.join("\n")}` : ""}`));
      }
    }
    case "run_steps": {
      const steps: Step[] = inp.steps ?? [];
      const stop = inp.stop_on_error !== false;
      const lines: string[] = [];
      for (let i = 0; i < steps.length; i++) {
        // The model may use the name it knows the tool by in account mode.
        const s = { ...steps[i], tool: String(steps[i].tool).replace(/^mcp__\w+__/, "") };
        if (NOT_IN_BATCH.has(s.tool)) { lines.push(`${i + 1}. ${s.tool}: 여기서는 쓸 수 없습니다`); if (stop) break; continue; }
        try {
          const out = await run(s.tool, s.input ?? {});
          const text = typeof out === "string" ? out : (out as ChatBlock[]).filter((b) => b.type === "text").map((b) => String(b.text)).join(" ");
          lines.push(`${i + 1}. ${s.tool}: ${text.slice(0, 600)}`);
        } catch (e) {
          lines.push(`${i + 1}. ${s.tool}: 실패 (${(e as Error)?.message ?? e})`);
          if (stop) { lines.push(`여기서 멈췄습니다 (${steps.length - i - 1}단계 남음).`); break; }
        }
      }
      return lines.join("\n");
    }
    case "equirect_sheet": {
      const a = getAsset(inp.asset_id);
      if (!is360(a)) throw new Error("360 영상이 아닙니다");
      const times = (inp.times as number[]).slice(0, 6);
      const lens = { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 };
      const shots = await api.eqSheet(a.info.path, lens, times, Math.min(1920, Math.max(480, inp.width ?? 960)));
      return [{ type: "text", text: "가로 0~960 = 방위 -180~180°(480 = 정면), 세로 240 = 수평선(위가 위쪽). 격자 눈금으로 [x,y]를 읽으세요." }, ...shots.flatMap((b, i) => [{ type: "text", text: `${a.info.name} ${r3(times[i])}초` } as ChatBlock, img(b)])];
    }
    case "save_scene_notes": {
      const a = getAsset(inp.asset_id);
      const scenes = mergeScenes(a.scenes, inp.notes ?? []);
      patchAsset(a.id, { scenes });
      return `${a.info.name}: 장면 설명 ${scenes.length}개가 저장되어 있습니다.`;
    }
    case "search_scenes": {
      const hits = searchScenes(p.assets, String(inp.query ?? ""));
      const none = p.assets.filter((a) => a.info.kind === "video" && !a.scenes?.length).map((a) => `${a.id} ${a.info.name}`);
      const lines = hits.map((h) => `${h.asset} | ${p.assets.find((a) => a.id === h.asset)?.info.name} | ${r3(h.t)}초 | ${h.text}`);
      return (lines.length ? lines.join("\n") : "찾지 못했습니다.") + (none.length ? `\n장면 설명이 아직 없는 미디어: ${none.join(", ")}` : "");
    }
    case "scan_bad_shots": {
      const a = getAsset(inp.asset_id);
      const found = await scanShots(a.id, inp.from, inp.to);
      const name = { blurry: "흐림", shaky: "흔들림", dark: "어두움" };
      return found.length ? found.map((b) => `${r3(b.from)}–${r3(b.to)}초 ${name[b.kind]}`).join("\n") : "문제 구간이 없습니다.";
    }
    case "scan_gaze": {
      const a = getAsset(inp.asset_id);
      if (a.info.kind !== "video") throw new Error("영상이 아닙니다");
      const step = Number(inp.step) || 2;
      const lens = is360(a) ? { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 } : null;
      const looks = await api.scanGaze(a.info.path, lens, Number(inp.from), Math.min(Number(inp.to), a.info.duration), step);
      const spans = gazeSpans(looks, step, is360(a) ? GAZE_MIN_FACE_360 : 0);
      const withFace = looks.filter((l) => l.faces.length).length;
      return `${looks.length}곳을 봤고 그중 ${withFace}곳에 얼굴이 있었습니다. 카메라 쪽을 향한 구간 ${spans.length}개 (머리 방향 기준):\n${spans.map((x) => `${x.from}~${x.to}초, 얼굴 ${x.faces}개`).join("\n") || "없음"}`;
    }
    case "measure_loudness": {
      const a = getAsset(inp.asset_id), from = Number(inp.start) || 0, to = Math.min(Number(inp.end) || a.info.duration, a.info.duration);
      const r = await api.measure("loudness", a.info.path, from, to);
      const each = r.series.filter((_: unknown, i: number) => i % 10 === 0).map((p: any) => `${Math.round(p.t)}초 ${Math.round(p.db)}dB`).join(", ");
      return `전체 ${r.lufs} LUFS, 범위 ${r.range ?? "?"} LU, 최고점 ${r.peak ?? "?"} dBFS\n${each}`;
    }
    case "find_beats": {
      const a = getAsset(inp.asset_id), from = Number(inp.start) || 0, to = Math.min(Number(inp.end) || a.info.duration, a.info.duration);
      const r = await api.measure("beats", a.info.path, from, to);
      if (!r.beats.length) return "일정한 박자를 찾지 못했습니다 (구간이 4초보다 짧거나 소리가 없습니다).";
      return `${r.bpm} BPM, 확실한 정도 ${r.confidence}${r.confidence < 0.2 ? " (일정한 박자가 없어 보입니다)" : ""}, 박자 ${r.beats.length}개:\n${r.beats.slice(0, 400).join(" ")}${r.beats.length > 400 ? " …" : ""}`;
    }
    case "find_scene_cuts": {
      const a = getAsset(inp.asset_id), from = Number(inp.start) || 0, to = Math.min(Number(inp.end) || a.info.duration, a.info.duration);
      const r: { t: number; score: number }[] = await api.measure("scenes", a.info.path, from, to, Number(inp.threshold) || 0);
      return r.length ? `화면이 바뀌는 곳 ${r.length}곳:\n${r.slice(0, 300).map((x) => `${x.t}초(${x.score})`).join(" ")}` : "화면이 갑자기 바뀌는 곳이 없습니다.";
    }
    case "find_audio_events": {
      const a = getAsset(inp.asset_id), from = Number(inp.start) || 0, to = Math.min(Number(inp.end) || a.info.duration, a.info.duration);
      const r: { from: number; to: number; kind: string; db: number }[] = await api.measure("events", a.info.path, from, to);
      return r.length ? `${r.length}곳 (소리 크기 기준):\n${r.slice(0, 300).map((x) => `${r3(x.from)}~${r3(x.to)}초 ${x.kind} ${x.db}dB`).join("\n")}` : "눈에 띄는 구간이 없습니다.";
    }
    case "organize_media": {
      const moves = new Map<string, string>((inp.moves ?? []).map((m: any) => [String(m.asset_id), String(m.folder ?? "").trim()]));
      const names = [...new Set(moves.values())].filter(Boolean);
      mutate((p) => ({ ...p, folders: [...new Set([...(p.folders ?? []), ...names])], assets: p.assets.map((a) => (moves.has(a.id) ? { ...a, folder: moves.get(a.id)! } : a)) }));
      return `미디어 ${moves.size}개를 옮겼습니다. 폴더: ${names.join(", ") || "맨 위"}`;
    }
    case "find_faces": {
      const a = getAsset(inp.asset_id);
      if (!is360(a)) throw new Error("360 영상이 아닙니다");
      const lens = { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 };
      const found = await api.findFaces(a.info.path, lens, inp.times);
      return found.map((r) => `${r3(r.t)}초: ${r.faces.length ? r.faces.map((f) => `[x ${Math.round(f.x + f.w / 2)}, y ${Math.round(f.y + f.h / 2)}, 크기 ${Math.round(f.w)}]`).join(" ") : "얼굴 없음"}`).join("\n");
    }
    case "track_people": {
      const a = getAsset(inp.asset_id);
      if (!is360(a)) throw new Error("360 영상이 아닙니다");
      const lens = { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 };
      const subs = (inp.subjects ?? []).map((s: any, i: number) => ({ name: String(s?.name ?? `사람${i + 1}`), seeds: s.seeds }));
      const res = await api.trackPeople(a.info.path, lens, inp.from, inp.to, subs);
      // About one mark a second is plenty to hand on to frame_subject.
      return res.map((s) => `${s.name}: ${s.tracked}% 추적\n${JSON.stringify(s.marks.filter((_, i) => i % 5 === 0))}`).join("\n");
    }
    case "frame_subject": {
      const d0 = getDraft(inp.draft_id);
      const c = d0.clips.find((x) => x.id === inp.clip_id);
      if (!c) throw new Error(`클립 없음: ${inp.clip_id}`);
      if (!is360(getAsset(c.asset))) throw new Error("360 영상 클립이 아닙니다");
      const toMark = (m: any): Mark => (Array.isArray(m) ? { t: m[0], x: m[1], y: m[2], hfov: m[3] } : m);
      const subjects: Subject[] = (inp.subjects ?? []).map((s: any, i: number) => ({ name: String(s?.name ?? `사람${i + 1}`), marks: (s?.marks ?? []).map(toMark) })).filter((s: Subject) => s.marks.length);
      const marks: Mark[] = (inp.marks ?? []).map(toMark);
      if (!marks.length && !subjects.length) throw new Error("marks나 subjects가 비었습니다");
      const [aw, ah] = d0.aspect.split(":").map(Number);
      const from = Math.max(c.start, inp.from ?? c.start), to = Math.min(c.end, inp.to ?? c.end);
      const opts = { aspect: aw / ah || 16 / 9, hfov: inp.hfov, headroom: inp.headroom, step: inp.step, sigma: inp.smooth, free: !!inp.allow_steep };
      let note = "";
      let keys;
      let people: Subject[] = subjects.length ? subjects : [{ name: "사람", marks }];
      // The marks are starting points: follow each head between them with the built-in tracker.
      if (inp.track !== false && to - from <= 180) {
        try {
          const a = getAsset(c.asset);
          const lens = { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 };
          const seeds = people.map((s) => ({ name: s.name, seeds: s.marks.map((m) => [m.t, m.x, m.y] as [number, number, number]) }));
          const tracked = await api.trackPeople(a.info.path, lens, from, to, seeds);
          people = people.map((s, i) => {
            const tr = tracked[i];
            return tr && tr.marks.length >= s.marks.length ? { name: s.name, marks: tr.marks.map(([t, x, y]) => ({ t, x, y })) } : s;
          });
          note += `\n자동 추적: ${tracked.map((s) => `${s.name} ${s.tracked}%`).join(", ")}`;
        } catch (e) {
          note += `\n자동 추적을 못 해 표시만 썼습니다: ${e}`;
        }
      }
      // A tracker that slid onto the floor or jumped away must not steer the view.
      people = people.map((p) => ({ ...p, marks: saneMarks(p.marks) })).filter((p) => p.marks.length);
      if (!people.length) throw new Error("쓸 만한 머리 위치가 남지 않았습니다. 표시를 다시 찍어 주세요");
      if (people.length > 1 || inp.track !== false) {
        const g = frameGroup(people, from, to, opts);
        keys = g.keys;
        note += `\n화면 안 비율: ${g.report.subjects.map((s) => `${s.name} ${s.inFrame}%`).join(", ")}`
          + (g.report.tooFar.length ? `\n너무 멀리 떨어져 한 화면에 다 못 담은 구간(원본 초): ${g.report.tooFar.map(([a, b]) => `${r3(a)}–${r3(b)}`).join(", ")}. 이 구간은 클립을 나눠 한 사람씩 번갈아 따라가고, 두 사람의 화면 시간이 비슷하게 맞추세요.` : "");
      } else {
        keys = frameSubject(marks, from, to, opts);
      }
      if (!keys.length) throw new Error("키프레임을 만들 수 없습니다 (marks나 구간 확인)");
      // A cut jumps less when this clip tilts about as the one before it ended.
      const before = d0.clips[d0.clips.indexOf(c) - 1]?.viewKeys;
      if (before?.length && !opts.free) keys = easePitch(keys, before[before.length - 1].view.pitch, people, opts.aspect);
      // Remembered so check_framing can tell who is in frame.
      const d = updateClip(d0, c.id, { viewKeys: keys, ...(subjects.length ? { subjects: people.map((p) => ({ name: p.name, marks: thinMarks(p.marks) })) } : {}) });
      editDraft("AI: 사람 따라가기", () => d, d0.id);
      return `${c.id}에 시점 키프레임 ${keys.length}개를 넣었습니다 (원본 ${keys[0].t}–${keys[keys.length - 1].t}초, ${r3(inp.step ?? 0.1)}초 간격, 머리 위 여백 ${inp.headroom ?? 0.33}).${note} check_framing으로 확인하세요.`;
    }
    case "get_view_keys": {
      const c = getDraft(inp.draft_id).clips.find((x) => x.id === inp.clip_id);
      if (!c) throw new Error(`클립 없음: ${inp.clip_id}`);
      const ks = c.viewKeys ?? [];
      if (!ks.length) return `키프레임 없음. 고정 시점: ${JSON.stringify(c.view ?? null)}`;
      const shown = sampleKeys(ks, Math.max(2, Math.min(200, inp.max ?? 60)));
      return `키프레임 ${ks.length}개 (${shown.length}개 표시) t | yaw | pitch | roll | hfov\n` + shown.map((k) => `${k.t} | ${k.view.yaw} | ${k.view.pitch} | ${k.view.roll} | ${k.view.hfov}`).join("\n");
    }
    case "check_framing": {
      const d = getDraft(inp.draft_id);
      const c = d.clips.find((x) => x.id === inp.clip_id);
      if (!c) throw new Error(`클립 없음: ${inp.clip_id}`);
      const a = getAsset(c.asset);
      if (!is360(a)) throw new Error("360 영상 클립이 아닙니다");
      const lens = { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 };
      const looks = c.subjects?.length ? await lookAtClip(d, c) : [];
      // The pictures show the worst moments first, then the rest of the clip evenly.
      const evenly = Array.from({ length: 6 }, (_, i) => c.start + ((i + 0.5) * (c.end - c.start)) / 6);
      const bad = looks.filter((l) => !l.ok).map((l) => l.t);
      const picks: number[] = inp.times?.length ? inp.times : [...bad.filter((_, i) => i % Math.max(1, Math.ceil(bad.length / 4)) === 0).slice(0, 4), ...evenly];
      const times = [...new Set(picks.map(r3))].sort((x, y) => x - y).slice(0, 8);
      const head = "머리가 화면 위에서 약 1/3 선에 있고 위·아래가 잘리지 않아야 합니다. 어긋나면 marks를 고쳐 frame_subject를 다시 하세요.";
      const out: ChatBlock[] = [{ type: "text", text: c.subjects?.length ? `${head}\n${lookSummary(looks)}\n자동 판단은 얼굴 인식과 추적 기준이라 틀릴 수 있습니다. 아래 사진을 직접 보고 누가 있는지 판단하세요. 따라갈 사람이 빠졌거나 다른 어른이 화면을 차지하면 표시를 고쳐 frame_subject를 다시 하고, 고칠 수 없으면 trim_to_subjects로 그 부분을 뺍니다.` : head }];
      const seen = await api.faceCheck(a.info.path, lens, times.map((t) => [t, viewAt(c.view, c.viewKeys, t)] as [number, View])).catch(() => []);
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        const v = viewAt(c.view, c.viewKeys, t);
        const [b] = await api.frames(a.info.path, [t], 640, v, lens);
        const f = seen[i];
        const faces = f ? ` | 얼굴 ${f.faces}개${f.edges.length ? ` · 가장자리에 걸림: ${f.edges.join(", ")}` : ""}` : "";
        const l = looks.length ? looks.reduce((x, y) => (Math.abs(y.t - t) < Math.abs(x.t - t) ? y : x)) : null;
        const who = l ? ` | 자동: ${l.ok ? "모두 안" : `${l.missing.length ? `${l.missing.join(", ")} 없음` : ""}${l.bigOther ? " 다른 사람이 크게 나옴" : ""}`.trim()}` : "";
        out.push({ type: "text", text: `${r3(t)}초 | yaw ${v.yaw} pitch ${v.pitch} hfov ${v.hfov}${faces}${who}` }, img(b));
      }
      return out;
    }
    case "trim_to_subjects": {
      const d0 = getDraft(inp.draft_id);
      const clips = d0.clips.filter((c) => c.subjects?.length && !isGap(c) && (!inp.clip_ids?.length || inp.clip_ids.includes(c.id)));
      if (!clips.length) throw new Error("따라갈 사람을 정한 클립이 없습니다. frame_subject의 subjects를 먼저 하세요");
      const notOk = (inp.not_ok_times ?? []).map(Number), yes = (inp.ok_times ?? []).map(Number);
      const before: { ok: boolean }[] = [], after: { ok: boolean }[] = [];
      const cuts: Record<string, [number, number][]> = {};
      const lines: string[] = [];
      for (const c of clips) {
        const looks = applyVerdicts(await lookAtClip(d0, c), notOk, yes);
        const step = looks.length > 1 ? looks[1].t - looks[0].t : 1;
        const spans = badSpans(looks, step, c.start, c.end);
        before.push(...looks);
        const left = spans.reduce((n, [x, y]) => n - (y - x), c.end - c.start);
        if (inp.apply !== false && spans.length && left >= 1) {
          cuts[c.id] = spans;
          after.push(...looks.filter((l) => !spans.some(([x, y]) => l.t >= x && l.t < y)));
          lines.push(`${c.id}: 원본 ${spans.map(([x, y]) => `${r3(x)}–${r3(y)}`).join(", ")}초를 뺐습니다`);
        } else {
          after.push(...looks);
          if (spans.length) lines.push(`${c.id}: 맞지 않는 구간 ${spans.map(([x, y]) => `${r3(x)}–${r3(y)}`).join(", ")}초${left < 1 ? " (빼면 거의 남지 않아 그대로 두었습니다)" : " (빼지 않았습니다)"}`);
        }
      }
      if (Object.keys(cuts).length) editDraft("AI: 사람이 없는 부분 빼기", (x) => cutSource(x, cuts), d0.id);
      const d = getDraft(d0.id);
      return `따라갈 사람이 모두 화면 안에 있는 비율(살펴본 ${after.length}곳 기준, 자동 판단과 AI가 본 것을 합침): ${percentOk(before)}% → ${percentOk(after)}%. 길이 ${r3(draftDuration(d0))}초 → ${r3(draftDuration(d))}초.\n${lines.join("\n") || "뺀 곳이 없습니다."}`;
    }
    case "snap_cuts": {
      const d0 = getDraft(inp.draft_id);
      const am = assetMap();
      for (const c of d0.clips) { const a = asset(c.asset); if (a && !a.words && !waves.has(a.id)) await loadWave(a); }
      const report: string[] = [];
      let d = d0;
      for (const c of d0.clips) {
        if (isGap(c) || (inp.clip_ids?.length && !inp.clip_ids.includes(c.id))) continue;
        const a = am.get(c.asset);
        const sp = a ? speechRuns(a.words, waves.get(a.id), c.start - 2, c.end + 2) : null;
        if (!sp?.length) continue;
        const { ranges, moved } = snapRanges([[c.start, c.end]], sp, { reach: inp.reach });
        if (!moved.length) continue;
        d = updateClip(d, c.id, { start: r3(ranges[0][0]), end: r3(ranges[0][1]) });
        report.push(`${c.id}: ${moved.map((m) => `${m.side === "start" ? "시작" : "끝"} ${m.from}→${m.to}`).join(", ")}`);
      }
      if (d !== d0) editDraft("AI: 컷 위치를 말 틈으로", () => d, d0.id);
      return report.length ? `컷 ${report.length}곳을 옮겼습니다.\n` + report.join("\n") : "옮길 컷이 없습니다 (이미 말 틈이거나 가까운 틈이 없음).";
    }
    case "delete_draft": {
      const id = String(inp.draft_id);
      if (!p.drafts.some((x) => x.id === id)) throw new Error(`편집본을 찾을 수 없습니다: ${id}`);
      if (p.drafts.length <= 1) throw new Error("마지막 편집본은 지울 수 없습니다");
      const rest = p.drafts.filter((x) => x.id !== id);
      setDrafts("AI: 편집본 지우기", rest, st.draftId === id ? rest[0].id : st.draftId);
      return `지웠습니다. 남은 편집본 ${rest.length}개 (Ctrl+Z로 되돌릴 수 있음)`;
    }
    case "remove_silences": {
      const d0 = getDraft(inp.draft_id);
      for (const c of d0.clips) { const a = asset(c.asset); if (a && !a.words && !waves.has(a.id)) await loadWave(a); }
      const { draft, removed } = removeSilences(d0, assetMap(), waves, inp.pacing as Pacing);
      editDraft(`AI: 무음 정리`, () => draft, d0.id);
      return `무음 ${r3(removed)}초를 잘라 냈습니다. 길이 ${r3(draftDuration(d0))}초 → ${r3(draftDuration(draft))}초, 클립 ${d0.clips.length}개 → ${draft.clips.length}개`;
    }
    case "remove_fillers": {
      const d0 = getDraft(inp.draft_id);
      const found = draftWords(d0, assetMap()).filter((w) => isFiller(w.t)).map((w) => w.t);
      const { draft, count } = removeFillers(d0, assetMap());
      editDraft(`AI: 군더더기 말 정리`, () => draft, d0.id);
      return count ? `군더더기 말 ${count}개(${[...new Set(found)].join(", ")})를 잘라 냈습니다. 길이 ${r3(draftDuration(d0))}초 → ${r3(draftDuration(draft))}초` : "군더더기 말을 찾지 못했습니다 (받아쓰기가 없으면 먼저 transcribe).";
    }
    case "add_markers": {
      const d0 = getDraft(inp.draft_id);
      editDraft("AI: 마커", (d) => ({ ...d, markers: [...d.markers, ...(inp.markers as any[]).map((m) => ({ id: uid(), t: Number(m.time), label: String(m.label), color: m.color || "#FFB020" }))] }), d0.id);
      return `마커 ${inp.markers.length}개를 달았습니다.`;
    }
    case "sync_media": {
      const ids: string[] = inp.asset_ids ?? [];
      if (ids.length < 2) throw new Error("둘 이상 필요합니다");
      const out: string[] = [];
      for (const id of ids.slice(1)) {
        const r = await syncAssets(ids[0], id);
        out.push(`${getAsset(id).info.name}: 기준 ${r.offset >= 0 ? "+" : ""}${r.offset.toFixed(2)}초에 시작 (확실함 ${r.clear})`);
      }
      return out.join("\n");
    }
    case "multicam_draft": {
      const sound = getAsset(inp.sound_asset_id);
      const cuts = (inp.cuts ?? []).map((c: any) => ({ at: Number(c.at), asset: getAsset(c.asset_id) }));
      if (!cuts.length) throw new Error("cuts가 비었습니다");
      const d = multicamDraft(String(inp.name || "멀티캠"), sound, cuts, (a) => a.syncOffset ?? 0, Number(inp.end), inp.aspect || "16:9");
      if (!d.clips.length) throw new Error("겹치는 구간이 없습니다 (sync_media를 먼저 하세요)");
      setDrafts(`AI: 멀티캠 "${d.name}"`, [...p.drafts, d], d.id);
      set({ playhead: 0, sourceId: null });
      return `만들었습니다.\n` + draftInfo(d);
    }
    case "auto_color": {
      const d0 = getDraft(inp.draft_id);
      const clips = d0.clips.filter((c) => !isGap(c) && (!inp.clip_ids?.length || inp.clip_ids.includes(c.id)));
      const out: string[] = [];
      let d = d0;
      for (const c of clips) {
        const a = getAsset(c.asset);
        if (a.info.kind === "audio") continue;
        const r360 = is360(a);
        const lens = r360 ? { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 } : undefined;
        const r = await api.autoColor(a.info.path, c.start, c.end, lens, r360 ? viewAt(c.view, c.viewKeys, (c.start + c.end) / 2) : undefined);
        d = updateClip(d, c.id, { color: { ...DEFAULT_COLOR, ...c.color, ...r } });
        out.push(`${c.id}: 노출 ${r.exposure}, 대비 ${r.contrast}, 색온도 ${r.temperature}K`);
      }
      editDraft("AI: 자동 색 보정", () => d, d0.id, false);
      return out.join("\n") || "맞출 클립이 없습니다.";
    }
    case "set_look": {
      const d0 = getDraft(inp.draft_id);
      const look = LOOKS.find((l) => l.id === inp.look)?.color ?? {};
      let d = d0;
      let n = 0;
      for (const c of d0.clips) {
        if (isGap(c) || (inp.clip_ids?.length && !inp.clip_ids.includes(c.id))) continue;
        d = updateClip(d, c.id, { color: { ...DEFAULT_COLOR, ...c.color, ...look, ...(inp.color ?? {}) } });
        n++;
      }
      editDraft("AI: 색", () => d, d0.id, false);
      return `클립 ${n}개의 색을 바꿨습니다.`;
    }
    case "paste_attributes": {
      const d0 = getDraft(inp.draft_id);
      const from = d0.clips.find((c) => c.id === inp.from_clip_id);
      if (!from) throw new Error(`클립 없음: ${inp.from_clip_id}`);
      let n = 0;
      editDraft("AI: 속성 붙여넣기", (x) => ({ ...x, clips: x.clips.map((c) => {
        if (isGap(c) || c.id === from.id || (inp.to_clip_ids?.length && !inp.to_clip_ids.includes(c.id))) return c;
        n++;
        return pasteAttrs(c, from, inp.attrs ?? []);
      }) }), d0.id);
      return `클립 ${n}개에 붙여 넣었습니다.`;
    }
    case "set_motion": {
      const d0 = getDraft(inp.draft_id);
      const c = d0.clips.find((x) => x.id === inp.item_id);
      const o = overlays(d0).find((x) => x.id === inp.item_id);
      const it = c ?? o;
      if (!it) throw new Error(`없는 항목: ${inp.item_id}`);
      const keys: AnimKey[] | undefined = inp.preset === "none" ? undefined : inp.preset ? movePreset(inp.preset, it.start, it.end, inp.amount ?? 0.15)
        : (inp.keys ?? []).map((k: any) => ({ t: Number(k.t), scale: k.scale ?? 1, x: k.x ?? 0, y: k.y ?? 0, opacity: k.opacity ?? 1 }));
      editDraft("AI: 움직임", (d) => (c ? updateClip(d, c.id, { anim: keys }) : { ...d, overlays: overlays(d).map((x) => (x.id === inp.item_id ? { ...x, anim: keys } : x)) }), d0.id, false);
      return keys?.length ? `움직임을 넣었습니다 (키 ${keys.length}개).` : "움직임을 껐습니다.";
    }
    case "set_volume_keys": {
      const d0 = getDraft(inp.draft_id);
      const keys: VolKey[] | undefined = inp.keys?.length ? inp.keys.map((k: any) => ({ t: Number(k.t), v: Number(k.v) })) : undefined;
      const patch = <T extends { id: string }>(x: T) => (x.id === inp.item_id ? { ...x, volKeys: keys } : x);
      editDraft("AI: 음량 키프레임", (d) => ({ ...d, clips: d.clips.map(patch), music: d.music.map(patch), overlays: overlays(d).map(patch) }), d0.id, false);
      return keys ? `음량 키 ${keys.length}개를 넣었습니다.` : "음량 키를 껐습니다.";
    }
    case "fit_music": {
      const d0 = getDraft(inp.draft_id);
      const m = d0.music.find((x) => x.id === inp.music_id);
      if (!m) throw new Error(`없는 소리: ${inp.music_id}`);
      const a = getAsset(m.asset);
      editDraft("AI: 음악 길이 맞추기", (d) => fitMusic(d, m.id, a.info.duration, inp.fade ?? 2), d0.id, false);
      const n = getDraft(d0.id).music.filter((x) => x.asset === m.asset).length;
      return `영상 길이 ${r3(draftDuration(getDraft(d0.id)))}초에 맞췄습니다 (음악 조각 ${n}개).`;
    }
    case "add_text": {
      const d0 = getDraft(inp.draft_id);
      const add: TextItem[] = (inp.items ?? []).map((m: any) => {
        const k = TEXT_KINDS.find((x) => x.id === m.kind);
        return { id: uid(), kind: m.kind, at: Math.max(0, Number(m.at) || 0), dur: Math.max(0.3, Number(m.dur) || k?.dur || 3), text: String(m.text ?? ""), sticker: m.sticker, x: m.x, y: m.y, size: m.size, color: m.color };
      });
      editDraft("AI: 글자·스티커", (d) => ({ ...d, texts: [...(d.texts ?? []), ...add] }), d0.id, false);
      return `${add.length}개를 올렸습니다: ${add.map((t) => `${t.id} ${t.kind} ${r3(t.at)}초`).join(", ")}`;
    }
    case "remove_text": {
      const d0 = getDraft(inp.draft_id);
      const ids: string[] | undefined = inp.ids;
      editDraft("AI: 글자 지우기", (d) => ({ ...d, texts: ids?.length ? (d.texts ?? []).filter((t) => !ids.includes(t.id)) : [] }), d0.id, false);
      return "지웠습니다.";
    }
    case "get_captions": {
      const d = getDraft(inp.draft_id);
      const { lines } = draftCaptions(d, draftWords(d, assetMap()));
      const use = lines.filter((l) => l.t1 > (inp.from ?? 0) && l.t0 < (inp.to ?? Infinity));
      if (!use.length) return "자막으로 쓸 말이 없습니다. 받아쓰기를 먼저 하세요.";
      const tr = new Map((d.translation?.items ?? []).map((i) => [i.from, i.text]));
      return [`자막 ${d.captions ? "켬" : "끔"}, ${use.length}줄${d.translation ? `, 번역 ${d.translation.lang}` : ""}`, ...use.map((l) => `${l.key} | ${r3(l.t0)}-${r3(l.t1)} | ${l.hidden ? "(숨김) " : ""}${l.text.replace(/\n/g, " / ")}${tr.has(l.key ?? "") ? ` | 번역: ${tr.get(l.key ?? "")}` : ""}${l.words && l.words.length > 1 ? ` | 단어: ${l.words.map((w) => `${wordKey(w)}=${w.t}`).join(" ")}` : ""}`)].join("\n");
    }
    case "edit_captions": {
      const d0 = getDraft(inp.draft_id);
      let e = d0.capEdits;
      for (const o of inp.ops ?? []) {
        const lines = captionLines(draftWords(d0, assetMap()), d0.captionStyle.maxChars, { lines: d0.captionStyle.lines, breakBy: d0.captionStyle.breakBy, edits: e });
        const i = lines.findIndex((l) => l.key === o.key), l = lines[i];
        switch (o.op) {
          case "fix_word": e = { ...e, words: { ...e?.words, [o.key]: String(o.text) } }; break;
          case "break_before": e = setBreak(e, o.key, "break"); break;
          case "set_line": if (!l) throw new Error(`줄 없음: ${o.key}`); e = setLineText(e, l, String(o.text)); break;
          case "join_next": if (!lines[i + 1]) throw new Error(`다음 줄 없음: ${o.key}`); e = joinNext(e, lines[i + 1]); break;
          case "move_word_prev": if (!l) throw new Error(`줄 없음: ${o.key}`); e = moveWordPrev(e, l); break;
          case "hide": e = setHidden(e, o.key, true); break;
          case "show": e = setHidden(e, o.key, false); break;
          default: throw new Error(`모르는 op: ${o.op}`);
        }
      }
      editDraft("AI: 자막 고치기", (x) => ({ ...x, capEdits: e }), d0.id);
      return `자막을 ${(inp.ops ?? []).length}군데 고쳤습니다.`;
    }
    case "fix_words": {
      const pairs: { from: string; to: string }[] = inp.replace ?? [];
      const byKey = new Map<string, string>((inp.words ?? []).map((w: any) => [String(w.key), String(w.text)]));
      let n = 0;
      for (const a of st.project?.assets ?? []) {
        if (!a.words || (inp.asset_id && a.id !== inp.asset_id)) continue;
        const words = a.words.map((w, i) => {
          let t = byKey.get(`${a.id}:${i}`) ?? w.t;
          for (const p of pairs) t = t.split(p.from).join(p.to);
          if (t !== w.t) n++;
          return t === w.t ? w : { ...w, t };
        });
        patchAsset(a.id, { words });
      }
      return `단어 ${n}개를 고쳤습니다.`;
    }
    case "set_translation": {
      const d0 = getDraft(inp.draft_id);
      const { lines } = draftCaptions(d0, draftWords(d0, assetMap()));
      const at = new Map(lines.map((l) => [l.key, l]));
      const old = d0.translation?.lang === inp.lang ? d0.translation!.items : [];
      const items = new Map(old.map((i) => [i.from, i]));
      const missing: string[] = [];
      for (const it of inp.items ?? []) {
        const l = at.get(String(it.key));
        if (!l?.words?.length) { missing.push(String(it.key)); continue; }
        items.set(String(it.key), { from: String(it.key), to: wordKey(l.words[l.words.length - 1]), text: String(it.text) });
      }
      editDraft("AI: 번역", (x) => ({ ...x, translation: { lang: String(inp.lang), items: [...items.values()] }, capShow: inp.show ?? x.capShow ?? "both", captions: true }), d0.id);
      return `${inp.lang} 번역 ${items.size}줄을 넣었습니다 (전체 ${lines.length}줄).${missing.length ? ` 줄을 찾지 못한 key: ${missing.join(", ")}` : ""}`;
    }
    case "set_captions": {
      const d0 = getDraft(inp.draft_id);
      const look = CAPTION_PRESETS.find((p) => p.id === inp.style)?.style ?? {};
      editDraft("AI: 자막", (d) => ({
        ...d, captions: !!inp.enabled,
        captionStyle: { ...d.captionStyle, ...look, ...(inp.anim ? { anim: inp.anim } : {}), ...(inp.anim_by ? { animBy: inp.anim_by } : {}), ...(inp.lines ? { lines: Number(inp.lines) as 1 | 2 } : {}), ...(inp.break_by ? { breakBy: inp.break_by } : {}), ...(inp.keyword ? { keyword: inp.keyword, keyColor: inp.key_color ?? d.captionStyle.keyColor ?? "#FFE14D" } : {}), ...(inp.highlight != null ? { highlight: inp.highlight } : {}), ...(inp.align ? { align: inp.align } : {}), ...(inp.size ? { size: Number(inp.size) } : {}), ...(inp.position ? { position: inp.position } : {}), ...(inp.max_chars ? { maxChars: Number(inp.max_chars) } : {}) },
      }), d0.id);
      const n = draftWords(getDraft(d0.id), assetMap()).length;
      return inp.enabled ? `자막을 켰습니다 (단어 ${n}개 기준).${n ? "" : " 받아쓰기가 없어 자막이 비어 있습니다."}` : "자막을 껐습니다.";
    }
    case "transcribe": {
      const ids: string[] = inp.asset_ids;
      const res: string[] = [];
      for (const id of ids) {
        const a = getAsset(id);
        if (a.words) { res.push(`${a.info.name}: 이미 있음`); continue; }
        const w = waitJob(id, "transcribe");
        await startTranscribe(id);
        const after = asset(id)!;
        if (after.tState === "error") { res.push(`${a.info.name}: 실패 - ${after.tError}`); continue; }
        set({ agentStatus: `받아쓰는 중: ${a.info.name}` });
        const e = await w;
        await new Promise((r) => setTimeout(r, 50));
        res.push(e.state === "done" ? `${a.info.name}: 완료 (${asset(id)?.words?.length ?? 0}단어)` : `${a.info.name}: ${e.state} ${e.message}`);
      }
      return res.join("\n");
    }
    case "export_draft": {
      const d = getDraft(inp.draft_id);
      const pr = String(inp.preset);
      const shrink = pr.startsWith("shrink_");
      const given = splitOutName(String(inp.file_name ?? ""));
      const noFolder = given.dir && !(await api.dirExists(given.dir)) ? given.dir : "";
      set({ agentStatus: "내보내는 중…" });
      const e = await exportAndWait(d, {
        mode: pr === "audio" ? "audio" : shrink ? "shrink" : "standard", quality: shrink ? "fhd" : pr, preset: shrink ? pr.slice(7) : "balanced",
        codec: "auto", container: "mkv", dir: noFolder ? "" : given.dir, name: given.name, srt: !!inp.srt,
      });
      if (e.state !== "done") return `내보내기 실패: ${e.message}`;
      return `${noFolder ? `폴더 ${noFolder}이 없어 내보내기 폴더에 저장했습니다. ` : ""}내보냈습니다: ${e.result.path} (${(e.result.size / 1048576).toFixed(1)}MB, ${r3(e.result.duration)}초)${inp.srt ? ` 자막 파일: ${String(e.result.path).replace(/\.[^.\/]+$/, ".srt")}` : ""}${e.message ? " 경고: " + e.message : ""}`;
    }
  }
  throw new Error(`알 수 없는 도구: ${name}`);
}

// ---------------------------------------------------------------- loop

let stopFlag = false;
/** Cards the AI is waiting on; an answer ends the wait and comes back as the tool's result. */
const waiting = new Map<string, (answer: string) => void>();
export const isWaitingCard = (id: string) => waiting.has(id);
export const waitingCardOf = (c: ChatSession | null | undefined) => c?.cards?.find((k) => !k.used && waiting.has(k.id)) ?? null;
function endWait(id: string, answer: string) {
  const res = waiting.get(id);
  if (!res) return false;
  waiting.delete(id);
  mutateChat((c) => ({ ...c, cards: (c.cards ?? []).map((k) => (k.id === id ? { ...k, used: true } : k)) }));
  set({ agentStatus: "생각하는 중…" });
  res(answer);
  return true;
}
/** The user picked: the AI gets what each pick means. Returns false when the AI is no longer waiting. */
export function answerCard(card: ChoiceCard, picks: number[]): boolean {
  const lines = picks.map((i) => card.options[i]).map((o) => `- ${o.label}${o.meaning ? `: ${o.meaning}` : ""}`);
  return endWait(card.id, `사용자가 고른 것:\n${lines.join("\n")}`);
}
export const answerCardText = (card: ChoiceCard, text: string) => endWait(card.id, `사용자가 카드에서 고르지 않고 이렇게 답했습니다: ${text}`);

export const stopAgent = () => {
  stopFlag = true;
  stopScript();
  for (const id of [...waiting.keys()]) endWait(id, "사용자가 작업을 멈췄습니다. 여기서 끝내세요.");
  if (ccRunning) api.ccStop().catch(() => {});
};

// ---------------------------------------------------------------- skills in force, merged skills

/** Said to the AI with the next request only, and not shown in the conversation. */
let nextNote = "";
let turnNote = "";
let chainRunning = false;
let stepReport: StepResult | null = null;
/** The step of a merged skill now running; tools belonging to later steps wait. */
let stepNow: { request: string; current: Skill; later: { label: string; skill: Skill }[] } | null = null;
/** Whether this step has looked at a whole panorama. */
let sawPanorama = false;
let pendingChain: { skill: Skill; request: string } | null = null;

/** Tokens the skills in force will add to the next request. */
export function pendingSkillTokens(c: ChatSession | null | undefined): number {
  return c ? estTokens(activeNote(st.skills, c.activeSkills, c.skillsSent).note) : 0;
}

/** Puts a skill in force in this conversation, if it fits the context budget. */
export function addActiveSkill(name: string): boolean {
  const k = findSkill(st.skills, name);
  if (!k) return false;
  const c = activeChat() ?? chatById(newChat())!;
  const next = addActive(c.activeSkills, k.name);
  if (isChain(k) && next.some((n) => n !== k.name && isChain(findSkill(st.skills, n)))) { toast("병합 스킬은 한 번에 하나만 켤 수 있습니다"); return false; }
  const budget = activeBudget(ctxLimit(c.model ?? st.settings.model, st.settings));
  const size = estTokens(activeNote(st.skills, next, []).note);
  if (size > budget) { toast(`스킬이 너무 많습니다: 약 ${fmtK(size)} 토큰으로 한도 ${fmtK(budget)}를 넘습니다. 하나를 빼 주세요`); return false; }
  mutateChat((x) => ({ ...x, activeSkills: next }), c.id);
  return true;
}
export const removeActiveSkill = (name: string) => mutateChat((x) => ({ ...x, activeSkills: (x.activeSkills ?? []).filter((n) => n !== name) }));

/** What the chat box sends: skills named at the start go in force, and a merged skill in force runs. */
export async function askWithSkills(text: string) {
  const { names, rest } = parseSkillCommand(text, st.skills);
  for (const n of names) addActiveSkill(n);
  const chain = (activeChat()?.activeSkills ?? []).map((n) => findSkill(st.skills, n)).find(isChain);
  if (chain) {
    removeActiveSkill(chain.name);
    return runChain(chain, rest);
  }
  if (rest) await ask(rest);
}

/** Runs a merged skill: one request per step, in order, stopping at the first that fails. */
export async function runChain(chain: Skill, request: string) {
  const parts = chainSkills(chain, st.skills);
  const labels = parts.map((p) => stepLabel(p.step));
  const sid = (activeChat() ?? chatById(newChat())!).id;
  chainRunning = true;
  try {
    const end = await runChainSteps(labels, async (i, prev) => {
      stepReport = null;
      const head = `[${i + 1}/${labels.length}] ${labels[i]}`;
      sawPanorama = false;
      stepNow = { request, current: parts[i].skill, later: parts.slice(i + 1).map((p) => ({ label: stepLabel(p.step), skill: p.skill })) };
      nextNote = chainStepNote(chain.name, labels, i, parts[i].skill, request, prev);
      await ask(head);
      if (stopFlag) return { ok: false, summary: "사용자가 멈췄습니다" };
      if (!stepReport) {
        nextNote = "<merged-skill>이 단계의 결과를 finish_step으로 알려 주세요. 다른 일은 하지 마세요.</merged-skill>";
        await ask(`${head}: 결과 확인`);
        if (stopFlag) return { ok: false, summary: "사용자가 멈췄습니다" };
      }
      return stepReport ?? { ok: false, summary: "AI가 이 단계의 결과를 알리지 않았습니다" };
    }, (steps) => mutateChat((x) => ({ ...x, chain: { name: chain.name, request, steps } }), sid));
    toast(`${chain.name}: ${end.message}`);
  } finally {
    chainRunning = false;
    stepNow = null;
    nextNote = "";
  }
}

/** What each moment of a clip shows, by the face detector on the panorama and the people's tracked heads. */
const clipFaces = new Map<string, { t: number; faces: { x: number; y: number; w: number }[] }[]>();
async function lookAtClip(d: Draft, c: Clip): Promise<SubjectLook[]> {
  const a = getAsset(c.asset);
  const step = Math.max(1, (c.end - c.start) / 60);
  const key = `${a.id}:${r3(c.start)}:${r3(c.end)}:${step}`;
  let seen = clipFaces.get(key);
  if (!seen) {
    const lens = { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 };
    seen = await api.scanGaze(a.info.path, lens, c.start, c.end, step);
    clipFaces.set(key, seen);
  }
  const [aw, ah] = d.aspect.split(":").map(Number);
  return subjectLooks(c.subjects ?? [], seen, (t) => viewAt(c.view, c.viewKeys, t), aw / ah || 16 / 9);
}

function stateNote(): string {
  const d = st.project?.drafts.find((x) => x.id === st.draftId);
  return `<project-state>열린 편집본: ${d ? `${d.id} "${d.name}" (클립 ${d.clips.length}개, ${r3(draftDuration(d))}초)` : "없음"} | 미디어 ${st.project?.assets.length ?? 0}개 | 재생 위치 ${r3(st.playhead)}초${st.selClip ? ` | 선택한 클립 ${st.selClip}` : ""}</project-state>` + (turnNote ? `\n\n${turnNote}` : "");
}

const chatById = (sid: string) => st.project?.chats?.find((c) => c.id === sid) ?? null;

/** Appends to one session: the visible history and, after a compaction, the sent context too. */
function pushMsg(sid: string, m: ChatMsg) {
  mutateChat((c) => ({ ...c, messages: [...c.messages, m], context: c.context ? [...c.context, m] : undefined, updated: Date.now() }), sid);
}

/** Context size from a usage record: everything the model read plus what it wrote. */
const usageTokens = (u: any) => (u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) : 0);
function setCtx(sid: string, tokens: number, model: string) {
  if (tokens > 0) mutateChat((c) => ({ ...c, ctxTokens: tokens, model }), sid);
}

/** Tokens a fresh context holds before any conversation (system prompt and tools), per mode; measured on first turns. */
const BASE_KEY = "reelcut-ctx-base";
function baseTokens(mode: "account" | "api"): number {
  try { const v = JSON.parse(localStorage.getItem(BASE_KEY) || "{}")[mode]; if (v > 0) return v; } catch { /* default */ }
  return mode === "api" ? estTokens(sys() + JSON.stringify(TOOLS)) : 22_000;
}
function noteBase(mode: "account" | "api", ctx: number, sent: string) {
  const b = Math.max(1000, ctx - estTokens(sent) - 500);
  try { const all = JSON.parse(localStorage.getItem(BASE_KEY) || "{}"); all[mode] = all[mode] ? Math.min(all[mode], b) : b; localStorage.setItem(BASE_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

/** Starts a new conversation (the old ones stay in the list). */
export function newChat(): string {
  const c = newSession();
  mutate((p) => ({ ...p, chats: [...(p.chats ?? []), c], activeChat: c.id }));
  return c.id;
}

export async function ask(text: string) {
  if (!st.project || st.agentBusy) return;
  const mode = st.settings.aiMode ?? "account";
  let c = activeChat() ?? chatById(newChat())!;
  // A conversation stays on one connection; switching connection opens a new conversation.
  if (c.messages.length && (c.chatMode ?? "api") !== mode) { c = chatById(newChat())!; toast("연결 방식이 바뀌어 새 대화를 시작합니다"); }
  const sid = c.id;
  if (!c.messages.length) mutateChat((x) => ({ ...x, title: titleFrom(text), chatMode: mode }), sid);
  // Remember the drafts before this request, so its changes can be listed and undone as one.
  const run = { id: uid(), chat: sid, at: Date.now(), prompt: text, before: st.project.drafts, draftId: st.draftId, done: false };
  set({ aiRuns: [...st.aiRuns, run], agentBusy: true, agentStatus: "생각하는 중…" });
  try {
    await compactIfNeeded(sid, mode);
    // Skills are told after any compaction above, which forgets what was told before.
    const cur = chatById(sid)!;
    const skills = activeNote(st.skills, cur.activeSkills, cur.skillsSent);
    turnNote = [skills.note, nextNote].filter(Boolean).join("\n");
    nextNote = "";
    if (mode === "account") await askAccount(sid, text);
    else await askApi(sid, text);
    mutateChat((x) => ({ ...x, skillsSent: skills.sent }), sid);
  } finally {
    turnNote = "";
    set({ agentBusy: false, agentStatus: "", aiRuns: st.aiRuns.map((r) => (r.id === run.id ? { ...r, done: true, after: st.project?.drafts } : r)) });
    await saveNow();
  }
  const next = pendingChain;
  pendingChain = null;
  if (next && !stopFlag && !chainRunning) await runChain(next.skill, next.request);
}

async function askApi(sid: string, text: string) {
  const s = st.settings;
  if (!s.apiKey) throw new Error("설정에서 Anthropic API 키를 먼저 넣어 주세요.");
  stopFlag = false;
  pushMsg(sid, { role: "user", content: [{ type: "text", text: stateNote() }, { type: "text", text }] });
  const sent = () => { const c = chatById(sid)!; return c.context ?? c.messages; };
  for (let turn = 0; turn < 40; turn++) {
    if (stopFlag) break;
    const body: any = {
      model: s.model, max_tokens: 16000, system: sys(), tools: TOOLS, messages: sent(),
      thinking: { type: "adaptive" }, output_config: { effort: s.effort }, cache_control: { type: "ephemeral" },
    };
    let res: any;
    try {
      res = await api.claude(s.apiKey, body);
    } catch (e) {
      const msg = String(e);
      // A thinking block that no longer matches (e.g. the model was switched): drop thinking blocks once.
      if (/thinking/i.test(msg) && /signature|bound|different/i.test(msg)) {
        const strip = (ms?: ChatMsg[]) => ms?.map((m) => (typeof m.content === "string" ? m : { ...m, content: m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") }));
        mutateChat((c) => ({ ...c, messages: strip(c.messages)!, context: strip(c.context) }), sid);
        body.messages = sent();
        res = await api.claude(s.apiKey, body);
      } else throw e;
    }
    const first = !chatById(sid)?.ctxTokens;
    setCtx(sid, usageTokens(res.usage), s.model);
    if (first && turn === 0) noteBase("api", usageTokens(res.usage), JSON.stringify(sent()));
    const content: ChatBlock[] = res.content ?? [];
    pushMsg(sid, { role: "assistant", content });
    if (res.stop_reason === "refusal") { pushMsg(sid, { role: "user", content: [{ type: "text", text: "(요청이 거절되었습니다)" }] }); break; }
    const uses = content.filter((b) => b.type === "tool_use") as any[];
    if (!uses.length) break;
    const results: ChatBlock[] = [];
    for (const u of uses) {
      if (stopFlag || res.stop_reason === "max_tokens") {
        results.push({ type: "tool_result", tool_use_id: u.id, content: stopFlag ? "사용자가 멈췄습니다." : "응답이 잘려 도구 입력이 완전하지 않습니다. 더 짧게 나눠서 다시 하세요.", is_error: true });
        continue;
      }
      set({ agentStatus: TOOL_LABEL[u.name] ?? u.name });
      try {
        const out = await run(u.name, u.input ?? {});
        results.push({ type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : out });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: u.id, content: String((e as Error)?.message ?? e), is_error: true });
      }
    }
    pushMsg(sid, { role: "user", content: results });
    set({ agentStatus: "생각하는 중…" });
  }
}

// ---------------------------------------------------------------- automatic compaction

/**
 * When a session has reached the compaction point (90% of its model's limit by default), asks
 * the model for a faithful summary and continues in a fresh context made of that summary and
 * the latest turns, sized to the target (50%). The panel keeps showing the whole history.
 */
export async function compactIfNeeded(sid: string, mode: "account" | "api", force = false) {
  const c = chatById(sid);
  if (!c) return;
  const s = st.settings;
  const limit = ctxLimit(c.model ?? s.model, s);
  if (!force && !needsCompaction(c.ctxTokens && c.ctxTokens + pendingSkillTokens(c), limit, s)) return;
  const since = c.marks?.length ? c.marks[c.marks.length - 1].at : 0;
  if (c.messages.length - since < 2) return;
  set({ agentStatus: "대화가 길어 요약하는 중…" });
  let summary = "";
  try {
    summary = mode === "account" ? await summariseAccount(c) : await summariseApi(c);
  } catch (e) {
    toast(`대화 요약에 실패해서 그대로 이어 갑니다: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return;
  }
  if (!summary.trim()) return;
  const base = baseTokens(mode);
  const budget = Math.max(2000, compactBudget(limit, s) - base);
  const seed = seedText(summary, c.messages.slice(since), budget);
  const to = base + estTokens(seed);
  const mark = { at: c.messages.length, from: c.ctxTokens ?? 0, to, time: Date.now() };
  if (mode === "api") {
    mutateChat((x) => ({
      ...x, ctxTokens: to, marks: [...(x.marks ?? []), mark],
      context: [{ role: "user", content: [{ type: "text", text: seed }] }, { role: "assistant", content: [{ type: "text", text: "요약과 최근 대화를 이어받았습니다. 계속하겠습니다." }] }],
    }), sid);
  } else {
    mutateChat((x) => ({ ...x, ctxTokens: to, marks: [...(x.marks ?? []), mark], ccSession: undefined, seed, skillsSent: [] }), sid);
  }
  set({ agentStatus: "생각하는 중…" });
}

async function summariseApi(c: ChatSession): Promise<string> {
  const s = st.settings;
  const msgs = (c.context ?? c.messages).slice();
  // Messages must alternate and end with the assistant before our request.
  while (msgs.length && msgs[msgs.length - 1].role === "user") msgs.pop();
  const body: any = {
    model: s.model, max_tokens: 8000, system: sys(), tools: TOOLS, tool_choice: { type: "none" },
    messages: [...msgs, { role: "user", content: [{ type: "text", text: SUMMARY_REQUEST }] }],
  };
  const res = await api.claude(s.apiKey, body);
  return (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

/** One Claude Code turn whose reply is collected (not shown): the summary request. */
async function summariseAccount(c: ChatSession): Promise<string> {
  const s = st.settings;
  const offs: (() => void)[] = [];
  let text = "";
  let resolve!: (v: { ok: boolean; err: string }) => void;
  const done = new Promise<{ ok: boolean; err: string }>((r) => { resolve = r; });
  ccRunning = true;
  try {
    offs.push(await onEvent("cc", (e) => {
      if (e.kind === "exit") { resolve({ ok: e.ok, err: e.err }); return; }
      const v = e.data ?? {};
      if (v.parent_tool_use_id) return;
      if (v.type === "assistant") text += (v.message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    }));
    offs.push(await onEvent("cc-tool", async (e) => { await api.ccAnswer(e.id, { content: [{ type: "text", text: "요약 중에는 도구를 쓸 수 없습니다. 요약만 답하세요." }], isError: true }); }));
    // Without a Claude Code conversation to resume (e.g. right after another compaction), summarise the visible history.
    const prompt = c.ccSession ? SUMMARY_REQUEST : `${SUMMARY_REQUEST}\n\n<conversation>\n${(c.seed ? c.seed + "\n\n" : "") + recentWithin(c.messages, 60_000)}\n</conversation>`;
    await api.ccRun({ model: c.model ?? s.model, effort: "low", system: sysCc(), prompt, session: c.ccSession ?? null, tools: TOOLS });
    const end = await done;
    if (!text.trim() && !end.ok) throw new Error(end.err.slice(-200) || "요약을 받지 못했습니다");
    return text;
  } finally {
    ccRunning = false;
    offs.forEach((f) => f());
  }
}

export const TOOL_LABEL: Record<string, string> = {
  get_project_overview: "프로젝트 살펴보는 중", get_transcript: "대본 읽는 중", search_transcript: "대본 찾는 중", view_frames: "장면 보는 중",
  contact_sheet: "영상 훑어보는 중", create_draft: "편집본 만드는 중", get_draft: "편집본 확인 중", edit_draft: "편집하는 중",
  remove_silences: "무음 정리 중", remove_fillers: "군더더기 말 정리 중", add_markers: "마커 다는 중", set_captions: "자막 설정 중",
  run_script: "스크립트 실행 중", get_sdk_types: "스크립트 API 읽는 중", measure_loudness: "소리 크기 재는 중", find_beats: "박자 찾는 중", find_scene_cuts: "장면 바뀌는 곳 찾는 중", find_audio_events: "소리 구간 찾는 중", scan_gaze: "카메라 보는 구간 찾는 중", organize_media: "미디어 정리하는 중", trim_to_subjects: "사람이 없는 부분 빼는 중", merge_skills: "스킬 합치는 중", run_merged_skill: "병합 스킬 준비 중", finish_step: "단계 마치는 중", get_captions: "자막 읽는 중", edit_captions: "자막 고치는 중", fix_words: "받아쓰기 고치는 중", set_translation: "번역 넣는 중", paste_attributes: "속성 붙여넣는 중", sync_media: "소리로 시간 맞추는 중", multicam_draft: "멀티캠 편집본 만드는 중", auto_color: "색 맞추는 중", set_look: "색 입히는 중", save_skill: "스킬 저장 중", delete_skill: "스킬 지우는 중", ask_options: "선택지 보여 주는 중", run_steps: "여러 작업 실행 중", set_motion: "움직임 넣는 중", set_volume_keys: "음량 조절 중", fit_music: "음악 길이 맞추는 중", add_text: "글자 올리는 중", remove_text: "글자 지우는 중", save_scene_notes: "장면 설명 저장 중", search_scenes: "장면 찾는 중", scan_bad_shots: "흔들림·흐림 찾는 중", find_faces: "얼굴 찾는 중", track_people: "사람 추적하는 중", get_playbook: "작업 순서 읽는 중", equirect_sheet: "파노라마 보는 중", frame_subject: "사람 따라가기 만드는 중", get_view_keys: "시점 키 확인 중", check_framing: "화면 구도 확인 중", snap_cuts: "컷을 말 틈으로 옮기는 중", delete_draft: "편집본 지우는 중",
  transcribe: "받아쓰는 중", export_draft: "내보내는 중",
};

// ---------------------------------------------------------------- "Claude 계정" mode (Claude Code)

const PREFIX = "mcp__reelcut__";
/** The system prompt with what the user asked the AI always to keep in mind (설정 > AI 편집). */
const sys = () => {
  const notes = (st.settings.aiNotes ?? "").trim();
  const base = `${SYSTEM}\n\n${skillCatalog(st.skills)}`;
  return notes ? `${base}\n\n## 사용자가 늘 지켜 달라고 한 것 (설정에 적어 둔 내용)\n${notes}` : base;
};
const sysCc = () => sys() + `\n\n도구 이름에는 ${PREFIX} 접두어가 붙어 있습니다 (예: ${PREFIX}get_project_overview). 이 앱의 도구 말고 다른 도구는 없습니다.`;

/** A tool's output in MCP content shape. */
function mcpContent(out: Out): any[] {
  if (typeof out === "string") return [{ type: "text", text: out }];
  return out.map((b: any) => (b.type === "image" ? { type: "image", data: b.source.data, mimeType: b.source.media_type } : { type: "text", text: String(b.text ?? "") }));
}

/** Keeps what the chat shows (text, tool calls, tool errors); drops thinking and images. */
function shown(blocks: any[]): ChatBlock[] {
  const r: ChatBlock[] = [];
  for (const b of blocks ?? []) {
    if (b.type === "text" && String(b.text).trim()) r.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") r.push({ type: "tool_use", id: b.id, name: String(b.name).replace(PREFIX, ""), input: {} });
    else if (b.type === "tool_result" && b.is_error) {
      const t = typeof b.content === "string" ? b.content : (b.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
      r.push({ type: "tool_result", tool_use_id: b.tool_use_id, content: t.slice(0, 500), is_error: true });
    }
  }
  return r;
}

let ccRunning = false;

function loginHint(msg: string) {
  return /not logged in|log ?in|logged out|authenticat|credential|\b401\b|oauth/i.test(msg)
    ? "Claude 계정에 로그인되어 있지 않습니다. 설정 > AI 편집에서 'Claude 계정 연결'을 눌러 주세요."
    : "";
}

async function askAccount(sid: string, text: string) {
  const s = st.settings;
  const cc = st.cc ?? (await api.ccStatus().catch(() => null));
  if (cc && (!cc.found || !cc.logged_in)) throw new Error("Claude 계정에 로그인되어 있지 않습니다. 설정 > AI 편집에서 'Claude 계정 연결'을 눌러 주세요.");
  stopFlag = false;
  ccRunning = true;
  pushMsg(sid, { role: "user", content: [{ type: "text", text: stateNote() }, { type: "text", text }] });
  const c0 = chatById(sid)!;
  // A fresh Claude Code conversation after a compaction starts from the summary and the latest turns.
  const fresh = !c0.ccSession;
  const prompt = `${fresh && c0.seed ? c0.seed + "\n\n" : ""}${stateNote()}\n\n${text}`;
  const offs: (() => void)[] = [];
  let resultErr = "";
  let gotResult = false;
  let lastCtx = 0;
  try {
    let resolve!: (v: { ok: boolean; err: string }) => void;
    const done = new Promise<{ ok: boolean; err: string }>((r) => { resolve = r; });
    offs.push(await onEvent("cc", (e) => {
        if (e.kind === "exit") { resolve({ ok: e.ok, err: e.err }); return; }
        const v = e.data ?? {};
        if (v.session_id && chatById(sid)?.ccSession !== v.session_id) mutateChat((x) => ({ ...x, ccSession: v.session_id, seed: undefined }), sid);
        if (v.parent_tool_use_id) return;
        if (v.type === "assistant") {
          const n = usageTokens(v.message?.usage);
          if (n) { lastCtx = n; setCtx(sid, n, s.model); }
          const c = shown(v.message?.content);
          if (c.length) pushMsg(sid, { role: "assistant", content: c });
          if (c.some((b) => b.type === "text")) set({ agentStatus: "생각하는 중…" });
        } else if (v.type === "user") {
          const c = shown(Array.isArray(v.message?.content) ? v.message.content : []);
          if (c.length) pushMsg(sid, { role: "user", content: c });
        } else if (v.type === "system" && v.subtype === "compact_boundary") {
          // Claude Code compacted on its own: the next usage shows the new size.
          set({ agentStatus: "Claude Code가 대화를 줄이는 중…" });
        } else if (v.type === "result") {
          gotResult = true;
          if (v.is_error || (v.subtype && v.subtype !== "success")) resultErr = String(v.result || (v.errors ?? []).join(" ") || v.subtype || "실패");
        }
    }));
    offs.push(await onEvent("cc-tool", async (e) => {
        const name = String(e.name).replace(PREFIX, "");
        set({ agentStatus: TOOL_LABEL[name] ?? name });
        let result: any;
        if (stopFlag) result = { content: [{ type: "text", text: "사용자가 멈췄습니다." }], isError: true };
        else {
          try { result = { content: mcpContent(await run(name, e.input ?? {})), isError: false }; }
          catch (err) { result = { content: [{ type: "text", text: String((err as Error)?.message ?? err) }], isError: true }; }
        }
        await api.ccAnswer(e.id, result);
        if (ccRunning) set({ agentStatus: "생각하는 중…" });
    }));
    await api.ccRun({ model: s.model, effort: s.effort, system: sysCc(), prompt, session: c0.ccSession ?? null, tools: TOOLS });
    const end = await done;
    if (fresh && !c0.seed && lastCtx) noteBase("account", lastCtx, prompt);
    if (stopFlag) return;
    if (resultErr) throw new Error(loginHint(resultErr) || `Claude 오류: ${resultErr.slice(0, 300)}`);
    if (!end.ok && !gotResult) {
      // A conversation that can no longer be resumed: start fresh next time.
      if (/No conversation found|session/i.test(end.err)) mutateChat((x) => ({ ...x, ccSession: undefined }), sid);
      throw new Error(loginHint(end.err) || `Claude Code가 멈췄습니다: ${end.err.slice(-300) || "알 수 없는 오류"}`);
    }
  } finally {
    ccRunning = false;
    offs.forEach((f) => f());
  }
}
