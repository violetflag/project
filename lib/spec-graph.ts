import type { SpecItem } from "./types";

// Tree layout of the 기능 그래프: PRD on the left, then 요구사항 → 기능 → 상세 기능 columns.
export const COL = { 0: 0, 1: 270, 2: 560, 3: 880 } as const;
export const W = { 0: 210, 1: 230, 2: 250, 3: 230 } as const;
export const ROW = 62;
export const COLORS = ["#78b08a", "#7ab7b9", "#83a3c4", "#9989b5", "#adbf6e", "#c7ab65", "#d18578"];

export interface GraphNode { x: SpecItem; cx: number; cy: number; w: number; color: string; parent?: GraphNode }

export function graphLayout(items: SpecItem[], shown: Set<string> | null) {
  const nodes: GraphNode[] = [];
  let top = 20;
  const place = (x: SpecItem, color: string, parent?: GraphNode): GraphNode => {
    const kids = x.children.filter((c) => !shown || shown.has(c.id));
    const n: GraphNode = { x, cx: COL[x.level], cy: 0, w: W[x.level], color, parent };
    nodes.push(n);
    if (!kids.length) { n.cy = top + ROW / 2; top += ROW; return n; }
    const placed = kids.map((c) => place(c, color, n));
    n.cy = (placed[0].cy + placed[placed.length - 1].cy) / 2;
    return n;
  };
  const roots = items.filter((x) => !shown || shown.has(x.id)).map((x, i) => place(x, COLORS[i % COLORS.length]));
  const height = Math.max(top + 20, 200);
  const rootY = roots.length ? (roots[0].cy + roots[roots.length - 1].cy) / 2 : height / 2;
  return { nodes, roots, height, rootY };
}
