import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { TabPill } from "../ui/TabPill";
import { useT } from "../../lib/i18n";
import { SuggestionCard } from "./SuggestionCard";
import { FaqAccordion } from "./FaqAccordion";
import { useHelperData } from "./useHelperData";

type Tab = "suggestions" | "faq";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Right-side drawer with two tabs:
 *   - suggestions: live rule-engine output (auto-refresh 60s).
 *   - faq:         static Q&A list.
 *
 * Mobile behaviour: width falls to 100vw <640px; header is sticky so
 * close-cross and tabs stay visible when a suggestion body is long.
 */
export function HelperPanel({ open, onClose }: Props) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("suggestions");
  const q = useHelperData(open);

  // ESC-to-close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const suggestions = q.data?.suggestions ?? [];
  const faq = q.data?.faq ?? [];

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      style={{ background: "rgba(20,12,6,.28)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("helper.title")}
    >
      <div
        className="h-full w-full max-w-[440px] flex flex-col shadow-2xl border-l"
        style={{
          background: "var(--bg)",
          borderColor: "var(--border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b sticky top-0 z-10"
          style={{ borderColor: "var(--border)", background: "var(--bg)" }}
        >
          <div>
            <div className="text-[15px] font-semibold text-[color:var(--text-primary)]">
              {t("helper.title")}
            </div>
            <div className="text-[11px] text-[color:var(--text-muted)]">
              {t("helper.refresh_hint")}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("helper.close")}
            className="p-2 rounded-lg hover:bg-[color:var(--bg-nested)] text-[color:var(--text-muted)]"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div
          className="px-5 py-3 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <TabPill<Tab>
            block
            value={tab}
            onChange={setTab}
            items={[
              {
                value: "suggestions",
                label: t("helper.tab_suggestions"),
                count: suggestions.length || undefined,
              },
              {
                value: "faq",
                label: t("helper.tab_faq"),
                count: faq.length || undefined,
              },
            ]}
          />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 nf-scroll-thin">
          {tab === "suggestions" ? (
            q.isLoading ? (
              <div className="text-center text-[color:var(--text-muted)] text-sm py-10">
                {t("helper.loading")}
              </div>
            ) : q.isError ? (
              <div className="text-center text-[color:var(--text-muted)] text-sm py-10">
                {t("helper.error")}
              </div>
            ) : suggestions.length === 0 ? (
              <div className="text-center text-[color:var(--text-muted)] text-sm py-10">
                {t("helper.no_suggestions")}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {suggestions.map((s) => (
                  <SuggestionCard
                    key={s.id}
                    suggestion={s}
                    onAction={onClose}
                  />
                ))}
              </div>
            )
          ) : (
            <FaqAccordion items={faq} />
          )}
        </div>
      </div>
    </div>
  );
}
