import { useState } from "preact/hooks";
import { fileSrc, pickFiles } from "../api";
import { fmtTC } from "../edit";
import { createProject, deleteProject, importPaths, openProject, renameProject, useStore } from "../store";

const when = (ms: number) => {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function Home() {
  const s = useStore();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const list = s.projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));

  const startNew = async () => {
    const files = await pickFiles();
    const name = files[0] ? files[0].split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "") : "새 프로젝트";
    await createProject(name);
    if (files.length) await importPaths(files);
  };

  return (
    <div class="home">
      <div class="home-head">
        <h1>프로젝트</h1>
        <input class="search" placeholder="프로젝트 찾기" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <button class="primary" onClick={startNew}>＋ 새 프로젝트 (파일 고르기)</button>
        <button onClick={() => createProject("새 프로젝트")}>빈 프로젝트</button>
      </div>
      {!s.projects.length && (
        <div class="empty">
          <p>영상 파일을 이 창에 끌어다 놓거나 <b>새 프로젝트</b>를 누르세요.</p>
          <p class="muted">DJI Osmo 360의 .osv·.lrf 파일도 바로 열립니다. 받아쓰기와 AI 편집은 설정에서 모델과 API 키를 넣으면 켜집니다.</p>
        </div>
      )}
      <div class="grid">
        {list.map((p) => (
          <div key={p.id} class="card" onDblClick={() => openProject(p.id)}>
            <div class="thumb" onClick={() => openProject(p.id)}>
              {p.poster ? <img src={fileSrc(p.poster)} alt="" /> : <span class="muted">미디어 없음</span>}
            </div>
            <div class="meta">
              {editing === p.id ? (
                <input
                  autoFocus
                  defaultValue={p.name}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { renameProject(p.id, (e.target as HTMLInputElement).value.trim() || p.name); setEditing(null); }
                    if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={(e) => { renameProject(p.id, (e.target as HTMLInputElement).value.trim() || p.name); setEditing(null); }}
                />
              ) : (
                <b title={p.name} onClick={() => openProject(p.id)}>{p.name}</b>
              )}
              <span class="muted">{when(p.updated)} · 미디어 {p.assets} · 편집본 {p.drafts}{p.duration ? ` · ${fmtTC(p.duration)}` : ""}</span>
              <div class="row">
                <button class="small" onClick={() => openProject(p.id)}>열기</button>
                <button class="small" onClick={() => setEditing(p.id)}>이름 바꾸기</button>
                {confirmDel === p.id ? (
                  <>
                    <button class="small danger" onClick={() => { deleteProject(p.id); setConfirmDel(null); }}>정말 삭제</button>
                    <button class="small" onClick={() => setConfirmDel(null)}>취소</button>
                  </>
                ) : (
                  <button class="small" onClick={() => setConfirmDel(p.id)}>삭제</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
