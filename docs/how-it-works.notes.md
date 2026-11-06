# how-it-works 순서도 메모

다음에 그림을 고칠 때 단계별로 볼 파일입니다.

| 단계 | 파일 · 함수 |
|---|---|
| 홈 입력, 프로젝트 만들기 | `components/PromptBox.tsx` → `lib/store.ts` `createProject` |
| AI 엔진 고르기 (키 확인, 실패 시 대체) | `lib/actions.ts` `withAi`, `aiEnabled` / `lib/ai.ts` `ask`, `describeError` |
| Claude 호출 | `lib/ai.ts` (`aiQuestions`, `aiSummary`, `aiPlan`, `aiReview`, `aiChoices`, `aiApplyChoice`, `aiChat`) |
| 로컬 생성기 | `lib/generator.ts` (`makeQuestions`, `makePrd`, `makeFeatures`, `runReview`, `interpret`) |
| 질문 받기 | `lib/actions.ts` `initQuestions`, `answerQuestion`, `addMoreQuestions` / `components/editor/ChatPanel.tsx` |
| 기획서 만들기 | `lib/actions.ts` `generatePrd` / `components/editor/PrdView.tsx`, `FeaturesView.tsx` |
| 다듬기 (채팅, 검토, 수정안) | `lib/actions.ts` `sendChat`, `review`, `discussFinding`, `pickChoice`, `resolvePending` / `components/editor/SidePanels.tsx` |
| 그림 만들기 | `lib/generator.ts` `makeFlow`, `makeScreens` / `FlowView.tsx`, `WireframeView.tsx` |
| 저장, 공유 | `lib/store.ts` (localStorage `planspace.projects.v1`) / `lib/export.ts` / `ShareDialog.tsx` |
| API 키 입력 | `components/AiKeyForm.tsx` (localStorage `planspace.anthropic.key`) |

그림에서 뺀 것: 모든 변경은 브라우저 localStorage에 자동 저장되고, 버전·코멘트·회의록(기획실)은 왼쪽 메뉴에서 따로 관리됩니다.
