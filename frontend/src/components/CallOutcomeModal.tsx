/**
 * CallOutcomeModal — Фаза 1 click-to-call: показывается после того,
 * как оператор нажал 📞, поговорил (или не поговорил) и вернулся в CRM.
 * 6 больших кнопок исхода + опциональный комментарий + «Пропустить».
 *
 * Пропуск сохраняет ряд CallAttempt с пустым outcome — менеджер увидит
 * его как «попытку без результата» и сможет расспросить оператора.
 */
import { useState } from "react";

import { useT } from "../lib/i18n";
import type { TrackedCallOutcome } from "../hooks/useTrackedCall";

interface Props {
  open: boolean;
  leadName: string;
  leadPhone: string;
  onSelect: (outcome: TrackedCallOutcome | "", comment: string) => void;
  onClose: () => void;
}

const OUTCOMES: { code: TrackedCallOutcome; emoji: string; key: string }[] = [
  { code: "talked_interested", emoji: "🗣️", key: "call_attempt.outcome.talked_interested" },
  { code: "talked_callback",   emoji: "⏰", key: "call_attempt.outcome.talked_callback" },
  { code: "no_answer",         emoji: "☎️", key: "call_attempt.outcome.no_answer" },
  { code: "wrong_number",      emoji: "🚫", key: "call_attempt.outcome.wrong_number" },
  { code: "rejected",          emoji: "❌", key: "call_attempt.outcome.rejected" },
  { code: "tg_only",           emoji: "💬", key: "call_attempt.outcome.tg_only" },
];

export default function CallOutcomeModal({
  open,
  leadName,
  leadPhone,
  onSelect,
  onClose,
}: Props) {
  const t = useT();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<TrackedCallOutcome | "" | null>(null);

  if (!open) return null;

  const pick = async (code: TrackedCallOutcome | "") => {
    setBusy(code);
    onSelect(code, comment.trim());
    // Родитель сам закроет модалку — но на всякий случай сбросим локальный
    // busy через микротакт (если parent не размонтирует нас мгновенно).
    setTimeout(() => setBusy(null), 200);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-4"
      style={{
        background: "rgba(20,12,6,.42)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
      }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-3xl overflow-hidden animate-nfFadeUp"
        style={{
          background: "var(--bg-card, #fff)",
          border: "1.5px solid var(--border-main, #eee)",
          boxShadow: "0 24px 60px -20px rgba(0,0,0,.35)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-3">
          <div className="text-[13px] uppercase tracking-wide text-muted">
            {t("call_attempt.modal.title")}
          </div>
          <div className="text-[17px] font-semibold mt-1 truncate">
            {leadName}
          </div>
          <div className="text-[13px] text-muted tabular-nums font-mono">
            {leadPhone}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 px-4 pb-3">
          {OUTCOMES.map((o) => (
            <button
              key={o.code}
              type="button"
              disabled={busy !== null}
              onClick={() => pick(o.code)}
              className="rounded-2xl px-3 py-4 text-left transition-transform active:scale-[.97] disabled:opacity-60"
              style={{
                background: "var(--faint, #f6f6f6)",
                border: "1.5px solid var(--border, #eee)",
                minHeight: 72,
              }}
            >
              <div className="text-[22px] leading-none">{o.emoji}</div>
              <div className="text-[13.5px] font-semibold mt-1.5">
                {t(o.key)}
              </div>
            </button>
          ))}
        </div>

        <div className="px-4 pb-3">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("call_attempt.modal.comment_placeholder")}
            rows={2}
            className="w-full rounded-xl px-3 py-2 text-[13.5px] resize-none"
            style={{
              background: "var(--surface, #fff)",
              border: "1.5px solid var(--border, #eee)",
              outline: "none",
            }}
          />
        </div>

        <div className="flex gap-2 px-4 pb-4">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => pick("")}
            className="flex-1 rounded-xl py-2.5 text-[13.5px] font-medium disabled:opacity-60"
            style={{
              background: "transparent",
              border: "1.5px solid var(--border, #eee)",
              color: "var(--text-muted, #666)",
            }}
          >
            {t("call_attempt.modal.skip")}
          </button>
        </div>
      </div>
    </div>
  );
}
