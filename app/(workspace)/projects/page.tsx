"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Close } from "@/components/icons";
import { duplicateProject, folderNames, importProject, moveProjects, trashProjects, updateProject, useProjects } from "@/lib/store";
import type { Project } from "@/lib/types";

const fmt = (t: number) => new Date(t).toLocaleDateString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

function stage(p: Project) {
  if (p.wires?.length) return "와이어프레임";
  if (p.flows?.length) return "유저플로우";
  if (p.spec?.length) return "기능명세서";
  if (p.prd) return "PRD";
  return "질문 중";
}

// "" = every project, NONE = projects outside any folder, anything else = that folder.
const NONE = "\u0000none";

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:px-4" onClick={onClose}>
      <div className="animate-fade-up max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-background p-5 shadow-xl sm:max-w-[400px] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label={label}>
        <div className="mb-3 flex items-center">
          <h2 className="flex-1 font-semibold">{label}</h2>
          <button onClick={onClose} aria-label="닫기" className="p-1 text-foreground-muted hover:text-foreground"><Close className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function MoveDialog({ folders, count, onMove, onClose }: { folders: string[]; count: number; onMove: (f: string | undefined) => void; onClose: () => void }) {
  const [pick, setPick] = useState<string>(folders.length ? folders[0] : "\u0000new");
  const [name, setName] = useState("");
  const isNew = pick === "\u0000new";
  const ok = !isNew || name.trim().length > 0;
  const radio = (value: string, label: string) => (
    <label key={value} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface">
      <input type="radio" name="folder" checked={pick === value} onChange={() => setPick(value)} className="accent-[var(--color-primary)]" />
      {label}
    </label>
  );
  return (
    <Sheet label="폴더로 이동" onClose={onClose}>
      <p className="mb-2 text-xs text-foreground-support">선택한 프로젝트 {count}개를 옮길 곳을 고르세요.</p>
      <div className="space-y-0.5">
        {folders.map((f) => radio(f, f))}
        {radio(NONE, "폴더에서 빼기")}
        {radio("\u0000new", "새 폴더")}
      </div>
      {isNew && (
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="새 폴더 이름" aria-label="새 폴더 이름" maxLength={40}
          onKeyDown={(e) => { if (e.key === "Enter" && ok) onMove(name); }}
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary" />
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm">취소</button>
        <button disabled={!ok} onClick={() => onMove(isNew ? name : pick === NONE ? undefined : pick)}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-40">이동</button>
      </div>
    </Sheet>
  );
}

export default function Projects() {
  const router = useRouter();
  const all = useProjects().filter((p) => !p.deletedAt);
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<"move" | "delete" | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const folders = folderNames(all);
  const inFolder = (p: Project, f: string) => (f === "" ? true : f === NONE ? !p.folder : p.folder === f);
  const projects = all
    .filter((p) => inFolder(p, folder))
    .filter((p) => !q || p.name.includes(q) || p.idea.includes(q))
    .sort((a, b) => (sort === "recent" ? b.updatedAt - a.updatedAt : a.name.localeCompare(b.name, "ko")));
  // Only what is on screen counts as selected, so a hidden project is never deleted by surprise.
  const chosen = projects.filter((p) => picked.has(p.id)).map((p) => p.id);
  const allChosen = projects.length > 0 && chosen.length === projects.length;

  useEffect(() => {
    if (folder && folder !== NONE && !folders.includes(folder)) setFolder("");
  }, [folder, folders]);

  const onImport = async (f?: File) => {
    if (!f) return;
    try {
      const p = importProject(await f.text());
      router.push(`/editor?id=${p.id}`);
    } catch (e) {
      setNote(e instanceof SyntaxError ? "JSON 파일을 읽지 못했어요." : e instanceof Error ? e.message : "불러오지 못했어요.");
    }
  };
  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const setEdit = (on: boolean) => { setEditing(on); setPicked(new Set()); setNote(""); };
  const done = (text: string) => { setPicked(new Set()); setDialog(null); setNote(text); };
  const duplicate = () => {
    chosen.forEach((id) => duplicateProject(id));
    done(`프로젝트 ${chosen.length}개를 복제했어요.`);
  };
  const move = (f: string | undefined) => {
    moveProjects(chosen, f);
    done(f?.trim() ? `프로젝트 ${chosen.length}개를 '${f.trim()}' 폴더로 옮겼어요.` : `프로젝트 ${chosen.length}개를 폴더에서 뺐어요.`);
  };
  const remove = () => {
    trashProjects(chosen);
    done(`프로젝트 ${chosen.length}개를 휴지통으로 옮겼어요. 휴지통에서 되살릴 수 있어요.`);
  };

  const chip = (value: string, label: string, n: number) => (
    <button key={value || "all"} onClick={() => setFolder(value)} aria-pressed={folder === value}
      className={`shrink-0 rounded-full border px-3 py-1 text-xs ${folder === value ? "border-foreground bg-foreground text-background" : "border-border bg-background text-foreground-support hover:border-border-strong"}`}>
      {label} <span className="opacity-60">{n}</span>
    </button>
  );
  const act = "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs hover:border-border-strong disabled:opacity-40 disabled:hover:border-border";

  return (
    <section className="flex h-full w-full flex-col overflow-y-auto bg-background-canvas px-4 py-5 md:rounded-lg md:px-6 md:py-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold md:text-xl">전체 프로젝트</h1>
        <button onClick={() => file.current?.click()} className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm hover:border-border-strong md:px-3">JSON 불러오기</button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => { onImport(e.target.files?.[0]); e.target.value = ""; }} />
        <Link href="/" className="rounded-md bg-foreground px-2.5 py-1.5 text-sm text-background md:px-3">새 프로젝트</Link>
      </div>
      {all.length > 0 && (
        <div className="mt-4 flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름·아이디어 찾기"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary" />
          <select value={sort} onChange={(e) => setSort(e.target.value as "recent" | "name")} aria-label="정렬"
            className="rounded-md border border-border bg-background px-2 text-sm">
            <option value="recent">최근 수정 순</option><option value="name">이름 순</option>
          </select>
          <button onClick={() => setEdit(!editing)} aria-pressed={editing}
            className={`shrink-0 rounded-md border px-3 py-1.5 text-sm ${editing ? "border-primary bg-primary text-white" : "border-border bg-background hover:border-border-strong"}`}>
            {editing ? "완료" : "편집"}
          </button>
        </div>
      )}
      {folders.length > 0 && (
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="폴더">
          {chip("", "전체", all.length)}
          {folders.map((f) => chip(f, f, all.filter((p) => p.folder === f).length))}
          {chip(NONE, "폴더 없음", all.filter((p) => !p.folder).length)}
        </div>
      )}
      {editing && (
        <div className="sticky top-0 z-10 -mx-1 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 shadow-sm" role="toolbar" aria-label="편집 도구">
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={allChosen} disabled={!projects.length} aria-label="전체 선택"
              onChange={() => setPicked(allChosen ? new Set() : new Set(projects.map((p) => p.id)))} className="h-4 w-4 accent-[var(--color-primary)]" />
            {chosen.length ? `${chosen.length}개 선택됨` : "전체 선택"}
          </label>
          <div className="ml-auto flex gap-1.5">
            <button disabled={!chosen.length} onClick={duplicate} className={act}>복제</button>
            <button disabled={!chosen.length} onClick={() => setDialog("move")} className={act}>폴더 이동</button>
            <button disabled={!chosen.length} onClick={() => setDialog("delete")} className={`${act} text-red-600`}>삭제</button>
          </div>
        </div>
      )}
      {note && <p className={`mt-2 text-xs ${editing ? "text-foreground-support" : "text-red-600"}`} role="status">{note}</p>}
      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {projects.map((p) => {
          const on = picked.has(p.id);
          const body = (
            <>
              <p className="truncate font-medium">{p.name}</p>
              <p className="mt-1 line-clamp-2 text-xs text-foreground-support">{p.idea}</p>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-foreground-muted">
                <span className="rounded bg-primary-soft px-1.5 py-0.5 text-primary">{stage(p)}</span>
                {p.folder && folder === "" && <span className="rounded border border-border px-1.5 py-0.5">📁 {p.folder}</span>}
                <span>{fmt(p.updatedAt)}</span>
              </div>
            </>
          );
          return editing ? (
            <button key={p.id} onClick={() => toggle(p.id)} aria-pressed={on} aria-label={`${p.name} 선택`}
              className={`relative rounded-lg border bg-background p-4 pl-11 text-left ${on ? "border-primary ring-1 ring-primary" : "border-border hover:border-border-strong"}`}>
              <span className={`absolute top-4 left-4 grid h-4.5 w-4.5 place-items-center rounded border text-[11px] text-white ${on ? "border-primary bg-primary" : "border-border-strong bg-background"}`} aria-hidden>{on ? "✓" : ""}</span>
              {body}
            </button>
          ) : (
            <div key={p.id} className="relative rounded-lg border border-border bg-background p-4 hover:border-border-strong">
              <Link href={`/editor?id=${p.id}`} className="block pr-8">{body}</Link>
              <button onClick={() => updateProject(p.id, (x) => ({ ...x, starred: !x.starred }))}
                className={`absolute top-3 right-3 rounded px-1.5 text-base ${p.starred ? "text-amber-500" : "text-foreground-muted"}`}
                aria-label={p.starred ? `${p.name} 즐겨찾기 해제` : `${p.name} 즐겨찾기`}>★</button>
            </div>
          );
        })}
      </div>
      {!all.length && <p className="mt-20 text-center text-sm text-foreground-support">아직 프로젝트가 없어요. 홈에서 아이디어를 적어 시작하세요.</p>}
      {all.length > 0 && !projects.length && <p className="mt-10 text-center text-sm text-foreground-support">찾는 프로젝트가 없어요.</p>}
      {dialog === "move" && <MoveDialog folders={folders} count={chosen.length} onMove={move} onClose={() => setDialog(null)} />}
      {dialog === "delete" && (
        <Sheet label="프로젝트 삭제" onClose={() => setDialog(null)}>
          <p className="text-sm">선택한 프로젝트 {chosen.length}개를 휴지통으로 옮길까요?</p>
          <p className="mt-1 text-xs text-foreground-support">휴지통에서 다시 되살릴 수 있어요.</p>
          <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-xs text-foreground-support">
            {projects.filter((p) => picked.has(p.id)).map((p) => <li key={p.id} className="truncate">· {p.name}</li>)}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setDialog(null)} className="rounded-md border border-border px-3 py-1.5 text-sm">취소</button>
            <button onClick={remove} className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white">휴지통으로 옮기기</button>
          </div>
        </Sheet>
      )}
    </section>
  );
}
