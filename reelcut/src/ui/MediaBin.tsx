// Media bin: grid or list, sort, smart filters (360 / with transcript / picks / 3★+), star
// ratings (1–5 keys), pick / reject (P / X), tags, and hover scrubbing over the thumbnails.
import { Check, Flag, FolderPlus, LayoutGrid, List, Music, Plus, Star, X as XIcon } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { api, fileSrc, pickFiles } from "../api";
import { draftDuration, fmtTC, insertClips, is360, newClip, overlays, searchScenes, uid } from "../edit";
import { draft, editDraft, ensureStrip, importPaths, mutate, patchAsset, scanShots, set, startTranscribe, toast, useStore } from "../store";
import type { Asset } from "../types";
import { player } from "./Viewer";

const fmtSize = (b: number) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + " GB" : (b / 1024 ** 2).toFixed(0) + " MB");
type Sort = "added" | "name" | "duration" | "recorded" | "rating";
type Smart = "" | "360" | "words" | "picks" | "stars" | "unused";
const VIEW_KEY = "reelcut-bin-view";

function Badges({ a }: { a: Asset }) {
  return (
    <div class="badges">
      {is360(a) && <span class="b b360">360</span>}
      {a.info.ext && ["osv", "lrf", "lrv"].includes(a.info.ext) && <span class="b">{a.info.ext.toUpperCase()}</span>}
      {a.info.lrf && <span class="b" title={`저용량 짝 파일 (썸네일에 씀): ${a.info.lrf}`}>LRF 짝</span>}
      {a.tState === "running" && <span class="b busy">받아쓰기 {Math.round(a.tPct ?? 0)}%</span>}
      {a.words && <span class="b ok">대본</span>}
      {a.tState === "error" && <span class="b err" title={a.tError}>받아쓰기 실패</span>}
      {(a.tags ?? []).map((t) => <span class="b tag">#{t}</span>)}
    </div>
  );
}

function Stars({ a }: { a: Asset }) {
  const r = a.rating ?? 0;
  return (
    <span class="stars" role="radiogroup" aria-label="별점">
      {[1, 2, 3, 4, 5].map((n) => (
        <button role="radio" aria-checked={r === n} class={`star ${n <= r ? "on" : ""}`} aria-label={`${n}점`} title={`${n}점 (${n} 키)`}
          onClick={(e) => { e.stopPropagation(); patchAsset(a.id, { rating: r === n ? 0 : n }); }}><Star size={11} /></button>
      ))}
    </span>
  );
}

/** Thumbnail that shows other frames as the mouse moves over it (from the frame strip). */
function Thumb({ a }: { a: Asset }) {
  const [hx, setHx] = useState<number | null>(null);
  const strip = a.strip ? fileSrc(a.strip) : null;
  return (
    <div class="thumb" onMouseEnter={() => ensureStrip(a)}
      onMouseMove={(e) => { if (!strip) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setHx(Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width))); }}
      onMouseLeave={() => setHx(null)}>
      {hx != null && strip ? (
        <div class="strip-frame" style={{ backgroundImage: `url("${strip}")`, backgroundSize: "3000% 100%", backgroundPosition: `${(Math.floor(hx * 30) / 29) * 100}% 0` }} />
      ) : a.poster ? <img src={fileSrc(a.poster)} alt="" loading="lazy" /> : <span class="icon">{a.info.kind === "audio" ? <Music size={22} /> : null}</span>}
      {hx != null && strip && <span class="hx" style={{ left: `${hx * 100}%` }} />}
      <span class="dur">{a.info.kind === "image" ? "사진" : fmtTC(a.info.duration)}</span>
      {a.flag === "pick" && <span class="flag pick" title="고른 컷"><Check size={11} /></span>}
      {a.flag === "reject" && <span class="flag reject" title="안 씀"><XIcon size={11} /></span>}
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
  const [view, setView] = useState<"grid" | "list">(() => { try { return (localStorage.getItem(VIEW_KEY) as any) || "grid"; } catch { return "grid"; } });
  const [sort, setSort] = useState<Sort>("added");
  const [smart, setSmart] = useState<Smart>("");
  const [tagging, setTagging] = useState<string | null>(null);
  const setV = (v: "grid" | "list") => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };

  const used = new Set(p.drafts.flatMap((d) => [...d.clips.map((c) => c.asset), ...d.music.map((m) => m.asset), ...overlays(d).map((o) => o.asset)]));
  const ql = q.trim().toLowerCase();
  const filtering = !!ql || !!smart;
  const inFolder = (a: Asset) => (filtering ? true : a.folder === s.folder);
  const match = (a: Asset) => !ql || a.info.name.toLowerCase().includes(ql) || (a.tags ?? []).some((t) => t.toLowerCase().includes(ql.replace(/^#/, ""))) || (a.words?.map((w) => w.t).join(" ").includes(q.trim()) ?? false) || (a.scenes ?? []).some((n) => n.text.toLowerCase().includes(ql));
  const smartOk = (a: Asset) => !smart || (smart === "360" ? is360(a) : smart === "words" ? !!a.words : smart === "picks" ? a.flag === "pick" : smart === "stars" ? (a.rating ?? 0) >= 3 : !used.has(a.id));
  const cmp = (x: Asset, y: Asset) => sort === "name" ? x.info.name.localeCompare(y.info.name, "ko") : sort === "duration" ? y.info.duration - x.info.duration
    : sort === "recorded" ? (x.info.recorded || "").localeCompare(y.info.recorded || "") : sort === "rating" ? (y.rating ?? 0) - (x.rating ?? 0) : (x.added ?? 0) - (y.added ?? 0);
  // Rejected takes stay visible (dimmed) in the plain view and drop out of smart filters.
  const list = p.assets.filter((a) => inFolder(a) && match(a) && smartOk(a) && (!smart || a.flag !== "reject")).sort(cmp);
  const sub = filtering ? [] : p.folders.filter((f) => f.startsWith(s.folder ? s.folder + "/" : "") && f !== s.folder && !f.slice(s.folder ? s.folder.length + 1 : 0).includes("/"));

  const open = (a: Asset) => { player.pause(); set({ sourceId: a.id }); };
  const add = (ids: string[]) => {
    const d = draft();
    if (!d) return;
    const as = ids.map((id) => p.assets.find((a) => a.id === id)!).filter(Boolean);
    const audio = as.filter((a) => a.info.kind === "audio");
    const vis = as.filter((a) => a.info.kind !== "audio");
    if (vis.length) editDraft("클립 넣기", (x) => insertClips(x, vis.map((a) => newClip(a, 0, a.info.kind === "image" ? 4 : a.info.duration))));
    if (audio.length) editDraft("음악 넣기", (x) => ({ ...x, music: [...x.music, ...audio.map((a) => ({ id: uid(), asset: a.id, start: 0, end: Math.min(a.info.duration, Math.max(5, draftDuration(x))), at: 0, volume: 0.25, fadeIn: 1, fadeOut: 2, track: 2 as const }))] }), undefined, false);
  };
  const remove = (ids: string[]) => {
    if (ids.some((id) => used.has(id))) return toast("편집본에서 쓰는 미디어는 먼저 편집본에서 빼 주세요");
    mutate((pp) => ({ ...pp, assets: pp.assets.filter((a) => !ids.includes(a.id)) }));
    setSel([]);
    if (ids.includes(s.sourceId ?? "")) set({ sourceId: null });
  };

  // Rating and pick keys while the bin has a selection.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!sel.length || (e.target as HTMLElement).closest("input, textarea, select") || e.ctrlKey || e.altKey) return;
      if (!(document.activeElement as HTMLElement)?.closest?.(".bin")) return;
      const k = e.code.startsWith("Digit") ? e.code.slice(5) : e.code === "KeyP" ? "p" : e.code === "KeyX" ? "x" : e.code === "KeyU" ? "u" : "";
      if (!k) return;
      e.preventDefault(); e.stopPropagation();
      mutate((pp) => ({ ...pp, assets: pp.assets.map((a) => {
        if (!sel.includes(a.id)) return a;
        if (/^[0-5]$/.test(k)) return { ...a, rating: Number(k) };
        if (k === "p") return { ...a, flag: a.flag === "pick" ? undefined : "pick" };
        if (k === "x") return { ...a, flag: a.flag === "reject" ? undefined : "reject" };
        return { ...a, flag: undefined };
      }) }));
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [sel.join(",")]);

  const hits = ql ? searchScenes(p.assets, q).slice(0, 12) : [];
  const crumbs = s.folder ? s.folder.split("/") : [];
  const m = menu ? p.assets.find((a) => a.id === menu.id) : null;
  const targets = menu ? (sel.includes(menu.id) ? sel : [menu.id]) : [];
  const click = (a: Asset, e: MouseEvent) => setSel(e.ctrlKey || e.metaKey ? (sel.includes(a.id) ? sel.filter((x) => x !== a.id) : [...sel, a.id])
    : e.shiftKey && sel.length ? (() => { const i0 = list.findIndex((x) => x.id === sel[0]), i1 = list.findIndex((x) => x.id === a.id); return list.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).map((x) => x.id); })() : [a.id]);
  const itemProps = (a: Asset) => ({
    key: a.id, tabIndex: 0, role: "option", "aria-selected": sel.includes(a.id), draggable: true,
    onDragStart: (e: DragEvent) => e.dataTransfer?.setData("text/reelcut-assets", (sel.includes(a.id) ? sel : [a.id]).join(",")),
    onClick: (e: MouseEvent) => click(a, e),
    onDblClick: () => open(a),
    onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter") open(a); if (e.key === " ") { e.preventDefault(); click(a, e as any); } },
    onContextMenu: (e: MouseEvent) => { e.preventDefault(); if (!sel.includes(a.id)) setSel([a.id]); setMenu({ id: a.id, x: e.clientX, y: e.clientY }); },
    title: `${a.info.path}\n${a.info.width ? `${a.info.width}×${a.info.height} ` : ""}${a.info.vcodec} ${a.info.fps ? Math.round(a.info.fps) + "fps" : ""} · ${fmtSize(a.info.size)}${a.info.recorded ? `\n촬영 ${a.info.recorded}` : ""}\n두 번 클릭: 원본 보기 · 1–5 별점 · P 고르기 · X 안 씀`,
  });

  return (
    <div class="bin" onClick={() => setMenu(null)}>
      <div class="bin-tools">
        <button class="small primary" onClick={async () => importPaths(await pickFiles())} title="미디어 가져오기 (Ctrl+I)"><Plus size={13} aria-hidden="true" /> 가져오기</button>
        <button class="small" onClick={async () => importPaths(await pickFiles(true))} title="폴더째 가져오기">폴더</button>
        <button class="icon-btn" onClick={() => setNewFolder("")} aria-label="새 폴더" title="새 폴더"><FolderPlus size={15} /></button>
        <span class="spacer" />
        <div class="seg">
          <button class={`icon-btn ${view === "grid" ? "on" : ""}`} aria-pressed={view === "grid"} onClick={() => setV("grid")} aria-label="썸네일 보기" title="썸네일 보기"><LayoutGrid size={15} /></button>
          <button class={`icon-btn ${view === "list" ? "on" : ""}`} aria-pressed={view === "list"} onClick={() => setV("list")} aria-label="목록 보기" title="목록 보기"><List size={15} /></button>
        </div>
      </div>
      <div class="bin-filter">
        <input class="search" placeholder="이름·대사·#태그로 찾기" aria-label="미디어 찾기" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)} aria-label="정렬">
          <option value="added">가져온 순</option><option value="name">이름</option><option value="duration">길이</option><option value="recorded">촬영일</option><option value="rating">별점</option>
        </select>
      </div>
      <div class="smart" role="tablist" aria-label="스마트 폴더">
        {([["", "전체"], ["picks", "고른 컷"], ["stars", "3★ 이상"], ["360", "360"], ["words", "대본 있음"], ["unused", "안 쓴 것"]] as [Smart, string][]).map(([k, l]) => (
          <button role="tab" aria-selected={smart === k} class={`chip ${smart === k ? "on" : ""}`} onClick={() => setSmart(k)}>{l}</button>
        ))}
      </div>
      {!filtering && (
        <div class="crumbs">
          <a onClick={() => set({ folder: "" })}>최상위</a>
          {crumbs.map((c, i) => <><span>/</span><a onClick={() => set({ folder: crumbs.slice(0, i + 1).join("/") })}>{c}</a></>)}
        </div>
      )}
      {newFolder != null && (
        <input autoFocus placeholder="폴더 이름" aria-label="새 폴더 이름" onKeyDown={(e) => {
          if (e.key === "Enter") {
            const n = (e.target as HTMLInputElement).value.trim().replace(/\//g, " ");
            if (n) { const f = s.folder ? `${s.folder}/${n}` : n; mutate((pp) => ({ ...pp, folders: pp.folders.includes(f) ? pp.folders : [...pp.folders, f] })); }
            setNewFolder(null);
          }
          if (e.key === "Escape") setNewFolder(null);
        }} onBlur={() => setNewFolder(null)} />
      )}
      {hits.length > 0 && (
        <div class="scene-hits" aria-label="찾은 장면">
          <div class="muted">찾은 장면 {hits.length}곳</div>
          {hits.map((h) => {
            const a = p.assets.find((x) => x.id === h.asset)!;
            return <button class="scene-hit" title={a.info.name} onClick={() => { open(a); setTimeout(() => player.seek(h.t), 300); }}><span class="tc-s">{fmtTC(h.t)}</span> {h.text}</button>;
          })}
        </div>
      )}
      <div class={view === "grid" ? "assets" : "assets list"} role="listbox" aria-multiselectable="true" aria-label="미디어" onDragOver={(e) => e.preventDefault()}>
        {sub.map((f) => (
          <div class="folder" onDblClick={() => set({ folder: f })} onClick={() => set({ folder: f })}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const ids = (e.dataTransfer?.getData("text/reelcut-assets") || "").split(",").filter(Boolean); mutate((pp) => ({ ...pp, assets: pp.assets.map((a) => (ids.includes(a.id) ? { ...a, folder: f } : a)) })); }}>
            {f.split("/").pop()} <span class="muted">{p.assets.filter((a) => a.folder === f || a.folder.startsWith(f + "/")).length}</span>
          </div>
        ))}
        {view === "grid" && list.map((a) => (
          <div {...(itemProps(a) as any)} class={`asset ${sel.includes(a.id) ? "sel" : ""} ${s.sourceId === a.id ? "open" : ""} ${a.flag === "reject" ? "rejected" : ""}`}>
            <Thumb a={a} />
            <div class="aname">{a.info.name}</div>
            <Stars a={a} />
            <Badges a={a} />
          </div>
        ))}
        {view === "list" && list.length > 0 && (
          <table class="alist">
            <thead><tr><th>이름</th><th>길이</th><th>해상도</th><th>fps</th><th>별점</th></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr {...(itemProps(a) as any)} class={`${sel.includes(a.id) ? "sel" : ""} ${a.flag === "reject" ? "rejected" : ""}`}>
                  <td class="nm">{a.flag === "pick" && <Flag size={11} class="ok" aria-label="고른 컷" />} {a.info.name} {is360(a) && <span class="b b360">360</span>} {a.words && <span class="b ok">대본</span>}</td>
                  <td class="tc">{a.info.kind === "image" ? "사진" : fmtTC(a.info.duration)}</td>
                  <td>{a.info.width ? `${a.info.width}×${a.info.height}` : "-"}</td>
                  <td>{a.info.fps ? Math.round(a.info.fps) : "-"}</td>
                  <td>{a.rating ? "★".repeat(a.rating) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!p.assets.length && <div class="muted pad">가져오기를 누르거나 파일을 창에 끌어다 놓으세요. Osmo 360의 .osv·.lrf도 됩니다.</div>}
        {p.assets.length > 0 && !list.length && !sub.length && <div class="muted pad">조건에 맞는 미디어가 없습니다.</div>}
      </div>
      {sel.length > 0 && (
        <div class="bin-actions">
          <span>{sel.length}개 선택</span>
          <button class="small" onClick={() => add(sel)}>편집본에 넣기</button>
          <button class="small" onClick={() => sel.forEach((id) => startTranscribe(id))}>받아쓰기</button>
          <span class="muted">1–5 별점 · P 고르기 · X 안 씀</span>
        </div>
      )}
      {tagging && (
        <div class="bin-actions">
          <input autoFocus placeholder="태그 (쉼표로 구분)" aria-label="태그" defaultValue={(p.assets.find((a) => a.id === tagging)?.tags ?? []).join(", ")}
            onKeyDown={(e) => {
              if (e.key === "Enter") { const tags = (e.target as HTMLInputElement).value.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean); mutate((pp) => ({ ...pp, assets: pp.assets.map((a) => ((sel.includes(a.id) || a.id === tagging) ? { ...a, tags } : a)) })); setTagging(null); }
              if (e.key === "Escape") setTagging(null);
            }} onBlur={() => setTagging(null)} />
        </div>
      )}
      {menu && m && (
        <div class="ctx" style={{ left: `${menu.x}px`, top: `${menu.y}px` }} role="menu" onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => { open(m); setMenu(null); }}>원본 보기</button>
          <button role="menuitem" onClick={() => { add(targets); setMenu(null); }}>편집본에 넣기</button>
          <div class="menu-sep" />
          <button role="menuitem" onClick={() => { mutate((pp) => ({ ...pp, assets: pp.assets.map((a) => (targets.includes(a.id) ? { ...a, flag: a.flag === "pick" ? undefined : "pick" } : a)) })); setMenu(null); }}>{m.flag === "pick" ? "고르기 취소" : "좋은 컷으로 고르기"} <kbd>P</kbd></button>
          <button role="menuitem" onClick={() => { mutate((pp) => ({ ...pp, assets: pp.assets.map((a) => (targets.includes(a.id) ? { ...a, flag: a.flag === "reject" ? undefined : "reject" } : a)) })); setMenu(null); }}>{m.flag === "reject" ? "안 씀 취소" : "안 씀으로 표시"} <kbd>X</kbd></button>
          <button role="menuitem" onClick={() => { setTagging(m.id); setMenu(null); }}>태그 달기…</button>
          <div class="menu-sep" />
          <button role="menuitem" onClick={() => { targets.forEach((id) => startTranscribe(id)); setMenu(null); }}>{m.words ? "다시 받아쓰기" : "받아쓰기"}</button>
          <button role="menuitem" onClick={() => { targets.forEach((id) => scanShots(id).then((b) => toast(b.length ? `흔들리거나 흐린 구간 ${b.length}곳을 찾았습니다 (원본 보기의 재생 막대에 표시)` : "문제 구간이 없습니다")).catch((e) => toast(`찾지 못했습니다: ${e}`))); setMenu(null); }}>흔들림·흐림 찾기</button>
          {m.tState === "running" && <button role="menuitem" onClick={() => { api.cancel(`transcribe:${m.id}`); setMenu(null); }}>받아쓰기 취소</button>}
          <button role="menuitem" onClick={() => { api.reveal(m.info.path); setMenu(null); }}>탐색기에서 보기</button>
          {s.folder && <button role="menuitem" onClick={() => { mutate((pp) => ({ ...pp, assets: pp.assets.map((a) => (targets.includes(a.id) ? { ...a, folder: "" } : a)) })); setMenu(null); }}>맨 위 폴더로</button>}
          <button role="menuitem" class="danger" onClick={() => { remove(targets); setMenu(null); }}>프로젝트에서 빼기</button>
        </div>
      )}
    </div>
  );
}

