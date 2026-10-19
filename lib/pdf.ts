import { toMarkdown } from "./export";
import type { Project } from "./types";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Inline marks in one line of Markdown: `code`, **bold**.
const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

// The subset of Markdown that toMarkdown writes: headings, lists, tables, code fences, paragraphs.
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let table: string[][] | null = null;
  let code: string[] | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => {
    if (!table) return;
    const [head, ...body] = table;
    out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    table = null;
  };
  for (const line of md.split("\n")) {
    if (code) {
      if (line.startsWith("```")) { out.push(`<pre>${esc(code.join("\n"))}</pre>`); code = null; } else code.push(line);
      continue;
    }
    if (line.startsWith("```")) { closeList(); closeTable(); code = []; continue; }
    if (line.startsWith("|")) {
      closeList();
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!table) table = [];
      table.push(cells);
      continue;
    }
    closeTable();
    const h = /^(#{1,4}) (.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const ul = /^\s*[-*] (.*)$/.exec(line);
    const ol = /^\s*\d+\. (.*)$/.exec(line);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    if (line.startsWith("> ")) { out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  closeTable();
  if (code) out.push(`<pre>${esc((code as string[]).join("\n"))}</pre>`);
  return out.join("\n");
}

const STYLE = `
body{font-family:"Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;color:#111;max-width:780px;margin:28px auto;padding:0 18px;line-height:1.65;font-size:14px}
h1{font-size:24px;margin:0 0 12px}h2{font-size:19px;border-bottom:1px solid #ddd;padding-bottom:4px;margin:30px 0 10px}
h3{font-size:16px;margin:22px 0 8px}h4{font-size:14px;margin:16px 0 6px}
p{margin:6px 0}li{margin:2px 0}code{font-family:Consolas,monospace;font-size:12px;background:#f3f3f3;padding:0 3px;border-radius:3px}
pre{font-family:Consolas,monospace;font-size:12px;background:#f5f5f5;padding:10px;white-space:pre-wrap;border-radius:4px}
table{border-collapse:collapse;width:100%;font-size:12px;margin:8px 0}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f4f4f4}blockquote{margin:8px 0;padding-left:10px;border-left:3px solid #bbb;color:#555}
@media print{@page{margin:14mm}body{margin:0;max-width:none}h2{break-after:avoid}table,pre{break-inside:auto}}`;

// Opens a print-ready page; the browser's "PDF로 저장" turns it into a PDF.
// Returns false when the popup is blocked, so the caller can fall back to a file.
export function printPdf(p: Project): boolean {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)}</title><style>${STYLE}</style></head><body>${markdownToHtml(toMarkdown(p))}<script>addEventListener("load",function(){setTimeout(function(){print()},300)})</script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}

export function pdfHtmlFile(p: Project): { name: string; text: string } {
  return { name: `${p.name}.html`, text: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(p.name)}</title><style>${STYLE}</style></head><body>${markdownToHtml(toMarkdown(p))}</body></html>` };
}
