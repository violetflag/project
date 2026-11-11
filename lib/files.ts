"use client";

// Material attached on the home screen ("내 자료로 시작"), in the chat or in the 자료 panel.
// Text files and office documents are read into the project as text; PDFs and images
// are kept in IndexedDB (too big for localStorage) and sent to Claude as document/image blocks.
import { uid } from "./id";
import { OFFICE, officeText } from "./extract";

export interface Material {
  id: string;
  name: string;
  kind: "text" | "pdf" | "image";
  mediaType: string;
  data: string; // plain text for "text", base64 for the others
}

const TEXT = /\.(txt|md|markdown|csv|tsv|json|html?|xml|ya?ml|log)$/i;
const IMAGE = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_BYTES = 50 * 1024 * 1024;
export const ACCEPT = ".txt,.md,.markdown,.csv,.tsv,.json,.html,.xml,.yaml,.yml,.pdf,.docx,.xlsx,.pptx,.hwp,.hwpx,image/png,image/jpeg,image/gif,image/webp";

export function classify(f: File): Material["kind"] | null {
  if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) return "pdf";
  if (IMAGE.includes(f.type)) return "image";
  if (OFFICE.test(f.name)) return "text";
  if (f.type.startsWith("text/") || TEXT.test(f.name)) return "text";
  return null;
}

const toBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

// skipped: too big or an unknown type; failed: a known type that could not be read (with why).
export async function readMaterials(files: File[]): Promise<{ items: Material[]; skipped: string[]; failed: string[] }> {
  const items: Material[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let total = 0;
  for (const f of files) {
    const kind = classify(f);
    if (!kind || f.size > MAX_FILE || total + f.size > MAX_BYTES) {
      skipped.push(f.name);
      continue;
    }
    total += f.size;
    try {
      if (kind === "text") {
        const text = OFFICE.test(f.name) ? await officeText(f) : await f.text();
        items.push({ id: uid("mt_"), name: f.name, kind, mediaType: "text/plain", data: text.slice(0, 60000) });
      } else items.push({ id: uid("mt_"), name: f.name, kind, mediaType: kind === "pdf" ? "application/pdf" : f.type, data: await toBase64(f) });
    } catch (e) {
      failed.push(`${f.name}(${e instanceof Error ? e.message : "읽기 실패"})`);
    }
  }
  return { items, skipped, failed };
}

// What a project keeps about each file (the text itself for text and office files).
export const toProjectMaterial = (m: Material) => ({
  id: m.id, name: m.name, kind: m.kind, at: Date.now(), ...(m.kind === "text" ? { text: m.data } : {}),
});

function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("planspace", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("materials");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putBinary(projectId: string, bin: Material[]) {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction("materials", "readwrite");
      tx.objectStore("materials").put(bin, projectId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IndexedDB unavailable (private mode): the files only live for this session.
    memory.set(projectId, bin);
  }
}

const memory = new Map<string, Material[]>();

// Adds the PDFs and images among items to what the project already stores.
export async function saveBinary(projectId: string, items: Material[]) {
  const bin = items.filter((m) => m.kind !== "text");
  if (!bin.length) return;
  await putBinary(projectId, [...await loadBinary(projectId), ...bin]);
}
export async function removeBinary(projectId: string, materialId: string) {
  const cur = await loadBinary(projectId);
  const key = (m: Material) => m.id ?? m.name;
  if (cur.some((m) => key(m) === materialId)) await putBinary(projectId, cur.filter((m) => key(m) !== materialId));
}
// A blob URL for opening the original PDF or image.
export async function binaryUrl(projectId: string, m: { id?: string; name: string }) {
  const b = (await loadBinary(projectId)).find((x) => (m.id && x.id ? x.id === m.id : x.name === m.name));
  if (!b) return null;
  const bytes = Uint8Array.from(atob(b.data), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: b.mediaType }));
}

export async function loadBinary(projectId: string): Promise<Material[]> {
  if (memory.has(projectId)) return memory.get(projectId)!;
  try {
    const d = await db();
    return await new Promise<Material[]>((resolve, reject) => {
      const req = d.transaction("materials").objectStore("materials").get(projectId);
      req.onsuccess = () => resolve((req.result as Material[] | undefined) ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function deleteBinary(projectId: string) {
  memory.delete(projectId);
  try {
    const d = await db();
    d.transaction("materials", "readwrite").objectStore("materials").delete(projectId);
  } catch {
    // Nothing stored.
  }
}
