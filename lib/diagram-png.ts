import { currentFlow } from "./export";
import { LEFT, layoutFlow, routeEdge } from "./flow-layout";
import { numbering } from "./spec-model";
import { COL, W, graphLayout } from "./spec-graph";
import type { Flow, FlowKind, Project } from "./types";

// PNG images of the user flow and the 기능 그래프, drawn from the same layouts as the canvases
// (always in light colors, whatever the screen theme).
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = `font-family="Pretendard,Malgun Gothic,Apple SD Gothic Neo,sans-serif"`;

// Splits text into at most `lines` lines that fit `width` px (Hangul is about one em wide).
function wrap(s: string, width: number, size: number, lines = 2) {
  const out: string[] = [];
  let cur = "", w = 0;
  for (const ch of s) {
    const cw = /[ᄀ-￿]/.test(ch) ? size * 0.95 : size * 0.56;
    if (w + cw > width && cur) {
      out.push(cur);
      if (out.length === lines) { out[lines - 1] = out[lines - 1].slice(0, -1) + "…"; return out; }
      cur = "";
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  if (cur) out.push(cur);
  return out;
}
function textBlock(s: string, cx: number, cy: number, width: number, size: number, fill: string, weight = 400) {
  const ls = wrap(s, width, size);
  const top = cy - ((ls.length - 1) * size * 1.25) / 2 + size * 0.35;
  return ls.map((l, i) => `<text x="${cx}" y="${top + i * size * 1.25}" text-anchor="middle" font-size="${size}" font-weight="${weight}" fill="${fill}" ${FONT}>${esc(l)}</text>`).join("");
}

const KIND: Record<FlowKind, { fill: string; stroke: string; text: string }> = {
  start: { fill: "#845dde", stroke: "#845dde", text: "#ffffff" },
  page: { fill: "#ffffff", stroke: "#bdb9b9", text: "#333333" },
  data: { fill: "#e8f1fa", stroke: "#8fb2d4", text: "#2f4a63" },
  branch: { fill: "#fdf3df", stroke: "#dcae55", text: "#6b4a10" },
  action: { fill: "#e7f6ee", stroke: "#78bf97", text: "#245a3b" },
};

export function flowSvg(flow: Flow): string {
  const L = layoutFlow(flow);
  const pad = 24, head = 40;
  const width = L.width + pad * 2, height = L.height + pad * 2 + head;
  const bands = L.bands.map((b, i) => `<rect x="0" y="${b.y}" width="${L.width}" height="${b.h}" fill="${i % 2 ? "#f6f5f5" : "#fbfbfb"}"/><line x1="0" x2="${L.width}" y1="${b.y}" y2="${b.y}" stroke="#e4e2e2"/>`
    + wrap(b.section, LEFT - 28, 12, 3).map((l, j) => `<text x="10" y="${b.y + 24 + j * 16}" font-size="12" font-weight="600" fill="#555" ${FONT}>${esc(l)}</text>`).join("")).join("");
  const lanes = new Map<string, number>();
  const edges = flow.edges.map((e) => {
    const a = L.boxes[e.from], b = L.boxes[e.to];
    if (!a || !b) return "";
    const lane = L.back.has(e.id) ? lanes.get(e.to) ?? 0 : 0;
    if (L.back.has(e.id)) lanes.set(e.to, lane + 1);
    const r = routeEdge(a, b, lane);
    const label = e.label ? `<text x="${r.lx}" y="${r.ly - 4}" text-anchor="middle" font-size="10" fill="#6f6d6d" stroke="#f8f8f8" stroke-width="4" paint-order="stroke" ${FONT}>${esc(e.label.length > 16 ? `${e.label.slice(0, 15)}…` : e.label)}</text>` : "";
    return `<path d="${r.d}" fill="none" stroke="#a6a4a4" stroke-width="1.1"${L.back.has(e.id) ? ` stroke-dasharray="4 3"` : ""} marker-end="url(#arr)"/>${label}`;
  }).join("");
  const nodes = flow.nodes.map((n) => {
    const b = L.boxes[n.id];
    if (!b) return "";
    const s = KIND[n.kind];
    const { x, y, w, h } = b;
    const shape = n.kind === "start" ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"`
      : n.kind === "page" ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4"`
      : n.kind === "data" ? `<polygon points="${x + 14},${y} ${x + w},${y} ${x + w - 14},${y + h} ${x},${y + h}"`
      : n.kind === "branch" ? `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}"`
      : `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"`;
    const inset = n.kind === "branch" ? w * 0.18 : n.kind === "data" ? 12 : 6;
    return `${shape} fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.2"/>${textBlock(n.label, b.cx, b.cy, w - inset * 2 - 4, 11, s.text)}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/>`
    + `<text x="${pad}" y="${pad + 18}" font-size="18" font-weight="700" fill="#222" ${FONT}>${esc(flow.name)}</text>`
    + `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" fill="#9b9b9b"/></marker></defs>`
    + `<g transform="translate(${pad} ${pad + head})">${bands}${edges}${nodes}</g></svg>`;
}

export function specSvg(p: Project): string | null {
  const items = (p.spec ?? []).filter((x) => x.pending?.kind !== "new");
  if (!items.length) return null;
  const { nodes, height, rootY } = graphLayout(items, null);
  const num = numbering(items);
  const pad = 24, width = COL[3] + W[3] + pad * 2;
  const links = nodes.map((n) => {
    const from = n.parent ? { x: n.parent.cx + n.parent.w, y: n.parent.cy } : { x: COL[0] + W[0], y: rootY };
    const mx = (from.x + n.cx) / 2;
    return `<path d="M${from.x} ${from.y} C ${mx} ${from.y}, ${mx} ${n.cy}, ${n.cx} ${n.cy}" fill="none" stroke="${n.color}" stroke-width="1.5"/>`;
  }).join("");
  const root = `<rect x="${COL[0]}" y="${rootY - 32}" width="${W[0]}" height="64" rx="12" fill="#ffffff" stroke="#e9e8e8"/>`
    + `<text x="${COL[0] + 14}" y="${rootY - 6}" font-size="14" font-weight="700" fill="#333" ${FONT}>PRD</text>`
    + `<text x="${COL[0] + 14}" y="${rootY + 14}" font-size="11" fill="#888" ${FONT}>${esc(wrap(p.name, W[0] - 28, 11, 1)[0] ?? "")}</text>`;
  const boxes = nodes.map((n) => {
    const h = n.x.level === 3 ? 42 : 48, y = n.cy - h / 2;
    const stroke = n.x.level === 1 ? n.color : "#e9e8e8";
    return `<rect x="${n.cx}" y="${y}" width="${n.w}" height="${h}" rx="8" fill="#ffffff" stroke="${stroke}" stroke-width="${n.x.level === 1 ? 2 : 1}"/>`
      + `<text x="${n.cx + 10}" y="${y + 19}" font-size="10" fill="#888" ${FONT}>${esc(num[n.x.id] ?? "")}</text>`
      + `<text x="${n.cx + 40}" y="${y + 19}" font-size="12" font-weight="${n.x.level === 1 ? 700 : 500}" fill="#333" ${FONT}>${esc(wrap(n.x.title, n.w - 50, 12, 1)[0] ?? "")}</text>`
      + `<text x="${n.cx + 10}" y="${y + 36}" font-size="10" fill="#888" ${FONT}>${esc(n.x.code)}</text>`;
  }).join("");
  const H = height + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}"><rect width="100%" height="100%" fill="#ffffff"/><g transform="translate(${pad} ${pad})">${links}${root}${boxes}</g></svg>`;
}

export async function svgToPng(svg: string, scale = 2): Promise<Blob | null> {
  const m = /width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)"/.exec(svg)!;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("svg load failed"));
      im.src = url;
    });
    // Browsers cap canvas size; very large diagrams are drawn at a smaller scale.
    const w = Number(m[1]), h = Number(m[2]);
    const s = Math.min(scale, 16000 / w, 16000 / h, Math.sqrt(120_000_000 / (w * h)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * s);
    canvas.height = Math.round(h * s);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(s, s);
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function saveBlob(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[\\/:*?"<>|]/g, "_");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export async function exportFlowPng(p: Project): Promise<boolean> {
  const f = currentFlow(p);
  if (!f) return false;
  const blob = await svgToPng(flowSvg(f));
  if (blob) saveBlob(`${p.name}-${f.name}.png`, blob);
  return !!blob;
}

export async function exportSpecPng(p: Project): Promise<boolean> {
  const svg = specSvg(p);
  const blob = svg && await svgToPng(svg);
  if (blob) saveBlob(`${p.name}-기능명세서-그래프.png`, blob);
  return !!blob;
}
