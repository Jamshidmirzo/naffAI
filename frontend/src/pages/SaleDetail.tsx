import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { formatDate, formatUZS } from "../lib/format";
import {
  Button,
  Eyebrow,
  Modal,
  StatusBadge,
  toast,
} from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import { useAuth } from "../store/auth";
import { normaliseRole } from "../components/RoleGate";

interface OperatorLine {
  operator: number;
  operator_name: string;
  amount: string;
}
interface PartnerLine {
  partner: number;
  partner_name: string;
  amount: string;
}
interface Gift {
  id: number;
  name: string;
  cost: string | null;
}

function fmtRelativeTime(iso: string | null | undefined, t: (k: string, p?: Record<string, string | number>) => string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday =
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate();
    const time = d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (sameDay) return t("sale_detail.time_today", { t: time });
    if (isYesterday) return t("sale_detail.time_yesterday", { t: time });
    const dateStr = d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
    });
    return t("sale_detail.time_date", { d: dateStr, t: time });
  } catch {
    return formatDate(iso);
  }
}

/* -----------------------------------------------------------------
 * AI insights — mock data, swap for real endpoint later.
 * ---------------------------------------------------------------- */
const AI_INSIGHT_POOL: Array<Array<{ tag: string; text: string }>> = [
  [
    { tag: "Чек", text: "Средний чек на 12% выше медианы месяца." },
    { tag: "Скорость", text: "Продажа закрыта за 8 минут — быстрее 90% сделок." },
    { tag: "Оператор", text: "Оператор в топ-3 по конверсии за последние 30 дней." },
    { tag: "Рекомендация", text: "Клиент подходит для допродажи чехла и стекла." },
  ],
  [
    { tag: "Чек", text: "Сумма ниже среднего чека на 4% — типично для канала." },
    { tag: "Скорость", text: "Диалог занял 22 минуты, чуть выше средней." },
    { tag: "Оператор", text: "5-я продажа этой модели за неделю — стабильно." },
    { tag: "Рекомендация", text: "Проверить сплит: обычно этот оператор берёт 60%." },
  ],
  [
    { tag: "Чек", text: "Крупная продажа — топ-10% по сумме за месяц." },
    { tag: "Скорость", text: "Быстрая сделка через партнёрский канал." },
    { tag: "Оператор", text: "Оператор впервые продал эту модель — новый рекорд." },
    { tag: "Рекомендация", text: "Занести кейс в разбор дня для команды." },
  ],
];

interface AiPanelProps {
  saleId: string | undefined;
}
function AiPanel({ saleId }: AiPanelProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [seed, setSeed] = useState(0);
  const insights = AI_INSIGHT_POOL[seed % AI_INSIGHT_POOL.length];

  const regenerate = () => {
    setBusy(true);
    setTimeout(() => {
      setSeed((s) => s + 1);
      setBusy(false);
      toast.success(t("sale_detail.ai_updated"));
    }, 900);
  };

  return (
    <div
      className="nf-card animate-nfFadeUp"
      style={{
        background:
          "linear-gradient(165deg, rgba(242,86,11,.07), var(--surface) 55%)",
        padding: "24px 26px",
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div
            className="grid place-items-center text-white shrink-0"
            style={{
              width: 22,
              height: 22,
              borderRadius: 7,
              background: "var(--accent-grad)",
              boxShadow: "0 6px 14px -6px var(--accent)",
            }}
          >
            <Sparkles className="w-3 h-3" />
          </div>
          <div className="text-[15px] font-semibold tracking-tight">{t("sale_detail.ai_title")}</div>
        </div>
        <button
          type="button"
          onClick={regenerate}
          disabled={busy}
          className="text-[12px] text-muted hover:text-text transition disabled:opacity-50"
        >
          {busy ? "…" : t("sale_detail.ai_again")}
        </button>
      </div>

      {busy ? (
        <div className="py-8 text-center text-[12.5px] text-muted animate-nfFade">
          {t("sale_detail.ai_comparing")}
        </div>
      ) : (
        <div className="flex flex-col">
          {insights.map((ins, i) => (
            <div
              key={`${seed}-${i}`}
              className="py-3 animate-nfFadeUp"
              style={{
                borderBottom:
                  i < insights.length - 1 ? "1px solid var(--border)" : undefined,
                animationDelay: `${0.05 + i * 0.06}s`,
              }}
            >
              <div
                className="text-[12.5px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--accent)", letterSpacing: "0.06em" }}
              >
                {ins.tag}
              </div>
              <div className="text-[13.5px] mt-1 leading-[1.5]">{ins.text}</div>
            </div>
          ))}
        </div>
      )}

      {saleId && (
        <div className="mt-3 text-[11px] text-muted">
          {t("sale_detail.ai_mock_note", { id: saleId })}
        </div>
      )}
    </div>
  );
}

/* -----------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------- */

export default function SaleDetail() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const role = normaliseRole(useAuth((s) => s.role));
  const isManager = role === "manager";
  const [returnReason, setReturnReason] = useState("");
  const [showReturn, setShowReturn] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showPhotoFull, setShowPhotoFull] = useState(false);

  const q = useQuery({
    queryKey: ["sale", id],
    queryFn: () => api.get(`/sales/${id}/`).then((r) => r.data),
  });

  usePageHeader(
    {
      title: t("sale_detail.title_pageheader"),
      subtitle: id ? t("sale_detail.subtitle_id", { id }) : undefined,
      back: "/sales",
    },
    [id],
  );

  const returnMut = useMutation({
    mutationFn: (reason: string) => api.post(`/sales/${id}/return/`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sale", id] });
      qc.invalidateQueries({ queryKey: ["sales"] });
      setShowReturn(false);
      setReturnReason("");
      toast.success(t("sale_detail.return_success"));
    },
    onError: () => toast.error(t("sale_detail.return_failed")),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/sales/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales"] });
      toast.success(t("sale_detail.delete_success"));
      nav("/sales");
    },
    onError: () => toast.error(t("sale_detail.delete_failed")),
  });

  const approveMut = useMutation({
    mutationFn: () => api.post(`/sales/${id}/confirm/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sale", id] });
      qc.invalidateQueries({ queryKey: ["sales-pending"] });
      qc.invalidateQueries({ queryKey: ["sales-pending-count"] });
      toast.success(t("sale_pending.approve_done"));
    },
    onError: () => toast.error(t("sale_pending.approve_failed")),
  });

  const rejectMut = useMutation({
    mutationFn: (reason: string) => api.post(`/sales/${id}/reject/`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sale", id] });
      qc.invalidateQueries({ queryKey: ["sales-pending"] });
      qc.invalidateQueries({ queryKey: ["sales-pending-count"] });
      setShowReject(false);
      setRejectReason("");
      toast.success(t("sale_pending.reject_done"));
    },
    onError: () => toast.error(t("sale_pending.reject_failed")),
  });

  const s = q.data;

  const operatorLines: OperatorLine[] = s?.operator_lines ?? [];
  const partnerLines: PartnerLine[] = s?.partner_lines ?? [];

  const opTotal = useMemo(
    () => operatorLines.reduce((sum, l) => sum + Number(l.amount), 0),
    [operatorLines],
  );

  if (q.isLoading) {
    return (
      <div className="mx-auto max-w-[1180px] py-20 text-center text-muted text-[14px]">
        {t("common.loading")}
      </div>
    );
  }

  if (q.isError || !s) {
    return (
      <div className="mx-auto max-w-[1180px] py-16 text-center">
        <div
          className="text-[14px] mb-4 rounded-2xl px-5 py-4 inline-block"
          style={{
            background: "rgba(220,60,40,.08)",
            color: "var(--danger)",
            border: "1px solid rgba(220,60,40,.2)",
          }}
        >
          {t("sale_detail.not_found")}
        </div>
        <div>
          <Button variant="ghost" onClick={() => nav("/sales")}>
            {t("sale_detail.back_list")}
          </Button>
        </div>
      </div>
    );
  }

  const isReturned = !!s.is_returned;
  const isDeleted = !!s.is_deleted;
  const isPending = s.status === "pending";
  const isGift = Array.isArray(s.gifts) && s.gifts.length > 0;

  const badge = isReturned
    ? { tone: "danger" as const, text: t("sale_detail.status_return") }
    : isDeleted
    ? { tone: "neutral" as const, text: t("sale_detail.status_deleted_lower") }
    : isPending
    ? { tone: "hot" as const, text: t("sale_detail.status_pending") }
    : { tone: "neutral" as const, text: t("sale_detail.status_paid") };

  const primaryOp = operatorLines[0];
  const opSummary = primaryOp
    ? operatorLines.length === 1
      ? primaryOp.operator_name
      : `${primaryOp.operator_name} +${operatorLines.length - 1}`
    : s.operator_name ?? "—";

  const opSplitLabel = (line: OperatorLine) => {
    if (opTotal <= 0) return "";
    const pct = (Number(line.amount) / opTotal) * 100;
    return `${pct.toFixed(0)}%`;
  };

  const partnerSummary = partnerLines.length
    ? partnerLines.map((p) => p.partner_name).join(", ")
    : s.channel_name ?? "—";

  const giftsSummary = isGift
    ? (s.gifts as Gift[]).map((g) => g.name).join(", ")
    : "—";

  const tiles = [
    { label: t("common.amount"), value: formatUZS(s.total_price ?? s.amount) },
    { label: t("sale_detail.tile_channel"), value: partnerSummary },
    { label: t("sale_detail.tile_operator"), value: opSummary, hint: primaryOp ? opSplitLabel(primaryOp) : "" },
    { label: t("sale_detail.tile_client"), value: s.client_name || s.client_phone || "—" },
    { label: t("common.date"), value: formatDate(s.sold_at) },
    { label: t("sale_detail.tile_gifts"), value: giftsSummary },
  ];

  // History (audit_events) — optional; fallback to created/updated.
  const history: Array<{ text: string; who: string; when: string }> = (
    (s.audit_events as Array<{ description?: string; actor_name?: string; created_at?: string }>) ??
    []
  ).map((e) => ({
    text: e.description ?? t("sale_detail.audit_change"),
    who: e.actor_name ?? t("sale_detail.system"),
    when: formatDate(e.created_at ?? null),
  }));
  if (history.length === 0) {
    history.push(
      {
        text: t("sale_detail.return_created", { sum: formatUZS(s.amount) }),
        who: primaryOp?.operator_name ?? t("sale_detail.system"),
        when: formatDate(s.created_at),
      },
      ...(s.updated_at && s.updated_at !== s.created_at
        ? [
            {
              text: t("sale_detail.updated_record"),
              who: t("sale_detail.system"),
              when: formatDate(s.updated_at),
            },
          ]
        : []),
    );
  }

  return (
    <div className="mx-auto max-w-[1180px]">
      <div
        className="grid gap-5"
        style={{ gridTemplateColumns: "minmax(0, 1.35fr) minmax(0, 1fr)" }}
      >
        {/* LEFT COLUMN */}
        <div className="flex flex-col gap-5 min-w-0">
          {/* Main card */}
          <section
            className="nf-card animate-nfFadeUp"
            style={{ padding: "28px 32px" }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Eyebrow>{t("sale_detail.title_eyebrow", { id: s.id })}</Eyebrow>
                <h1
                  className="font-semibold mt-2 truncate"
                  style={{
                    fontSize: 30,
                    letterSpacing: "-0.03em",
                    lineHeight: 1.15,
                  }}
                >
                  {s.phone_model || t("sale_detail.model_unknown")}
                </h1>
                <div className="text-[13px] text-muted mt-1.5">
                  IMEI <span className="font-mono text-text">{s.imei}</span>
                  {" · "}
                  {fmtRelativeTime(s.sold_at, t)}
                </div>
              </div>
              <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>
            </div>

            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {tiles.map((tile) => (
                <div
                  key={tile.label}
                  className="nf-tile"
                  style={{ padding: "14px 16px" }}
                >
                  <div
                    className="text-[11.5px] uppercase tracking-wider text-muted"
                    style={{ letterSpacing: "0.06em" }}
                  >
                    {tile.label}
                  </div>
                  <div
                    className="mt-1 text-[15px] font-semibold tabular-nums truncate"
                    title={tile.value}
                  >
                    {tile.value}
                  </div>
                  {tile.hint && (
                    <div className="text-[11.5px] text-muted mt-0.5">{tile.hint}</div>
                  )}
                </div>
              ))}
            </div>

            {operatorLines.length > 1 && (
              <div
                className="mt-4 pt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                <div className="font-semibold text-text">{t("sale_detail.split")}</div>
                {operatorLines.map((l, i) => (
                  <span key={i}>
                    {l.operator_name} · {opSplitLabel(l)} ({formatUZS(l.amount)})
                  </span>
                ))}
              </div>
            )}

            {s.comment && (
              <div
                className="mt-4 pt-4 text-[13.5px]"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                <div className="nf-col mb-1.5">{t("common.comment")}</div>
                <div>{s.comment}</div>
              </div>
            )}

            {s.bonus_note && (
              <div
                className="mt-3 rounded-xl px-4 py-3 flex items-start gap-2 text-[13.5px]"
                style={{
                  background: "rgba(242,86,11,.08)",
                  border: "1px solid rgba(242,86,11,.25)",
                }}
              >
                <span style={{ fontSize: 18 }}>🎁</span>
                <div>
                  <div className="text-[11.5px] uppercase tracking-wide font-semibold" style={{ color: "var(--accent)" }}>
                    {t("sale_detail.bonus_label")}
                  </div>
                  <div className="mt-0.5">{s.bonus_note}</div>
                </div>
              </div>
            )}

            {s.sheet_source_name && (
              <div className="mt-3 text-[12.5px] text-muted">
                {t("sale_detail.source_label")}: <span className="font-medium text-text">{s.sheet_source_name}</span>
              </div>
            )}

            {s.contract_photo && (
              <div className="mt-5">
                <div className="nf-col mb-1.5">{t("sale_pending.contract_photo")}</div>
                <button
                  type="button"
                  onClick={() => setShowPhotoFull(true)}
                  className="block w-full max-w-sm rounded-2xl overflow-hidden border border-[var(--border)] hover:border-[var(--accent)] transition"
                >
                  <img
                    src={s.contract_photo}
                    alt="contract"
                    className="w-full max-h-[280px] object-contain bg-[var(--surface2)]"
                  />
                </button>
              </div>
            )}

            {s.status === "rejected" && s.rejection_reason && (
              <div className="mt-5 rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
                <div className="text-[12.5px] font-semibold text-red-500 mb-1">
                  {t("sale_pending.rejected_title")}
                </div>
                <div className="text-[13px] text-text whitespace-pre-wrap">
                  {s.rejection_reason}
                </div>
              </div>
            )}

            {isPending && isManager && !isDeleted && (
              <div className="mt-6 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="nf-btn nf-btn--primary"
                  onClick={() => approveMut.mutate()}
                  disabled={approveMut.isPending}
                >
                  {approveMut.isPending ? t("common.loading") : t("sale_pending.approve")}
                </button>
                <Link to={`/sales/${id}/edit`} className="nf-btn nf-btn--secondary">
                  {t("sale_pending.improve")}
                </Link>
                <button
                  type="button"
                  className="nf-btn nf-btn--danger"
                  onClick={() => setShowReject(true)}
                >
                  {t("sale_pending.reject")}
                </button>
              </div>
            )}

            {!isDeleted && !isPending && isManager && (
              <div className="mt-6 flex flex-wrap gap-2">
                <Link to={`/sales/${id}/edit`} className="nf-btn nf-btn--primary">{t("common.edit")}</Link>
                {!isReturned && (
                  <Button variant="secondary" onClick={() => setShowReturn(true)}>
                    <RotateCcw className="w-3.5 h-3.5" /> {t("sale_detail.return_modal_title")}
                  </Button>
                )}
                <Button variant="danger" onClick={() => setShowDelete(true)}>
                  <Trash2 className="w-3.5 h-3.5" /> {t("common.delete")}
                </Button>
              </div>
            )}
          </section>

          {/* History card */}
          <section
            className="nf-card animate-nfFadeUp"
            style={{ padding: 24, animationDelay: "0.1s" }}
          >
            <div className="text-[15px] font-semibold tracking-tight mb-4">
              {t("sale_detail.history_title")}
            </div>
            <ol className="flex flex-col gap-3.5">
              {history.map((h, i) => (
                <li
                  key={i}
                  className="grid items-start gap-3"
                  style={{ gridTemplateColumns: "7px 1fr" }}
                >
                  <div
                    className="mt-[7px]"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 99,
                      background: "var(--accent)",
                    }}
                  />
                  <div>
                    <div className="text-[13.5px]">{h.text}</div>
                    <div className="text-[11.5px] text-muted mt-0.5">
                      {h.who} · {h.when}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        {/* RIGHT COLUMN */}
        <div className="min-w-0">
          <AiPanel saleId={id} />
        </div>
      </div>

      {/* Reject modal */}
      <Modal open={showReject} onClose={() => setShowReject(false)} width={440}>
        <div className="p-7">
          <div className="text-[18px] font-semibold tracking-tight">
            {t("sale_pending.reject_modal_title")}
          </div>
          <div className="text-[13px] text-muted mt-1">
            {t("sale_pending.reject_hint")}
          </div>
          <div className="mt-5">
            <div className="nf-col mb-1.5">{t("sale_pending.reason_label")}</div>
            <textarea
              className="nf-input min-h-[100px]"
              rows={4}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("sale_pending.reason_ph")}
              autoFocus
            />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="nf-btn nf-btn--ghost"
              onClick={() => setShowReject(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="nf-btn nf-btn--danger"
              onClick={() => rejectMut.mutate(rejectReason)}
              disabled={rejectMut.isPending || !rejectReason.trim()}
            >
              {rejectMut.isPending ? t("common.loading") : t("sale_pending.reject")}
            </button>
          </div>
        </div>
      </Modal>

      {/* Photo fullscreen */}
      {s.contract_photo && (
        <Modal open={showPhotoFull} onClose={() => setShowPhotoFull(false)} width={900}>
          <div className="p-2">
            <img
              src={s.contract_photo}
              alt="contract"
              className="w-full max-h-[85vh] object-contain rounded-xl"
            />
          </div>
        </Modal>
      )}

      {/* Return modal */}
      <Modal
        open={showReturn}
        onClose={() => setShowReturn(false)}
        width={440}
      >
        <div className="p-7">
          <div className="text-[18px] font-semibold tracking-tight">
            {t("sale_detail.return_modal_title")}
          </div>
          <div className="text-[13px] text-muted mt-1">
            {t("sale_detail.return_hint", { id: s.id, model: s.phone_model })}
          </div>
          <div className="mt-5">
            <div className="nf-col mb-1.5">{t("sale_detail.return_reason")}</div>
            <textarea
              className="nf-input min-h-[80px]"
              rows={3}
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
              placeholder={t("sale_detail.return_reason_ph")}
              autoFocus
            />
          </div>
          <div className="mt-6 flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setShowReturn(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => returnMut.mutate(returnReason)}
              disabled={returnMut.isPending || !returnReason.trim()}
            >
              {returnMut.isPending ? t("sale_detail.return_processing") : t("sale_detail.return_modal_title")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete modal */}
      <Modal open={showDelete} onClose={() => setShowDelete(false)} width={420}>
        <div className="p-7">
          <div
            className="text-[18px] font-semibold tracking-tight"
            style={{ color: "var(--danger)" }}
          >
            {t("sale_detail.delete_title")}
          </div>
          <div className="text-[13px] text-muted mt-2">
            {t("sale_detail.delete_body", { id: s.id, model: s.phone_model, sum: formatUZS(s.amount) })}
          </div>
          <div className="mt-6 flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setShowDelete(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => deleteMut.mutate()}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? t("sale_detail.deleting") : t("common.delete")}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
