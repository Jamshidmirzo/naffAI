import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Camera, Copy } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import { formatNumber, formatUZS } from "../lib/format";

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
  contract_photos_all?: { id: number; url: string | null; position: number }[];
  // Multi-channel payment split. Empty on legacy single-channel sales;
  // populated (2 entries) when the operator paid via a split. The UI
  // decides whether to render the compact channel_name summary or the
  // A+B chip pair based on `partner_lines.length`.
  partner_lines?: {
    partner: number;
    partner_name: string;
    amount: string;
  }[];
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
        {rows.map((s) => {
          // Prefer the multi-photo thumbnail (#0) when present; fall back
          // to the legacy single field, then to the camera-placeholder.
          const firstPhoto =
            s.contract_photos_all?.[0]?.url ?? s.contract_photo ?? null;
          const extraPhotoCount = Math.max(
            0,
            (s.contract_photos_all?.length ?? 0) - 1,
          );
          const splitLines = s.partner_lines ?? [];
          const isSplit = splitLines.length > 1;
          return (
            <Link
              key={s.id}
              to={`/sales/${s.id}`}
              className="nf-card overflow-hidden hover:border-[var(--accent)] transition"
            >
              <div className="flex gap-3">
                <div className="relative w-24 h-24 flex-shrink-0 bg-[var(--surface2)] flex items-center justify-center">
                  {firstPhoto ? (
                    <img
                      src={firstPhoto}
                      alt="contract"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Camera className="w-6 h-6 text-muted" />
                  )}
                  {extraPhotoCount > 0 && (
                    <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] tabular-nums">
                      +{extraPhotoCount}
                    </div>
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
                  {/* Prominent IMEI — mono 14 with a tiny inline copy button
                      so the manager can grab it from the queue without
                      opening the detail page. */}
                  <div
                    className="mt-1.5 flex items-center gap-1.5 text-muted"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="text-[10.5px] uppercase tracking-wider">
                      IMEI
                    </span>
                    <span className="font-mono text-[14px] tabular-nums text-text select-all truncate">
                      {s.imei}
                    </span>
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                          await navigator.clipboard.writeText(s.imei);
                          toast.success(t("common.copied"));
                        } catch {
                          /* silent */
                        }
                      }}
                      className="text-muted hover:text-[var(--accent)] transition"
                      title={t("sale_detail.copy_imei")}
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="text-[12px] text-muted mt-1 truncate">
                    {s.operator_name || "—"}
                    {!isSplit && ` · ${s.channel_name || "—"}`}
                  </div>
                  {isSplit && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {splitLines.map((line, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--faint)] border border-[var(--border)] text-[10.5px] tabular-nums"
                          title={`${line.partner_name}: ${formatUZS(line.amount)}`}
                        >
                          <span className="font-medium">{line.partner_name}</span>
                          <span className="text-muted">
                            {formatNumber(Number(line.amount))}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  {(s.client_name || s.client_phone) && (
                    <div className="text-[11.5px] text-muted mt-0.5 truncate">
                      {s.client_name} {s.client_phone}
                    </div>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
