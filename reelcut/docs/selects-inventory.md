# Selects 기능 목록과 Reelcut 비교

조사 대상: Selects(Cutback) 2.0.967. 대상 자료는 아래와 같습니다.
- 설치 폴더
- 설치 파일 안의 압축(7z, 설치 폴더와 같은 내용이며 렌더러는 원격)
- 앱 번들과 캐시된 렌더러
- `~/.selects`의 SDK 문서(`*.d.ts`)와 내장 스킬 33개
- John의 사용자 스킬 `auto-360-edit`

동작만 정리했고, Selects의 코드·문구·이름·로고는 Reelcut에 가져오지 않습니다. 비교 기준은 Reelcut 2.6.1입니다.

표시: ✅ 있음 · 🟡 일부 · ❌ 없음

## 한눈에 보기

아래 표는 Reelcut 2.12.0 기준입니다. 뒤쪽 부록(A·B·C)의 Reelcut 칸은 조사 당시(2.6.0)의 값이라, 그 뒤에 넣은 기능은 이 표가 맞습니다.

| 영역 | Selects | Reelcut 2.12.0 | 메모 |
|---|---|---|---|
| 360 영상 | ❌ 360 지원 없음(.osv 불가) | ✅ .osv 바로 열기, 스티칭, 흔들림 보정, 시점 키프레임, 사람·쌍둥이 따라가기, 수평 파노라마, 미리보기 수평 맞춤 | Reelcut이 앞섬 |
| AI 에이전트 도구 | ✅ 스크립트 실행(run_script, TypeScript SDK) + 분석 도구 | 🟡 도구 30여 개 + 한 번에 여러 도구 실행(run_steps) | 코드 스크립트와 저장 전 검사(stage/validate)는 없음 |
| AI 스킬 | ✅ 내장 33개 + 사용자 스킬 + 스킬 만들기 | 🟡 내장 5개 + 사용자 스킬 + 대화로 저장 + 설정에서 편집 | 플러그인·공유 없음 |
| 선택 카드 | ✅ ask_options | ✅ show_options | |
| 장면 찾기 | ✅ 장면 설명·의미 검색 | 🟡 AI가 적은 장면 설명을 낱말로 검색 | 의미 검색(임베딩)은 없음 |
| 얼굴·사람 자동 찾기 | ✅ faces.detect, person.matte, 시선 검사 | 🟡 얼굴 찾기, 머리 추적, 가장자리 검사 | 인물 구분·배경 분리·시선 검사 없음 |
| 흔들림·흐림 장면 찾기 | ✅ scan_bad_shots | ✅ scan_bad_shots | |
| 자막 | ✅ 스타일 15종, 단어 강조, 애니메이션, 줄 나누기, 맞춤법, 번역 | 🟡 모양 6종, 단어 강조, SRT 저장 | 줄 고치기·맞춤법·번역 없음 |
| 제목·스티커 | ✅ 제목 6종, 스티커 9종(장소·날짜 핀) | ✅ 제목 류 3종, 장소·날짜 핀, 스티커 6종 | 템플릿 수는 적음 |
| 변형·불투명도·음량 키프레임 | ✅ | ✅ | |
| 사진 줌·이동 | ✅ | ✅ 프리셋 4종 | |
| 전환 효과 | ✅ 28종 | 🟡 14종 | 미리보기는 컷으로 보임 |
| 색 보정 | ✅ 자동 보정, HSL, 커브, 룩 | 🟡 자동 보정, 색조·밝은/어두운 부분·생기·가장자리, 룩 5종, LUT | HSL·커브 없음 |
| 음악 | ✅ 음악 라이브러리, 길이 맞추기, 박자 분석 | 🟡 길이 맞추기, 자동 덕킹 | 라이브러리·박자 분석 없음 |
| 음성 정리 | ✅ 학습형 잡음 제거, 음성 향상 | 🟡 잡음 제거 필터, 라우드니스 | |
| 여러 카메라 맞추기 | ✅ 파형·타임코드 동기화, 멀티캠 | 🟡 소리로 맞추기, 카메라 전환 편집본 | 타임코드·자동 카메라 전환 없음 |
| 대본 편집 | ✅ 화자, 단어 고치기, 의미 검색, 주제 나누기 | 🟡 대본 보기·지우기·찾기 | |
| 하이라이트 만들기 | ✅ 하이라이트 제안, 쇼츠 템플릿 | 🟡 후보 제안 카드 → 9:16 편집본 | 템플릿 없음 |
| 내보내기 | ✅ 4K/FHD/HD, 플랫폼별, XML 넘기기, 바로 올리기 | 🟡 프리셋, 고압축(Shrink식), SRT | XML·바로 올리기·스틸 없음 |
| 생성(AI 이미지·음성·나레이션) | ✅ 유료 생성 | ❌ | 범위 밖으로 둠 |
| 편집 편의 | ✅ 단축키 바꾸기, 속성 붙여넣기, 클립 끄기 | 🟡 롤·슬립 도구, 별점 등은 Reelcut이 앞섬 | |

## 진행 상황

2.7.0(얼굴·추적, 미리보기 수평) · 2.8.0(장면 찾기, 흔들림·흐림) · 2.9.0(제목·스티커·자막 모양·SRT) · 2.10.0(키프레임, 사진 줌, 음악 길이, 전환) · 2.11.0(멀티캠, 자동 색, 색 패널) · 2.12.0(스킬, 브이로그 안내, 선택 카드, run_steps) 모두 넣었습니다.

**남은 큰 항목(쓸모 큰 순):** 대본 도구(화자, 단어 고치기, 번역, 맞춤법), 음악 박자 분석, 전환 미리보기, 인물 구분(쌍둥이 자동 구별), 의미 기반 장면 검색, 속성 붙여넣기·클립 끄기·단축키 바꾸기, XML 넘기기, HSL·커브.

---

아래는 자세한 목록입니다(영문).
- A: AI 스크립트·도구 API
- B: 내장 스킬
- C: 편집기 기능


# Appendix A. Agent tools and scripting API


Read-only analysis for Reelcut 2.6.0. Sources: `~/.selects/resources/sdk/*` (all .d.ts, README, recipe index), `resources/manifest.json`, `selects-analysis/app/dist/mcp/server-*.js` (tool registrations), `renderer-cache/f_00007c.js` (web-connector tool list). Everything below is behaviour described in our own words; identifiers are kept so the mapping is unambiguous.

---

## 1. Agent tool surface

### 1a. Desktop MCP server (`dist/mcp/server-*.js`, `registerTool`)

| Tool | Parameters | Behaviour |
|---|---|---|
| `run_script` | `script` (TS or JS; top-level await/return), `summary` (2-4 word English verb phrase shown in chat), `timeoutSeconds` (default 30, max 120), `maxResultBytes` (default 256 KB, max 1 MB), `allowCommit` (bool, default false), `resultHandles` (up to 16 `sa1_...` handles from `spawn_subagent`) | The main tool. Compiles TS with esbuild to ES2022, runs it in a Node `vm` context with string-eval and wasm disabled, a deadline and captured console. Exposes the `selects` SDK (section 2). Without `allowCommit`, edits are a simulation and every persistent write/export rejects. Oversized results are spilled to a per-session file the agent then reads with `run_shell`. Refuses if the session is not bound to a verified project. Logs script hash, duration, result size. |
| `run_shell` | `command` (max 16 KB), `cwd` (absolute, optional), `timeout_ms` (default 30 s, cap 5 min), `max_output_bytes` (default 16 KB), `summary` | Real shell with the user's permissions, network reachable, no confirmation. Fresh scratch dir per call. Env var `SELECTS_AGENT_RESOURCES_ROOT` points at the read-only SDK/skills tree; bundled `rg` on PATH. Also the loader for built-in Skills (read `skills/<name>/SKILL.md`). |
| `read_docs` | `path?`, `startLine?`, `maxLines?` (default 1000, max 2000) | Lists or pages through manifest-listed SDK/skill documents only (for clients without filesystem access). |
| `get_sdk_docs` | `section?` (ignored) | Legacy stub: always says docs moved to the filesystem. |
| `read_editor_state` | none | Live snapshot of what the UI shows: project, on-screen tab (draft/synced/none), playhead (resolved + base frame), view pointer, last viewed draft, all draft ids, `timelineTrackLabels` mapping V/A row labels to track/audio-source targets. Same as `selects.editor.state()`. |
| `create_draft` | `projectId`, `draftName`, `agents[]` (`shorts` / `trim` content agent, at most one; `broll` polish) each with verbatim `context`, `targetDurationSeconds`, `targetDraftId` (re-edit in place), `deferredIntent` (speech-flow wording to apply later) | Server-side "edit plan" draft generator. Long running, returns workflowId, app wakes the agent on completion. Pacing/silence work is explicitly excluded and deferred to a script pass afterwards. |
| `analyze_retakes` | `projectId`, `draftId` | Background job: groups repeated takes in a draft's sources, ranks best take, attaches result (read via `draft.takeGroups()`). Fails as stale if the draft changes meanwhile. |
| `scan_bad_shots` | `projectId`, `resources[]{resourceId, jobId?}` | Server scores every keyframe for blur/shake/focus problems and stores spans on the resource; returns only counts per camera. Synced timelines expand to member cameras. Resumable by `jobId` without rescanning. Read results via `draft.visualSpanRanges()`. |
| `scan_gaze` | same shape | Server face detection for frontal gaze (subject looking into lens) per camera; stores `frontalSpans` + a gaze table used by the "object-cam" multicam round. |
| `regenerate_topics` | `projectId`, `sequenceId`, `genre?`, `jobId?` | Re-segments a draft's own transcript into Chapter/SubChapter bands with an LLM pass per topic; replaces the draft's chapter tracks (undoable). Resumable. |
| `export_transcript` | `projectId`, `outPath`, `format` plain/srt/vtt | Writes the whole project transcript to a new file (never overwrites); returns path + metadata, not the body. |
| `export_draft_text` | `projectId`, `sequenceId`, `outPath`, `format` plain/srt/vtt/markdown, `includeStructure`, `includeSpeakers` | Same for one draft's kept dialogue; soft cuts excluded; optional chapter headers and speaker labels. |
| `scan_directory` | `path`, `extensions?`, `recursive?` | Lists media file paths/sizes; summarises per folder when too many. |
| `probe_media` | `filePaths?`, `directoryPath?`, `recursive?`, `extensions?` | Metadata for scene grouping: dates (recorded/encoded/creation/filename), timecode, camera model/id, encoder, duration, audio presence + measured RMS/peak/silent flag, BWF slate. Comes with a grouping heuristic (timecode overlap > same-date similar duration > folder siblings > filename patterns). |
| `compare_audio` | `files[]` (2+) | MFCC fingerprint cross-correlation on first 10 min of each file, all pairs; returns similarity (match at >= 0.4) and time offset. For grouping simultaneous recordings. |
| `preview_timeline_xml` | `projectId`, `xmlPath` (xmeml, fcpxml, fcpxmld bundle, prproj) | Dry-run parse: sequences with clip counts, missing media, selectable flag and reason (nested/multicam/still/retimed/missing media). |
| `import_timeline_xml` | `projectId`, `xmlPath`, `sequenceIndexes?` | Registers all referenced media (bins become folders) and creates one Synced Timeline per complete, unretimed, media-only sequence, trusting the XML alignment. All-or-nothing per sequence. |
| `browser_repl` | `title`, `code` | Playwright-style JS REPL against Selects' embedded browser (tabs, snapshots with refs, locators); realm persists 5 min idle, 120 s deadline. |
| `generate_media` | model filter input | Read-only: lists generation models and their input/output schemas. Actual generation goes through `selects.generation.submit` in `run_script`. |
| `apply_object_cam_overlay` | injected config | Multicam "object cam" overlay helper (schema supplied at runtime). |
| `start_analysis` | — | Deprecated stub; points to `project.estimateAnalysis` / `startAnalysis` in scripts. |

Deprecated "prep" tools still registered, each returning a migration hint to the SDK call: `list_prep_files`/`list_source_files` (sourceFiles), `create_synced_sequence`, `list_synced_sequences`, `open_synced_sequence`, `list_prep_timeline` (layout), `add_files_to_project` (importFiles), `delete_files_from_project`, `add_clips_to_timeline`, `remove_timeline_clips`, `remove_vacant_ranges`, `remove_empty_tracks`, `run_sequence_sync`, `move_timeline_clip`, `get_prep_workflows`/`get_project_workflows`, `read_app_log`.

### 1b. In-app agent tools referenced by docs/descriptions (implemented outside this MCP file)

| Tool | What it does (from references) |
|---|---|
| `ask_options` | Multiple-choice question card to the user (used when targets are ambiguous; chosen option's "Meaning" text is carried forward verbatim). |
| `spawn_subagent` | Sub-agent; with `resultMode:'handle'` returns a handle whose parsed result is injected into a later script as `agentResults[]` without entering the parent's context. |
| `app_repl` | Drives the Selects window / plugin panels (snapshots, clicks), used by the `app-agent` and `use-apps` skills. |
| `switch_full_draft_multicam` | Recomputes camera switching across a whole draft (only when exposed). |
| `generate_media` (in-app variant) | Shows a credit-approval card before paid generation. |
| `web_search`, `web_fetch`, `tool_search` | Provider-side tools rendered in the chat. |

### 1c. Web connector tool list (renderer bundle `f_00007c.js`)

`read_editor_state`, `run_script` (`script`, `summary`, `allowCommit`; paid ops ask approval; web SDK, native-only ops unavailable), `read_agent_resource` (list/read SDK and skill docs), `import_chat_attachment` + `read_attachment_import` (import a chat-attached file into browser storage, poll status, idempotent by file_id/executionId), `import_local_media` + `read_local_media_import` (stream originals from a loopback helper into the web project).

### 1d. Built-in Skills (playbooks loaded through `run_shell`/`read_docs`; manifest lists 32)

app-agent, author-video-effects (WGSL), beat-sync-analysis, break-caption-lines, browser-agent, camera-gaze, captcha-solver, check-caption-spelling, fix-blur, folder-organization, generate-media (incl. narration/music), google-search, image-search, install-plugin, multicam-cutting (11 reference docs: base, reactions, wides, facial inserts, object/screen rounds, solo regions, sweep, cleanup), panel-authoring (206 files: plugin/panel SDK), podcast-edit-defaults, prepare-editing, publish-plugin, skill-creator (user skills), speech-flow-editor, suggest-highlights (shorts), sync-project-sources, transcript-editor, transcript-guided-editing (storyline planning, script-driven edits, length compression, targeted edits, multicam/overlays), translate-plugin-captions, translate-transcript, use-apps, video-request-intake (ad/explainer/vlog/event-recap... category cards), visual-browse, visual-editing (montage by what is visible), **vlog-edit** (archive of clips + photos, clock disagreement, footage profiles, photo survey), youtube. SDK recipes (14): advanced-editing, analysis-estimates, camera-audio-routing, clip-adjustments, effect-presets, markers, retakes, revert, review-evidence, sequence-settings, speaker-profiles, transcription-editing, unanalyzed-resource-placement, visual-observation.

---

## 2. Scripting SDK (`selects` global), grouped by file

Notation: S = `Span` (live draft range), SS = `SourceSpan` (live source range), WC = change stays in the script's working copy until `commitAll`, IMM = persists immediately and needs `allowCommit:true`.

### core.d.ts / sandbox-globals.d.ts — root and shared values

| Item | Shape / behaviour |
|---|---|
| `selects` root | `files, narration, generation, stock, epidemic, artlist, apps, templates, export, editor, comfy, media, ai, speakerProfiling, diagnostics, pacingPresets, effectPresets` (optional capability), `createProject()` IMM (empty project, no draft), `listProjects()` (session-bound project only), `project(id)`, `draft(sequenceId)`, `sequence(sequenceId)` (translation-only handle), `workflow(id)` |
| `Span` | `startFrame, endFrame, seconds, text`; `expand({before,after} seconds | {padding:"natural"})` (natural = available adjacent source room at speech-aligned edges, non-accumulating); `expandTo("clip"|"semanticCutSegment"|"turn"|"chapter")` (throws `ambiguous_expansion`); `through(other)`, `intersect`, `contains`, `overlaps`, `toJSON()` |
| `SourceSpan` | same plus `projectId, resourceId, context{before,after}`; `expandTo("sentence"|...)`; `toRef()` -> `SourceSpanRef` (JSON identity with `sourceRevision`, base coordinate) |
| Targets / Position | one Span or row with `.span`, or non-empty array; `Position = {before:T} | {after:T}` |
| `selection(targets)` | set algebra: `union / intersect / subtract` -> `.spans` |
| `framesToSeconds`, `secondsToFrames` | helpers |
| `FrameRatePreset` | 13 exact ratios 23.976 ... 120; `SequenceSettings {frameRate, frameSize}`; change result reports `removedClipIds` (zero-frame clips dropped) |
| `console.*`, `agentResults` | log capture; sub-agent results |
| `display(artifact)` | opt a captured JPEG (frames, media frames, screenshot) into the tool result as an image; max 4 artifacts / ~8 MB base64 per run |

### draft.d.ts — `DraftHandle` (`selects.draft(id)`)

Reads

| Method | Returns / behaviour |
|---|---|
| `meta()` | name, legacy genre, fps, frameSize, durationFrames/Seconds, `videoAngles[]` (index + default speakers) |
| `settings()` | exact FPS ratio + canvas |
| `words({view})` | playback view: rows with `span`, source SS, speaker, utterance/word ids, `filler{type hesitation/hedging/repeat, groupId, removable}`, `semanticEnd`; transcript view: all words incl. soft-cut (`cut`), silence (`nonSpeech`), `unanalyzed` placeholders, point tokens |
| `turns({offset,limit})` | speaker turns, paged |
| `semanticCutSegments()` | natural edit-point units (throws if metadata missing) |
| `chapters()` | Chapter/SubChapter bands with spans |
| `viewerTranscript({startFrame,endFrame})` | readable text with speaker labels, removed parts as `[CUT]` |
| `pauses()` | playback pause rows; `mode:"stranded"` isolated silences with flags; `mode:"represented", output:"summary"` distribution (min/median/p95/max, visible vs cut seconds) |
| `seams()` | every visible join: before/after spans, removed text, sourceJump, hidden frames, source gap, angle changed, stable `id` + `reviewKey` |
| `find(quote)`, `findAll(quotes[])` (1-50), `findUnique(quote)` (throws not_found / ambiguous with up to 5 contexts), `findCandidates(quote,{maxResults,contextTurns})` | exact-word matching on kept transcript |
| `spanFromQuote(startQuote,endQuote)` | fuzzy anchor pair (>=70% token overlap for 4+ token anchors) -> Span or null |
| `rangeAtFrames(s,e)` | revision-bound Span from raw frames |
| `validate({requiredText, forbiddenText, maxDurationSeconds})` | ok/issues report, never throws |
| `searchScenes(query,{pageSize,nextToken,ranges})` | semantic visual search on the edited draft (resolved frames) |
| `captureFrames({frames, includeOverlays})` | 1-12 frames or search hits -> one JPEG contact sheet of the working-copy composite (uncommitted edits included) |
| `captureCameraAngles({frame, videoIndexes?})` | all multicam angles at one frame, labelled by V track |
| `visualSpanRanges({kind:"badShotSpans"|"frontalSpans", videoIndex?})` | stored scan results projected onto the draft as removable Spans + frame ranges |
| `camFacts({span})` | per-camera coverage (who it sees, score, wide, face visible), wide-shot and reaction moments, solo/screen-recording flags |
| `clips({trackScope})` | ClipInfo: clipId, trackId, resourceId, trackKind, frames, videoIndex, audioSourceIndexes, color, playbackSpeed, preserveAudioPitch |
| `audioTracks()` | audio source inventory with display labels A1.. and colors |
| `markers()`, `overlays()`, `takeGroups({alternatives})` | markers; installed overlays (not clips); retake groups with exact `placements` |
| `silenceSpans({preset | minSilenceSeconds | keepPaddingSeconds, scope, semanticEndOnly, overrides[]})` | read-only plan: per silence `cutSpans` (for remove) and `restoreRanges` (for restoreFrom), speech-rate bucket 1-4; presets gentle/normal/tight/jump_cut with per-rate padding table (`selects.pacingPresets`) |
| `clipAudio(clip)` | volumeDb or keyed line, fades |

Edits (all WC unless noted; each returns an `EditDiff {before/afterDurationFrames, deltaFrames, opCount, removedDurationFrames, removedText, warnings, frameRateChange?}`)

| Method | Behaviour |
|---|---|
| `setName`, `setFrameSize(size|"original")`, `setSettings({frameRate, frameSize})` | rename; canvas; FPS conform (re-read spans after) |
| `remove(targets,{tracks:"all"|"main"|ids, intentionalSilence?})` | Main = recoverable soft cut; selected lanes physically trimmed with ripple; unselected lanes follow ripple rule; multiple cuts applied last-to-first |
| `restoreFrom(targets)` | undo soft cuts (own base ranges) or re-insert material from a reference draft's rows |
| `replace({target, source})` | swap exactly target with source span(s), Main only |
| `insert({source, at?, tracks})` | copy a source window (SS, ref, or another draft's span) incl. chosen tracks; cuts all tracks at insert point; first insert into empty draft adopts source fps/canvas |
| `insertResource({resourceId, sourceRange?, at?})` | place any project resource, even unanalysed, by source seconds |
| `insertGap({at?, seconds})` | blank time on Main |
| `moveRange({target, to})` | reorder storyline with lane clips carried |
| `splitAt({frame})`, `trimBoundary({frame, side, byFrames})` | razor; ripple edge trim (rejects rather than clamps) |
| `setVideoAngle({target, videoIndex})`, `setAudioTracks({target, audioSourceIndexes})` | multicam camera / audio routing over a range |
| `addMarker({at, note})`, `deleteMarker(marker)` | timeline markers with notes |
| `setChapterTitle({chapter, title})` | rename chapter band |
| `moveOverlayClip({clip, startFrame})` | drag a lane clip (overwrite) |
| `removeClips(clips)` | delete lane clips, leaves gap |
| `addTrack({kind, beside?})`, `deleteTrack`, `removeEmptyTracks()` | lane management |
| `setClipColor({within | clips, color})` | 11-colour labels |
| `setClipAudio({clip, volumeDb | volumeKeys[], fadeInSeconds, fadeOutSeconds})` | -60..+12 dB constant or keyed level line (ducking) |
| `overlayResource({resource, over, sourceStartSeconds?, playbackSpeed?, withSound?})` | B-roll/photo over a span on the outermost free lane; photo held for any length |
| `setClipPlaybackSpeed({clips, edit: rate | preserveAudioPitch | duration | reset})` | 0.01-100x, pitch preserved 0.25-10x, duration mode retimes to a length |
| `stage(reason)` | validated preview: cumulative diff, findings (`word-boundary-cut, source-room, flash-clip, created-silence, speaker-visibility, multicam-structure, speechless-audio-route`), review frames, changed seams. Saves nothing |
| `commitAll(reason)` | persist the whole working copy as one undo step (needs allowCommit); returns `commitId` or `createdDraftId`; rejects if draft changed since read |
| `revertCommit(commitId)` | IMM safe inverse of the latest commit |
| `replaceWords({target rows, replacement[]})`, `splitCaptionBefore(word)`, `mergeCaptionWithPrevious(word)` | IMM transcript corrections on the owning resource (affect all drafts) |
| `captions({offset,limit})`, `nextCaptionTranslationBatch({targetLanguage,limit})`, `setCaptionTranslations`, `activateCaptionTranslation` | transcript caption rows and per-language translation progress; writes IMM |
| `multicam` | see multicam.d.ts |

### project.d.ts — `ProjectHandle` and `selects.media`

| Method | Behaviour |
|---|---|
| `meta()` | id, title, status, dates, `draftIds` |
| `resources()` | per resource: short id `r0..`, name, type Video/Audio/Image/Sequence, analysis status (9 states), color, hasAnalysis, hasTranscription, duration, `recording{recordedAt, creationAt, filenameTimestamp, timecodeStart, location{lat,lon,accuracy}}`, owning synced timeline |
| `sourceFiles({folder?})` | file tree with path, timecode, fps, size, sample rate, slate; summary mode over 200 files |
| `readFootage()` | deterministic same-shoot grouping (timecode/filename/checksum), residual clips, possible extra angles, folders, drafts, unanalysed list |
| `searchScenes(query,{resourceIds,pageSize,nextToken})` | ranked project-wide visual search; hits renderable with `resource(id).captureFrames` |
| `transcription()` | all utterances/words (source seconds), chapter summaries, **visualCaptions** (stored text descriptions of what each video shows over time) |
| `speakers({resourceId})`, `profiles({resourceId})` | speakers per resource (audio routing, face profile); visual profiles with representative image |
| `addSpeaker`, `renameSpeaker`, `assignSpeakerAudio`, `assignSpeakerToProfile`, `removeSpeaker` | IMM speaker management |
| `setWordsText(updates[])` | IMM word text correction by ids |
| `retakeGroups(sequenceId)` | raw retake metadata incl. AI visual/audio descriptions per take |
| `importFiles({paths})` | IMM import of files or whole folders (structure kept); no timeline placement, no dedup |
| `importArtifact(aiArtifact)` | IMM adopt local-AI output as a resource |
| `deleteFiles({resourceIds})` | IMM remove resources and their clips |
| `createFolder / moveToFolder / renameFolder / deleteFolder` | IMM folder ops |
| `setResourceColor`, `setFolderColor`, `setAudioTrackColor` (legacy) | IMM colour labels |
| `createDraft({name})`, `duplicateDraft({sourceDraftId,name})` | new working-copy drafts, created by first commit |
| `estimateAnalysis({resourceIds})` | credit + duration quote |
| `startAnalysis({resourceIds, purpose?})`, `cancelAnalysis` | IMM paid analysis (sampling + transcription); one batch per script |
| `workflows({status,type})` | background job diagnostics incl. user-started ones |
| synced timelines | see synced-timelines.d.ts |
| `selects.media.probe(...)` | same as `probe_media` |
| `selects.media.captureFrames({path, seconds[1-24], crop?})` | contact sheet from any file path, no project needed |
| `selects.media.measureBeatSync({sources[{path,crop?}], includeBeatAnalysis?})` | 200 Hz RMS, 5 band levels, spectral flux and onset candidates; for video every frame's PTS, picture-change score and replaced-picture candidates; optional BPM, first beat, grid confidence, per-beat energy, band onsets, pulse candidates. Limits 300 s / 512 MiB / 18k frames, cached |
| `selects.media.startFFmpeg({args})`, `startFFprobe`, `job(id).status({cursor})/cancel()` | bundled ffmpeg/ffprobe with argv (no shell), background, 10 min cap, paged stdout/stderr |

### source.d.ts — `SourceReadHandle` (`project.resource(id)`, analysed sources, base frames)

`searchScenes`, `captureFrames`, `meta`, `words`, `turns`, `semanticCutSegments`, `chapters`, `viewerTranscript`, `pauses`, `find`, `findAll`, `findUnique`, `findCandidates`, `rangeAtFrames`, `spanFromQuote`, `takeGroups` (all as on Draft but SS-typed), plus:

| Method | Behaviour |
|---|---|
| `searchTranscript({query, speaker?})` | **semantic** speech search (meaning, paraphrase, "the reason...", "an example of..."); evaluates all speech server-side; returns candidates with SS + relative probability (kept if confidence >= 0.6 and p >= 0.4); all-or-nothing on failure |
| `resolveSpan(ref)` | revive a saved `SourceSpanRef`; throws `stale_source_span` if source changed |
| `speechAlignment({cursor,limit})` (narration.d.ts) | provider character-level timing for generated narration |

### visual.d.ts

`SceneSearchHit` (resourceId, trackId/videoIndex, start/time/duration seconds, score, frame window, focal frame), `SceneSearchPage` (`results, nextToken` valid for hours, `complete` flag when some sources have no index, `tokenAfter(hit)`), project-wide variant with per-hit fps, `VisualArtifact` (frame/contact_sheet JPEG with per-tile info), `VisualCaptureOptions` (1-12 frames or hits, overlays), `CameraAngleCaptureOptions`, `display()` limits.

### transcript.d.ts

Value types: `Word`/`WordRow` (see draft), `SegmentRow` (turn), `Chapter`, `TranscriptCaptionRow` (captionId, frames, original text, speaker, translation status translated/not-needed, span may be null), pages/batches with progress counts, `TranscriptTranslationSequenceHandle` (captions / batch / set / activate), `Speaker`, `Profile`, `Transcription {utterances, summaries, visualCaptions}`, `Utterance`, `TranscriptWord`, `Summary`, `Caption`.

### caption-documents.d.ts (styled Captions-panel document; generated-media capability)

| Method | Behaviour |
|---|---|
| `captionDocumentLines({targetLanguage?, offset, limit})` | styled caption lines with words, speaker, line-length limit (max words/characters), optional translation + staleness flag |
| `correctCaptionDocumentSpelling({corrections[]})` | IMM fix single words keeping punctuation/timing; atomic, max 500 |
| `breakCaptionDocumentLines({runs[{lines, wordCounts}]})` | IMM re-break lines at phrase boundaries; may raise the line limit |
| `translateCaptionDocumentLines({targetLanguage, entries[]})` | IMM write translated lines beside originals |

### generated-media.d.ts (effects, graphics, transitions, transforms)

| Method | Behaviour |
|---|---|
| `selects.effectPresets.list({category})`, `.get(id)` | built-in + user-saved presets: kind effect/generator/transition, categories filter/effects/zoom/text/sticker/transition; definition carries TSX (generators), editable parameter schema, defaults, default duration, start transform |
| `applyEffectPreset({clip, presetId, parameters})` | grade/filter/zoom/stack semantics like the Effects app; reports displaced presets |
| `addVideoEffect({clip, label, shader | tsxCode, parameters, editableParameters})` | custom per-clip effect as portable multi-pass WGSL graph (up to 128 passes, 8 inputs, SVG images/noise, uniform slots) or legacy React TSX |
| `videoEffects(clip)`, `videoEffectProgram(effect)`, `setVideoEffectParameters`, `replaceVideoEffect`, `removeVideoEffect` | inspect / tweak / replace / remove an effect in the stack |
| `addMotionGraphic({label, tsxCode, parameters, editableParameters, timeIndependent, within | at+durationSeconds})` | Remotion/React component as its own video clip (titles, lower thirds, shapes, logos); one element per call; inspector controls including real installed-font picker |
| `motionGraphics()`, `motionGraphicProgram(clip)`, `setMotionGraphicParameters`, `setMotionGraphicProgram` | list / read / patch / replace graphics |
| `addTransition({after, label, tsxCode, inOffsetSeconds, outOffsetSeconds})` | custom Remotion transition at a cut |
| `applyTransitionPreset({after, presetId | "constant-gain", durationSeconds})` | preset picture transition or audio crossfade centred on cut (0.1-5 s) |
| `transitions()`, `setTransitionDuration`, `removeTransition` | list/resize/remove (incl. track-edge fades) |
| `clipOpacity`, `setClipOpacity({opacityPercent | opacityKeys[]})` | constant or keyed opacity |
| `clipTransform`, `setClipTransform({position, scale, rotation, anchor, flips, enabled, positionKeys, scaleKeys, rotationKeys})`, `resetClipTransform` | FCP-style transform (position in % of frame height from centre), keyframable per group, keys never silently flattened |
| `recordPreviewReplay({startSeconds, endSeconds, withoutEffect?})` | record up to 30 s real-time playback of the unsaved working copy (optionally with one effect disabled as control) -> video + PNG manifest + presentation stats (holds, dropped frames) |

### synced-timelines.d.ts (multi-source "Synced Timeline" resources; all writes IMM)

Project: `syncedTimelines()` (status, clip/track counts, referencing drafts, editability lock), `syncedTimeline(id)`, `createSyncedTimeline({name, tracks[{clips[{resourceId,startFrame?}]}]})`, `deleteSyncedTimeline`, `syncSyncedTimelines([{sequenceId, method timecode|waveform, clipIds?, addGroupGap?}])` (background, wakes agent).
Handle: `settings/setSettings`, `setName`, `layout()` (tracks with V/A labels, mute/solo; placements with base frames, unsynced flag + reason, slate, speed, gain), `addClips`, `removeClips`, `removeVacantRanges`, `removeEmptyTracks`, `moveTrack`, `addTrack`, `deleteTrack`, `setTrackMute`, `moveClip({clipId, newTrackId|newTrackIndex, newStartFrame})` (manual sync nudge), `setClipPlaybackSpeed`, `setClipAudioGain`.

### multicam.d.ts (`draft.multicam`)

| Method | Behaviour |
|---|---|
| `regions()` | split Main into same-resource regions: standard / solo / skipped, screen-recording flag, profiling readiness, needs-classification marker |
| `classifyResource({resourceId, soloMulticam, screenRecording})` | IMM record the agent's judgment |
| `base(regionId)` | gapless "who is speaking" camera plan (switch list + stats + warnings), writes nothing |
| `tracksAt(frame)`, `roles({startFrame,endFrame})` | per person: main camera, alternates with scores, wide candidates; prominence/quality scores per track |
| `listenerEligibility({at[]})` | up to 200 frame/camera samples -> eligible or reason (noMain/speaking/onScreen/blurred/outsideRegion) |
| `angleCoverage(regionId)` | per-angle recorded windows (dead zones show black) |

### retakes.d.ts

Draft/Source `takeGroups`: groups with reference text, suggested selection (ranked take or "directed rewrite" detected from English/Korean director cues), alternatives, follow-up turns, consumed-by link; each take has text, exact spans, mapping status, verdict, rank, note, director cue, tags. Legacy `RetakeGroup/RetakeTake` with AI `visualDetails`/`audioDetails`.

### application.d.ts

| Service | Methods |
|---|---|
| `selects.export` | `inspectComposition` (render key/geometry), `still({resolvedFrame, outPath})` IMM PNG of one composite frame, `video({outPath .mp4, resolution 4K/FHD/HD/SD, composition{includeCaptions, excludeClips, endFrame, frameSize}})` background job with `status/cancel`, `audio({outPath .wav})` mix-down, `handoff({format premiere_pro/final_cut_pro/davinci_resolve, source selected/all/stringout, options: Premiere version, multicam, chapters as markers/captions, caption language mode, full timeline, used audio only, dropUnsupported})` -> artifact listing what was left out |
| `selects.editor` | `pickFile`, `pickDirectory`, `pickSavePath`, `revealFile`, `browser.tabs/open/close`, `seekDraftFrame`, `state()`, `captureScreenshot({target app/preview/timeline/transcript, region})`, `recordPreviewReplay({draftSequenceId,...})`, `openSyncedTimeline`, `linkToDraftFrame` (OS deep link), `openDraft`, `openApp` (apps.d.ts) |
| `selects.workflow(id)` | `status()`, `cancel()` |
| `selects.diagnostics.readAppLog({contains, level, sinceMinutes, limit, maxChars})` | main-process log tail |
| `selects.speakerProfiling` | `status`, `start` (build face/speaker profiles), `stop` |

### ai.d.ts — local AI runtime (`selects.ai`, plugin `selects-ai-runtime`)

`submit({runtimeId, requestKey, projectId, resourceId, sourceRange, task, options})` IMM with tasks **`faces.detect`** (sample interval, score threshold, CPU), **`person.matte`** (RVM matting; alpha frames PNG/AVIF or transparent foreground video; auto/CPU/DirectML), **`speakers.detect`** (active speaker, video <= 60 s). Job handle `status/result/cancel`, `job(id, projectId)`, `readJSON(artifact)`, `prepareMatte(artifact, projectId, {sourceKind})` -> durable mask URLs per source timestamp, capability flags `activeSpeakerSupported`, `imageSourceSupported`, `supportedMatteEncodings`. Idempotent by requestKey.

### generation.d.ts / narration.d.ts — paid media

`selects.generation.submit({projectId, requestKey, modelId, input, mediaType, uploads{resourceId|pluginFile + preparation(sourceRange, format, resize)}, inputMediaSeconds, outputName, delivery})`, `job(id).status/result/cancel/retryDelivery`, `jobs(projectId)`; refused in the in-app agent (must go through approval tool). `selects.stock.searchVideos({query, per, page, orientation})` stock footage discovery (no import). `selects.narration.voices({provider elevenlabs|typecast, query, cursor})`, `generate({projectId, name, text, voiceId, language, context, provider, model})` -> imported audio resource, `job(id).status (billing)/result/cancel/resumeImport`.

### local-files.d.ts — `selects.files` (writes IMM)

`environment, exists, stat, readdir, localUrl, pathFromLocalUrl, readRange (<= 48 KB base64), writeChunk (replace/append/exclusive), compareAndReplace, mkdir, remove, rename, copy, download(url, path)`.

### apps.d.ts

`selects.apps.list/get` (builtin/panel/template apps with input slots and options), `prepareFile` (hand a project file to a panel's file drop), `selects.templates.run({projectId, templateId, inputs{slot:[resourceId|sequenceId]}, targetSeconds 10-90, options})` + `job(id).status/cancel`, `editor.openApp`.

### artlist.d.ts / epidemic.d.ts — licensed music/SFX with the user's own account

Artlist: `status/connect/disconnect`, `search(term, kind music|sfx, categoryIds, page)`, `footage(term,page)`, `waveform(trackId)` (200 peaks), `categories(kind)` (genre/mood/theme/instrument), `artboards`, `collectionTracks/collectionPage`, `setFavorite`, `createArtboard`, `setArtboardTrack`, `preview`, `download` -> local path + attribution, `cancelDownload`, `openTrack`. Tracks carry bpm and length.
Epidemic: `status/connect/disconnect`, `search(term, offset)`, `liked`, `preview`, `stream` (HLS), `download`, plus `mcp.{status,connect,disconnect,search,download}` variant.

### comfy.d.ts

`selects.comfy.execute({action status/list/load/save/delete/select/openEditor/run/jobs/job/cancel/deliver/loadFile, scope, ...})` — ComfyUI workflow management and runs; `deliver` imports outputs as resources.

---

## 3. Runtime model

- **Execution**: each `run_script` call is a fresh script: TS -> ES2022 (esbuild), run in a Node `vm` context with no `eval`/`Function` code generation and no wasm. No DOM, network, filesystem, `require/import` or `setTimeout`; only ES built-ins, `console`, `display`, `selection`, frame helpers, `agentResults` and the `selects` object (a proxy over a renderer bridge `window.__MCP_BRIDGE__`). Top-level `await` and `return`; the return value is `JSON.stringify`-ed (cycles/BigInt fail, functions/undefined dropped).
- **Limits**: 30 s default deadline (max 120), 256 KB result (max 1 MB; larger spilled to a session file), console capped, max 4 displayed images / ~8 MB base64 per run, 1-12 frames per draft capture, 1-24 per media capture, pages of 1-50 for scene search, 500 for caption batches. One paid step (analysis, narration, credit template) per script.
- **Caching**: snapshot reads are cached per run by method + args; working-copy reads reflect local edits; editor state, workflows status, readFootage and estimates are live. Immediate project writes invalidate the cache.
- **Two persistence lanes**:
  1. *Draft working copy*: timeline edits (insert/remove/replace/move/split/trim, clip adjustments, effects, graphics, markers, settings, name) apply to a script-local copy; later reads see them; `captureFrames`/`recordPreviewReplay` render them; `stage()` validates and reports without saving; only `commitAll(reason)` with `allowCommit:true` saves, as one undo step, with an optimistic revision check (rejects if the saved draft changed since the run read it). Unsaved edits vanish when the script ends. `revertCommit(commitId)` undoes the latest commit.
  2. *Immediate writes*: project-level changes (import, delete, folders, colours, speakers, transcript word fixes, caption boundaries/translations/caption-document edits, synced timeline ops, analysis start, exports, file writes, AI/generation submits) persist at once, require `allowCommit:true`, are not rolled back by script failure, and must not be mixed with `commitAll` in the same run.
- **Recommended flows**: simulate + preview (capture frames, `stage`) then rerun with commit; or one-shot commit when the user already decided; never carry frame numbers from one call into a committing call (recompute in the committing script).
- **Time units**: draft data in frames at the draft fps; two draft clocks — *playback/resolved* (soft cuts excluded, what plays/exports) and *transcript/base* (cuts and silence included). Source handles use the source sequence's base frames; project transcription and AI/probe/beat APIs use source-media seconds; `atSeconds` for keyed values counts from the clip's first visible frame; transform position in % of frame height.
- **Referencing**: short ids per project (`r0` resources, `s0` synced timelines, `t0` tracks) mapped to UUIDs; edit targets are opaque live objects (`Span`, `SourceSpan`, `ClipInfo`, `Marker`, `VideoEffectInfo`, `TransitionInfo`, caption rows) that are occurrence-anchored (follow content across edits, throw if the content was deleted) and become stale after edits that change identities (re-read clips after each lane edit). Portable identity across calls is `SourceSpan.toRef()` + `resolveSpan`. Background jobs are referenced by workflowId/jobId and idempotent `requestKey`.
- **Safety model**: `allowCommit` is the single permission gate; paid actions additionally need an approval card in-app; session bound to one project; outputs never overwrite existing files.

---

## 4. Reelcut 2.6.0 comparison (`src/agent.ts`: 22 tools, `edit_draft` op list, `run()` switch)

Legend: **P** present, **p** partial, **M** missing, **R+** Reelcut ahead.

### Agent surface and runtime

| Selects capability | Reelcut | Note |
|---|---|---|
| `run_script` sandbox over a full SDK | M | Reelcut exposes fixed tools; compound queries need many calls. |
| Simulate/preview/stage/commit lanes, `allowCommit` gate | p | Every tool edit applies at once; safety via Ctrl+Z and per-request `aiRuns` before/after record. No dry run. |
| `revertCommit` | p | Undo stack instead. |
| `read_docs` + 32 skills + recipes | p | One playbook (`get_playbook` 360_auto_edit). |
| `run_shell`, `browser_repl`, `app_repl`, web search | M | Not needed for a personal editor except maybe web search. |
| `ask_options` card | M | Agent can only ask in plain text. |
| `spawn_subagent` | M | |
| `read_editor_state` / `editor.state()` | p | `stateNote` injects open draft, playhead, selected clip per turn; no seek, no screenshot, no open-draft. |
| Long-job wake-ups (analysis, sync, scans) | p | `transcribe` and `export_draft` block until done. |

### Project / media

| Selects capability | Reelcut | Note |
|---|---|---|
| `resources()` inventory | P | `get_project_overview` (id, name, kind, duration, res/fps, 360 layout, transcript state, folder, recorded date). |
| Recording date / GPS location | p | Date shown; no GPS. |
| `sourceFiles` tree, `readFootage` same-shoot grouping | M | |
| `importFiles`, `deleteFiles`, folders, colour labels | M | Agent cannot import or organise. |
| `probe_media` (timecode, camera, audio level) | p | Only basic info. |
| `compare_audio`, Synced Timelines, waveform/timecode sync | M | Needed for phone + 360 + mic shoots. |
| `media.measureBeatSync` / beat analysis | M | |
| `media.captureFrames` by path | p | `view_frames`/`contact_sheet` on project assets only. |
| `startFFmpeg` jobs | M | (Rust side has ffmpeg; not agent-exposed.) |
| `export_transcript` / `export_draft_text` | M | |
| `preview/import_timeline_xml` | M | |

### Transcript and search

| Selects capability | Reelcut | Note |
|---|---|---|
| words/turns/viewerTranscript | P | `get_transcript` asset (source s) or draft (timeline s). |
| Speakers, profiles, speaker labels | M | No speaker info in tools. |
| Filler tags | p | `isFiller` text heuristic in `remove_fillers`. |
| `find`/`findUnique`/`findAll`/`findCandidates` | p | `search_transcript` whitespace-insensitive substring, 40 hits, no uniqueness check, no draft-span result. |
| `searchTranscript` semantic | M | |
| `spanFromQuote` | M | |
| chapters, `regenerate_topics`, `setChapterTitle` | M | |
| `semanticCutSegments`, natural padding `expand` | p | `snap_cuts` moves edges to nearest gap (±1.5 s). |
| Transcript correction (`replaceWords`, `setWordsText`, caption split/merge) | M | |
| Caption translation (transcript and caption-document) | M | |
| Caption line breaking / spelling | p | `set_captions` toggles burned-in captions with size/position/max_chars only. |
| `transcription().visualCaptions` | M | No stored visual descriptions of footage. |

### Visual understanding

| Selects capability | Reelcut | Note |
|---|---|---|
| `searchScenes` (draft / resource / project) | M | Biggest discovery gap. |
| `captureFrames` of edited composite | p | `view_frames` = source frames; `check_framing` = 360 view of one clip; no render of the full draft with overlays/titles. |
| `captureCameraAngles` | M | |
| `scan_bad_shots` + `visualSpanRanges` | M | Shaky/blurry detection. |
| `scan_gaze`, `camFacts`, multicam module | M | |
| local AI `faces.detect`, `person.matte`, `speakers.detect` | M | Reelcut has manual head marks via `equirect_sheet` + `frame_subject`. |
| `recordPreviewReplay` | M | |
| 360 reframing (view keys, equirect sheet, subject follow, framing check) | R+ | Selects has no 360 handling at all. |

### Draft editing

| Selects capability | Reelcut | Note |
|---|---|---|
| `createDraft` | P | `create_draft` with clip list + aspect. |
| `duplicateDraft` | M | |
| `insert` from source span / `insertResource` | P | `insert` op by source seconds. |
| `insert` from another draft with lanes | M | |
| `remove` soft cut + `restoreFrom` | p | `remove_range` / `cut_source` are hard edits; restore only via undo. |
| `replace` | M | (delete + insert manually). |
| `moveRange` | p | `move` by clip index only. |
| `insertGap`, `splitAt`, `trimBoundary` | P | `gap`, `split`, `trim`. |
| `setSettings` fps/canvas, `setFrameSize` | p | Aspect presets only. |
| `setName` | P | `rename`. |
| `validate` (required/forbidden text, max duration) | M | |
| `stage` findings / `seams()` review | M | |
| `pauses`, `silenceSpans` plan with same 4 presets | p | `remove_silences` applies directly (words or waveform); no inspection/plan, no per-scope overrides. |
| markers add/read/delete with notes | p | Add only (`add_markers`); read via `get_draft`; no delete. |
| `clips()` read | P | `get_draft`. |
| Lanes: `overlayResource`, `moveOverlayClip`, `removeClips` | P | `add_overlay` / `set_overlay` / `remove_item` (V2/V3 fixed). |
| `addTrack`/`deleteTrack`/`removeEmptyTracks` | M | Fixed track layout by design. |
| `setClipAudio` constant volume + fades | P | `set` volume/fade_in/fade_out; music add with fades. |
| Keyed volume line (ducking) | M | |
| Audio crossfade preset | M | |
| `setClipPlaybackSpeed` rate | P | `speed` 0.1-16. Pitch-preserve flag and "retime to duration" missing. |
| `setClipColor` | M | |
| `setClipTransform` static | P | x/y/scale/rotation/crop. |
| Transform / opacity keyframes | M | Only 360 view keys are keyframed. |
| `setClipOpacity` | p | Static opacity in transform. |
| `applyEffectPreset` / effect stack / custom WGSL | p | Fixed colour controls (exposure, contrast, saturation, temperature) + denoise; no presets, no custom effects. |
| `applyTransitionPreset` / custom transitions | p | Dissolve (`transition`) only. |
| `addMotionGraphic` titles/text/stickers | M | No title/text tool. |
| `detach_audio` (J/L cut) | R+ | No direct Selects equivalent in SDK. |
| Multicam `setVideoAngle`/`setAudioTracks` | M | |
| Retakes / `analyze_retakes` / `takeGroups` | M | |

### Output and generation

| Selects capability | Reelcut | Note |
|---|---|---|
| `export.video` | P | `export_draft` 4k/fhd/hd/sd. |
| `export.audio` | P | `audio` preset. |
| High-compression archive presets | R+ | `shrink_*` AV1/HEVC presets. |
| `export.still` PNG | M | |
| `export.handoff` Premiere/FCPXML/Resolve | M | |
| Export composition (exclude clips, captions toggle, end frame) | p | Captions follow draft setting. |
| Generation, stock search, narration TTS | M | |
| Artlist / Epidemic music libraries | M | Music must already be a project asset. |
| ComfyUI, apps/templates/plugins | M | |
| Local files service | M | By design. |
| Diagnostics / app log | M | |

---

## 5. Most important gaps for a personal vlog / 360 family-video editor (highest value first)

1. Visual scene search over footage (`searchScenes` + stored `visualCaptions`): "find the kids at the beach" across hours of family clips; Reelcut can only look at frames it is told to.
2. Automatic subject detection for 360 follow (`faces.detect`/person tracking): would replace the manual equirect head-marking loop that feeds `frame_subject`.
3. Bad-shot scan (blur/shake/out-of-focus spans returned as removable ranges): key for handheld and 360 walking footage.
4. Titles and text (`addMotionGraphic` + presets): vlog chapter cards, place/date captions; Reelcut has no text tool.
5. Preview of the edited composite and a dry-run lane (`captureFrames` on the working copy, `stage` findings, `validate`); Reelcut edits are immediate and only verifiable through source frames.
6. Soft-cut removal with restore (`remove`/`restoreFrom`) and `replace`, instead of hard cuts recoverable only by undo.
7. Keyframed music volume for ducking under speech, audio crossfades, and keyframed transform/opacity (Ken Burns on photos).
8. Beat analysis (`measureBeatSync`) to cut montage clips and photo slideshows to music.
9. Capture-time ordering and grouping (recording date + GPS, `readFootage`, `probe` camera/timecode) plus waveform sync (`compare_audio`, synced timelines) for phone + 360 + mic of the same moment.
10. Semantic transcript search (`searchTranscript`) and topic chapters (`regenerate_topics`) for long talking segments.
11. Transcript and caption quality tools: word correction, caption line breaking, spelling, translation (Korean <-> English for family abroad).
12. A sandboxed scripting tool (`run_script`) so the agent can aggregate/plan in one call instead of many fixed-tool round trips.
13. Agent-side media import and folder organisation (`importFiles`, folders, colour labels) for new SD-card dumps.
14. Still-frame PNG export (thumbnails) and NLE handoff (FCPXML) as secondary outputs.
15. Music/narration sourcing (licensed music search, TTS narration) — lower priority for a private family editor; Reelcut already leads on 360 reframing, J/L-cut detach and archive-size export.

# Appendix B. Built-in skills


Read-only analysis for Reelcut 2.6.0. Sources: `~/.selects/resources/skills/*` (33 built-in Skill folders, `manifest.json`), `~/.selects/skills/auto-360-edit` (John's user Skill), skill loader code in `selects-analysis/app/dist/main/index-D0GunPM8.js` and `renderer-cache/f_00000d.js`, `f_000005.js`, `f_000073.js`, `f_000086.js`. Skill behaviour is described in our own words; SDK calls use the names from `inv-api.md` (sections 1-2 there). Note: `inv-api.md` 1d says the manifest lists 32 Skills; the current manifest and folder both hold **33** (the 33 names are the same in both).

---

## 1. The Skills mechanism

### Where Skills live

| Kind | Location | Notes |
|---|---|---|
| Built-in | `~/.selects/resources/skills/<name>/` (env `SELECTS_AGENT_RESOURCES_ROOT`, together with `sdk/` and `bin/rg.exe`) | Copied from the app's `electron/built-in-skills/` and checked against `resources/manifest.json` (per-file bytes + sha256). The loader rejects symlinks and special files, requires `SKILL.md` in every folder, and has file-count / size caps. Read-only for the agent. |
| Built-in, web host | Bundled into the renderer (`f_000005.js`): 25 desktop Skills plus "web overlays" | An overlay replaces a desktop file for the browser version and carries a `<!-- web-overlay source-sha256:... -->` header pinning the desktop file it was derived from. Overlays exist for beat-sync-analysis, install-plugin, panel-authoring (+3 refs), skill-creator, translate-transcript, video-request-intake (+11 cards/paths). |
| User | `~/.selects/skills/<name>/SKILL.md` (env `SELECTS_USER_SKILLS_ROOT`) | Written by the agent (skill-creator) or by plugin installs. A renderer `SkillRepo` class also reads/saves/deletes here (the folder name wins if it differs from the frontmatter name). |
| Panels (UI half of a plugin) | `~/.selects/panels/<name>/panel.tsx` (env `SELECTS_USER_PANELS_ROOT`) | Not Skills, but a Plugin = Skill + optional Panel + support files. |
| Helper files | Any files beside SKILL.md: `references/*.md`, scripts, `.d.ts`, Python | Linked relatively from SKILL.md and read on demand. Big Skills split into a short entry file plus references (multicam-cutting 11, transcript-guided-editing 7, video-request-intake 28, panel-authoring ~200). |

### File format (frontmatter, parsed by class `zr`/`Lr`)

- Must begin with a `---` fenced block; a flat key/value block, not full YAML.
- `name` (required): lowercase slug `a-z0-9` with single hyphens, at most 64 chars, must match the folder.
- `description` (required): one line, 1-1024 chars. It is the main thing the model uses to choose a Skill, so built-in descriptions also say what the Skill is *not* for and which sibling Skill to use instead.
- `triggers` (optional): JSON-style inline string array, max 16 phrases, each single-line and at most 80 chars, de-duplicated case-insensitively. Built-ins mix English and Korean phrases (e.g. vlog-edit has both "travel vlog" and a Korean equivalent). `# prettier-ignore` sits above it to keep it on one line.
- `autoInject.url` (optional): up to 16 URL globs; when such a URL appears the Skill is injected (only `youtube` uses it: youtube.com / youtu.be).
- Body: Markdown, parser limit 256 KiB. No other fields (no version, no tools list, no model).

### How the agent finds, chooses and loads a Skill

1. **Discovery each request.** The host lists the built-in tree plus every user folder holding a SKILL.md. Each user SKILL.md is read with a 400 ms timeout and parsed; failures go into an `issues` list ("Skill discovery failure ...") rather than aborting.
2. **Catalog in the prompt.** A localized block (`agentSkillDiscovery`) is injected. It has an "Available Skills" list (summary = name, description, triggers, autoInject) with a per-Skill read command (`cat "$SELECTS_AGENT_RESOURCES_ROOT/skills/<name>/SKILL.md"`, `type "%SELECTS_USER_SKILLS_ROOT%\<name>\SKILL.md"` on Windows) and a "Relevant Skills for this request" subset. The model is told to choose by description. The subset is most likely filled by trigger/URL matching on the user message; the matching code was not found in the cached bundles, so treat that as inference.
3. **Loading = reading the file.** Before planning or editing, the agent reads each relevant SKILL.md in full through `run_shell` (`max_output_bytes` 49152, chunked if cut off). Other hosts read it through `read_agent_resource` with a catalog key (web connector, browser agent), or through the host's native Skill feature (Codex / Claude Code hosts, where a `<skill>` block counts as loaded). References are resolved relative to the SKILL.md folder. The agent should load the smallest relevant set. If a resource is unavailable it must report that and stop ("fail closed"), never guess.
4. **Chaining.** Skills name each other by name and hand off ("load prepare-editing", "follow speech-flow-editor's normal pass", "read the use-apps Skill"). Example: transcript-guided-editing explains how to `ls` all `skills/*/references/<file>` when a relative path fails, because after a hand-off the most recently read Skill is not the owner.
5. **Policy for user Skills.** A user Skill is a user-authored procedure and cannot override product rules or tool contracts. It is re-read at the start of every new request even if already in context. A Skill that has been removed or is unreadable must not be applied from chat history. An empty catalog replaces earlier ones.
6. **Supporting agent tools used by Skills** (beyond `run_script`): `ask_options` (multiple-choice card; first option is shown as recommended; `multiSelect`; the chosen option's "Meaning" text carries forward), `update_todo` (notepad), `schedule_when` (one live conditional follow-up per chat that wakes the agent when analysis/jobs finish), `spawn_subagent` (handles, `outputShape`), and long-job tools such as `scan_bad_shots`, `scan_gaze`, `regenerate_topics` and `generate_media`.

### User vs built-in

- The catalog groups built-in and user Skills separately. A user Skill may not shadow or overwrite a built-in name; skill-creator checks both catalogs and existing folders, including malformed ones, before choosing a name.
- John has one user Skill: **auto-360-edit**. It turns one dual-fisheye 360 recording into a 16:9 highlight Draft with person tracking, horizon/shake correction and seam stitching, using Python tools (`prep.py`, `eqsheet.py`, `facecheck.py`, `silence.py`, `render.py`, `models/`). It has already been analysed elsewhere.

### Creation and install flows

- **skill-creator**: reduces the agreed procedure to a short SKILL.md, keeping lasting rules and dropping per-project IDs, camera numbers and filenames. It writes the file with shell commands to `SELECTS_USER_SKILLS_ROOT/<slug>/SKILL.md`, reads it back to check the name, limits, rules and relative links, and replies with a `selects-action://document?path=skills%2F<slug>%2FSKILL.md` review link. The new Skill shows up on the next request.
- **install-plugin**: takes a GitHub folder or `CutbackVideo/selects-plugin-library/plugins/<id>`. It pins a commit SHA, downloads only the files listed in `plugin.json` into a fresh staging folder (rejecting traversal), puts the Skill files under the user Skills root and `panel.tsx` byte-for-byte under the panels root, keeps `.local` settings plus a backup, checks hashes, and confirms the panel loads. When the app already did the download, the agent only sets up the runtime and reports in two or three plain sentences.
- **publish-plugin**: packages a working local plugin into the official library through a PR (localized names in 10 languages, public-safety checks, anonymous re-download check after merge).
- **panel-authoring**: writes the plugin's React `panel.tsx` (may import only react; gets `sdk`/`context`/`ui` props), can register a "Video template", and the plugin must produce an editable Draft, not a flattened video.

---

## 2. Built-in Skills (33)

Relevance = value for a personal vlog / 360 family-video editor (H/M/L).

| Skill | Purpose | Steps in short | SDK / tools relied on | Rel. |
|---|---|---|---|---|
| app-agent | Look at and operate the Selects window and plugin panels for the user | Take an interactive snapshot first. Act only on allow-listed controls (app panels, view tabs, transport). Never press export, delete, timeline or credit-spending buttons. Re-snapshot and read the diff, report in visible names, recover from revoked control. | `app_repl`, `read_editor_state`, `run_script` for real edits, `selects.templates.run` for credit apps | L |
| author-video-effects | Create or fix custom per-clip effects (WGSL shaders) and verify their speed | Read the effect stack. Check `effectPresets` first. Add/replace in the working copy, record a Preview Replay, and on a problem record again with the effect disabled as a control. Change one cost at a time while keeping the picture the same. Run `stage`, then commit. | `effectPresets.list`, `addVideoEffect`, `replaceVideoEffect`, `videoEffects`, `videoEffectProgram`, `recordPreviewReplay`, `stage`, `commitAll` | L |
| beat-sync-analysis | Learn a reference edit's way of cutting to music and turn it into a reusable template, or apply an existing template to the user's song and clips | Measure the reference (picture changes, audio bands, onsets, beat grid) and look at every change candidate. Write 4 artifacts (scene changes, audio changes, pairs, composition). Freeze the rules (SHA-256) before opening any user song. Build the plugin. For each song, write an explicit plan with exact cut frames on the Draft's fps, apply it and verify. Re-run on the reference audio and count hits within 1-2 frames. Report what was not listened to. | `media.measureBeatSync` (`includeBeatAnalysis`), `media.captureFrames`, `sourceFiles`, `importFiles`, `createDraft`/`insert`/`overlayResource`, `draft.captureFrames`, `commitAll`; panel-authoring, app-agent | M |
| break-caption-lines | Re-break the styled caption document's lines at phrase boundaries | Read all caption-document lines; if there are none, have the user press Add captions (or use app_repl). Group lines into short same-speaker runs and pick break points (no article+noun or number+unit splits, balanced lengths). Write from the end backwards, at most 100 runs per call. Report before/after examples and that Apply is still needed. | `captionDocumentLines`, `breakCaptionDocumentLines`, `draft.words` | M |
| browser-agent | Interactive website tasks in the embedded browser | Open or reuse a tab, snapshot with refs, act, verify from a fresh snapshot. Read network metadata only. Downloads go to Downloads; offer to import them. Never submit or buy anything unasked. Close the tabs at the end. | `browser_repl`, `web_search`/`web_fetch`; google-search, captcha-solver | L |
| camera-gaze | Find stretches where a subject looks straight into the lens | Read frontal spans. If any shown footage has none, collect resource ids in a script, run `scan_gaze`, re-read (resume by jobId). Report draft-time ranges. Optionally switch to the facing camera after checking with `camFacts`. Never judge gaze by eye or by scene search. | `visualSpanRanges({kind:"frontalSpans"})`, `clips`, `scan_gaze`, `camFacts`, `setVideoAngle`, `commitAll` | M |
| captcha-solver | Solve a CAPTCHA blocking an authorized browser task | Snapshot or screenshot, then a checkbox click, slider drag, press-and-hold or grid solve, then verify and continue the task. | `browser_repl` helpers (`captcha.click/drag`) | L |
| check-caption-spelling | Fix typos in the caption document without touching the transcript | Read all lines. Find single-word misspellings (typos, homophones, inconsistent names). Do not change style, grammar or slang. List join/split fixes and doubtful cases instead of writing them. Write at most 500 per call, re-reading on conflicts. Report before → after. | `captionDocumentLines`, `correctCaptionDocumentSpelling` | M |
| fix-blur | Remove or cover blurry, shaky or out-of-focus stretches on an assembled Draft | Read bad-shot spans and run `scan_bad_shots` on any unscanned shown footage. Choose the route by camera-angle count, not source count. One camera: remove the spans. Multicam: for each span pick another camera showing the same person with a visible face that is not blurry there, then `setVideoAngle` and report anything uncovered. | `visualSpanRanges({kind:"badShotSpans", videoIndex})`, `scan_bad_shots`, `meta().videoAngles`, `camFacts`, `remove`, `setVideoAngle`, `commitAll` | H |
| folder-organization | Sort project sources (and Drafts) into folders | Read `readFootage` (groups, synced units, residual, unanalysed, existing folders, drafts). Default to Main vs B-roll by content, not length, unless the user named a scheme; a screenshot of a bin layout is accepted as the spec. Propose with `ask_options`, then create/reuse folders and move, checking each result. | `readFootage`, `createFolder`, `moveToFolder`, `renameFolder`, `deleteFolder`, `viewerTranscript`, `ask_options` | M |
| generate-media | Paid AI generation (images/video/music) plus narration and music placement on a Draft | Discover the model and its schema, upload Resource or chat image, `submitBatch` for one approval, then poll/result/recover without resubmitting. Narration: one script per scene (chapters or Main-clip runs), one voice, neighbour context, fit-to-scene check, place at re-read frames. Music: duck under speech (about -3 → -18 dB, ramp 0.4 s before / 0.5 s after, sound-ups -26 dB, merge ducks < 1.5 s apart) and verify levels before commit. | `generate_media`, `narration.voices/generate/job`, `chapters`, `clips`, `overlayResource`, `moveOverlayClip`, `setClipAudio(volumeKeys)`, `clipAudio`, `speechAlignment`, `schedule_when`, `ask_options` | M |
| google-search | Google results through the signed-in browser profile | Use only when web_search is not enough. One query at a time. CAPTCHA goes to captcha-solver. | `googleSearch.search` (browser REPL) | L |
| image-search | Structured Google Images results (URLs, size, colour, licence hint) | Search with filters and verify reuse terms on the source page. | `imageSearch.search` | L |
| install-plugin | Install or update a library/GitHub plugin | See section 1 (pin commit, staged download, two roots, hash check, panel check). | `run_shell`, GitHub API, `selects.editor.captureScreenshot`, app-agent | L |
| multicam-cutting | Conversational camera switching on a multicam Draft | Work region by region in layers: base (who speaks), reactions, wides, facial inserts, cleanup, then a sweep over the whole Draft and an optional object-cam round (gaze scan first). Solo regions get a rhythm round, screen-recording regions their own round. Commit per layer with a plain-language line, keep commitIds for one-step revert, and give a numbers report per region. Stated preferences replace defaults and are checked at the end. | `draft.multicam.regions/base/roles/tracksAt/listenerEligibility/angleCoverage/classifyResource`, `camFacts`, `seams`, `setVideoAngle`, `revertCommit`, `scan_gaze`, `apply_object_cam_overlay` | L |
| panel-authoring | Build/change/delete a plugin's React panel or a Video template | Map each step to an SDK capability first. One portable `panel.tsx`, settings via `sdk.storage`, output an editable Draft. Verify through app-agent. | panel SDK (`panel-sdk.d.ts`), `run_script` SDK, app-agent | L |
| podcast-edit-defaults | Genre defaults when analysed genre is PODCAST | Keep all conversation; cut only obvious non-content and excessive dead air; switch cameras sparingly, brief reaction cuts. Overridable. | (policy only) | L |
| prepare-editing | Readiness check when an edit starts or sources change | Inventory resources/workflows/synced timelines. Create useful Synced Timelines without asking when editing was requested. Start analysis with an explanation and let the app's credit card decide (no extra chat question). Decide per operation what can proceed (evidence table). Register a `schedule_when` follow-up before starting jobs. Handle decline/failure/cancel without re-asking. | `resources`, `workflows`, `sourceFiles`, `syncedTimelines`, `estimateAnalysis`, `startAnalysis`, `cancelAnalysis`, `insertResource`, `schedule_when`, `update_todo` | M |
| publish-plugin | Publish a plugin to the official library | Gather only missing choices (name), localize, stage portable files, run library checks, PR to merge, verify anonymous download. | `run_shell`, git/gh, `ask_options` | L |
| skill-creator | Save a user's reusable procedure/preferences as a user Skill | See section 1: separate lasting rules from per-project values, slug and frontmatter limits, shell write, read-back validation, review link. | `run_shell` (`SELECTS_USER_SKILLS_ROOT`) | H |
| speech-flow-editor | Pacing, silences, fillers, repeats, playback speed on the current Draft | Four presets are target states (gentle/normal/tight/jump_cut), and relative requests move one step. Exact numbers are executed as given. Taste requests are measured first: 2-4 candidates from fixed formulas with impact previews; apply the recommended one, report the others, and later steps move from that value. Fillers only from tagged groups, all-or-none. Speed-change maths keeps pitch inside 0.25-10x. Every pass is simulated with hard guards (scope, no spoken change in a silence pass, direction, empty re-plan), re-planned at most once, recomputed in a fresh committing call, then verified. | `words`, `pauses`, `silenceSpans`, `remove`, `restoreFrom`, `span.through`, `setClipPlaybackSpeed`, `stage`, `commitAll` | H |
| suggest-highlights | Short-form clips (Shorts/Reels) from longer footage, user picks | Read chapters/turns/words/pauses (+scene search, camFacts). Propose up to 3 non-overlapping 20-60 s candidates on sentence boundaries with a hooking first line, each listed in the message with its reason. Ask with a `multiSelect` card. Build each pick as a new Draft (Main only), then style it with the user's shorts template or offer 9:16 + frame check. | `chapters`, `turns`, `words`, `pauses`, `searchScenes`, `captureFrames`, `rangeAtFrames`, `createDraft`, `insert`, `commitAll`, `apps.list`, `templates.run`, `setFrameSize`, `ask_options` | H |
| sync-project-sources | Group simultaneous recordings into Synced Timelines and sync them | Read files/resources/timelines. Plan all disjoint groups before writing, with no approval question for an explicit sync. Create and open each timeline, one camera per track. Choose timecode or waveform. Start the background sync and resume on wake. Report unsynced placements by source name, ask for a play-through, keep manual offsets (repair reference for misalignment). | `sourceFiles`, `resources`, `syncedTimelines`, `media.probe`, `createSyncedTimeline`, `addClips`, `layout`, `syncSyncedTimelines`, `moveClip`, `editor.openSyncedTimeline`, `workflows` | M |
| transcript-editor | Correct transcript words, change caption boundaries, rename chapters | Classify the phase. Find targets from fresh Draft words by (resource, utterance, word) id. Same token count → `setWordsText`; different → `replaceWords`; split/merge captions; chapter rename in a separate working-copy phase. Re-read and verify; warn that the change is global to the Resource. | `words`, `setWordsText`, `replaceWords`, `splitCaptionBefore`, `mergeCaptionWithPrevious`, `chapters`, `setChapterTitle` | M |
| transcript-guided-editing | Transcript-led assembly and content cuts | Pick one route: setup only, script-driven, length compression, storyline, or targeted. Read only that route's reference plus cut-execution. Speech goes on Main, B-roll/music on lanes. Plan with replayable quote anchors / SourceSpanRefs. For each batch: simulate → `stage` → review findings and changed seams → commit in a fresh call → read back. Do content first, then the speech-flow pass. Offer `regenerate_topics` after big trims. Report deviations only. | `organizeClips`, `transcription`, `insertResource`, `searchTranscript`, `viewerTranscript`, `chapters`, `takeGroups`, `spanFromQuote`, `findUnique`, `insertGap`, `overlayResource`, `stage`, `seams`, `commitAll`, `regenerate_topics`, `ask_options` | H |
| translate-plugin-captions | Translate caption-document lines beside the originals | Read with target language, skip lines already current, translate in context with one line per line and similar length, write at most 200 per call, verify all are current. | `captionDocumentLines`, `translateCaptionDocumentLines` | M |
| translate-transcript | Translate every transcript caption of one timeline into a language entity | Require an explicit language and timeline. Batch read; mark deterministic "not needed" rows (Korean: Hangul-only validator). Translate directly when ≤30 rows, otherwise up to 5 parallel pure-translator subagents of 100 rows with a fixed output shape. Validate, write, activate, verify. | `sequence.nextCaptionTranslationBatch`, `setCaptionTranslations`, `activateCaptionTranslation`, `captions`, `spawn_subagent` | M |
| use-apps | Run existing Apps/templates on chosen media | List apps (issues, slots, options). Choose resources by content; follow prepare-editing for transcripts. Run the template with credits approved in the app, one paid run per script, and poll the job; or drive the panel via app_repl / `prepareFile`. Verify the resulting Draft. | `apps.list/get/prepareFile`, `templates.run/job`, `editor.openApp`, `duplicateDraft`, app-agent | L |
| video-request-intake | Plan and deliver a brand-new video quickly (ads, explainers, stories, or footage edits such as vlog / event recap / talk show / podcast) | Lead the user: fill everything inferable and ask only hard-to-change items in one `ask_options`. Plan → storyboard → sample → full video, each approved once. Never mention cost. Narration sets timing. Pick category and path files plus "cards" (models, narration, on-screen text, audio/loudness, check, export). Finish with an "Export now / I'll adjust first" question, then export to Downloads and check size, length and loudness. | `editor.openDraft`, `resources`, `generate_media`, `narration`, `addMotionGraphic`, captions app, `export.video/audio`, `schedule_when`, ffmpeg via `run_shell` | M |
| visual-browse | Coordinate clicks/drags for canvas-like browser controls | Fresh screenshot → smallest coordinate action → verify → back to refs. | `browser_repl` (`page.mouse`) | L |
| visual-editing | Picture-led edits: montages, shot lists, B-roll searches | Write a shot contract (beats, relations, negatives, counts). Search all footage project-wide, one query at a time (rate limits). Search and capture in the same call; inspect head/middle/tail pixels and reject when the pixels contradict. Keep provenance via `SourceSpanRef`. Simulate the montage and display frames, commit in a separate call, verify the saved composite at numeric frames (preserve hit `videoIndex`). | `organizeClips`, `project.searchScenes`, `resource.searchScenes`, `captureFrames`, `rangeAtFrames().toRef()`, `createDraft`, `insert`, `setSettings`, `setVideoAngle`, `commitAll` | H |
| vlog-edit | Cut a finished vlog/trip/recap from a real archive of clips and photos | Quick survey script (per-day video/speech seconds, photos, devices, orientation). Classify the profile (long take, many short clips, photo-heavy, talk-heavy, no talk, mixed cameras, single event) and compute a rough length ceiling. Ask one question: destination + aspect + length. Deep survey: fix camera clocks via anchors (shared audio, same event, spoken cues, light), detect coverage inversion, review every photo on contact sheets, shortlist from stored visual captions/chapters/utterances, scene search only for gaps, rate 1-5, confirm hero frames, scan bad shots. Shape: hook, acts on a chronological spine, find the complication. Shot rules checked in code: one moment once, photo share ≤35%, variety caps, a change every ≤8 s, sound-ups, portrait handling. Opening via the Vlog Opening template or a self-built 4-8 s hook. Build in two committing scripts (picture; then audio/overlays/sound polish/dissolves/photo motion/titles/chapters). Quality-gate script with a 12-frame look, up to 2 rebuild passes. Report and offer next steps. | `resources`, `readFootage`, `sourceFiles`, `media.probe`, `compare_audio`, `transcription` (visualCaptions/summaries/utterances), `project.searchScenes`, `captureFrames`, `scan_bad_shots`, `visualSpanRanges`, `insertResource`, `span.expand({padding:"natural"})`, `overlayResource`, `setClipAudio(volumeKeys)`, `applyTransitionPreset`, `setClipTransform` keys, `addMotionGraphic`, `setChapterTitle`, `templates.run`, `generate_media`, `editor.openDraft`, `ask_options`; ffmpeg + local HTTP for photo sheets | H |
| youtube | Structured YouTube search/metadata/transcripts/comments; yt-dlp download | Use the structured helper before scraping. Download only on explicit request, to an authorized folder, if yt-dlp exists. | `youtube.*` helper, `run_shell` | L |

User Skill (not built-in): **auto-360-edit**, John's 360 dual-fisheye → 16:9 person-tracked highlight pipeline with Python tools (already analysed).

---

## 3. Reelcut 2.6.0 comparison (`src/agent.ts`, `src/playbook.ts`)

**Reelcut's mechanism today:**
- One playbook, `PLAYBOOK_360` in `playbook.ts` (Korean, 33 lines). It covers the 360 auto-edit order: overview/transcribe, contact-sheet sweep, equirect_sheet, pick highlights, create_draft, snap_cuts, head marks → `frame_subject`, `check_framing`, get_draft.
- It is served by `get_playbook` with a one-value enum (`360_auto_edit`), and one line of the system prompt routes 360 requests to it.
- Missing: Skill catalog, frontmatter, triggers, user-Skill folder, "save as playbook" flow, reference files, `ask_options` card, background-job wake-ups.
- The system prompt itself holds the general rules: look before describing, transcribe first, new draft for big changes, export only on request, 2-4 sentence report.
- In "Claude account" mode the same tools are exposed as MCP `mcp__reelcut__*` to Claude Code, which has its own native skills, but Reelcut does not ship or point to any.

Legend: **P** present, **p** partial, **M** missing, **n/a** not wanted for a personal editor.

| Skill | Reelcut | Note |
|---|---|---|
| (mechanism) catalog + user Skills | p | One hardcoded playbook via `get_playbook`; no folder, no catalog, no user-authored playbooks. |
| app-agent | M (n/a) | `stateNote` gives the open draft/playhead/selection only; no screen reading or UI driving. |
| author-video-effects | p | Fixed colour ops (`set color`: exposure/contrast/saturation/temperature) + denoise; no effect authoring or replay measurement. |
| beat-sync-analysis | M | No beat/onset measurement; music is placed but cuts are not timed to it. |
| break-caption-lines | p | `set_captions max_chars` wraps automatically; no line-level re-breaking at phrase boundaries. |
| browser-agent | M (n/a) | |
| camera-gaze | M | No face/gaze detection; 360 head positions are marked by hand on `equirect_sheet`. |
| captcha-solver | M (n/a) | |
| check-caption-spelling | M | No caption or word text correction at all. |
| fix-blur | M | No blur/shake detection; 360 horizon/stabilisation is a render setting only. |
| folder-organization | M | Overview shows `folder`, but the agent cannot create or move folders. |
| generate-media | p | `add_music` with default fades exists (music volume 0.25, fade 1 s/2 s); no ducking key line, no narration TTS, no generation. |
| google-search / image-search | M (n/a) | |
| install-plugin / publish-plugin / panel-authoring / use-apps | M (n/a) | No plugin system; possible later as presets. |
| multicam-cutting | M | No multicam. 360 view keys are the closest analogue (one camera, many angles) and are covered by the 360 playbook. |
| podcast-edit-defaults | M | No genre defaults; the system prompt has only generic pacing presets. |
| prepare-editing | p | System prompt says transcribe first and `transcribe` blocks until done; no readiness table, no sync step, no follow-up after background jobs. |
| skill-creator | M | The user cannot save "my editing rules" as a reusable playbook. |
| speech-flow-editor | p | `remove_silences` (same 4 preset names) and `remove_fillers` (text heuristic) apply directly. Missing: measured candidates, filler groups, restore, simulation guards, speed-to-duration maths. |
| suggest-highlights | M | Possible ad hoc (transcript + create_draft + aspect 9:16), but no procedure or choice card. |
| sync-project-sources | M | No waveform/timecode grouping or synced timelines. |
| transcript-editor | M | No word fixes, caption split/merge or chapter titles. |
| transcript-guided-editing | p | `get_transcript`, `search_transcript` (substring), `create_draft`, `cut_source`, `snap_cuts` allow transcript-led cuts. No route split, no semantic search, no stage/seam review, no chapter refresh. |
| translate-plugin-captions / translate-transcript | M | Captions are single-language from the transcript. |
| video-request-intake | M | No new-video planning flow. Export is only on request, with no post-export check of length/loudness. |
| visual-browse | M (n/a) | |
| visual-editing | p | `contact_sheet`, `view_frames`, `equirect_sheet` allow real pixel inspection. No scene search, shot contract or provenance, and no capture of the edited composite (`check_framing` shows one 360 clip's view only). |
| vlog-edit | p | The 360 playbook covers one recording → highlight with head-third framing, 4-30 s shots, 10-15% other family members, and a full sweep before picking. Missing: multi-clip/photo archive survey, footage profiles, clock correction, one-question intake, story shape/hook, one-moment-once/variety checks, photo survey + photo motion, sound polish (ducking/edge fades), titles, quality-gate script. |
| youtube | M | |
| auto-360-edit (user) | p | Its goals overlap PLAYBOOK_360 (follow person, horizon, stabilisation). Reelcut does the reframing natively (`frame_subject`, view keys) but lacks automatic person detection and seam stitching tools. |

---

## Summary: most important gaps (most valuable first)

1. Skill system: add a playbook catalog (built-in + user folder, name/description/triggers, a `get_playbook` that lists and loads by name) instead of one hardcoded 360 playbook.
2. A vlog-edit equivalent: archive survey, footage profile, clock correction, one length/destination question, story shape and hook, one-moment-once/variety rules, quality gate.
3. A skill-creator equivalent: "save these rules for next time" writes a user playbook that is re-read on every request.
4. Sound polish rules from vlog-edit/generate-media: music ducking under speech (keyed volume), edge fades on speech beats, act-to-act music crossfades.
5. fix-blur: measure shaky/blurry stretches (handheld and walking 360) and remove them, instead of finding them by eye.
6. visual-editing: shot contract, project-wide scene search, pixel-verified candidates, and a check of the edited composite before reporting.
7. suggest-highlights: propose 3 Shorts candidates with reasons, let the user pick on a card, build 9:16 drafts.
8. speech-flow-editor: measure-first pacing candidates, filler groups, restore, simulate-then-commit guards, instead of one-shot `remove_silences`.
9. transcript-guided-editing routes: storyline / length compression / targeted edits with seam review and a semantic transcript search.
10. Multi-device prep: sync-project-sources + vlog-edit Clocks for phone + 360 + mic of the same moment (waveform offset, grouping).
11. Interaction plumbing used by many Skills: `ask_options` choice cards, prepare-editing readiness flow, follow-ups after long jobs.
12. Caption and text Skills: transcript word correction, caption spelling and line breaks, Korean↔English translation, plus folder organization for SD-card dumps.

# Appendix C. Editor features


Written 2026-11-04. Read-only analysis. This file covers the hand-operated editor: panels, timeline, inspector, presets, export and settings. The agent API and the Skills are in `inv-api.md` and `inv-skills.md`, so they appear here only where a UI feature depends on them.

**Sources and evidence notation**
- `f_0000xx.js@N` is a character offset in `renderer-cache\f_0000xx.js`. `main@N` is an offset in `app\dist\main\index-D0GunPM8.js`. A `.d.ts` or `recipes/*.md` name refers to `C:\Users\pc\.selects\resources\sdk`.
- The renderer's UI text sits in an i18n dictionary that is not in the cache. Most features below were therefore identified from **i18n key names** (for example `clipper.template.followFaces`) and the code around them. Their visible wording was not available and is not reproduced.
- The built-in preset catalogue (looks, captions, stickers, titles, transitions, zooms) is in `f_000008.js` (the RenderedPresetArt chunk). The command and keybinding registry is in `f_000086.js@1481700–1546400`.
- Reelcut status was checked against `src/types.ts`, `edit.ts`, `exporter.ts`, `captions.ts`, `presets.ts`, `commands.ts`, `ui/*.tsx`, `src-tauri/src/render.rs`, and `CHANGELOG.md` (2.6.0).

**Status legend:** **present** = equivalent exists. **partial** = some of it exists. **missing** = not in Reelcut. **R+** = Reelcut does more than Selects here.

---

## 1. Media import and library

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| Import files / folders / drag-drop | Picker for files or folders. Folders are scanned recursively up to depth 40; hidden and `._` files are skipped. Option-drag places clips side by side instead of stacking them. | main@4902809 (`pick-media-*`, `drop-media-files`); `prepPage.dragDrop.pressOptionToPlaceHorizontally` f_000070@1492738 | present | Reelcut accepts more containers (osv, lrf, mts, m2ts, 360). Selects does not accept `.osv`. |
| Skipped / unsupported file notice | After an import, lists the files that were skipped and links to the supported formats. A separate notice covers RED `.r3d` files. Duplicate files are skipped and reported. | `prepPage.skippedFilesNotice.*`, `prepPage.r3dImportNotice.title` f_000070@1596508, `prepPage.duplicateFilesSkipped` | partial | Reelcut shows a toast for files it cannot read but no list of what was skipped. |
| Relink missing originals | Dialog that lists unlinked originals and lets you locate each one. It searches for a matching file and reports when none matches. | `manhattan.relinkFiles.*` f_000070@603263, `resourcePanel.relinkFiles` f_000070@1625217 | missing | Matters when footage sits on a NAS or a removable drive. |
| Slow-drive / HDD warning | Measures transfer speed and checks whether the media sits on an HDD, then warns that playback will be slow. | main IPC `measure-transfer-speed`, `contains-path-in-hdd`; `alertSlowDataTransfer.*` | missing | Useful for NAS footage (`\\DS620slim`). |
| Folders (bins) | Create, rename and nest folders. Selects only, never in an exported draft. | `resourcePanel.createFolder` f_000070@1594484 | present | Reelcut has flat bin folders. |
| Colour labels | Palette colour labels on folders, resources and timeline clips. | `timeline.colorLabel` f_000070@1588974; `draft.d.ts` `ClipColor`/`PaletteColor` | missing | Reelcut has star ratings, pick/reject and tags instead. |
| Ratings / pick / reject / tags | No star ratings on media. The "rating" strings are feedback ratings for handoff. | f_00007c@~1497300 (handoff rating) | **R+** | Reelcut has 1–5 stars, pick (P) / reject (X), tags and a note. |
| Smart collections | None. The media panel sorts by a chosen column (`fileTreeColumns.*`). | f_000070@1250327 | **R+** | Reelcut has smart folders (picks, 3 stars and up, 360, has transcript, unused). |
| List / grid view, sort | List and grid views; sort column with ascending or descending order. | `resourcePanel.switchToListView*`, `fileTreeColumns.*` | present | |
| Metadata / info panel | Info tab shows type, frame rate, frame size and "mixed" for multi-selection. | `info.*` f_000071@392674 | partial | Reelcut shows probe info and recording date, but has no inspector tab for a media item. |
| Text search in the media panel | Search panel over names and spoken words. | `resourcePanel.searchPanel*` | present | Reelcut searches names, dialogue and `#tag`. |
| **Visual search** | "Search visuals": scene search across analysed footage (cloud analysis). Find and replace also has a scene mode. | `resourcePanel.searchVisuals` f_000070@1551305, `searchReplace.scene` f_000070@1946111 | missing | Biggest discovery gap for family footage ("kids at the beach"). |
| Cloud analysis of clips | "Analyze clips" uploads audio samples and keyframes and charges credits. It produces the transcript, topics, speakers and visual descriptions. Stages include render audio, detect silences, upload samples and poll. | `resourcePanel.analyzeClips` f_000070@1624514; f_000086@1619916–1620618 | partial (by design) | Reelcut transcribes locally (Whisper / Qwen) and has no visual analysis. |
| **Multi-source sync** | Builds a "Synced Timeline" from camera, phone and recorder clips. Sync by timecode or by audio waveform; sync all or selected; review unsynced clips; re-sync. | `prepPage.syncWithTimecode` f_000070@1808916, `prepPage.syncWithAudioWaveform` @1808795, `prepPage.reviewUnsyncedClips` @1809501; f_000086@1616612 (sync stages) | missing | Needed for Osmo 360 + phone + lav mic of the same moment. |
| Auto-organise a shoot folder | Groups many sources by recorder or camera, arranges them automatically, inserts groups into a timeline, syncs the groups and removes gaps. Has a long-running progress view with a stop button. | `jwonderPreparation.organize.title` f_000070@1443519, `.autoArrange.action` @623456, `.syncGroups.title` @628766 | missing | Good fit for SD-card dumps from several devices. |
| Import timeline XML | Imports a Premiere / FCP7 XML (xmeml) as sequences. Shows a preview with clip and track counts, flags problem clips (retimed, missing media, unsupported content) and recognises multicam sources. | `prepPage.importTimelineXml.*` f_000070@1604757–1606118; parser f_000086 (`xmeml`) | missing | Low priority for a personal editor. |
| Script import | Imports a script (`.docx`, `.pdf`, `.srt`, `.txt`) and matches it to footage. | f_000070 `parseDocxScript`/`parsePdfScript` chunks, `.docx` handler | missing | |
| Recorder | Records camera, microphone, screen and system audio inside the app, with device pickers, level meter, mirror and recovery of unfinished takes. | `recorder.*` f_000070@1188175–1189514; `resourcePanel.addMenuRecord` @1651300 | missing | Low priority. |
| Generated-data storage cleanup | Scans generated files per project, shows their sizes and deletes the selected ones. | `generatedData.*` f_00007c@1565903 | missing | Reelcut stores few derived files since 2.5 (proxies were removed). |
| Library / project storage | Local SQLite library per user. Project export (archive) and import. Web-to-desktop handoff. No cloud sync of the library. | REPORT §4; `manhattan.titlebar.exportMenu.project` f_000070@568252; `profile.importProject`; `desktopHandoff.*` | partial | Reelcut keeps JSON projects; it has no project archive export or import. |

## 2. Transcript editing

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| Edit by deleting text | Delete words, a sentence or a whole chapter from the transcript; the timeline follows. | `C_TOGGLE_DELETE_MARK_SEGMENT`/`_CHAPTER` f_000086@1491338 | present | |
| Show and restore deleted words | Option to show deleted words, and restore them. | `manhattan.preferences.showDeletedWords` f_000070@376689 | present | Reelcut strikes cut words through and restores them with one click. |
| Show silence length | Shows the length of each gap (in frames) inline in the transcript. | `manhattan.preferences.showSilenceFrameLength` @376966 | partial | Reelcut previews the silences it would cut on the timeline, not in the transcript. |
| Word correction | Edit a word's text, merge it with the previous or next word, split a caption, merge a line with the one above, insert a line break. | f_000086@1491513–1491797; `transcription.popovers.*` | partial | Reelcut can edit a word on double-click and do find & replace. It has no split or merge. |
| Proper-noun fixer | Panel listing proper nouns as transcribed, with a field to change each one throughout. | `manhattan.properNounsPanel.*` f_000070@654601 | missing | Handy for family names misheard by Whisper. |
| Speakers | Diarised speakers; change a line's speaker with keys 0–9; rename a speaker (this source or all). Speaker profiles carry a face photo picked from frames, can be merged, and their deletion can be undone. | f_000086@1491871 (`C_CHANGE_SPEAKER_TRACK_n`); `speaker.*` f_000070@1385745 | missing | |
| Topics / chapters | Topic and subtopic bands over the transcript and timeline; chapters can be regenerated; navigation commands for chapters. | `timeline.topicBand.*` @1783869, `topicRegeneration.*` @1340631; f_000086@1490436–1490930 | missing | |
| Keyboard navigation | Word, line, chapter and subchapter movement and selection (arrows, Shift + arrows). Reversed for right-to-left languages. | f_000086@1495714 (default keymap) | partial | Reelcut has playback keys but no word or line cursor movement in the transcript. |
| Find & replace | Searches the text or scenes, in this draft, the project or all files; replace and replace all. | `searchReplace.*` | partial | Reelcut finds and replaces words in the current transcript only. |
| Remove silences panel | Presets (short, medium, no gap, custom). Minimum cut length, gap kept between sentences, padding after a word ends and before the next one. Results can be restored. | `manhattan.removeSilencePanel.*` f_000070@644186 | present | Reelcut has 4 pacing presets and a preview, with no custom padding fields. |
| Cut filler words | Categories: hesitations, repeats, hedging. Choice of frequency, minimum jump-cut length, all occurrences or some. Restore. Runs through the agent. | `cutFillerWords.*` f_000070@648259–649645 | partial | Reelcut uses a single list-based filler detector, with no categories and no repeats. |
| Translate transcript | Translates the transcript of analysed or draft sequences into a language picked from a searchable list. | `toolPanel.translateTranscript` f_000070@661977, `toolPanel.translateDraftSequences` @661395 | missing | Korean ↔ English for relatives abroad. |
| Transcript export | Exports plain text, transcript SRT, caption SRT and a chapters list, optionally with the translation. | `manhattan.exportTranscriptDialog.*` f_000070@510453; `toolPanel.exportDraftTranscript*` @1338511 | missing | Reelcut has `transcriptText()` and `toSrt()` code, but no menu item writes them to disk. |
| Right-to-left transcript | Option to show the transcript right to left. | `manhattan.preferences.rightToLeftTranscript` @377206 | missing | Not needed (Korean/English). |
| Scrub audio / click blank to seek | Options to play audio while scrubbing and to seek by clicking empty space. | `manhattan.preferences.playAudioWhileScrubbing` @375877, `.clickBlankToSeek` | partial | Reelcut seeks on click; it has no scrub audio. |

## 3. Timeline

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| Tracks | Any number of video and audio tracks: add, delete, remove empty tracks, change all track heights. | `timeline.trackLabel.addTrack` f_000070@1782780, `timeline.removeEmptyTracks` @1782939; f_000086@1486601 | partial | Reelcut has fixed V1–V3, A1–A3 and C1 by design, with hide, mute, solo and lock per track. |
| Tools | Selection, razor, zoom, hand, track select forward/backward, rate stretch. | f_000086@1484260–1484815 | partial | Reelcut has select (V), blade (C), **roll (N)** and **slip (Y)**; Selects has no roll or slip tool. It lacks rate stretch and track select. |
| Trim commands | Trim start or end to the playhead, trim forward or backward, extend the selected clips to the playhead. | f_000086@1487303–1487588 | partial | Reelcut uses ↑/↓ to move to an edit point and drag trims; it has no keyboard trim-to-playhead. |
| Ripple | Ripple delete, add a gap, ripple trim on main, video and audio tracks. Insert time on every track; collapse everything to the top track. | f_000086@1483538, f_000070@1786267 (`canRippleTrim`); `insertTimeOnEveryTrack`/`collapseToTopTrack` chunks | present | Reelcut's V1 is magnetic; Shift+Del leaves a gap. Insert time across all tracks is missing. |
| Snapping | Snap toggle. A separate snap applies in the preview when moving graphics. | `C_TIMELINE_TOGGLE_SNAPPING` f_000086@1484913; `videoToolbar.previewSnap` f_000070@1456556 | partial | Reelcut has timeline snap (Shift+S) but no snap in the preview. |
| Clipboard | Copy, cut, paste, paste-insert, paste attributes (copies one clip's adjustments to others). | f_000086@1483861–1484089 | missing | Paste attributes would help apply one grade or 360 view to many clips. |
| Disable clip | Turn a clip off without deleting it. | `C_TIMELINE_TOGGLE_DISABLE_CLIP` f_000086@1488130 | missing | |
| Nudge | Move a clip 1 or 5 frames, up or down a track, and by pixels in the preview. | f_000086@1492711–1494027 | partial | Reelcut moves clips left and right in order (Alt+←/→). It has no frame nudge on V2/V3/A tracks and no pixel nudge. |
| Markers | Add, clear the selected marker, go to next or previous marker; marker drag. Markers carry a colour and a note and appear as review comments in Comment mode. Feedback markers are separate. | f_000086@1481771–1481890, @1486797; `recipes/markers.md` | partial | Reelcut adds markers (label and colour) and shows them. It cannot jump between them, edit a note in a list, or delete a marker from the UI. |
| Review / comment mode | View modes: default, vertical video, comment and preview-only. | `manhattan.editorPage.viewMode*` f_000070@378131 | missing | |
| **Multicam** | Synced multicam: cut to camera 1–9 at the playhead, or pick the angle for the current shot. Grid preview of all angles (grid, single, top tracks first). Automatic camera switching with a priority setting (active speaker, hold the current shot, most people on screen). Multicam setup panel (delete or merge angles). | f_000086@1482773, @1488846; `videoToolbar.trackGrid.*` f_000070@1458655; `camSwitching.*` @1335934; `manhattan.multicamSetupPanel.*` @683342 | missing | Two angles (360 + phone) of family events. |
| Retakes | Detects repeated takes of the same line and offers a "review takes" flow. | f_000086@240848; f_000070@1881565; `retakes.d.ts` | missing | |
| Bad-shot marking | Marks bad (shaky, blurry) shots in the source. | `manhattan.preferences.markBadShotsInSource` f_000070@374943; f_000086@1177135 | missing | |
| Audio meter, waveforms | Audio meter with a clip indicator; waveforms are generated automatically. | `timeline.audioMeter.*` f_000070@1864335; f_000070@1786267 | partial | Reelcut draws waveforms but has no level meter. |
| Drafts | Draft tabs, new draft, duplicate, close other tabs; drafts that track the main footage are locked. | `draftsTabs.*`, `contextMenu.duplicate` @1586392 | present | Reelcut has draft tabs with duplicate and delete. |
| Compare with source | Toggles the preview between the edit and the source. | `videoToolbar.compareWithSource` f_000071@14837 | missing | |
| Sequence settings | Frame-rate presets (23.976–120), canvas Original or custom W×H, "match source" on the first clip. | `videoToolbar.sequenceFrameSize.*` f_000071@389483; `sequenceSettings.matchSource` f_000070@1478809; `recipes/sequence-settings.md` | partial | Reelcut has 4 aspect presets and an fps setting, with no custom canvas size. |
| Preview zoom / resolution | Zoom and pan the preview (gestures), plus a preview-resolution badge. | `usePreviewZoomGestures` chunk; `videoToolbar.previewResolution.*` | partial | Reelcut has full screen, safe area and a thirds grid, but no zoom. |

## 4. 360 video

Selects has **no 360 support**. It imports `.insv` and `.lrv` as flat video and does not accept `.osv` (REPORT §2). The code has no equirect, projection, reframe or horizon handling (searched f_000086, f_000070, f_00007c and main). The closest Selects features are listed so that Reelcut can borrow the ideas.

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| 360 import (.osv dual-fisheye, LRF pairing) | Not available. | REPORT §2 | **R+** | Reelcut has the stitching, AI seam and GPU decoding. |
| Reframe with view keyframes | Not available. | — | **R+** | Reelcut has yaw, pitch, roll and FOV keys with smooth interpolation. |
| Horizon levelling / stabilisation | Not available. | — | **R+** | Reelcut has gyro-based horizon, lock and smooth modes, plus rolling-shutter correction. |
| Auto-follow a subject | For flat video only: the Clipper template's "follow faces" option keeps faces in frame when making a vertical clip. Local AI `faces.detect`, `person.matte` and `speakers.detect` exist for the agent. | `clipper.template.followFaces` f_000070@1304122; `ai.d.ts` | partial | Reelcut 2.6 follows a person from head marks the AI places on an equirect sheet. It has no built-in face or person detector; an automatic detector is the missing piece. |
| Vertical (9:16) view for editing | View mode that edits a vertical version. | `manhattan.editorPage.viewModeVertical` | partial | Reelcut sets 9:16 per draft. |

## 5. Captions

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| Caption document | A separate Captions panel document built from the transcript. It can be regenerated (optionally keeping edits), rebuilt from the transcript, or imported from a file. | `captionPanel.rebuildFromTranscript` f_000070@700080, `captionPanel.import.button` @700152, `captionPanel.regenerateKeepEdits` | partial | Reelcut builds captions from the timeline words every time, so there are no editable caption lines. |
| Caption line editing | Edit a caption, edit a word, merge with the next or previous word, move a word to the previous line, show or hide a line. | `captionPanel.menu.*`, `captionPanel.editCaption` | missing | |
| Line breaking | Split by letter count, word count or whole sentence; 1 line, 2 lines or all. | f_000008@63975–64253 | partial | Reelcut wraps by a maximum number of characters, on one line. |
| Style presets | 15 built-in styles plus "my background image": plain, soft appear, serif bar, keyword green/yellow, purple/orange highlight, red outline, yellow block, white pill, sky blue, neon blue, yellow pop, subtle white, and a "dynamic text" style that enlarges the key word. User styles can be saved. | f_000008@140339–145487 (`caption-*` ids) | missing | Reelcut has one style with size, colour, outline, position and font. |
| Per-state styling | Separate text, stroke, box and shadow settings for the spoken word, the other words and the highlighted word (font, weight, size, colour, letter spacing, italic, underline, box padding/colour/radius, shadow). | f_000008@~59900 (`spoken/default/highlight` × `captionText/Stroke/Box/Shadow`) | missing | Karaoke-style word highlighting is the popular look for vlogs. |
| Animation | Entrance animations (dissolve, rise, drop, pop, typewriter, and others), per whole line, each word or each letter, with an easing curve. After a word is spoken it either stays or hides. | f_000008@18553–19091, @61958–62899, @63688 | missing | |
| Emphasis | Key word chosen by keyword, first word, number, last word or by hand. Emphasis styles: bold, serif, marker, glitch, italic. | f_000008@118709–119098 | missing | |
| Case, alignment, position | Case as typed, upper or lower; left, centre or right alignment; position on a 9-point grid. | f_000008@63303–64685 | partial | Reelcut has top, middle or bottom. |
| Speaker-scoped styles | Apply a style to one speaker. Handoff can output one caption track per speaker. | `captionPanel.speakerScope` f_000070@682185; `manhattan.preferences.captionTracksBySpeaker` @516262 | missing | |
| Translation | Adds translated lines beside the originals and edits them; handoff can include original + translation. | `captionPanel.translation.*` f_000070@690167; `handoff.captionOriginalAndTranslation` @514006 | missing | |
| Profanity filter | Profanity option on captions. | `captionPanel.profanity.title` f_000070@670088 | missing | Not needed. |
| Caption SRT export | Saves the captions as SRT. | `manhattan.exportTranscriptDialog.captionSrtFile` @510453 | partial | Reelcut burns captions in (ASS) and computes SRT text but does not save it. |

## 6. Audio

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| Clip gain and fades | Audio gain dialog (dB or %) for one clip, many clips or many resources, with fades. | `audioGainDialog.*` f_000070@1618146; `C_TIMELINE_AUDIO_GAIN` | present | Reelcut has volume (dB shown) and fade in/out per clip. |
| Volume keyframes | A keyed volume line per clip. | `volumeKeys` f_000086@1246515; `recipes/clip-adjustments.md` | missing | Needed for manual ducking and for swelling the music at the end. |
| Audio crossfade | Constant-gain crossfade as an audio transition at a cut. | f_000008@211837 (`constant-gain`) | present | Reelcut's dissolve also adds `acrossfade` (render.rs:759). |
| Noise reduction | "Reduce noise": local ffmpeg high-pass at 90 Hz plus spectral denoise, using a noise profile learned from the quietest stretch. The result is written as a new cleaned resource. | f_000086@1646626–1647100 | partial | Reelcut applies a fixed `afftdn` to the clip at export with no learned profile. |
| Voice enhancement | "Enhance voice": a cloud AI recipe. The result is a new "(enhanced voice)" resource and the transcript is copied onto it. | f_000086@1647296 | missing | Could use a local model (e.g. DeepFilterNet) instead. |
| Per-speaker audio source | Picks which microphone or track is each speaker's main audio and applies the setting to all of that speaker's clips (camera-audio routing). | `manhattan.speakerAudioSettingsPanel.*` f_000070@658322; `audioSelectDialog.speakerMainAudioTitle` f_000071@95110 | missing | |
| Loudness normalisation | No UI. An agent skill can post-process the exported file with two-pass loudnorm at −14 LUFS. | f_00007c (skill text with `loudnorm`) | **R+** | Reelcut has −14 LUFS on export as a checkbox. |
| Ducking | No automatic ducking (volume keys only). | — | **R+** | Reelcut has sidechain ducking of the music under speech at export. |
| Music library | Epidemic Sound and Artlist with the user's own account: browse by genre and BPM, favourites, find similar tracks, **edit a track to a target length**, sound effects, voiceover. | `epidemicSound.*` f_000070@1050753–1051042; `artlist.*` @1017438 | partial | Reelcut uses music the user has imported onto A2. Fitting a song to the video length is missing. |
| Beat sync | Only in the agent SDK and skill (`measureBeatSync`, beat-sync-analysis); there is no UI. | `project.d.ts`; inv-skills | missing | Montages and photo slideshows cut to music. |
| Pitch-preserving speed | Option to preserve audio pitch when the speed changes. | `adjustments.preserveAudioPitch` f_000071@337329; `PitchTempoCapability` chunk | present | Reelcut uses `atempo`, which keeps the pitch, with no option to turn it off. |
| Audio export formats | Exports WAV, AAC, AIFF, MP3 high or MP3 low. | f_00007c@1842444 | partial | Reelcut exports WAV only. |

## 7. Effects, transitions, zoom and speed

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| Effects browser | Categories (filter, effects, zoom, text, sticker, transition) with search, favourites and saved presets ("saved from this project"). Built-in effects run as WGSL shaders on the GPU. | f_000008 catalogue; `effectsBrowser.*`; `adjustments.saveAsPreset` f_000071@316527; `recipes/effect-presets.md` | missing | |
| Looks (filters) | Film stock (named looks), grain & halation, black & white (three variants), VHS / retro, duotone, vignette & light leak, bleach bypass / day for night, bloom (soft focus), posterize / halftone / comic. One filter slot per clip; others stack. | f_000008@149191–152362 | missing | Reelcut has a LUT slot (`.cube`) instead, which Selects lacks (**R+**). |
| Other effects | Camera shake, device frame (browser or phone), progress bar, shape mask (rectangle, circle, split, stars, heart, text). | f_000008@152498–154084 | missing | Shape mask and camera shake fit vlogs. |
| Transitions | 28 picture transitions: dissolve, fade through black, flicker, exposure flash, flare, pans in 4 directions, zoom in/out, spin, shake, stretch, blur, pixel, morph, wipes in 4 directions, clock wipe, circle in/out, reveal, checkerboard. Also custom AI transitions. | f_000008@208393–211722 | partial | Reelcut has a cross-dissolve only. |
| Zoom presets | Punch in, in & out, slow push, instant. Written as transform scale keys. | f_000008@176778–177615 | missing | A slow push or punch-in on photos and talking shots is a cheap win. |
| Transform keyframes | Position, scale, rotation and opacity keys, with a keyframe graph per axis and previous/next key navigation. | `adjustments.keyframeGraph` f_000071@294588, `adjustments.positionAxisGraph`; `generated-media.d.ts` `setClipTransform` keys | missing | Ken Burns on photos. Reelcut keys only the 360 view. |
| Transform basics | Position, scale, rotation, anchor, flip H/V, rotate 90°, crop, opacity. | `adjustments.flipHorizontal` f_000071@302734, `rotateQuarter` @302688; `compileSourceCropPlan` chunk | present | Reelcut has position, scale, rotation, crop and opacity; flip and anchor are missing. |
| Speed | Speed section, rate stretch tool, pitch option. No speed ramps. | `adjustments.sectionSpeed`; f_000086@1484815 | present | Reelcut has 0.1–16× speed. Neither app has ramps. |
| Person matte | Local AI person matte (masks), available to the agent. | `ai.d.ts` `person.matte` | missing | Text behind a person. Low priority. |

## 8. Colour

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| Basic grade | Temperature, tint, exposure, contrast, highlights, shadows, whites, blacks, brightness, clarity, saturation, vibrance, sharpen, noise reduction, fade, vignette, grain. | f_000008@59196 (`basic-adjust` parameters) | partial | Reelcut has exposure, contrast, saturation and temperature only. |
| HSL | Hue, saturation and luminance per colour range. | f_000008@~59100 (`So`), `adjustments.resetHsl` f_000071@213143 | missing | |
| Colour wheels | Shadows, midtones and highlights wheels. | f_000008@23022–23234; `adjustments.resetWheels` f_000071@213929 | missing | |
| Curves | Curves with black and white points and added points. | `adjustments.curves.title` f_000071@297192 | missing | |
| Auto grade | Analyses the footage (skin tones, colourfulness, levels) and sets exposure, white balance, whites, blacks, saturation and vibrance. | f_000008@148250–148959 | missing | High value for mixed phone and 360 footage. |
| Compare with original | Before/after toggle for adjustments. | `adjustments.compareOriginal` f_000071@253514 | missing | |
| LUT | None. | — | **R+** | Reelcut loads `.cube` LUTs (for D-Log M). |

## 9. Titles, graphics and templates

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| Text presets | Plain text, title card (section or chapter), lower third (name on a bar), pull quote, highlight marker (underline or box drawn on), slice-twist title. Each graphic is its own clip on a track, with inspector controls and a picker for the installed fonts. | f_000008@204908–207294; `adjustments.allFonts`, `recentFonts` | missing | Vlog chapter cards and place names. |
| Stickers | Sound word, status badge, watermark or logo, burst (confetti, sparkle, impact), **location pin with place and date**, rating or counter or tally, countdown, seal badge, word sticker. Emoji library by category. | f_000008@172996–176315; f_000071@274143 | missing | The location pin is aimed at vlogs. |
| AI-generated graphics | Describe a graphic and the agent writes it, optionally from a reference image. | `effectsBrowser.addGraphic`, `addReferenceHint`; generated-media.d.ts | missing | |
| MOGRT import | Imports Premiere motion-graphics templates, maps common After Effects effects and warns about missing or unverified fonts. | `effectsBrowser.importMogrt` f_000070@730672; `mogrt.*` @944288; f_000070 (`AE.ADBE …` map) | missing | Not needed. |
| Brand kit / templates | (Clipper) brand with name, logo, font and colours. Templates are layer stacks (captions, text, logo, music, overlay) that can be duplicated, set as default, and exported or imported as packs. | `clipper.brand.*` f_000070@1275110; `clipper.templates.*` @1282380 | missing | A "family channel" template (intro card, caption style, music) would be the personal equivalent. |

## 10. Generation (images, video, voice, narration)

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| Image / video generation | Generate panel with a model picker, reference slots (files or the current frame) and history with reuse and retry. Edit tools for existing video: edit, extend, reframe (change aspect), upscale. Paid credits. | `mediaGeneration.*` f_000070@85249; f_000070 `SP=[edit,extend,reframe,upscale]` | missing | Low priority. AI upscale or outpaint reframe could help old phone clips. |
| Voice / narration (TTS) | Voice library search (Typecast and others), voiceover, speech alignment. | `typecast.*` f_000070@1128179; `mediaGeneration.voice.*` @1128421; `narration.d.ts` | missing | |
| Avatars | Clone an avatar (with consent), looks, voice sample, talking-avatar videos. | `avatars.*` f_000070@54423 | missing | Not wanted. |
| ComfyUI | Runs the user's ComfyUI workflows, with a workflow editor and a button to add results to the timeline. | `comfyui.*` f_000070@1081854 | missing | |
| Stock footage | Artlist footage search. | `artlist.footage.searchLabel` @1017438 | missing | |

## 11. Export

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| Video export | 4K, FHD or HD (SD through the API), frame rate 24/25/30/50/60, fixed H.264 bitrates, AAC 256k, BT.709 tags. GPU compositing when effects are present. | REPORT §3; `manhattan.exportResolutionDialog.*` f_000070@467333 | present | Reelcut adds purpose presets, custom bitrate, a queue, notifications and saved presets (**R+**). |
| High-compression archive | None. | — | **R+** | Reelcut has Shrink-style AV1/HEVC presets. |
| Export a section | Export menu entry for a section. | `manhattan.titlebar.exportMenu.section` @567389 | present | Reelcut can export the in/out range. |
| Audio export | WAV, AAC, AIFF, MP3. | `manhattan.titlebar.exportMenu.audio` @567509 | partial | Reelcut exports WAV only. |
| Transcript / captions export | See §2 and §5. | — | missing | |
| **NLE handoff** | Premiere `.prproj`, Final Cut `.fcpxml`, DaVinci `.drp`, Avid `.aaf`. Options: destination, file name, include the full timeline, preserve cut points, only used audio tracks, nested multicam timeline, enable all angles, captions and chapters (as captions or markers), caption tracks per speaker, maximum caption lines and language, mark bad shots, Premiere file version. Warns about FCP audio-sync risks. | `handoff.*` f_000070@399062–519764; f_000070 (`.prproj`/`.drp`/`.fcpxml`/`.aaf`) | missing | FCPXML or Resolve would let John finish in DaVinci if needed. Medium-low priority. |
| **Social publish** | Uploads directly to YouTube (title, description, tags, category, audience, thumbnail, notify subscribers, synthetic-media flag), TikTok (caption, cover, photo carousel, disclosure, **schedule**) and Instagram (caption, cover, share to feed, collaborators). Batch publishing with progress, and a post history. | `youtube.*` f_000070@474079, `tiktok.schedule.action` @432634, `socialPublish.batch.title` @458227, `socialPosts.title` @394123 | missing | Private family videos would more likely go to a NAS or a shared album. |
| **Short-form clips (Clipper)** | Finds highlight clips in a long video and scores them (with the reasons). Applies a template: reframe as fill (face-follow) or fit (background colour or blur), push-in, captions, titles, filler and silence removal. Runs as a queue that can be resumed. You pick, restyle, export or post clips. | `clipper.*` f_000070@1245085–1304122 | partial | Reelcut has a 9:16 "Shorts" export only, with no highlight finding and no batch of clips. |
| Visual highlights | Builds a highlight cut from visual analysis (for example for talking heads), at a short target length. | `visualHighlights.*` f_000070@1111626, @1553927 | missing | A "best moments of the trip" reel. |
| Project / evaluation bundle | Project archive export; evaluation bundle (internal QA). | @568252 | missing | |

## 12. Settings, shortcuts and app

| Feature | Selects behaviour | Evidence | Reelcut 2.6.0 | Note |
|---|---|---|---|---|
| Keyboard shortcuts | 142 commands. Default layouts follow Premiere, Final Cut or Resolve. You can remap per command with conflict detection and reset. Selects can **import** your existing Premiere `.kys`, FCP `.commandset` or Resolve keyboard preset files. Custom bindings are saved to a JSON file. | f_000086@1481713–1494059 (registry), @1495714 (defaults), @1530466 (cross-app map), @1544578 (file discovery); `shortcut.layout.*` f_00007c@1493484 | partial | Reelcut has about 50 fixed shortcuts and a list window, with no remapping. |
| Appearance | Light/dark mode and an accent ("key") colour. | `preferences.appearance.*` f_00007c@1506585 | missing | Reelcut has a single theme. |
| App language | Language setting. | `appLanguage.title` f_00007c@1509665 | missing | Reelcut is Korean only (fine). |
| Timeline / transcript preferences | Show audio meter, scrub audio, click-to-seek, show topics and subtopics, chapter display mode. | `manhattan.preferences.*` f_000070@374943–377206 | partial | |
| AI connectors | Bring your own Claude, ChatGPT or Gemini; MCP connection for external agents; skills manager; prompt history with favourites. | `preferences.connectors.*` f_00007c@1549193–1549529; `promptHistory.*` f_000070@324191 | present | Reelcut has Claude account or API key, saved prompts and session chats. |
| Notifications, browser, font diagnostics | System notifications, settings for the agent's browser, font diagnose report. | `preferences.*` | partial | Reelcut sends a notification when an export finishes. |
| Undo / redo | Undo and redo; the agent works on a staged working copy that is committed and can be reverted. | f_000086@1483700 | present | |

---

## Most valuable missing features for a personal vlog / 360 family-video editor (most valuable first)

1. **Visual search over footage** (scene search, "find the kids at the beach") using local frame captions or embeddings. The biggest time-saver across hours of family clips.
2. **Automatic person/face detection for 360 follow**, feeding the existing 2.6 view-key path, so the AI no longer has to mark heads by hand on the equirect sheet.
3. **Titles and stickers**: chapter or title card, lower third, and a location/date pin. Today Reelcut cannot put any text on screen except burned-in captions.
4. **Styled, animated captions**: style presets, highlighting the spoken word, per-word entrance animation, emphasised key words, editable caption lines, and SRT saved next to the video.
5. **Transform and opacity keyframes plus zoom presets** (punch-in, slow push, Ken Burns on photos).
6. **Volume keyframes on clips and music, and fitting music to length** (edit a song to the video duration), on top of Reelcut's existing auto-ducking.
7. **Multi-source sync** by audio waveform or timecode for the Osmo 360, phone and mic recordings of the same moment, with a simple 2–4 angle "cut to camera N" multicam.
8. **Auto grade and a fuller colour panel**: tint, highlights and shadows, whites and blacks, vibrance, vignette, HSL or curves, plus a before/after toggle and a few looks (warm film, black and white, bloom). This matches phone and 360 footage that differ in colour.
9. **Bad-shot detection** (blur and shake spans marked in the source or removable), important for handheld and walking 360 footage.
10. **More transitions**: fade through black, wipes, zoom and blur, plus J/L-friendly audio crossfade presets.
11. **Highlight reel builder** (Clipper / visual highlights): pick and score the best moments, then make a short 9:16 or 16:9 recap with a template.
12. **Better voice cleanup**: noise reduction with a learned profile written as a reusable cleaned file, and a local "enhance voice" for wind and room noise.
13. **Transcript tools**: speakers, a proper-noun fixer for family names, split and merge of lines, translation (Korean ↔ English), and export of the transcript as TXT or SRT.
14. **Editing comfort**: copy, paste and paste-attributes (one grade or 360 view onto many clips), disable clip, marker navigation and deletion, relink missing media, and remappable shortcuts with a Premiere or Resolve layout.
15. **Secondary outputs**: FCPXML or Resolve handoff, AAC or MP3 audio export, and still-frame export. Reelcut already leads on 360 stitching, stabilisation and reframing, the LUT slot, J/L detach, loudness and ducking on export, and archive-size encoding.

## 넣지 않기로 한 기능

- 사람 오려내기(person.matte): 모델을 내려받지 않기로 John이 정했습니다(2026-11-04). 2.15.0에 포함하지 않았고, 내려받기 버튼도 두지 않았습니다.
- 인터넷 브라우저, CAPTCHA 풀기, Google·이미지·YouTube 검색, 플러그인 패널과 게시 스킬: Reelcut에 해당 기능이 없어 넣지 않았습니다. CAPTCHA 풀기는 앞으로도 넣지 않습니다.

## 2.16.0에서 맞춘 것

- run_script: TypeScript 스크립트와 Reelcut SDK(`sdk/reelcut.d.ts`). 워커 샌드박스, 시간 제한, 되돌리기 한 번. 스크립트 안에서 내보내기와 지우기는 할 수 없습니다.
- 분석: 소리 크기, 박자, 화면이 바뀌는 곳, 소리 구간. 소리 구간은 크기로만 나눕니다.
