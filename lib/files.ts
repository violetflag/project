"use client";

// Material attached on the home screen ("내 자료로 시작"). Text files are read
// into the project; PDFs and images are kept in IndexedDB (too big for
// localStorage) and sent to Claude as document/image blocks.

export interface Material {
  name: string;
  kind: "text" | "pdf" | "image";
  mediaType: string;
  data: string; // plain text for "text", base64 for the others
}

const TEXT = /\.(txt|md|markdown|csv|tsv|json|html?|xml|ya?ml|log)$/i;
const IMAGE = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_BYTES = 8 * 1024 * 1024;

export function classify(f: File): Material["kind"] | null {
  if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) return "pdf";
  if (IMAGE.includes(f.type)) return "image";
  if (f.type.startsWith("text/") || TEXT.test(f.name)) return "text";
  return null;
}

const toBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

export async function readMaterials(files: File[]): Promise<{ items: Material[]; skipped: string[] }> {
  const items: Material[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const f of files) {
    const kind = classify(f);
    if (!kind || total + f.size > MAX_BYTES) {
      skipped.push(f.name);
      continue;
    }
    total += f.size;
    if (kind === "text") items.push({ name: f.name, kind, mediaType: "text/plain", data: (await f.text()).slice(0, 60000) });
    else items.push({ name: f.name, kind, mediaType: kind === "pdf" ? "application/pdf" : f.type, data: await toBase64(f) });
  }
  return { items, skipped };
}

function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("planspace", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("materials");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveBinary(projectId: string, items: Material[]) {
  const bin = items.filter((m) => m.kind !== "text");
  if (!bin.length) return;
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
