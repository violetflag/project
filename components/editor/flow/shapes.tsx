"use client";

import type { Box } from "@/lib/flow-layout";
import type { FlowKind } from "@/lib/types";

export const KIND_STYLE: Record<FlowKind, { fill: string; stroke: string; text: string }> = {
  start: { fill: "var(--color-primary)", stroke: "var(--color-primary)", text: "#fff" },
  page: { fill: "var(--flow-page-fill)", stroke: "var(--flow-page-stroke)", text: "var(--color-foreground)" },
  data: { fill: "var(--flow-data-fill)", stroke: "var(--flow-data-stroke)", text: "var(--flow-data-text)" },
  branch: { fill: "var(--flow-branch-fill)", stroke: "var(--flow-branch-stroke)", text: "var(--flow-branch-text)" },
  action: { fill: "var(--flow-action-fill)", stroke: "var(--flow-action-stroke)", text: "var(--flow-action-text)" },
};

// The outline of a node; used for the canvas and the legend.
export function ShapePath({ kind, b, selected }: { kind: FlowKind; b: Pick<Box, "x" | "y" | "w" | "h">; selected?: boolean }) {
  const s = KIND_STYLE[kind];
  const stroke = selected ? "var(--color-primary)" : s.stroke;
  const sw = selected ? 2.2 : 1.2;
  const { x, y, w, h } = b;
  if (kind === "start") return <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={s.fill} stroke={selected ? "#4b2fa0" : stroke} strokeWidth={sw} />;
  if (kind === "page") return <rect x={x} y={y} width={w} height={h} rx={4} fill={s.fill} stroke={stroke} strokeWidth={sw} />;
  if (kind === "data") {
    const k = Math.min(14, w / 6);
    return <polygon points={`${x + k},${y} ${x + w},${y} ${x + w - k},${y + h} ${x},${y + h}`} fill={s.fill} stroke={stroke} strokeWidth={sw} />;
  }
  if (kind === "branch") return <polygon points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} fill={s.fill} stroke={stroke} strokeWidth={sw} />;
  return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={s.fill} stroke={stroke} strokeWidth={sw} />;
}

export function LegendIcon({ kind }: { kind: FlowKind }) {
  const box = kind === "branch" ? { x: 2, y: 0.5, w: 14, h: 13 } : kind === "action" ? { x: 2, y: 1, w: 14, h: 12 } : { x: 1, y: 2, w: 16, h: 10 };
  return <svg width={18} height={14} aria-hidden><ShapePath kind={kind} b={box} /></svg>;
}
