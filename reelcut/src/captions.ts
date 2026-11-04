// Burned-in captions: groups timeline words into short lines and writes an ASS file. Corrections and
// line changes are kept per draft against the spoken words (asset + word number), so they survive
// later cuts; a translation is a list of its own, tied to the first and last word it covers.
import { assColor, assText, assTime, textEvent } from "./graphics";
import type { CapEdits, CaptionStyle, Draft, TextItem } from "./types";
import type { TWord } from "./edit";

export type CapWord = TWord & { br?: boolean };
export type Line = { t0: number; t1: number; text: string; words?: CapWord[]; key?: string; hidden?: boolean; custom?: boolean };
export type LineOptions = { lines?: 1 | 2; breakBy?: CaptionStyle["breakBy"]; edits?: CapEdits };

export const wordKey = (w: { asset: string; wi: number }) => `${w.asset}:${w.wi}`;

const SENTENCE_END = /[.?!。]$/;
/** Good places to end a line: punctuation and Korean endings that join two clauses. */
const CLAUSE_END = /(?:[,，、]|고|며|면|서|는데|은데|지만|니까|라서|어서|아서|해서)$/;
const lenOf = (ws: { t: string }[]) => ws.reduce((s, x) => s + x.t.length + 1, 0);

export function captionLines(ws0: TWord[], maxChars: number, opt: LineOptions = {}): Line[] {
  const breaks = opt.edits?.breaks ?? {}, mode = opt.breakBy ?? "smart", rows = opt.lines ?? 1;
  const ws: CapWord[] = ws0.map((w) => { const fix = opt.edits?.words?.[wordKey(w)]; return fix ? { ...w, t: fix } : w; });
  const cap = maxChars * rows * (mode === "sentence" ? 3 : 1);
  const groups: CapWord[][] = [];
  let cur: CapWord[] = [];
  const flush = () => { if (cur.length) groups.push(cur); cur = []; };
  ws.forEach((w, i) => {
    const force = breaks[wordKey(w)];
    if (force === "break") flush();
    const pause = cur.length > 0 && w.t0 - cur[cur.length - 1].t1 > 0.6;
    if (force !== "join" && cur.length && (lenOf(cur) + w.t.length > cap || pause)) {
      // A long run ends at the last natural place in its second half; the rest starts the next line.
      let at = -1;
      if (!pause && mode === "smart") for (let j = cur.length - 2; j >= Math.ceil(cur.length / 2) - 1 && at < 0; j--) if (CLAUSE_END.test(cur[j].t)) at = j;
      if (at >= 0 && !cur.slice(at + 1).some((x) => breaks[wordKey(x)] === "join")) {
        const rest = cur.slice(at + 1);
        cur = cur.slice(0, at + 1);
        flush();
        cur = rest;
      } else flush();
    }
    cur.push(w);
    const next = ws[i + 1];
    if ((SENTENCE_END.test(w.t) && !(next && breaks[wordKey(next)] === "join")) || !next) flush();
  });
  // A lone short word goes back to the line before it, when that line runs into it.
  if (mode === "smart") for (let i = groups.length - 1; i > 0; i--) {
    const g = groups[i], p = groups[i - 1], w = g[0];
    if (g.length === 1 && w.t.length <= 2 && !breaks[wordKey(w)] && !SENTENCE_END.test(p[p.length - 1].t) && w.t0 - p[p.length - 1].t1 < 0.3 && lenOf(p) + w.t.length <= cap * 1.25) {
      p.push(w);
      groups.splice(i, 1);
    }
  }
  const out: Line[] = groups.map((g) => {
    const group = rows === 2 ? twoRows(g, maxChars) : g;
    const key = wordKey(group[0]), custom = opt.edits?.lineText?.[key];
    const text = group.map((w, i) => (i ? (w.br ? "\n" : " ") : "") + w.t).join("");
    return { t0: group[0].t0, t1: group[group.length - 1].t1, text: custom ?? text, words: group, key, hidden: opt.edits?.hidden?.includes(key), custom: custom != null };
  });
  // No gaps shorter than a few frames between lines; keep each line on screen at least 0.5 s.
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (next && next.t0 - out[i].t1 < 0.25) out[i].t1 = next.t0;
    if (out[i].t1 - out[i].t0 < 0.5) out[i].t1 = next ? Math.min(next.t0, out[i].t0 + 0.5) : out[i].t0 + 0.5;
  }
  return out;
}

/** Splits a line over two rows of similar length, preferring the end of a clause. */
function twoRows(g: CapWord[], maxChars: number): CapWord[] {
  if (g.length < 2 || lenOf(g) - 1 <= maxChars) return g;
  let best = 1, score = Infinity;
  for (let i = 1; i < g.length; i++) {
    const a = lenOf(g.slice(0, i)), b = lenOf(g.slice(i));
    const s = Math.abs(a - b) - (CLAUSE_END.test(g[i - 1].t) ? 3 : 0);
    if (s < score) { score = s; best = i; }
  }
  return g.map((w, i) => (i === best ? { ...w, br: true } : w));
}

/** The draft's caption lines, and its translation as timed lines of their own. */
export function draftCaptions(d: Draft, ws: TWord[]): { lines: Line[]; tr: Line[] } {
  const st = d.captionStyle;
  const lines = captionLines(ws, st.maxChars, { lines: st.lines, breakBy: st.breakBy, edits: d.capEdits });
  const at = new Map(ws.map((w) => [wordKey(w), w]));
  const hidden = d.capEdits?.hidden ?? [];
  const tr: Line[] = [];
  for (const it of d.translation?.items ?? []) {
    const a = at.get(it.from), b = at.get(it.to);
    if ((!a && !b) || hidden.includes(it.from)) continue;
    const t0 = (a ?? b)!.t0, t1 = (b ?? a)!.t1;
    tr.push({ t0, t1: Math.max(t1, t0 + 0.5), text: it.text, key: it.from, custom: true });
  }
  tr.sort((x, y) => x.t0 - y.t0);
  return { lines, tr };
}

// Editing lines: each returns the new edits and leaves the words themselves alone.

/** New text for a line: same number of words corrects them one by one, otherwise the line gets its own text. */
export function setLineText(e: CapEdits | undefined, l: Line, text: string): CapEdits {
  const ws = l.words ?? [], parts = text.trim().split(/\s+/).filter(Boolean);
  const lineText = { ...e?.lineText };
  delete lineText[l.key ?? ""];
  if (parts.length !== ws.length) return { ...e, lineText: { ...lineText, [l.key ?? ""]: text.trim() } };
  const words = { ...e?.words };
  ws.forEach((w, i) => { if (w.t !== parts[i]) words[wordKey(w)] = parts[i]; });
  return { ...e, lineText, words };
}
export const setBreak = (e: CapEdits | undefined, key: string, how: "break" | "join"): CapEdits => ({ ...e, breaks: { ...e?.breaks, [key]: how } });
export const joinNext = (e: CapEdits | undefined, next: Line) => setBreak(e, next.key ?? "", "join");
export function moveWordPrev(e: CapEdits | undefined, l: Line): CapEdits {
  const ws = l.words ?? [];
  const joined = setBreak(e, l.key ?? "", "join");
  return ws.length > 1 ? setBreak(joined, wordKey(ws[1]), "break") : joined;
}
export function moveWordNext(e: CapEdits | undefined, l: Line, next: Line): CapEdits {
  const ws = l.words ?? [];
  return ws.length > 1 ? setBreak(setBreak(e, next.key ?? "", "join"), wordKey(ws[ws.length - 1]), "break") : e ?? {};
}
export function setHidden(e: CapEdits | undefined, key: string, hide: boolean): CapEdits {
  const rest = (e?.hidden ?? []).filter((x) => x !== key);
  return { ...e, hidden: hide ? [...rest, key] : rest };
}

/** The word a style picks out on its own: first, last, the first number or the longest. */
export function keyWordIndex(ws: { t: string }[], how: CaptionStyle["keyword"]): number {
  if (!ws.length || !how || how === "none") return -1;
  if (how === "first") return 0;
  if (how === "last") return ws.length - 1;
  if (how === "number") { const i = ws.findIndex((w) => /\d/.test(w.t)); if (i >= 0) return i; }
  return ws.reduce((best, w, i) => (w.t.length > ws[best].t.length ? i : best), 0);
}

/** Which word of a line is being spoken at time t (-1 before its first word). */
export function spokenIndex(l: Line, t: number): number {
  const ws = l.words ?? [];
  for (let i = ws.length - 1; i >= 0; i--) if (t >= (i === 0 ? l.t0 : ws[i].t0)) return i;
  return -1;
}

export function toAss(lines: Line[], st: CaptionStyle, width: number, height: number, texts: TextItem[] = [], tr: Line[] = [], show: Draft["capShow"] = "orig"): string {
  const size = Math.round((height * st.size) / 100);
  const margin = Math.round(width * 0.06), marginV = Math.round(height * 0.07);
  const col = st.align === "left" ? 1 : st.align === "right" ? 3 : 2;
  const row = st.position === "top" ? 6 : st.position === "middle" ? 3 : 0;
  const an = row + col, x = col === 1 ? margin : col === 3 ? width - margin : Math.round(width / 2);
  const baseY = st.position === "top" ? marginV : st.position === "middle" ? Math.round(height / 2) : height - marginV;
  const both = show === "both" && tr.length > 0;
  const trPx = Math.round(size * 0.75);
  // With a translation under the line, a line at the bottom moves up to make room.
  const y = both && !row ? baseY - Math.round(trPx * 1.5) : baseY;
  const bold = st.bold === false ? 0 : -1;
  const edge = Math.max(2, Math.round(size / 14));
  const bord = st.box ? Math.round(size / 6) : edge;
  const line = st.box && st.boxColor ? assColor(st.boxColor) : assColor(st.outline);
  const styleLine = (name: string, font: string, px: number, color: string, ln: string, b: number, border: number, outline: number, a: number) =>
    `Style: ${name},${font},${px},${assColor(color)},&H000000FF,${ln},&H64000000,${b},0,0,0,100,100,0,0,${border},${outline},${border === 3 ? 0 : 1},${a},${margin},${margin},${marginV},1`;
  const head = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styleLine("Default", st.font, size, st.color, line, bold, st.box ? 3 : 1, bord, an),
    styleLine("Box", st.font, size, "#FFFFFF", "&H50000000", -1, 3, Math.round(size / 5), 5),
    styleLine("Trans", st.font, trPx, st.color, assColor(st.outline), 0, 1, edge, st.position === "top" || st.position === "middle" ? 6 + col : col),
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const anim = st.anim ?? "none";
  const dist = Math.round(size * 0.9);
  const look = `${st.italic ? "\\i1" : ""}${st.spacing ? `\\fsp${st.spacing}` : ""}${st.glow ? "\\blur4" : ""}`;
  const POP_LINE = "\\fscx70\\fscy70\\t(0,160,\\fscx100\\fscy100)";
  const events: string[] = [];
  const lineEvents = (l: Line) => {
    const ws = l.custom ? [] : l.words ?? [];
    const byWord = st.animBy === "word" && anim !== "none" && ws.length > 0;
    const reveal = (anim === "type" || byWord) && ws.length > 0;
    const wordWise = ws.length > 0 && (!!st.highlight || !!st.markColor || reveal);
    const key = keyWordIndex(ws, st.keyword);
    const lead = (first: boolean) => {
      const place = first && !byWord && anim === "rise" ? `\\move(${x},${y + dist},${x},${y},0,240)` : first && !byWord && anim === "drop" ? `\\move(${x},${y - dist},${x},${y},0,240)` : `\\pos(${x},${y})`;
      return `{\\an${an}${place}${first && !byWord && anim === "fade" ? "\\fad(180,0)" : ""}${look}}`;
    };
    const block = (j: number, k: number, first: boolean) => {
      const spoken = j === k;
      const c = spoken && st.highlight ? st.highlight : j === key && st.keyColor ? st.keyColor : st.color;
      let scale = spoken && st.pop ? "\\fscx112\\fscy112" : "\\fscx100\\fscy100";
      if (first && !byWord && anim === "pop") scale = POP_LINE;
      if (spoken && byWord && anim === "pop") scale = "\\fscx70\\fscy70\\t(0,150,\\fscx100\\fscy100)";
      let alpha = "\\alpha&H00&";
      if (reveal && k >= 0 && j > k) alpha = "\\alpha&HFF&";
      else if (spoken && byWord && anim !== "pop" && anim !== "type") alpha = "\\alpha&HFF&\\t(0,150,\\alpha&H00&)";
      const edgeTag = spoken && st.markColor && !st.box ? `\\3c${assColor(st.markColor)}&\\bord${Math.round(size / 5)}` : `\\3c${line}&\\bord${bord}`;
      return `{\\c${assColor(c)}&${edgeTag}${scale}${alpha}}`;
    };
    const body = (k: number, first: boolean) => ws.map((w, j) => (j ? (w.br ? "\\N" : " ") : "") + block(j, k, first) + assText(w.t)).join("");
    if (!ws.length || (!wordWise && key < 0)) {
      const pop = anim === "pop" ? `{${POP_LINE}}` : "";
      events.push(`Dialogue: 0,${assTime(l.t0)},${assTime(l.t1)},Default,,0,0,0,,${lead(true)}${pop}${assText(l.text)}`);
    } else if (!wordWise) {
      events.push(`Dialogue: 0,${assTime(l.t0)},${assTime(l.t1)},Default,,0,0,0,,${lead(true)}${body(-1, true)}`);
    } else {
      // One event per spoken word, the whole line on screen with that word picked out.
      ws.forEach((w, k) => {
        const from = k === 0 ? l.t0 : w.t0;
        const to = k + 1 < ws.length ? ws[k + 1].t0 : l.t1;
        if (to > from) events.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Default,,0,0,0,,${lead(k === 0)}${body(k, k === 0)}`);
      });
    }
  };
  for (const l of show === "tr" ? tr : lines) lineEvents(l);
  if (both) {
    const ty = !row ? baseY : y + Math.round(size * (row === 3 ? 0.9 : 1.4 * (st.lines ?? 1)));
    for (const l of tr) events.push(`Dialogue: 1,${assTime(l.t0)},${assTime(l.t1)},Trans,,0,0,0,,{\\pos(${x},${ty})${look}}${assText(l.text)}`);
  }
  for (const t of texts) events.push(textEvent(t, width, height));
  return head.concat(events).join("\n") + "\n";
}

export function toSrt(lines: Line[]): string {
  const t = (s: number) => assTime(s).replace(".", ",").padStart(11, "0") + "0";
  return lines.map((l, i) => `${i + 1}\n${t(l.t0)} --> ${t(l.t1)}\n${l.text}\n`).join("\n");
}
