"use client";

import { useSyncExternalStore } from "react";

// 화면 테마: light, dark, or follow the system. Per device (localStorage); app/layout.tsx applies it
// before the first paint with the same key, so the page never flashes the wrong theme.
export type Theme = "system" | "light" | "dark";
const KEY = "planspace.theme";
const DARK = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(t: Theme) {
  const dark = t === "dark" || (t === "system" && window.matchMedia(DARK).matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function setTheme(t: Theme) {
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {}
  apply(t);
  listeners.forEach((l) => l());
}

export function useTheme() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      const m = window.matchMedia(DARK);
      const sys = () => { if (read() === "system") apply("system"); };
      m.addEventListener("change", sys);
      return () => { listeners.delete(l); m.removeEventListener("change", sys); };
    },
    read,
    () => "system" as Theme,
  );
}

export const THEME_SCRIPT = `try{var t=localStorage.getItem("${KEY}");if(t==="dark"||(t!=="light"&&matchMedia("${DARK}").matches))document.documentElement.classList.add("dark")}catch(e){}`;
