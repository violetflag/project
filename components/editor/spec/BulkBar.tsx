"use client";

import { bulkDeleteSpec, bulkUpdateSpec } from "@/lib/spec";
import { STATUS_LABEL, type Status } from "@/lib/types";

// Shown while several spec items are picked (Shift-click or a drag box on the graph).
export function BulkBar({ pid, ids, onClear }: { pid: string; ids: string[]; onClear: () => void }) {
  if (!ids.length) return null;
  const sel = "rounded border border-border bg-background px-1.5 py-1 text-xs";
  return (
    <div role="toolbar" aria-label="선택한 항목 한번에 바꾸기"
      className="animate-fade-up absolute top-3 left-1/2 z-30 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2 text-xs shadow-lg">
      <span className="font-medium">{ids.length}개 선택</span>
      <select value="" onChange={(e) => e.target.value && bulkUpdateSpec(pid, ids, { status: e.target.value as Status })} aria-label="선택 항목 상태 바꾸기" className={sel}>
        <option value="">상태 바꾸기</option>
        {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <select value="" onChange={(e) => e.target.value && bulkUpdateSpec(pid, ids, { priority: Number(e.target.value) as 1 | 2 | 3 })} aria-label="선택 항목 중요도 바꾸기" className={sel}>
        <option value="">중요도 바꾸기</option><option value="3">높음</option><option value="2">보통</option><option value="1">낮음</option>
      </select>
      <button onClick={() => bulkUpdateSpec(pid, ids, { starred: true })} aria-label="선택 항목 즐겨찾기" className="rounded px-1.5 py-1 text-amber-500 hover:bg-surface">★</button>
      <button onClick={() => { if (confirm(`선택한 ${ids.length}개 항목과 그 하위 항목을 지울까요? ⌘Z로 되돌릴 수 있어요.`)) { bulkDeleteSpec(pid, ids); onClear(); } }}
        aria-label="선택 항목 삭제" className="rounded px-1.5 py-1 text-red-500 hover:bg-surface">삭제</button>
      <button onClick={onClear} aria-label="선택 해제" className="rounded px-1.5 py-1 text-foreground-muted hover:bg-surface">선택 해제</button>
    </div>
  );
}
