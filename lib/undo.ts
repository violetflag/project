"use client";

import { useSyncExternalStore } from "react";

// Undo/redo for hand edits, kept in memory per key ("spec:<project>", "flow:<project>:<flow>").
// Each edit remembers the value it replaced; undo swaps it back and keeps the newer one for redo.
const LIMIT = 50;
const stacks = new Map<string, { undo: unknown[]; redo: unknown[] }>();
const listeners = new Set<() => void>();
let tick = 0;
const notify = () => { tick++; listeners.forEach((l) => l()); };
const get = (key: string) => stacks.get(key) ?? stacks.set(key, { undo: [], redo: [] }).get(key)!;

// Edits within a moment of each other (typing a title) undo as one step.
const last = new Map<string, number>();
export function remember(key: string, before: unknown) {
  const s = get(key);
  const now = Date.now();
  const burst = now - (last.get(key) ?? 0) < 800 && s.undo.length > 0 && !s.redo.length;
  last.set(key, now);
  if (burst) return;
  s.undo = [...s.undo, before].slice(-LIMIT);
  s.redo = [];
  notify();
}

// Returns the value to restore, or undefined when there is nothing to undo.
export function takeUndo<T>(key: string, current: T): T | undefined {
  const s = get(key);
  if (!s.undo.length) return undefined;
  const v = s.undo.pop() as T;
  s.redo.push(current);
  last.delete(key);
  notify();
  return v;
}
export function takeRedo<T>(key: string, current: T): T | undefined {
  const s = get(key);
  if (!s.redo.length) return undefined;
  const v = s.redo.pop() as T;
  s.undo.push(current);
  notify();
  return v;
}

export function useUndo(key: string) {
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => tick, () => 0);
  const s = stacks.get(key);
  return { canUndo: !!s?.undo.length, canRedo: !!s?.redo.length };
}

// ⌘Z / Ctrl+Z undoes and ⌘⇧Z / Ctrl+Y redoes, except while typing in a field.
export function undoKey(e: KeyboardEvent): "undo" | "redo" | null {
  const t = e.target as HTMLElement | null;
  if (t && (t.closest("input, textarea, select, [contenteditable=true]"))) return null;
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y") return "redo";
  return null;
}
