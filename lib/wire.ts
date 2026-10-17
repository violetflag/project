"use client";

// Wireframe tab: generating pages from the user flow (AI or local), syncing with flow changes and editing.

import { josa } from "./josa";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import { ask, prdText, styleOf } from "./ai";
import { uid } from "./id";
import { aiEnabled, withAi } from "./run";
import { specText } from "./spec-model";
import { getProject, updateProject } from "./store";
import { saveToDrive } from "./sync";
import type { Flow, FlowNode, Project, WireEl, WirePage, WireSet } from "./types";
import { autoVersion } from "./versions";
import { hasNav, localPage, navName, navPages, nextPages, pageNodes, relatedFeatures } from "./wire-local";

export { matchPage, navPages, pageNodes } from "./wire-local";

type Device = "mobile" | "desktop";

// --- Pages being drawn right now (for spinners); in memory only -----------------

const drawing = new Set<string>();
let drawingSnap: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const key = (setId: string, nodeId: string) => `${setId}:${nodeId}`;
function setDrawing(setId: string, nodeIds: string[], on: boolean) {
  nodeIds.forEach((n) => (on ? drawing.add(key(setId, n)) : drawing.delete(key(setId, n))));
  drawingSnap = new Set(drawing);
  listeners.forEach((l) => l());
}
export function useDrawing(): ReadonlySet<string> {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => drawingSnap, () => drawingSnap);
}
export const isDrawing = (d: ReadonlySet<string>, setId: string, nodeId: string) => d.has(key(setId, nodeId));

// --- Helpers ------------------------------------------------------------------------

const findFlow = (p: Project, flowId: string) => p.flows.find((f) => f.id === flowId);
const sortPages = (flow: Flow, pages: WirePage[]) => {
  const order = new Map(pageNodes(flow).map((n, i) => [n.id, i]));
  return [...pages].sort((a, b) => (order.get(a.nodeId) ?? 999) - (order.get(b.nodeId) ?? 999));
};

function mapSet(id: string, setId: string, fn: (s: WireSet) => WireSet, log?: string) {
  updateProject(id, (p) => ({ ...p, wires: p.wires.map((s) => (s.id === setId ? fn(s) : s)) }), log);
}
function mapPage(id: string, setId: string, pageId: string, fn: (pg: WirePage) => WirePage) {
  mapSet(id, setId, (s) => ({ ...s, pages: s.pages.map((pg) => (pg.id === pageId ? fn(pg) : pg)) }));
}

// Saves a finished page into the set (replacing an earlier drawing of the same node).
function putPage(id: string, setId: string, node: FlowNode, els: WireEl[]) {
  updateProject(id, (p) => ({
    ...p,
    wires: p.wires.map((s) => {
      if (s.id !== setId) return s;
      const old = s.pages.find((x) => x.nodeId === node.id);
      const page: WirePage = { id: old?.id ?? uid("wp_"), nodeId: node.id, name: node.label, section: node.section, els, at: Date.now() };
      const pages = old ? s.pages.map((x) => (x.id === old.id ? page : x)) : [...s.pages, page];
      const flow = findFlow(p, s.flowId);
      return { ...s, pages: flow ? sortPages(flow, pages) : pages, at: Date.now() };
    }),
  }));
}

// Runs tasks with at most `limit` in flight.
async function pool<T>(items: T[], limit: number, run: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await run(items[i++]);
  }));
}

// --- AI -------------------------------------------------------------------------------

// Flat element schema (one shape for all kinds) keeps the structured output simple; mapped to WireEl below.
const ElSchema = z.object({
  t: z.enum(["bar", "heading", "text", "image", "input", "button", "chips", "card", "list", "rows", "tabs", "nav", "divider"]),
  text: z.string(),
  to: z.string(),
  flag: z.boolean(),
  items: z.array(z.string()),
  pairs: z.array(z.object({ a: z.string(), b: z.string() })),
});
export const PageSchema = z.object({ els: z.array(ElSchema) });

function toEl(x: z.infer<typeof ElSchema>, valid: Set<string>): WireEl {
  const to = valid.has(x.to) ? x.to : undefined;
  const base = { id: uid("e_"), ...(to ? { to } : {}) };
  switch (x.t) {
    case "bar": return { ...base, t: "bar", title: x.text, back: x.flag };
    case "heading": return { ...base, t: "heading", text: x.text };
    case "text": return { ...base, t: "text", text: x.text, muted: x.flag };
    case "image": return { ...base, t: "image", label: x.text, tall: x.flag };
    case "input": return { ...base, t: "input", label: x.text, placeholder: x.items[0] };
    case "button": return { ...base, t: "button", text: x.text, primary: x.flag };
    case "chips": return { ...base, t: "chips", items: x.items };
    case "card": return { ...base, t: "card", title: x.text, lines: x.items, image: x.flag };
    case "list": return { ...base, t: "list", items: x.pairs.map((r) => ({ title: r.a, ...(r.b ? { sub: r.b } : {}) })) };
    case "rows": return { ...base, t: "rows", items: x.pairs.map((r) => ({ label: r.a, value: r.b })) };
    case "tabs": return { ...base, t: "tabs", items: x.items, active: 0 };
    case "nav": return { ...base, t: "nav", items: x.items };
    case "divider": return { ...base, t: "divider" };
  }
}

async function aiPage(p: Project, flow: Flow, node: FlowNode, device: Device, note?: string, request?: string, current?: WireEl[]): Promise<WireEl[]> {
  const pages = pageNodes(flow);
  const next = nextPages(flow, node.id);
  const nav = device === "mobile" && hasNav(flow, node) ? navPages(flow) : [];
  const feats = relatedFeatures(p.spec, `${node.label} ${node.section}`, 8);
  const out = await ask(PageSchema, `서비스 아이디어: ${p.idea}
PRD 요약:
${prdText(p).slice(0, 2500)}
기능명세서:
${specText(p.spec).slice(0, 4000)}
이 페이지와 특히 관련된 기능: ${feats.map((f) => `${f.code} ${f.title}`).join(", ") || "(없음)"}

유저플로우 '${flow.name}'의 페이지 목록 (id: 이름 [구역]):
${pages.map((n) => `${n.id}: ${n.label} [${n.section}]`).join("\n")}

지금 그릴 페이지: ${node.id} '${node.label}' (구역: ${node.section})
이 페이지에서 이어지는 페이지: ${next.map((x) => `${x.node.id} '${x.node.label}'${x.label ? ` (동작: ${x.label})` : ""}`).join(", ") || "(없음)"}
기기: ${device === "mobile" ? "모바일 앱 (폭 360px)" : "데스크톱 웹 (폭 1024px)"}
${nav.length ? `하단 탭 메뉴(nav)를 맨 끝에 넣고, 항목은 모든 페이지에서 똑같이 이 순서로: ${nav.map((n) => navName(n.label)).join(", ")}` : "하단 탭 메뉴(nav)는 넣지 않습니다."}
${note ? `추가 요청: ${note}` : ""}
${current ? `지금 화면 요소(JSON): ${JSON.stringify(current).slice(0, 3000)}\n이 화면을 다음 요청에 맞게 다시 그려 주세요: ${request}` : ""}

이 페이지의 와이어프레임을 화면 요소 목록으로 그려 주세요. 위에서 아래 순서입니다.
- 첫 요소는 상단 바(bar, text=페이지 제목, flag=뒤로 가기 버튼 여부)입니다.
- 요소 종류와 필드: heading(text), text(text, flag=흐린 보조 문구), image(text=무슨 이미지인지, flag=크게), input(text=라벨, items[0]=입력 예시), button(text, flag=주요 버튼), chips(items), card(text=제목, items=줄, flag=썸네일 있음), list(pairs a=제목 b=보조 문구), rows(pairs a=항목 b=값), tabs(items), nav(items), divider.
- 쓰지 않는 필드는 빈 문자열, false, 빈 배열로 둡니다.
- 회색 상자가 아니라 실제 서비스 화면처럼, 이 서비스에 맞는 현실적인 예시 내용(한국 이름, 날짜, 장소, 숫자, 금액)을 채웁니다.
- 버튼, 카드, 목록, 탭 메뉴가 다른 페이지로 이어지면 to에 그 페이지 id를 위 목록에서 골라 넣습니다. 이어지지 않으면 to는 빈 문자열입니다. 이어지는 페이지는 빠짐없이 어딘가에 연결합니다.
- 요소는 8~16개 정도로, 이 페이지의 핵심 기능이 한눈에 보이게 합니다.
${styleOf(p)}`);
  return out.els.map((x) => toEl(x, new Set(pages.map((n) => n.id))));
}

// --- Generate -----------------------------------------------------------------------

export async function generateWires(id: string, opts: { flowId: string; device: Device; nodeIds: string[]; note?: string }) {
  const p0 = getProject(id);
  const flow = p0 && findFlow(p0, opts.flowId);
  if (!p0 || !flow || !opts.nodeIds.length) return;
  // Extend the latest set for this flow+device, or start a new one.
  let set = p0.wires.find((s) => s.flowId === flow.id && s.device === opts.device && s.id === p0.wireId)
    ?? p0.wires.find((s) => s.flowId === flow.id && s.device === opts.device);
  if (!set) {
    set = { id: uid("ws_"), flowId: flow.id, device: opts.device, note: opts.note, pages: [], at: Date.now() };
    const fresh = set;
    updateProject(id, (p) => ({ ...p, wires: [fresh, ...p.wires], wireId: fresh.id }));
  } else {
    const sid = set.id;
    updateProject(id, (p) => ({ ...p, wireId: sid, wires: p.wires.map((s) => (s.id === sid && opts.note ? { ...s, note: opts.note } : s)) }));
  }
  const setId = set.id;
  const nodes = pageNodes(flow).filter((n) => opts.nodeIds.includes(n.id));
  const done = () => {
    setDrawing(setId, nodes.map((n) => n.id), false);
    autoVersion(id, `와이어프레임 ${nodes.length}페이지 생성`);
    saveToDrive();
  };
  const local = () => {
    const p = getProject(id)!;
    const have = new Set(p.wires.find((s) => s.id === setId)?.pages.map((x) => x.nodeId));
    nodes.filter((n) => !have.has(n.id) || drawing.has(key(setId, n.id)))
      .forEach((n) => { putPage(id, setId, n, localPage(p, flow, n, opts.device)); setDrawing(setId, [n.id], false); });
  };

  setDrawing(setId, nodes.map((n) => n.id), true);
  if (!aiEnabled()) {
    local();
    done();
    return;
  }
  let fails = 0, first: unknown;
  let ran = false;
  await withAi(id, `와이어프레임 ${nodes.length}페이지를 그리고 있어요…`, async (p, step) => {
    ran = true;
    let n = 0;
    await pool(nodes, 3, async (node) => {
      let els: WireEl[];
      try {
        els = await aiPage(p, flow, node, opts.device, opts.note);
      } catch (e) {
        fails++; first ??= e;
        els = localPage(getProject(id)!, flow, node, opts.device);
      }
      putPage(id, setId, node, els);
      setDrawing(setId, [node.id], false);
      step(`페이지를 그리고 있어요 ${++n}/${nodes.length}`);
    });
    if (fails === nodes.length) throw first;
  }, local);
  if (!ran) { setDrawing(setId, nodes.map((n) => n.id), false); return; } // another AI job was running
  done();
}

export async function regeneratePage(id: string, setId: string, pageId: string, request: string) {
  const p0 = getProject(id);
  const set = p0?.wires.find((s) => s.id === setId);
  const page = set?.pages.find((x) => x.id === pageId);
  const flow = set && findFlow(p0!, set.flowId);
  const node = flow?.nodes.find((n) => n.id === page?.nodeId);
  if (!p0 || !set || !page || !flow || !node) return;
  const local = () => {
    // Without AI: redraw with other sample data, keeping the request as a note at the top.
    const els = localPage(getProject(id)!, flow, node, set.device, Date.now() % 97);
    if (request.trim()) els.splice(1, 0, { id: uid("e_"), t: "text", text: `요청: ${request.trim()}`, muted: true });
    putPage(id, setId, node, els);
  };
  setDrawing(setId, [node.id], true);
  let ran = !aiEnabled();
  if (ran) local();
  else await withAi(id, `'${node.label}' 페이지를 다시 그리고 있어요…`, async (p, step) => {
    ran = true;
    putPage(id, setId, node, await aiPage(p, flow, node, set.device, set.note, request.trim() || "더 완성도 있게", page.els));
    step("페이지 다시 그림");
  }, local);
  setDrawing(setId, [node.id], false);
  if (!ran) return;
  autoVersion(id, `와이어프레임 '${node.label}' 재생성`);
  saveToDrive();
}

// After the flow changed: drop pages whose node is gone, redraw renamed ones, unlink dead `to`s.
export async function syncWires(id: string): Promise<void> {
  const p = getProject(id);
  if (!p?.stale?.wire) return;
  const redraw: { setId: string; node: FlowNode; device: Device; flow: Flow; els: WireEl[] }[] = [];
  updateProject(id, (x) => ({
    ...x,
    stale: { ...x.stale, wire: false },
    wires: x.wires.map((s) => {
      const flow = findFlow(x, s.flowId);
      if (!flow) return s;
      const live = new Map(pageNodes(flow).map((n) => [n.id, n]));
      const pages = s.pages.filter((pg) => live.has(pg.nodeId)).map((pg) => {
        const node = live.get(pg.nodeId)!;
        const els = pg.els.map((e) => (e.to && !live.has(e.to) ? { ...e, to: undefined } : e)) as WireEl[];
        if (node.label !== pg.name) redraw.push({ setId: s.id, node, device: s.device, flow, els });
        return { ...pg, name: node.label, section: node.section, els };
      });
      return { ...s, pages: sortPages(flow, pages) };
    }),
  }), "와이어프레임을 유저플로우에 맞췄어요");
  for (const r of redraw) {
    setDrawing(r.setId, [r.node.id], true);
    let els: WireEl[] | null = null;
    if (aiEnabled()) {
      try { els = await aiPage(getProject(id)!, r.flow, r.node, r.device, undefined, `페이지 이름이 '${r.node.label}'${josa(r.node.label, "으로/로")} 바뀌었어요. 새 이름에 맞게 고쳐 주세요.`, r.els); } catch { els = null; }
    }
    putPage(id, r.setId, r.node, els ?? localPage(getProject(id)!, r.flow, r.node, r.device));
    setDrawing(r.setId, [r.node.id], false);
  }
  autoVersion(id, redraw.length ? `와이어프레임 동기화 (${redraw.length}페이지 다시 그림)` : "와이어프레임 동기화");
  saveToDrive();
}

// --- Editing ----------------------------------------------------------------------------

export function updateEl(id: string, setId: string, pageId: string, elId: string, patch: Partial<WireEl>) {
  mapPage(id, setId, pageId, (pg) => ({ ...pg, els: pg.els.map((e) => (e.id === elId ? ({ ...e, ...patch } as WireEl) : e)) }));
}
export function deleteEl(id: string, setId: string, pageId: string, elId: string) {
  mapPage(id, setId, pageId, (pg) => ({ ...pg, els: pg.els.filter((e) => e.id !== elId) }));
}
export function moveEl(id: string, setId: string, pageId: string, elId: string, dir: -1 | 1) {
  mapPage(id, setId, pageId, (pg) => {
    const i = pg.els.findIndex((e) => e.id === elId), j = i + dir;
    if (i < 0 || j < 0 || j >= pg.els.length) return pg;
    const els = [...pg.els];
    [els[i], els[j]] = [els[j], els[i]];
    return { ...pg, els };
  });
}
// Undo: put back a snapshot of a page's elements.
export function setPageEls(id: string, setId: string, pageId: string, els: WireEl[]) {
  mapPage(id, setId, pageId, (pg) => ({ ...pg, els }));
}
export function finishEditing(id: string, pageName: string) {
  autoVersion(id, `와이어프레임 '${pageName}' 직접 편집`);
  saveToDrive();
}
export function deleteSet(id: string, setId: string) {
  updateProject(id, (p) => {
    const wires = p.wires.filter((s) => s.id !== setId);
    return { ...p, wires, wireId: p.wireId === setId ? wires[0]?.id : p.wireId };
  }, "와이어프레임을 지웠어요");
  saveToDrive();
}
export function openSet(id: string, setId: string | undefined) {
  updateProject(id, (p) => ({ ...p, wireId: setId }));
}
