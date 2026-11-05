// Toolbar actions (2.18): one registry for the top toolbar's buttons, their shortcuts and the AI's
// quick_action tool, so a click and an AI request do exactly the same thing. Every run is one undo
// step and one action-log line; running it again when nothing is left to do says "이미 적용됨".
import { logAction, quickBegin, quickEnd } from "./actionlog";
import { beginUndoGroup, editDraft, st, toast } from "./store";
import type { Clip, Draft } from "./types";

export type Scope = { kind: "clips"; ids: string[] } | { kind: "draft" };
export type ActionResult = { changed: number; detail: string; skipped: string[] };
export type ActionCtx = { draft: Draft; scope: Scope; clips: Clip[]; params: Record<string, unknown>; by: "user" | "ai" };
/**
 * What a run gives back. `edit` is applied to the draft as it is when the run ends (use it when the
 * run waited for something, so edits made meanwhile are kept); else `draft` replaces it.
 */
export type ActionOut = { draft?: Draft; edit?: (d: Draft) => Draft; changed: number; detail: string; skipped?: string[] };
export type ActionDef = {
  id: string;
  group: "기본" | "360";
  label: string;
  /** lucide-preact icon name. */
  icon?: string;
  tooltip?: string;
  /** Shortcut, e.g. "Alt+Shift+H". */
  key?: string;
  enabled?: (d: Draft, scope: Scope) => boolean;
  run: (ctx: ActionCtx) => ActionOut | Promise<ActionOut>;
};

const REG = new Map<string, ActionDef>();
export function registerAction(def: ActionDef) { REG.set(def.id, def); }
export const actionList = () => [...REG.values()];
export const getAction = (id: string) => REG.get(id);

/** "selection": the selected main-track clip, else the whole draft; "draft": always the whole draft. */
export type ScopeArg = Scope | "selection" | "draft" | { clips: string[] };
export function resolveScope(d: Draft, s: ScopeArg | undefined, sel: string | null): Scope {
  if (s === "draft") return { kind: "draft" };
  if (s && typeof s === "object" && "kind" in s) return s;
  if (s && typeof s === "object" && "clips" in s) {
    const ids = (s.clips ?? []).filter((id) => d.clips.some((c) => c.id === id));
    if (!ids.length) throw new Error(`편집본에 없는 클립입니다: ${(s.clips ?? []).join(", ")}`);
    return { kind: "clips", ids };
  }
  return sel && d.clips.some((c) => c.id === sel) ? { kind: "clips", ids: [sel] } : { kind: "draft" };
}
export const scopeClips = (d: Draft, s: Scope) => (s.kind === "draft" ? d.clips : d.clips.filter((c) => s.ids.includes(c.id)));
export function scopeLabel(d: Draft, s: Scope): string {
  if (s.kind === "draft") return "초안 전체";
  return s.ids.length === 1 ? `클립 ${d.clips.findIndex((c) => c.id === s.ids[0]) + 1}` : `클립 ${s.ids.length}개`;
}

export type RunOpts = { scope?: ScopeArg; params?: Record<string, unknown>; by?: "user" | "ai"; run?: string | null; chat?: string | null; draftId?: string | null };

export async function runAction(id: string, o: RunOpts = {}): Promise<ActionResult> {
  const def = REG.get(id);
  if (!def) throw new Error(`없는 버튼입니다: ${id}. 쓸 수 있는 것: ${[...REG.keys()].join(", ") || "(없음)"}`);
  const p = st.project;
  const d = p?.drafts.find((x) => x.id === (o.draftId ?? st.draftId));
  if (!p || !d) throw new Error("열린 편집본이 없습니다");
  const by = o.by ?? "user";
  const scope = resolveScope(d, o.scope, st.selClip);
  const base = {
    who: by, kind: by === "ai" ? "ai" as const : "quick" as const, label: def.label, draft: d.id,
    clips: scope.kind === "clips" ? scope.ids : [], params: { id, scope: scope.kind === "draft" ? "draft" : scope.ids, ...(o.params ?? {}) },
    run: o.run ?? null, chat: o.chat ?? null, tool: by === "ai" ? "quick_action" : null,
  };
  if (def.enabled && !def.enabled(d, scope)) {
    const detail = `${def.label}: ${scopeLabel(d, scope)}에는 할 일이 없습니다`;
    if (by === "user") toast(detail);
    return { changed: 0, detail, skipped: [] };
  }
  const label = by === "ai" ? `AI: ${def.label}` : def.label;
  const t0 = Date.now();
  const g = beginUndoGroup(label);
  quickBegin();
  let out: ActionOut;
  let moved = false;
  try {
    out = await def.run({ draft: d, scope, clips: scopeClips(d, scope), params: o.params ?? {}, by });
    if (out.edit) editDraft(label, out.edit, d.id);
    else if (out.draft && out.draft !== d) editDraft(label, () => out.draft!, d.id);
    moved = g.commit();
  } catch (e) {
    g.rollback();
    logAction(p.id, { ...base, detail: String((e as Error)?.message ?? e).slice(0, 300), ok: false, took: Date.now() - t0 });
    throw e;
  } finally {
    quickEnd();
  }
  const changed = moved ? Math.max(1, out.changed) : 0;
  const detail = changed ? out.detail : `${def.label}: 이미 적용됨`;
  logAction(p.id, { ...base, detail, took: Date.now() - t0, step: moved ? label : undefined });
  if (by === "user") toast(detail);
  return { changed, detail, skipped: out.skipped ?? [] };
}
