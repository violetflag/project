import type { Flow, FlowEdge, FlowKind } from "./types";

// Deterministic auto layout: each section is a horizontal band; inside a band nodes sit in
// columns by graph depth (longest path from the entry points over the whole graph).

export const NODE_SIZE: Record<FlowKind, [number, number]> = {
  start: [132, 40], page: [152, 46], data: [152, 44], branch: [128, 72], action: [124, 48],
};
export const LEFT = 168; // room for band titles
const COL_W = 236;
const ROW_H = 96;
const PAD = 14;

export interface Box { x: number; y: number; w: number; h: number; cx: number; cy: number }
export interface Band { section: string; y: number; h: number }
export interface FlowLayout {
  boxes: Record<string, Box>;
  bands: Band[];
  width: number;
  height: number;
  back: Set<string>; // edge ids that point against the flow
}

const isReturn = (e: FlowEdge) => !!e.label?.trim().startsWith("↩") || /^[YN]?\s*↩/.test(e.label ?? "");

export function layoutFlow(flow: Pick<Flow, "sections" | "nodes" | "edges">): FlowLayout {
  const { nodes } = flow;
  const ids = new Set(nodes.map((n) => n.id));
  const edges = flow.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const sections = [...flow.sections, ...new Set(nodes.map((n) => n.section).filter((s) => !flow.sections.includes(s)))];

  // Back edges: returns ("↩ …") plus whatever closes a cycle in a DFS from the entry points.
  const back = new Set(edges.filter(isReturn).map((e) => e.id));
  const out = new Map<string, FlowEdge[]>(nodes.map((n) => [n.id, []]));
  edges.forEach((e) => !back.has(e.id) && out.get(e.from)!.push(e));
  const state = new Map<string, 1 | 2>();
  const visit = (v: string) => {
    state.set(v, 1);
    for (const e of out.get(v)!) {
      const s = state.get(e.to);
      if (s === 1) back.add(e.id);
      else if (!s) visit(e.to);
    }
    state.set(v, 2);
  };
  [...nodes.filter((n) => n.kind === "start"), ...nodes].forEach((n) => !state.has(n.id) && visit(n.id));

  // Longest path depth over the remaining DAG (Kahn order).
  const fwd = edges.filter((e) => !back.has(e.id));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  fwd.forEach((e) => indeg.set(e.to, indeg.get(e.to)! + 1));
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const v = queue.shift()!;
    order.push(v);
    for (const e of fwd) {
      if (e.from !== v) continue;
      depth.set(e.to, Math.max(depth.get(e.to)!, depth.get(v)! + 1));
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (!indeg.get(e.to)) queue.push(e.to);
    }
  }
  // Sources sit just left of their first target (e.g. "알림 진입" next to the page it opens).
  for (const v of [...order].reverse()) {
    if (fwd.some((e) => e.to === v)) continue;
    const kids = fwd.filter((e) => e.from === v).map((e) => depth.get(e.to)!);
    if (kids.length) depth.set(v, Math.max(0, Math.min(...kids) - 1));
  }

  // Each band starts at the left edge, so later sections don't trail off far to the right.
  for (const s of sections) {
    const own = nodes.filter((n) => n.section === s);
    const min = Math.min(...own.map((n) => depth.get(n.id)!));
    own.forEach((n) => depth.set(n.id, depth.get(n.id)! - min));
  }

  // Band heights: the busiest column decides how many rows a band needs.
  const rowsOf = new Map<string, number>();
  for (const s of sections) {
    const perCol = new Map<number, number>();
    nodes.filter((n) => n.section === s).forEach((n) => perCol.set(depth.get(n.id)!, (perCol.get(depth.get(n.id)!) ?? 0) + 1));
    rowsOf.set(s, Math.max(1, ...perCol.values()));
  }
  const bands: Band[] = [];
  let y = 0;
  for (const s of sections) {
    const h = PAD * 2 + rowsOf.get(s)! * ROW_H;
    bands.push({ section: s, y, h });
    y += h;
  }
  const bandOf = new Map(bands.map((b) => [b.section, b]));

  // Rows: walk columns left to right; each node tries the row nearest its parents.
  const cy = new Map<string, number>();
  const maxCol = Math.max(0, ...depth.values());
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  for (let c = 0; c <= maxCol; c++) {
    for (const band of bands) {
      const col = nodes.filter((n) => n.section === band.section && depth.get(n.id) === c);
      if (!col.length) continue;
      const want = (id: string) => {
        const ps = fwd.filter((e) => e.to === id && cy.has(e.from)).map((e) => cy.get(e.from)!);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
      };
      const rows = rowsOf.get(band.section)!;
      const taken = new Set<number>();
      const sorted = col.map((n) => ({ id: n.id, w: want(n.id) }))
        .sort((a, b) => (a.w ?? Infinity) - (b.w ?? Infinity) || index.get(a.id)! - index.get(b.id)!);
      for (const { id, w } of sorted) {
        const ideal = w == null ? 0 : Math.round((w - band.y - PAD - ROW_H / 2) / ROW_H);
        let best = -1;
        for (let d = 0; d < rows * 2 && best < 0; d++) {
          for (const r of [ideal + d, ideal - d]) if (r >= 0 && r < rows && !taken.has(r)) { best = r; break; }
        }
        if (best < 0) best = [...Array(rows).keys()].find((r) => !taken.has(r)) ?? 0;
        taken.add(best);
        cy.set(id, band.y + PAD + best * ROW_H + ROW_H / 2);
      }
    }
  }

  const boxes: Record<string, Box> = {};
  for (const n of nodes) {
    const [w, h] = NODE_SIZE[n.kind];
    const cx = LEFT + depth.get(n.id)! * COL_W + COL_W / 2;
    const c = cy.get(n.id) ?? (bandOf.get(n.section)?.y ?? 0) + PAD + ROW_H / 2;
    boxes[n.id] = { x: cx - w / 2, y: c - h / 2, w, h, cx, cy: c };
  }
  return { boxes, bands, width: LEFT + (maxCol + 1) * COL_W + 60, height: Math.max(y, ROW_H), back };
}

// Orthogonal path with rounded corners through the given points.
function rounded(pts: [number, number][], r = 8) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const r1 = Math.min(r, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const ax = x - Math.sign(x - px) * r1, ay = y - Math.sign(y - py) * r1;
    const bx = x + Math.sign(nx - x) * r1, by = y + Math.sign(ny - y) * r1;
    d += ` L${ax},${ay} Q${x},${y} ${bx},${by}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return `${d} L${lx},${ly}`;
}

// Label goes in the middle of the longest segment.
function labelAt(pts: [number, number][]) {
  let best = 0, at: [number, number] = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (len > best) { best = len; at = [(pts[i][0] + pts[i - 1][0]) / 2, (pts[i][1] + pts[i - 1][1]) / 2]; }
  }
  return at;
}

// Routes an edge between box sides. Forward edges go right; edges going back or within a column
// loop around (below the boxes, or along their right side). lane spreads parallel loops apart.
export function routeEdge(a: Box, b: Box, lane = 0): { d: string; lx: number; ly: number } {
  let pts: [number, number][];
  if (b.cx > a.cx + 1) {
    const x1 = a.x + a.w, x2 = b.x;
    if (Math.abs(a.cy - b.cy) < 1) pts = [[x1, a.cy], [x2, b.cy]];
    else {
      // Trunk right after the source, so a fan-out shares it and each label sits by its target.
      const mx = x1 + 22 + (lane % 3) * 5;
      pts = [[x1, a.cy], [mx, a.cy], [mx, b.cy], [x2, b.cy]];
      if (x2 - mx > 60) return { d: rounded(pts), lx: (mx + x2) / 2, ly: b.cy };
    }
  } else if (Math.abs(b.cx - a.cx) <= 1) {
    const x = Math.max(a.x + a.w, b.x + b.w) + 18 + (lane % 3) * 6;
    pts = [[a.x + a.w, a.cy], [x, a.cy], [x, b.cy], [b.x + b.w, b.cy]];
  } else {
    const yy = Math.max(a.y + a.h, b.y + b.h) + 16 + (lane % 3) * 6;
    const ax = a.cx - 10 - (lane % 2) * 8, bx = b.cx + 10 + (lane % 2) * 8;
    pts = [[ax, a.y + a.h], [ax, yy], [bx, yy], [bx, b.y + b.h]];
  }
  const [lx, ly] = labelAt(pts);
  return { d: rounded(pts), lx, ly };
}
