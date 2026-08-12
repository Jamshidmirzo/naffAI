import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Camera } from "lucide-react";
import { api } from "../lib/api";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import { formatUZS } from "../lib/format";

type PendingSale = {
  id: number;
  imei: string;
  phone_model: string;
  operator_name: string | null;
  channel_name: string | null;
  amount: string;
  client_name: string;
  client_phone: string;
  contract_photo: string | null;
  created_at: string;
};

/**
 * Manager review queue for operator-submitted pending sales.
 * Card = photo thumbnail + IMEI + model + operator + amount.
 * Click → SaleDetail, where the approve/reject/improve panel lives.
 */
export default function SalesPending() {
  const t = useT();
  usePageHeader(
    { title: t("sales_pending.title"), subtitle: t("sales_pending.subtitle") },
    [t("sales_pending.title")],
  );

  const q = useQuery({
    queryKey: ["sales-pending"],
    queryFn: () =>
      api.get<{ results: PendingSale[]; count: number }>("/sales/pending/").then((r) => r.data),
    refetchInterval: 30_000,
  });

  const rows = q.data?.results || [];

  return (
    <div className="max-w-5xl">
      {q.isLoading && (
        <div className="text-muted py-16 text-center">{t("common.loading")}</div>
      )}
      {!q.isLoading && rows.length === 0 && (
        <div className="nf-card p-12 text-center">
          <div className="text-[16px] font-semibold mb-1">
            {t("sales_pending.empty_title")}
          </div>
          <div className="text-muted text-[13px]">
            {t("sales_pending.empty_hint")}
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((s) => (
          <Link
            key={s.id}
            to={`/sales/${s.id}`}
            className="nf-card overflow-hidden hover:border-[var(--accent)] transition"
          >
            <div className="flex gap-3">
              <div className="w-24 h-24 flex-shrink-0 bg-[var(--surface2)] flex items-center justify-center">
                {s.contract_photo ? (
                  <img
                    src={s.contract_photo}
                    alt="contract"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Camera className="w-6 h-6 text-muted" />
                )}
              </div>
              <div className="flex-1 min-w-0 p-3 pr-4">
                <div className="flex justify-between items-baseline gap-2">
                  <div className="text-[14px] font-semibold truncate">
                    {s.phone_model}
                  </div>
                  <div className="text-[14px] font-semibold tabular-nums flex-shrink-0">
                    {formatUZS(Number(s.amount))}
                  </div>
                </div>
                <div className="text-[11.5px] text-muted mt-1 font-mono truncate">
                  IMEI: {s.imei}
                </div>
                <div className="text-[12px] text-muted mt-1.5 truncate">
                  {s.operator_name || "—"} · {s.channel_name || "—"}
                </div>
                {(s.client_name || s.client_phone) && (
                  <div className="text-[11.5px] text-muted mt-0.5 truncate">
                    {s.client_name} {s.client_phone}
                  </div>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
