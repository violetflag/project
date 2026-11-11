import { download } from "./export";
import { currentWires } from "./export";
import type { Project, WireEl, WireSet } from "./types";

// A clickable HTML prototype of the open wireframe set: one self-contained file, each screen a
// frame, and every element with a prototype link (WireEl.to) a hotspot that opens its screen.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function el(e: WireEl, href: (to?: string) => string | null): string {
  const h = href(e.to);
  const wrap = (inner: string, cls = "") => (h ? `<a class="hot ${cls}" href="${h}">${inner}</a>` : `<div class="${cls}">${inner}</div>`);
  switch (e.t) {
    case "bar": return `<div class="bar">${e.back ? `<a class="back" href="#" onclick="history.back();return false" aria-label="뒤로">‹</a>` : ""}${wrap(esc(e.title), "bar-title")}</div>`;
    case "heading": return wrap(`<h2>${esc(e.text)}</h2>`, "pad");
    case "text": return wrap(`<p class="${e.muted ? "muted" : ""}">${esc(e.text)}</p>`, "pad");
    case "image": return wrap(`<div class="img ${e.tall ? "tall" : ""}">${esc(e.label)}</div>`, "pad");
    case "input": return wrap(`<label>${esc(e.label)}</label><div class="input">${esc(e.placeholder ?? "")}</div>`, "pad");
    case "button": return wrap(`<div class="btn ${e.primary ? "primary" : ""}">${esc(e.text)}</div>`, "pad");
    case "chips": return wrap(`<div class="chips">${e.items.map((c, i) => `<span class="${i === 0 ? "on" : ""}">${esc(c)}</span>`).join("")}</div>`, "pad");
    case "card": return wrap(`<div class="card">${e.image ? `<div class="img"></div>` : ""}<b>${esc(e.title)}</b>${e.lines.map((l) => `<p class="muted">${esc(l)}</p>`).join("")}</div>`, "pad");
    case "list": return wrap(`<div class="list">${e.items.map((x) => `<div><b>${esc(x.title)}</b>${x.sub ? `<p class="muted">${esc(x.sub)}</p>` : ""}</div>`).join("")}</div>`);
    case "rows": return wrap(`<div class="rows">${e.items.map((x) => `<div><span class="muted">${esc(x.label)}</span><span>${esc(x.value)}</span></div>`).join("")}</div>`, "pad");
    case "tabs": return wrap(`<div class="tabs">${e.items.map((t, i) => `<span class="${i === (e.active ?? 0) ? "on" : ""}">${esc(t)}</span>`).join("")}</div>`);
    case "nav": return wrap(`<div class="nav">${e.items.map((t, i) => `<span class="${i === (e.active ?? -1) ? "on" : ""}">${esc(t)}</span>`).join("")}</div>`);
    case "divider": return `<hr>`;
  }
}

const CSS = `*{box-sizing:border-box}body{margin:0;font-family:Pretendard,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#efefef;color:#333;display:flex;min-height:100vh}
aside{width:240px;flex-shrink:0;background:#fdfdfd;border-right:1px solid #e9e8e8;padding:16px;overflow:auto;height:100vh;position:sticky;top:0}
aside h1{font-size:15px;margin:0 0 4px}aside p{font-size:12px;color:#888;margin:0 0 12px}aside a{display:block;padding:6px 8px;border-radius:6px;font-size:13px;color:#555;text-decoration:none}aside a.on{background:#f1edff;color:#845dde;font-weight:600}
aside small{display:block;margin:12px 0 4px;color:#aaa;font-size:11px}aside label{font-size:12px;color:#555;display:flex;gap:6px;align-items:center;margin-top:12px}
main{flex:1;display:grid;place-items:center;padding:24px}
.frame{background:#fff;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.12)}
.mobile .frame{width:375px;height:760px;border-radius:32px;border:8px solid #222}.desktop .frame{width:1024px;min-height:640px;border-radius:12px;border:1px solid #cfcfcf}
.screen{display:none;flex:1;overflow:auto;flex-direction:column}.screen.on{display:flex}
.bar{display:flex;align-items:center;gap:8px;height:48px;padding:0 12px;border-bottom:1px solid #e6e6e6;font-weight:600;font-size:15px}.bar .back{font-size:22px;color:#333;text-decoration:none}.bar-title{flex:1}
.pad{padding:6px 16px}h2{font-size:20px;margin:6px 0}p{margin:2px 0;font-size:14px;line-height:1.5}.muted{color:#888;font-size:12px}
.img{background:#ececf2;border-radius:10px;height:110px;display:grid;place-items:center;color:#888;font-size:12px}.img.tall{height:200px}
label{display:block;font-size:12px;color:#555;font-weight:600;margin-bottom:4px}.input{height:40px;border:1px solid #d6d6d6;border-radius:8px;padding:0 12px;display:flex;align-items:center;color:#a5a5a5;font-size:13px}
.btn{height:44px;border-radius:8px;display:grid;place-items:center;font-weight:600;font-size:14px;border:1px solid #cfcfcf}.btn.primary{background:#333;color:#fff;border-color:#333}
.chips{display:flex;gap:6px;overflow:auto}.chips span{flex-shrink:0;border:1px solid #d6d6d6;border-radius:99px;padding:4px 12px;font-size:12px}.chips span.on{background:#333;color:#fff;border-color:#333}
.card{border:1px solid #e2e2e2;border-radius:12px;padding:12px}.card .img{height:90px;margin-bottom:8px}
.list>div{padding:10px 16px;border-bottom:1px solid #eee}.rows>div{display:flex;justify-content:space-between;padding:6px 0;font-size:13px}
.tabs{display:flex;border-bottom:1px solid #e6e6e6}.tabs span{flex:1;text-align:center;padding:10px 0;font-size:13px;color:#888}.tabs span.on{color:#333;font-weight:700;border-bottom:2px solid #333}
.nav{display:flex;border-top:1px solid #e6e6e6;margin-top:auto;position:sticky;bottom:0;background:#fff}.nav span{flex:1;text-align:center;padding:12px 0;font-size:11px;color:#888}.nav span.on{color:#333;font-weight:700}
.screen>.nav-wrap{margin-top:auto}hr{border:0;border-top:1px solid #eee;margin:8px 16px}
a.hot{display:block;color:inherit;text-decoration:none;border-radius:8px;outline:2px solid transparent;outline-offset:-2px;cursor:pointer}
a.hot:hover,.show a.hot{outline-color:rgba(132,93,222,.55);background:rgba(132,93,222,.05)}
@media(max-width:800px){body{flex-direction:column}aside{width:auto;height:auto;position:static}.desktop .frame{width:100%}.mobile .frame{width:100%;max-width:375px}}`;

export function prototypeHtml(p: Project, w: WireSet): string {
  const byNode = new Map(w.pages.map((pg) => [pg.nodeId, pg.id]));
  const href = (to?: string) => (to && byNode.has(to) ? `#${byNode.get(to)}` : null);
  const screens = w.pages.map((pg) => {
    const nav = pg.els.filter((e) => e.t === "nav");
    const body = pg.els.filter((e) => e.t !== "nav");
    return `<section class="screen" id="s-${pg.id}" data-id="${pg.id}">${body.map((e) => el(e, href)).join("")}${nav.length ? `<div class="nav-wrap">${nav.map((e) => el(e, href)).join("")}</div>` : ""}</section>`;
  }).join("");
  const sections = [...new Set(w.pages.map((pg) => pg.section))];
  const menu = sections.map((s) => `<small>${esc(s)}</small>${w.pages.filter((pg) => pg.section === s).map((pg) => `<a href="#${pg.id}" data-id="${pg.id}">${esc(pg.name)}</a>`).join("")}`).join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)} 프로토타입</title><style>${CSS}</style></head>
<body class="${w.device}"><aside><h1>${esc(p.name)}</h1><p>화면 ${w.pages.length}개 · 보라 테두리를 누르면 연결된 화면으로 가요</p>${menu}<label><input type="checkbox" id="hl"> 누를 수 있는 곳 항상 보기</label></aside>
<main><div class="frame">${screens}</div></main>
<script>
var first=${JSON.stringify(w.pages[0]?.id ?? "")};
function show(){var id=location.hash.slice(1)||first;var s=document.getElementById("s-"+id)?id:first;
document.querySelectorAll(".screen").forEach(function(e){e.classList.toggle("on",e.dataset.id===s);if(e.dataset.id===s)e.scrollTop=0});
document.querySelectorAll("aside a").forEach(function(a){a.classList.toggle("on",a.dataset.id===s)})}
addEventListener("hashchange",show);show();
document.getElementById("hl").onchange=function(e){document.body.classList.toggle("show",e.target.checked)};
</script></body></html>`;
}

export function exportPrototype(p: Project): boolean {
  const w = currentWires(p);
  if (!w?.pages.length) return false;
  download(`${p.name}-프로토타입.html`, prototypeHtml(p, w), "text/html");
  return true;
}
