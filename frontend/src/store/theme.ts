import { create } from "zustand";

type Theme = "light" | "dark";

const KEY = "naffai_theme";

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

function initial(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem(KEY) as Theme | null;
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  set: (t: Theme) => void;
}

export const useTheme = create<ThemeState>((set, get) => {
  const t = initial();
  if (typeof window !== "undefined") applyTheme(t);
  return {
    theme: t,
    toggle: () => {
      const next: Theme = get().theme === "dark" ? "light" : "dark";
      localStorage.setItem(KEY, next);
      applyTheme(next);
      set({ theme: next });
    },
    set: (t) => {
      localStorage.setItem(KEY, t);
      applyTheme(t);
      set({ theme: t });
    },
  };
});
