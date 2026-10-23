import type { ItemPending, SpecCore, SpecItem } from "./types";

// Pure helpers for the requirement → feature → detail tree.

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PREFIX = { 1: "R", 2: "F", 3: "S" } as const;
export function newCode(level: 1 | 2 | 3) {
  let s = "";
  for (let i = 0; i < 6; i++) s += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  return `${PREFIX[level]}-${s}`;
}
let seq = 0;
export const itemId = () => `i_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const LEVEL_LABEL = { 1: "요구사항", 2: "기능", 3: "상세 기능" } as const;

export function flatten(items: SpecItem[] | null | undefined): SpecItem[] {
  const out: SpecItem[] = [];
  const walk = (xs: SpecItem[]) => xs.forEach((x) => { out.push(x); walk(x.children); });
  walk(items ?? []);
  return out;
}

export function findItem(items: SpecItem[] | null | undefined, id: string): SpecItem | undefined {
  return flatten(items).find((x) => x.id === id);
}

// Path of ancestors from the root down to (and including) the item.
export function pathTo(items: SpecItem[], id: string): SpecItem[] {
  for (const x of items) {
    if (x.id === id) return [x];
    const sub = pathTo(x.children, id);
    if (sub.length) return [x, ...sub];
  }
  return [];
}

// Outline numbers like "3.2.1".
export function numbering(items: SpecItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (xs: SpecItem[], pre: string) => xs.forEach((x, i) => {
    const n = pre ? `${pre}.${i + 1}` : `${i + 1}`;
    out[x.id] = n;
    walk(x.children, n);
  });
  walk(items, "");
  return out;
}

export function mapItems(items: SpecItem[], fn: (x: SpecItem) => SpecItem | null): SpecItem[] {
  return items.flatMap((x) => {
    const next = fn({ ...x, children: mapItems(x.children, fn) });
    return next ? [next] : [];
  });
}

export function updateItem(items: SpecItem[], id: string, fn: (x: SpecItem) => SpecItem): SpecItem[] {
  return mapItems(items, (x) => (x.id === id ? fn(x) : x));
}

export function removeItem(items: SpecItem[], id: string): SpecItem[] {
  return mapItems(items, (x) => (x.id === id ? null : x));
}

// Adds under parentId (or at the root when parentId is null), after afterId when given.
export function insertItem(items: SpecItem[], parentId: string | null, item: SpecItem, afterId?: string): SpecItem[] {
  const put = (xs: SpecItem[]) => {
    const i = afterId ? xs.findIndex((x) => x.id === afterId) : -1;
    return i >= 0 ? [...xs.slice(0, i + 1), item, ...xs.slice(i + 1)] : [...xs, item];
  };
  if (!parentId) return put(items);
  return items.map((x) => (x.id === parentId ? { ...x, children: put(x.children) } : { ...x, children: insertItem(x.children, parentId, item, afterId) }));
}

export function coreOf(x: SpecItem): SpecCore {
  const { title, summary, rationale, success, criteria, roles, status, priority, slots, offSlots, questions, src } = x;
  return { title, summary, rationale, success, criteria, roles, status, priority, slots, offSlots, questions, src };
}

export function blankItem(level: 1 | 2 | 3, title = "새 항목", pending?: ItemPending): SpecItem {
  return { id: itemId(), code: newCode(level), level, title, summary: "", roles: [], status: "draft", priority: 2, children: [], pending };
}

// --- Pending AI changes ------------------------------------------------------------

export const pendingItems = (items: SpecItem[] | null | undefined) => flatten(items).filter((x) => x.pending);

export function approveItem(items: SpecItem[], id: string): SpecItem[] {
  return mapItems(items, (x) => {
    if (x.id !== id || !x.pending) return x;
    if (x.pending.kind === "delete") return null;
    return { ...x, pending: undefined };
  });
}

export function rejectItem(items: SpecItem[], id: string): SpecItem[] {
  return mapItems(items, (x) => {
    if (x.id !== id || !x.pending) return x;
    if (x.pending.kind === "new") return null;
    if (x.pending.kind === "edit" && x.pending.prev) return { ...x, ...x.pending.prev, pending: undefined };
    return { ...x, pending: undefined };
  });
}

export function approveAll(items: SpecItem[]) {
  return mapItems(items, (x) => (x.pending?.kind === "delete" ? null : x.pending ? { ...x, pending: undefined } : x));
}
export function rejectAll(items: SpecItem[]) {
  return mapItems(items, (x) => {
    if (!x.pending) return x;
    if (x.pending.kind === "new") return null;
    if (x.pending.kind === "edit" && x.pending.prev) return { ...x, ...x.pending.prev, pending: undefined };
    return { ...x, pending: undefined };
  });
}

// Marks an AI rewrite of an item as a pending edit, keeping the first "before".
export function proposeEdit(items: SpecItem[], id: string, next: Partial<SpecCore>, reason?: string): SpecItem[] {
  return updateItem(items, id, (x) => ({
    ...x, ...next,
    pending: x.pending?.kind === "new" ? x.pending : { kind: "edit", prev: x.pending?.prev ?? coreOf(x), reason },
  }));
}

// How many of the enabled slots have text, e.g. 9/9.
export function slotFill(x: SpecItem) {
  const keys = ["pre", "trigger", "action", "result", "exception", "display", "access", "rule", "data"] as const;
  const on = keys.filter((k) => !x.offSlots?.includes(k));
  return { filled: on.filter((k) => x.slots?.[k]?.some((s) => s.trim())).length, total: on.length };
}

export function counts(items: SpecItem[] | null | undefined) {
  const all = flatten(items);
  return { req: all.filter((x) => x.level === 1).length, feat: all.filter((x) => x.level === 2).length, detail: all.filter((x) => x.level === 3).length };
}

// Plain-text dump of the spec for AI prompts and exports.
export function specText(items: SpecItem[] | null | undefined, withSlots = false) {
  const num = numbering(items ?? []);
  return flatten(items).map((x) => {
    const head = `${"  ".repeat(x.level - 1)}${num[x.id]} [${x.code}] ${x.title}: ${x.summary}`;
    if (!withSlots || !x.slots) return head;
    const slots = Object.entries(x.slots).filter(([, v]) => v?.length).map(([k, v]) => `${"  ".repeat(x.level)}- ${k}: ${v!.join(" / ")}`);
    return [head, ...slots].join("\n");
  }).join("\n");
}
