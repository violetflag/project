"use client";

// Draws one wireframe page as a grey-scale app screen inside a phone or browser frame.

import type { CSSProperties, ReactNode } from "react";
import { matchPage } from "@/lib/wire";
import type { FlowNode, WireEl } from "@/lib/types";

export const FRAME = { mobile: { w: 360, h: 740 }, desktop: { w: 1024, h: 700 } } as const;

type Props = {
  els: WireEl[];
  device: "mobile" | "desktop";
  pages: FlowNode[]; // flow page nodes, for nav items that open a page by name
  zoom?: number;
  editing?: boolean;
  selected?: string | null;
  onSelect?: (elId: string) => void;
  onOpen?: (nodeId: string) => void;
  still?: boolean; // thumbnail: no interaction
};

const ImgIcon = ({ className = "h-6 w-6" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m3 18 6-5 4 3 3-2 5 4" />
  </svg>
);

export function Screen({ els, device, pages, zoom = 1, editing, selected, onSelect, onOpen, still }: Props) {
  const desk = device === "desktop";
  const nav = els.find((e) => e.t === "nav") as Extract<WireEl, { t: "nav" }> | undefined;
  const bar = desk ? (els.find((e) => e.t === "bar") as Extract<WireEl, { t: "bar" }> | undefined) : undefined;
  const body = els.filter((e) => e !== nav && e !== bar);

  // Click target for the whole element (prototype) or selection (editing).
  const wrap = (e: WireEl, node: ReactNode, cls = "") => {
    const link = !editing && e.to;
    const sel = editing && selected === e.id;
    return (
      <div key={e.id} data-el={e.id}
        onClick={still ? undefined : (ev) => {
          if (editing) { ev.stopPropagation(); onSelect?.(e.id); }
          else if (e.to) onOpen?.(e.to);
        }}
        className={`${cls} relative ${link && !still ? "cursor-pointer hover:outline hover:outline-1 hover:outline-dashed hover:outline-[#999]" : ""} ${editing && !still ? "cursor-pointer hover:outline hover:outline-1 hover:outline-[#845dde]/60" : ""} ${sel ? "outline outline-2 outline-[#845dde] -outline-offset-1" : ""}`}>
        {node}
      </div>
    );
  };
  const itemOpen = (target?: string) => (ev: React.MouseEvent) => {
    if (editing || still || !target) return;
    ev.stopPropagation();
    onOpen?.(target);
  };

  const render = (e: WireEl): ReactNode => {
    switch (e.t) {
      case "bar": return wrap(e, (
        <div className="flex h-12 items-center gap-2 border-b border-[#e6e6e6] bg-white px-3">
          <span className="w-6 text-xl leading-none text-[#555]">{e.back ? "‹" : ""}</span>
          <span className="flex-1 truncate text-center text-[15px] font-semibold text-[#222]">{e.title}</span>
          <span className="flex w-6 justify-end"><span className="h-4 w-4 rounded-full border-[1.5px] border-[#999]" /></span>
        </div>
      ), "sticky top-0 z-10");
      case "heading": return wrap(e, <p className={`px-4 pt-3 font-bold text-[#222] ${desk ? "text-2xl" : "text-[19px] leading-snug"}`}>{e.text}</p>);
      case "text": return wrap(e, <p className={`px-4 text-[13px] leading-relaxed ${e.muted ? "text-[#8a8a8a]" : "text-[#444]"}`}>{e.text}</p>);
      case "image": return wrap(e, (
        <div className={`mx-4 flex flex-col items-center justify-center gap-1.5 rounded-xl bg-[#e9e9e9] text-[#9a9a9a] ${e.tall ? (desk ? "h-72" : "h-56") : desk ? "h-44" : "h-32"}`}>
          <ImgIcon /><span className="px-3 text-center text-[11px]">{e.label}</span>
        </div>
      ));
      case "input": return wrap(e, (
        <div className="px-4">
          {e.label && <p className="mb-1 text-[12px] font-medium text-[#555]">{e.label}</p>}
          <div className="flex h-10 items-center rounded-lg border border-[#d6d6d6] bg-white px-3 text-[13px] text-[#a5a5a5]">{e.placeholder || " "}</div>
        </div>
      ));
      case "button": return wrap(e, (
        <div className={`${desk ? "" : "mx-4"} flex h-11 items-center justify-center rounded-lg px-5 text-[14px] font-semibold ${e.primary ? "bg-[#333] text-white" : "border border-[#cfcfcf] bg-white text-[#333]"}`}>{e.text}</div>
      ));
      case "chips": return wrap(e, (
        <div className="flex gap-1.5 overflow-hidden px-4">
          {e.items.map((c, i) => <span key={i} className={`shrink-0 rounded-full px-3 py-1 text-[12px] ${i === 0 ? "bg-[#333] text-white" : "border border-[#d6d6d6] bg-white text-[#555]"}`}>{c}</span>)}
        </div>
      ));
      case "card": return wrap(e, desk ? (
        <div className="overflow-hidden rounded-xl border border-[#e2e2e2] bg-white">
          {e.image && <div className="flex h-28 items-center justify-center bg-[#e9e9e9] text-[#a5a5a5]"><ImgIcon /></div>}
          <div className="p-3"><p className="truncate text-[14px] font-semibold text-[#222]">{e.title}</p>
            {e.lines.map((l, i) => <p key={i} className="truncate text-[12px] text-[#8a8a8a]">{l}</p>)}</div>
        </div>
      ) : (
        <div className="mx-4 flex gap-3 rounded-xl border border-[#e2e2e2] bg-white p-3">
          {e.image && <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-[#e9e9e9] text-[#a5a5a5]"><ImgIcon className="h-5 w-5" /></div>}
          <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-semibold text-[#222]">{e.title}</p>
            {e.lines.map((l, i) => <p key={i} className="truncate text-[12px] text-[#8a8a8a]">{l}</p>)}</div>
        </div>
      ));
      case "list": return wrap(e, (
        <div className="divide-y divide-[#eee] border-y border-[#eee] bg-white">
          {e.items.map((it, i) => {
            const target = e.to ?? matchPage(it.title, pages)?.id;
            return (
              <div key={i} onClick={itemOpen(target)} className={`flex items-center gap-3 px-4 py-3 ${target && !editing && !still ? "cursor-pointer hover:bg-[#f6f6f6]" : ""}`}>
                <div className="min-w-0 flex-1"><p className="truncate text-[14px] text-[#222]">{it.title}</p>{it.sub && <p className="truncate text-[12px] text-[#999]">{it.sub}</p>}</div>
                <span className="text-[#bbb]">›</span>
              </div>
            );
          })}
        </div>
      ));
      case "rows": return wrap(e, (
        <div className="mx-4 space-y-2 rounded-xl bg-[#f3f3f3] p-3.5">
          {e.items.map((r, i) => <div key={i} className="flex justify-between gap-3 text-[13px]"><span className="shrink-0 text-[#8a8a8a]">{r.label}</span><span className="truncate text-right text-[#333]">{r.value}</span></div>)}
        </div>
      ));
      case "tabs": return wrap(e, (
        <div className="flex border-b border-[#e6e6e6] bg-white">
          {e.items.map((t, i) => <span key={i} className={`flex-1 py-2.5 text-center text-[13px] ${i === (e.active ?? 0) ? "border-b-2 border-[#333] font-semibold text-[#222]" : "text-[#999]"}`}>{t}</span>)}
        </div>
      ));
      case "nav": return null;
      case "divider": return wrap(e, <div className="my-1 h-2 bg-[#f1f1f1]" />);
    }
  };

  // Desktop: rows of cards become a grid, runs of buttons sit side by side.
  const blocks: ReactNode[] = [];
  for (let i = 0; i < body.length; i++) {
    const e = body[i];
    if (desk && (e.t === "card" || e.t === "button")) {
      const run: WireEl[] = [e];
      while (body[i + 1]?.t === e.t) run.push(body[++i]);
      blocks.push(<div key={e.id} className={e.t === "card" ? "grid grid-cols-3 gap-3 px-4" : "flex flex-wrap gap-2 px-4"}>{run.map(render)}</div>);
    } else blocks.push(render(e));
  }

  const navBar = nav && wrap(nav, (
    <div className={desk ? "flex gap-5" : "grid border-t border-[#e6e6e6] bg-white pb-2 pt-1.5"} style={desk ? undefined : { gridTemplateColumns: `repeat(${nav.items.length}, 1fr)` }}>
      {nav.items.map((it, i) => {
        const target = matchPage(it, pages)?.id ?? nav.to;
        const on = i === nav.active;
        return (
          <div key={i} onClick={itemOpen(target)} className={`flex ${desk ? "" : "flex-col"} items-center gap-0.5 ${target && !editing && !still ? "cursor-pointer" : ""} ${on ? "font-semibold text-[#222]" : "text-[#9a9a9a]"}`}>
            {!desk && <span className={`h-5 w-5 rounded-md ${on ? "bg-[#333]" : "border-[1.5px] border-[#b5b5b5]"}`} />}
            <span className={desk ? "text-[13px]" : "max-w-full truncate text-[10px]"}>{it}</span>
          </div>
        );
      })}
    </div>
  ));

  const frameStyle: CSSProperties = { zoom };
  if (desk) return (
    <div style={frameStyle} className="w-[1024px] overflow-hidden rounded-xl border border-[#cfcfcf] bg-white shadow-sm">
      <div className="flex h-9 items-center gap-1.5 border-b border-[#e3e3e3] bg-[#f3f3f3] px-3">
        {[0, 1, 2].map((i) => <span key={i} className="h-2.5 w-2.5 rounded-full bg-[#cfcfcf]" />)}
        <span className="mx-auto h-5 w-80 rounded bg-white" />
      </div>
      <div className="flex h-14 items-center gap-6 border-b border-[#e6e6e6] px-6">
        {bar ? wrap(bar, <span className="text-[16px] font-bold text-[#222]">{bar.title}</span>) : <span className="h-4 w-20 rounded bg-[#ddd]" />}
        <div className="ml-auto">{navBar}</div>
        <span className="h-7 w-7 rounded-full bg-[#e3e3e3]" />
      </div>
      <div className="mx-auto flex min-h-[600px] max-w-[800px] flex-col gap-3 py-6">{blocks}</div>
    </div>
  );
  return (
    <div style={frameStyle} className="w-[360px] shrink-0 rounded-[34px] border-[9px] border-[#2b2b2b] bg-[#2b2b2b] shadow-md">
      <div className="flex h-[722px] flex-col overflow-hidden rounded-[26px] bg-white">
        <div className="flex h-6 shrink-0 items-center justify-between px-5 text-[10px] font-semibold text-[#333]"><span>9:41</span><span className="h-2 w-6 rounded-sm bg-[#333]" /></div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-4 [scrollbar-width:none]">{blocks}</div>
        {navBar}
      </div>
    </div>
  );
}
