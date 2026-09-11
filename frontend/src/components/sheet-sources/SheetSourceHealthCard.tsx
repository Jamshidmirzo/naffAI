/**
 * One health card in the /sheet-sources top row.
 *
 * Shows the source name, current health (green/yellow/red), leads-in-
 * last-24h, a "Sync now" trigger, and clicking a red card unfolds the
 * `last_sync_error` inline so the manager can act on it.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Settings2 } from "lucide-react";
import { api } from "../../lib/api";
import { toast } from "../ui";
import { useT } from "../../lib/i18n";

type Stats = {
  id: number;
  name: string;
  active: boolean;
  leads_total: number;
  leads_last_24h: number;
  leads_last_7d: number;
  sales_from_source: number;
  last_sync_at: string | null;
  last_sync_error: string | null;
  is_healthy: boolean;
};

type Props = {
  sourceId: number;
  fallbackName: string;
  onConfigure: () => void;
};

export function SheetSourceHealthCard({ sourceId, fallbackName, onConfigure }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const [errorOpen, setErrorOpen] = useState(false);

  const q = useQuery({
    queryKey: ["sheet-source-stats", sourceId],
    queryFn: () =>
      api.get<Stats>(`/sheet-sources/${sourceId}/stats/`).then((r) => r.data),
    refetchInterval: 60_000,
  });

  const sync = useMutation({
    mutationFn: () => api.post(`/sheet-sources/${sourceId}/sync-now/`),
    onSuccess: (r) => {
      const d = r.data as { imported?: number; created?: number; error?: string };
      toast.success(
        t("sheet_src.health.sync_ok", {
          n: String(d.created ?? d.imported ?? 0),
        }),
      );
      qc.invalidateQueries({ queryKey: ["sheet-source-stats", sourceId] });
      qc.invalidateQueries({ queryKey: ["sheet-sources"] });
    },
    onError: (err: unknown) => {
      const e = err as {
        response?: { status?: number; data?: { detail?: string } };
      };
      const detail =
        e?.response?.data?.detail || t("sheet_src.health.sync_failed");
      if (e?.response?.status === 429) {
        toast.error(detail);
      } else {
        toast.error(detail);
      }
    },
  });

  const s = q.data;
  const status: "ok" | "warn" | "bad" = !s
    ? "warn"
    : s.last_sync_error
      ? "bad"
      : s.is_healthy
        ? "ok"
        : "warn";

  const dot = {
    ok: "#22c55e",
    warn: "#f59e0b",
    bad: "#ef4444",
  }[status];

  const label = {
    ok: t("sheet_src.health.ok"),
    warn: t("sheet_src.health.warn"),
    bad: t("sheet_src.health.bad"),
  }[status];

  const last =
    s?.last_sync_at != null
      ? new Date(s.last_sync_at).toLocaleString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
          day: "2-digit",
          month: "2-digit",
        })
      : "—";

  return (
    <div
      className="nf-card p-4 flex flex-col gap-3"
      style={{ minWidth: 220 }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-[14px] truncate">
            {s?.name || fallbackName}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: dot,
                display: "inline-block",
              }}
            />
            <span>{label}</span>
          </div>
        </div>
        <button
          className="grid place-items-center rounded-full hover:bg-[color:var(--faint)]"
          style={{ width: 28, height: 28 }}
          onClick={onConfigure}
          title={t("sheet_src.health.configure")}
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex items-end justify-between">
        <div>
          <div
            className="text-[22px] leading-none font-semibold tabular-nums"
            style={{ letterSpacing: -0.2 }}
          >
            {s?.leads_last_24h ?? "—"}
          </div>
          <div className="text-[11px] text-muted mt-0.5">
            {t("sheet_src.health.leads_24h")}
          </div>
        </div>
        <div className="text-right text-[11px] text-muted">
          <div>{t("sheet_src.health.last_sync")}: {last}</div>
          <div>{t("sheet_src.health.leads_total", { n: String(s?.leads_total ?? 0) })}</div>
        </div>
      </div>
      <button
        className="nf-btn nf-btn--ghost text-[12px] flex items-center justify-center gap-1.5"
        style={{ padding: "7px 10px" }}
        onClick={() => sync.mutate()}
        disabled={sync.isPending}
      >
        <RefreshCw
          className={"w-3.5 h-3.5 " + (sync.isPending ? "animate-spin" : "")}
        />
        {sync.isPending
          ? t("sheet_src.health.syncing")
          : t("sheet_src.health.sync_now")}
      </button>
      {status === "bad" && s?.last_sync_error && (
        <div>
          <button
            className="text-[11.5px] underline"
            style={{ color: "var(--danger)" }}
            onClick={() => setErrorOpen((v) => !v)}
          >
            {errorOpen
              ? t("sheet_src.health.hide_error")
              : t("sheet_src.health.show_error")}
          </button>
          {errorOpen && (
            <div
              className="mt-2 text-[11.5px] rounded-lg px-2.5 py-2 whitespace-pre-wrap break-words"
              style={{
                background: "rgba(220,60,40,.08)",
                color: "var(--danger)",
              }}
            >
              {s.last_sync_error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
