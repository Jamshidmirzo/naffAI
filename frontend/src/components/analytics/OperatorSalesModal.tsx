import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ExternalLink, X } from "lucide-react";
import { api } from "../../lib/api";
import { formatDate, formatUZS } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Modal } from "../ui";

const LIMIT = 200;

interface PartnerLine {
  partner: number;
  partner_name: string;
  amount: string;
}
interface OperatorLine {
  operator: number | null;
  amount: string;
}
interface SaleRow {
  id: number;
  imei: string;
  phone_model: string;
  sold_at: string;
  channel_name: string;
  total_price: string;
  amount: string;
  client_name: string;
  client_phone: string;
  partner_lines: PartnerLine[];
  operator_lines: OperatorLine[];
  contract_photo: string | null;
  contract_photos_all?: { id: number; url: string | null }[];
}

export interface SalesWindow {
  date_from?: string;
  date_to?: string;
}

interface Props {
  operator: { id: number; name: string } | null;
  window: SalesWindow;
  partnerIds: number[];
  periodLabel: string;
  onClose: () => void;
}

function photosOf(s: SaleRow): string[] {
  const list = (s.contract_photos_all ?? []).map((p) => p.url).filter(Boolean) as string[];
  if (list.length > 0) return list;
  return s.contract_photo ? [s.contract_photo] : [];
}

/**
 * «Bonu ustiga bossa» — every confirmed sale of one operator for the
 * window the Top-operators card is showing: phone, hamkor (payment
 * partners), client, amount and the contract photos.
 */
export default function OperatorSalesModal({
  operator,
  window,
  partnerIds,
  periodLabel,
  onClose,
}: Props) {
  const t = useT();
  const [preview, setPreview] = useState<string | null>(null);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (!operator) return p;
    p.set("operator_ids", String(operator.id));
    p.set("status", "confirmed");
    p.set("is_returned", "false");
    p.set("limit", String(LIMIT));
    if (window.date_from) p.set("date_from", window.date_from);
    if (window.date_to) p.set("date_to", window.date_to);
    for (const id of partnerIds) p.append("partner_ids", String(id));
    return p;
  }, [operator, window.date_from, window.date_to, partnerIds]);

  const q = useQuery<{ count: number; results: SaleRow[] }>({
    queryKey: ["operator-sales-modal", params.toString()],
    queryFn: () => api.get("/sales/", { params }).then((r) => r.data),
    enabled: !!operator,
  });

  const rows = q.data?.results ?? [];
  const total = rows.reduce((a, s) => a + (Number(s.total_price ?? s.amount) || 0), 0);
  const cols = "92px 1.3fr 1fr 1.25fr .95fr 112px";

  if (!operator) return null;
  // Portal: the card above is animated (transform), which would trap a
  // position:fixed overlay inside the card instead of the viewport.
  return createPortal(
    <Modal open={!!operator} onClose={preview ? () => setPreview(null) : onClose} width={1040}>
      {operator && (
        <div className="p-6">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <div className="text-[17px] font-semibold tracking-tight">
                {t("opsales.title", { name: operator.name })}
              </div>
              <div className="text-[12.5px] text-muted mt-1">
                {periodLabel}
                {q.data && (
                  <>
                    {" · "}
                    <span className="font-semibold" style={{ color: "var(--accent)" }}>
                      {t("opsales.summary", { count: q.data.count, sum: formatUZS(total) })}
                    </span>
                  </>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid place-items-center rounded-full hover:bg-[color:var(--faint)] transition"
              style={{ width: 32, height: 32 }}
              aria-label="close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid gap-3 pb-2 nf-col" style={{ gridTemplateColumns: cols }}>
            <div>{t("opsales.col_date")}</div>
            <div>{t("opsales.col_phone")}</div>
            <div>{t("opsales.col_partner")}</div>
            <div>{t("opsales.col_client")}</div>
            <div className="text-right">{t("opsales.col_amount")}</div>
            <div>{t("opsales.col_photo")}</div>
          </div>

          {q.isLoading ? (
            <div className="text-center text-muted py-12 text-[13px]">{t("common.loading")}</div>
          ) : rows.length === 0 ? (
            <div className="text-center text-muted py-12 text-[13px]">{t("opsales.empty")}</div>
          ) : (
            <div>
              {rows.map((s) => {
                const price = Number(s.total_price ?? s.amount) || 0;
                const myLine = s.operator_lines.find((l) => l.operator === operator.id);
                const share = myLine ? Number(myLine.amount) : price;
                const photos = photosOf(s);
                return (
                  <div
                    key={s.id}
                    className="grid gap-3 items-center py-3 text-[13px]"
                    style={{ gridTemplateColumns: cols, borderTop: "1px solid var(--faint)" }}
                  >
                    <div className="text-muted tabular-nums text-[12px]">{formatDate(s.sold_at)}</div>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{s.phone_model || "—"}</div>
                      <div className="text-[11.5px] text-muted font-mono truncate">{s.imei}</div>
                    </div>
                    <div className="min-w-0">
                      {s.partner_lines.length > 0 ? (
                        s.partner_lines.map((p) => (
                          <div key={p.partner} className="truncate">
                            {p.partner_name}
                            {s.partner_lines.length > 1 && (
                              <span className="text-muted text-[11.5px]"> · {formatUZS(p.amount)}</span>
                            )}
                          </div>
                        ))
                      ) : (
                        <div className="truncate">{s.channel_name || "—"}</div>
                      )}
                    </div>
                    <div className="min-w-0">
                      {s.client_name || s.client_phone ? (
                        <>
                          <div className="truncate">{s.client_name || "—"}</div>
                          {s.client_phone && (
                            <a
                              href={`tel:${s.client_phone}`}
                              className="text-[12px] text-muted tabular-nums hover:text-text"
                            >
                              {s.client_phone}
                            </a>
                          )}
                        </>
                      ) : (
                        <span className="text-muted text-[12px]">{t("opsales.no_client")}</span>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="font-semibold tabular-nums">{formatUZS(price)}</div>
                      {Math.round(share) !== Math.round(price) && (
                        <div className="text-[11px] text-muted tabular-nums">
                          {t("opsales.share", { sum: formatUZS(share) })}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {photos.length === 0 ? (
                        <span className="text-[11.5px] text-muted">{t("opsales.no_photo")}</span>
                      ) : (
                        photos.slice(0, 2).map((url, i) => (
                          <button
                            key={url}
                            type="button"
                            onClick={() => setPreview(url)}
                            className="relative rounded-lg overflow-hidden border border-[color:var(--border)] hover:border-[color:var(--accent)] transition"
                            style={{ width: 38, height: 38 }}
                          >
                            <img src={url} alt="" className="w-full h-full object-cover" loading="lazy" />
                            {i === 1 && photos.length > 2 && (
                              <span className="absolute inset-0 grid place-items-center bg-black/55 text-white text-[11px] font-semibold">
                                +{photos.length - 2}
                              </span>
                            )}
                          </button>
                        ))
                      )}
                      <Link
                        to={`/sales/${s.id}`}
                        title={t("opsales.open_sale")}
                        className="ml-auto grid place-items-center rounded-lg text-muted hover:text-text hover:bg-[color:var(--faint)] transition"
                        style={{ width: 28, height: 28 }}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Link>
                    </div>
                  </div>
                );
              })}
              {(q.data?.count ?? 0) > rows.length && (
                <div className="text-[12px] text-muted text-center pt-3">
                  {t("opsales.more", { n: rows.length })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {preview &&
        createPortal(
          <div
            className="fixed inset-0 grid place-items-center p-6 cursor-zoom-out"
            style={{ zIndex: 10000, background: "rgba(0,0,0,.82)" }}
            onClick={() => setPreview(null)}
          >
            <img
              src={preview}
              alt=""
              className="max-w-full max-h-full rounded-xl shadow-2xl"
              style={{ objectFit: "contain" }}
            />
          </div>,
          document.body,
        )}
    </Modal>,
    document.body,
  );
}
