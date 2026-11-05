// The project's action log (2.18): every toolbar click, hand edit, AI change, undo and export, in
// order, kept in an append-only file (logs/actions/<project>.jsonl; the project folder from the
// .reelcut file on). Before each AI request the user's new lines are put in front of the AI, and
// again when the user clicks while the AI works, so it continues from them instead of undoing
// them. Clips the user set by hand carry `userSet`, which the AI may not change unless asked.
import { api } from "./api";
import { is360, isGap } from "./edit";
import type { ActionEntry, ActionKind, ActionWho, Asset, Clip, Draft, Stab, UserSet, View } from "./types";

/** Hand edits with the same name on the same draft within this time are one line. */
export const COALESCE_MS = 2000;
/** At most this many new lines go in front of the AI per request. */
export const INJECT_MAX = 15;
const KEEP = 5000;

export type NewEntry = Partial<ActionEntry> & { who: ActionWho; kind: ActionKind; label: string };
export type Sink = {
  load(pid: string): Promise<ActionEntry[]>;
  /** Appends; an entry saved again (a coalesced edit) replaces the older line with its seq on load. */
  save(pid: string, entries: ActionEntry[]): Promise<void>;
};

/** Lines from the file: the last line with a seq wins, ordered by seq. */
export function parseLines(lines: string[]): ActionEntry[] {
  const by = new Map<number, ActionEntry>();
  for (const l of lines) {
    try { const e = JSON.parse(l); if (typeof e?.seq === "number") by.set(e.seq, e); } catch { /* a cut-off line */ }
  }
  return [...by.values()].sort((a, b) => a.seq - b.seq);
}

export const fileSink: Sink = {
  load: async (pid) => parseLines(await api.jsonlTail("actions", pid, 20_000)),
  save: (pid, es) => api.jsonlAppend("actions", pid, es.map((e) => JSON.stringify(e))),
};

let sink: Sink = fileSink;
let pid: string | null = null;
let log: ActionEntry[] = [];
let seq = 0;
let loading: Promise<void> = Promise.resolve();
let unsaved: ActionEntry[] = [];
let saveT: ReturnType<typeof setTimeout> | undefined;
/** The line a following edit may be folded into, with the draft before the first of them. */
let pending: { key: string; before: Draft; at: number; seq: number } | null = null;
const listeners = new Set<() => void>();

/** Where entries are kept (tests use memory; the .reelcut project file will point it at its folder). */
export function setSink(s: Sink) { flush(); sink = s; pid = null; log = []; seq = 0; pending = null; }
export function onLog(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }

/**
 * Switches the log to a project and loads its earlier lines. Lines written before the load ends
 * are numbered after the loaded ones.
 */
export function useLog(p: string): Promise<void> {
  if (p === pid) return loading;
  flush();
  pid = p; log = []; seq = 0; pending = null; unsaved = [];
  loading = sink.load(p).then((old) => {
    if (pid !== p) return;
    const base = old.length ? old[old.length - 1].seq : 0;
    for (const e of log) { e.seq += base; if (e.ref != null) e.ref += base; }
    if (pending) pending.seq += base;
    log = [...old, ...log].slice(-KEEP);
    seq = log.length ? log[log.length - 1].seq : 0;
  }).catch(() => {
    // No earlier log could be read: number from the clock so nothing written now collides with it.
    if (pid !== p) return;
    const base = Date.now() * 10;
    for (const e of log) { e.seq += base; if (e.ref != null) e.ref += base; }
    if (pending) pending.seq += base;
    seq = log.length ? log[log.length - 1].seq : base;
  });
  return loading;
}

function scheduleSave() {
  clearTimeout(saveT);
  saveT = setTimeout(flush, 800);
}
/** Writes what is not saved yet (also called when the project changes or the app closes). */
export function flush() {
  clearTimeout(saveT);
  if (!pid || !unsaved.length) return;
  const p = pid, es = unsaved, to = sink;
  unsaved = [];
  // Never before the load: the numbers of early lines change there.
  void loading.then(() => to.save(p, es)).catch(() => { /* the next save tries again with new lines only */ });
}

function local(ms: number): string {
  const d = new Date(ms), off = -d.getTimezoneOffset();
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

export function logAction(p: string, e: NewEntry): ActionEntry {
  void useLog(p);
  const ms = Date.now();
  const c = ai && e.who === "ai" ? ai : null;
  const full: ActionEntry = {
    t: local(ms), ms, seq: ++seq, draft: null, clips: [], assets: [], params: null, detail: "",
    run: c?.run ?? null, chat: c?.chat ?? null, tool: c?.tool ?? null, took: 0, ok: true, ...e,
  };
  if (c) c.logged = true;
  log.push(full);
  if (log.length > KEEP) log.shift();
  unsaved.push(full);
  scheduleSave();
  listeners.forEach((f) => f());
  return full;
}

/** Changes a line already written (it is saved again; the newer copy wins). */
export function updateEntry(e: ActionEntry, patch: Partial<ActionEntry>) {
  Object.assign(e, patch);
  if (!unsaved.includes(e)) unsaved.push(e);
  scheduleSave();
  listeners.forEach((f) => f());
}

export const entries = (): readonly ActionEntry[] => log;
export const lastSeq = () => seq;
export const logReady = () => loading;

/** Undone by a later undo (of it, or of its whole AI request) and not redone since. */
export function isUndone(e: ActionEntry, list: readonly ActionEntry[] = log): boolean {
  let undone = false;
  for (const x of list) {
    if (x.seq <= e.seq || x === e) continue;
    if (x.kind !== "undo" && x.kind !== "redo") continue;
    if (x.ref === e.seq || (x.kind === "undo" && e.run && x.run === e.run && !x.ref)) undone = x.kind === "undo";
  }
  return undone;
}

/** The newest line made by this undo step and not already undone (for Ctrl+Z / Ctrl+Y lines). */
export function stepEntry(step: string, undone: boolean): ActionEntry | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.step === step && e.kind !== "undo" && e.kind !== "redo" && isUndone(e) === undone) return e;
  }
  return undefined;
}

// ---------------------------------------------------------------- who is acting

type AiCtx = { run: string | null; chat: string | null; tool: string; call: number; logged: boolean };
let ai: AiCtx | null = null;
let callN = 0;
/** Marks the AI tool now running; returns what was running before (restore with aiEnd). */
export function aiBegin(run: string | null, chat: string | null, tool: string): AiCtx | null {
  const prev = ai;
  ai = { run, chat, tool, call: ++callN, logged: false };
  return prev;
}
export function aiEnd(prev: AiCtx | null): AiCtx | null {
  const cur = ai;
  ai = prev;
  return cur;
}
/** An AI tool is running now (what it starts is the AI's). */
export const aiActive = () => !!ai;
let quick = 0;
/** A toolbar action is running: its edits are logged by the action itself, not as hand edits. */
export function quickBegin() { quick++; }
export function quickEnd() { quick = Math.max(0, quick - 1); }

/** Undo-step names the AI uses ("AI: …", "AI 스크립트: …"). */
export const isAiLabel = (label: string) => /^AI(:| 스크립트)/.test(label);

// ---------------------------------------------------------------- what changed

const r1 = (x: number) => Math.round(x * 10) / 10;
const deg = (x: number | undefined) => Math.round(x ?? 0);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const STAB_MODE: Record<Stab["mode"], string> = { horizon: "수평", eis: "수평+흔들림", lock: "방향 고정", smooth: "흔들림만", off: "끔" };
export const stabName = (s?: Stab | null) => !s ? "기본" : s.mode === "off" ? "끔" : s.mode === "horizon" ? "수평만" : `${s.strength <= 0.6 ? "약" : s.strength >= 1.5 ? "강" : "보통"}(${STAB_MODE[s.mode]})`;
const PRESET: Record<string, string> = { best: "최적", zoom: "확대", wide: "광각", ultra: "초광각", planet: "작은 행성" };
export const presetName = (p?: string) => (p ? PRESET[p] ?? p : "");

function viewDiff(a?: View, b?: View): string {
  if (!a || !b) return a ? "시점 지움" : "시점 정함";
  const parts: string[] = [];
  if (deg(a.yaw) !== deg(b.yaw)) parts.push(`yaw ${deg(a.yaw)}→${deg(b.yaw)}`);
  if (deg(a.pitch) !== deg(b.pitch)) parts.push(`pitch ${deg(a.pitch)}→${deg(b.pitch)}`);
  if (deg(a.roll) !== deg(b.roll)) parts.push(`roll ${deg(a.roll)}→${deg(b.roll)}`);
  if (deg(a.hfov) !== deg(b.hfov)) parts.push(`hfov ${deg(a.hfov)}→${deg(b.hfov)}`);
  const da = (a as any).dist ?? 0, db = (b as any).dist ?? 0;
  if (r1(da) !== r1(db)) parts.push(`왜곡 ${r1(da)}→${r1(db)}`);
  return parts.join(" ");
}

/** One clip's changes, in words. */
function clipDiff(a: Clip, b: Clip): string[] {
  const out: string[] = [];
  if (a.start !== b.start || a.end !== b.end) out.push(`구간 ${r1(a.start)}–${r1(a.end)}→${r1(b.start)}–${r1(b.end)}`);
  if (a.speed !== b.speed) out.push(`속도 ${a.speed}→${b.speed}`);
  if (a.volume !== b.volume) out.push(`음량 ${r1(a.volume)}→${r1(b.volume)}`);
  if (!same(a.volKeys, b.volKeys)) out.push(`음량 키 ${a.volKeys?.length ?? 0}→${b.volKeys?.length ?? 0}개`);
  if (!same(a.view, b.view)) { const v = viewDiff(a.view, b.view); if (v) out.push(`시점 ${v}`); }
  if (!same(a.viewKeys, b.viewKeys)) out.push(`시점 키 ${a.viewKeys?.length ?? 0}→${b.viewKeys?.length ?? 0}개`);
  if (!same(a.viewPreset, b.viewPreset)) out.push(`화각 ${presetName(a.viewPreset) || "-"}→${presetName(b.viewPreset) || "-"}`);
  if (!same(a.stab, b.stab)) out.push(`흔들림 ${stabName(a.stab)}→${stabName(b.stab)}`);
  if (!same(a.color, b.color)) out.push("색");
  if (!same(a.transform, b.transform)) out.push("변형");
  if (!same(a.anim, b.anim)) out.push("움직임");
  if (a.xin !== b.xin || a.xtype !== b.xtype) out.push(b.xin ? `전환 ${b.xtype ?? "fade"} ${b.xin}초` : "전환 없앰");
  if (!!a.disabled !== !!b.disabled) out.push(b.disabled ? "끔" : "켬");
  if (a.fadeIn !== b.fadeIn || a.fadeOut !== b.fadeOut) out.push("페이드");
  if (!!a.denoise !== !!b.denoise) out.push(b.denoise ? "잡음 제거" : "잡음 제거 끔");
  if (!!a.detached !== !!b.detached) out.push("소리 분리");
  return out;
}

/** What changed in a draft, short enough for one log line, and which main-track clips. */
export function diffDraft(a: Draft, b: Draft): { detail: string; clips: string[] } {
  const parts: string[] = [];
  const clips: string[] = [];
  const old = new Map(a.clips.map((c) => [c.id, c]));
  const now = new Set(b.clips.map((c) => c.id));
  const added = b.clips.filter((c) => !old.has(c.id)).length;
  const removed = a.clips.filter((c) => !now.has(c.id)).length;
  if (added) parts.push(`클립 +${added}`);
  if (removed) parts.push(`클립 -${removed}`);
  const keptA = a.clips.filter((c) => now.has(c.id)).map((c) => c.id), keptB = b.clips.filter((c) => old.has(c.id)).map((c) => c.id);
  if (!added && !removed && keptA.join() !== keptB.join()) parts.push("순서 바꿈");
  const per: string[] = [];
  b.clips.forEach((c, i) => {
    const o = old.get(c.id);
    if (!o || o === c) return;
    const d = clipDiff(o, c);
    if (!d.length) return;
    clips.push(c.id);
    per.push(`클립 ${i + 1}(${c.id}) ${d.join(", ")}`);
  });
  parts.push(...per.slice(0, 4));
  if (per.length > 4) parts.push(`외 클립 ${per.length - 4}개`);
  if (a.aspect !== b.aspect) parts.push(`비율 ${a.aspect}→${b.aspect}`);
  if (a.name !== b.name) parts.push(`이름 "${b.name}"`);
  if (a.captions !== b.captions) parts.push(b.captions ? "자막 켬" : "자막 끔");
  if (!same(a.captionStyle, b.captionStyle)) parts.push("자막 모양");
  if (!same(a.capEdits, b.capEdits)) parts.push("자막 고침");
  if (!same(a.translation, b.translation)) parts.push("번역");
  if (!same(a.fx, b.fx)) parts.push(b.fx?.loudnorm ? `소리 고르게 ${b.fx.lufs ?? -16} LUFS` : "소리 고르게 끔");
  const count = (x: unknown[] | undefined, y: unknown[] | undefined, name: string) => { if (!same(x, y)) parts.push((x?.length ?? 0) === (y?.length ?? 0) ? name : `${name} ${x?.length ?? 0}→${y?.length ?? 0}`); };
  count(a.overlays, b.overlays, "V2·V3");
  count(a.music, b.music, "소리 클립");
  count(a.markers, b.markers, "마커");
  count(a.texts, b.texts, "글자");
  if (a.inPoint !== b.inPoint || a.outPoint !== b.outPoint) parts.push("인·아웃");
  if (!same(a.tracks, b.tracks)) parts.push("트랙");
  return { detail: parts.join(" · ").slice(0, 400), clips };
}

/** Marks the fields the user changed by hand on main-track clips (view, stabilisation, sound). */
export function markUserSet(a: Draft, b: Draft, now = Date.now()): Draft {
  const old = new Map(a.clips.map((c) => [c.id, c]));
  let changed = false;
  const clips = b.clips.map((c) => {
    const o = old.get(c.id);
    if (!o || o === c) return c;
    const set: UserSet = {};
    if (!same(o.view, c.view) || !same(o.viewKeys, c.viewKeys) || !same(o.viewPreset, c.viewPreset)) set.view = now;
    if (!same(o.stab, c.stab)) set.stab = now;
    if (o.volume !== c.volume || !same(o.volKeys, c.volKeys)) set.volume = now;
    if (!Object.keys(set).length) return c;
    changed = true;
    return { ...c, userSet: { ...c.userSet, ...set } };
  });
  return changed ? { ...b, clips } : b;
}

/** A toolbar button pressed by hand: the clips it changed keep that for the AI (`ActionDef.marks`). */
export function markButton(a: Draft, b: Draft, field: keyof UserSet, now = Date.now()): Draft {
  const old = new Map(a.clips.map((c) => [c.id, c]));
  let changed = false;
  const clips = b.clips.map((c) => {
    const o = old.get(c.id);
    if (!o || o === c || same(o, c)) return c;
    changed = true;
    return { ...c, userSet: { ...c.userSet, [field]: now } };
  });
  return changed ? { ...b, clips } : b;
}

const drafts = (ds: Draft[]) => new Map(ds.map((d) => [d.id, d]));

/**
 * Called by the store for every draft edit (an undo step). Logs it as a hand edit, an AI change
 * or nothing (a toolbar action logs itself) and returns the draft with hand-set fields marked.
 */
export function noteDraftChange(p: string, label: string, before: Draft, after: Draft): Draft {
  if (quick) return after;
  const byAi = isAiLabel(label) && !!ai;
  if (!byAi && !isAiLabel(label)) after = markUserSet(before, after);
  const now = Date.now();
  const key = byAi ? `ai|${ai!.call}|${after.id}` : `edit|${label}|${after.id}`;
  const last = log[log.length - 1];
  if (pending && pending.key === key && last?.seq === pending.seq && (byAi || now - pending.at < COALESCE_MS)) {
    const { detail, clips } = diffDraft(pending.before, after);
    pending.at = now;
    updateEntry(last, { detail, clips, ms: now, t: local(now) });
    if (byAi) ai!.logged = true;
    return after;
  }
  const { detail, clips } = diffDraft(before, after);
  const e = logAction(p, {
    who: byAi || isAiLabel(label) ? "ai" : "user", kind: byAi || isAiLabel(label) ? "ai" : "edit",
    label: label.replace(/^AI:\s*/, ""), draft: after.id, clips, detail, step: label,
  });
  pending = { key, before, at: now, seq: e.seq };
  return after;
}

/** Drafts added, removed or replaced together (new draft, delete, undo of a whole AI request). */
export function noteDraftsChange(p: string, label: string, before: Draft[], after: Draft[], extra?: Partial<ActionEntry>) {
  if (quick) return;
  const a = drafts(before), b = drafts(after);
  const parts: string[] = [];
  for (const d of after) if (!a.has(d.id)) parts.push(`편집본 추가 "${d.name}"`);
  for (const d of before) if (!b.has(d.id)) parts.push(`편집본 삭제 "${d.name}"`);
  for (const d of after) { const o = a.get(d.id); if (o && o !== d) { const x = diffDraft(o, d).detail; if (x) parts.push(`"${d.name}": ${x}`); } }
  const byAi = isAiLabel(label);
  pending = null;
  logAction(p, { who: byAi ? "ai" : "user", kind: byAi ? "ai" : "edit", label: label.replace(/^AI:\s*/, ""), detail: parts.join(" · ").slice(0, 400), step: label, ...extra });
}

/** An AI tool changed drafts without a logged edit (scripts write the project directly). */
export function noteAiTool(p: string, label: string, before: Draft[], after: Draft[], draftId: string | null) {
  if (before === after) return;
  const a = drafts(before);
  const d = after.find((x) => x.id === draftId) ?? after.find((x) => a.get(x.id) !== x);
  const o = d && a.get(d.id);
  const detail = d && o ? diffDraft(o, d) : { detail: "편집본 바뀜", clips: [] };
  logAction(p, { who: "ai", kind: "ai", label, draft: d?.id ?? null, ...detail });
}

// ---------------------------------------------------------------- what the AI is told

const hhmm = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

function scopeText(e: ActionEntry): string {
  const s = (e.params as any)?.scope;
  if (s === "draft" || s?.kind === "draft") return "초안 전체";
  const n = e.clips?.length ?? 0;
  return n === 1 ? `클립 ${e.clips![0]}` : n ? `클립 ${n}개` : "";
}

/** One line for the AI: time, what, where, what changed. */
export function fmtEntry(e: ActionEntry, withSeq = false): string {
  const head = withSeq ? `#${e.seq} ${hhmm(e.ms)} [${e.who}/${e.kind}]` : hhmm(e.ms);
  const what = e.kind === "edit" ? `[직접] ${e.label}`
    : e.kind === "undo" ? `되돌리기: ${e.label}` : e.kind === "redo" ? `다시 실행: ${e.label}` : e.label;
  return [`${head} ${what}`, e.kind === "quick" ? scopeText(e) : "", e.detail ?? "", e.ok ? "" : "실패", isUndone(e) ? "(되돌림)" : ""].filter(Boolean).join(" · ");
}

/** The user's lines after `seen` (newest INJECT_MAX), as a block for the AI, and the seq to remember. */
export function userActionsNote(seen: number, max = INJECT_MAX): { text: string; last: number } {
  const news = log.filter((e) => e.seq > seen && e.who !== "ai");
  const last = Math.max(seen, seq);
  if (!news.length) return { text: "", last };
  const shown = news.slice(-max);
  const more = news.length - shown.length;
  return {
    text: `<user-actions>\n${more ? `(앞선 ${more}건은 get_activity_log로)\n` : ""}${shown.map((e) => fmtEntry(e)).join("\n")}\n</user-actions>`,
    last,
  };
}

/** What is switched on now in a draft, in one line ("" when nothing is). */
export function stateLine(d: Draft, assets: Map<string, Asset>): string {
  const parts: string[] = [];
  if (d.fx?.loudnorm) parts.push(`소리 고르게(초안 전체, ${d.fx.lufs ?? -16} LUFS)`);
  const c360 = d.clips.filter((c) => !isGap(c) && is360(assets.get(c.asset)));
  if (c360.length) {
    // Clips without their own setting use the media's, whose default is level only.
    const eff = c360.map((c) => c.stab ?? assets.get(c.asset)?.lens?.stab ?? { mode: "horizon", strength: 1, rs: true } as Stab);
    const on = eff.filter((s) => s.mode === "smooth" || s.mode === "eis" || s.mode === "lock");
    if (on.length) {
      const names = new Map<string, number>();
      for (const s of on) { const n = stabName(s).replace(/\(.*\)/, ""); names.set(n, (names.get(n) ?? 0) + 1); }
      const top = [...names.entries()].sort((a, b) => b[1] - a[1])[0][0];
      parts.push(`흔들림 ${top} 360 클립 ${on.length}/${c360.length}`);
    }
    const level = eff.filter((s) => s.mode === "horizon" || s.mode === "eis" || s.mode === "lock").length;
    if (level) parts.push(`수평 맞추기 ${level}/${c360.length}`);
    const views = new Map<string, number>();
    for (const c of c360) {
      const k = c.userSet?.view ? "사용자 지정" : c.viewPreset ? presetName(c.viewPreset) : "";
      if (k) views.set(k, (views.get(k) ?? 0) + 1);
    }
    if (views.size) parts.push(`시점 ${[...views.entries()].map(([k, n]) => `${k} ${n}`).join(", ")}`);
    const seams = new Set(c360.map((c) => (assets.get(c.asset)?.lens?.stitch as any)?.seam).filter(Boolean));
    if (seams.size === 1 && seams.has("linear")) parts.push("이음새 미리보기와 같게");
    else if (seams.has("flow")) parts.push("이음새 정밀");
  }
  const hand = d.clips.filter((c) => c.userSet && Object.keys(c.userSet).length).length;
  if (hand) parts.push(`사용자 지정 클립 ${hand}개`);
  return parts.length ? `켜져 있는 것: ${parts.join(" · ")}` : "";
}

/** Lines for the get_activity_log tool. */
export function activityLog(o: { since_seq?: number; limit?: number; who?: ActionWho } = {}): string {
  const limit = Math.min(100, Math.max(1, Number(o.limit ?? 30)));
  const list = log.filter((e) => e.seq > (o.since_seq ?? 0) && (!o.who || e.who === o.who)).slice(-limit);
  return list.length ? list.map((e) => fmtEntry(e, true)).join("\n") : "기록이 없습니다.";
}

// ---------------------------------------------------------------- raw AI conversation archive

const archiveQ = new Map<string, string[]>();
let archiveT: ReturnType<typeof setTimeout> | undefined;
/** Images become a size note: the archive keeps words, tool inputs and results, not pictures. */
function noImages(_k: string, v: any) {
  if (v && typeof v === "object" && v.type === "image") {
    const data = v.source?.data ?? v.data;
    return { type: "image_ref", media_type: v.source?.media_type ?? v.mimeType ?? "", bytes: typeof data === "string" ? Math.round(data.length * 0.75) : 0 };
  }
  return v;
}
/** Adds one raw record (request, response, Claude Code event, tool call) to a conversation's archive. */
export function archive(p: string, sid: string, raw: unknown) {
  const name = `${p}.${sid}`;
  let line: string;
  try { line = JSON.stringify({ t: Date.now(), raw }, noImages); } catch { return; }
  const q = archiveQ.get(name) ?? [];
  q.push(line);
  archiveQ.set(name, q);
  clearTimeout(archiveT);
  archiveT = setTimeout(flushArchive, 1000);
}
export function flushArchive() {
  clearTimeout(archiveT);
  for (const [name, lines] of archiveQ) api.jsonlAppend("chats", name, lines).catch(() => { /* kept in the chat itself */ });
  archiveQ.clear();
}
export const archiveLine = (raw: unknown) => JSON.stringify({ raw }, noImages);

// Lines not written yet go out when the window closes.
if (typeof window !== "undefined") window.addEventListener("beforeunload", () => { flush(); flushArchive(); });
