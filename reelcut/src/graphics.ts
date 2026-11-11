// Titles, place/date pins, stickers and caption looks. Everything on screen that is not a picture is
// written as ASS events, burned in at export; the preview draws the same items (Viewer) from the same
// numbers. Sticker shapes are ASS vector paths, which also convert directly to SVG.
import type { CaptionStyle, TextItem, TextKind } from "./types";

export const TEXT_KINDS: { id: TextKind; label: string; text: string; dur: number }[] = [
  { id: "title", label: "제목", text: "제목", dur: 4 },
  { id: "subtitle", label: "작은 제목", text: "작은 제목", dur: 4 },
  { id: "lower", label: "설명 막대", text: "설명", dur: 5 },
  { id: "pin", label: "장소·날짜 핀", text: "장소 · 날짜", dur: 5 },
];

/** Shapes in a 100×100 box, as ASS drawing paths. */
export const STICKERS: Record<string, { label: string; path: string; color: string; ring?: boolean }> = {
  heart: { label: "하트", color: "#FF5A7A", path: "m 50 90 b 18 66 4 48 4 30 b 4 16 15 8 27 8 b 37 8 45 13 50 22 b 55 13 63 8 73 8 b 85 8 96 16 96 30 b 96 48 82 66 50 90" },
  star: { label: "별", color: "#FFD23F", path: "m 50 4 l 62 37 l 97 38 l 69 59 l 79 93 l 50 73 l 21 93 l 31 59 l 3 38 l 38 37 l 50 4" },
  pin: { label: "위치", color: "#FF5A5A", path: "m 50 96 b 34 70 18 52 18 34 b 18 16 32 4 50 4 b 68 4 82 16 82 34 b 82 52 66 70 50 96 m 50 22 b 43 22 38 27 38 34 b 38 41 43 46 50 46 b 57 46 62 41 62 34 b 62 27 57 22 50 22" },
  arrow: { label: "화살표", color: "#FFFFFF", path: "m 6 40 l 58 40 l 58 18 l 96 50 l 58 82 l 58 60 l 6 60 l 6 40" },
  bubble: { label: "말풍선", color: "#FFFFFF", path: "m 14 10 l 86 10 b 92 10 96 14 96 20 l 96 60 b 96 66 92 70 86 70 l 44 70 l 24 92 l 26 70 l 14 70 b 8 70 4 66 4 60 l 4 20 b 4 14 8 10 14 10" },
  circle: { label: "동그라미", color: "#FFD23F", ring: true, path: "m 50 6 b 74 6 94 26 94 50 b 94 74 74 94 50 94 b 26 94 6 74 6 50 b 6 26 26 6 50 6" },
};

/** The same shape for the preview. */
export function stickerSvgPath(name: string): string {
  const path = STICKERS[name]?.path ?? "";
  return path.replace(/\bm\b/g, "M").replace(/\bl\b/g, "L").replace(/\bb\b/g, "C");
}

/** Where each kind sits and how it looks, unless the item says otherwise. */
export function textLook(t: TextItem): { x: number; y: number; size: number; color: string; align: "left" | "center"; box: boolean; bold: boolean; fade: number } {
  const kinds = {
    title: { x: 0.5, y: 0.42, size: 11, align: "center", box: false, bold: true },
    subtitle: { x: 0.5, y: 0.56, size: 6, align: "center", box: false, bold: false },
    lower: { x: 0.06, y: 0.8, size: 5, align: "left", box: true, bold: true },
    pin: { x: 0.04, y: 0.92, size: 3.8, align: "left", box: false, bold: true },
    sticker: { x: 0.5, y: 0.5, size: 16, align: "center", box: false, bold: false },
  } as const;
  const k = kinds[t.kind] ?? kinds.title;
  return { x: t.x ?? k.x, y: t.y ?? k.y, size: t.size ?? k.size, color: t.color ?? (t.kind === "sticker" ? STICKERS[t.sticker ?? "star"]?.color ?? "#FFFFFF" : "#FFFFFF"), align: k.align, box: k.box, bold: k.bold, fade: t.fade ?? 0.3 };
}

export const assTime = (s: number) => {
  const cs = Math.round(Math.max(0, s) * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), x = Math.floor((cs % 6000) / 100), c = cs % 100;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${h}:${p(m)}:${p(x)}.${p(c)}`;
};
/** #RRGGBB → ASS &H00BBGGRR */
export const assColor = (hex: string) => {
  const h = hex.replace("#", "").padEnd(6, "0");
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};
export const assText = (t: string) => t.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, "\\N");

/** One overlay item as an ASS event (layer 2, above the captions). */
export function textEvent(t: TextItem, width: number, height: number): string {
  const l = textLook(t);
  const x = Math.round(l.x * width), y = Math.round(l.y * height);
  const px = Math.round((height * l.size) / 100);
  const fade = Math.round(l.fade * 1000);
  const start = assTime(t.at), end = assTime(t.at + t.dur);
  const fad = fade ? `\\fad(${fade},${fade})` : "";
  if (t.kind === "sticker") {
    const s = STICKERS[t.sticker ?? "star"] ?? STICKERS.star;
    const fill = s.ring ? "\\1a&HFF&" : `\\1c${assColor(l.color)}&`;
    const line = s.ring ? `\\3c${assColor(l.color)}&\\bord${Math.max(3, Math.round(px / 14))}` : "\\3c&H00000000&\\bord2";
    return `Dialogue: 2,${start},${end},Default,,0,0,0,,{\\an5\\pos(${x},${y})\\fscx${px}\\fscy${px}\\shad0${fill}${line}${fad}\\p1}${s.path}{\\p0}`;
  }
  const an = l.align === "left" ? 4 : 5;
  const style = l.box ? "Box" : "Default";
  const b = l.bold ? 1 : 0;
  let body = assText(t.text);
  if (t.kind === "pin") {
    // A little location mark drawn in front of the words.
    const pin = STICKERS.pin;
    const size = Math.round(px * 0.9);
    body = `{\\p1\\fscx${size}\\fscy${size}\\1c${assColor(pin.color)}&\\bord1}${pin.path}{\\p0\\r${style}\\fs${px}\\b${b}\\c${assColor(l.color)}&} ${body}`;
  }
  return `Dialogue: 2,${start},${end},${style},,0,0,0,,{\\an${an}\\pos(${x},${y})\\fs${px}\\b${b}\\c${assColor(l.color)}&${fad}}${body}`;
}

/** Caption looks to choose from (style values applied over the current ones). */
const PLAIN: Partial<CaptionStyle> = { font: "Malgun Gothic", color: "#FFFFFF", outline: "#000000", box: false, boxColor: "", highlight: "", markColor: "", keyword: "none", keyColor: "", pop: false, anim: "none", animBy: "line", italic: false, spacing: 0, glow: false, bold: true, size: 6 };
const look = (id: string, label: string, style: Partial<CaptionStyle>) => ({ id, label, style: { ...PLAIN, ...style } });

export const CAPTION_PRESETS: { id: string; label: string; style: Partial<CaptionStyle> }[] = [
  look("basic", "기본 (흰 글자 + 테두리)", {}),
  look("soft", "얇고 차분하게", { color: "#F2F2F2", outline: "#333333", bold: false, size: 5 }),
  look("fade_in", "부드럽게 나타나기", { anim: "fade", size: 5.5 }),
  look("serif_bar", "명조체 + 어두운 띠", { font: "Noto Serif KR", box: true, boxColor: "#14161A", size: 5, bold: false }),
  look("box", "검은 상자", { box: true, size: 5.5 }),
  look("yellow", "노란 글자", { color: "#FFE14D" }),
  look("key_green", "핵심 단어 초록", { keyword: "longest", keyColor: "#5BE7A9" }),
  look("key_yellow", "숫자·핵심 단어 노랑", { keyword: "number", keyColor: "#FFE14D" }),
  look("karaoke", "말하는 단어 강조", { highlight: "#FFE14D" }),
  look("mark_purple", "말하는 단어에 보라 형광펜", { markColor: "#7C4DFF", size: 6.5 }),
  look("mark_orange", "말하는 단어에 주황 형광펜", { markColor: "#FF7A1A", color: "#FFFFFF", size: 6.5 }),
  look("red_edge", "빨간 테두리", { outline: "#D81E2C", size: 7 }),
  look("yellow_block", "노란 상자 + 검은 글자", { box: true, boxColor: "#FFD400", color: "#111111", size: 5.5 }),
  look("neon", "푸른 네온", { color: "#BFEFFF", outline: "#1E7BFF", glow: true, size: 6.5 }),
  look("pop", "강조 + 톡 튀는 단어 (쇼츠)", { highlight: "#5BE7A9", pop: true, anim: "pop", animBy: "word", size: 8, maxChars: 12, position: "middle" }),
];
