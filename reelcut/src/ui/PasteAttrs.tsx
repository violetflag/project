// Paste attributes: the chosen settings of the copied clip onto the selected clip, or every clip.
import { useState } from "preact/hooks";
import { attrSource } from "../commands";
import { CLIP_ATTRS, isGap, pasteAttrs } from "../edit";
import { draft, editDraft, st, toast } from "../store";
import { player } from "./Viewer";
import { Modal } from "./Modal";

export function PasteAttrsDialog({ onClose }: { onClose: () => void }) {
  const [on, setOn] = useState<string[]>(["color"]);
  const [all, setAll] = useState(false);
  const go = () => {
    const from = attrSource, d = draft();
    if (!from || !d) return onClose();
    let n = 0;
    editDraft("속성 붙여넣기", (x) => ({
      ...x,
      clips: x.clips.map((c) => {
        if (isGap(c) || c.id === from.id || (!all && c.id !== st.selClip)) return c;
        n++;
        return pasteAttrs(c, from, on);
      }),
    }));
    player.refresh();
    toast(`클립 ${n}개에 붙여 넣었습니다`);
    onClose();
  };
  return (
    <Modal title="속성 붙여넣기" onClose={onClose}>
      {CLIP_ATTRS.map((g) => (
        <label class="check"><input type="checkbox" checked={on.includes(g.id)} onChange={(e) => setOn((e.target as HTMLInputElement).checked ? [...on, g.id] : on.filter((x) => x !== g.id))} /> {g.label}</label>
      ))}
      <label class="check"><input type="checkbox" checked={all} onChange={(e) => setAll((e.target as HTMLInputElement).checked)} /> 이 편집본의 모든 클립에</label>
      <div class="row"><span class="spacer" /><button class="small" onClick={onClose}>취소</button><button class="small primary" disabled={!on.length} onClick={go}>붙여넣기</button></div>
    </Modal>
  );
}
