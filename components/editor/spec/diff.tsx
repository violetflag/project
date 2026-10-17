"use client";

// Word-level diff (LCS over words and spaces) to show AI edits: removed text struck through, new text highlighted.
export type Seg = { t: string; k: "same" | "add" | "del" };

export function wordDiff(a: string, b: string): Seg[] {
  const A = a.split(/(\s+)/).filter(Boolean);
  const B = b.split(/(\s+)/).filter(Boolean);
  // Very long texts: fall back to whole replacement to keep the table small.
  if (A.length * B.length > 250_000) return [...(a ? [{ t: a, k: "del" as const }] : []), ...(b ? [{ t: b, k: "add" as const }] : [])];
  const L = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) {
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out: Seg[] = [];
  const push = (t: string, k: Seg["k"]) => {
    const last = out[out.length - 1];
    if (last?.k === k) last.t += t; else out.push({ t, k });
  };
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { push(A[i], "same"); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push(A[i++], "del");
    else push(B[j++], "add");
  }
  while (i < A.length) push(A[i++], "del");
  while (j < B.length) push(B[j++], "add");
  return out;
}

export function DiffText({ before, after, className = "" }: { before: string; after: string; className?: string }) {
  return (
    <p className={`whitespace-pre-line ${className}`}>
      {wordDiff(before, after).map((s, i) => s.k === "same" ? <span key={i}>{s.t}</span>
        : s.k === "del" ? <del key={i} className="bg-red-50 text-red-500/80 decoration-red-400">{s.t}</del>
        : <ins key={i} className="rounded-sm bg-primary-soft text-primary no-underline">{s.t}</ins>)}
    </p>
  );
}

// Sentence-list diff: removed sentences struck, new ones highlighted, changed ones word-diffed.
export function DiffList({ before, after, bullet = "•" }: { before: string[]; after: string[]; bullet?: string }) {
  const rows: { a?: string; b?: string }[] = [];
  const used = new Set<number>();
  after.forEach((b) => {
    const k = before.findIndex((a, i) => !used.has(i) && a === b);
    if (k >= 0) { used.add(k); rows.push({ a: b, b }); return; }
    rows.push({ b });
  });
  // Pair leftover removed sentences with new ones in order so small rewrites show as word diffs.
  const removed = before.filter((_, i) => !used.has(i));
  for (const r of rows) if (r.a === undefined && removed.length) r.a = removed.shift();
  rows.push(...removed.map((a) => ({ a })));
  return (
    <ul className="space-y-1">
      {rows.map((r, i) => (
        <li key={i} className="flex gap-2 text-sm leading-relaxed">
          <span className="text-foreground-muted">{bullet}</span>
          {r.a !== undefined && r.b !== undefined
            ? <DiffText before={r.a} after={r.b} className="flex-1" />
            : r.b !== undefined
              ? <ins className="flex-1 rounded-sm bg-primary-soft text-primary no-underline">{r.b}</ins>
              : <del className="flex-1 text-red-500/80">{r.a}</del>}
        </li>
      ))}
    </ul>
  );
}
