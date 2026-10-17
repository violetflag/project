"use client";

import { generateFlow } from "@/lib/actions";
import type { FlowKind, Project } from "@/lib/types";
import { EmptyDoc } from "./PrdView";

const W = 150, H = 40, GAP_X = 70, LANE_H = 110, LEFT = 150;

const LEGEND: [FlowKind, string][] = [["start", "시작"], ["page", "페이지"], ["layer", "팝업·시트"], ["branch", "분기"], ["end", "종료"]];

function Shape({ kind, x, y, label }: { kind: FlowKind; x: number; y: number; label: string }) {
  const common = { strokeWidth: 1.2 };
  const text = (
    <foreignObject x={x} y={y} width={W} height={H}>
      <div className="flex h-full items-center justify-center px-2 text-center text-[11px] leading-tight">{label}</div>
    </foreignObject>
  );
  if (kind === "start" || kind === "end")
    return <g><rect x={x} y={y} width={W} height={H} rx={20} fill={kind === "start" ? "#845dde" : "#555"} {...common} />
      <foreignObject x={x} y={y} width={W} height={H}><div className="flex h-full items-center justify-center text-[11px] text-white">{label}</div></foreignObject></g>;
  if (kind === "branch")
    return <g><polygon points={`${x + W / 2},${y - 6} ${x + W},${y + H / 2} ${x + W / 2},${y + H + 6} ${x},${y + H / 2}`} fill="#fdf2dc" stroke="#e4b65c" {...common} />{text}</g>;
  if (kind === "layer")
    return <g><polygon points={`${x + 14},${y} ${x + W},${y} ${x + W - 14},${y + H} ${x},${y + H}`} fill="#e6f1fb" stroke="#83a3c4" {...common} />{text}</g>;
  return <g><rect x={x} y={y} width={W} height={H} rx={4} fill="#f1edfb" stroke="#b8a6ea" {...common} />{text}</g>;
}

export function FlowView({ p }: { p: Project }) {
  if (!p.groups) return <EmptyDoc title="유저플로우가 여기에 생겨요" hint="기능명세서가 있어야 화면 흐름을 그릴 수 있어요." />;
  if (!p.flow) return (
    <EmptyDoc title="아직 유저플로우가 없어요" hint="기능명세서를 바탕으로 사용자가 지나가는 화면 흐름을 그려 드려요."
      action={<button onClick={() => generateFlow(p.id)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">유저플로우 만들기</button>} />
  );
  const { lanes, nodes, edges } = p.flow;
  const pos = new Map(nodes.map((n) => [n.id, { x: LEFT + n.col * (W + GAP_X), y: lanes.indexOf(n.lane) * LANE_H + (LANE_H - H) / 2 }]));
  const maxCol = Math.max(...nodes.map((n) => n.col));
  const width = LEFT + (maxCol + 1) * (W + GAP_X) + 40;
  const height = lanes.length * LANE_H;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-2 text-xs">
        <span className="truncate font-medium">{p.name}</span>
        <div className="ml-auto flex items-center gap-3 text-foreground-support">
          {LEGEND.map(([k, l]) => <span key={k} className="hidden items-center gap-1 md:flex"><svg width={18} height={12}><Shape kind={k} x={0} y={0} label="" /></svg>{l}</span>)}
          <button onClick={() => generateFlow(p.id)} className="rounded border border-border px-2 py-0.5">다시 그리기</button>
        </div>
      </div>
      <div className="flex-1 overflow-auto bg-background-canvas">
        <svg width={width} height={height} className="block">
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#999" /></marker>
          </defs>
          {lanes.map((l, i) => (
            <g key={l}>
              <rect x={0} y={i * LANE_H} width={width} height={LANE_H} fill={i % 2 ? "#f7f7f7" : "#fdfdfd"} />
              <foreignObject x={8} y={i * LANE_H + 8} width={LEFT - 20} height={40}><div className="text-[11px] text-foreground-muted">{l}</div></foreignObject>
            </g>
          ))}
          {edges.map((e, i) => {
            const a = pos.get(e.from), b = pos.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
            const mid = x2 > x1 ? (x1 + x2) / 2 : x1 + 20;
            const d = x2 > x1 ? `M${x1},${y1} H${mid} V${y2} H${x2 - 2}` : `M${a.x + W / 2},${a.y + H} V${(y1 + y2) / 2} H${b.x + W / 2} V${b.y - 2}`;
            return <path key={i} d={d} fill="none" stroke="#999" strokeWidth={1} markerEnd="url(#arr)" />;
          })}
          {nodes.map((n) => { const q = pos.get(n.id)!; return <Shape key={n.id} kind={n.kind} x={q.x} y={q.y} label={n.label} />; })}
        </svg>
      </div>
    </div>
  );
}
