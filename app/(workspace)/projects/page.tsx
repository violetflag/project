"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { importProject, trashProject, updateProject, useProjects } from "@/lib/store";

const fmt = (t: number) => new Date(t).toLocaleDateString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

function stage(p: ReturnType<typeof useProjects>[number]) {
  if (p.screens) return "와이어프레임";
  if (p.flow) return "유저플로우";
  if (p.groups) return "기능명세서";
  if (p.prd) return "PRD";
  return "질문 중";
}

export default function Projects() {
  const router = useRouter();
  const all = useProjects().filter((p) => !p.deletedAt);
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const projects = all
    .filter((p) => !q || p.name.includes(q) || p.idea.includes(q))
    .sort((a, b) => (sort === "recent" ? b.updatedAt - a.updatedAt : a.name.localeCompare(b.name, "ko")));

  const onImport = async (f?: File) => {
    if (!f) return;
    try {
      const p = importProject(await f.text());
      router.push(`/editor?id=${p.id}`);
    } catch (e) {
      setNote(e instanceof SyntaxError ? "JSON 파일을 읽지 못했어요." : e instanceof Error ? e.message : "불러오지 못했어요.");
    }
  };

  return (
    <section className="flex h-full w-full flex-col overflow-y-auto bg-background-canvas px-4 py-5 md:rounded-lg md:px-6 md:py-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">전체 프로젝트</h1>
        <button onClick={() => file.current?.click()} className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:border-border-strong">JSON 불러오기</button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => { onImport(e.target.files?.[0]); e.target.value = ""; }} />
        <Link href="/" className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background">새 프로젝트</Link>
      </div>
      {note && <p className="mt-2 text-xs text-red-600">{note}</p>}
      {all.length > 0 && (
        <div className="mt-4 flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름이나 아이디어로 찾기"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary" />
          <select value={sort} onChange={(e) => setSort(e.target.value as "recent" | "name")} aria-label="정렬"
            className="rounded-md border border-border bg-background px-2 text-sm">
            <option value="recent">최근 수정 순</option><option value="name">이름 순</option>
          </select>
        </div>
      )}
      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {projects.map((p) => (
          <div key={p.id} className="group relative rounded-lg border border-border bg-background p-4 hover:border-border-strong">
            <Link href={`/editor?id=${p.id}`} className="block pr-16">
              <p className="truncate font-medium">{p.name}</p>
              <p className="mt-1 line-clamp-2 text-xs text-foreground-support">{p.idea}</p>
              <div className="mt-4 flex items-center gap-2 text-[11px] text-foreground-muted">
                <span className="rounded bg-primary-soft px-1.5 py-0.5 text-primary">{stage(p)}</span>
                <span>{fmt(p.updatedAt)}</span>
              </div>
            </Link>
            <div className="absolute top-3 right-3 flex gap-1 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
              <button onClick={() => updateProject(p.id, (x) => ({ ...x, starred: !x.starred }))}
                className={`rounded px-1.5 text-base ${p.starred ? "text-amber-500" : "text-foreground-muted"}`} aria-label={p.starred ? "즐겨찾기 해제" : "즐겨찾기"}>★</button>
              <button onClick={() => trashProject(p.id)} className="rounded px-1.5 text-xs text-foreground-muted hover:text-red-500">삭제</button>
            </div>
          </div>
        ))}
      </div>
      {!all.length && <p className="mt-20 text-center text-sm text-foreground-support">아직 프로젝트가 없어요. 홈에서 아이디어를 적어 시작하세요.</p>}
      {all.length > 0 && !projects.length && <p className="mt-10 text-center text-sm text-foreground-support">찾는 프로젝트가 없어요.</p>}
    </section>
  );
}
