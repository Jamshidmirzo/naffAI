import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CheckCircle2, XCircle, ChevronDown, ChevronUp } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

/**
 * Manager review of pending day-off requests.
 *
 * Each row expands to show DayOffContextCard — last day off of this
 * operator, count of other operators approved for the same date, and
 * last-7d sales+leads+calls so the manager has data to argue back.
 */

interface Row {
  id: number;
  operator_id: number;
  operator_name: string;
  date: string;
  status: string;
  reason: string;
  created_at: string;
}

interface ContextPayload extends Row {
  context: {
    last_day_off: string | null;
    others_on_date: number;
    recent: {
      sales_7d_count: number;
      sales_7d_total: string;
      leads_7d_touched: number;
      calls_7d_total: number;
    };
  };
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });

const fmtMoney = (raw: string): string => {
  const n = Number(raw) || 0;
  return new Intl.NumberFormat("ru-RU").format(Math.round(n));
};

export default function DayOffRequests() {
  const t = useT();
  const qc = useQueryClient();
  usePageHeader({ title: t("day_off_admin.title"), subtitle: t("day_off_admin.subtitle") });

  const q = useQuery<{ results: Row[]; count: number }>({
    queryKey: ["day-off-pending"],
    queryFn: () => api.get("/operators/day-off/pending/").then((r) => r.data),
  });

  const rows = q.data?.results ?? [];

  return (
    <div className="mx-auto max-w-[900px] flex flex-col gap-5">
      <section className="nf-card p-5 flex items-center gap-3">
        <div className="grid place-items-center" style={{
          width: 44, height: 44, borderRadius: 14,
          background: "var(--accent-grad)", color: "#fff",
        }}>
          <CalendarClock className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold tracking-tight">
            {t("day_off_admin.total_prefix")}: {q.data?.count ?? 0}
          </div>
          <div className="text-[12.5px] text-muted">{t("day_off_admin.hint")}</div>
        </div>
      </section>

      {q.isLoading ? (
        <div className="nf-card p-8 text-center text-muted text-[13px]">…</div>
      ) : rows.length === 0 ? (
        <div className="nf-card p-10 text-center text-muted text-[13px]">
          {t("day_off_admin.empty")}
        </div>
      ) : (
        rows.map((r) => (
          <RequestCard key={r.id} row={r} onDecided={() => qc.invalidateQueries({ queryKey: ["day-off-pending"] })} />
        ))
      )}
    </div>
  );
}

function RequestCard({ row, onDecided }: { row: Row; onDecided: () => void }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");

  const ctx = useQuery<ContextPayload>({
    queryKey: ["day-off-context", row.id],
    queryFn: () => api.get(`/operators/day-off/${row.id}/context/`).then((r) => r.data),
    enabled: expanded,
  });

  const approve = useMutation({
    mutationFn: () => api.post(`/operators/day-off/${row.id}/approve/`, { note }),
    onSuccess: () => {
      toast.success(t("day_off_admin.approved_toast"));
      onDecided();
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { detail?: string } } };
      toast.error(err.response?.data?.detail || t("day_off_admin.action_failed"));
    },
  });

  const reject = useMutation({
    mutationFn: () => api.post(`/operators/day-off/${row.id}/reject/`, { note }),
    onSuccess: () => {
      toast.success(t("day_off_admin.rejected_toast"));
      onDecided();
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { detail?: string } } };
      toast.error(err.response?.data?.detail || t("day_off_admin.action_failed"));
    },
  });

  return (
    <section className="nf-card overflow-hidden">
      <div
        className="px-6 py-4 flex items-center gap-3 cursor-pointer hover:bg-[var(--faint)] transition"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold">{row.operator_name}</div>
          <div className="text-[12.5px] text-muted">
            {fmtDate(row.date)}
            {row.reason && <> · {row.reason}</>}
          </div>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </div>

      {expanded && (
        <div className="border-t px-6 py-5 flex flex-col gap-4" style={{ borderColor: "var(--border)" }}>
          {ctx.isLoading ? (
            <div className="text-center text-muted text-[13px] py-4">…</div>
          ) : ctx.data ? (
            <>
              {/* Stats grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                <StatChip
                  label={t("day_off_admin.stat_last_day_off")}
                  value={ctx.data.context.last_day_off ? fmtDate(ctx.data.context.last_day_off) : t("day_off_admin.never")}
                />
                <StatChip
                  label={t("day_off_admin.stat_others")}
                  value={String(ctx.data.context.others_on_date)}
                  tone={ctx.data.context.others_on_date >= 3 ? "danger" : "neutral"}
                />
                <StatChip
                  label={t("day_off_admin.stat_sales_7d")}
                  value={`${ctx.data.context.recent.sales_7d_count} · ${fmtMoney(ctx.data.context.recent.sales_7d_total)}`}
                />
                <StatChip
                  label={t("day_off_admin.stat_activity_7d")}
                  value={`${ctx.data.context.recent.leads_7d_touched} · ${ctx.data.context.recent.calls_7d_total}`}
                  hint={t("day_off_admin.stat_activity_hint")}
                />
              </div>

              {/* Decision */}
              <div>
                <label className="nf-col mb-1.5 block">{t("day_off_admin.note_label")}</label>
                <textarea
                  className="nf-input"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("day_off_admin.note_ph")}
                  maxLength={2000}
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  className="nf-btn nf-btn--ghost"
                  disabled={reject.isPending}
                  onClick={() => reject.mutate()}
                >
                  <XCircle className="w-3.5 h-3.5" /> {t("day_off_admin.reject_btn")}
                </button>
                <button
                  className="nf-btn nf-btn--primary"
                  disabled={approve.isPending}
                  onClick={() => approve.mutate()}
                >
                  <CheckCircle2 className="w-3.5 h-3.5" /> {t("day_off_admin.approve_btn")}
                </button>
              </div>
            </>
          ) : (
            <div className="text-red-500 text-[13px]">Error loading context</div>
          )}
        </div>
      )}
    </section>
  );
}

function StatChip({
  label, value, hint, tone = "neutral",
}: { label: string; value: string; hint?: string; tone?: "neutral" | "danger" }) {
  const bg = tone === "danger" ? "rgba(239,68,68,.10)" : "var(--surface)";
  const color = tone === "danger" ? "#ef4444" : "var(--text)";
  return (
    <div className="rounded-xl p-3 border" style={{ background: bg, borderColor: "var(--border)" }}>
      <div className="text-[11px] uppercase text-muted tracking-wide">{label}</div>
      <div className="text-[15px] font-semibold tabular-nums mt-1" style={{ color }}>
        {value}
      </div>
      {hint && <div className="text-[10.5px] text-muted mt-0.5">{hint}</div>}
    </div>
  );
}
