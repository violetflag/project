import { useState } from "preact/hooks";
import { api, fileSrc, pickFiles } from "../api";
import { draftDuration, fmtTC, insertClips, is360, newClip, uid } from "../edit";
import { draft, editDraft, importPaths, mutate, set, startProxy, startTranscribe, toast, useStore } from "../store";
import type { Asset } from "../types";
import { player } from "./Viewer";

const fmtSize = (b: number) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + " GB" : (b / 1024 ** 2).toFixed(0) + " MB");

function Badges({ a }: { a: Asset }) {
  return (
    <div class="badges">
      {is360(a) && <span class="b b360">360</span>}
      {a.info.ext && ["osv", "lrf", "lrv"].includes(a.info.ext) && <span class="b">{a.info.ext.toUpperCase()}</span>}
      {a.proxyState === "running" && <span class="b busy">미리보기 {Math.round(a.proxyPct ?? 0)}%</span>}
      {a.proxyState === "error" && <span class="b err" title={a.proxyError}>미리보기 실패</span>}
      {a.tState === "running" && <span class="b busy">받아쓰기 {Math.round(a.tPct ?? 0)}%</span>}
      {a.words && <span class="b ok">대본</span>}
      {a.tState === "error" && <span class="b err" title={a.tError}>받아쓰기 실패</span>}
    </div>
  );
}

export function MediaBin() {
  const s = useStore();
  const p = s.project!;
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const ql = q.trim().toLowerCase();
  const inFolder = (a: Asset) => (ql ? true : a.folder === s.folder);
  const match = (a: Asset) => !ql || a.info.name.toLowerCase().includes(ql) || (a.words?.map((w) => w.t).join(" ").includes(q.trim()) ?? false);
  const list = p.assets.filter((a) => inFolder(a) && match(a));
  const sub = ql ? [] : p.folders.filter((f) => f.startsWith(s.folder ? s.folder + "/" : "") && f !== s.folder && !f.slice(s.folder ? s.folder.length + 1 : 0).includes("/"));

  const open = (a: Asset) => { player.pause(); set({ sourceId: a.id }); };
  const add = (ids: string[]) => {
    const d = draft();
    if (!d) return;
    const as = ids.map((id) => p.assets.find((a) => a.id === id)!).filter(Boolean);
    const audio = as.filter((a) => a.info.kind === "audio");
    const vis = as.filter((a) => a.info.kind !== "audio");
    if (vis.length) editDraft("클립 넣기", (x) => insertClips(x, vis.map((a) => newClip(a, 0, a.info.kind === "image" ? 4 : a.info.duration))));
    if (audio.length) editDraft("음악 넣기", (x) => ({ ...x, music: [...x.music, ...audio.map((a) => ({ id: uid(), asset: a.id, start: 0, end: Math.min(a.info.duration, Math.max(5, draftDuration(x))), at: 0, volume: 0.25, fadeIn: 1, fadeOut: 2 }))] }));
  };
  const remove = (ids: string[]) => {
    const used = p.drafts.some((d) => d.clips.some((c) => ids.includes(c.asset)) || d.music.some((m) => ids.includes(m.asset)));
    if (used) return toast("편집본에서 쓰는 미디어는 먼저 편집본에서 빼 주세요");
    mutate((pp) => ({ ...pp, assets: pp.assets.filter((a) => !ids.includes(a.id)) }));
    setSel([]);
    if (ids.includes(s.sourceId ?? "")) set({ sourceId: null });
  };

  const crumbs = s.folder ? s.folder.split("/") : [];
  const m = menu ? p.assets.find((a) => a.id === menu.id) : null;
  const targets = menu ? (sel.includes(menu.id) ? sel : [menu.id]) : [];

  return (
    <div class="bin" onClick={() => setMenu(null)}>
      <div class="bin-tools">
        <button class="small primary" onClick={async () => importPaths(await pickFiles())}>＋ 가져오기</button>
        <button class="small" onClick={async () => importPaths(await pickFiles(true))}>폴더</button>
        <button class="small" onClick={() => setNewFolder("")}>새 폴더</button>
      </div>
      <input class="search" placeholder="이름이나 대사로 찾기" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="crumbs">
        <a onClick={() => set({ folder: "" })}>전체</a>
        {crumbs.map((c, i) => <><span>/</span><a onClick={() => set({ folder: crumbs.slice(0, i + 1).join("/") })}>{c}</a></>)}
      </div>
      {newFolder != null && (
        <input autoFocus placeholder="폴더 이름" onKeyDown={(e) => {
          if (e.key === "Enter") {
            const n = (e.target as HTMLInputElement).value.trim().replace(/\//g, " ");
            if (n) { const f = s.folder ? `${s.folder}/${n}` : n; mutate((pp) => ({ ...pp, folders: pp.folders.includes(f) ? pp.folders : [...pp.folders, f] })); }
            setNewFolder(null);
          }
          if (e.key === "Escape") setNewFolder(null);
        }} onBlur={() => setNewFolder(null)} />
      )}
      <div class="assets"
        onDragOver={(e) => e.preventDefault()}>
        {sub.map((f) => (
          <div class="folder" onDblClick={() => set({ folder: f })} onClick={() => set({ folder: f })}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const ids = (e.dataTransfer?.getData("text/reelcut-assets") || "").split(",").filter(Boolean); mutate((pp) => ({ ...pp, assets: pp.assets.map((a) => (ids.includes(a.id) ? { ...a, folder: f } : a)) })); }}>
            📁 {f.split("/").pop()} <span class="muted">{p.assets.filter((a) => a.folder === f || a.folder.startsWith(f + "/")).length}</span>
          </div>
        ))}
        {list.map((a) => (
          <div key={a.id} class={`asset ${sel.includes(a.id) ? "sel" : ""} ${s.sourceId === a.id ? "open" : ""}`} draggable
            onDragStart={(e) => e.dataTransfer?.setData("text/reelcut-assets", (sel.includes(a.id) ? sel : [a.id]).join(","))}
            onClick={(e) => setSel(e.ctrlKey || e.metaKey ? (sel.includes(a.id) ? sel.filter((x) => x !== a.id) : [...sel, a.id]) : [a.id])}
            onDblClick={() => open(a)}
            onContextMenu={(e) => { e.preventDefault(); if (!sel.includes(a.id)) setSel([a.id]); setMenu({ id: a.id, x: e.clientX, y: e.clientY }); }}
            title={`${a.info.path}\n${a.info.width ? `${a.info.width}×${a.info.height} ` : ""}${a.info.vcodec} ${a.info.fps ? Math.round(a.info.fps) + "fps" : ""} · ${fmtSize(a.info.size)}${a.info.recorded ? `\n촬영 ${a.info.recorded}` : ""}`}>
            <div class="thumb">
              {a.poster ? <img src={fileSrc(a.poster)} alt="" loading="lazy" /> : <span class="icon">{a.info.kind === "audio" ? "♪" : "▣"}</span>}
              <span class="dur">{a.info.kind === "image" ? "사진" : fmtTC(a.info.duration)}</span>
            </div>
            <div class="aname">{a.info.name}</div>
            <Badges a={a} />
          </div>
        ))}
        {!p.assets.length && <div class="muted pad">＋ 가져오기를 누르거나 파일을 창에 끌어다 놓으세요. Osmo 360의 .osv·.lrf도 됩니다.</div>}
      </div>
      {sel.length > 0 && (
        <div class="bin-actions">
          <span>{sel.length}개 선택</span>
          <button class="small" onClick={() => add(sel)}>편집본에 넣기</button>
          <button class="small" onClick={() => sel.forEach((id) => startTranscribe(id))}>받아쓰기</button>
        </div>
      )}
      {menu && m && (
        <div class="ctx" style={{ left: `${menu.x}px`, top: `${menu.y}px` }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { open(m); setMenu(null); }}>원본 보기</button>
          <button onClick={() => { add(targets); setMenu(null); }}>편집본에 넣기</button>
          <button onClick={() => { targets.forEach((id) => startTranscribe(id)); setMenu(null); }}>{m.words ? "다시 받아쓰기" : "받아쓰기"}</button>
          <button onClick={() => { targets.forEach((id) => startProxy(id)); setMenu(null); }}>미리보기 파일 다시 만들기</button>
          {m.tState === "running" && <button onClick={() => { api.cancel(`transcribe:${m.id}`); setMenu(null); }}>받아쓰기 취소</button>}
          <button onClick={() => { api.reveal(m.info.path); setMenu(null); }}>탐색기에서 보기</button>
          {s.folder && <button onClick={() => { mutate((pp) => ({ ...pp, assets: pp.assets.map((a) => (targets.includes(a.id) ? { ...a, folder: "" } : a)) })); setMenu(null); }}>맨 위 폴더로</button>}
          <button class="danger" onClick={() => { remove(targets); setMenu(null); }}>프로젝트에서 빼기</button>
        </div>
      )}
    </div>
  );
}
