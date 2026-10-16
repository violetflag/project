"use client";

import Link from "next/link";
import { trashProject, updateProject, useProjects } from "@/lib/store";

const fmt = (t: number) => new Date(t).toLocaleDateString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

function stage(p: ReturnType<typeof useProjects>[number]) {
  if (p.screens) return "와이어프레임";
  if (p.flow) return "유저플로우";
  if (p.groups) return "기능명세서";
  if (p.prd) return "PRD";
  return "질문 중";
}

export default function Projects() {
  const projects = useProjects().filter((p) => !p.deletedAt);
  return (
    <section className="flex h-full w-full flex-col overflow-y-auto rounded-lg bg-background-canvas px-6 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">전체 프로젝트</h1>
        <Link href="/" className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background">새 프로젝트</Link>
      </div>
      <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {projects.map((p) => (
          <div key={p.id} className="group relative rounded-lg border border-border bg-background p-4 hover:border-border-strong">
            <Link href={`/editor?id=${p.id}`} className="block">
              <p className="truncate font-medium">{p.name}</p>
              <p className="mt-1 line-clamp-2 text-xs text-foreground-support">{p.idea}</p>
              <div className="mt-4 flex items-center gap-2 text-[11px] text-foreground-muted">
                <span className="rounded bg-primary-soft px-1.5 py-0.5 text-primary">{stage(p)}</span>
                <span>{fmt(p.updatedAt)}</span>
              </div>
            </Link>
            <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100">
              <button onClick={() => updateProject(p.id, (x) => ({ ...x, starred: !x.starred }))}
                className={`rounded px-1.5 text-sm ${p.starred ? "text-amber-500" : "text-foreground-muted"}`} aria-label="즐겨찾기">★</button>
              <button onClick={() => trashProject(p.id)} className="rounded px-1.5 text-xs text-foreground-muted hover:text-red-500">삭제</button>
            </div>
          </div>
        ))}
      </div>
      {!projects.length && <p className="mt-20 text-center text-sm text-foreground-support">아직 프로젝트가 없어요. 홈에서 아이디어를 적어 시작하세요.</p>}
    </section>
  );
}
