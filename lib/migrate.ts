import { itemId, newCode } from "./spec-model";
import type { Flow, FlowKind, Perspective, Project, SpecItem } from "./types";

// Projects saved before the three-level spec (schema 1) are upgraded on load.
type Old = Project & {
  groups?: { id: string; title: string; features: { id: string; title: string; summary: string; rationale?: string; success?: string; criteria?: string[]; roles?: string[]; status?: SpecItem["status"]; priority?: 1 | 2 | 3; starred?: boolean }[] }[] | null;
  flow?: { lanes: string[]; nodes: { id: string; lane: string; kind: string; label: string }[]; edges: { from: string; to: string; label?: string }[] } | null;
  screens?: unknown;
  pending?: unknown;
};

const KIND: Record<string, FlowKind> = { start: "start", page: "page", layer: "data", branch: "branch", end: "action" };
const PERSP: Record<string, Perspective> = { "UX·디자인": "UX", 운영: "사업" };

// The three early statuses map onto the six current ones (검토중 → 기획 제안, 확정 → 기획 확정).
const OLD_STATUS: Record<string, SpecItem["status"]> = { review: "proposed", done: "confirmed" };
const fixStatus = (xs: SpecItem[]): SpecItem[] => xs.map((x) => ({
  ...x, status: OLD_STATUS[x.status] ?? x.status, children: fixStatus(x.children),
  ...(x.pending?.prev ? { pending: { ...x.pending, prev: { ...x.pending.prev, status: OLD_STATUS[x.pending.prev.status] ?? x.pending.prev.status } } } : {}),
}));
const needsFix = (xs: SpecItem[] | null): boolean => !!xs?.some((x) => x.status in OLD_STATUS || needsFix(x.children));

export function migrate(p: Project): Project {
  if (p.schema === 2) return needsFix(p.spec) ? { ...p, spec: fixStatus(p.spec!) } : p;
  const o = p as Old;
  const spec: SpecItem[] | null = o.groups
    ? o.groups.map((g) => ({
      id: g.id || itemId(), code: newCode(1), level: 1 as const, title: g.title, summary: "", roles: [], status: "draft" as const, priority: 2 as const,
      children: g.features.map((f) => ({
        id: f.id, code: newCode(2), level: 2 as const, title: f.title, summary: f.summary, rationale: f.rationale, success: f.success,
        criteria: f.criteria, roles: f.roles ?? [], status: f.status ?? "draft", priority: f.priority ?? 2, starred: f.starred, children: [],
      })),
    }))
    : (p.spec ?? null);
  const flows: Flow[] = p.flows ?? (o.flow ? [{
    id: "fl_" + p.id, name: "유저플로우 1", at: p.updatedAt, sections: o.flow.lanes,
    nodes: o.flow.nodes.map((n) => ({ id: n.id, section: n.lane, kind: KIND[n.kind] ?? "page", label: n.label })),
    edges: o.flow.edges.map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to, label: e.label })),
  }] : []);
  const { groups: _g, flow: _f, screens: _s, pending: _p, ...rest } = o;
  return {
    ...rest,
    spec: spec && fixStatus(spec),
    flows,
    flowId: flows[0]?.id,
    wires: p.wires ?? [],
    findings: p.findings?.map((f) => ({ ...f, perspective: PERSP[f.perspective] ?? f.perspective })) ?? null,
    settings: p.settings ?? { language: "한국어", tone: "간결하게" },
    schema: 2,
  };
}
