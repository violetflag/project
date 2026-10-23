"use client";

// Text out of office files, read in the browser: Word (.docx), Excel (.xlsx), PowerPoint (.pptx),
// and Hangul (.hwpx, and .hwp 5.0). Slides and sheets are marked ([슬라이드 3], [시트: 일정])
// so the AI can cite where a sentence came from.
import CFB from "cfb";
import { inflateSync, strFromU8, unzipSync } from "fflate";

export const OFFICE = /\.(docx|xlsx|pptx|hwpx|hwp)$/i;

const xml = (s: string) => new DOMParser().parseFromString(s, "application/xml");
const byNum = (a: string, b: string) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0);
const tags = (d: Document | Element, name: string) => Array.from(d.getElementsByTagName(name));

// Paragraph text: each <p> joined from its <t> runs.
function paragraphs(doc: Document, p: string, t: string) {
  return tags(doc, p).map((el) => tags(el, t).map((x) => x.textContent ?? "").join("")).filter((s) => s.trim());
}

function docx(files: Record<string, Uint8Array>) {
  const main = files["word/document.xml"];
  if (!main) throw new Error("Word 문서 본문을 찾지 못했어요.");
  return paragraphs(xml(strFromU8(main)), "w:p", "w:t").join("\n");
}

function pptx(files: Record<string, Uint8Array>) {
  const slides = Object.keys(files).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort(byNum);
  return slides.map((k, i) => `[슬라이드 ${i + 1}]\n${paragraphs(xml(strFromU8(files[k])), "a:p", "a:t").join("\n")}`).join("\n\n");
}

function xlsx(files: Record<string, Uint8Array>) {
  const shared = files["xl/sharedStrings.xml"]
    ? tags(xml(strFromU8(files["xl/sharedStrings.xml"])), "si").map((si) => tags(si, "t").map((t) => t.textContent ?? "").join(""))
    : [];
  const rels = files["xl/_rels/workbook.xml.rels"] ? xml(strFromU8(files["xl/_rels/workbook.xml.rels"])) : null;
  const target = (rid: string) => {
    const r = rels && tags(rels, "Relationship").find((x) => x.getAttribute("Id") === rid);
    const t = r?.getAttribute("Target") ?? "";
    return t.startsWith("/") ? t.slice(1) : `xl/${t}`;
  };
  const wb = files["xl/workbook.xml"] ? xml(strFromU8(files["xl/workbook.xml"])) : null;
  const sheets = wb
    ? tags(wb, "sheet").map((s) => ({ name: s.getAttribute("name") ?? "", path: target(s.getAttribute("r:id") ?? "") }))
    : Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort(byNum).map((path, i) => ({ name: `시트${i + 1}`, path }));
  return sheets.filter((s) => files[s.path]).map((s) => {
    const rows = tags(xml(strFromU8(files[s.path])), "row").map((row) => tags(row, "c").map((c) => {
      const type = c.getAttribute("t");
      if (type === "inlineStr") return tags(c, "t").map((t) => t.textContent ?? "").join("");
      const v = tags(c, "v")[0]?.textContent ?? "";
      return type === "s" ? shared[Number(v)] ?? "" : v;
    }).join("\t")).filter((r) => r.trim());
    return `[시트: ${s.name}]\n${rows.join("\n")}`;
  }).join("\n\n");
}

function hwpx(files: Record<string, Uint8Array>) {
  const secs = Object.keys(files).filter((k) => /^Contents\/section\d+\.xml$/.test(k)).sort(byNum);
  if (!secs.length) throw new Error("한글 문서 본문을 찾지 못했어요.");
  return secs.map((k) => paragraphs(xml(strFromU8(files[k])), "hp:p", "hp:t").join("\n")).join("\n");
}

// HWP 5.0: an OLE compound file; BodyText/Section* hold (usually deflated) records, and
// HWPTAG_PARA_TEXT (67) records carry UTF-16 text mixed with 1- or 8-unit control codes.
const PARA_TEXT = 67;
const SINGLE = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);
function paraText(u16: Uint16Array) {
  let s = "";
  for (let i = 0; i < u16.length; i++) {
    const c = u16[i];
    if (c >= 32) s += String.fromCharCode(c);
    else if (SINGLE.has(c)) { if (c === 10) s += "\n"; }
    else { if (c === 9) s += "\t"; i += 7; }
  }
  return s;
}
// cfb hands back stream contents as a plain number array in some builds.
const bytesOf = (c: unknown) => (c == null ? undefined : c instanceof Uint8Array ? c : new Uint8Array(c as ArrayLike<number>));

export function hwp(bytes: Uint8Array) {
  const cfb = CFB.read(bytes, { type: "buffer" });
  const header = bytesOf(CFB.find(cfb, "/FileHeader")?.content);
  if (!header || strFromU8(header.slice(0, 17)) !== "HWP Document File") throw new Error("한글(HWP) 파일이 아니에요.");
  const flags = new DataView(header.buffer, header.byteOffset).getUint32(36, true);
  if (flags & 2) throw new Error("암호가 걸린 한글 파일은 읽을 수 없어요.");
  if (flags & 4) throw new Error("배포용 한글 파일은 읽을 수 없어요.");
  const compressed = (flags & 1) === 1;
  const out: string[] = [];
  for (let n = 0; ; n++) {
    const raw = bytesOf(CFB.find(cfb, `/BodyText/Section${n}`)?.content);
    if (!raw) break;
    const data = compressed ? inflateSync(raw) : raw;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let o = 0;
    while (o + 4 <= data.length) {
      const h = view.getUint32(o, true);
      o += 4;
      const tag = h & 0x3ff;
      let size = h >>> 20;
      if (size === 0xfff) { size = view.getUint32(o, true); o += 4; }
      if (tag === PARA_TEXT && size >= 2) {
        const body = data.slice(o, o + size);
        const line = paraText(new Uint16Array(body.buffer, body.byteOffset, Math.floor(size / 2))).trim();
        if (line) out.push(line);
      }
      o += size;
    }
  }
  if (!out.length) throw new Error("한글 문서에서 글을 찾지 못했어요.");
  return out.join("\n");
}

export async function officeText(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  const ext = f.name.toLowerCase().split(".").pop();
  if (ext === "hwp") return hwp(bytes);
  const files = unzipSync(bytes);
  if (ext === "docx") return docx(files);
  if (ext === "pptx") return pptx(files);
  if (ext === "xlsx") return xlsx(files);
  return hwpx(files);
}
