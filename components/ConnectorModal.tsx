"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { brand } from "@/lib/brand";
import { connectorSlides } from "@/lib/mock";
import { ArrowUp, Close, Sparkle } from "./icons";

const Ctx = createContext<() => void>(() => {});
export const useConnectorModal = () => useContext(Ctx);

export function ConnectorModalProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [slide, setSlide] = useState(0);

  // Auto-advances the preview like a carousel while the modal is open.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setSlide((s) => (s + 1) % connectorSlides.length), 3000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => {
      clearInterval(id);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = connectorSlides[slide];

  return (
    <Ctx.Provider value={() => { setSlide(0); setOpen(true); }}>
      {children}
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 backdrop-blur-[1px]" onMouseDown={() => setOpen(false)}>
          <div className="animate-fade-up w-[630px] overflow-hidden rounded-lg bg-background shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="relative bg-surface px-8 pt-12 pb-6">
              <button onClick={() => setOpen(false)} className="absolute top-4 right-4 text-foreground-muted hover:text-foreground" aria-label="닫기">
                <Close />
              </button>
              <div className="mx-auto w-[340px]">
                <p className="mb-2 flex items-center gap-1.5 text-xs text-foreground-support">
                  <Sparkle className="h-3 w-3 text-primary" /> {brand.name} 문서 작성 중...
                </p>
                <div key={slide} className="animate-fade-up rounded-xl border border-border bg-background p-3 shadow-sm">
                  <p className="text-sm leading-relaxed">{current.prompt}</p>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-xs text-foreground-support">{current.source}</span>
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-foreground text-background">
                      <ArrowUp className="h-3 w-3" />
                    </span>
                  </div>
                </div>
              </div>
              <div className="mt-6 flex justify-center gap-1.5">
                {connectorSlides.map((_, i) => (
                  <button key={i} onClick={() => setSlide(i)} aria-label={`${i + 1}번째 예시`}
                    className={`h-1.5 w-1.5 rounded-full ${i === slide ? "bg-foreground-support" : "bg-border-strong"}`} />
                ))}
              </div>
            </div>
            <div className="px-8 py-7 text-center">
              <h2 className="text-lg font-semibold">쓰고 있는 AI 도구와 {brand.name} 연결하기</h2>
              <p className="mt-2 text-sm leading-relaxed text-foreground-support">
                평소 쓰는 AI 대화나 코드 에디터에서 바로 기획 문서를 만들고,<br />
                {brand.name}에 쌓인 문서를 언제든 불러와 활용할 수 있어요.
              </p>
              <button className="mt-5 rounded-md border border-border px-4 py-2 text-sm font-medium hover:border-border-strong">
                연결 시작하기
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
