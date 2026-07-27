import { create } from "zustand";
import { useEffect } from "react";

export interface PageMeta {
  title?: string;
  subtitle?: string;
  back?: string | (() => void);
}

interface State extends PageMeta {
  set: (m: PageMeta) => void;
  reset: () => void;
}

export const usePageStore = create<State>((set) => ({
  title: undefined,
  subtitle: undefined,
  back: undefined,
  set: (m) => set({ title: m.title, subtitle: m.subtitle, back: m.back }),
  reset: () => set({ title: undefined, subtitle: undefined, back: undefined }),
}));

export function usePageHeader(meta: PageMeta, deps: unknown[] = []) {
  const set = usePageStore((s) => s.set);
  const reset = usePageStore((s) => s.reset);
  useEffect(() => {
    set(meta);
    return () => reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
