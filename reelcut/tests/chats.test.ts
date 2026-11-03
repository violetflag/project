import { describe, expect, it } from "vitest";
import { compactBudget, CTX_DEFAULTS, ctxLimit, estTokens, fmtK, migrateChats, needsCompaction, recentWithin, seedText, titleFrom } from "../src/chats";
import { newDraft } from "../src/edit";
import type { ChatMsg, Project } from "../src/types";

const project = (extra: Partial<Project> = {}): Project => ({ id: "p", name: "p", created: 1, updated: 5, assets: [], folders: [], drafts: [newDraft("d")], ...extra });
const user = (t: string): ChatMsg => ({ role: "user", content: [{ type: "text", text: "<project-state>…</project-state>" }, { type: "text", text: t }] });
const ai = (t: string): ChatMsg => ({ role: "assistant", content: [{ type: "text", text: t }] });

describe("conversation sessions", () => {
  it("moves an old single conversation into the first session", () => {
    const p = migrateChats(project({ chat: [user("무음 정리해 줘"), ai("정리했습니다")], ccSession: "cc-1", chatMode: "account" }));
    expect(p.chats).toHaveLength(1);
    expect(p.chats![0]).toMatchObject({ title: "무음 정리해 줘", ccSession: "cc-1", chatMode: "account" });
    expect(p.chats![0].messages).toHaveLength(2);
    expect(p.activeChat).toBe(p.chats![0].id);
    expect(p.chat).toBeUndefined();
    expect(p.ccSession).toBeUndefined();
  });
  it("gives a project without a conversation one empty session", () => {
    const p = migrateChats(project());
    expect(p.chats).toHaveLength(1);
    expect(p.chats![0].messages).toEqual([]);
  });
  it("leaves migrated projects alone and repairs a missing active id", () => {
    const p = migrateChats(project());
    expect(migrateChats(p)).toBe(p);
    expect(migrateChats({ ...p, activeChat: "gone" }).activeChat).toBe(p.chats![0].id);
  });
  it("titles from the first request, about 30 characters", () => {
    expect(titleFrom("짧은 요청")).toBe("짧은 요청");
    const long = titleFrom("가".repeat(50));
    expect(long.length).toBe(30);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("context limits and compaction", () => {
  const s = { ...CTX_DEFAULTS };
  it("Haiku gets 90k, the others 950k", () => {
    expect(ctxLimit("claude-haiku-5-5", s)).toBe(90_000);
    expect(ctxLimit("claude-opus-5-5", s)).toBe(950_000);
    expect(ctxLimit(undefined, s)).toBe(950_000);
    expect(ctxLimit("claude-haiku-5-5", { ctxHaiku: 8000 })).toBe(8000);
  });
  it("compacts at 90% and aims at 50%", () => {
    expect(needsCompaction(80_999, 90_000, s)).toBe(false);
    expect(needsCompaction(81_000, 90_000, s)).toBe(true);
    expect(needsCompaction(undefined, 90_000, s)).toBe(false);
    expect(compactBudget(90_000, s)).toBe(45_000);
    expect(compactBudget(950_000, s)).toBe(475_000);
    expect(needsCompaction(600, 1000, { compactAt: 60 })).toBe(true);
  });
  it("keeps the newest turns that fit and the whole summary", () => {
    const msgs = Array.from({ length: 40 }, (_, i) => (i % 2 ? ai(`답 ${i} ` + "x".repeat(200)) : user(`질문 ${i} ` + "y".repeat(200))));
    const recent = recentWithin(msgs, 500);
    expect(recent).toContain("답 39");
    expect(recent).not.toContain("질문 0 ");
    expect(estTokens(recent)).toBeLessThanOrEqual(500);
    const seed = seedText("요약 내용", msgs, 2000);
    expect(seed.startsWith("<compacted-summary>\n요약 내용")).toBe(true);
    expect(estTokens(seed)).toBeLessThanOrEqual(2000);
    expect(seed).not.toContain("<project-state>");
  });
  it("formats token counts", () => {
    expect(fmtK(950_000)).toBe("950k");
    expect(fmtK(3400)).toBe("3.4k");
    expect(fmtK(420)).toBe("420");
  });
});
