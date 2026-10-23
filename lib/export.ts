import { flatten, LEVEL_LABEL, numbering } from "./spec-model";
import { SLOTS, STATUS_LABEL } from "./types";
import type { Flow, Project, SpecItem, WireEl, WireSet } from "./types";
import { saveBlob } from "./diagram-png";
import { xlsxBytes, type Sheet } from "./xlsx";

export function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[\\/:*?"<>|]/g, "_");
  // Some browsers (iOS Safari, older Chrome) ignore the file name on a detached link.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const PRIORITY = { 3: "높음", 2: "보통", 1: "낮음" } as const;
const KIND_LABEL = { start: "시작", page: "페이지", data: "데이터", branch: "분기", action: "행동" } as const;

export const currentFlow = (p: Project) => p.flows.find((f) => f.id === p.flowId) ?? p.flows[p.flows.length - 1];
export const currentWires = (p: Project) => p.wires.find((w) => w.id === p.wireId) ?? p.wires[0];

function specMarkdown(items: SpecItem[]) {
  const num = numbering(items);
  const out: string[] = [];
  flatten(items).filter((x) => x.pending?.kind !== "new").forEach((x) => {
    out.push(`${"#".repeat(x.level + 2)} ${num[x.id]} [${x.code}] ${x.title}`, "");
    out.push(`*${LEVEL_LABEL[x.level]} · ${STATUS_LABEL[x.status]} · 중요도 ${PRIORITY[x.priority]}${x.roles.length ? ` · ${x.roles.join(", ")}` : ""}*`, "");
    if (x.summary) out.push(x.summary, "");
    if (x.rationale) out.push(`- 근거: ${x.rationale}`);
    if (x.success) out.push(`- 성공 기준: ${x.success}`);
    if (x.rationale || x.success) out.push("");
    if (x.criteria?.length) out.push("**수용 기준**", "", ...x.criteria.map((c) => `- [ ] ${c}`), "");
    const slots = SLOTS.filter(([k]) => !x.offSlots?.includes(k) && x.slots?.[k]?.some((s) => s.trim()));
    if (slots.length) {
      out.push("**개발 준비**", "", "| 항목 | 내용 |", "|---|---|");
      slots.forEach(([k, label]) => out.push(`| ${label} | ${x.slots![k]!.filter((s) => s.trim()).join("<br>").replace(/\|/g, "\\|")} |`));
      out.push("");
    }
  });
  return out;
}

const mid = (id: string) => id.replace(/[^A-Za-z0-9_]/g, "_");
const mlabel = (s: string) => s.replace(/["\[\]{}()<>|]/g, " ").trim() || " ";

export function flowMermaid(f: Flow) {
  const shape = (k: keyof typeof KIND_LABEL, l: string) => {
    const t = `"${mlabel(l)}"`;
    return k === "start" ? `([${t}])` : k === "data" ? `[/${t}/]` : k === "branch" ? `{${t}}` : k === "action" ? `((${t}))` : `[${t}]`;
  };
  const out = ["flowchart TD"];
  f.sections.forEach((s, i) => {
    out.push(`  subgraph S${i}["${mlabel(s)}"]`);
    f.nodes.filter((n) => n.section === s).forEach((n) => out.push(`    ${mid(n.id)}${shape(n.kind, n.label)}`));
    out.push("  end");
  });
  f.nodes.filter((n) => !f.sections.includes(n.section)).forEach((n) => out.push(`  ${mid(n.id)}${shape(n.kind, n.label)}`));
  f.edges.forEach((e) => out.push(`  ${mid(e.from)} -->${e.label ? `|"${mlabel(e.label)}"|` : ""} ${mid(e.to)}`));
  return out.join("\n");
}

function flowList(f: Flow) {
  const name = (id: string) => f.nodes.find((n) => n.id === id)?.label ?? "?";
  const out: string[] = [];
  f.sections.forEach((s) => {
    out.push(`#### ${s}`, "");
    f.nodes.filter((n) => n.section === s).forEach((n) => {
      out.push(`- (${KIND_LABEL[n.kind]}) ${n.label}`);
      f.edges.filter((e) => e.from === n.id).forEach((e) => out.push(`  - → ${name(e.to)}${e.label ? ` (${e.label})` : ""}`));
    });
    out.push("");
  });
  return out;
}

// One line per wireframe element, so a reader (or another AI) can rebuild the screen.
function wireLine(e: WireEl, link: (id?: string) => string) {
  const to = link(e.to);
  switch (e.t) {
    case "bar": return `상단바: ${e.title}${e.back ? " (뒤로가기)" : ""}${to}`;
    case "heading": return `제목: ${e.text}${to}`;
    case "text": return `${e.muted ? "보조 문구" : "문구"}: ${e.text}${to}`;
    case "image": return `이미지: ${e.label}${to}`;
    case "input": return `입력: ${e.label}${e.placeholder ? ` (예: ${e.placeholder})` : ""}${to}`;
    case "button": return `${e.primary ? "주 버튼" : "버튼"}: ${e.text}${to}`;
    case "chips": return `칩: ${e.items.join(" · ")}${to}`;
    case "card": return `카드: ${e.title}${e.lines.length ? ` — ${e.lines.join(" / ")}` : ""}${to}`;
    case "list": return `목록: ${e.items.map((x) => x.title + (x.sub ? ` (${x.sub})` : "")).join(" · ")}${to}`;
    case "rows": return `정보: ${e.items.map((x) => `${x.label} ${x.value}`).join(" · ")}${to}`;
    case "tabs": return `탭: ${e.items.join(" · ")}${to}`;
    case "nav": return `하단 메뉴: ${e.items.join(" · ")}${to}`;
    case "divider": return "구분선";
  }
}

const wireLinker = (w: WireSet) => {
  const names = new Map(w.pages.map((x) => [x.nodeId, x.name]));
  return (id?: string) => (id && names.has(id) ? ` → ${names.get(id)}` : "");
};

export interface ExportOptions { mermaid?: boolean }

export function toMarkdown(p: Project, opts: ExportOptions = {}) {
  const out: string[] = [`# ${p.name}`, "", `> ${p.idea}`, ""];
  if (p.prd) {
    out.push("## PRD", "");
    if (p.prdProps) {
      out.push(`- 카테고리: ${p.prdProps.category}`, `- 사용자 역할: ${p.prdProps.roles.join(", ")}`, `- 기기: ${p.prdProps.devices.join(", ")}`, "");
    }
    p.prd.forEach((s) => {
      out.push(`### ${s.title}`, "");
      s.blocks.forEach((b) => out.push(`**${b.label}**`, "", b.body, ""));
    });
  }
  if (p.spec?.length) {
    out.push("## 기능명세서", "");
    out.push(...specMarkdown(p.spec));
  }
  const f = currentFlow(p);
  if (f) {
    out.push(`## 유저플로우 — ${f.name}`, "");
    if (opts.mermaid) out.push("```mermaid", flowMermaid(f), "```", "");
    else out.push(...flowList(f));
  }
  const w = currentWires(p);
  if (w) {
    out.push(`## 와이어프레임 (${w.device === "mobile" ? "모바일" : "데스크톱"}, ${w.pages.length}페이지)`, "");
    const link = wireLinker(w);
    const sections = [...new Set(w.pages.map((x) => x.section))];
    sections.forEach((s) => {
      out.push(`### ${s}`, "");
      w.pages.filter((x) => x.section === s).forEach((x) => {
        out.push(`#### ${x.name}`, "", ...x.els.map((e) => `- ${wireLine(e, link)}`), "");
      });
    });
  }
  return out.join("\n");
}

// Deliverables only, in a shape other tools can read.
export function toDeliverablesJson(p: Project) {
  const strip = (x: SpecItem): unknown => ({
    code: x.code, level: LEVEL_LABEL[x.level], title: x.title, summary: x.summary, rationale: x.rationale, success: x.success,
    criteria: x.criteria ?? [], roles: x.roles, status: STATUS_LABEL[x.status], priority: PRIORITY[x.priority],
    slots: Object.fromEntries(SLOTS.filter(([k]) => x.slots?.[k]?.length && !x.offSlots?.includes(k)).map(([k, l]) => [l, x.slots![k]])),
    children: x.children.filter((c) => c.pending?.kind !== "new").map(strip),
  });
  const f = currentFlow(p);
  const w = currentWires(p);
  const link = w ? wireLinker(w) : () => "";
  return JSON.stringify({
    name: p.name, idea: p.idea, prd: p.prd, prdProps: p.prdProps,
    spec: (p.spec ?? []).filter((x) => x.pending?.kind !== "new").map(strip),
    flow: f ? { name: f.name, sections: f.sections, nodes: f.nodes, edges: f.edges, mermaid: flowMermaid(f) } : null,
    wireframe: w ? { device: w.device, pages: w.pages.map((x) => ({ name: x.name, section: x.section, nodeId: x.nodeId, elements: x.els.map((e) => wireLine(e, link)) })) } : null,
  }, null, 2);
}

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;

export function exportMarkdown(p: Project, opts: ExportOptions = {}) {
  download(`${p.name}.md`, toMarkdown(p, opts), "text/markdown");
}

function specRows(p: Project) {
  const num = numbering(p.spec ?? []);
  const rows = [["번호", "코드", "단계", "이름", "설명", "역할", "중요도", "상태", "수용 기준", ...SLOTS.map(([, l]) => l)]];
  flatten(p.spec).filter((x) => x.pending?.kind !== "new").forEach((x) => rows.push([
    num[x.id], x.code, LEVEL_LABEL[x.level], x.title, x.summary, x.roles.join(", "), PRIORITY[x.priority], STATUS_LABEL[x.status],
    (x.criteria ?? []).join(" / "), ...SLOTS.map(([k]) => (x.slots?.[k] ?? []).join(" / ")),
  ]));
  return rows;
}

export function exportCsv(p: Project) {
  // BOM so Excel opens Korean text correctly.
  download(`${p.name}-기능명세서.csv`, "\ufeff" + specRows(p).map((r) => r.map(csvCell).join(",")).join("\n"), "text/csv");
}

// The sheets of the .xlsx export: the spec, then the open user flow and wireframe screens if any.
export function workbook(p: Project): Sheet[] {
  const sheets: Sheet[] = [{ name: "기능명세서", rows: specRows(p), widths: [8, 10, 8, 24, 40, 14, 8, 12, 40, ...SLOTS.map(() => 30)] }];
  const f = currentFlow(p);
  if (f) {
    const name = (id: string) => f.nodes.find((n) => n.id === id)?.label ?? "?";
    sheets.push({
      name: "유저플로우", widths: [18, 8, 28, 50],
      rows: [["구역", "종류", "이름", "다음 (연결 라벨)"], ...f.nodes.map((n) => [n.section, KIND_LABEL[n.kind], n.label,
        f.edges.filter((e) => e.from === n.id).map((e) => `${name(e.to)}${e.label ? ` (${e.label})` : ""}`).join("\n")])],
    });
  }
  const w = currentWires(p);
  if (w?.pages.length) {
    const link = wireLinker(w);
    sheets.push({
      name: "와이어프레임", widths: [22, 18, 70],
      rows: [["화면", "구역", "구성 요소"], ...w.pages.map((pg) => [pg.name, pg.section ?? "", pg.els.map((e) => wireLine(e, link)).join("\n")])],
    });
  }
  return sheets;
}

export function exportXlsx(p: Project) {
  const bytes = xlsxBytes(workbook(p));
  saveBlob(`${p.name}-기획서.xlsx`, new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}

export function exportDeliverables(p: Project) {
  download(`${p.name}-기획서.json`, toDeliverablesJson(p), "application/json");
}

export function exportJson(p: Project) {
  download(`${p.name}.json`, JSON.stringify(p, null, 2), "application/json");
}
