import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { Button, Chip, StatusBadge, toast } from "../components/ui";
import { Paginator } from "../components/Paginator";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface SystemLostLead {
  id: number;
  full_name: string;
  phone: string;
  phone_raw: string;
  status: string;
  sheet_source_name: string | null;
  sheet_row_index: number | null;
  product_hint: string;
  lost_reason: string;
  lost_comment: string;
  lost_original_operator_name: string;
  lost_original_status: string;
  lost_at: string;
  lost_by: string;
  created_at: string;
  updated_at: string;
}

interface Summary {
  total: number;
  by_reason: Record<string, number>;
  top_original_operators: { name: string; count: number }[];
}

interface Response {
  results: SystemLostLead[];
  count: number;
  next: string | null;
  previous: string | null;
  summary: Summary;
  known_reasons: string[];
}

const PAGE_SIZE = 50;

function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

/**
 * /leads/system-lost — superadmin-only страница «системно потерянных» лидов.
 *
 * Показывает то, что раньше было в /leads/orphans под чипами «Требуют
 * пересмотра» и «Зависли на уволенных» — теперь эти пулы автоматически
 * закрываются в статус `lost` с сохранением причины в metadata.
 *
 * Функции:
 *   - Фильтры: reason, days.
 *   - Сводка сверху (total + by_reason + top-5 original operators).
 *   - Кнопка «Восстановить» на каждой строке → POST recover-endpoint.
 */
export default function SystemLostLeads() {
  const t = useT();
  usePageHeader(
    { title: t("system_lost.title"), subtitle: t("system_lost.subtitle") },
    ["system-lost-leads"],
  );

  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const reason = searchParams.get("reason") || "";
  const days = searchParams.get("days") || "";
  const page = Number(searchParams.get("page")) || 1;

  const setFilter = (key: string, value: string | number | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === "") next.delete(key);
    else next.set(key, String(value));
    if (key !== "page") next.delete("page");
    setSearchParams(next);
  };

  const listQ = useQuery({
    queryKey: ["system-lost-leads", reason, days, page],
    queryFn: async (): Promise<Response> => {
      const qp = new URLSearchParams();
      if (reason) qp.set("reason", reason);
      if (days) qp.set("days", days);
      qp.set("limit", String(PAGE_SIZE));
      qp.set("offset", String((page - 1) * PAGE_SIZE));
      const { data } = await api.get<Response>(
        `/leads/system-lost/?${qp.toString()}`,
      );
      return data;
    },
    refetchInterval: 120_000,
  });

  const recoverMut = useMutation({
    mutationFn: (id: number) =>
      api.post<SystemLostLead>(`/leads/${id}/recover-from-system-lost/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["system-lost-leads"] });
      qc.invalidateQueries({ queryKey: ["orphan-leads"] });
      qc.invalidateQueries({ queryKey: ["orphan-leads-count"] });
      toast.success(t("system_lost.toast.recovered"));
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const onRecover = (id: number) => {
    if (!window.confirm(t("system_lost.confirm.recover"))) return;
    recoverMut.mutate(id);
  };

  const summary = listQ.data?.summary || {
    total: 0,
    by_reason: {},
    top_original_operators: [],
  };
  const knownReasons = listQ.data?.known_reasons || [];
  const rows = listQ.data?.results || [];
  const totalCount = listQ.data?.count || 0;

  const reasonLabel = (code: string) => {
    const key = `system_lost.reason.${code}`;
    const translated = t(key);
    // Если ключа нет — вернётся код обратно.
    return translated === key ? code : translated;
  };

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Сводка */}
      <section className="nf-card p-5 animate-nfFadeUp">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
          <div>
            <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">
              {t("system_lost.summary.total")}
            </div>
            <div className="text-[26px] font-semibold tabular-nums mt-0.5">
              {summary.total}
            </div>
          </div>
          {Object.entries(summary.by_reason).length > 0 && (
            <div className="min-w-[240px]">
              <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">
                {t("system_lost.summary.by_reason")}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                {Object.entries(summary.by_reason).map(([code, n]) => (
                  <span key={code} className="text-muted">
                    {reasonLabel(code)}{" "}
                    <span className="text-text tabular-nums font-medium">{n}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {summary.top_original_operators.length > 0 && (
            <div className="flex-1 min-w-[220px]">
              <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">
                {t("system_lost.summary.top_operators")}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                {summary.top_original_operators.map((row) => (
                  <span key={row.name} className="text-muted">
                    {row.name}{" "}
                    <span className="text-text tabular-nums font-medium">
                      {row.count}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Фильтры */}
      <section className="flex flex-wrap gap-2 items-center animate-nfFadeUp">
        <Chip
          active={reason === ""}
          onClick={() => setFilter("reason", null)}
        >
          {t("system_lost.filter.all_reasons")}
        </Chip>
        {knownReasons.map((code) => (
          <Chip
            key={code}
            active={reason === code}
            onClick={() => setFilter("reason", code)}
          >
            {reasonLabel(code)}
          </Chip>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <input
            className="nf-input"
            style={{ padding: "6px 10px", width: 140, fontSize: 12.5 }}
            type="number"
            min="1"
            max="365"
            placeholder={t("system_lost.filter.days_placeholder")}
            value={days}
            onChange={(e) => setFilter("days", e.target.value || null)}
          />
        </div>
      </section>

      {/* Таблица */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col items-center"
          style={{
            gridTemplateColumns: "1.3fr .9fr .7fr 1fr .8fr 1.4fr .9fr",
          }}
        >
          <div>{t("system_lost.table.col.lead")}</div>
          <div>{t("system_lost.table.col.original_operator")}</div>
          <div>{t("system_lost.table.col.status_before")}</div>
          <div>{t("system_lost.table.col.reason")}</div>
          <div className="text-right">{t("system_lost.table.col.lost_at")}</div>
          <div>{t("system_lost.table.col.comment")}</div>
          <div className="text-right">{t("system_lost.table.col.action")}</div>
        </div>

        {listQ.isLoading ? (
          <div className="text-center text-muted py-16 text-[13px]">
            {t("system_lost.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-16 text-[13px]">
            {t("system_lost.empty")}
          </div>
        ) : (
          <div>
            {rows.map((lead, i) => (
              <div
                key={lead.id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns:
                    "1.3fr .9fr .7fr 1fr .8fr 1.4fr .9fr",
                  animationDelay: `${0.02 + i * 0.03}s`,
                }}
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">
                    {lead.full_name || <span className="text-muted">—</span>}
                  </div>
                  <div className="text-[12px] text-muted truncate">
                    {lead.phone ||
                      lead.phone_raw ||
                      t("orphans.table.no_phone")}
                  </div>
                </div>
                <div className="truncate text-[13px]">
                  {lead.lost_original_operator_name || (
                    <span className="text-muted">—</span>
                  )}
                </div>
                <div>
                  <StatusBadge tone="neutral">
                    {lead.lost_original_status || "—"}
                  </StatusBadge>
                </div>
                <div className="text-[12.5px]">
                  {reasonLabel(lead.lost_reason)}
                </div>
                <div className="text-right text-muted tabular-nums text-[12.5px]">
                  {fmtDateTime(lead.lost_at)}
                </div>
                <div
                  className="text-[12px] text-muted truncate"
                  title={lead.lost_comment}
                >
                  {lead.lost_comment || "—"}
                </div>
                <div className="text-right">
                  <Button
                    variant="ghost"
                    onClick={() => onRecover(lead.id)}
                    disabled={recoverMut.isPending}
                  >
                    {recoverMut.isPending
                      ? t("system_lost.action.recovering")
                      : t("system_lost.action.recover")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="flex justify-center">
        <Paginator
          page={page}
          total={totalCount}
          pageSize={PAGE_SIZE}
          onChange={(p) => setFilter("page", p > 1 ? p : null)}
        />
      </div>
    </div>
  );
}

