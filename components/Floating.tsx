import { Chat } from "./icons";

export function FloatingButtons() {
  return (
    <div className="fixed right-6 bottom-6 z-20 flex items-center gap-2">
      <button className="h-12 rounded-full border border-border bg-background px-4 text-[15px] font-medium text-primary hover:border-border-strong">
        사용 가이드
      </button>
      <button aria-label="문의하기" className="grid h-12 w-12 place-items-center rounded-full border border-border bg-background text-primary hover:border-border-strong">
        <Chat className="h-5 w-5" />
      </button>
    </div>
  );
}
