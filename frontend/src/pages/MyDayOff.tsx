import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

/**
 * Operator self-service: create a day-off request + see history.
 *
 * Backend: POST /api/operators/day-off/  +  GET /api/me/day-off/.
 * Manager reviews on /operators/day-off (DayOffRequests page).
 */

interface Row {
  id: number;
  operator_name: string;
  date: string;
  status: "pending" | "approved" | "rejected";
  reason: string;
  decision_note: string;
  decided_at: string | null;
  decided_by_name: string | null;
  created_at: string;
}

const STATUS_STYLES: Record<Row["status"], { bg: string; color: string; label_uz: string; label_ru: string }> = {
  pending: { bg: "rgba(245,158,11,.15)", color: "#f59e0b", label_uz: "Kutmoqda", label_ru: "На рассмотрении" },
  approved: { bg: "rgba(16,185,129,.15)", color: "#10b981", label_uz: "Ma'qullangan", label_ru: "Одобрен" },
  rejected: { bg: "rgba(239,68,68,.15)", color: "#ef4444", label_uz: "Rad etilgan", label_ru: "Отклонён" },
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });

function todayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function maxISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 60);
  return d.toISOString().slice(0, 10);
}

export default function MyDayOff() {
  const t = useT();
  const qc = useQueryClient();
  usePageHeader({ title: t("my_day_off.title"), subtitle: t("my_day_off.subtitle") });

  const [date, setDate] = useState(todayISO());
  const [reason, setReason] = useState("");

  const q = useQuery<{ results: Row[]; count: number }>({
    queryKey: ["my-day-off"],
    queryFn: () => api.get("/me/day-off/").then((r) => r.data),
  });

  const create = useMutation({
    mutationFn: () => api.post("/operators/day-off/", { date, reason }),
    onSuccess: () => {
      toast.success(t("my_day_off.submitted"));
      setReason("");
      qc.invalidateQueries({ queryKey: ["my-day-off"] });
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: string } } };
      toast.error(e.response?.data?.detail || t("my_day_off.submit_failed"));
    },
  });

  const rows = q.data?.results ?? [];

  return (
    <div className="mx-auto max-w-[720px] flex flex-col gap-5">
      {/* Form */}
      <section className="nf-card p-5 flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <div className="grid place-items-center" style={{
            width: 40, height: 40, borderRadius: 12,
            background: "var(--accent-grad)", color: "#fff",
          }}>
            <CalendarPlus className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-tight">{t("my_day_off.form_title")}</div>
            <div className="text-[12px] text-muted">{t("my_day_off.form_hint")}</div>
          </div>
        </div>

        <div>
          <label className="nf-col mb-1.5 block">{t("my_day_off.date_label")}</label>
          <input
            type="date"
            className="nf-input"
            value={date}
            min={todayISO()}
            max={maxISO()}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div>
          <label className="nf-col mb-1.5 block">{t("my_day_off.reason_label")}</label>
          <textarea
            className="nf-input"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("my_day_off.reason_ph")}
            maxLength={2000}
          />
        </div>

        <div className="flex justify-end">
          <button
            className="nf-btn nf-btn--primary"
            disabled={!date || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "…" : t("my_day_off.submit_btn")}
          </button>
        </div>
      </section>

      {/* History */}
      <section className="nf-card overflow-hidden">
        <div className="px-6 pt-5 pb-3 text-[14px] font-semibold tracking-tight">
          {t("my_day_off.history")}
        </div>
        {q.isLoading ? (
          <div className="text-center text-muted py-6 text-[13px]">…</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-8 text-[13px]">
            {t("my_day_off.empty")}
          </div>
        ) : (
          <div>
            {rows.map((r) => {
              const st = STATUS_STYLES[r.status];
              return (
                <div key={r.id} className="grid gap-2 px-6 py-3.5" style={{
                  gridTemplateColumns: "auto 1fr auto",
                  borderTop: "1px solid var(--border)",
                }}>
                  <div className="text-[13.5px] font-semibold tabular-nums">
                    {fmtDate(r.date)}
                  </div>
                  <div className="min-w-0">
                    {r.reason && (
                      <div className="text-[12.5px] text-muted truncate">{r.reason}</div>
                    )}
                    {r.status !== "pending" && r.decision_note && (
                      <div className="text-[12px] mt-1" style={{ color: st.color }}>
                        {t("my_day_off.decision_prefix")}: {r.decision_note}
                        {r.decided_by_name && ` — ${r.decided_by_name}`}
                      </div>
                    )}
                  </div>
                  <div
                    className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full self-start"
                    style={{ background: st.bg, color: st.color }}
                  >
                    {t(`my_day_off.status_${r.status}`)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
