import { useNavigate } from "react-router-dom";
import { AlertTriangle, Info, Zap, type LucideIcon } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useLang } from "../../store/lang";
import type { HelperSuggestion, Severity } from "./types";

const SEVERITY_META: Record<
  Severity,
  { icon: LucideIcon; badgeKey: string; tone: string }
> = {
  urgent: { icon: Zap, badgeKey: "helper.severity_urgent", tone: "urgent" },
  warning: {
    icon: AlertTriangle,
    badgeKey: "helper.severity_warning",
    tone: "warning",
  },
  info: { icon: Info, badgeKey: "helper.severity_info", tone: "info" },
};

// Tailwind can't statically analyze dynamic classes, so pre-declare all combos.
const TONE_STYLES: Record<string, { card: React.CSSProperties; badge: React.CSSProperties }> = {
  urgent: {
    card: {
      borderColor: "rgba(220,38,38,.45)",
      background: "linear-gradient(180deg, rgba(220,38,38,.09) 0%, rgba(220,38,38,.03) 100%)",
    },
    badge: { color: "#dc2626", background: "rgba(220,38,38,.14)" },
  },
  warning: {
    card: {
      borderColor: "rgba(217,119,6,.45)",
      background: "linear-gradient(180deg, rgba(217,119,6,.09) 0%, rgba(217,119,6,.03) 100%)",
    },
    badge: { color: "#b45309", background: "rgba(217,119,6,.14)" },
  },
  info: {
    card: {
      borderColor: "var(--border)",
      background: "var(--bg-nested)",
    },
    badge: { color: "var(--text-muted)", background: "var(--bg-nested)" },
  },
};

interface Props {
  suggestion: HelperSuggestion;
  onAction: () => void;
}

/**
 * A single suggestion card — severity-tinted border/bg, title + body,
 * optional action button. Click → navigate(href) + tell parent to close panel.
 */
export function SuggestionCard({ suggestion, onAction }: Props) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const navigate = useNavigate();
  const meta = SEVERITY_META[suggestion.severity] ?? SEVERITY_META.info;
  const styles = TONE_STYLES[meta.tone];
  const Icon = meta.icon;

  const title = lang === "uz" ? suggestion.title_uz : suggestion.title_ru;
  const body = lang === "uz" ? suggestion.body_uz : suggestion.body_ru;
  const actionLabel =
    lang === "uz"
      ? suggestion.action_label_uz ?? t("helper.open_action")
      : suggestion.action_label_ru ?? t("helper.open_action");

  const handleClick = () => {
    if (suggestion.action_href) {
      navigate(suggestion.action_href);
      onAction();
    }
  };

  return (
    <div
      className="rounded-2xl border p-4 flex flex-col gap-2"
      style={styles.card}
    >
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
          style={styles.badge}
        >
          <Icon size={12} />
          {t(meta.badgeKey)}
        </span>
      </div>
      <div className="font-semibold text-[15px] text-[color:var(--text-primary)] leading-snug">
        {title}
      </div>
      <div className="text-[13px] text-[color:var(--text-secondary)] leading-relaxed">
        {body}
      </div>
      {suggestion.action_href && (
        <button
          type="button"
          onClick={handleClick}
          className="mt-1 self-start px-3 py-1.5 rounded-lg text-[13px] font-medium"
          style={{
            background: "var(--accent)",
            color: "var(--accent-fg, #fff)",
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
