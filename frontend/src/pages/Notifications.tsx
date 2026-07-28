import { useMemo, useState } from "react";
import { Button, Toggle, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface NotifItem {
  id: number;
  titleKey: string;
  bodyKey: string;
  timeKey: string;
  read: boolean;
}

const MOCK_INITIAL: NotifItem[] = [
  {
    id: 1,
    titleKey: "notif.demo_lead_title",
    bodyKey: "notif.demo_lead_body",
    timeKey: "notif.demo_time_5min",
    read: false,
  },
  {
    id: 2,
    titleKey: "notif.demo_callback_title",
    bodyKey: "notif.demo_callback_body",
    timeKey: "notif.demo_time_12min",
    read: false,
  },
  {
    id: 3,
    titleKey: "notif.demo_morning_title",
    bodyKey: "notif.demo_morning_body",
    timeKey: "notif.demo_time_morning",
    read: false,
  },
  {
    id: 4,
    titleKey: "notif.demo_week_title",
    bodyKey: "notif.demo_week_body",
    timeKey: "notif.demo_time_yesterday",
    read: true,
  },
];

interface SubSetting {
  key: string;
  labelKey: string;
  hintKey: string;
  on: boolean;
}

const SUBS_INITIAL: SubSetting[] = [
  { key: "new_leads", labelKey: "notif.sub_new_leads", hintKey: "notif.sub_new_leads_hint", on: true },
  { key: "callbacks_sound", labelKey: "notif.sub_callbacks", hintKey: "notif.sub_callbacks_hint", on: true },
  { key: "lessons", labelKey: "notif.sub_lessons", hintKey: "notif.sub_lessons_hint", on: true },
  { key: "daily_kpi", labelKey: "notif.sub_daily_kpi", hintKey: "notif.sub_daily_kpi_hint", on: false },
];

export default function Notifications() {
  const t = useT();
  usePageHeader({
    title: t("notif.title"),
    subtitle: t("notif.header_subtitle"),
  });

  const [items, setItems] = useState<NotifItem[]>(MOCK_INITIAL);
  const [subs, setSubs] = useState<SubSetting[]>(SUBS_INITIAL);

  const unread = useMemo(() => items.filter((i) => !i.read).length, [items]);

  const markRead = (id: number) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, read: true } : it)),
    );
  };

  const markAllRead = () => {
    setItems((prev) => prev.map((it) => ({ ...it, read: true })));
    toast.success(t("notif.all_marked"));
  };

  const toggleSub = (key: string, on: boolean) => {
    setSubs((prev) => prev.map((s) => (s.key === key ? { ...s, on } : s)));
    toast.success(t("toast.settings_saved"));
  };

  return (
    <div className="mx-auto max-w-[820px] flex flex-col gap-5">
      <section className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px] text-muted">
          {unread > 0 ? (
            <>{t("notif.unread_of_total", { unread, total: items.length })}</>
          ) : (
            <>{t("notif.total_only", { n: items.length })}</>
          )}
        </div>
        {unread > 0 && (
          <Button variant="ghost" size="sm" onClick={markAllRead}>
            {t("notif.mark_all_short")}
          </Button>
        )}
      </section>

      <section className="flex flex-col gap-2">
        {items.length === 0 && (
          <div
            className="rounded-2xl py-12 text-center text-[13.5px] text-muted"
            style={{ border: "1.5px dashed var(--border)" }}
          >
            {t("notif.empty_soft")}
          </div>
        )}
        {items.map((it, i) => (
          <button
            key={it.id}
            type="button"
            onClick={() => markRead(it.id)}
            className="text-left flex items-start gap-3.5 transition animate-nfFadeUp"
            style={{
              padding: "14px 18px",
              borderRadius: 18,
              background: "var(--surface)",
              border: it.read
                ? "1px solid var(--border)"
                : "1px solid rgba(242,86,11,.35)",
              boxShadow: "var(--shadow)",
              animationDelay: `${0.03 + i * 0.045}s`,
            }}
          >
            <span
              className="mt-1.5 shrink-0 rounded-full"
              style={{
                width: 8,
                height: 8,
                background: it.read ? "var(--faint2)" : "var(--accent)",
              }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-[14px]" style={{ fontWeight: 550 }}>
                {t(it.titleKey)}
              </div>
              <div className="text-[12.5px] text-muted mt-0.5">{t(it.bodyKey)}</div>
            </div>
            <div className="text-[12px] text-muted shrink-0 tabular-nums">
              {t(it.timeKey)}
            </div>
          </button>
        ))}
      </section>

      <section
        className="nf-card animate-nfFadeUp"
        style={{ padding: "22px 26px", animationDelay: "0.15s" }}
      >
        <div className="text-[15px] font-semibold">{t("notif.subs_title")}</div>
        <p className="text-[12.5px] text-muted mt-1">
          {t("notif.subs_subtitle")}
        </p>
        <div className="mt-4 flex flex-col">
          {subs.map((s, i) => (
            <div
              key={s.key}
              className="flex items-center gap-4 py-3.5"
              style={
                i === subs.length - 1
                  ? undefined
                  : { borderBottom: "1px solid var(--border)" }
              }
            >
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium">{t(s.labelKey)}</div>
                <div className="text-[12px] text-muted mt-0.5">{t(s.hintKey)}</div>
              </div>
              <Toggle
                on={s.on}
                onChange={(v) => toggleSub(s.key, v)}
                aria-label={t(s.labelKey)}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
