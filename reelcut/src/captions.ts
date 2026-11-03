// Burned-in captions: groups timeline words into short lines and writes an ASS file.
import type { CaptionStyle } from "./types";
import type { TWord } from "./edit";

export type Line = { t0: number; t1: number; text: string };

export function captionLines(ws: TWord[], maxChars: number): Line[] {
  const out: Line[] = [];
  let cur: TWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ t0: cur[0].t0, t1: cur[cur.length - 1].t1, text: cur.map((w) => w.t).join(" ") });
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

const assTime = (s: number) => {
  const cs = Math.round(Math.max(0, s) * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), x = Math.floor((cs % 6000) / 100), c = cs % 100;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${h}:${p(m)}:${p(x)}.${p(c)}`;
};
/** #RRGGBB → ASS &H00BBGGRR */
const assColor = (hex: string) => {
  const h = hex.replace("#", "").padEnd(6, "0");
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};
const assText = (t: string) => t.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, "\\N");

export function toAss(lines: Line[], st: CaptionStyle, width: number, height: number): string {
  const size = Math.round((height * st.size) / 100);
  const align = st.position === "top" ? 8 : st.position === "middle" ? 5 : 2;
  const marginV = Math.round(height * 0.07);
  const head = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${st.font},${size},${assColor(st.color)},&H000000FF,${assColor(st.outline)},&H64000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size / 14))},1,${align},${Math.round(width * 0.06)},${Math.round(width * 0.06)},${marginV},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  return head.concat(lines.map((l) => `Dialogue: 0,${assTime(l.t0)},${assTime(l.t1)},Default,,0,0,0,,${assText(l.text)}`)).join("\n") + "\n";
}

export function toSrt(lines: Line[]): string {
  const t = (s: number) => assTime(s).replace(".", ",").padStart(11, "0") + "0";
  return lines.map((l, i) => `${i + 1}\n${t(l.t0)} --> ${t(l.t1)}\n${l.text}\n`).join("\n");
}
