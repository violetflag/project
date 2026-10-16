"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { brand } from "@/lib/brand";
import { patchNotes } from "@/lib/mock";
import { useDismiss } from "./Popover";
import { useConnectorModal } from "./ConnectorModal";
import {
  BellIcon, BoardIcon, Card, ChevronDown, FolderIcon, Gear, HomeIcon, LockIcon,
  Megaphone, PlugIcon, Plus, Sparkle, TrashIcon, UserPlus,
} from "./icons";

const itemCls =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm text-foreground hover:bg-border/50 [&_svg]:text-foreground-muted";

function NavLink({ href, label, icon }: { href: string; label: string; icon: React.ReactNode }) {
  const active = usePathname() === href;
  return (
    <Link href={href} className={`${itemCls} ${active ? "bg-border" : ""}`}>
      {icon}
      <span>{label}</span>
    </Link>
  );
}

function LockedItem({ label, icon, hint }: { label: string; icon: React.ReactNode; hint: string }) {
  return (
    <div title={hint} aria-disabled className={`${itemCls} cursor-not-allowed opacity-40 hover:bg-transparent`}>
      {icon}
      <span className="flex-1">{label}</span>
      <LockIcon />
    </div>
  );
}

function GroupMenu() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-md border border-border bg-background px-2.5 py-2.5 text-left hover:border-border-strong"
      >
        <span className="grid h-7 w-7 place-items-center rounded-md bg-avatar text-xs font-semibold text-white">
          {brand.user[0]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{brand.group}</span>
          <span className="block truncate text-xs text-foreground-muted">{brand.plan} 플랜 · 멤버 1명</span>
        </span>
        <ChevronDown className="h-4 w-4 text-foreground-muted" />
      </button>
      {open && (
        <div className="animate-fade-up absolute top-full right-0 left-0 z-30 mt-1 rounded-lg border border-border bg-background p-1.5 shadow-lg">
          <button className="flex w-full items-center gap-2 rounded-md border border-primary/30 bg-primary-soft px-2.5 py-1.5 text-sm font-medium text-primary">
            <Sparkle className="h-3.5 w-3.5" /> 플랜 업그레이드
          </button>
          {[
            [<Gear key="g" />, "그룹 설정"],
            [<UserPlus key="u" />, "멤버 초대"],
            [<Card key="c" />, "결제 관리"],
          ].map(([icon, label]) => (
            <button key={label as string} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-foreground-support hover:bg-border/50 [&_svg]:text-foreground-muted">
              {icon}
              {label}
            </button>
          ))}
          <div className="my-1.5 border-t border-border" />
          <p className="px-2.5 py-1 text-xs text-foreground-muted">내 그룹</p>
          <div className="flex items-center gap-2 rounded-md border border-primary/40 px-2.5 py-1.5 text-sm">
            <span className="grid h-5 w-5 place-items-center rounded bg-avatar text-[10px] font-semibold text-white">{brand.user[0]}</span>
            <span className="flex-1">{brand.group}</span>
            <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary">{brand.plan}</span>
          </div>
          <button className="mt-1 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-foreground-support hover:bg-border/50">
            <Plus /> 새 그룹 만들기
          </button>
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className={`${itemCls} ${open ? "bg-border" : ""}`}>
        <BellIcon />
        <span>알림함</span>
      </button>
      {open && (
        <div className="animate-fade-up absolute top-0 left-full z-30 ml-3 w-80 rounded-lg border border-border bg-background p-3 shadow-lg">
          <div className="flex items-center justify-between">
            <button className="flex items-center gap-1 text-sm font-medium">
              모든 그룹 <ChevronDown className="h-3.5 w-3.5 text-foreground-muted" />
            </button>
            <button className="text-xs text-foreground-support hover:text-foreground">모두 읽음</button>
          </div>
          <p className="py-6 text-center text-xs text-foreground-muted">새 알림이 없어요</p>
        </div>
      )}
    </div>
  );
}

function PatchNotes() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      {!open && (
        <span className="absolute -top-9 left-1/3 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground-support shadow-sm">
          새 소식이 있어요!
        </span>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-md border border-border bg-background px-3 py-3 text-left hover:border-border-strong"
      >
        <span className="flex-1">
          <span className="block text-sm font-medium">업데이트 소식</span>
          <span className="block text-xs text-foreground-muted">최근 변경 사항을 확인하세요</span>
        </span>
        <span className="relative grid h-8 w-8 place-items-center rounded-md border border-border text-foreground-support">
          <Megaphone />
          <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
      </button>
      {open && (
        <div className="animate-fade-up absolute bottom-0 left-full z-30 ml-3 max-h-72 w-64 overflow-y-auto rounded-lg border border-border bg-background shadow-lg">
          {patchNotes.map((n) => (
            <div key={n.title} className="border-b border-border px-3 py-3 last:border-0 hover:bg-surface">
              <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] text-primary">{n.tag}</span>
              <p className="mt-1.5 text-sm">{n.title}</p>
              <p className="mt-0.5 text-xs text-foreground-muted">{n.date}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const openConnectors = useConnectorModal();
  return (
    <nav className="flex h-full w-70 shrink-0 flex-col gap-2 p-2 pr-0">
      <GroupMenu />
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pt-1">
        <NavLink href="/" label="홈" icon={<HomeIcon />} />
        <LockedItem label="전체 프로젝트" icon={<FolderIcon />} hint="프로젝트를 만들면 열려요" />
        <LockedItem label="기획 보드" icon={<BoardIcon />} hint="프로젝트를 만들면 열려요" />
        <button onClick={openConnectors} className={itemCls}>
          <PlugIcon />
          <span>연결</span>
        </button>
        <NavLink href="/archive" label="휴지통" icon={<TrashIcon />} />
        <div className="h-3" />
        <Notifications />
        <p className="mt-4 px-2.5 text-xs font-medium text-foreground-support">즐겨찾기</p>
        <p className="py-6 text-center text-xs text-foreground-muted">아직 즐겨찾은 프로젝트가 없어요</p>
      </div>
      <div className="flex flex-col gap-2">
        <PatchNotes />
        <button className="flex w-full items-center gap-3 rounded-md border border-primary/30 bg-background bg-gradient-to-b from-primary/[0.03] to-primary/[0.03] px-3 py-3 text-left hover:border-primary/50">
          <span className="flex-1">
            <span className="block text-sm font-medium text-primary">플랜 업그레이드</span>
            <span className="block text-xs text-foreground-muted">팀 협업과 넉넉한 사용량</span>
          </span>
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary-soft text-primary">
            <Sparkle />
          </span>
        </button>
        <button className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-background-canvas">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-foreground-support text-[10px] text-white">
            {brand.user[0]}
          </span>
          {brand.user}
        </button>
      </div>
    </nav>
  );
}
