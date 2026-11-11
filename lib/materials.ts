"use client";

// The project's 자료 (reference files): added from the chat or the 자료 panel, switched on or off
// for the AI, removed. Text lives in the project; PDFs and images in IndexedDB (lib/files).
import { readMaterials, removeBinary, saveBinary, toProjectMaterial } from "./files";
import { updateProject } from "./store";
import { saveToDrive } from "./sync";
import type { ProjectMaterial } from "./types";

export const materialKey = (m: Pick<ProjectMaterial, "id" | "name">) => m.id ?? m.name;

// Returns the names added and a note about files left out.
export async function addMaterials(id: string, files: File[]) {
  const { items, skipped, failed } = await readMaterials(files);
  if (items.length) {
    await saveBinary(id, items);
    updateProject(id, (p) => ({ ...p, materials: [...(p.materials ?? []), ...items.map(toProjectMaterial)] }),
      `자료 ${items.length}개를 올렸어요`);
    saveToDrive();
  }
  const note = [
    skipped.length && `용량이 크거나 읽을 수 없는 형식이라 뺐어요: ${skipped.join(", ")}`,
    failed.length && `읽지 못했어요: ${failed.join(", ")}`,
  ].filter(Boolean).join(" · ");
  return { added: items.map((m) => m.name), note };
}

export function setMaterialOn(id: string, key: string, on: boolean) {
  updateProject(id, (p) => ({ ...p, materials: p.materials?.map((m) => (materialKey(m) === key ? { ...m, off: on ? undefined : true } : m)) }));
}

export async function removeMaterial(id: string, key: string) {
  await removeBinary(id, key);
  updateProject(id, (p) => ({ ...p, materials: p.materials?.filter((m) => materialKey(m) !== key) }), "자료를 지웠어요");
  saveToDrive();
}

// "기획안.pdf p.3" → the material it names.
export function materialOfSource(list: ProjectMaterial[] | undefined, src: string) {
  return (list ?? []).filter((m) => src.includes(m.name)).sort((a, b) => b.name.length - a.name.length)[0];
}

// Asks the editor to open the 자료 panel on one file (EditorShell listens for this event).
export const openMaterial = (key: string) => window.dispatchEvent(new CustomEvent("planspace:material", { detail: key }));
