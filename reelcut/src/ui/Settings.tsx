import { useState } from "preact/hooks";
import { api, pickFolder } from "../api";
import { EFFORTS, MODELS } from "../agent";
import { refreshModels, saveSettings, set, st, toast, useStore } from "../store";

export function SettingsView() {
  const s = useStore();
  const cfg = s.settings;
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState("");

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
        <label>Anthropic API 키
          <div class="row">
            <input type={show ? "text" : "password"} value={cfg.apiKey} placeholder="sk-ant-…" onInput={(e) => saveSettings({ apiKey: (e.target as HTMLInputElement).value.trim() })} style="flex:1" />
            <button onClick={() => setShow(!show)}>{show ? "숨기기" : "보기"}</button>
            <button onClick={testKey} disabled={!cfg.apiKey}>연결 확인</button>
          </div>
        </label>
        {testing && <p class="muted">{testing}</p>}
        <p class="muted">키는 이 PC의 앱 데이터 폴더에만 저장됩니다.</p>
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
      </section>

      <section>
        <h2>받아쓰기 (whisper)</h2>
        {s.info && !s.info.whisperOk && <p class="warn">받아쓰기 프로그램(whisper-cli)이 앱 폴더에 없습니다.</p>}
        <div class="row">
          <label>언어
            <select value={cfg.lang} onChange={(e) => saveSettings({ lang: (e.target as HTMLSelectElement).value })}>
              <option value="ko">한국어</option><option value="en">영어</option><option value="ja">일본어</option><option value="auto">자동 감지</option>
            </select>
          </label>
        </div>
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
        <label class="check"><input type="checkbox" checked={cfg.autoTranscribe} onChange={(e) => saveSettings({ autoTranscribe: (e.target as HTMLInputElement).checked })} /> 가져온 영상은 자동으로 받아쓰기</label>
      </section>

      <section>
        <h2>미디어와 내보내기</h2>
        <label class="check"><input type="checkbox" checked={cfg.autoProxy} onChange={(e) => saveSettings({ autoProxy: (e.target as HTMLInputElement).checked })} /> 가져올 때 미리보기 파일(프록시) 만들기 — 큰 파일·360 영상도 부드럽게 재생</label>
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
            <li>CPU 스레드: {hw.threads}</li>
            <li>ffmpeg: {s.info?.ffmpegVersion || "없음"}</li>
            <li class="muted">데이터 폴더: {s.info?.dataDir}</li>
          </ul>
        ) : <p class="muted">확인 중…</p>}
        <button class="small" onClick={async () => { const h = await api.hwInfo(true); set({ info: st.info ? { ...st.info, hw: h } : st.info }); toast("다시 확인했습니다"); }}>그래픽카드 다시 확인</button>
      </section>
    </div>
  );
}
