// Shortcut list (Ctrl+/): every command with its keys, grouped like the menus, with a filter.
import { useState } from "preact/hooks";
import { COMMANDS, keyLabel } from "../commands";
import { Modal } from "./Modal";

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const list = COMMANDS.filter((c) => c.keys && (!ql || c.label.toLowerCase().includes(ql) || (c.term ?? "").toLowerCase().includes(ql) || c.keys.toLowerCase().includes(ql)));
  const menus = [...new Set(list.map((c) => c.menu))];
  return (
    <Modal title="단축키" onClose={onClose} wide>
      <input class="search" autoFocus placeholder="기능이나 키로 찾기" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="단축키 찾기" />
      <div class="keys-grid">
        {menus.map((m) => (
          <section>
            <h3>{m}</h3>
            <table class="keys">
              <tbody>
                {list.filter((c) => c.menu === m).map((c) => (
                  <tr>
                    <td>{c.label}{c.term && <span class="muted"> · {c.term}</span>}</td>
                    <td class="kbd-cell">{c.keys!.split("|").map((k) => <kbd>{keyLabel(k)}</kbd>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
      <p class="muted">대본에서 말을 끌어 고른 뒤 Delete: 영상에서 잘라 내기 · 미디어 칸에서 1–5: 별점, P: 고르기, X: 안 씀</p>
    </Modal>
  );
}
