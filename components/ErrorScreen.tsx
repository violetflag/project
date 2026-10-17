"use client";

import { useEffect } from "react";

// After a new deploy, a page cached by the browser can ask for script files
// that no longer exist. Reloading once fetches the current version.
const STALE = /ChunkLoadError|Loading (CSS )?chunk|dynamically imported module|Importing a module script failed/i;
const FLAG = "planspace.reloadedForChunk";

export function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = STALE.test(`${error.name} ${error.message}`);
  useEffect(() => {
    console.error(error);
    if (!stale) return;
    try {
      // Reload at most once every 30 seconds so a real outage can't loop.
      if (Date.now() - Number(sessionStorage.getItem(FLAG) ?? 0) < 30000) return;
      sessionStorage.setItem(FLAG, String(Date.now()));
    } catch {
      return;
    }
    location.reload();
  }, [error, stale]);

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-6">
      <div className="w-full max-w-sm text-center">
        <p className="text-lg font-semibold">화면을 불러오다 문제가 생겼어요</p>
        <p className="mt-2 text-sm text-foreground-support">
          {stale ? "새 버전이 올라와서 생긴 일이에요. 새로고침하면 해결돼요." : "작업한 내용은 브라우저에 그대로 저장돼 있어요."}
        </p>
        <p className="mt-3 rounded-md bg-surface px-3 py-2 text-left text-xs break-all text-foreground-muted">{error.message || "알 수 없는 오류"}</p>
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={() => location.reload()} className="rounded-md bg-primary px-4 py-2 text-sm text-white">새로고침</button>
          {!stale && <button onClick={reset} className="rounded-md border border-border px-4 py-2 text-sm">다시 시도</button>}
          <a href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`} className="rounded-md border border-border px-4 py-2 text-sm">홈으로</a>
        </div>
      </div>
    </div>
  );
}
