export type Role = string;
export type Status = "draft" | "review" | "done";

export interface Feature {
  id: string;
  code: string;
  title: string;
  summary: string;
  rationale: string;
  success: string;
  criteria: string[];
  roles: Role[];
  status: Status;
  priority: 1 | 2 | 3;
  starred?: boolean;
}

export interface FeatureGroup {
  id: string;
  code: string;
  title: string;
  features: Feature[];
}

export interface PrdSection {
  id: string;
  title: string;
  blocks: { label: string; body: string }[];
}

export type FlowKind = "start" | "page" | "layer" | "branch" | "end";
export interface FlowNode {
  id: string;
  lane: string;
  kind: FlowKind;
  label: string;
  col: number;
}
export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
}
export interface Flow {
  lanes: string[];
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export type WireBlock =
  | { type: "header"; text: string }
  | { type: "input"; label: string }
  | { type: "select"; label: string }
  | { type: "list"; items: string[] }
  | { type: "card"; title: string; lines: string[] }
  | { type: "button"; text: string; primary?: boolean }
  | { type: "tabs"; items: string[] };

export interface Screen {
  id: string;
  name: string;
  main: WireBlock[];
  side: WireBlock[];
}

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
  question?: Question;
  answered?: string[];
  choices?: { question: string; options: ChatOption[]; picked?: string };
  actions?: ("generate-prd" | "more-questions" | "goto-features" | "run-review")[];
}

export type Perspective = "개발" | "사업" | "UX·디자인" | "QA" | "보안" | "운영";
export interface Finding {
  id: string;
  perspective: Perspective;
  level: "주의" | "제안";
  title: string;
  body: string;
  featureId?: string;
  state: "open" | "resolved" | "held";
}

export interface PendingChange {
  id: string;
  featureId: string;
  kind: "edit" | "add";
  groupId?: string;
  before?: Partial<Feature>;
  after: Partial<Feature>;
  reason: string;
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
  snapshot: string;
}

export interface LogEntry {
  id: string;
  at: number;
  text: string;
}

export interface Project {
  id: string;
  name: string;
  idea: string;
  createdAt: number;
  updatedAt: number;
  starred?: boolean;
  deletedAt?: number;
  questions: Question[];
  answers: Record<string, string[]>;
  chat: ChatMessage[];
  prd: PrdSection[] | null;
  groups: FeatureGroup[] | null;
  flow: Flow | null;
  screens: Screen[] | null;
  findings: Finding[] | null;
  pending: PendingChange[];
  comments: Comment[];
  decisions: Decision[];
  notes: Note[];
  versions: Version[];
  log: LogEntry[];
  settings: { language: string; tone: string };
}
