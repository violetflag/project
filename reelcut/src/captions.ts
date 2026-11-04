// Burned-in captions: groups timeline words into short lines and writes an ASS file.
import { assColor, assText, assTime, textEvent } from "./graphics";
import type { CaptionStyle, TextItem } from "./types";
import type { TWord } from "./edit";

export type Line = { t0: number; t1: number; text: string; words?: TWord[] };

export function captionLines(ws: TWord[], maxChars: number): Line[] {
  const out: Line[] = [];
  let cur: TWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ t0: cur[0].t0, t1: cur[cur.length - 1].t1, text: cur.map((w) => w.t).join(" "), words: cur });
    cur = [];
  };
  ws.forEach((w, i) => {
    const len = cur.reduce((s, x) => s + x.t.length + 1, 0);
    if (cur.length && (len + w.t.length > maxChars || w.t0 - cur[cur.length - 1].t1 > 0.6)) flush();
    cur.push(w);
    if (/[.?!。]$/.test(w.t) || i === ws.length - 1) flush();
  });
  // No gaps shorter than a few frames between lines; keep each line on screen at least 0.5 s.
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (next && next.t0 - out[i].t1 < 0.25) out[i].t1 = next.t0;
    if (out[i].t1 - out[i].t0 < 0.5) out[i].t1 = next ? Math.min(next.t0, out[i].t0 + 0.5) : out[i].t0 + 0.5;
  }
  return out;
}

export function toAss(lines: Line[], st: CaptionStyle, width: number, height: number, texts: TextItem[] = []): string {
  const size = Math.round((height * st.size) / 100);
  const align = st.position === "top" ? 8 : st.position === "middle" ? 5 : 2;
  const marginV = Math.round(height * 0.07);
  const margin = Math.round(width * 0.06);
  const bold = st.bold === false ? 0 : -1;
  const edge = Math.max(2, Math.round(size / 14));
  const styleLine = (name: string, font: string, px: number, color: string, line: string, b: number, border: number, outline: number, an: number) =>
    `Style: ${name},${font},${px},${assColor(color)},&H000000FF,${line},&H64000000,${b},0,0,0,100,100,0,0,${border},${outline},${border === 3 ? 0 : 1},${an},${margin},${margin},${marginV},1`;
  const head = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styleLine("Default", st.font, size, st.color, assColor(st.outline), bold, st.box ? 3 : 1, st.box ? Math.round(size / 6) : edge, align),
    styleLine("Box", st.font, size, "#FFFFFF", "&H50000000", -1, 3, Math.round(size / 5), 5),
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  for (const l of lines) {
    const ws = l.words ?? [];
    if (!st.highlight || !ws.length) {
      events.push(`Dialogue: 0,${assTime(l.t0)},${assTime(l.t1)},Default,,0,0,0,,${assText(l.text)}`);
      continue;
    }
    // One event per spoken word, the whole line on screen with that word coloured.
    const on = `{\\c${assColor(st.highlight)}&${st.pop ? "\\fscx112\\fscy112" : ""}}`;
    ws.forEach((w, k) => {
      const from = k === 0 ? l.t0 : w.t0;
      const to = k + 1 < ws.length ? ws[k + 1].t0 : l.t1;
      if (to <= from) return;
      const text = ws.map((x, j) => (j === k ? `${on}${assText(x.t)}{\\r}` : assText(x.t))).join(" ");
      events.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Default,,0,0,0,,${text}`);
    });
  }
  for (const t of texts) events.push(textEvent(t, width, height));
  return head.concat(events).join("\n") + "\n";
}

export function toSrt(lines: Line[]): string {
  const t = (s: number) => assTime(s).replace(".", ",").padStart(11, "0") + "0";
  return lines.map((l, i) => `${i + 1}\n${t(l.t0)} --> ${t(l.t1)}\n${l.text}\n`).join("\n");
}
