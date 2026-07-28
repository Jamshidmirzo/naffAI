import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { Button, Eyebrow, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface SourceStat {
  sheet_source_id: number;
  source_name: string;
  leads: number;
  converted: number;
  conversion_rate: number;
}

interface Insight {
  id: number;
  period_start: string;
  period_end: string;
  lead_quality_by_source: Record<string, SourceStat>;
  targeting_recommendations: string[];
  top_products: { product: string; mentions: number }[];
  summary: string;
  model_version: string;
  provider_used?: string;
  created_at: string;
}

function providerLabel(insight: Insight): string {
  const provider = insight.provider_used;
  const model = insight.model_version;
  if (!provider || provider === "fallback" || provider === "exhausted" || provider === "unknown") {
    return model || provider || "";
  }
  return model ? `${provider} · ${model}` : provider;
}

export default function Marketing() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  usePageHeader({ title: t("marketing.title"), subtitle: t("marketing.subtitle") });

  const listQ = useQuery<Insight[]>({
    queryKey: ["marketing", "insights"],
    queryFn: async () => {
      const r = await api.get("/marketing/insights/");
      const data = r.data as Insight[] | { results: Insight[] };
      return Array.isArray(data) ? data : data.results;
    },
  });

  const insights = listQ.data ?? [];
  const latest = insights[0];

  const generateMut = useMutation({
    mutationFn: () => api.post<Insight>("/marketing/insights/generate/", { days: 7 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketing", "insights"] });
      setError(null);
      toast.success(t("marketing.generated"));
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const sourceBars = latest
    ? Object.values(latest.lead_quality_by_source).sort((a, b) => b.leads - a.leads)
    : [];

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3 animate-nfFadeUp">
        <div className="text-[13px] text-muted">
          {insights.length > 0 ? t("marketing.total", { n: insights.length }) : t("marketing.none_yet")}
        </div>
        <Button onClick={() => generateMut.mutate()} disabled={generateMut.isPending}>
          <RefreshCcw className="w-3.5 h-3.5" />
          {generateMut.isPending ? t("marketing.calculating") : t("marketing.generate_7d")}
        </Button>
      </div>

      {error && (
        <div
          className="text-[13px] rounded-xl px-3.5 py-2.5"
          style={{
            background: "rgba(220,60,40,.08)",
            color: "var(--danger)",
            border: "1px solid rgba(220,60,40,.2)",
          }}
        >
          {error}
        </div>
      )}

      {!latest && !listQ.isLoading && (
        <div
          className="nf-card p-8 text-center text-[13.5px] text-muted animate-nfFadeUp"
        >
          {t("marketing.empty_hint")}
        </div>
      )}

      {latest && (
        <>
          <section className="grid gap-[13px] lg:grid-cols-[2fr,1fr]">
            <div
              className="nf-card p-6 animate-nfFadeUp"
              style={{ animationDelay: "0.05s" }}
            >
              <Eyebrow>{t("marketing.conversion_by_source")}</Eyebrow>
              <div className="mt-1 text-[15px] font-semibold tracking-tight">
                {latest.period_start} — {latest.period_end}
              </div>
              <div className="text-[12.5px] text-muted mb-4">
                {t("marketing.leads_and_conv")}
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={sourceBars}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--faint)" />
                  <XAxis dataKey="source_name" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="l" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar yAxisId="l" dataKey="leads" fill="rgba(0,0,0,.25)" name={t("nav.leads")} />
                  <Bar yAxisId="l" dataKey="converted" fill="#ff9d47" name={t("nav.sales")} />
                  <Bar yAxisId="r" dataKey="conversion_rate" fill="#f2560b" name={t("marketing.conversion_pct")} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div
              className="nf-card p-6 animate-nfFadeUp"
              style={{ animationDelay: "0.1s" }}
            >
              <div className="text-[15px] font-semibold tracking-tight mb-3">
                {t("marketing.top_products")}
              </div>
              <ul className="flex flex-col gap-2 text-[13.5px]">
                {latest.top_products.slice(0, 10).map((p) => (
                  <li
                    key={p.product}
                    className="flex justify-between py-2"
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <span className="truncate">{p.product}</span>
                    <span className="text-muted ml-2 tabular-nums">{p.mentions}</span>
                  </li>
                ))}
                {latest.top_products.length === 0 && (
                  <li className="text-muted py-4 text-center">{t("common.no_data")}</li>
                )}
              </ul>
            </div>
          </section>

          <section
            className="nf-card p-6 animate-nfFadeUp"
            style={{ animationDelay: "0.15s" }}
          >
            <Eyebrow>{t("marketing.ai_recommendations")}</Eyebrow>
            <div className="text-[14px] text-muted italic mt-3 mb-4">
              {latest.summary}
            </div>
            <ul className="flex flex-col gap-2.5 text-[14px]">
              {latest.targeting_recommendations.map((r, i) => (
                <li key={i} className="flex gap-3">
                  <span
                    className="mt-2 shrink-0 w-1.5 h-1.5 rounded-full"
                    style={{ background: "var(--accent)" }}
                  />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
            <div className="text-[11px] text-muted mt-4 uppercase tracking-wide">
              {providerLabel(latest)}
            </div>
          </section>
        </>
      )}

      {insights.length > 1 && (
        <section className="nf-card overflow-hidden">
          <div className="px-6 pt-5 pb-3 text-[15px] font-semibold tracking-tight">
            {t("marketing.history_title")}
          </div>
          <div
            className="grid gap-2 px-6 pb-3 nf-col"
            style={{ gridTemplateColumns: ".8fr 2fr .6fr" }}
          >
            <div>{t("common.period")}</div>
            <div>{t("marketing.col_summary")}</div>
            <div className="text-right">{t("common.model")}</div>
          </div>
          <div>
            {insights.slice(1).map((i, idx) => (
              <div
                key={i.id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: ".8fr 2fr .6fr",
                  animationDelay: `${0.02 + idx * 0.035}s`,
                  cursor: "default",
                }}
              >
                <div className="text-muted tabular-nums whitespace-nowrap">
                  {i.period_start} — {i.period_end}
                </div>
                <div className="text-muted truncate">{i.summary}</div>
                <div className="text-right text-[11px] uppercase text-muted tracking-wide">
                  {providerLabel(i)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
