// Runs a script the AI wrote against the Reelcut SDK (sdk/reelcut.d.ts). The TypeScript is translated
// here and run in a worker with its network, storage and code-building features taken away, so all it
// can reach is the methods below. It can be stopped at any time, even inside an endless loop. All of
// its changes are one undo step, and if it fails or times out they are all taken back.
import { api } from "./api";
import { draftCaptions, wordKey } from "./captions";
import { clipDur, draftDuration, draftWords, gazeSpans, GAZE_MIN_FACE_360, is360, starts, uid } from "./edit";
import { asset, assetMap, beginUndoGroup, draft, mutate, set, st } from "./store";
import type { Asset, Draft } from "./types";

export type CallTool = (name: string, input: Record<string, unknown>) => Promise<string>;
type Ctx = { call: CallTool };

/** Tools a script may not call: those that publish, delete, ask the user or change skills. */
export const NOT_IN_SCRIPT = new Set(["run_script", "ask_options", "export_draft", "delete_draft", "save_skill", "delete_skill", "run_steps"]);

const need = (id: string): Asset => {
  const a = asset(id);
  if (!a) throw new Error(`미디어 없음: ${id}`);
  return a;
};
const draftOf = (id?: string | null): Draft => {
  const d = id ? st.project?.drafts.find((x) => x.id === id) : draft();
  if (!d) throw new Error(id ? `편집본 없음: ${id}` : "열린 편집본이 없습니다");
  return d;
};
const draftView = (d: Draft) => {
  const at = starts(d);
  return { id: d.id, name: d.name, aspect: d.aspect, fps: d.fps, duration: draftDuration(d), captions: d.captions, captionStyle: d.captionStyle, clips: d.clips.map((c, i) => ({ ...c, at: at[i], dur: clipDur(c) })), overlays: d.overlays ?? [], music: d.music, markers: d.markers, texts: d.texts ?? [] };
};
const range = (a: Asset, from?: number, to?: number): [number, number] => [from ?? 0, Math.min(to ?? a.info.duration, a.info.duration)];
const lensOf = (a: Asset) => (is360(a) ? { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 } : null);
/** The folders a script may look in: those holding the project's media, and the export folder. */
const allowedRoots = () => {
  const dirs = (st.project?.assets ?? []).map((a) => a.info.path.replace(/[\\/][^\\/]*$/, ""));
  return [...new Set([...dirs, exportFolder()])].filter(Boolean);
};
const exportFolder = () => st.settings.exportDir || st.info?.videosDir || "";

/** Every SDK method, by the path scripts call it with. Each must be declared in sdk/reelcut.d.ts. */
export const SDK: Record<string, (ctx: Ctx, ...a: any[]) => unknown> = {
  "project.assets": () => (st.project?.assets ?? []).map((a) => ({ id: a.id, name: a.info.name, path: a.info.path, kind: a.info.kind, duration: a.info.duration, width: a.info.width, height: a.info.height, fps: a.info.fps, is360: is360(a), hasAudio: a.info.has_audio, hasTranscript: !!a.words?.length, folder: a.folder, recorded: a.info.recorded })),
  "project.drafts": () => (st.project?.drafts ?? []).map((d) => ({ id: d.id, name: d.name, aspect: d.aspect, duration: draftDuration(d), clips: d.clips.length, open: d.id === st.draftId })),

  "drafts.get": (_, id?: string) => draftView(draftOf(id)),
  "drafts.create": async (c, o: { name: string; aspect?: string; clips: { assetId: string; start: number; end: number; speed?: number; view?: unknown }[] }) => {
    await c.call("create_draft", { name: o.name, aspect: o.aspect, clips: o.clips.map(({ assetId, ...r }) => ({ ...r, asset_id: assetId })) });
    return draftView(draftOf());
  },
  "drafts.edit": async (c, id: string | undefined, ops: unknown[]) => {
    const d = draftOf(id);
    await c.call("edit_draft", { draft_id: d.id, ops });
    return draftView(draftOf(d.id));
  },
  "drafts.duplicate": (_, id: string | undefined, name: string) => {
    const d = draftOf(id), copy: Draft = { ...d, id: uid(), name: String(name || `${d.name} 복사`), updated: Date.now() };
    mutate((p) => ({ ...p, drafts: [...p.drafts, copy] }));
    return draftView(copy);
  },
  "drafts.open": (_, id: string) => { set({ draftId: draftOf(id).id }); },

  "transcript.words": (_, id: string) => (need(id).words ?? []).map((w, i) => ({ key: `${id}:${i}`, text: w.t, start: w.s, end: w.e })),
  "transcript.draftWords": (_, id?: string) => draftWords(draftOf(id), assetMap()).map((w) => ({ key: wordKey(w), text: w.t, start: w.s, end: w.e, asset: w.asset, clip: w.clip, t0: w.t0, t1: w.t1 })),
  "transcript.search": (_, q: string) => (st.project?.assets ?? []).flatMap((a) => (a.words ?? []).flatMap((w, i) => (w.t.includes(String(q)) ? [{ key: `${a.id}:${i}`, text: w.t, start: w.s, end: w.e, asset: a.id }] : []))),
  "transcript.fix": (c, o: { assetId?: string; replace?: unknown[]; words?: unknown[] }) => c.call("fix_words", { asset_id: o.assetId, replace: o.replace, words: o.words }),

  "captions.lines": (_, id?: string) => {
    const d = draftOf(id);
    return draftCaptions(d, draftWords(d, assetMap())).lines.map((l) => ({ key: l.key, text: l.text, t0: l.t0, t1: l.t1, hidden: !!l.hidden, words: (l.words ?? []).map((w) => ({ key: wordKey(w), text: w.t, t0: w.t0, t1: w.t1 })) }));
  },
  "captions.edit": (c, id: string | undefined, ops: unknown[]) => c.call("edit_captions", { draft_id: id, ops }),
  "captions.style": (c, id: string | undefined, change: Record<string, unknown>) => c.call("set_captions", { enabled: true, ...change, draft_id: id }),
  "captions.translate": (c, id: string | undefined, lang: string, items: unknown[], show?: string) => c.call("set_translation", { draft_id: id, lang, items, show }),

  "visual.scenes": (c, query: string) => c.call("search_scenes", { query }),
  "visual.badShots": (c, id: string, from?: number, to?: number) => c.call("scan_bad_shots", { asset_id: id, from, to }),
  "visual.faces": (_, id: string, times: number[]) => {
    const a = need(id), lens = lensOf(a);
    if (!lens) throw new Error("360 영상이 아닙니다");
    return api.findFaces(a.info.path, lens, times);
  },
  "visual.gaze": async (_, id: string, from: number, to: number, step = 2) => {
    const a = need(id);
    return gazeSpans(await api.scanGaze(a.info.path, lensOf(a), from, to, step), step, is360(a) ? GAZE_MIN_FACE_360 : 0);
  },

  "multicam.sync": (c, ids: string[]) => c.call("sync_media", { asset_ids: ids }),
  "multicam.draft": (c, o: Record<string, unknown>) => c.call("multicam_draft", o),

  "analysis.loudness": (_, id: string, from?: number, to?: number) => { const a = need(id); return api.measure("loudness", a.info.path, ...range(a, from, to)); },
  "analysis.beats": (_, id: string, from?: number, to?: number) => { const a = need(id); return api.measure("beats", a.info.path, ...range(a, from, to)); },
  "analysis.sceneCuts": (_, id: string, from?: number, to?: number, threshold = 0) => { const a = need(id); return api.measure("scenes", a.info.path, ...range(a, from, to), threshold); },
  "analysis.audioEvents": (_, id: string, from?: number, to?: number) => { const a = need(id); return api.measure("events", a.info.path, ...range(a, from, to)); },

  "files.list": (_, dir: string) => api.scriptFiles("list", String(dir), "", allowedRoots()),
  "files.readText": (_, path: string) => api.scriptFiles("read", String(path), "", allowedRoots()),
  "files.writeText": (_, name: string, text: string) => api.scriptFiles("write", String(name), String(text), [exportFolder()]),

  "tools.call": (c, name: string, input?: Record<string, unknown>) => {
    if (NOT_IN_SCRIPT.has(name)) throw new Error(`스크립트에서는 ${name}을 쓸 수 없습니다`);
    return c.call(name, input ?? {});
  },
};

/** The worker's whole program. It builds the script, then removes everything that reaches outside. */
const WORKER = `"use strict";
(() => {
  const post = self.postMessage.bind(self), listen = self.addEventListener.bind(self);
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const timer = self.setTimeout.bind(self), ticker = self.setInterval.bind(self);
  const BLOCK = ["fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "importScripts", "indexedDB", "caches", "Worker", "SharedWorker", "BroadcastChannel", "WebTransport", "navigator", "location", "WebAssembly", "FileReaderSync", "FileSystemHandle", "requestFileSystemSync", "webkitRequestFileSystem", "webkitRequestFileSystemSync", "webkitResolveLocalFileSystemURL", "RTCPeerConnection", "RTCDataChannel", "Notification", "postMessage", "addEventListener", "onmessage", "close", "eval", "Function"];
  const lockdown = () => {
    for (const f of [function () {}, async function () {}, function* () {}, async function* () {}]) Object.defineProperty(Object.getPrototypeOf(f), "constructor", { value: undefined });
    for (const n of BLOCK) {
      for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) { try { delete o[n]; } catch {} }
      try { if (n in self) Object.defineProperty(self, n, { value: undefined, writable: false, configurable: false }); } catch {}
    }
    const onlyFn = (run) => (f, ...a) => { if (typeof f !== "function") throw new TypeError("함수만 넘길 수 있습니다"); return run(f, ...a); };
    self.setTimeout = onlyFn(timer);
    self.setInterval = onlyFn(ticker);
  };
  const logs = [];
  const text = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); } };
  const say = (...a) => { if (logs.length < 500) logs.push(a.map(text).join(" ")); };
  const con = { log: say, info: say, warn: say, error: say, debug: say };
  const pending = new Map();
  let next = 0;
  listen("message", (e) => {
    const m = e.data;
    if (m.t === "ret") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p) { if (m.ok) p.res(m.v); else p.rej(new Error(m.err)); }
      return;
    }
    if (m.t !== "start") return;
    const reelcut = {};
    for (const path of m.methods) {
      const [a, b] = path.split(".");
      (reelcut[a] ??= {})[b] = (...args) => new Promise((res, rej) => { const id = ++next; pending.set(id, { res, rej }); post({ t: "call", id, path, args }); });
    }
    let fn;
    try { fn = new AsyncFn("reelcut", "console", m.code); } catch (err) { post({ t: "done", ok: false, err: String(err), logs }); return; }
    lockdown();
    fn(reelcut, con).then(
      (v) => { let out; try { out = v === undefined ? undefined : JSON.parse(JSON.stringify(v)); } catch { out = String(v); } post({ t: "done", ok: true, v: out, logs }); },
      (err) => post({ t: "done", ok: false, err: String(err && err.stack || err), logs }),
    );
  });
})();
`;

/** Translates the script's TypeScript. Syntax errors come back with the script's own line numbers. */
export async function transpileScript(code: string): Promise<string> {
  const ts = (await import("typescript")).default;
  const wrapped = `async function __main() {\n${code}\n}\nreturn await __main();`;
  const source = ts.createSourceFile("script.ts", wrapped, ts.ScriptTarget.ES2022, true);
  const bad: string[] = [];
  const line = (pos: number) => source.getLineAndCharacterOfPosition(pos).line;
  const walk = (n: import("typescript").Node) => {
    if (n.kind === ts.SyntaxKind.ImportDeclaration || n.kind === ts.SyntaxKind.ImportEqualsDeclaration || (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) || ts.isMetaProperty(n)) {
      bad.push(`${line(n.getStart())}번째 줄: import는 쓸 수 없습니다. reelcut만 씁니다`);
    }
    ts.forEachChild(n, walk);
  };
  walk(source);
  const out = ts.transpileModule(wrapped, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, removeComments: true } });
  for (const d of out.diagnostics ?? []) {
    // The last line's return is ours, and legal where the worker puts it.
    const at = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start).line : 0;
    if (at > code.split("\n").length) continue;
    bad.push(`${at}번째 줄: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
  if (bad.length) throw new Error(`스크립트 오류\n${bad.join("\n")}`);
  return out.outputText;
}

export type ScriptOutcome = { value: unknown; logs: string[]; changed: boolean };

let stopRunning: (() => void) | null = null;
/** Stops the running script now; its changes are taken back. */
export const stopScript = () => stopRunning?.();

export async function runScript(code: string, o: { summary: string; timeoutMs: number; call: CallTool }): Promise<ScriptOutcome> {
  const js = await transpileScript(code);
  const group = beginUndoGroup(`AI 스크립트: ${o.summary}`.slice(0, 60));
  const url = URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" }));
  const worker = new Worker(url);
  try {
    const out = await new Promise<ScriptOutcome>((resolve, reject) => {
      const quit = (e: Error) => { (e as any).logs ??= []; reject(e); };
      const timer = setTimeout(() => quit(new Error(`시간 초과: ${Math.round(o.timeoutMs / 1000)}초 안에 끝나지 않아 멈췄습니다. 바뀐 것은 모두 되돌렸습니다.`)), o.timeoutMs);
      stopRunning = () => { clearTimeout(timer); quit(new Error("사용자가 멈췄습니다. 바뀐 것은 모두 되돌렸습니다.")); };
      worker.onerror = (e) => { clearTimeout(timer); quit(new Error(e.message || "스크립트 실행 오류")); };
      worker.onmessage = async (e) => {
        const m = e.data;
        if (m.t === "done") {
          clearTimeout(timer);
          if (m.ok) resolve({ value: m.v, logs: m.logs, changed: false });
          else { const err = new Error(`${m.err}\n바뀐 것은 모두 되돌렸습니다.`); (err as any).logs = m.logs; reject(err); }
          return;
        }
        if (m.t !== "call") return;
        try {
          const fn = SDK[m.path];
          if (!fn) throw new Error(`없는 기능: ${m.path}`);
          worker.postMessage({ t: "ret", id: m.id, ok: true, v: await fn({ call: o.call }, ...m.args) });
        } catch (err) {
          worker.postMessage({ t: "ret", id: m.id, ok: false, err: String((err as Error)?.message ?? err) });
        }
      };
      worker.postMessage({ t: "start", code: js, methods: Object.keys(SDK) });
    });
    return { ...out, changed: group.commit() };
  } catch (e) {
    group.rollback();
    throw e;
  } finally {
    stopRunning = null;
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}
