// Draft tabs above the timeline (like sequence tabs): switch, add, and a menu to rename,
// duplicate or delete.
import { Copy, Pencil, Plus, Trash2 } from "lucide-preact";
import { useState } from "preact/hooks";
import { draftDuration, fmtTC, newDraft, uid } from "../edit";
import { draft, editDraft, set, setDrafts, useStore } from "../store";

export function DraftTabs() {
  const s = useStore();
  const p = s.project!;
  const d = draft();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const open = (id: string) => set({ draftId: id, sourceId: null, playhead: 0, selClip: null, selItem: null });

  const dup = (id: string) => {
    const x = p.drafts.find((y) => y.id === id);
    if (!x) return;
    const c = { ...structuredClone(x), id: uid(), name: x.name + " 사본" };
    setDrafts("편집본 복제", [...p.drafts, c], c.id);
  };
  const del = (id: string) => {
    if (p.drafts.length < 2) return;
    const x = p.drafts.find((y) => y.id === id)!;
    const rest = p.drafts.filter((y) => y.id !== id);
    setDrafts(`편집본 삭제 "${x.name}"`, rest, d?.id === id ? rest[0].id : d?.id ?? rest[0].id);
  };

  return (
    <div class="draft-tabs" role="tablist" aria-label="편집본" onClick={() => setMenu(null)}>
      {p.drafts.map((x) => (
        renaming === x.id ? (
          <input class="tab-edit" autoFocus defaultValue={x.name} aria-label="편집본 이름"
            onKeyDown={(e) => {
              if (e.key === "Enter") { const v = (e.target as HTMLInputElement).value.trim(); if (v) editDraft("이름 바꾸기", (y) => ({ ...y, name: v }), x.id, false); setRenaming(null); }
              if (e.key === "Escape") setRenaming(null);
            }} onBlur={() => setRenaming(null)} />
        ) : (
          <button role="tab" aria-selected={x.id === s.draftId} class={`dtab ${x.id === s.draftId && !s.sourceId ? "on" : ""}`}
            onClick={() => open(x.id)} onDblClick={() => setRenaming(x.id)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ id: x.id, x: e.clientX, y: e.clientY }); }}
            title={`${x.name} · ${fmtTC(draftDuration(x))} · ${x.aspect} · ${x.fps}fps (두 번 클릭: 이름 바꾸기, 오른쪽 클릭: 메뉴) · Sequence`}>
            {x.name} <span class="muted">{fmtTC(draftDuration(x))}</span>
          </button>
        )
      ))}
      <button class="icon-btn" aria-label="새 편집본" title="새 편집본 · New Sequence"
        onClick={() => { const nd = newDraft(`편집본 ${p.drafts.length + 1}`, d?.aspect, d?.fps); setDrafts("새 편집본", [...p.drafts, nd], nd.id); set({ playhead: 0, sourceId: null }); }}>
        <Plus size={15} />
      </button>
      {menu && (
        <div class="ctx" style={{ left: `${menu.x}px`, top: `${Math.max(8, menu.y - 120)}px` }} role="menu" onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => { setRenaming(menu.id); setMenu(null); }}><Pencil size={13} /> 이름 바꾸기</button>
          <button role="menuitem" onClick={() => { dup(menu.id); setMenu(null); }}><Copy size={13} /> 복제</button>
          <button role="menuitem" class="danger" disabled={p.drafts.length < 2} onClick={() => { del(menu.id); setMenu(null); }}><Trash2 size={13} /> 삭제</button>
        </div>
      )}
    </div>
  );
}
