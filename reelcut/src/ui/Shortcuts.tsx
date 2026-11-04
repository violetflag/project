// Shortcut list (Ctrl+/) and where they are changed: every command with its keys, grouped like the
// menus, with a filter, a key layout to start from, and a "press the new key" capture on each row.
import { useEffect, useState } from "preact/hooks";
import { applyKeymap, COMMANDS, eventKey, KEY_LAYOUTS, keyLabel } from "../commands";
import { saveSettings, st, toast, useStore } from "../store";
import { Modal } from "./Modal";

/** Saves a set of changes and applies them at once. */
function save(keys: Record<string, string>) {
  saveSettings({ keys });
  applyKeymap(keys);
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useStore();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const ql = q.trim().toLowerCase();
  const list = COMMANDS.filter((c) => !ql || c.label.toLowerCase().includes(ql) || (c.term ?? "").toLowerCase().includes(ql) || (c.keys ?? "").toLowerCase().includes(ql));
  const menus = [...new Set(list.map((c) => c.menu))];
  const over = st.settings.keys ?? {};

  useEffect(() => {
    if (!editing) return;
    const on = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      if (e.key === "Escape") return setEditing(null);
      const k = eventKey(e);
      const next = { ...(st.settings.keys ?? {}), [editing]: k };
      // A key does one thing: the command that had it loses it.
      for (const c of COMMANDS) {
        if (c.id === editing || !c.keys?.split("|").includes(k)) continue;
        next[c.id] = c.keys.split("|").filter((b) => b !== k).join("|");
        toast(`"${c.label}"에 있던 ${keyLabel(k)}를 옮겼습니다`);
      }
      save(next);
      setEditing(null);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [editing]);

  return (
    <Modal title="단축키" onClose={onClose} wide>
      <div class="row">
        <input class="search" style="flex:1" autoFocus placeholder="기능이나 키로 찾기" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="단축키 찾기" />
        <label>배열
          <select value="" onChange={(e) => { const l = KEY_LAYOUTS.find((x) => x.id === (e.target as HTMLSelectElement).value); if (l) { save(l.keys); toast(`${l.label} 배열로 바꿨습니다`); } }}>
            <option value="">고르기…</option>
            {KEY_LAYOUTS.map((l) => <option value={l.id}>{l.label}</option>)}
          </select>
        </label>
      </div>
      <p class="muted tip">키 칸을 누르고 새 키를 누르면 바뀝니다. Esc는 취소입니다.</p>
      <div class="keys-grid">
        {menus.map((m) => (
          <section>
            <h3>{m}</h3>
            <table class="keys">
              <tbody>
                {list.filter((c) => c.menu === m).map((c) => (
                  <tr>
                    <td>{c.label}{c.term && <span class="muted"> · {c.term}</span>}</td>
                    <td class="kbd-cell">
                      <button class={`key-btn ${editing === c.id ? "on" : ""}`} aria-label={`${c.label} 단축키 바꾸기`} onClick={() => setEditing(c.id)}>
                        {editing === c.id ? "새 키 누르기…" : c.keys ? c.keys.split("|").map((k) => <kbd>{keyLabel(k)}</kbd>) : <span class="muted">없음</span>}
                      </button>
                      {c.id in over && <button class="tb" title="기본으로" aria-label={`${c.label} 기본 키로`} onClick={() => { const { [c.id]: _, ...rest } = over; save(rest); }}>↺</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Modal>
  );
}
