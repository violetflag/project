// 파일 > 다른 이름으로 저장 and 파일 > 백업에서 되살리기 (2.18 project files).
import { Archive, FolderOpen, RotateCcw } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { api, type ProjectBackup } from "../api";
import { backupNow, restoreBackup, revealProjectFolder, saveProjectAs } from "../project";
import { st, useStore } from "../store";
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
