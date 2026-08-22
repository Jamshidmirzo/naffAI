import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Camera, Check, Copy, X } from "lucide-react";
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

type BulkResult = {
  processed: { sale_id: number; status: string }[];
  skipped: { sale_id: number; reason: string }[];
  errors: { sale_id: number; detail: string }[];
  counts: { ok: number; skipped: number; errors: number };
};

/**
 * Manager review queue for operator-submitted pending sales.
 * Card = photo thumbnail + IMEI + model + operator + amount.
 * Click → SaleDetail, where the approve/reject/improve panel lives.
 *
 * Wave-1 (2026-08-22): multi-select — чекбокс в углу каждой карточки,
 * footer-bar с массовыми действиями. Bulk approve / reject проходят
 * через POST /api/sales/bulk-confirm/ (backend `sale_bulk_action`).
 */
export default function SalesPending() {
  const t = useT();
  const qc = useQueryClient();
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

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  // Если backend вернул обновлённый список — вычищаем из выбора те,
  // которых больше нет (после успешного bulk), чтобы footer не залипал.
  const visibleIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const validSelected = useMemo(
    () => new Set([...selectedIds].filter((id) => visibleIds.has(id))),
    [selectedIds, visibleIds],
  );

  const bulk = useMutation({
    mutationFn: async (payload: {
      sale_ids: number[];
      mode: "approve" | "reject";
      reason?: string;
    }) => {
      const { data } = await api.post<BulkResult>(
        "/sales/bulk-confirm/",
        payload,
      );
      return data;
    },
    onSuccess: (data) => {
      toast.success(
        t("sales_pending.bulk_success", {
          ok: data.counts.ok,
          skipped: data.counts.skipped,
          errors: data.counts.errors,
        }),
      );
      setSelectedIds(new Set());
      setRejectModalOpen(false);
      setRejectReason("");
      qc.invalidateQueries({ queryKey: ["sales-pending"] });
      qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
      qc.invalidateQueries({ queryKey: ["lead-stats"] });
    },
    onError: (err: unknown) => {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response
          ?.data?.detail || "Ошибка";
      toast.error(detail);
    },
  });

  const toggleOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(rows.map((r) => r.id)));
  };
  const clearSelection = () => setSelectedIds(new Set());

  const runApproveAll = () => {
    if (validSelected.size === 0) return;
    bulk.mutate({ sale_ids: [...validSelected], mode: "approve" });
  };
  const runRejectAll = () => {
    if (validSelected.size === 0) return;
    const reason = rejectReason.trim();
    if (!reason) {
      toast.error(t("sales_pending.reject_reason_label"));
      return;
    }
    bulk.mutate({ sale_ids: [...validSelected], mode: "reject", reason });
  };

  return (
    <div className="max-w-5xl pb-24">
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

      {rows.length > 0 && (
        <div className="mb-3 flex items-center gap-3 text-[12.5px] text-muted">
          <button
            type="button"
            onClick={
              validSelected.size === rows.length ? clearSelection : selectAll
            }
            className="underline underline-offset-2 hover:text-[var(--accent)] transition"
          >
            {validSelected.size === rows.length
              ? t("sales_pending.clear_selection")
              : t("common.select_all") /* falls back to key if missing */}
          </button>
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
          const checked = selectedIds.has(s.id);
          return (
            <div
              key={s.id}
              className={`nf-card overflow-hidden relative transition ${
                checked
                  ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                  : "hover:border-[var(--accent)]"
              }`}
            >
              {/* Checkbox overlay — click stops navigation to the sale
                  detail. Positioned top-left over the photo. */}
              <label
                className="absolute top-1.5 left-1.5 z-10 w-6 h-6 flex items-center justify-center bg-white/95 rounded-md border border-[var(--border)] shadow-sm cursor-pointer"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-[var(--accent)]"
                  checked={checked}
                  onChange={() => toggleOne(s.id)}
                />
              </label>

              <Link to={`/sales/${s.id}`} className="block">
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
            </div>
          );
        })}
      </div>

      {/* Footer bulk-bar — появляется когда есть выбранное. Sticky
          bottom, centered, читаемо на мобильном тоже. */}
      {validSelected.size > 0 && (
        <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-2 rounded-full bg-[var(--surface)] border border-[var(--border)] shadow-lg">
          <div className="text-[13px] font-semibold pl-2 pr-1 tabular-nums">
            {t("sales_pending.bulk_selected", { count: validSelected.size })}
          </div>
          <button
            type="button"
            onClick={runApproveAll}
            disabled={bulk.isPending}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-emerald-600 text-white text-[12.5px] font-medium hover:bg-emerald-700 transition disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            {t("sales_pending.approve_all")}
          </button>
          <button
            type="button"
            onClick={() => setRejectModalOpen(true)}
            disabled={bulk.isPending}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-red-600 text-white text-[12.5px] font-medium hover:bg-red-700 transition disabled:opacity-50"
          >
            <X className="w-3.5 h-3.5" />
            {t("sales_pending.reject_all")}
          </button>
          <button
            type="button"
            onClick={clearSelection}
            disabled={bulk.isPending}
            className="text-muted hover:text-text transition text-[12px] px-2"
          >
            {t("sales_pending.clear_selection")}
          </button>
        </div>
      )}

      {/* Reject-all modal — reason обязателен на backend'e. */}
      {rejectModalOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
          <div className="nf-card p-4 w-full max-w-md">
            <div className="text-[15px] font-semibold mb-2">
              {t("sales_pending.bulk_confirm_reject", {
                count: validSelected.size,
              })}
            </div>
            <label className="block text-[12px] text-muted mb-1">
              {t("sales_pending.reject_reason_label")}
            </label>
            <textarea
              className="nf-input w-full h-24 resize-none"
              placeholder={t("sales_pending.reject_reason_placeholder")}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              autoFocus
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setRejectModalOpen(false);
                  setRejectReason("");
                }}
                disabled={bulk.isPending}
                className="px-3 py-1.5 rounded-full border border-[var(--border)] text-[13px]"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={runRejectAll}
                disabled={bulk.isPending || !rejectReason.trim()}
                className="px-3 py-1.5 rounded-full bg-red-600 text-white text-[13px] font-medium disabled:opacity-50"
              >
                {t("sales_pending.reject_all")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
