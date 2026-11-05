import { FolderOpen, Pencil, Plus, Trash2 } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { api, fileSrc, pickFiles } from "../api";
import { fmtTC } from "../edit";
import { createProject, deleteProject, importPaths, loadProjects, openProject, renameProject, set, toast, useStore } from "../store";
import { Modal } from "./Modal";

const when = (ms: number) => {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const PURPOSE = [
  { id: "16:9", label: "유튜브", desc: "가로 16:9", aspect: "16:9" },
  { id: "9:16", label: "쇼츠·릴스", desc: "세로 9:16", aspect: "9:16" },
  { id: "1:1", label: "정사각", desc: "1:1", aspect: "1:1" },
  { id: "4:5", label: "인스타 피드", desc: "4:5", aspect: "4:5" },
  { id: "360", label: "360 영상", desc: "Osmo 360 → 일반 영상 16:9", aspect: "16:9" },
];

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("16:9");
  const [fps, setFps] = useState(30);
  const make = async (withFiles: boolean) => {
    const files = withFiles ? await pickFiles() : [];
    if (withFiles && !files.length) return;
    const p = PURPOSE.find((x) => x.id === purpose)!;
    const n = name.trim() || (files[0] ? files[0].split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "") : "새 프로젝트");
    onClose();
    await createProject(n, p.aspect, fps);
    if (files.length) await importPaths(files);
  };
  return (
    <Modal title="새 프로젝트" onClose={onClose}
      footer={<><span class="spacer" /><button onClick={() => make(false)}>빈 프로젝트</button><button class="primary" onClick={() => make(true)}><FolderOpen size={15} aria-hidden="true" /> 파일 골라서 만들기</button></>}>
      <label>이름<input autoFocus value={name} placeholder="비우면 첫 파일 이름" onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
      <p class="label">용도</p>
      <div class="purposes small" role="radiogroup" aria-label="용도">
        {PURPOSE.map((p) => (
          <button role="radio" aria-checked={purpose === p.id} class={`purpose ${purpose === p.id ? "on" : ""}`} onClick={() => setPurpose(p.id)}><b>{p.label}</b><span class="muted">{p.desc}</span></button>
        ))}
      </div>
      <label>프레임 레이트
        <select value={String(fps)} onChange={(e) => setFps(Number((e.target as HTMLSelectElement).value))}>
          {[24, 25, 30, 50, 60].map((x) => <option value={String(x)}>{x}fps{x === 30 ? " (대부분)" : x === 60 ? " (부드러운 움직임)" : ""}</option>)}
        </select>
      </label>
      <p class="muted">나중에 편집본마다 바꿀 수 있습니다. 파일은 창에 끌어다 놓아도 됩니다.</p>
    </Modal>
  );
}

export function Home() {
  const [trash, setTrash] = useState<{ file: string; at: number; name?: string; drafts?: number; assets?: number }[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const loadTrash = () => api.storeTrashList().then(setTrash).catch(() => {});
  useEffect(() => { loadTrash(); }, []);
  const s = useStore();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "name" | "created">("recent");
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const list = s.projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) =>
    sort === "name" ? a.name.localeCompare(b.name, "ko") : sort === "created" ? b.created - a.created : b.updated - a.updated);
  const empty = s.projects.filter((p) => !p.assets && !p.clips && p.id !== s.project?.id);

  return (
    <div class="home">
      <div class="home-head">
        <h1>프로젝트</h1>
        <input class="search" placeholder="프로젝트 찾기" aria-label="프로젝트 찾기" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as any)} aria-label="정렬">
          <option value="recent">최근 수정</option><option value="created">만든 날</option><option value="name">이름</option>
        </select>
        <span class="spacer" />
        {empty.length > 0 && <button onClick={() => Promise.all(empty.map((p) => deleteProject(p.id))).then(loadTrash)} title="미디어도 편집도 없는 프로젝트를 지웁니다">빈 프로젝트 {empty.length}개 정리</button>}
        <button onClick={() => setShowTrash(true)} title="지운 프로젝트를 되살립니다"><Trash2 size={15} aria-hidden="true" /> 휴지통{trash.length ? ` ${trash.length}` : ""}</button>
        <button class="primary" onClick={() => set({ dialog: "newProject" })}><Plus size={15} aria-hidden="true" /> 새 프로젝트</button>
      </div>
      {showTrash && (
        <Modal title="휴지통" onClose={() => setShowTrash(false)}>
          {!trash.length && <p class="muted">지운 프로젝트가 없습니다.</p>}
          {trash.map((t) => (
            <div class="row trash-row" key={t.file}>
              <span class="grow"><b>{t.name ?? t.file}</b> <span class="muted">{when(t.at)}에 지움 · 미디어 {t.assets ?? 0} · 편집본 {t.drafts ?? 0}</span></span>
              <button class="small" onClick={() => api.storeRestore(t.file).then(() => { loadProjects(); loadTrash(); toast("프로젝트를 되살렸습니다"); }).catch((e) => toast(String(e)))}>되살리기</button>
            </div>
          ))}
        </Modal>
      )}
      {!s.projects.length && (
        <div class="empty">
          <p>영상 파일을 이 창에 끌어다 놓거나 <b>새 프로젝트</b>를 누르세요.</p>
          <p class="muted">DJI Osmo 360의 .osv·.lrf 파일도 바로 열립니다. 받아쓰기와 AI 편집은 설정에서 켭니다.</p>
        </div>
      )}
      <div class="grid">
        {list.map((p) => (
          <div key={p.id} class="card" onDblClick={() => openProject(p.id)}>
            <button class="thumb" onClick={() => openProject(p.id)} aria-label={`${p.name} 열기`}>
              {p.poster ? <img src={fileSrc(p.poster)} alt="" /> : <span class="muted">미디어 없음</span>}
              {p.duration > 0 && <span class="dur">{fmtTC(p.duration)}</span>}
            </button>
            <div class="meta">
              {editing === p.id ? (
                <input autoFocus defaultValue={p.name} aria-label="프로젝트 이름"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { renameProject(p.id, (e.target as HTMLInputElement).value.trim() || p.name); setEditing(null); }
                    if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={(e) => { renameProject(p.id, (e.target as HTMLInputElement).value.trim() || p.name); setEditing(null); }} />
              ) : (
                <b title={p.name} onClick={() => openProject(p.id)}>{p.name}</b>
              )}
              <span class="muted">{when(p.updated)} · 미디어 {p.assets} · 편집본 {p.drafts}</span>
              <div class="row card-actions">
                <button class="icon-btn" onClick={() => setEditing(p.id)} aria-label="이름 바꾸기" title="이름 바꾸기"><Pencil size={14} /></button>
                {confirmDel === p.id ? (
                  <>
                    <button class="small danger" onClick={() => { deleteProject(p.id).then(loadTrash); setConfirmDel(null); toast("휴지통으로 옮겼습니다. 언제든 되살릴 수 있습니다"); }}>휴지통으로</button>
                    <button class="small" onClick={() => setConfirmDel(null)}>취소</button>
                  </>
                ) : (
                  <button class="icon-btn" onClick={() => setConfirmDel(p.id)} aria-label="삭제" title="삭제"><Trash2 size={14} /></button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
