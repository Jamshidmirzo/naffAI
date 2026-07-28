import { useState } from "react";
import {
  BarChart3,
  Clock,
  Download,
  FileText,
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

interface ReportCard {
  key: string;
  title: string;
  description: string;
  meta: string;
  icon: React.ComponentType<{ className?: string }>;
  xlsxUrl?: string;
}

interface RecentExport {
  id: number;
  file: string;
  size: string;
  when: string;
}

export default function Reports() {
  const [period, setPeriod] = useState<Period>("today");
  const t = useT();

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
    },
    {
      key: "payroll",
      title: t("reports.card_payroll_title"),
      description: t("reports.card_payroll_desc"),
      meta: t("reports.card_payroll_meta"),
      icon: Wallet,
    },
    {
      key: "leads",
      title: t("reports.card_leads_title"),
      description: t("reports.card_leads_desc"),
      meta: t("reports.card_leads_meta"),
      icon: Users2,
    },
    {
      key: "calls",
      title: t("reports.card_calls_title"),
      description: t("reports.card_calls_desc"),
      meta: t("reports.card_calls_meta"),
      icon: Phone,
    },
    {
      key: "channels",
      title: t("reports.card_channels_title"),
      description: t("reports.card_channels_desc"),
      meta: t("reports.card_channels_meta"),
      icon: MessageSquare,
    },
  ];

  const RECENT: RecentExport[] = [
    { id: 1, file: "naffcrm-savdo-2025-07-27.xlsx", size: `82 ${t("reports.unit_kb")}`, when: t("reports.when_today_time") },
    { id: 2, file: "attendance-2025-07.xlsx", size: `24 ${t("reports.unit_kb")}`, when: t("reports.when_yesterday") },
    { id: 3, file: "payroll-2025-07.xlsx", size: `18 ${t("reports.unit_kb")}`, when: t("reports.when_days_ago", { n: 3 }) },
  ];

  usePageHeader({ title: t("reports.title"), subtitle: t("reports.subtitle") });

  const download = async (card: ReportCard, format: "xlsx" | "pdf") => {
    if (format === "xlsx" && card.xlsxUrl) {
      try {
        const r = await api.get(card.xlsxUrl, { responseType: "blob" });
        const blob = new Blob([r.data], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${card.key}-${new Date().toISOString().slice(0, 10)}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        toast.success(t("reports.downloaded"));
      } catch {
        toast.error(t("reports.download_failed"));
      }
      return;
    }
    toast.success(t("reports.preparing", { name: card.title }));
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
                <Button size="sm" onClick={() => download(c, "xlsx")}>
                  <Download className="w-3 h-3" /> Excel
                </Button>
                <Button size="sm" variant="ghost" onClick={() => download(c, "pdf")}>
                  <FileText className="w-3 h-3" /> PDF
                </Button>
              </div>
            </div>
          );
        })}
      </section>

      {/* Recent exports */}
      <section className="nf-card overflow-hidden animate-nfFadeUp">
        <div className="px-6 pt-5 pb-3 text-[15px] font-semibold tracking-tight">
          {t("reports.recent_title")}
        </div>
        <div
          className="grid gap-2 px-6 pb-3 nf-col"
          style={{ gridTemplateColumns: "2fr .6fr .8fr .8fr" }}
        >
          <div>{t("reports.col_file")}</div>
          <div className="text-right">{t("reports.col_size")}</div>
          <div>{t("reports.col_when")}</div>
          <div className="text-right"></div>
        </div>
        <div>
          {RECENT.map((r, i) => (
            <div
              key={r.id}
              className="nf-row animate-nfFadeUp"
              style={{
                gridTemplateColumns: "2fr .6fr .8fr .8fr",
                animationDelay: `${0.02 + i * 0.035}s`,
                cursor: "default",
              }}
            >
              <div className="font-medium font-mono text-[12.5px] truncate">
                {r.file}
              </div>
              <div className="text-right text-muted tabular-nums">{r.size}</div>
              <div className="text-muted">{r.when}</div>
              <div className="text-right">
                <button
                  className="nf-btn nf-btn--ghost"
                  style={{ padding: "7px 12px", fontSize: 12.5 }}
                  onClick={() => toast.success(t("reports.downloaded"))}
                >
                  <Download className="w-3 h-3" /> {t("reports.download")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
