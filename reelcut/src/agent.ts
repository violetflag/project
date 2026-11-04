// The editing agent: a tool-use loop against the Claude Messages API (called from Rust).
// The transcript is append-only (preserved thinking): `system` and `tools` never change, the
// project state goes into each user turn, and every response's content is kept as returned.
import { api, onEvent } from "./api";
import {
  clipDur, cutSource, DEFAULT_COLOR, DEFAULT_TRANSFORM, deleteClip, detachAudio, draftDuration, draftWords, fmtTC, insertClips, is360, isDefaultColor, isDefaultTransform, isFiller, isGap, moveClip,
  newClip, newDraft, newGap, newOverlay, r3, removeFillers, removeItem, removeRange, removeSilences, setTransition, splitAt, speechFromWave, speechFromWords, starts, transcriptText, uid, updateClip, updateOverlay, viewAt,
  type Pacing,
} from "./edit";
import { exportAndWait } from "./exporter";
import { cleanKeys, frameGroup, frameSubject, normView, sampleKeys, snapRanges, type Mark, type Subject } from "./framing";
import { PLAYBOOK_360 } from "./playbook";
import { compactBudget, ctxLimit, estTokens, needsCompaction, newSession, recentWithin, seedText, SUMMARY_REQUEST, titleFrom } from "./chats";
import { activeChat, asset, assetMap, editDraft, loadWave, mutate, mutateChat, saveNow, set, setDrafts, startTranscribe, st, toast, waitJob, waves } from "./store";
import type { Asset, ChatBlock, ChatMsg, ChatSession, Draft, View, ViewKey } from "./types";

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
        name: str, aspect: { type: "string", enum: ["16:9", "9:16", "1:1", "4:5"] },
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
- {op:"transition", clip_id, seconds}: 이 클립과 앞 클립 사이 디졸브 (0이면 컷)
- {op:"gap", index, seconds}: 빈칸(검은 화면·무음) 넣기
- {op:"detach_audio", clip_id}: 클립 소리를 A1으로 분리
- {op:"rename", name} / {op:"aspect", aspect}
- {op:"add_music", asset_id, start?, end?, at?, volume?, track?}: 소리 넣기. track 2=배경음악(기본, volume 기본 0.25), 3=효과음, 1=대사
- {op:"clear_music"}
- {op:"add_overlay", asset_id, at, start?, end?, track?(2|3), transform?, volume?}: 본편 위에 겹치기 (기본: 오른쪽 위 40% 크기)
- {op:"set_overlay", overlay_id, at?, start?, end?, transform?, volume?}
- {op:"remove_item", id}: V2/V3 또는 소리 클립 지우기`,
    input_schema: { type: "object", properties: { draft_id: draftId, ops: { type: "array", items: { type: "object" } } }, required: ["ops"] },
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
    name: "set_captions", description: "받아쓰기로 만든 자막을 켜고 끄거나 모양을 바꿉니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, enabled: { type: "boolean" }, size: { ...num, description: "화면 높이 대비 % (기본 6)" }, position: { type: "string", enum: ["bottom", "middle", "top"] }, max_chars: num }, required: ["enabled"] },
  },
  { name: "transcribe", description: "미디어를 받아쓰기합니다 (끝날 때까지 기다림).", input_schema: { type: "object", properties: { asset_ids: { type: "array", items: str } }, required: ["asset_ids"] } },
  {
    name: "get_playbook", description: "작업별 단계별 지침을 읽습니다. name=360_auto_edit: 360 영상을 사람 따라가며 자동 편집하는 순서.",
    input_schema: { type: "object", properties: { name: { type: "string", enum: ["360_auto_edit"] } }, required: ["name"] },
  },
  {
    name: "equirect_sheet", description: "360 영상의 특정 원본 시간을 '수평으로 펴 놓은 파노라마'(가로 0~960 = 방위 -180~180°, 480 = 정면, 세로 240 = 수평선)로 봅니다. 좌표 격자가 그려져 있어 사람 머리의 [x,y]를 읽을 때 씁니다 (최대 6장).",
    input_schema: { type: "object", properties: { asset_id: str, times: { type: "array", items: num }, width: { ...num, description: "그림 가로 픽셀(기본 960)" } }, required: ["asset_id", "times"] },
  },
  {
    name: "frame_subject", description: "사람(머리) 위치 표시를 따라가는 시점 키프레임을 만듭니다. 한 사람이면 marks에 equirect_sheet에서 읽은 [원본 초, x, y] 목록(빠르면 1초, 보통 2.5초 간격). 여러 사람을 함께 화면에 담으려면(쌍둥이 등) subjects에 사람마다 이름과 marks를 넣으세요. 화면이 모두의 가운데를 보고, 모두 들어오도록 화각을 넓힙니다(90~130°). 0.1초 간격 키프레임으로 부드럽게 이어서 클립에 넣고, 가장 높은 머리가 화면 위에서 1/3 지점에 오게 합니다. 결과에 사람마다 화면 안에 있었던 비율과, 너무 멀리 떨어져 한 화면에 못 담은 구간을 알려 줍니다.",
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
        hfov: { ...num, description: "화각(기본 90)" }, headroom: { ...num, description: "머리 위 여백 비율(기본 0.33)" },
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
    name: "check_framing", description: "클립의 시점 키프레임으로 실제 잡히는 화면을 원본 시간 times에서 확인합니다(없으면 클립 안 고르게 6곳). 머리가 위 1/3 선 근처인지, 잘리지 않았는지 보세요. 여러 사람(쌍둥이 등)을 담는 클립이면 모든 머리가 화면 안에 함께 있어야 합니다. 얼굴이 화면 가장자리에 걸린 곳은 자동으로 찾아 알려 줍니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, clip_id: str, times: { type: "array", items: num } }, required: ["clip_id"] },
  },
  {
    name: "snap_cuts", description: "편집본 클립의 시작·끝을 가까운 말 없는 틈(±1.5초 안)으로 옮겨 말 중간에서 끊기지 않게 합니다. 받아쓰기가 있으면 단어 사이, 없으면 소리 크기 기준입니다.",
    input_schema: { type: "object", properties: { draft_id: draftId, clip_ids: { type: "array", items: str }, reach: { ...num, description: "옮길 수 있는 최대 거리 초(기본 1.5)" } } },
  },
  { name: "delete_draft", description: "편집본을 지웁니다 (마지막 하나는 지울 수 없고, Ctrl+Z로 되돌릴 수 있습니다).", input_schema: { type: "object", properties: { draft_id: str }, required: ["draft_id"] } },
  {
    name: "export_draft", description: "편집본을 파일로 내보냅니다 (끝날 때까지 기다림). preset: fhd/4k/hd/sd는 일반 H.264 MP4, shrink_balanced/shrink_small/shrink_archive/shrink_lecture는 크기를 많이 줄이는 고압축(AV1/HEVC), audio는 WAV 소리만.",
    input_schema: { type: "object", properties: { draft_id: draftId, preset: { type: "string", enum: ["4k", "fhd", "hd", "sd", "shrink_archive", "shrink_balanced", "shrink_small", "shrink_lecture", "audio"] }, file_name: str }, required: ["preset"] },
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

function draftInfo(d: Draft): string {
  const am = assetMap();
  const stt = starts(d);
  const lines = [`편집본 ${d.id} "${d.name}" | 비율 ${d.aspect} | 길이 ${r3(draftDuration(d))}초 | 자막 ${d.captions ? "켬" : "끔"}`, "클립 (순서 | id | 미디어 | 원본 구간 | 타임라인 구간 | 속도 | 음량 | 시점):"];
  d.clips.forEach((c, i) => {
    if (isGap(c)) { lines.push(`${i} | ${c.id} | (빈칸) | - | ${r3(stt[i])}–${r3(stt[i] + clipDur(c))} | - | - | -`); return; }
    const a = am.get(c.asset);
    const extra = [c.xin ? `디졸브 ${c.xin}초` : "", c.transform && !isDefaultTransform(c.transform) ? `변형 ${JSON.stringify(c.transform)}` : "", c.color && !isDefaultColor(c.color) ? `색 ${JSON.stringify(c.color)}` : "", c.detached ? "소리 분리됨" : "", c.viewKeys?.length ? `시점 키프레임 ${c.viewKeys.length}개(원본 ${c.viewKeys[0].t}–${c.viewKeys[c.viewKeys.length - 1].t}초)` : ""].filter(Boolean).join(", ");
    lines.push(`${i} | ${c.id} | ${a?.info.name ?? "?"}(${c.asset}) | ${r3(c.start)}–${r3(c.end)} | ${r3(stt[i])}–${r3(stt[i] + clipDur(c))} | ${c.speed}x | ${c.volume} | ${c.view ? `yaw ${c.view.yaw} pitch ${c.view.pitch} hfov ${c.view.hfov}` : "-"}${extra ? ` | ${extra}` : ""}`);
  });
  const ov = d.overlays ?? [];
  if (ov.length) lines.push("V2/V3:", ...ov.map((o) => `- ${o.id} | V${o.track} | ${am.get(o.asset)?.info.name} | 원본 ${o.start}–${o.end} | 타임라인 ${o.at}부터 | 변형 ${JSON.stringify(o.transform ?? {})}`));
  if (d.music.length) lines.push("소리 (A1 대사 / A2 음악 / A3 효과음):", ...d.music.map((m) => `- ${m.id} | A${m.track ?? 2} | ${am.get(m.asset)?.info.name} | 원본 ${m.start}–${m.end} | 타임라인 ${m.at}부터 | 음량 ${m.volume}`));
  if (d.markers.length) lines.push("마커:", ...d.markers.map((m) => `- ${r3(m.t)}초 ${m.label}`));
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
      case "transition": d = setTransition(d, o.clip_id, Number(o.seconds ?? 0.5)); break;
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
      return shots.flatMap((b, i) => [{ type: "text", text: `${a.info.name} ${r3(times[i])}초` }, img(b)]);
    }
    case "contact_sheet": {
      const a = getAsset(inp.asset_id);
      const cols = Math.min(6, inp.cols ?? 5), rows = Math.min(6, inp.rows ?? 4);
      const start = inp.start ?? 0;
      const every = inp.every ?? Math.max(1, (a.info.duration - start) / (cols * rows));
      // An .osv's .lrf (both lenses side by side) reads quicker than the full-size original.
      const path = a.info.layout360 === "dual" && a.info.lrf ? a.info.lrf : a.info.path;
      const b = await api.contactSheet(path, start, every, cols, rows, 240);
      return [{ type: "text", text: `${a.info.name}: ${r3(start)}초부터 ${r3(every)}초 간격, ${cols}×${rows}칸 (왼쪽 위부터 오른쪽으로)${is360(a) ? " — 360 원본의 어안 렌즈 그림이라 둥글게 휘어 보입니다. 특정 방향은 view_frames로 보세요" : ""}` }, img(b)];
    }
    case "create_draft": {
      let d = newDraft(String(inp.name || "새 편집본"), inp.aspect || "16:9");
      d = applyOps(d, (inp.clips ?? []).map((c: any) => ({ op: "insert", ...c })));
      setDrafts(`AI: 편집본 만들기 "${d.name}"`, [...p.drafts, d], d.id);
      set({ playhead: 0, sourceId: null });
      return `만들었습니다.\n` + draftInfo(d);
    }
    case "get_draft": return draftInfo(getDraft(inp.draft_id));
    case "edit_draft": {
      const d0 = getDraft(inp.draft_id);
      const d = applyOps(d0, inp.ops ?? []);
      editDraft(`AI: 편집본 수정`, () => d, d0.id);
      return `적용했습니다. 길이 ${r3(draftDuration(d0))}초 → ${r3(draftDuration(d))}초\n` + draftInfo(d);
    }
    case "get_playbook": return PLAYBOOK_360;
    case "equirect_sheet": {
      const a = getAsset(inp.asset_id);
      if (!is360(a)) throw new Error("360 영상이 아닙니다");
      const times = (inp.times as number[]).slice(0, 6);
      const lens = { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 };
      const shots = await api.eqSheet(a.info.path, lens, times, Math.min(1920, Math.max(480, inp.width ?? 960)));
      return [{ type: "text", text: "가로 0~960 = 방위 -180~180°(480 = 정면), 세로 240 = 수평선(위가 위쪽). 격자 눈금으로 [x,y]를 읽으세요." }, ...shots.flatMap((b, i) => [{ type: "text", text: `${a.info.name} ${r3(times[i])}초` } as ChatBlock, img(b)])];
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
      const opts = { aspect: aw / ah || 16 / 9, hfov: inp.hfov, headroom: inp.headroom, step: inp.step, sigma: inp.smooth };
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
      if (people.length > 1 || inp.track !== false) {
        const g = frameGroup(people, from, to, opts);
        keys = g.keys;
        note += `\n화면 안 비율: ${g.report.subjects.map((s) => `${s.name} ${s.inFrame}%`).join(", ")}`
          + (g.report.tooFar.length ? `\n너무 멀리 떨어져 한 화면에 다 못 담은 구간(원본 초): ${g.report.tooFar.map(([a, b]) => `${r3(a)}–${r3(b)}`).join(", ")}. 이 구간은 클립을 나눠 한 사람씩 번갈아 따라가고, 두 사람의 화면 시간이 비슷하게 맞추세요.` : "");
      } else {
        keys = frameSubject(marks, from, to, opts);
      }
      if (!keys.length) throw new Error("키프레임을 만들 수 없습니다 (marks나 구간 확인)");
      const d = updateClip(d0, c.id, { viewKeys: keys });
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
      const c = getDraft(inp.draft_id).clips.find((x) => x.id === inp.clip_id);
      if (!c) throw new Error(`클립 없음: ${inp.clip_id}`);
      const a = getAsset(c.asset);
      if (!is360(a)) throw new Error("360 영상 클립이 아닙니다");
      const times: number[] = (inp.times?.length ? inp.times : Array.from({ length: 6 }, (_, i) => c.start + ((i + 0.5) * (c.end - c.start)) / 6)).slice(0, 8);
      const lens = { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 };
      const out: ChatBlock[] = [{ type: "text", text: "머리가 화면 위에서 약 1/3 선에 있고 위·아래가 잘리지 않아야 합니다. 어긋나면 marks를 고쳐 frame_subject를 다시 하세요." }];
      const seen = await api.faceCheck(a.info.path, lens, times.map((t) => [t, viewAt(c.view, c.viewKeys, t)] as [number, View])).catch(() => []);
      times.forEach((t, i) => void (seen[i] && (seen[i].t = t)));
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        const v = viewAt(c.view, c.viewKeys, t);
        const [b] = await api.frames(a.info.path, [t], 640, v, lens);
        const f = seen[i];
        const faces = f ? ` | 얼굴 ${f.faces}개${f.edges.length ? ` · 가장자리에 걸림: ${f.edges.join(", ")}` : ""}` : "";
        out.push({ type: "text", text: `${r3(t)}초 | yaw ${v.yaw} pitch ${v.pitch} hfov ${v.hfov}${faces}` }, img(b));
      }
      return out;
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
    case "set_captions": {
      const d0 = getDraft(inp.draft_id);
      editDraft("AI: 자막", (d) => ({
        ...d, captions: !!inp.enabled,
        captionStyle: { ...d.captionStyle, ...(inp.size ? { size: Number(inp.size) } : {}), ...(inp.position ? { position: inp.position } : {}), ...(inp.max_chars ? { maxChars: Number(inp.max_chars) } : {}) },
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
      set({ agentStatus: "내보내는 중…" });
      const e = await exportAndWait(d, {
        mode: pr === "audio" ? "audio" : shrink ? "shrink" : "standard", quality: shrink ? "fhd" : pr, preset: shrink ? pr.slice(7) : "balanced",
        codec: "auto", container: "mkv", dir: "", name: inp.file_name ?? "",
      });
      if (e.state !== "done") return `내보내기 실패: ${e.message}`;
      return `내보냈습니다: ${e.result.path} (${(e.result.size / 1048576).toFixed(1)}MB, ${r3(e.result.duration)}초)${e.message ? " 경고: " + e.message : ""}`;
    }
  }
  throw new Error(`알 수 없는 도구: ${name}`);
}

// ---------------------------------------------------------------- loop

let stopFlag = false;
export const stopAgent = () => {
  stopFlag = true;
  if (ccRunning) api.ccStop().catch(() => {});
};

function stateNote(): string {
  const d = st.project?.drafts.find((x) => x.id === st.draftId);
  return `<project-state>열린 편집본: ${d ? `${d.id} "${d.name}" (클립 ${d.clips.length}개, ${r3(draftDuration(d))}초)` : "없음"} | 미디어 ${st.project?.assets.length ?? 0}개 | 재생 위치 ${r3(st.playhead)}초${st.selClip ? ` | 선택한 클립 ${st.selClip}` : ""}</project-state>`;
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
    if (mode === "account") await askAccount(sid, text);
    else await askApi(sid, text);
  } finally {
    set({ agentBusy: false, agentStatus: "", aiRuns: st.aiRuns.map((r) => (r.id === run.id ? { ...r, done: true, after: st.project?.drafts } : r)) });
    await saveNow();
  }
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
  if (!force && !needsCompaction(c.ctxTokens, limit, s)) return;
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
    mutateChat((x) => ({ ...x, ctxTokens: to, marks: [...(x.marks ?? []), mark], ccSession: undefined, seed }), sid);
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
  find_faces: "얼굴 찾는 중", track_people: "사람 추적하는 중", get_playbook: "작업 순서 읽는 중", equirect_sheet: "파노라마 보는 중", frame_subject: "사람 따라가기 만드는 중", get_view_keys: "시점 키 확인 중", check_framing: "화면 구도 확인 중", snap_cuts: "컷을 말 틈으로 옮기는 중", delete_draft: "편집본 지우는 중",
  transcribe: "받아쓰는 중", export_draft: "내보내는 중",
};

// ---------------------------------------------------------------- "Claude 계정" mode (Claude Code)

const PREFIX = "mcp__reelcut__";
/** The system prompt with what the user asked the AI always to keep in mind (설정 > AI 편집). */
const sys = () => {
  const notes = (st.settings.aiNotes ?? "").trim();
  return notes ? `${SYSTEM}\n\n## 사용자가 늘 지켜 달라고 한 것 (설정에 적어 둔 내용)\n${notes}` : SYSTEM;
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
