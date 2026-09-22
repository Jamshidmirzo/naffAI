import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  Clock,
  Download,
  FileText,
  Loader2,
  MessageSquare,
  Phone,
  Users2,
  Wallet,
} from "lucide-react";
import { Button, Chip, Eyebrow, toast, type TabItem } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import { api } from "../lib/api";

type Period = "today" | "week" | "month" | "custom";

/** Compute {date_from, date_to} in YYYY-MM-DD for the selected period. */
function periodRange(p: Period): { date_from: string; date_to: string } {
  const now = new Date();
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = fmt(now);
  if (p === "today") return { date_from: today, date_to: today };
  if (p === "week") {
    const past = new Date(now);
    past.setDate(past.getDate() - 6);
    return { date_from: fmt(past), date_to: today };
  }
  if (p === "month" || p === "custom") {
    const past = new Date(now);
    past.setDate(past.getDate() - 29);
    return { date_from: fmt(past), date_to: today };
  }
  return { date_from: today, date_to: today };
}

interface ReportCard {
  key: string;
  title: string;
  description: string;
  meta: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Backend endpoint that returns an xlsx blob. Receives the selected
   * period as `date_from`/`date_to` (or year+month for payroll).
   */
  xlsxUrl?: string;
  /** Special param builder for endpoints that don't use date_from/date_to. */
  buildParams?: (period: Period) => Record<string, string>;
  /** In-app link instead of download (e.g. activity → /leads-stats). */
  linkTo?: string;
}

interface RecentExport {
  key: string;
  filename: string;
  sizeBytes: number;
  when: number; // epoch ms
}

const LS_KEY = "naff:reports:recent";

function loadRecent(): RecentExport[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, 10) : [];
  } catch {
    return [];
  }
}

function saveRecent(list: RecentExport[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* quota exceeded — ignore */
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtWhen(epochMs: number, t: (k: string, p?: Record<string, string | number>) => string): string {
  const diffSec = Math.floor((Date.now() - epochMs) / 1000);
  if (diffSec < 60) return t("common.just_now") || "только что";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min`;
  const d = new Date(epochMs);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return t("reports.when_today_time") + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return t("reports.when_yesterday");
  return d.toLocaleDateString();
}

export default function Reports() {
  const [period, setPeriod] = useState<Period>("today");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentExport[]>(() => loadRecent());
  const t = useT();

  useEffect(() => saveRecent(recent), [recent]);

  const PERIODS: TabItem<Period>[] = [
    { value: "today", label: t("common.today") },
    { value: "week", label: t("common.week") },
    { value: "month", label: t("common.month") },
    { value: "custom", label: t("reports.period_custom") },
  ];

  const CARDS: ReportCard[] = [
    {
      key: "sales",
      title: t("reports.card_sales_title"),
      description: t("reports.card_sales_desc"),
      meta: t("reports.card_sales_meta"),
      icon: BarChart3,
      xlsxUrl: "/sales/export.xlsx",
    },
    {
      key: "attendance",
      title: t("reports.card_attendance_title"),
      description: t("reports.card_attendance_desc"),
      meta: t("reports.card_attendance_meta"),
      icon: Clock,
      xlsxUrl: "/attendance/report/",
      buildParams: (p) => ({ ...periodRange(p), format: "xlsx" }),
    },
    {
      key: "payroll",
      title: t("reports.card_payroll_title"),
      description: t("reports.card_payroll_desc"),
      meta: t("reports.card_payroll_meta"),
      icon: Wallet,
      xlsxUrl: "/payroll/monthly/export.xlsx",
      buildParams: () => {
        const now = new Date();
        return { year: String(now.getFullYear()), month: String(now.getMonth() + 1) };
      },
    },
    {
      key: "leads",
      title: t("reports.card_leads_title"),
      description: t("reports.card_leads_desc"),
      meta: t("reports.card_leads_meta"),
      icon: Users2,
      xlsxUrl: "/analytics/export.xlsx",
    },
    {
      // Активность операторов теперь живёт внутри страницы «Статистика
      // лидов» (/leads-stats) — там она смёржена с per-operator таблицей
      // лидов/продаж/конверсии в единый отчёт с date-range фильтром.
      key: "activity",
      title: t("reports.card_activity_title"),
      description: t("reports.card_activity_desc"),
      meta: t("reports.card_activity_meta"),
      icon: Phone,
      linkTo: "/leads-stats",
    },
    {
      key: "channels",
      title: t("reports.card_channels_title"),
      description: t("reports.card_channels_desc"),
      meta: t("reports.card_channels_meta"),
      icon: MessageSquare,
      xlsxUrl: "/marketing/export.xlsx/",
    },
  ];

  usePageHeader({ title: t("reports.title"), subtitle: t("reports.subtitle") });

  const download = async (card: ReportCard, format: "xlsx" | "pdf") => {
    if (format === "pdf") {
      toast.error("PDF пока не поддерживается — используйте Excel");
      return;
    }
    if (!card.xlsxUrl) {
      toast.error(t("reports.download_failed"));
      return;
    }
    setBusyKey(card.key);
    try {
      const params = card.buildParams ? card.buildParams(period) : periodRange(period);
      const r = await api.get(card.xlsxUrl, {
        responseType: "blob",
        params,
      });
      const blob = new Blob([r.data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const size = blob.size;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `naff-${card.key}-${stamp}.xlsx`;
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setRecent((prev) => [
        { key: card.key, filename, sizeBytes: size, when: Date.now() },
        ...prev.filter((x) => x.filename !== filename),
      ]);
      toast.success(`✓ ${card.title} · ${fmtSize(size)}`);
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: unknown } };
      const status = e.response?.status;
      if (status === 403) {
        toast.error("Нет прав на этот отчёт");
      } else if (status === 404) {
        toast.error("Отчёт не найден на сервере");
      } else {
        toast.error(t("reports.download_failed"));
      }
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Period bar */}
      <section className="flex items-center gap-3 flex-wrap animate-nfFadeUp">
        <div className="nf-col">{t("common.period")}:</div>
        <div className="flex flex-wrap gap-2">
          {PERIODS.map((p) => (
            <Chip
              key={p.value}
              active={period === p.value}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </Chip>
          ))}
        </div>
      </section>

      {/* 6 report cards */}
      <section className="grid gap-[13px] md:grid-cols-2">
        {CARDS.map((c, i) => {
          const Icon = c.icon;
          const isBusy = busyKey === c.key;
          return (
            <div
              key={c.key}
              className="nf-card p-5 flex gap-5 items-start animate-nfFadeUp"
              style={{ animationDelay: `${0.04 + i * 0.055}s` }}
            >
              <div
                className="grid place-items-center text-white shrink-0"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 14,
                  background: "var(--accent-grad)",
                  boxShadow: "0 10px 22px -10px var(--accent)",
                }}
              >
                <Icon className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className="font-semibold"
                  style={{ fontSize: 15, letterSpacing: "-0.02em" }}
                >
                  {c.title}
                </div>
                <div className="text-[13px] text-muted mt-1 leading-[1.5]">
                  {c.description}
                </div>
                <Eyebrow className="mt-3">{c.meta}</Eyebrow>
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                {c.linkTo ? (
                  <Link to={c.linkTo}>
                    <Button size="sm">
                      {t("reports.open")} <ArrowRight className="w-3 h-3" />
                    </Button>
                  </Link>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => download(c, "xlsx")}
                    disabled={isBusy || !!busyKey}
                  >
                    {isBusy ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" /> …
                      </>
                    ) : (
                      <>
                        <Download className="w-3 h-3" /> Excel
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {/* Recent exports (real, backed by localStorage) */}
      <section className="nf-card overflow-hidden animate-nfFadeUp">
        <div className="px-6 pt-5 pb-3 text-[15px] font-semibold tracking-tight flex items-center justify-between">
          <span>{t("reports.recent_title")}</span>
          {recent.length > 0 && (
            <button
              className="text-[11px] text-muted hover:text-text"
              onClick={() => setRecent([])}
            >
              Очистить
            </button>
          )}
        </div>
        {recent.length === 0 ? (
          <div className="px-6 pb-6 text-[13px] text-muted">
            Пока нет скачанных отчётов. Нажмите Excel на любой карточке выше.
          </div>
        ) : (
          <>
            <div
              className="grid gap-2 px-6 pb-3 nf-col"
              style={{ gridTemplateColumns: "2fr .6fr .8fr" }}
            >
              <div>{t("reports.col_file")}</div>
              <div className="text-right">{t("reports.col_size")}</div>
              <div>{t("reports.col_when")}</div>
            </div>
            <div>
              {recent.map((r, i) => (
                <div
                  key={i}
                  className="nf-row animate-nfFadeUp"
                  style={{
                    gridTemplateColumns: "2fr .6fr .8fr",
                    animationDelay: `${0.02 + i * 0.035}s`,
                    cursor: "default",
                  }}
                >
                  <div className="font-medium font-mono text-[12.5px] truncate">
                    {r.filename}
                  </div>
                  <div className="text-right text-muted tabular-nums">
                    {fmtSize(r.sizeBytes)}
                  </div>
                  <div className="text-muted">{fmtWhen(r.when, t)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
