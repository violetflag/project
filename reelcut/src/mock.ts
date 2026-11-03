// Browser stand-in for the Rust commands, used by UI tests (no files, no ffmpeg).
import type { JobEvent, MediaInfo } from "./types";

const subs: ((e: JobEvent) => void)[] = [];
const emit = (e: JobEvent) => setTimeout(() => subs.forEach((s) => s(e)), 30);
export const listen = async (cb: (e: JobEvent) => void) => {
  subs.push(cb);
  return () => { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); };
};

const evSubs: Record<string, ((p: any) => void)[]> = {};
const fire = (name: string, p: any) => setTimeout(() => (evSubs[name] ?? []).slice().forEach((f) => f(p)), 10);
export const listenEvent = async (name: string, cb: (p: any) => void) => {
  (evSubs[name] ??= []).push(cb);
  return () => { const a = evSubs[name]; const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); };
};

// "Claude 계정" mode: replays window.__mockClaude (same script shape as the API mock) as Claude Code
// stream-json lines, and sends tool calls through the "cc-tool" event like the real MCP bridge.
const ccWait = new Map<string, (v: any) => void>();
let ccStopped = false;
async function mockCcRun(a: any) {
  ccStopped = false;
  const sid = a.session || "mock-session-1";
  (window as any).__ccRuns = [...((window as any).__ccRuns ?? []), { ...a, tools: undefined, toolNames: (a.tools ?? []).map((t: any) => t.name) }];
  fire("cc", { kind: "line", data: { type: "system", subtype: "init", session_id: sid } });
  const messages: any[] = [{ role: "user", content: a.prompt }];
  let n = 0;
  for (let turn = 0; turn < 20; turn++) {
    await new Promise((r) => setTimeout(r, 20));
    if (ccStopped) { fire("cc", { kind: "exit", ok: false, err: "" }); return; }
    const h = (window as any).__mockClaude;
    const res = h ? h({ model: a.model, system: a.system, messages }) : { content: [{ type: "text", text: "(모의 응답) Claude 계정으로 연결되었습니다." }] };
    const content = (res.content ?? []).map((b: any) => (b.type === "tool_use" ? { ...b, name: "mcp__reelcut__" + b.name } : b));
    fire("cc", { kind: "line", data: { type: "assistant", message: { role: "assistant", content }, session_id: sid, parent_tool_use_id: null } });
    messages.push({ role: "assistant", content: res.content });
    const uses = content.filter((b: any) => b.type === "tool_use");
    if (!uses.length) {
      await new Promise((r) => setTimeout(r, 20));
      fire("cc", { kind: "line", data: { type: "result", subtype: "success", is_error: false, result: "", session_id: sid } });
      await new Promise((r) => setTimeout(r, 20));
      fire("cc", { kind: "exit", ok: true, err: "" });
      return;
    }
    const results: any[] = [];
    for (const u of uses) {
      const id = "m" + ++n;
      const r: any = await new Promise((res2) => { ccWait.set(id, res2); fire("cc-tool", { id, name: u.name, input: u.input }); });
      const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      results.push({ type: "tool_result", tool_use_id: u.id, content: text, is_error: r.isError });
    }
    fire("cc", { kind: "line", data: { type: "user", message: { role: "user", content: results }, session_id: sid, parent_tool_use_id: null } });
    messages.push({ role: "user", content: results });
  }
}

const ls = {
  get: (k: string) => { try { return localStorage.getItem("rc:" + k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem("rc:" + k, v); } catch { /* */ } },
  del: (k: string) => { try { localStorage.removeItem("rc:" + k); } catch { /* */ } },
  keys: () => { try { return Object.keys(localStorage).filter((k) => k.startsWith("rc:")).map((k) => k.slice(3)); } catch { return []; } },
};

function info(path: string): MediaInfo {
  const name = path.split(/[\\/]/).pop()!;
  const ext = name.split(".").pop()!.toLowerCase();
  const is360 = ["osv", "lrf", "lrv", "insv"].includes(ext);
  const audio = ["mp3", "wav", "m4a"].includes(ext);
  return {
    path, name, ext, kind: audio ? "audio" : "video", size: 50_000_000, duration: audio ? 60 : 20,
    width: audio ? 0 : is360 ? 3840 : 1920, height: audio ? 0 : is360 ? 1920 : 1080, fps: audio ? 0 : 30,
    vcodec: audio ? "" : "h264", acodec: "aac", channels: 2, has_audio: true,
    videos: is360 && ext === "osv" ? [{ index: 0, width: 1920, height: 1920, codec: "hevc" }, { index: 1, width: 1920, height: 1920, codec: "hevc" }] : [],
    djmd: is360, layout360: ext === "osv" ? "dual" : is360 ? "dfisheye" : "none", lrf: null, created: Date.now(), recorded: "", bit_depth: 8,
  };
}

const words = () => {
  const t = "안녕하세요 음 오늘은 동네 공원에 왔습니다 어 날씨가 정말 좋네요 여기서 잠깐 쉬었다가 갈게요 그럼 출발해 보겠습니다".split(" ");
  let s = 0.5;
  return t.map((w, i) => { const r = { s, e: s + 0.4 + w.length * 0.05, t: w }; s = r.e + (i === 6 ? 2.0 : 0.15); return r; });
};

export async function invoke(cmd: string, a: any = {}): Promise<any> {
  switch (cmd) {
    case "app_info": return { version: "1.0.1", ffmpeg: "mock", ffmpegOk: true, ffmpegVersion: "mock", whisper: "", whisperOk: true, dataDir: "/data", cacheDir: "/cache", hw: { threads: 8, gpus: ["Mock GPU"], ffmpeg_version: "7.1", tested: [], av1: "av1_nvenc", hevc: "hevc_nvenc", h264: "h264_nvenc", has_x265: true, has_x264: true, has_opus: true }, platform: "web", videosDir: "C:/Users/me/Videos" };
    case "hw_info": return (await invoke("app_info")).hw;
    case "store_get": return ls.get(a.name);
    case "store_set": ls.set(a.name, a.value); return;
    case "store_delete": ls.del(a.name); return;
    case "store_list": return ls.keys().filter((k) => k.startsWith(a.prefix));
    case "expand_paths": return a.paths.map((p: string) => [p, ""]);
    case "inspect": return info(a.path);
    case "calibrate_360": return { on: true, fov: 192.4, yaw: 0.6, pitch: -0.3, roll: 0.2, gain_a: [0.97, 1.2, -0.8], gain_b: [1.031, -1.2, 0.8], calibrated: true, before: 6.1, after: 2.3 };
    case "motion_info": return { source: "gyro", note: "축 맞춤 오차 4% · 시간차 +0ms · 롤링셔터 12.0ms", readout: 0.012, product: "Osmo 360" };
    case "live_url": return "";
    case "live_stop": return false;
    case "analyze_motion": emit({ id: a.id, kind: "motion", pct: 100, state: "done", message: "", result: null }); return;
    case "filmstrip": case "poster": return "/mock/poster.jpg";
    case "waveform": return Array.from({ length: Math.round(20 * 50) }, (_, i) => (Math.floor(i / 50) % 5 === 3 ? 10 : 150 + ((i * 37) % 80)));
    case "frames": return a.req.times.map(() => "");
    case "eq_sheet": return a.req.times.map(() => "");
    case "contact_sheet": return "";
    case "whisper_models": return [{ id: "turbo", label: "large-v3-turbo", file: "x", size_mb: 574, downloaded: true }, { id: "base", label: "base", file: "y", size_mb: 148, downloaded: false }];
    case "download_model": emit({ id: a.id, kind: "download", pct: 100, state: "done", message: "", result: "" }); return;
    case "qwen_status": return { env: true, package: true, models: true, ready: true, cuda: true, gpu: "Mock GPU", vram_gb: 12, torch: "2.9", error: "" };
    case "set_data_dir": return;
    case "qwen_setup": emit({ id: "qwen", kind: "qwen-setup", pct: 100, state: "done", message: "", result: null }); return;
    case "transcribe": emit({ id: a.id, kind: "transcribe", pct: 100, state: "done", message: "", result: { lang: "ko", words: words() } }); return;
    case "export": emit({ id: a.id, kind: "export", pct: 100, state: "done", message: "", result: { path: a.plan.out, size: 12_345_678, seconds: 3, duration: 10 } }); (window as any).__lastPlan = a.plan; return a.plan.out;
    case "cancel": return 1;
    case "reveal": return;
    case "path_exists": return true;
    case "initial_files": return [];
    case "cc_status": return (window as any).__mockCcStatus ?? { found: true, path: "C:/Users/me/.local/bin/claude.exe", version: "2.1.0", logged_in: true, method: "claude.ai", account: "me@example.com", plan: "max", error: "" };
    case "cc_login": (window as any).__ccOpened = cmd; if ((window as any).__mockCcStatus) (window as any).__mockCcStatus = { ...(window as any).__mockCcStatus, logged_in: true, account: "me@example.com", plan: "max", method: "claude.ai" }; return;
    case "cc_setup":
      (window as any).__ccSetup = true;
      [30, 70].forEach((pct, i) => setTimeout(() => subs.forEach((f) => f({ id: "claude", kind: "cc-setup", pct, state: "running", message: "Claude Code 내려받는 중", result: null })), 40 * (i + 1)));
      setTimeout(() => { if ((window as any).__mockCcStatus) (window as any).__mockCcStatus = { ...(window as any).__mockCcStatus, found: true, version: "2.1.317" }; subs.forEach((f) => f({ id: "claude", kind: "cc-setup", pct: 100, state: "done", message: "", result: {} })); }, 150);
      return;
    case "cc_run": mockCcRun(a); return;
    case "cc_answer": { const f = ccWait.get(a.id); ccWait.delete(a.id); f?.(a.result); return !!f; }
    case "cc_stop": ccStopped = true; ccWait.forEach((f) => f({ content: [{ type: "text", text: "멈춤" }], isError: true })); ccWait.clear(); return true;
    case "claude": {
      const h = (window as any).__mockClaude;
      if (h) return h(a.body);
      return { content: [{ type: "text", text: "(모의 응답) 설정에서 API 키를 넣으면 실제 Claude가 답합니다." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } };
    }
  }
  throw new Error("mock: unknown command " + cmd);
}
