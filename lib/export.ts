import type { Project } from "./types";

function download(name: string, text: string, type: string) {
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

export function toMarkdown(p: Project) {
  const out: string[] = [`# ${p.name}`, "", `> ${p.idea}`, ""];
  if (p.prd) {
    out.push("## PRD", "");
    p.prd.forEach((s) => {
      out.push(`### ${s.title}`, "");
      s.blocks.forEach((b) => out.push(`**${b.label}**`, "", b.body, ""));
    });
  }
  if (p.groups) {
    out.push("## 기능명세서", "");
    p.groups.forEach((g) => {
      out.push(`### ${g.code}. ${g.title}`, "");
      g.features.forEach((f) => {
        out.push(`#### ${f.code} ${f.title}`, "", f.summary, "", `- 역할: ${f.roles.join(", ")}`, `- 중요도: ${f.priority}`, `- 상태: ${f.status}`);
        f.criteria.forEach((c) => out.push(`- [ ] ${c}`));
        out.push("");
      });
    });
  }
  return out.join("\n");
}

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;

export function exportMarkdown(p: Project) {
  download(`${p.name}.md`, toMarkdown(p), "text/markdown");
}

export function exportCsv(p: Project) {
  const rows = [["번호", "기능 묶음", "기능", "설명", "역할", "중요도", "상태", "수용 기준"]];
  p.groups?.forEach((g) => g.features.forEach((f) =>
    rows.push([f.code, g.title, f.title, f.summary, f.roles.join(", "), ({ 3: "높음", 2: "보통", 1: "낮음" } as const)[f.priority], ({ draft: "작성 중", review: "검토 중", done: "확정" } as const)[f.status], f.criteria.join(" / ")])));
  // BOM so Excel opens Korean text correctly.
  download(`${p.name}-기능명세서.csv`, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n"), "text/csv");
}

export function exportJson(p: Project) {
  download(`${p.name}.json`, JSON.stringify(p, null, 2), "application/json");
}
