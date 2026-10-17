"use client";

import { uid } from "./id";
import { updateProject } from "./store";
import type { Project } from "./types";

const snapshot = (p: Project) => JSON.stringify({ prd: p.prd, prdProps: p.prdProps, spec: p.spec, flows: p.flows, wires: p.wires });

// Saves a version after a deliverable changes, e.g. "요구사항 1개 추가 · 기능 14개 추가".
export function autoVersion(id: string, summary: string) {
  updateProject(id, (p) => {
    const n = p.versions.length + 1;
    return { ...p, versions: [{ id: uid("v_"), name: `버전 ${n}`, at: Date.now(), auto: true, summary, snapshot: snapshot(p) }, ...p.versions].slice(0, 50) };
  });
}

export function saveVersion(id: string, name: string) {
  updateProject(id, (p) => ({
    ...p, versions: [{ id: uid("v_"), name: name || `버전 ${p.versions.length + 1}`, at: Date.now(), summary: "직접 저장", snapshot: snapshot(p) }, ...p.versions].slice(0, 50),
  }), "새 버전을 저장했어요");
}

export function restoreVersion(id: string, vid: string) {
  updateProject(id, (p) => {
    const v = p.versions.find((x) => x.id === vid);
    if (!v) return p;
    const s = JSON.parse(v.snapshot);
    return { ...p, prd: s.prd ?? null, prdProps: s.prdProps, spec: s.spec ?? s.groups ?? null, flows: s.flows ?? [], wires: s.wires ?? [], stale: {} };
  }, "이전 버전으로 되돌렸어요");
}
