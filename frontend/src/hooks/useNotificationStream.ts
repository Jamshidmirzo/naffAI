/**
 * useNotificationStream — subscribes to the server-sent-events channel at
 * `/api/notifications/stream/` and dispatches `naffai:notif` CustomEvents
 * on `window` for every incoming notification. Components (SaleCelebration,
 * SnapshotRequestPrompt) listen to that event instead of each one opening
 * their own stream.
 *
 * Транспорт: `fetch` + ReadableStream (НЕ EventSource) — EventSource не
 * поддерживает кастомные заголовки, а у нас токен-авторизация. Чтобы не
 * переделывать аутентификацию на cookies, мы руками парсим SSE-кадры из
 * фетч-стрима.
 *
 * Fallback: если fetch/ReadableStream недоступны, или сервер отдаёт 503
 * (SSE не настроен — нет redis), хук тихо возвращает без ошибки и
 * продолжает жить как no-op. SaleCelebration/… в этом случае сами
 * продолжают использовать свой legacy-polling.
 *
 * Reconnect: при обрыве коннекта хук ждёт 3 секунды и переподключается
 * (экспоненциальный backoff до 30с).
 */

import { useEffect, useRef } from "react";
import { API_BASE_URL } from "../lib/api";

export interface NaffaiNotificationEventDetail {
  kind: string;
  title?: string;
  body?: string;
  link?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export const NAFFAI_NOTIF_EVENT = "naffai:notif";

function emit(detail: NaffaiNotificationEventDetail) {
  try {
    window.dispatchEvent(
      new CustomEvent<NaffaiNotificationEventDetail>(NAFFAI_NOTIF_EVENT, { detail }),
    );
  } catch {
    /* ignore — oldschool browsers */
  }
}

export function useNotificationStream(enabled: boolean = true) {
  const abortRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    if (typeof fetch === "undefined" || typeof ReadableStream === "undefined") {
      // Старый браузер — не ломаемся, пусть polling-ветки работают.
      return;
    }

    stoppedRef.current = false;
    let delayMs = 3000;

    const connect = async () => {
      if (stoppedRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      const token = localStorage.getItem("naffai_token") || "";
      try {
        const res = await fetch(`${API_BASE_URL}/notifications/stream/`, {
          method: "GET",
          credentials: "include",
          headers: token
            ? { Accept: "text/event-stream", Authorization: `Token ${token}` }
            : { Accept: "text/event-stream" },
          signal: controller.signal,
        });

        if (res.status === 401 || res.status === 403) {
          // не авторизован — хватит дёргать, пусть основной polling работает
          return;
        }
        if (res.status === 503 || !res.ok) {
          // SSE отключен на бэке (нет redis). Ждём подольше и больше не
          // ломимся — polling-ветки компонентов продолжают работать.
          return;
        }
        if (!res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        delayMs = 3000;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frame delimiter — "\n\n"
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const rawFrame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            // Собираем data: lines, игнорим comment-пинги (начинаются с ":")
            const lines = rawFrame.split("\n");
            const dataLines = lines
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (!dataLines.length) continue;
            const payloadRaw = dataLines.join("\n");
            try {
              const detail = JSON.parse(payloadRaw);
              emit(detail);
            } catch {
              /* ignore unparseable frame */
            }
          }
        }
      } catch (err) {
        if ((err as DOMException | undefined)?.name === "AbortError") return;
        // прочие ошибки — reconnect с backoff
      } finally {
        abortRef.current = null;
      }

      if (!stoppedRef.current) {
        const nextDelay = Math.min(delayMs, 30_000);
        setTimeout(connect, nextDelay);
        delayMs = Math.min(delayMs * 2, 30_000);
      }
    };

    connect();

    return () => {
      stoppedRef.current = true;
      try {
        abortRef.current?.abort();
      } catch {
        /* ignore */
      }
    };
  }, [enabled]);
}
