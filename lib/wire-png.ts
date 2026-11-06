import { saveBlob, svgToPng } from "./diagram-png";
import { currentWires } from "./export";
import type { Project, WireEl, WirePage } from "./types";

// Draws every wireframe page as a grid of simple phone or desktop frames, then saves one PNG.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Height in px of one element inside a frame of width w.
function boxes(e: WireEl, ox: number, w: number, y: number): { svg: string; h: number } {
  const x = ox + 12, iw = w - 24;
  const rect = (h: number, fill = "#ffffff", stroke = "#cfcfd6") => `<rect x="${x}" y="${y}" width="${iw}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}"/>`;
  const text = (t: string, dy: number, size = 12, weight = 400, color = "#222") =>
    `<text x="${x + 8}" y="${y + dy}" font-size="${size}" font-weight="${weight}" fill="${color}" font-family="Malgun Gothic,Apple SD Gothic Neo,sans-serif">${esc(clip(t, Math.floor(iw / (size * 0.62))))}</text>`;
  switch (e.t) {
    case "bar": return { h: 40, svg: rect(40, "#f4f4f7") + text(e.title, 25, 13, 600) + (e.back ? text("‹", 25, 16) : "") };
    case "heading": return { h: 34, svg: text(e.text, 24, 17, 700) };
    case "text": return { h: 26, svg: text(e.text, 18, 12, 400, e.muted ? "#888" : "#333") };
    case "image": { const h = e.tall ? 150 : 96; return { h: h + 8, svg: rect(h, "#ececf2") + text(e.label, h / 2 + 4, 12, 400, "#777") }; }
    case "input": return { h: 52, svg: text(e.label, 16, 11, 600, "#555") + rect(28, "#ffffff") + text(e.placeholder ?? "", 36, 11, 400, "#999") };
    case "button": return { h: 44, svg: rect(32, e.primary ? "#6d4ae0" : "#ffffff", e.primary ? "#6d4ae0" : "#cfcfd6") + text(e.text, 30, 12, 600, e.primary ? "#ffffff" : "#222") };
    case "chips": return { h: 36, svg: e.items.slice(0, 4).map((c, i) => rect(24, "#f1edff", "#f1edff").replace(`x="${x}"`, `x="${x + i * 80}"`).replace(`width="${iw}"`, 'width="72"') + `<text x="${x + i * 80 + 8}" y="${y + 17}" font-size="11" fill="#5a3fc0" font-family="sans-serif">${esc(clip(c, 8))}</text>`).join("") };
    case "card": return { h: 84, svg: rect(74) + text(e.title, 22, 13, 600) + e.lines.slice(0, 2).map((l, i) => text(l, 40 + i * 16, 11, 400, "#666")).join("") };
    case "list": { const h = 46 * Math.min(e.items.length, 4) + 4; return { h, svg: e.items.slice(0, 4).map((it, i) => rect(40, "#ffffff").replace(`y="${y}"`, `y="${y + i * 46}"`) + `<text x="${x + 8}" y="${y + i * 46 + 17}" font-size="12" font-weight="600" fill="#222" font-family="sans-serif">${esc(clip(it.title, 24))}</text>` + (it.sub ? `<text x="${x + 8}" y="${y + i * 46 + 32}" font-size="10" fill="#888" font-family="sans-serif">${esc(clip(it.sub, 30))}</text>` : "")).join("") }; }
    case "rows": { const h = 30 * Math.min(e.items.length, 5) + 4; return { h, svg: e.items.slice(0, 5).map((it, i) => `<text x="${x + 8}" y="${y + i * 30 + 18}" font-size="11" fill="#666" font-family="sans-serif">${esc(clip(it.label, 12))}</text><text x="${x + iw - 8}" y="${y + i * 30 + 18}" text-anchor="end" font-size="11" fill="#222" font-family="sans-serif">${esc(clip(it.value, 16))}</text>`).join("") }; }
    case "tabs":
    case "nav": { const items = e.items.slice(0, 5); const cw = iw / Math.max(items.length, 1); return { h: 34, svg: rect(30, "#ffffff") + items.map((t, i) => `<text x="${x + i * cw + cw / 2}" y="${y + 19}" text-anchor="middle" font-size="11" font-weight="${i === (e.active ?? -1) ? 700 : 400}" fill="${i === (e.active ?? -1) ? "#6d4ae0" : "#666"}" font-family="sans-serif">${esc(clip(t, 6))}</text>`).join("") }; }
    case "divider": return { h: 14, svg: `<line x1="${x}" y1="${y + 7}" x2="${x + iw}" y2="${y + 7}" stroke="#e2e2e8"/>` };
  }
  return { h: 0, svg: "" };
}

function frameSvg(pg: WirePage, device: "mobile" | "desktop", ox: number, oy: number, fw: number, fh: number): string {
  let y = oy + 44;
  const body = pg.els.map((e) => { const b = boxes(e, ox, fw, y); const out = b.svg; y += b.h + 6; return out; }).join("");
  const titleBar = `<text x="${ox}" y="${oy - 12}" font-size="14" font-weight="700" fill="#111" font-family="Malgun Gothic,Apple SD Gothic Neo,sans-serif">${esc(clip(pg.name, 28))}</text>`;
  const frame = `<rect x="${ox}" y="${oy}" width="${fw}" height="${fh}" rx="${device === "mobile" ? 26 : 8}" fill="#ffffff" stroke="#9a9aa6" stroke-width="2"/>`;
  const clipId = `c${Math.random().toString(36).slice(2, 8)}`;
  return `${titleBar}${frame}<clipPath id="${clipId}"><rect x="${ox}" y="${oy}" width="${fw}" height="${fh}" rx="${device === "mobile" ? 26 : 8}"/></clipPath><g clip-path="url(#${clipId})">${body}</g>`;
}

export function wireSvg(p: Project): string | null {
  const w = currentWires(p);
  if (!w || !w.pages.length) return null;
  const mobile = w.device === "mobile";
  const fw = mobile ? 300 : 420;
  const cols = mobile ? 4 : 3;
  const pad = 36, gap = 40;
  const heights = w.pages.map((pg) => {
    let h = 44 + 18;
    for (const e of pg.els) h += boxes(e, 0, fw, 0).h + 6;
    return Math.max(h + 16, mobile ? 520 : 360);
  });
  const fh = Math.max(...heights);
  const rows = Math.ceil(w.pages.length / cols);
  const width = pad * 2 + cols * fw + (cols - 1) * gap;
  const height = pad * 2 + rows * (fh + gap + 24);
  const cells = w.pages.map((pg, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const ox = pad + c * (fw + gap), oy = pad + 24 + r * (fh + gap + 24);
    return frameSvg(pg, w.device, ox, oy, fw, fh);
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f5f5f8"/>${cells}</svg>`;
}

export async function wirePng(p: Project): Promise<Blob | null> {
  const svg = wireSvg(p);
  return svg ? svgToPng(svg) : null;
}

export async function exportWirePng(p: Project): Promise<boolean> {
  const blob = await wirePng(p);
  if (blob) saveBlob(`${p.name}-와이어프레임.png`, blob);
  return !!blob;
}
