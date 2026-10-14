import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, MessageCircleQuestion, Sparkles, X } from "lucide-react";
import { useLang } from "../../store/lang";
import { useHelperData } from "../../components/helper/useHelperData";
import type { HelperFaqItem, HelperSuggestion, Severity } from "../../components/helper/types";
import { EmptyState, ErrorState, LoadingBlock, cx } from "../ui";
import { useT2 } from "../i18n";
import { Layer } from "./shift";

/**
 * v2 operator helper (artboard OpHelper). Logic = old components/helper/*:
 * the floating button always polls /helper/operator-suggestions/ (60 s) for
 * the badge (total count, red when there is an urgent one); the drawer has
 * «Подсказки» and «Частые вопросы» tabs, Esc / backdrop close it, a
 * suggestion action navigates to its href and closes the drawer.
 */

const TONE: Record<Severity, { badge: string; key: string }> = {
  urgent: { badge: "b-bad", key: "helper.severity_urgent" },
  warning: { badge: "b-warn", key: "helper.severity_warning" },
  info: { badge: "b-info", key: "helper.severity_info" },
};

type Tab = "suggestions" | "faq";

export default function HelperButtonV2() {
  const t = useT2();
  const [open, setOpen] = useState(false);
  const q = useHelperData(true);
  const urgentCount = (q.data?.suggestions ?? []).filter((s) => s.severity === "urgent").length;
  const totalCount = q.data?.suggestions?.length ?? 0;

  return (
    <>
      <button
        type="button"
        className="btn btn-pri"
        onClick={() => setOpen(true)}
        aria-label={t("helper.button_aria")}
        title={t("helper.title")}
        style={{ position: "fixed", right: 24, bottom: 24, zIndex: 50, width: 52, height: 52, padding: 0, borderRadius: 999, boxShadow: "var(--shadow)" }}
      >
        <MessageCircleQuestion className="ic ic-l" />
        {totalCount > 0 ? (
          <span
            className={cx("cnt", urgentCount > 0 ? null : "cnt-mute")}
            aria-hidden
            style={{ position: "absolute", top: -4, right: -4, margin: 0, boxShadow: "0 0 0 2px var(--surface)" }}
          >
            {totalCount}
          </span>
        ) : null}
      </button>
      {open ? <HelperDrawer onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function HelperDrawer({ onClose }: { onClose: () => void }) {
  const t = useT2();
  const [tab, setTab] = useState<Tab>("suggestions");
  const q = useHelperData(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const suggestions = q.data?.suggestions ?? [];
  const faq = q.data?.faq ?? [];
  const urgent = suggestions.some((s) => s.severity === "urgent");

  return (
    <Layer z={55}>
      <div className="scrim" style={{ background: "rgba(21,19,43,.22)" }} onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={t("helper.title")} style={{ position: "fixed", width: 440 }}>
        <div className="row between" style={{ padding: "18px 20px 12px" }}>
          <div className="row g8">
            <span className="icon-tile t-info"><Sparkles className="ic" /></span>
            <h2 className="h2">{t("helper.title")}</h2>
          </div>
          <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("helper.close")} onClick={onClose}>
            <X className="ic" />
          </button>
        </div>
        <div className="tabs" role="tablist" style={{ padding: "0 20px", flex: "none" }}>
          <button className={cx("tab", tab === "suggestions" && "is-on")} type="button" role="tab" aria-selected={tab === "suggestions"} onClick={() => setTab("suggestions")}>
            {t("helper.tab_suggestions")}
            {suggestions.length ? <span className={cx("cnt", !urgent && "cnt-mute")}>{suggestions.length}</span> : null}
          </button>
          <button className={cx("tab", tab === "faq" && "is-on")} type="button" role="tab" aria-selected={tab === "faq"} onClick={() => setTab("faq")}>
            {t("helper.tab_faq")}
            {faq.length ? <span className="cnt cnt-mute">{faq.length}</span> : null}
          </button>
        </div>
        <div className="col g12" style={{ padding: "16px 20px", overflowY: "auto", flex: "1 1 0" }}>
          {q.isLoading ? (
            <LoadingBlock rows={3} />
          ) : q.isError ? (
            <ErrorState error={q.error} title={t("helper.error")} onRetry={() => void q.refetch()} />
          ) : tab === "suggestions" ? (
            suggestions.length === 0 ? (
              <EmptyState icon={<Sparkles className="ic ic-l" />} title={t("helper.no_suggestions")} />
            ) : (
              suggestions.map((s) => <SuggestionCardV2 key={s.id} s={s} onAction={onClose} />)
            )
          ) : faq.length === 0 ? (
            <EmptyState title={t("helper.faq_empty")} />
          ) : (
            <FaqV2 items={faq} />
          )}
        </div>
        <div className="xs c3" style={{ padding: "12px 20px", borderTop: "1px solid var(--line)", flex: "none" }}>{t("helper.refresh_hint")}</div>
      </aside>
    </Layer>
  );
}

function SuggestionCardV2({ s, onAction }: { s: HelperSuggestion; onAction: () => void }) {
  const t = useT2();
  const lang = useLang((st) => st.lang);
  const nav = useNavigate();
  const tone = TONE[s.severity] ?? TONE.info;
  const title = lang === "uz" ? s.title_uz : s.title_ru;
  const body = lang === "uz" ? s.body_uz : s.body_ru;
  const action = (lang === "uz" ? s.action_label_uz : s.action_label_ru) ?? t("helper.open_action");
  return (
    <section className="card col g8 pad" style={{ flex: "none" }}>
      <span className={cx("badge", tone.badge)} style={{ alignSelf: "flex-start" }}>{t(tone.key)}</span>
      <span className="s w6">{title}</span>
      <span className="s c3">{body}</span>
      {s.action_href ? (
        <button
          className="btn btn-sm"
          type="button"
          style={{ alignSelf: "flex-start" }}
          onClick={() => {
            nav(s.action_href!);
            onAction();
          }}
        >
          {action}
        </button>
      ) : null}
    </section>
  );
}

function FaqV2({ items }: { items: HelperFaqItem[] }) {
  const lang = useLang((st) => st.lang);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      {items.map((it) => {
        const isOpen = openId === it.id;
        return (
          <section key={it.id} className="card col" style={{ flex: "none", overflow: "hidden" }}>
            <button
              type="button"
              className="li"
              aria-expanded={isOpen}
              onClick={() => setOpenId(isOpen ? null : it.id)}
              style={{ minHeight: 48, width: "100%", textAlign: "left", background: "transparent", border: 0, cursor: "pointer", font: "inherit", color: "inherit" }}
            >
              <span className="s w6 grow">{lang === "uz" ? it.q_uz : it.q_ru}</span>
              <ChevronDown className="ic c3" style={{ transform: isOpen ? "rotate(180deg)" : undefined, transition: "transform .15s" }} />
            </button>
            {isOpen ? <p className="s c2" style={{ padding: "0 16px 14px", margin: 0, whiteSpace: "pre-line" }}>{lang === "uz" ? it.a_uz : it.a_ru}</p> : null}
          </section>
        );
      })}
    </>
  );
}
