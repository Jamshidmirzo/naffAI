import { create } from "zustand";

export type Lang = "ru" | "uz";

const KEY = "naffai_lang";

function initial(): Lang {
  if (typeof window === "undefined") return "ru";
  const stored = localStorage.getItem(KEY);
  return stored === "uz" ? "uz" : "ru";
}

interface State {
  lang: Lang;
  set: (l: Lang) => void;
  toggle: () => void;
}

export const useLang = create<State>((set, get) => ({
  lang: initial(),
  set: (l) => {
    localStorage.setItem(KEY, l);
    set({ lang: l });
  },
  toggle: () => {
    const next: Lang = get().lang === "ru" ? "uz" : "ru";
    localStorage.setItem(KEY, next);
    set({ lang: next });
  },
}));
