import { create } from "zustand";

/**
 * Persistent mute-toggle для звука аплодисментов в SaleCelebration.
 *
 * localStorage key `naffai:sale-sound-muted` ("1" = muted). Хранится
 * отдельно от темы/языка, т.к. это чисто user-preference per-browser.
 */

const KEY = "naffai:sale-sound-muted";

function initial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

interface SaleSoundState {
  muted: boolean;
  toggle: () => void;
  set: (muted: boolean) => void;
}

export const useSaleSound = create<SaleSoundState>((set, get) => ({
  muted: initial(),
  toggle: () => {
    const next = !get().muted;
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      /* storage can be disabled in private mode — ignore */
    }
    set({ muted: next });
  },
  set: (muted) => {
    try {
      localStorage.setItem(KEY, muted ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ muted });
  },
}));

/**
 * Non-reactive getter — SaleCelebration использует внутри обработчика
 * события, где нет нужды подписываться на изменения (muted читается
 * в момент .play()).
 */
export function isSaleSoundMuted(): boolean {
  return useSaleSound.getState().muted;
}
