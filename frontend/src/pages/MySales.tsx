import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ShoppingBag } from "lucide-react";
import { api } from "../lib/api";
import { usePageHeader } from "../store/page";

/**
 * Operator's own sales page (`/my/sales`).
 *
 * Fetches `/api/sales/mine/` which returns SaleOperator-scoped rows —
 * split-aware, so shared sales still show up with the operator's
 * personal share_amount alongside the sale total.
 *
 * No filters yet — keep it simple (chronological, last 100). Manager
 * still owns the full /sales table with search + filter panel.
 */

interface Row {
  id: number;
  imei: string;
  phone_model: string;
  client_name: string;
  client_phone: string;
  amount_total: string;
  share_amount: string;
  channel_name: string;
  status: string;
  sold_at: string;
}

export default function MySales() {
  usePageHeader({
    title: "Mening sotuvlarim",
    subtitle: "Sotildi bo'lgan barcha lidlarim",
  });

  const q = useQuery<{ results: Row[]; count: number; total_share: string }>({
    queryKey: ["my-sales"],
    queryFn: () => api.get("/sales/mine/").then((r) => r.data),
  });

  const rows = q.data?.results ?? [];
  const total = q.data?.count ?? 0;
  const share = Number(q.data?.total_share ?? 0);
  const fmt = new Intl.NumberFormat("ru-RU");

  return (
    <div className="mx-auto max-w-[820px] flex flex-col gap-5">
      {/* Header summary */}
      <section className="nf-card p-5 flex items-center gap-5">
        <div
          className="grid place-items-center shrink-0"
          style={{
            width: 52,
            height: 52,
            borderRadius: 14,
            background: "var(--accent-grad)",
            color: "#fff",
          }}
        >
          <ShoppingBag className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-muted">Jami sotuvlar</div>
          <div className="text-[26px] font-semibold tabular-nums">
            {total}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[13px] text-muted">Mening ulushim</div>
          <div className="text-[22px] font-semibold tabular-nums">
            {fmt.format(share)} <span className="text-[13px] text-muted">so'm</span>
          </div>
        </div>
      </section>

      {/* Sales list */}
      <section className="nf-card overflow-hidden">
        <div className="px-6 pt-5 pb-3 text-[14px] font-semibold tracking-tight">
          Ro'yxat
        </div>

        {q.isLoading ? (
          <div className="text-center text-muted py-8 text-[13px]">
            Yuklanmoqda…
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-10 text-[13px]">
            Hozircha sotuvlar yo'q. Yangi sotuv qo'shganingizdan keyin bu yerda ko'rinadi.
          </div>
        ) : (
          <div>
            <div
              className="grid gap-3 px-6 pb-3 text-[11px] uppercase tracking-wide text-muted"
              style={{ gridTemplateColumns: "70px 1.4fr 1fr 1.1fr" }}
            >
              <div>Sana</div>
              <div>Model / Mijoz</div>
              <div>Kanal</div>
              <div className="text-right">Summa</div>
            </div>
            {rows.map((s) => {
              const d = new Date(s.sold_at);
              const dateStr = d.toLocaleDateString("ru-RU", {
                day: "2-digit",
                month: "short",
              });
              const timeStr = d.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              });
              const shareAmt = fmt.format(Number(s.share_amount) || 0);
              const totalAmt = fmt.format(Number(s.amount_total) || 0);
              const shared = shareAmt !== totalAmt;
              return (
                <Link
                  to={`/sales/${s.id}`}
                  key={s.id}
                  className="grid gap-3 px-6 py-3 items-center hover:bg-[var(--faint)] transition"
                  style={{
                    gridTemplateColumns: "70px 1.4fr 1fr 1.1fr",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <div className="text-[12px] tabular-nums">
                    <div>{dateStr}</div>
                    <div className="text-muted text-[11px]">{timeStr}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium truncate">
                      {s.phone_model || "—"}
                    </div>
                    <div className="text-[12px] text-muted truncate">
                      {s.client_name || "—"}
                      {s.client_phone && (
                        <>
                          {" · "}
                          <span className="tabular-nums">{s.client_phone}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-[13px] text-muted truncate">
                    {s.channel_name || "—"}
                  </div>
                  <div className="text-right">
                    <div className="text-[14.5px] font-semibold tabular-nums">
                      {shareAmt} so'm
                    </div>
                    {shared && (
                      <div className="text-[11px] text-muted">
                        jami: {totalAmt}
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
