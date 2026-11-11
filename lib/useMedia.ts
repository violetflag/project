"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 767px)";

// True on phone-sized screens; the editor switches to its one-pane layout.
export function useIsMobile() {
  return useSyncExternalStore(
    (l) => {
      const m = window.matchMedia(QUERY);
      m.addEventListener("change", l);
      return () => m.removeEventListener("change", l);
    },
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
