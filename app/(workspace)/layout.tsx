"use client";

import { useState } from "react";
import { brand } from "@/lib/brand";
import { Sidebar } from "@/components/Sidebar";
import { MenuIcon, Sparkle } from "@/components/icons";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <div className="hidden md:flex"><Sidebar /></div>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
        <button onClick={() => setDrawer(true)} aria-label="메뉴 열기" className="-ml-1 rounded p-1.5 hover:bg-surface"><MenuIcon className="h-5 w-5" /></button>
        <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-white"><Sparkle className="h-3.5 w-3.5" /></span>
        <span className="font-semibold">{brand.name}</span>
      </header>
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="animate-fade-up absolute inset-y-0 left-0 bg-background-canvas shadow-xl" onClick={(e) => e.stopPropagation()}>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}
      <main className="min-h-0 w-full flex-1 md:h-full md:p-2">{children}</main>
    </div>
  );
}
