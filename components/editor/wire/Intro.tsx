"use client";

// Shown while the first pages of a set are being drawn: three short tips.

import { useEffect, useState } from "react";

const TIPS = [
  { title: "전체 보기", body: "그려진 화면을 구역별로 한눈에 모아 볼 수 있어요. 마음에 드는 화면을 누르면 크게 열려요." },
  { title: "직접 편집", body: "화면 속 요소를 눌러 글자를 바꾸고, 순서를 옮기거나 지울 수 있어요. 실수해도 되돌리기가 있어요." },
  { title: "재생성", body: "한 페이지만 다시 그리고 싶다면 한 줄로 바라는 점을 적어 주세요. 그 페이지만 새로 그려요." },
];

export function Intro() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % TIPS.length), 4000);
    return () => { clearInterval(t); };
  }, []);
  const tip = TIPS[i];
  return (
    <div className="mx-auto w-full max-w-sm rounded-2xl border border-border bg-background p-6 text-center shadow-sm" aria-label="와이어프레임 안내">
      <div className="mx-auto mb-4 h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="mb-1 text-sm text-foreground-muted">화면을 그리는 중이에요. 그동안 알아 두면 좋은 것</p>
      <p key={tip.title} className="animate-fade-up mt-4 text-lg font-semibold">{tip.title}</p>
      <p key={tip.body} className="animate-fade-up mt-1 min-h-[3.5rem] text-sm leading-relaxed text-foreground-support">{tip.body}</p>
      <div className="mt-4 flex items-center justify-center gap-3">
        <button aria-label="이전 안내" onClick={() => setI((i + TIPS.length - 1) % TIPS.length)} className="px-2 text-foreground-muted">‹</button>
        {TIPS.map((t, j) => <button key={t.title} aria-label={`${t.title} 안내`} onClick={() => setI(j)} className={`h-1.5 rounded-full ${j === i ? "w-5 bg-primary" : "w-1.5 bg-border-strong"}`} />)}
        <button aria-label="다음 안내" onClick={() => setI((i + 1) % TIPS.length)} className="px-2 text-foreground-muted">›</button>
      </div>
    </div>
  );
}
