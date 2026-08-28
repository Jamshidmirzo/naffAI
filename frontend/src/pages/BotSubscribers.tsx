/**
 * Manager UI: who is currently subscribed to @naffai_bot and which of
 * them actually receive the 3-hour leaderboard broadcast.
 *
 * Backend contract:
 *   GET   /api/bot/subscribers/       — full list
 *   PATCH /api/bot/subscribers/{id}/  — toggle `receives_broadcasts`
 *
 * The list is server-sorted (broadcasts-on first, then last_seen_at
 * DESC) — we render as-is. Toggle mutates optimistically; failure toasts
 * an error and the query auto-refetches to snap the row back.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { api } from "../lib/api";
import { Toggle, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

type LinkedOperator = {
  id: number;
  full_name: string;
  status: string;
  phone: string;
};

type LinkedProfile = {
  id: number;
  username: string;
  full_name: string;
  role: string;
};

type Subscriber = {
  id: number;
  chat_id: number;
  chat_title: string;
  phone: string;
  language: string;
  is_active: boolean;
  receives_broadcasts: boolean;
  blocked_at: string | null;
  linked_operator: LinkedOperator | null;
  linked_profile: LinkedProfile | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

function formatRelativeTime(iso: string, lang: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return lang === "uz" ? "hozirgina" : "только что";
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return lang === "uz" ? `${m} daq oldin` : `${m} мин назад`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return lang === "uz" ? `${h} soat oldin` : `${h} ч назад`;
  }
  const days = Math.floor(diff / 86400);
  if (days < 30) {
    return lang === "uz" ? `${days} kun oldin` : `${days} дн назад`;
  }
  return d.toLocaleDateString(lang === "uz" ? "uz-UZ" : "ru-RU");
}

function LinkedCell({ row, t }: { row: Subscriber; t: (k: string) => string }) {
  const op = row.linked_operator;
  const prof = row.linked_profile;
  if (op) {
    return (
      <div className="flex flex-col">
        <span className="font-medium">{op.full_name}</span>
        <span className="text-[12px] text-muted">
          {t("bot_subs.role_operator")}
        </span>
      </div>
    );
  }
  if (prof) {
    const roleLabel =
      prof.role === "operator"
        ? t("bot_subs.role_operator")
        : t("bot_subs.role_manager");
    return (
      <div className="flex flex-col">
        <span className="font-medium">
          {prof.full_name || prof.username || `#${prof.id}`}
        </span>
        <span className="text-[12px] text-muted">{roleLabel}</span>
      </div>
    );
  }
  return <span className="text-muted">—</span>;
}

export default function BotSubscribers() {
  const t = useT();
  const qc = useQueryClient();
  usePageHeader(
    { title: t("bot_subs.title"), subtitle: t("bot_subs.subtitle") },
    [t("bot_subs.title")],
  );

  const list = useQuery({
    queryKey: ["bot-subscribers"],
    queryFn: () =>
      api
        .get<{ results: Subscriber[]; count: number }>("/bot/subscribers/")
        .then((r) => r.data.results),
  });

  const toggle = useMutation({
    mutationFn: async (p: { id: number; receives_broadcasts: boolean }) =>
      api.patch<Subscriber>(`/bot/subscribers/${p.id}/`, {
        receives_broadcasts: p.receives_broadcasts,
      }),
    onMutate: async (p) => {
      // Optimistic update — flip the toggle immediately so the UI feels
      // instant. If the PATCH fails, we invalidate below and the row
      // snaps back to server truth.
      await qc.cancelQueries({ queryKey: ["bot-subscribers"] });
      const prev = qc.getQueryData<Subscriber[]>(["bot-subscribers"]);
      if (prev) {
        qc.setQueryData<Subscriber[]>(
          ["bot-subscribers"],
          prev.map((row) =>
            row.id === p.id
              ? { ...row, receives_broadcasts: p.receives_broadcasts }
              : row,
          ),
        );
      }
      return { prev };
    },
    onError: (err, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(["bot-subscribers"], ctx.prev);
      const detail =
        err instanceof AxiosError ? err.response?.data?.detail : "";
      toast.error(
        detail ? `${t("bot_subs.toggle_failed")}: ${detail}` : t("bot_subs.toggle_failed"),
      );
    },
    onSuccess: () => {
      toast.success(t("bot_subs.toggle_saved"));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["bot-subscribers"] });
    },
  });

  const rows = list.data ?? [];
  // Detect UI language via one t() output so relative-time honours it
  // without threading Lang store manually.
  const uiLang = t("common.loading") === "Загрузка…" ? "ru" : "uz";

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{
            gridTemplateColumns:
              "1.5fr 1.1fr 1.3fr .6fr 1.1fr 1fr",
          }}
        >
          <div>{t("bot_subs.col.chat")}</div>
          <div>{t("bot_subs.col.phone")}</div>
          <div>{t("bot_subs.col.linked")}</div>
          <div>{t("bot_subs.col.lang")}</div>
          <div className="text-center">{t("bot_subs.col.broadcast")}</div>
          <div className="text-right">{t("bot_subs.col.last_seen")}</div>
        </div>

        {list.isLoading ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("common.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-8 py-16 text-center flex flex-col items-center gap-3">
            <div className="text-[16px] font-semibold">
              {t("bot_subs.empty_title")}
            </div>
            <div className="text-[13px] text-muted max-w-[520px]">
              {t("bot_subs.empty_hint")}
            </div>
          </div>
        ) : (
          <div>
            {rows.map((row, i) => (
              <div
                key={row.id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns:
                    "1.5fr 1.1fr 1.3fr .6fr 1.1fr 1fr",
                  animationDelay: `${0.02 + i * 0.02}s`,
                  cursor: "default",
                }}
              >
                <div className="flex flex-col">
                  <span className="font-medium">
                    {row.chat_title || `chat#${row.chat_id}`}
                  </span>
                  <span className="text-[12px] text-muted">
                    {row.blocked_at && (
                      <span className="text-red-500">
                        {t("bot_subs.blocked_badge")}
                      </span>
                    )}
                    {!row.blocked_at && !row.is_active && (
                      <span>{t("bot_subs.inactive_badge")}</span>
                    )}
                  </span>
                </div>
                <div className="text-[13px] font-mono">
                  {row.phone || <span className="text-muted">—</span>}
                </div>
                <div>
                  <LinkedCell row={row} t={t} />
                </div>
                <div className="uppercase text-[12px] text-muted">
                  {row.language}
                </div>
                <div className="flex justify-center">
                  <Toggle
                    on={row.receives_broadcasts}
                    onChange={(v) =>
                      toggle.mutate({
                        id: row.id,
                        receives_broadcasts: v,
                      })
                    }
                    disabled={toggle.isPending}
                    aria-label={t("bot_subs.col.broadcast")}
                  />
                </div>
                <div className="text-right text-[13px] text-muted">
                  {formatRelativeTime(row.last_seen_at, uiLang)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
