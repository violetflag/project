"use client";

import { useConnectorModal } from "./ConnectorModal";
import { ArrowRight } from "./icons";

export function ConnectPill() {
  const open = useConnectorModal();
  return (
    <button onClick={open}
      className="group inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/50 py-2 pr-2.5 pl-2 text-xs text-foreground-support transition-colors hover:border-border-strong">
      <span className="flex -space-x-1">
        {["#f08a3c", "#69a4e8", "#845dde"].map((c) => (
          <span key={c} className="h-3.5 w-3.5 rounded-full border border-background" style={{ background: c }} />
        ))}
      </span>
      사용 중인 AI · 이슈 트래커와 연결하기
      <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
