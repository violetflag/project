// 파일 > 다른 이름으로 저장 and 파일 > 백업에서 되살리기 (2.18 project files).
import { Archive, FolderOpen, FolderSearch, MessagesSquare, RotateCcw } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { api, pickFiles, pickFolder, type FoundChat, type ProjectBackup } from "../api";
import { backupNow, recoverConversations, recoverGroup, relinkAssets, relinkFrom, restoreBackup, revealProjectFolder, saveProjectAs } from "../project";
import { st, toast, useStore } from "../store";
import { Modal } from "./Modal";

export function SaveAsDialog({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [name, setName] = useState(`${s.project?.name ?? "프로젝트"} 사본`);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const ok = await saveProjectAs(name);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal title="다른 이름으로 저장" onClose={onClose}
      footer={<><span class="spacer" /><button onClick={onClose}>취소</button><button class="primary" disabled={busy || !name.trim()} onClick={go}>저장</button></>}>
      <label>새 이름
        <input autoFocus value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) go(); }} />
      </label>
      <p class="muted">편집본, 미디어 목록, AI 대화와 작업 기록을 모두 복사한 새 프로젝트를 만들고 그것을 엽니다. 원래 프로젝트는 그대로 남습니다.</p>
    </Modal>
  );
}

const when = (ms: number) => {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const size = (b: number) => (b > 1 << 20 ? `${(b / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);
const REASON_TIP: Record<string, string> = {
  "열기": "그날 처음 열었을 때",
  "AI 작업 전": "AI에게 요청하기 직전",
  "전체 적용 전": "버튼을 편집본 전체에 적용하기 직전",
  "1시간마다": "작업 중 한 시간마다",
  "복구": "백업을 되살리기 직전 상태",
  "수동": "직접 만든 백업",
};

export function BackupsDialog({ onClose }: { onClose: () => void }) {
  useStore();
  const [list, setList] = useState<ProjectBackup[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const load = () => { const id = st.project?.id; if (id) api.projectBackups(id).then(setList).catch(() => setList([])); };
  useEffect(load, []);
  return (
    <Modal title="백업에서 되살리기" wide onClose={onClose}
      footer={<>
        <button onClick={() => revealProjectFolder()}><FolderOpen size={15} aria-hidden="true" /> 프로젝트 폴더 열기</button>
        <button onClick={async () => { await backupNow(); load(); }}><Archive size={15} aria-hidden="true" /> 지금 백업 만들기</button>
        <span class="spacer" />
        <button onClick={onClose}>닫기</button>
        <button class="primary" disabled={!pick} onClick={async () => { if (pick && (await restoreBackup(pick))) onClose(); }}><RotateCcw size={15} aria-hidden="true" /> 되살리기</button>
      </>}>
      <p class="muted">편집본과 미디어 목록을 고른 때로 되돌립니다. AI 대화는 그대로 두고, 지금 상태는 "복구" 백업으로 남겨 두므로 언제든 다시 바꿀 수 있습니다.</p>
      {list === null && <p class="muted">불러오는 중…</p>}
      {list?.length === 0 && <p class="muted">아직 백업이 없습니다. 프로젝트를 열 때, AI에게 요청할 때, 작업 중 한 시간마다 자동으로 만들어집니다.</p>}
      <div class="backup-list" role="listbox" aria-label="백업">
        {list?.map((b) => (
          <button role="option" aria-selected={pick === b.file} class={`backup-row ${pick === b.file ? "on" : ""}`} onClick={() => setPick(b.file)} onDblClick={async () => { if (await restoreBackup(b.file)) onClose(); }} title={b.file}>
            <span class="b-when">{when(b.time)}</span>
            <span class="b-why" title={REASON_TIP[b.reason] ?? ""}>{b.reason || "백업"}</span>
            <span class="muted b-size">{size(b.size)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** 홈 > 대화 복구: AI conversations whose project was deleted, made readable again. */
export function RecoverDialog({ onClose }: { onClose: () => void }) {
  const [found, setFound] = useState<FoundChat[] | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.recoverScan().then(setFound).catch((e) => { setFound([]); toast(String(e)); }); }, []);
  const groups = new Map<string, FoundChat[]>();
  for (const f of found ?? []) groups.set(recoverGroup(f), [...(groups.get(recoverGroup(f)) ?? []), f]);
  const chosen = (found ?? []).filter((f) => !off.has(f.session));
  const flip = (id: string) => { const n = new Set(off); n.has(id) ? n.delete(id) : n.add(id); setOff(n); };
  const go = async () => {
    setBusy(true);
    try {
      const n = await recoverConversations(chosen);
      toast(`대화 ${chosen.length}개를 프로젝트 ${n}개로 되살렸습니다`);
      onClose();
    } catch (e) { toast(`되살리지 못했습니다: ${String(e)}`); setBusy(false); }
  };
  return (
    <Modal title="대화 복구" wide onClose={onClose}
      footer={<><span class="spacer" /><button onClick={onClose}>닫기</button><button class="primary" disabled={busy || !chosen.length} onClick={go}><MessagesSquare size={15} aria-hidden="true" /> {chosen.length ? `${chosen.length}개 되살리기` : "되살리기"}</button></>}>
      <p class="muted">프로젝트를 지워도 AI(Claude 계정)와 나눈 대화는 이 PC에 남아 있습니다. 어느 프로젝트에도 연결되지 않은 대화를 찾아, 대화에 적힌 프로젝트 이름별로 새 프로젝트에 넣습니다. 미디어와 편집본은 대화에 없어서 빈 편집본으로 시작합니다. 원래 파일은 그대로 둡니다.</p>
      {found === null && <p class="muted">찾는 중…</p>}
      {found?.length === 0 && <p class="muted">되살릴 대화가 없습니다. 모든 대화가 프로젝트에 연결되어 있습니다.</p>}
      <div class="backup-list">
        {[...groups].map(([name, fs]) => (
          <div class="recover-group">
            <b>{name}</b>
            {fs.map((f) => (
              <label class="recover-row" title={f.first}>
                <input type="checkbox" checked={!off.has(f.session)} onChange={() => flip(f.session)} />
                <span class="b-when">{when(f.started)}</span>
                <span class="grow ellipsis">{f.title || f.first || "(내용 없음)"}</span>
                <span class="muted">메시지 {f.messages}</span>
              </label>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** Media whose file moved: find it in a folder (by name and size), or pick it by hand. */
export function RelinkDialog({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const list = (s.project?.assets ?? []).filter((a) => s.missing.includes(a.id));
  const search = async () => {
    const d = await pickFolder();
    if (!d) return;
    setBusy(true);
    setNote("찾는 중…");
    try {
      const r = await relinkFrom(d);
      setNote(r.found ? `${r.found}개를 다시 연결했습니다.${r.left ? ` ${r.left}개는 그 폴더에 없습니다.` : ""}` : "그 폴더와 하위 폴더에서 같은 이름·크기의 파일을 찾지 못했습니다.");
      if (!r.left) { toast(`미디어 ${r.found}개를 다시 연결했습니다`); onClose(); }
    } catch (e) { setNote(String(e)); }
    setBusy(false);
  };
  const one = async (id: string) => {
    const [f] = await pickFiles();
    if (f) await relinkAssets({ [id]: f });
  };
  return (
    <Modal title="원본 파일을 찾을 수 없습니다" wide onClose={onClose}
      footer={<><span class="spacer" /><button onClick={onClose}>나중에</button><button class="primary" disabled={busy || !list.length} onClick={search}><FolderSearch size={15} aria-hidden="true" /> 폴더에서 찾기…</button></>}>
      <p class="muted">이 프로젝트의 영상 {list.length}개가 원래 자리에 없습니다(옮겼거나, 외장 드라이브가 꽂혀 있지 않음). 옮긴 폴더를 고르면 하위 폴더까지 같은 이름과 크기의 파일을 찾아 다시 연결합니다. 편집 내용은 그대로입니다.</p>
      {note && <p class={note.startsWith("찾는") ? "muted" : ""}>{busy && <span class="spin" />} {note}</p>}
      <div class="backup-list">
        {list.map((a) => (
          <div class="recover-row relink-row" title={a.info.path}>
            <span class="grow ellipsis"><b>{a.info.name}</b> <span class="muted">{a.info.path}</span></span>
            <button class="small" onClick={() => one(a.id)}>직접 고르기…</button>
          </div>
        ))}
      </div>
      {!list.length && <p class="muted">모든 원본이 연결되어 있습니다.</p>}
    </Modal>
  );
}
