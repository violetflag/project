"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { trashProject, updateProject } from "@/lib/store";
import type { Project } from "@/lib/types";
import { Close } from "../icons";

const fmt = (t: number) => new Date(t).toLocaleString("ko-KR", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// Project settings: title, the idea it started from, dates, and moving it to the trash.
export function ProjectInfo({ p, onClose }: { p: Project; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(p.name);
  const [idea, setIdea] = useState(p.idea);
  const save = () => {
    updateProject(p.id, (x) => ({ ...x, name: name.trim() || x.name, idea: idea.trim() || x.idea }));
  };
  const close = () => { save(); onClose(); };
  const trash = () => {
    trashProject(p.id);
    router.push("/projects/");
  };
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={close} aria-hidden />
      <div role="dialog" aria-label="프로젝트 정보" className="fixed inset-x-3 top-16 z-40 mx-auto max-w-md rounded-xl border border-border bg-background p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-medium">프로젝트 정보</p>
          <button onClick={close} aria-label="닫기" className="p-1"><Close className="h-3.5 w-3.5 text-foreground-muted" /></button>
        </div>
        <label className="block text-xs text-foreground-muted">
          제목
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary" />
        </label>
        <label className="mt-3 block text-xs text-foreground-muted">
          처음 적은 아이디어
          <textarea value={idea} onChange={(e) => setIdea(e.target.value)} onBlur={save} rows={3}
            className="mt-1 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary" />
        </label>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-foreground-support">
          <dt className="text-foreground-muted">만든 날짜</dt><dd>{fmt(p.createdAt)}</dd>
          <dt className="text-foreground-muted">마지막 수정</dt><dd>{fmt(p.updatedAt)}</dd>
        </dl>
        <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
          <button onClick={trash} className="rounded-md px-3 py-1.5 text-sm text-red-600 hover:bg-surface">휴지통으로 이동</button>
          <button onClick={close} className="rounded-md bg-primary px-4 py-1.5 text-sm text-white">완료</button>
        </div>
      </div>
    </>
  );
}
