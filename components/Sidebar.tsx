"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { EFFORTS, modelLabel, useAiSettings, useApiKey } from "@/lib/ai";
import { brand } from "@/lib/brand";
import { useProjects } from "@/lib/store";
import { AiKeyDialog } from "./AiKeyForm";
import { HelpDialog } from "./HelpDialog";
import { FolderIcon, Gear, HelpIcon, HomeIcon, Plus, Sparkle, TrashIcon } from "./icons";

const itemCls =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm text-foreground hover:bg-border/50 [&_svg]:text-foreground-muted";

function NavLink({ href, label, icon, onNavigate }: { href: string; label: string; icon: React.ReactNode; onNavigate?: () => void }) {
  const active = usePathname().replace(/\/$/, "") === href.replace(/\/$/, "");
  return (
    <Link href={href} onClick={onNavigate} className={`${itemCls} ${active ? "bg-border" : ""}`}>
      {icon}
      <span className="flex-1">{label}</span>
    </Link>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const projects = useProjects().filter((p) => !p.deletedAt);
  const trashed = useProjects().filter((p) => p.deletedAt).length;
  const starred = projects.filter((p) => p.starred);
  const recent = [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const key = useApiKey();
  const ai = useAiSettings();
  const [aiOpen, setAiOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const list = (items: typeof projects) => items.map((p) => (
    <Link key={p.id} href={`/editor?id=${p.id}`} onClick={onNavigate} className={`${itemCls} truncate`}>
      <span className="truncate">{p.starred ? "★ " : ""}{p.name}</span>
    </Link>
  ));
  return (
    <nav className="flex h-full w-70 shrink-0 flex-col gap-2 p-2 pr-0">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-white"><Sparkle className="h-4 w-4" /></span>
        <span className="font-semibold">{brand.name}</span>
      </div>
      <Link href="/" onClick={onNavigate} className="flex items-center justify-center gap-1.5 rounded-md border border-border bg-background py-2 text-sm hover:border-border-strong">
        <Plus /> 새 프로젝트
      </Link>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pt-1">
        <NavLink href="/" label="홈" icon={<HomeIcon />} onNavigate={onNavigate} />
        <NavLink href="/projects" label={`전체 프로젝트 ${projects.length}`} icon={<FolderIcon />} onNavigate={onNavigate} />
        <NavLink href="/archive" label={`휴지통${trashed ? ` ${trashed}` : ""}`} icon={<TrashIcon />} onNavigate={onNavigate} />
        {starred.length > 0 && <p className="mt-4 px-2.5 text-xs font-medium text-foreground-support">즐겨찾기</p>}
        {list(starred)}
        <p className="mt-4 px-2.5 text-xs font-medium text-foreground-support">최근 프로젝트</p>
        {recent.length ? list(recent) : <p className="px-2.5 py-3 text-xs text-foreground-muted">아직 프로젝트가 없어요</p>}
      </div>
      <div className="flex flex-col gap-1 pb-1">
        <button onClick={() => setAiOpen(true)} className="flex w-full items-center gap-3 rounded-md border border-border bg-background px-3 py-2.5 text-left hover:border-border-strong">
          <span className="flex-1">
            <span className="block text-sm font-medium">AI 설정</span>
            <span className="block text-xs text-foreground-muted">
              {key ? `${modelLabel(ai.model)} · 노력 ${EFFORTS.find((e) => e.id === ai.effort)?.label}` : "연결 안 됨 · 기본 생성기 사용 중"}
            </span>
          </span>
          <span className={`h-2 w-2 rounded-full ${key ? "bg-green-500" : "bg-border-strong"}`} />
          <Gear className="h-4 w-4 text-foreground-muted" />
        </button>
        <button onClick={() => setHelp(true)} className={itemCls}><HelpIcon /> 사용 방법</button>
        <p className="px-2.5 text-[11px] text-foreground-assistive">{brand.name} {brand.version}</p>
      </div>
      <AiKeyDialog open={aiOpen} onClose={() => setAiOpen(false)} />
      <HelpDialog open={help} onClose={() => setHelp(false)} />
    </nav>
  );
}
