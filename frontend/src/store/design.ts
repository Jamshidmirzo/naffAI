import { create } from "zustand";

/**
 * Old ("v1") vs new «Атлас» ("v2") design. Same pattern as store/theme.ts:
 * persisted in localStorage, applied to <html data-design> immediately.
 * In v2 <body> also gets class "nf" so the Атлас tokens reach portals
 * (dialogs, toasts) rendered outside the shell.
 *
 * Default comes from VITE_DEFAULT_DESIGN (demo build: v2, prod build: v1).
 * `?design=v1|v2` in the URL overrides and remembers the choice (for QA links).
 */
export type Design = "v1" | "v2";

const KEY = "naffai_design";

function applyDesign(d: Design) {
  document.documentElement.setAttribute("data-design", d);
  document.body?.classList.toggle("nf", d === "v2");
}

function initial(): Design {
  if (typeof window === "undefined") return "v1";
  const fromUrl = new URLSearchParams(window.location.search).get("design");
  if (fromUrl === "v1" || fromUrl === "v2") {
    localStorage.setItem(KEY, fromUrl);
    return fromUrl;
  }
  const stored = localStorage.getItem(KEY);
  if (stored === "v1" || stored === "v2") return stored;
  return import.meta.env.VITE_DEFAULT_DESIGN === "v2" ? "v2" : "v1";
}

interface DesignState {
  design: Design;
  set: (d: Design) => void;
  toggle: () => void;
}

export const useDesign = create<DesignState>((set, get) => {
  const d = initial();
  if (typeof window !== "undefined") {
    applyDesign(d);
    // body may not exist yet when the store is created very early
    if (!document.body) window.addEventListener("DOMContentLoaded", () => applyDesign(get().design), { once: true });
  }
  return {
    design: d,
    set: (next) => {
      localStorage.setItem(KEY, next);
      applyDesign(next);
      set({ design: next });
    },
    toggle: () => get().set(get().design === "v2" ? "v1" : "v2"),
  };
});
