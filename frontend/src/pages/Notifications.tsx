import { useMemo, useState } from "react";
import { Button, Toggle, toast } from "../components/ui";
import { usePageHeader } from "../store/page";

interface NotifItem {
  id: number;
  title: string;
  body: string;
  time: string;
  read: boolean;
}

const MOCK_INITIAL: NotifItem[] = [
  {
    id: 1,
    title: "Новый лид назначен",
    body: "Умид Каримов, +998 90 123-45-67 — конверсия высокая.",
    time: "5 мин",
    read: false,
  },
  {
    id: 2,
    title: "Callback через 15 минут",
    body: "Малика Умарова просила перезвонить в 14:30.",
    time: "12 мин",
    read: false,
  },
  {
    id: 3,
    title: "Утренний разбор готов",
    body: "AI-анализ вчерашнего дня — 3 совета, 2 сильных момента.",
    time: "утро",
    read: false,
  },
  {
    id: 4,
    title: "Отчёт за неделю",
    body: "12 продаж, 84 млн выручка, +8% к прошлой неделе.",
    time: "вчера",
    read: true,
  },
];

interface SubSetting {
  key: string;
  label: string;
  hint: string;
  on: boolean;
}

const SUBS_INITIAL: SubSetting[] = [
  { key: "new_leads", label: "Новые лиды", hint: "Уведомлять о каждом назначенном лиде", on: true },
  { key: "callbacks_sound", label: "Колбэки со звуком", hint: "Звуковой сигнал при наступлении времени", on: true },
  { key: "lessons", label: "Уроки и разборы", hint: "Утренний AI-разбор и рекомендации", on: true },
  { key: "daily_kpi", label: "Ежедневный отчёт по KPI", hint: "Сводка личных показателей за день", on: false },
];

export default function Notifications() {
  usePageHeader({
    title: "Уведомления",
    subtitle: "Что присылать в интерфейс и в Telegram-бот",
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
    toast.success("Все уведомления прочитаны");
  };

  const toggleSub = (key: string, on: boolean) => {
    setSubs((prev) => prev.map((s) => (s.key === key ? { ...s, on } : s)));
    toast.success("Настройка сохранена");
  };

  return (
    <div className="mx-auto max-w-[820px] flex flex-col gap-5">
      <section className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px] text-muted">
          {unread > 0 ? (
            <>
              <span className="text-text font-semibold tabular-nums">{unread}</span>{" "}
              новых · всего{" "}
              <span className="tabular-nums">{items.length}</span>
            </>
          ) : (
            <>Всего <span className="text-text tabular-nums">{items.length}</span></>
          )}
        </div>
        {unread > 0 && (
          <Button variant="ghost" size="sm" onClick={markAllRead}>
            Прочитать всё
          </Button>
        )}
      </section>

      <section className="flex flex-col gap-2">
        {items.length === 0 && (
          <div
            className="rounded-2xl py-12 text-center text-[13.5px] text-muted"
            style={{ border: "1.5px dashed var(--border)" }}
          >
            Уведомлений пока нет
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
                {it.title}
              </div>
              <div className="text-[12.5px] text-muted mt-0.5">{it.body}</div>
            </div>
            <div className="text-[12px] text-muted shrink-0 tabular-nums">
              {it.time}
            </div>
          </button>
        ))}
      </section>

      <section
        className="nf-card animate-nfFadeUp"
        style={{ padding: "22px 26px", animationDelay: "0.15s" }}
      >
        <div className="text-[15px] font-semibold">Подписки</div>
        <p className="text-[12.5px] text-muted mt-1">
          Что присылать в интерфейс и в Telegram-бот
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
                <div className="text-[14px] font-medium">{s.label}</div>
                <div className="text-[12px] text-muted mt-0.5">{s.hint}</div>
              </div>
              <Toggle
                on={s.on}
                onChange={(v) => toggleSub(s.key, v)}
                aria-label={s.label}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
