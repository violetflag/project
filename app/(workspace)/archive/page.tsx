"use client";

import { useState } from "react";
import { deleteBinary } from "@/lib/files";
import { purgeProject, restoreProject, useProjects } from "@/lib/store";

export default function Archive() {
  const trashed = useProjects().filter((p) => p.deletedAt);
  // Permanent delete takes a second tap so a stray click can't lose a project.
  const [arm, setArm] = useState<string | null>(null);
  const purge = (id: string) => {
    purgeProject(id);
    deleteBinary(id);
    setArm(null);
  };
  return (
    <section className="flex h-full w-full flex-col bg-background-canvas px-4 py-5 md:rounded-lg md:px-5 md:py-6">
      <h1 className="text-xl font-semibold">휴지통</h1>
      <p className="mt-2 text-xs text-foreground-assistive">삭제한 프로젝트는 여기서 되살리거나 완전히 지울 수 있어요</p>
      {trashed.length ? (
        <>
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-background">
            {trashed.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <button onClick={() => restoreProject(p.id)} className="text-primary">되살리기</button>
                <button onClick={() => (arm === p.id ? purge(p.id) : setArm(p.id))}
                  className={arm === p.id ? "font-medium text-red-600" : "text-foreground-muted hover:text-red-500"}>
                  {arm === p.id ? "한 번 더 누르면 완전히 삭제" : "완전히 삭제"}
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => (arm === "all" ? (trashed.forEach((p) => purge(p.id)), setArm(null)) : setArm("all"))}
            className={`mt-3 self-end text-xs ${arm === "all" ? "font-medium text-red-600" : "text-foreground-muted hover:text-red-500"}`}>
            {arm === "all" ? "한 번 더 누르면 모두 삭제" : "휴지통 비우기"}
          </button>
        </>
      ) : (
        <div className="grid flex-1 place-items-center">
          <p className="text-sm text-foreground-support">휴지통이 비어 있어요.</p>
        </div>
      )}
    </section>
  );
}
