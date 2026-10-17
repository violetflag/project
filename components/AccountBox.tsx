"use client";

import { useState } from "react";
import { renew, signIn, signOut, syncNow, useSync } from "@/lib/sync";

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? "방금" : `${Math.round(s / 60)}분 전`;
};

// Google sign-in, shown at the bottom of the sidebar.
export function AccountBox() {
  const s = useSync();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  if (s.status === "off") return null;

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  if (s.status === "signed-out") {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-2.5">
        <button onClick={run(signIn)} disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border py-2 text-sm hover:border-border-strong disabled:opacity-50">
          <GoogleMark /> {busy ? "로그인 중…" : "구글로 로그인"}
        </button>
        <p className="mt-1.5 text-[11px] leading-relaxed text-foreground-muted">로그인하면 휴대폰과 노트북에서 같은 프로젝트와 API 키를 써요.</p>
        {msg && <p className="mt-1 text-[11px] text-red-600">{msg}</p>}
      </div>
    );
  }

  const { user } = s;
  const line = {
    syncing: "동기화 중…",
    synced: s.status === "synced" ? `동기화됨 · ${ago(s.at)}` : "",
    expired: "로그인 연장이 필요해요",
    error: s.status === "error" ? s.message : "",
  }[s.status];
  const dot = { syncing: "bg-amber-400", synced: "bg-green-500", expired: "bg-amber-400", error: "bg-red-500" }[s.status];

  return (
    <div className="rounded-md border border-border bg-background px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary text-xs text-white">{(user.name || user.email || "?").slice(0, 1).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{user.email || user.name}</span>
          <span className="flex items-center gap-1.5 text-[11px] text-foreground-muted"><span className={`h-1.5 w-1.5 rounded-full ${dot}`} />{line}</span>
        </span>
      </div>
      <div className="mt-2 flex gap-1.5 text-xs">
        {s.status === "expired" ? (
          <button onClick={run(renew)} disabled={busy} className="flex-1 rounded-md bg-primary py-1.5 text-white disabled:opacity-50">다시 연결</button>
        ) : (
          <button onClick={run(syncNow)} disabled={busy || s.status === "syncing"} className="flex-1 rounded-md border border-border py-1.5 hover:border-border-strong disabled:opacity-50">지금 동기화</button>
        )}
        <button onClick={run(signOut)} disabled={busy} className="flex-1 rounded-md border border-border py-1.5 hover:border-border-strong disabled:opacity-50">로그아웃</button>
      </div>
      {msg && <p className="mt-1 text-[11px] text-red-600">{msg}</p>}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}
