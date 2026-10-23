"use client";

import { useEffect } from "react";
import { startSync } from "@/lib/sync";

const BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "";
const VERSION_URL = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/version.json`;

// A tab left open across a deploy mixes old and new script files, which can
// crash on the next page change. When a newer version is out, reload while the
// user isn't typing.
async function newerVersion() {
  try {
    const r = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
    return r.ok && (await r.json()).build !== BUILD;
  } catch {
    return false;
  }
}

const typing = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT") && !!(el as HTMLInputElement).value;
};

function watchVersion() {
  if (!BUILD || process.env.NODE_ENV !== "production") return;
  let stale = false;
  const check = async () => {
    if (!stale) stale = await newerVersion();
    if (stale && !typing()) location.reload();
  };
  const onVisible = () => document.visibilityState === "visible" && check();
  document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(check, 5 * 60_000);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(timer);
  };
}

export function AppWatch() {
  useEffect(() => {
    startSync();
  }, []);
  useEffect(watchVersion, []);
  return null;
}
