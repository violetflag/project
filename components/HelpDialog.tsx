"use client";

import { Close } from "./icons";

const STEPS: [string, string][] = [
  ["아이디어 적기", "홈에서 만들고 싶은 서비스를 한두 줄로 적고 보내요. 자료가 있으면 [내 자료로 시작]에서 파일(txt, md, csv, PDF, 이미지)을 함께 올려요."],
  ["질문에 답하기", "AI가 범위를 좁히는 질문을 해요. 선택지를 고르거나 직접 적고 [✓ 선택 완료]를 눌러요."],
  ["PRD 만들기", "[바로 PRD 만들기]를 누르면 PRD와 기능명세서 초안이 함께 생겨요."],
  ["다듬기", "채팅으로 \"OO 기능 추가해줘\", \"기획 검토해줘\"처럼 요청해요. AI가 만든 수정안은 [✓ 승인]해야 반영돼요."],
  ["그림 만들기", "[유저플로우]와 [와이어프레임] 탭에서 버튼 하나로 화면 흐름과 화면 뼈대를 그려요."],
  ["보관하기", "모든 내용은 이 브라우저에 자동 저장돼요. [내보내기]로 Markdown, CSV, JSON 파일을 받아 두고, JSON은 [전체 프로젝트]에서 다시 불러올 수 있어요."],
];

export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:px-4" onClick={onClose}>
      <div className="animate-fade-up max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-background p-5 shadow-xl sm:max-w-[480px] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label="사용 방법">
        <div className="mb-4 flex items-center">
          <h2 className="flex-1 font-semibold">사용 방법</h2>
          <button onClick={onClose} aria-label="닫기" className="p-1 text-foreground-muted hover:text-foreground"><Close className="h-4 w-4" /></button>
        </div>
        <ol className="space-y-3">
          {STEPS.map(([t, d], i) => (
            <li key={t} className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-medium text-primary">{i + 1}</span>
              <span>
                <span className="block text-sm font-medium">{t}</span>
                <span className="block text-xs leading-relaxed text-foreground-support">{d}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
