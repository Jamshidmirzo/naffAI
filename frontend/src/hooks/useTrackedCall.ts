/**
 * useTrackedCall — Фаза 1 click-to-call lifecycle на фронте.
 *
 * Flow:
 *   1. startCall(lead) → POST /api/calls/start/ → сохраняем call_attempt_id,
 *      сразу же открываем tel:${lead.phone} (единственный способ на iOS).
 *   2. Слушаем visibilitychange: когда вкладка снова активна И прошло >= 15s
 *      с момента клика — предлагаем выбрать outcome в модалке.
 *   3. finishCall(outcome, comment?) → PATCH /api/calls/{id}/finish/,
 *      закрываем модалку.
 *   4. skip() — тоже PATCH, но outcome="" (ряд остаётся в БД как
 *      «попытка без результата», менеджер увидит его в отчётах).
 *
 * Особенности iOS:
 *   - На iOS `tel:` уводит из браузера; при возвращении Safari вызывает
 *     `visibilitychange` → мы просыпаемся и показываем модалку.
 *   - Некоторые Android-браузеры не блюрят страницу для tel: — там
 *     модалка появится, только если оператор реально свернёт вкладку.
 *     Это ОК: если звонок был короткий и вкладка не свернулась, оператор
 *     может закрыть модалку кнопкой «Пропустить» (или использовать
 *     старый split-button для быстрого outcome).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";

const RETURN_DELAY_MS = 15_000; // не дёргать модалку если оператор ушёл < 15 сек

export type TrackedCallOutcome =
  | "talked_interested"
  | "talked_callback"
  | "no_answer"
  | "wrong_number"
  | "rejected"
  | "tg_only";

interface PendingCall {
  callAttemptId: number;
  leadId: number;
  leadName: string;
  leadPhone: string;
  startedAtMs: number;
}

interface UseTrackedCallResult {
  startCall: (lead: { id: number; full_name?: string | null; phone: string }) => Promise<void>;
  pending: PendingCall | null;
  modalOpen: boolean;
  closeModal: () => void;
  finish: (outcome: TrackedCallOutcome | "", comment?: string) => Promise<void>;
}

export function useTrackedCall(opts?: {
  onFinished?: (leadId: number, outcome: TrackedCallOutcome | "") => void;
}): UseTrackedCallResult {
  const [pending, setPending] = useState<PendingCall | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Ref-копия pending — visibilitychange handler читает актуальный
  // pending без пересоздания обработчика.
  const pendingRef = useRef<PendingCall | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const startCall = useCallback(async (lead: { id: number; full_name?: string | null; phone: string }) => {
    try {
      const { data } = await api.post<{ id: number }>("/calls/start/", {
        lead_id: lead.id,
        source: "click_to_call",
      });
      setPending({
        callAttemptId: data.id,
        leadId: lead.id,
        leadName: lead.full_name || lead.phone,
        leadPhone: lead.phone,
        startedAtMs: Date.now(),
      });
    } catch {
      // Даже если backend упал — запустим tel:, оператор всё равно
      // хочет позвонить. Метрику в этом случае потеряем — это ок для
      // Фазы 1 (полагаемся на честность оператора).
    }
    // eslint-disable-next-line no-restricted-syntax
    window.location.href = `tel:${lead.phone}`;
  }, []);

  const finish = useCallback(
    async (outcome: TrackedCallOutcome | "", comment?: string) => {
      const p = pendingRef.current;
      if (!p) {
        setModalOpen(false);
        return;
      }
      try {
        await api.patch(`/calls/${p.callAttemptId}/finish/`, {
          outcome: outcome || "",
          comment: comment || "",
          duration_seconds: Math.max(
            0,
            Math.round((Date.now() - p.startedAtMs) / 1000),
          ),
        });
      } catch {
        // Тихо: даже если PATCH упал, модалку закроем.
      }
      opts?.onFinished?.(p.leadId, outcome);
      setPending(null);
      setModalOpen(false);
    },
    [opts],
  );

  const closeModal = useCallback(() => setModalOpen(false), []);

  // visibilitychange: вернулись в вкладку → показываем модалку.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const p = pendingRef.current;
      if (!p) return;
      const elapsed = Date.now() - p.startedAtMs;
      if (elapsed < RETURN_DELAY_MS) return;
      setModalOpen(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  return { startCall, pending, modalOpen, closeModal, finish };
}
