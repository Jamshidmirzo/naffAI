import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Button, Toggle, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import { formatDateTime } from "../lib/format";

interface NotificationRow {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  read_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface NotifResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: NotificationRow[];
  unread_count: number;
}

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
  const qc = useQueryClient();
  const nav = useNavigate();
  usePageHeader({
    title: t("notif.title"),
    subtitle: t("notif.header_subtitle"),
  });

  const q = useQuery<NotifResponse>({
    queryKey: ["notifications", "list"],
    queryFn: () =>
      api.get<NotifResponse>("/notifications/").then((r) => r.data),
    refetchInterval: 30_000,
  });

  const markOne = useMutation({
    mutationFn: (id: number) => api.post("/notifications/mark-read/", { ids: [id] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const markAll = useMutation({
    mutationFn: () => api.post("/notifications/mark-all-read/"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      toast.success(t("notif.all_marked"));
    },
  });

  const items = q.data?.results ?? [];
  const unread = q.data?.unread_count ?? 0;
  const total = q.data?.count ?? items.length;

  const [subs, setSubs] = useState<SubSetting[]>(SUBS_INITIAL);
  const toggleSub = (key: string, on: boolean) => {
    setSubs((prev) => prev.map((s) => (s.key === key ? { ...s, on } : s)));
    toast.success(t("toast.settings_saved"));
  };

  const handleClick = (n: NotificationRow) => {
    if (!n.read_at) markOne.mutate(n.id);
    if (n.link) nav(n.link);
  };

  return (
    <div className="mx-auto max-w-[820px] flex flex-col gap-5">
      <section className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px] text-muted">
          {q.isLoading ? (
            t("common.loading")
          ) : unread > 0 ? (
            <>{t("notif.unread_of_total", { unread, total })}</>
          ) : (
            <>{t("notif.total_only", { n: total })}</>
          )}
        </div>
        {unread > 0 && (
          <Button variant="ghost" size="sm" onClick={() => markAll.mutate()}>
            {t("notif.mark_all_short")}
          </Button>
        )}
      </section>

      <section className="flex flex-col gap-2">
        {!q.isLoading && items.length === 0 && (
          <div
            className="rounded-2xl py-12 text-center text-[13.5px] text-muted"
            style={{ border: "1.5px dashed var(--border)" }}
          >
            {t("notif.empty_soft")}
          </div>
        )}
        {items.map((it, i) => {
          const isRead = !!it.read_at;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => handleClick(it)}
              className="text-left flex items-start gap-3.5 transition animate-nfFadeUp"
              style={{
                padding: "14px 18px",
                borderRadius: 18,
                background: "var(--surface)",
                border: isRead
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
                  background: isRead ? "var(--faint2)" : "var(--accent)",
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-[14px]" style={{ fontWeight: 550 }}>
                  {it.title}
                </div>
                {it.body && (
                  <div className="text-[12.5px] text-muted mt-0.5">{it.body}</div>
                )}
              </div>
              <div className="text-[12px] text-muted shrink-0 tabular-nums">
                {formatDateTime(it.created_at)}
              </div>
            </button>
          );
        })}
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
