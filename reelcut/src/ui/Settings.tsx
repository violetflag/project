import { useEffect, useState } from "preact/hooks";
import { api, pickFolder } from "../api";
import { EFFORTS, MODELS } from "../agent";
import { CTX_DEFAULTS } from "../chats";
import { connectClaude, refreshCc, refreshModels, refreshQwen, saveNow, saveSettings, set, st, toast, useStore } from "../store";
import { SkillsSection } from "./SkillsSection";

export function SettingsView() {
  const s = useStore();
  const cfg = s.settings;
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState("");
  const [ccMsg, setCcMsg] = useState("");
  const cc = s.cc;
  useEffect(() => { if ((cfg.aiMode ?? "account") === "account") refreshCc(); }, [cfg.aiMode]);
  useEffect(() => { if (cfg.engine === "qwen") refreshQwen(true); }, [cfg.engine]);
  const q = s.qwen;
  const qs = s.qwenSetup;

  const testKey = async () => {
    setTesting("확인 중…");
    try {
      const r = await api.claude(cfg.apiKey, { model: cfg.model, max_tokens: 64, messages: [{ role: "user", content: "한 단어로 대답: 안녕" }], output_config: { effort: "low" } });
      const t = (r.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      setTesting(`연결됨 (${cfg.model}): ${t.slice(0, 40)}`);
    } catch (e) {
      setTesting("실패: " + String(e).slice(0, 200));
    }
  };

  const hw = s.info?.hw;
  return (
    <div class="settings">
      <h1>설정</h1>

      <section>
        <h2>AI 편집 (Claude)</h2>
        <label>연결 방식
          <select value={cfg.aiMode ?? "account"} onChange={(e) => saveSettings({ aiMode: (e.target as HTMLSelectElement).value as any })}>
            <option value="account">Claude 계정 (구독 사용량 안에서, 추가 비용 없음)</option>
            <option value="api">API 키 (쓴 만큼 따로 과금)</option>
          </select>
        </label>
        {(cfg.aiMode ?? "account") === "account" ? (
          <div class="qwen-box cc-box">
            <p class="muted">Claude Pro·Max 구독의 사용 한도 안에서 돌아가고, API 요금은 따로 나가지 않습니다. 처음 한 번 'Claude 계정 연결'을 누르면 Reelcut 전용 Claude Code(내려받기 약 150MB, 설치하면 약 340MB)를 Anthropic 공식 저장소에서 받아 오고, 브라우저에서 로그인합니다. 이 로그인은 Reelcut만 씁니다.</p>
            <ul class="facts">
              <li>계정: {cc == null ? "확인 중…" : cc.logged_in ? <span class="ok">{cc.account || "연결됨"}{cc.plan ? ` · ${cc.plan}` : ""}</span> : <span class="warn">연결 안 됨</span>}
                {cc?.logged_in && /api.?key|console/i.test(cc.method) && <span class="warn"> (구독이 아닌 API 방식으로 로그인되어 요금이 따로 나갈 수 있습니다)</span>}</li>
              {cc?.found && <li class="muted">Claude Code {cc.version}</li>}
              {cc?.error && <li class="warn">{cc.error.slice(0, 200)}</li>}
            </ul>
            {s.ccConnect && (
              <div>
                {s.ccConnect.state === "running" && s.ccConnect.pct < 100 && <div class="bar"><div style={{ width: `${s.ccConnect.pct}%` }} /></div>}
                <p class={s.ccConnect.state === "error" ? "warn" : "muted"}>{s.ccConnect.state === "running" && <span class="spin" />} {s.ccConnect.message}</p>
              </div>
            )}
            <div class="row">
              {!cc?.logged_in && <button class="primary" disabled={s.ccConnect?.state === "running"} onClick={() => connectClaude()}>Claude 계정 연결</button>}
              {cc?.logged_in && <button disabled={s.ccConnect?.state === "running"} onClick={() => connectClaude()}>다른 계정으로 연결</button>}
              {s.ccConnect?.state === "running" && <button onClick={() => set({ ccConnect: null })}>그만 기다리기</button>}
              <button onClick={async () => { setCcMsg("확인 중…"); const r = await refreshCc(); setCcMsg(r.logged_in ? "연결되어 있습니다." : ""); }}>다시 확인</button>
            </div>
            {ccMsg && <p class="muted">{ccMsg}</p>}
          </div>
        ) : (
          <>
            <label>Anthropic API 키
              <div class="row">
                <input type={show ? "text" : "password"} value={cfg.apiKey} placeholder="sk-ant-…" onInput={(e) => saveSettings({ apiKey: (e.target as HTMLInputElement).value.trim() })} style="flex:1" />
                <button onClick={() => setShow(!show)}>{show ? "숨기기" : "보기"}</button>
                <button onClick={testKey} disabled={!cfg.apiKey}>연결 확인</button>
              </div>
            </label>
            {testing && <p class="muted">{testing}</p>}
            <p class="muted">키는 이 PC의 앱 데이터 폴더에만 저장됩니다. API는 쓴 만큼 요금이 나갑니다.</p>
          </>
        )}
        <div class="row">
          <label>모델
            <select value={cfg.model} onChange={(e) => saveSettings({ model: (e.target as HTMLSelectElement).value })}>
              {MODELS.map((m) => <option value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label>생각 깊이
            <select value={cfg.effort} onChange={(e) => saveSettings({ effort: (e.target as HTMLSelectElement).value as any })}>
              {EFFORTS.map((m) => <option value={m.id}>{m.label}</option>)}
            </select>
          </label>
        </div>
        <label>AI에게 늘 알려 줄 것
          <textarea rows={3} value={cfg.aiNotes ?? ""} placeholder="예: 우리 아이는 쌍둥이(두 명)입니다. 아이를 따라갈 때는 둘을 함께 화면 가운데에 담아 주세요."
            onChange={(e) => saveSettings({ aiNotes: (e.target as HTMLTextAreaElement).value })} />
        </label>
        <p class="muted">새 대화에서도 AI가 항상 이 내용을 지킵니다.</p>
        <h3 class="sub">단축키</h3>
        <p class="muted">기능마다 키를 바꾸거나 Premiere Pro, Final Cut Pro, DaVinci Resolve 배열로 바꿀 수 있습니다.</p>
        <button class="small" onClick={() => set({ dialog: "shortcuts" })}>단축키 바꾸기…</button>
        <SkillsSection />
        <h3 class="sub">컨텍스트와 자동 요약</h3>
        <p class="muted">대화가 길어지면 한도의 {cfg.compactAt || 90}%에서 자동으로 요약해 {cfg.compactTo || 50}% 이하로 줄입니다. 지난 대화는 패널에 그대로 남습니다.</p>
        <div class="row">
          <label>Haiku 한도 (토큰)
            <input type="number" min={8000} max={2000000} step={1000} value={cfg.ctxHaiku || CTX_DEFAULTS.ctxHaiku} onChange={(e) => saveSettings({ ctxHaiku: Math.max(8000, Number((e.target as HTMLInputElement).value) || CTX_DEFAULTS.ctxHaiku) })} />
          </label>
          <label>다른 모델 한도 (토큰)
            <input type="number" min={8000} max={2000000} step={1000} value={cfg.ctxOther || CTX_DEFAULTS.ctxOther} onChange={(e) => saveSettings({ ctxOther: Math.max(8000, Number((e.target as HTMLInputElement).value) || CTX_DEFAULTS.ctxOther) })} />
          </label>
          <label>요약 시작 (%)
            <input type="number" min={50} max={99} step={1} value={cfg.compactAt || CTX_DEFAULTS.compactAt} onChange={(e) => saveSettings({ compactAt: Math.min(99, Math.max(50, Number((e.target as HTMLInputElement).value) || 90)) })} />
          </label>
          <label>요약 후 목표 (%)
            <input type="number" min={10} max={80} step={1} value={cfg.compactTo || CTX_DEFAULTS.compactTo} onChange={(e) => saveSettings({ compactTo: Math.min(80, Math.max(10, Number((e.target as HTMLInputElement).value) || 50)) })} />
          </label>
          <button class="small" onClick={() => saveSettings({ ...CTX_DEFAULTS })}>기본값 (90k · 950k · 90% → 50%)</button>
        </div>
      </section>

      <section>
        <h2>받아쓰기</h2>
        <label>엔진
          <select value={cfg.engine} onChange={(e) => saveSettings({ engine: (e.target as HTMLSelectElement).value })}>
            <option value="whisper">Whisper (whisper.cpp, 가볍고 빠름)</option>
            <option value="qwen">Qwen3-ASR 1.7B (더 정확, GPU 권장)</option>
          </select>
        </label>
        {cfg.engine === "qwen" && (
          <div class="qwen-box">
            <p class="muted">Qwen3-ASR-1.7B와 단어 시간을 맞추는 Qwen3-ForcedAligner-0.6B를 이 PC에서 돌립니다. 처음 한 번 설치가 필요합니다 (Python 환경 + PyTorch + 모델 약 6.5GB, 모두 앱 데이터 폴더 안).</p>
            {q && (
              <ul class="facts">
                <li>Python 환경: {q.env ? <span class="ok">있음</span> : "없음"} · qwen-asr: {q.package ? <span class="ok">설치됨</span> : "없음"} · 모델: {q.models ? <span class="ok">받음</span> : "없음"}</li>
                <li>{q.cuda ? <>GPU 사용: {q.gpu} ({q.vram_gb}GB)</> : q.env ? <span class="warn">GPU를 쓸 수 없어 CPU로 돌립니다 (느림)</span> : "GPU: 설치 후 확인"}</li>
                {q.error && <li class="warn">{q.error.slice(0, 300)}</li>}
              </ul>
            )}
            {qs?.state === "running" ? (
              <div>
                <div class="bar"><div style={{ width: `${qs.pct}%` }} /></div>
                <span>{qs.message} · {qs.pct.toFixed(0)}% </span>
                <button class="small" onClick={() => api.cancel("qwen-setup")}>취소</button>
              </div>
            ) : (
              <div class="row">
                <button class={q?.ready ? "small" : "small primary"} onClick={() => { set({ qwenSetup: { pct: 0, state: "running", message: "시작하는 중" } }); api.qwenSetup().catch((e) => toast(String(e))); }}>{q?.ready ? "다시 설치/업데이트" : "Qwen 받아쓰기 설치"}</button>
                <button class="small" onClick={() => refreshQwen(true)}>상태 확인</button>
              </div>
            )}
            {qs?.state === "error" && <pre class="errbox">{qs.message.slice(-1200)}</pre>}
          </div>
        )}
        {cfg.engine === "whisper" && s.info && !s.info.whisperOk && <p class="warn">받아쓰기 프로그램(whisper-cli)이 앱 폴더에 없습니다.</p>}
        <div class="row">
          <label>언어
            <select value={cfg.lang} onChange={(e) => saveSettings({ lang: (e.target as HTMLSelectElement).value })}>
              <option value="ko">한국어</option><option value="en">영어</option><option value="ja">일본어</option><option value="auto">자동 감지</option>
            </select>
          </label>
        </div>
        {cfg.engine === "whisper" && <>
        <table class="models">
          <tbody>
            {s.models.map((m) => {
              const dl = s.downloads[m.id];
              return (
                <tr key={m.id}>
                  <td><input type="radio" name="wm" checked={cfg.whisperModel === m.id} onChange={() => saveSettings({ whisperModel: m.id })} /></td>
                  <td>{m.label}</td>
                  <td class="muted">{m.size_mb} MB</td>
                  <td>
                    {m.downloaded ? <span class="ok">받음</span> : dl?.state === "running" ? (
                      <span>{dl.pct.toFixed(0)}% {dl.message} <button class="small" onClick={() => api.cancel("download")}>취소</button></span>
                    ) : (
                      <button class="small" onClick={() => { set({ downloads: { ...st.downloads, [m.id]: { pct: 0, state: "running", message: "" } } }); api.downloadModel(m.id).catch((e) => toast(String(e))); }}>내려받기</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button class="small" onClick={refreshModels}>새로 고침</button>
        </>}
        <label class="check"><input type="checkbox" checked={cfg.autoTranscribe} onChange={(e) => saveSettings({ autoTranscribe: (e.target as HTMLInputElement).checked })} /> 가져온 영상은 자동으로 받아쓰기</label>
      </section>

      <section>
        <h2>미디어와 내보내기</h2>
        <label>기본 내보내기 폴더
          <div class="row">
            <input value={cfg.exportDir || s.info?.videosDir || ""} readOnly style="flex:1" />
            <button onClick={async () => { const d = await pickFolder(); if (d) saveSettings({ exportDir: d }); }}>바꾸기</button>
          </div>
        </label>
      </section>

      <section>
        <h2>이 PC</h2>
        {hw ? (
          <ul class="facts">
            <li>그래픽카드: {hw.gpus.join(", ") || "알 수 없음"}</li>
            <li>GPU 인코더: AV1 {hw.av1 ?? "없음"} · HEVC {hw.hevc ?? "없음"} · H.264 {hw.h264 ?? "없음"}</li>
            <li>Reelcut 버전: {s.info?.version || "?"}</li>
            <li>CPU 스레드: {hw.threads}</li>
            <li>ffmpeg: {s.info?.ffmpegVersion || "없음"}</li>
            <li>
              데이터 폴더 (프로젝트·설정·받아쓰기 모델): <span class="muted">{s.info?.dataDir}</span>{" "}
              <button class="small" onClick={async () => { const d = await pickFolder(); if (d) { await saveNow(); api.setDataDir(d).catch((e) => toast(String(e))); } }}>바꾸기</button>{" "}
              <button class="small" onClick={async () => { await saveNow(); api.setDataDir("").catch((e) => toast(String(e))); }}>기본으로</button>
              <div class="muted">바꾸면 앱이 다시 시작됩니다. 큰 모델을 다른 드라이브에 두거나, 이미 받아 둔 모델 폴더를 쓸 때 바꾸세요.</div>
            </li>
          </ul>
        ) : <p class="muted">확인 중…</p>}
        <button class="small" onClick={async () => { const h = await api.hwInfo(true); set({ info: st.info ? { ...st.info, hw: h } : st.info }); toast("다시 확인했습니다"); }}>그래픽카드 다시 확인</button>
      </section>
    </div>
  );
}
