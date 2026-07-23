import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { CallbackReminder } from "../lib/leads";

/**
 * Poll `/api/callbacks/mine/due/?window=…` every N seconds and expose the
 * list of currently-due reminders. The caller renders the toast / modal
 * UI; this hook only maintains state and plays a chime the first time a
 * new reminder shows up.
 *
 * Skipped when the operator is not logged in as one (empty role).
 */
export function useCallbackWatcher(opts?: { enabled?: boolean; intervalMs?: number; windowSeconds?: number }) {
  const enabled = opts?.enabled ?? true;
  const intervalMs = opts?.intervalMs ?? 30_000;
  const windowSeconds = opts?.windowSeconds ?? 60;
  const [due, setDue] = useState<CallbackReminder[]>([]);
  const seenIds = useRef<Set<number>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    audioRef.current = new Audio("/callback-chime.mp3");
    audioRef.current.preload = "auto";

    let cancelled = false;
    const tick = async () => {
      try {
        const { data } = await api.get(`/callbacks/mine/due/?window=${windowSeconds}`);
        if (cancelled) return;
        const results: CallbackReminder[] = data?.results || [];
        const newOnes = results.filter((r) => !seenIds.current.has(r.id));
        if (newOnes.length > 0 && audioRef.current) {
          try {
            void audioRef.current.play();
          } catch {
            /* browser may block autoplay — silent fallback */
          }
        }
        newOnes.forEach((r) => seenIds.current.add(r.id));
        setDue(results);
      } catch {
        /* silent: operator page will retry next tick */
      }
    };

    void tick();
    const h = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [enabled, intervalMs, windowSeconds]);

  const dismiss = (id: number) => setDue((prev) => prev.filter((r) => r.id !== id));

  return { due, dismiss };
}
