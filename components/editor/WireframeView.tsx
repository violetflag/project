"use client";

import { useState } from "react";
import { generateScreens } from "@/lib/actions";
import type { Project, WireBlock } from "@/lib/types";
import { EmptyDoc } from "./PrdView";

function Block({ b }: { b: WireBlock }) {
  switch (b.type) {
    case "header": return <p className="mb-4 text-base font-semibold">{b.text}</p>;
    case "input": return <label className="mb-3 block text-[11px] text-foreground-support">{b.label}<span className="mt-1 block h-8 rounded border border-border bg-background" /></label>;
    case "select": return <label className="mb-3 block text-[11px] text-foreground-support">{b.label}<span className="mt-1 flex h-8 items-center justify-end rounded border border-border bg-background px-2">▾</span></label>;
    case "list": return <ul className="mb-3 space-y-1">{b.items.map((i) => <li key={i} className="rounded border border-border px-2 py-1.5 text-xs">{i}</li>)}</ul>;
    case "tabs": return <div className="mb-3 flex gap-1">{b.items.map((t, i) => <span key={t} className={`rounded px-2 py-1 text-[11px] ${i === 0 ? "bg-foreground text-background" : "border border-border"}`}>{t}</span>)}</div>;
    case "card": return (
      <div className="mb-3 rounded-lg border border-border p-3">
        <p className="mb-1 text-xs font-medium">{b.title}</p>
        {b.lines.map((l) => <p key={l} className="text-[11px] text-foreground-muted">{l}</p>)}
      </div>
    );
    case "button": return <span className={`mb-2 block rounded py-2 text-center text-xs ${b.primary ? "bg-foreground text-background" : "border border-border"}`}>{b.text}</span>;
  }
}

export function WireframeView({ p }: { p: Project }) {
  const [i, setI] = useState(0);
  if (!p.groups) return <EmptyDoc title="와이어프레임이 여기에 생겨요" hint="기능명세서가 있어야 화면 시안을 만들 수 있어요." />;
  if (!p.screens) return (
    <EmptyDoc title="아직 와이어프레임이 없어요" hint="주요 기능마다 화면 시안을 흑백으로 그려 드려요."
      action={<button onClick={() => generateScreens(p.id)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">와이어프레임 만들기</button>} />
  );
  const s = p.screens[Math.min(i, p.screens.length - 1)];
  return (
    <div className="flex h-full">
      <aside className="w-52 shrink-0 overflow-y-auto border-r border-border bg-background px-2 py-3">
        <p className="mb-2 px-2 text-xs text-foreground-muted">화면 {p.screens.length}개</p>
        {p.screens.map((x, j) => (
          <button key={x.id} onClick={() => setI(j)} className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${j === i ? "bg-surface font-medium" : "text-foreground-support hover:bg-surface"}`}>{x.name}</button>
        ))}
        <button onClick={() => generateScreens(p.id)} className="mt-3 px-2 text-xs text-primary">다시 만들기</button>
      </aside>
      <div className="flex-1 overflow-auto bg-background-canvas p-8">
        <p className="mb-3 text-xs text-foreground-muted">{s.name}</p>
        <div className="mx-auto flex max-w-4xl gap-6 rounded-xl border border-border bg-background p-8 grayscale">
          <div className="flex-1">{s.main.map((b, k) => <Block key={k} b={b} />)}</div>
          <div className="w-56">{s.side.map((b, k) => <Block key={k} b={b} />)}</div>
        </div>
      </div>
    </div>
  );
}
