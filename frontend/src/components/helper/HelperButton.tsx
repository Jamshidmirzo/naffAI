import { useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { useT } from "../../lib/i18n";
import { HelperPanel } from "./HelperPanel";
import { useHelperData } from "./useHelperData";

/**
 * Floating helper button (operator-only). Always mounted for the
 * operator role, but the underlying react-query request is lazy — it
 * fetches when the panel opens or when the button badge needs the
 * urgent count. Badge shows number of urgent-severity suggestions;
 * hidden when 0.
 *
 * Positioning: fixed bottom-6 right-6, z-50 so it stays above sticky
 * headers/tables. On mobile the panel becomes full-width.
 */
export function HelperButton() {
  const t = useT();
  const [open, setOpen] = useState(false);

  // Fetch always (60s poll) so the badge is live even when the panel is closed.
  // Backend caches for 30s → минимум лишней нагрузки.
  const q = useHelperData(true);
  const urgentCount = (q.data?.suggestions ?? []).filter(
    (s) => s.severity === "urgent",
  ).length;
  const totalCount = q.data?.suggestions?.length ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("helper.button_aria")}
        title={t("helper.title")}
        className="fixed z-50 flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
        style={{
          bottom: 24,
          right: 24,
          width: 56,
          height: 56,
          borderRadius: 999,
          background: "var(--accent)",
          color: "var(--accent-fg, #fff)",
          boxShadow: "0 12px 32px rgba(0,0,0,.22), 0 4px 12px rgba(0,0,0,.14)",
        }}
      >
        <MessageCircleQuestion size={26} />
        {totalCount > 0 && (
          <span
            aria-hidden
            className="absolute flex items-center justify-center text-[11px] font-bold tabular-nums"
            style={{
              top: -4,
              right: -4,
              minWidth: 22,
              height: 22,
              padding: "0 6px",
              borderRadius: 999,
              background: urgentCount > 0 ? "#dc2626" : "var(--bg)",
              color: urgentCount > 0 ? "#fff" : "var(--text-primary)",
              border: "2px solid var(--bg)",
              boxShadow: "0 2px 6px rgba(0,0,0,.18)",
            }}
          >
            {totalCount}
          </span>
        )}
      </button>
      <HelperPanel open={open} onClose={() => setOpen(false)} />
    </>
  );
}
