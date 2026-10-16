"use client";

import { purgeProject, restoreProject, useProjects } from "@/lib/store";

export default function Archive() {
  const trashed = useProjects().filter((p) => p.deletedAt);
  return (
    <section className="flex h-full w-full flex-col rounded-lg bg-background-canvas px-5 py-6">
      <h1 className="text-xl font-semibold">휴지통</h1>
      <p className="mt-6 text-xs text-foreground-assistive">삭제한 프로젝트는 여기서 되살리거나 완전히 지울 수 있어요</p>
      {trashed.length ? (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-background">
          {trashed.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="flex-1 truncate">{p.name}</span>
              <button onClick={() => restoreProject(p.id)} className="text-primary">되살리기</button>
              <button onClick={() => purgeProject(p.id)} className="text-foreground-muted hover:text-red-500">완전히 삭제</button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid flex-1 place-items-center">
          <p className="text-sm text-foreground-support">휴지통이 비어 있어요.</p>
        </div>
      )}
    </section>
  );
}
