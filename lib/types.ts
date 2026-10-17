import type { FlowPlanOp } from "./flow-local";
export type Role = string;
export type Status = "draft" | "review" | "done";
export const STATUS_LABEL: Record<Status, string> = { draft: "기획 작성중", review: "검토중", done: "확정" };

// --- Feature spec: requirement (1) → feature (2) → detail (3) --------------

export type SlotKey = "pre" | "trigger" | "action" | "result" | "exception" | "display" | "access" | "rule" | "data";
export const SLOTS: [SlotKey, string][] = [
  ["pre", "선행조건"], ["trigger", "트리거"], ["action", "동작"], ["result", "결과"], ["exception", "예외"],
  ["display", "표시"], ["access", "권한 & 접근"], ["rule", "비즈니스 규칙"], ["data", "데이터"],
];

// An undecided point the AI left inside a slot; answering it rewrites that slot.
export interface SlotQuestion {
  id: string;
  slot: SlotKey;
  text: string;
  options: string[];
  recommended?: number;
}

// Set while an AI change waits for approval. prev is the item before an edit.
export interface ItemPending {
  kind: "new" | "edit" | "delete";
  prev?: SpecCore;
  reason?: string;
}

export interface SpecCore {
  title: string;
  summary: string;
  rationale?: string;
  success?: string;
  criteria?: string[];
  roles: Role[];
  status: Status;
  priority: 1 | 2 | 3;
  slots?: Partial<Record<SlotKey, string[]>>;
  offSlots?: SlotKey[];
  questions?: SlotQuestion[];
}

export interface SpecItem extends SpecCore {
  id: string;
  code: string; // R-ABCDEF / F-ABCDEF / S-ABCDEF
  level: 1 | 2 | 3;
  starred?: boolean;
  pending?: ItemPending;
  children: SpecItem[];
}

// --- PRD ---------------------------------------------------------------------

export interface PrdSection {
  id: string;
  title: string;
  blocks: { label: string; body: string }[];
}
export interface PrdProps {
  category: string;
  roles: Role[];
  devices: string[];
}

// --- User flow -----------------------------------------------------------------

export type FlowKind = "start" | "page" | "data" | "branch" | "action";
export interface FlowNode {
  id: string;
  section: string;
  kind: FlowKind;
  label: string;
}
export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}
export interface Flow {
  id: string;
  name: string;
  at: number;
  sections: string[];
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// --- Wireframe -------------------------------------------------------------------
// Each element may carry `to`: the id of the flow page it opens, which makes a clickable prototype.

export type WireEl = { id: string; to?: string } & (
  | { t: "bar"; title: string; back?: boolean }
  | { t: "heading"; text: string }
  | { t: "text"; text: string; muted?: boolean }
  | { t: "image"; label: string; tall?: boolean }
  | { t: "input"; label: string; placeholder?: string }
  | { t: "button"; text: string; primary?: boolean }
  | { t: "chips"; items: string[] }
  | { t: "card"; title: string; lines: string[]; image?: boolean }
  | { t: "list"; items: { title: string; sub?: string }[] }
  | { t: "rows"; items: { label: string; value: string }[] }
  | { t: "tabs"; items: string[]; active?: number }
  | { t: "nav"; items: string[]; active?: number }
  | { t: "divider" }
);

export interface WirePage {
  id: string;
  nodeId: string; // flow page node
  name: string;
  section: string;
  els: WireEl[];
  at: number;
}
export interface WireSet {
  id: string;
  flowId: string;
  device: "mobile" | "desktop";
  note?: string;
  pages: WirePage[];
  at: number;
}

// --- Chat, review, docs ---------------------------------------------------------

export interface Question {
  id: string;
  text: string;
  multi: boolean;
  options: string[];
}

export interface ChatOption {
  title: string;
  detail: string;
}

export interface ChatMessage {
  id: string;
  from: "user" | "ai";
  text: string;
  thinking?: boolean;
  error?: boolean;
  // Visible work steps of the assistant, e.g. "문서 읽음", "기능 작성 완료".
  steps?: string[];
  question?: Question;
  answered?: string[];
  choices?: { question: string; options: ChatOption[]; picked?: string };
  actions?: ("generate-prd" | "more-questions" | "goto-features" | "goto-flow" | "goto-wire" | "run-review" | "complete-spec" | "make-flow" | "make-wire")[];
  // A user-flow change planned from chat; applied only when the user presses a button on it.
  flowPlan?: { summary: string; ops: FlowPlanOp[]; flowId: string; done?: "applied" | "copied" | "dismissed" };
}

export type Perspective = "개발" | "사업" | "UX" | "디자인" | "QA" | "보안";
export const PERSPECTIVES: Perspective[] = ["개발", "사업", "UX", "디자인", "QA", "보안"];
export interface Finding {
  id: string;
  perspective: Perspective;
  level: "주의" | "제안";
  title: string;
  body: string;
  scenario?: string;
  evidence?: string;
  featureId?: string;
  // How to resolve it, proposed with the finding; [해결] applies it.
  fix?: string;
  state: "open" | "resolved" | "held";
  // ai: [해결] applied the fix; chat: solved by picking an option in chat. Resolved findings stay closed.
  resolvedBy?: "ai" | "chat";
}

export interface Comment {
  id: string;
  featureId?: string;
  author: string;
  text: string;
  at: number;
  resolved?: boolean;
}

export interface Decision {
  id: string;
  state: "확정" | "미정" | "기각";
  text: string;
  source: string;
  applied?: boolean;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  at: number;
}

export interface Version {
  id: string;
  name: string;
  at: number;
  auto?: boolean;
  summary?: string;
  snapshot: string;
}

export interface LogEntry {
  id: string;
  at: number;
  text: string;
}

export interface ProjectSettings {
  language: string;
  tone: string;
  style?: string; // 기획서 문체
  format?: string; // 기능 설명 양식
  terms?: string; // 팀 용어
  avoid?: string; // 하지 말아야 할 것
  extra?: string; // 그 밖에 알아둘 것
}

export interface Project {
  id: string;
  name: string;
  idea: string;
  // Files attached on the home screen. Text is kept here; PDFs and images live in IndexedDB.
  materials?: { name: string; kind: "text" | "pdf" | "image"; text?: string }[];
  createdAt: number;
  updatedAt: number;
  starred?: boolean;
  deletedAt?: number;
  questions: Question[];
  answers: Record<string, string[]>;
  chat: ChatMessage[];
  prd: PrdSection[] | null;
  prdProps?: PrdProps;
  spec: SpecItem[] | null;
  flows: Flow[];
  flowId?: string;
  wires: WireSet[];
  wireId?: string;
  // Later tabs whose source changed since they were made; the sync button refreshes them.
  // prd: PRD edits made in the PRD tab that the chat has not yet checked against the other documents.
  stale?: { flow?: boolean; wire?: boolean; prd?: string[] };
  findings: Finding[] | null;
  comments: Comment[];
  decisions: Decision[];
  notes: Note[];
  versions: Version[];
  log: LogEntry[];
  settings: ProjectSettings;
  schema?: 2;
}
