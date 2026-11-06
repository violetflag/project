"use client";

import { useState } from "react";
import { renew, signIn, syncNow, useSync, useUnsaved } from "@/lib/sync";
import { FloppyIcon } from "./icons";

// Saves to Google Drive by hand. A dot means there are changes Drive doesn't have yet.
export function SaveButton({ label = false }: { label?: boolean }) {
  const s = useSync();
  const unsaved = useUnsaved();
  const [failed, setFailed] = useState("");
  if (s.status === "off") return null;

  const busy = s.status === "syncing";
  const text =
    s.status === "signed-out" ? "구글 로그인하고 저장"
    : s.status === "expired" ? "다시 연결하고 저장"
    : busy ? "저장 중…"
    : s.status === "error" || failed ? "저장 실패 · 다시 시도"
    : unsaved ? "드라이브에 저장"
    : "드라이브에 저장됨";
  const save = async () => {
    setFailed("");
    try {
      if (s.status === "signed-out") return await signIn();
      if (s.status === "expired") await renew();
      await syncNow();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "저장하지 못했어요.");
    }
  };

  return (
    <button onClick={save} disabled={busy} title={failed || text} aria-label={text} data-testid="save-drive"
      className="relative flex shrink-0 items-center gap-1 rounded p-1 text-foreground-muted hover:bg-surface disabled:opacity-60">
      <FloppyIcon className={`h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
      {label && <span className="hidden text-[11px] lg:inline">{text}</span>}
      {(unsaved || s.status === "error" || failed) && !busy && s.status !== "signed-out" && (
        <span className={`absolute left-4 top-0.5 h-1.5 w-1.5 rounded-full ${s.status === "error" || failed ? "bg-red-500" : "bg-amber-400"}`} />
      )}
    </button>
  );
}
