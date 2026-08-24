import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useLang } from "../../store/lang";
import type { HelperFaqItem } from "./types";

interface Props {
  items: HelperFaqItem[];
}

export function FaqAccordion({ items }: Props) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const [openId, setOpenId] = useState<string | null>(null);

  if (!items?.length) {
    return (
      <div className="p-6 text-center text-[color:var(--text-muted)] text-sm">
        {t("helper.faq_empty")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => {
        const isOpen = openId === item.id;
        const q = lang === "uz" ? item.q_uz : item.q_ru;
        const a = lang === "uz" ? item.a_uz : item.a_ru;
        return (
          <div
            key={item.id}
            className="rounded-xl border border-[color:var(--border)] bg-[color:var(--bg-nested)] overflow-hidden"
          >
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : item.id)}
              className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left text-[14px] font-medium text-[color:var(--text-primary)] hover:bg-[color:var(--bg)]"
            >
              <span>{q}</span>
              <ChevronDown
                size={16}
                className="shrink-0 transition-transform"
                style={{
                  transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
                  color: "var(--text-muted)",
                }}
              />
            </button>
            {isOpen && (
              <div className="px-3 pb-3 text-[13px] text-[color:var(--text-secondary)] leading-relaxed whitespace-pre-line">
                {a}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
