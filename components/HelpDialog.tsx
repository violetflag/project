"use client";

import { Close } from "./icons";

const STEPS: [string, string][] = [
  ["아이디어 적기", "홈에서 만들고 싶은 서비스를 한두 줄로 적어요. 기획 자료가 있으면 파일(txt, md, csv, PDF, 이미지)도 함께 올릴 수 있어요."],
  ["질문에 답하기", "AI가 범위를 좁히는 객관식 질문을 해요. 여러 개를 고르거나 직접 적고 [✓ 선택 완료]를 눌러요. 고르지 않은 보기는 PRD 끝에 '다음 단계 후보'로 남아요."],
  ["PRD → 기능명세서", "[PRD 만들기]로 PRD를 쓰고, [기능명세서 완성하기]로 요구사항 → 기능 → 상세 기능 3단계 명세를 채워요. 항목마다 [보강]과 개발 준비 칸 채우기를 쓸 수 있어요."],
  ["승인하며 다듬기", "AI가 바꾼 내용은 바로 확정되지 않고 '승인 대기'로 쌓여요. 채팅에서 @로 항목을 집어 묻거나 고쳐 달라고 하고, 기능명세서에서 하나씩 또는 한꺼번에 승인해요."],
  ["검토하기", "[검토]는 개발·사업·UX·디자인·QA·보안 여섯 관점에서 빈틈을 예시 상황과 근거와 함께 짚어요. [채팅에서 해결하기]로 해결 방법을 골라 바로 수정안을 받아요."],
  ["플로우와 와이어프레임", "유저플로우와 와이어프레임 탭에서 화면 흐름과 눌러 볼 수 있는 화면을 만들어요. 앞 단계가 바뀌면 탭 점이 주황색이 되고 [동기화]로 반영해요."],
  ["보관하기", "결과물이 생길 때마다 [버전]에 자동 저장돼요. [커스텀]에서 말투·용어·금지 사항을 정하고, [내보내기]로 Markdown·JSON·CSV를 받아요. Shift+1~4로 탭을 바꿀 수 있어요."],
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
