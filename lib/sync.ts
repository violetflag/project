"use client";

// Google sign-in and sync. The projects, the Anthropic key and the AI settings
// are kept in one JSON file in the user's own Google Drive "app data" folder,
// a hidden folder only this app can read. No server of our own is involved.

import { useSyncExternalStore } from "react";
import { applySyncedAi, getAiSettings, getAiUpdatedAt, getApiKey, onLocalAiChange, type AiSettings } from "./ai";
import { applySyncedProjects, getAllProjects, getPurged, onLocalProjectsChange } from "./store";
import type { Project } from "./types";

export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const SCOPE = "https://www.googleapis.com/auth/drive.appdata openid email profile";
const FILE = "planspace.json";
const AUTH = "planspace.google";

interface Remote {
  version: 1;
  savedAt: number;
  projects: Project[];
  purged: string[];
  apiKey: string;
  ai: AiSettings;
  aiAt: number;
}

interface Auth { token: string; expiresAt: number; email: string; name: string }

export type SyncState =
  | { status: "off" }
  | { status: "signed-out" }
  | { status: "syncing"; user: Auth }
  | { status: "synced"; user: Auth; at: number }
  | { status: "expired"; user: Auth }
  | { status: "error"; user: Auth; message: string };

let state: SyncState = { status: "off" };
const listeners = new Set<() => void>();
function set(next: SyncState) {
  state = next;
  listeners.forEach((l) => l());
}
export function useSync() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

function readAuth(): Auth | null {
  try {
    return JSON.parse(localStorage.getItem(AUTH) || "null");
  } catch {
    return null;
  }
}
function writeAuth(a: Auth | null) {
  try {
    if (a) localStorage.setItem(AUTH, JSON.stringify(a));
    else localStorage.removeItem(AUTH);
  } catch {
    // Signed in for this tab only.
  }
}
const valid = (a: Auth | null): a is Auth => !!a && a.expiresAt > Date.now() + 60_000;

// --- Google Identity Services -------------------------------------------

interface TokenResponse { access_token?: string; expires_in?: number; error?: string }
interface TokenClient { requestAccessToken(o?: { prompt?: string; hint?: string }): void }
declare global {
  interface Window {
    google?: { accounts: { oauth2: {
      initTokenClient(c: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }): TokenClient;
      revoke(token: string, done?: () => void): void;
    } } };
  }
}

let gis: Promise<void> | null = null;
function loadGis() {
  gis ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gis = null;
      reject(new Error("구글 로그인 스크립트를 불러오지 못했어요."));
    };
    document.head.appendChild(s);
  });
  return gis;
}

// Opens Google's window. Must run from a click, or the browser blocks it.
async function requestToken(prompt: "" | "select_account", hint?: string): Promise<Auth> {
  await loadGis();
  const raw = await new Promise<TokenResponse>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => (r.error ? reject(new Error(r.error)) : resolve(r)),
      error_callback: (e) => reject(new Error(e.type === "popup_closed" ? "로그인 창이 닫혔어요." : "구글 로그인에 실패했어요.")),
    });
    client.requestAccessToken({ prompt, hint });
  });
  const token = raw.access_token!;
  const me = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  return { token, expiresAt: Date.now() + (raw.expires_in ?? 3600) * 1000, email: me.email ?? "", name: me.name ?? me.email ?? "" };
}

// --- Drive ----------------------------------------------------------------

class Expired extends Error {}

async function drive(auth: Auth, url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${auth.token}` } });
  if (r.status === 401) throw new Expired();
  if (!r.ok) throw new Error(`구글 드라이브 오류 (${r.status})`);
  return r;
}

let fileId: string | null = null;
async function findFile(auth: Auth) {
  if (fileId) return fileId;
  const q = encodeURIComponent(`name='${FILE}'`);
  const r = await drive(auth, `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`);
  fileId = (await r.json()).files?.[0]?.id ?? null;
  return fileId;
}

async function pull(auth: Auth): Promise<Remote | null> {
  const id = await findFile(auth);
  if (!id) return null;
  const r = await drive(auth, `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  return r.json();
}

async function push(auth: Auth, data: Remote) {
  const body = JSON.stringify(data);
  const id = await findFile(auth);
  if (id) {
    await drive(auth, `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body,
    });
    return;
  }
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name: FILE, parents: ["appDataFolder"] })], { type: "application/json" }));
  form.append("file", new Blob([body], { type: "application/json" }));
  const r = await drive(auth, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", body: form });
  fileId = (await r.json()).id;
}

// --- Merge ------------------------------------------------------------------

// Per project, the most recently changed copy wins. Deleted-for-good ids stay deleted.
export function merge(local: Project[], remote: Project[], purged: string[]) {
  const gone = new Set(purged);
  const byId = new Map<string, Project>();
  for (const p of [...remote, ...local]) {
    if (gone.has(p.id)) continue;
    const had = byId.get(p.id);
    if (!had || p.updatedAt > had.updatedAt) byId.set(p.id, p);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let running: Promise<void> | null = null;
let again = false;

export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await syncOnce();
    } while (again);
  })().finally(() => (running = null));
  return running;
}

async function syncOnce() {
  const auth = readAuth();
  if (!auth) return set(GOOGLE_CLIENT_ID ? { status: "signed-out" } : { status: "off" });
  if (!valid(auth)) return set({ status: "expired", user: auth });
  set({ status: "syncing", user: auth });
  try {
    const remote = await pull(auth);
    const purged = [...new Set([...getPurged(), ...(remote?.purged ?? [])])];
    const local = getAllProjects();
    const projects = merge(local, remote?.projects ?? [], purged);
    if (!same(projects, local) || !same(purged, getPurged())) applySyncedProjects(projects, purged);

    const localAt = getAiUpdatedAt();
    let apiKey = getApiKey();
    let ai = getAiSettings();
    let aiAt = localAt;
    if (remote && remote.aiAt > localAt) {
      ({ apiKey, ai, aiAt } = remote);
      applySyncedAi(apiKey, ai, aiAt);
    }

    const next: Remote = { version: 1, savedAt: Date.now(), projects, purged, apiKey, ai, aiAt };
    if (!remote || !same({ ...remote, savedAt: 0 }, { ...next, savedAt: 0 })) await push(auth, next);
    set({ status: "synced", user: auth, at: Date.now() });
  } catch (e) {
    if (e instanceof Expired) return set({ status: "expired", user: auth });
    set({ status: "error", user: auth, message: e instanceof Error ? e.message : "동기화에 실패했어요." });
  }
}

// --- Public actions ------------------------------------------------------

export async function signIn() {
  const auth = await requestToken("select_account");
  fileId = null;
  writeAuth(auth);
  await syncNow();
}

// Renews the hour-long Google token. Needs a click; Google closes its window by itself.
let renewing: Promise<void> | null = null;
export function renew() {
  renewing ??= renewOnce().finally(() => (renewing = null));
  return renewing;
}
async function renewOnce() {
  const old = readAuth();
  const auth = await requestToken("", old?.email);
  writeAuth({ ...auth, email: auth.email || old?.email || "", name: auth.name || old?.name || "" });
  await syncNow();
}

// Saves everything to Drive, then removes the projects and key from this browser.
export async function signOut() {
  if (readAuth() && !valid(readAuth())) await renew();
  const auth = readAuth();
  if (valid(auth)) {
    await syncNow();
    if (state.status !== "synced") throw new Error("구글 드라이브에 저장하지 못해서 로그아웃을 멈췄어요. 잠시 뒤 다시 해 주세요.");
    window.google?.accounts.oauth2.revoke(auth.token);
  }
  writeAuth(null);
  fileId = null;
  applySyncedProjects([], []);
  applySyncedAi("", getAiSettings(), 0);
  set({ status: "signed-out" });
}

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const soon = () => {
  if (!readAuth()) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, 1500);
};

// Called once from the app shell.
export function startSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  if (!GOOGLE_CLIENT_ID) return set({ status: "off" });
  onLocalProjectsChange(soon);
  onLocalAiChange(soon);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && syncNow());
  setInterval(() => document.visibilityState === "visible" && syncNow(), 60_000);
  // An expired token is renewed on the next tap anywhere, since that counts as a click.
  document.addEventListener("pointerdown", () => {
    if (state.status === "expired") renew().catch(() => {});
  }, true);
  void syncNow();
}
