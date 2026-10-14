import { create } from "zustand";

interface CmdState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

/** ⌘K command palette visibility (opened from the menu or the keyboard). */
export const useCommandPalette = create<CmdState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
