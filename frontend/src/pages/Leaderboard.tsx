import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatUZS, formatNumber } from "../lib/format";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import { TabPill, type TabItem } from "../components/ui";

const REFRESH_SEC = 60;

type Period = "day" | "week" | "month" | "all";

interface Row {
  operator_id: number;
  operator_name: string;
  is_trainee: boolean;
  total: number | string;
  count: number | string;
  avg_ticket: number | string;
}

interface Me {
  operator_id: number | null;
  operator_name: string | null;
  display_name: string | null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

/**
 * Compact money label for podium — keeps big cards readable on mobile too.
 * The full precise sum lives in the tail table where `formatUZS` is fine.
 */
function millions(n: number, lang: "ru" | "uz" = "ru"): string {
  const suffix_m = lang === "uz" ? " mln" : " млн";
  const suffix_k = lang === "uz" ? " ming" : " тыс";
  if (Math.abs(n) >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}${suffix_m}`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)}${suffix_k}`;
  return Math.round(n).toString();
}

interface PodiumCardProps {
  rank: number;
  row: Row;
  isMe: boolean;
  t: (k: string) => string;
}

/**
 * Podium card for top-5. #1 gets an "elevated" treatment (gold gradient,
 * larger typography). #2/#3 are silver/bronze. #4/#5 are neutral cards.
 * The whole 5-card group uses a responsive grid — on desktop we get the
 * "podium feel" via row-span; on mobile it flattens to a single column.
 */
function PodiumCard({ rank, row, isMe, t }: PodiumCardProps) {
  const total = Number(row.total) || 0;
  const count = Number(row.count) || 0;

  const isGold = rank === 1;
  const isSilver = rank === 2;
  const isBronze = rank === 3;

  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;

  const bgStyle = isGold
    ? {
        background:
          "linear-gradient(155deg, #FFF4EC 0%, #FFDDBE 55%, #FFB57A 100%)",
        border: "1px solid #F5B978",
        boxShadow: "0 20px 42px -18px rgba(228,87,27,.35)",
      }
    : isSilver
      ? {
          background:
            "linear-gradient(155deg, #F6F5F2 0%, #E1DED7 60%, #C9C4B8 100%)",
          border: "1px solid #C9C4B8",
        }
      : isBronze
        ? {
            background:
              "linear-gradient(155deg, #FBEEE2 0%, #E9C7A2 60%, #C29469 100%)",
            border: "1px solid #C29469",
          }
        : {
            background: "var(--bg-card, #fff)",
            border: "1px solid var(--border-main, rgba(0,0,0,.08))",
          };

  const nameColor = isGold ? "#5a2a04" : isSilver ? "#2b2723" : isBronze ? "#4a2408" : "var(--text-primary)";
  const amountColor = isGold ? "#a2531d" : isSilver ? "#2b2723" : isBronze ? "#5a2a04" : "var(--text-primary)";
  const mutedColor = isGold ? "rgba(90,42,4,.65)" : isSilver ? "rgba(43,39,35,.6)" : isBronze ? "rgba(74,36,8,.7)" : "var(--text-muted)";

  return (
    <div
      className="relative flex flex-col animate-nfFadeUp"
      style={{
        ...bgStyle,
        borderRadius: 22,
        padding: isGold ? "26px 24px 22px" : "22px 20px 18px",
        minHeight: isGold ? 220 : 180,
        animationDelay: `${rank * 0.06}s`,
      }}
    >
      {isMe && (
        <span
          className="absolute top-3 right-3 text-[10.5px] font-semibold px-2 py-0.5 rounded-full"
          style={{
            background: "var(--accent)",
            color: "#fff",
            letterSpacing: ".02em",
          }}
        >
          {t("leaderboard.you_badge")}
        </span>
      )}

      {/* rank medal */}
      <div className="flex items-center gap-2">
        <div
          className="grid place-items-center font-bold tabular-nums shrink-0"
          style={{
            width: isGold ? 46 : 40,
            height: isGold ? 46 : 40,
            borderRadius: 14,
            fontSize: rank <= 3 ? (isGold ? 26 : 22) : 16,
            background: rank <= 3 ? "rgba(255,255,255,.55)" : "var(--bg-nested, rgba(0,0,0,.04))",
            color: nameColor,
          }}
        >
          {medal}
        </div>
        <div
          className="grid place-items-center font-semibold shrink-0"
          style={{
            width: isGold ? 46 : 40,
            height: isGold ? 46 : 40,
            borderRadius: "50%",
            background: "rgba(0,0,0,.06)",
            color: nameColor,
            fontSize: isGold ? 15 : 13,
            letterSpacing: ".02em",
          }}
        >
          {initials(row.operator_name)}
        </div>
      </div>

      {/* name */}
      <div
        className="mt-3 font-semibold leading-tight break-words"
        style={{
          color: nameColor,
          fontSize: isGold ? 22 : 18,
          letterSpacing: "-0.01em",
        }}
      >
        {row.operator_name}
      </div>
      {row.is_trainee && (
        <div className="text-[11px] mt-0.5" style={{ color: mutedColor }}>
          {t("leaderboard.trainee")}
        </div>
      )}

      <div className="flex-1" />

      {/* amount */}
      <div
        className="mt-3 font-bold tabular-nums leading-none"
        style={{
          color: amountColor,
          fontSize: isGold ? 34 : 26,
          letterSpacing: "-0.03em",
        }}
      >
        {millions(total)}
      </div>
      <div className="text-[12px] mt-1.5 tabular-nums" style={{ color: mutedColor }}>
        {formatUZS(total)}
      </div>
      <div
        className="text-[12px] mt-1 flex items-center gap-1.5 tabular-nums"
        style={{ color: mutedColor }}
      >
        <span>{formatNumber(count)}</span>
        <span>·</span>
        <span>{t("leaderboard.sales_short")}</span>
      </div>
    </div>
  );
}

interface TailRowProps {
  rank: number;
  row: Row;
  isMe: boolean;
  t: (k: string) => string;
}

function TailRow({ rank, row, isMe, t }: TailRowProps) {
  const total = Number(row.total) || 0;
  const count = Number(row.count) || 0;
  return (
    <div
      className="grid items-center transition-colors"
      style={{
        gridTemplateColumns: "56px 44px 1fr auto",
        gap: 14,
        padding: "14px 18px",
        borderTop: "1px solid var(--border-row, rgba(0,0,0,.05))",
        background: isMe ? "var(--accent-pale-bg, #FFF4EC)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!isMe) e.currentTarget.style.background = "var(--bg-nested, rgba(0,0,0,.03))";
      }}
      onMouseLeave={(e) => {
        if (!isMe) e.currentTarget.style.background = "transparent";
      }}
    >
      <div
        className="tabular-nums font-semibold"
        style={{ color: "var(--text-muted)", fontSize: 15 }}
      >
        #{rank}
      </div>
      <div
        className="grid place-items-center font-semibold shrink-0"
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "var(--bg-nested, rgba(0,0,0,.05))",
          color: "var(--text-secondary)",
          fontSize: 12,
        }}
      >
        {initials(row.operator_name)}
      </div>
      <div className="min-w-0">
        <div
          className="font-medium truncate"
          style={{ fontSize: 15, color: "var(--text-primary)" }}
        >
          {row.operator_name}
          {isMe && (
            <span
              className="ml-2 align-middle text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full"
              style={{ background: "var(--accent)", color: "#fff" }}
            >
              {t("leaderboard.you_badge")}
            </span>
          )}
        </div>
        <div className="text-[12px] tabular-nums" style={{ color: "var(--text-muted)" }}>
          {formatNumber(count)} · {t("leaderboard.sales_short")}
          {row.is_trainee && ` · ${t("leaderboard.trainee")}`}
        </div>
      </div>
      <div
        className="tabular-nums text-right"
        style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}
      >
        {formatUZS(total)}
      </div>
    </div>
  );
}

export default function Leaderboard() {
  const t = useT();
  const [period, setPeriod] = useState<Period>("month");
  const [tick, setTick] = useState(0);

  usePageHeader(
    { title: t("leaderboard.title"), subtitle: t("leaderboard.subtitle") },
    [t("leaderboard.title"), t("leaderboard.subtitle")],
  );

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), REFRESH_SEC * 1000);
    return () => clearInterval(id);
  }, []);

  // Whose row to highlight — falls back to null (manager sees no highlight).
  const me = useQuery<Me>({
    queryKey: ["auth-me-lb"],
    queryFn: () => api.get<Me>("/auth/me/").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const myOperatorId = me.data?.operator_id ?? null;

  const params = useMemo(() => {
    if (period === "all") return { limit: 0 };
    return { period, limit: 0 };
  }, [period]);

  const lb = useQuery<Row[]>({
    queryKey: ["leaderboard", period, tick],
    queryFn: () =>
      api.get<Row[]>("/analytics/leaderboard/", { params }).then((r) => r.data),
    staleTime: 0,
  });

  const rows = lb.data ?? [];
  const top = rows.slice(0, 5);
  const tail = rows.slice(5);

  const totalSum = rows.reduce((a, r) => a + (Number(r.total) || 0), 0);
  const totalCount = rows.reduce((a, r) => a + (Number(r.count) || 0), 0);

  const tabs: TabItem<Period>[] = [
    { value: "day", label: t("leaderboard.period_today") },
    { value: "week", label: t("leaderboard.period_week") },
    { value: "month", label: t("leaderboard.period_month") },
    { value: "all", label: t("leaderboard.period_all") },
  ];

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Controls + totals */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabPill items={tabs} value={period} onChange={setPeriod} />
        <div className="flex items-center gap-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
          <span>
            {t("leaderboard.total_operators")}:{" "}
            <span className="tabular-nums font-semibold" style={{ color: "var(--text-primary)" }}>
              {rows.length}
            </span>
          </span>
          <span>
            {t("leaderboard.total_sales")}:{" "}
            <span className="tabular-nums font-semibold" style={{ color: "var(--text-primary)" }}>
              {formatNumber(totalCount)}
            </span>
          </span>
          <span>
            {t("leaderboard.total_amount")}:{" "}
            <span className="tabular-nums font-semibold" style={{ color: "var(--text-primary)" }}>
              {formatUZS(totalSum)}
            </span>
          </span>
        </div>
      </div>

      {/* Empty state */}
      {!lb.isLoading && rows.length === 0 && (
        <div
          className="text-center py-24"
          style={{
            color: "var(--text-muted)",
            border: "1px dashed var(--border-main, rgba(0,0,0,.1))",
            borderRadius: 20,
            background: "var(--bg-surface, #fbfaf8)",
          }}
        >
          <div className="text-[18px] font-medium" style={{ color: "var(--text-secondary)" }}>
            {t("leaderboard.empty_title")}
          </div>
          <div className="text-[13px] mt-1">{t("leaderboard.empty_subtitle")}</div>
        </div>
      )}

      {/* Podium: top-5 */}
      {top.length > 0 && (
        <section>
          <div
            className="text-[11px] uppercase font-semibold mb-3 tracking-[.1em]"
            style={{ color: "var(--text-label)" }}
          >
            {t("leaderboard.top_title")}
          </div>
          {/*
            Grid layout:
             - mobile (1 col): #1 → #2 → #3 → #4 → #5 stacked
             - sm (2 cols): 2x2 + tail card
             - lg (5 cols): true podium row
          */}
          <div
            className="grid gap-3"
            style={{
              gridTemplateColumns: "repeat(1, minmax(0,1fr))",
            }}
          >
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
              {top.map((row, i) => (
                <PodiumCard
                  key={row.operator_id}
                  rank={i + 1}
                  row={row}
                  isMe={row.operator_id === myOperatorId}
                  t={t}
                />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Tail: rest of operators */}
      {tail.length > 0 && (
        <section>
          <div
            className="text-[11px] uppercase font-semibold mb-2 tracking-[.1em]"
            style={{ color: "var(--text-label)" }}
          >
            {t("leaderboard.rest_title")}
          </div>
          <div
            style={{
              background: "var(--bg-card, #fff)",
              border: "1px solid var(--border-main, rgba(0,0,0,.08))",
              borderRadius: 18,
              overflow: "hidden",
            }}
          >
            {/* header row */}
            <div
              className="grid items-center"
              style={{
                gridTemplateColumns: "56px 44px 1fr auto",
                gap: 14,
                padding: "10px 18px",
                background: "var(--bg-nested, #f6f4f0)",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: ".08em",
                color: "var(--text-label)",
                fontWeight: 600,
              }}
            >
              <div>#</div>
              <div />
              <div>{t("leaderboard.col_name")}</div>
              <div className="text-right">{t("leaderboard.col_amount")}</div>
            </div>
            {tail.map((row, i) => (
              <TailRow
                key={row.operator_id}
                rank={i + 6}
                row={row}
                isMe={row.operator_id === myOperatorId}
                t={t}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
