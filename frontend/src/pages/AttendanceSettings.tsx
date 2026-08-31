import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { useT } from "../lib/i18n";

type Settings = {
  shift_start: string;
  shift_end: string;
  late_threshold_min: number;
  auto_close_at: string;
  checkout_reminder_after_hours: number;
  max_backfill_hours: number;
  default_salary_uzs: string;
  default_grace_period_min: number;
  default_late_penalty_uzs: string;
  default_weekly_day_off: number;
  default_attendance_gate_pct: number;
  default_weekly_free_absences: number;
};

const WEEKDAYS_RU = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export default function AttendanceSettings() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery<Settings>({
    queryKey: ["attendance-settings-full"],
    queryFn: () => api.get<Settings>("/attendance/settings/").then((r) => r.data),
  });
  const [form, setForm] = useState<Settings | null>(null);

  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);

  const mut = useMutation({
    mutationFn: (payload: Partial<Settings>) =>
      api.patch<Settings>("/attendance/settings/", payload).then((r) => r.data),
    onSuccess: (d) => {
      setForm(d);
      qc.invalidateQueries({ queryKey: ["attendance-settings-full"] });
      toast.success(t("att_settings.saved"));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  if (q.isPending || !form) {
    return <div className="p-8 text-muted">Загрузка…</div>;
  }

  const upd = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setForm({ ...form, [k]: v });

  return (
    <div className="mx-auto max-w-[840px] flex flex-col gap-5 p-5">
      <div>
        <h1 className="text-[22px] font-semibold">{t("att_settings.title")}</h1>
        <div className="text-[13px] text-muted mt-0.5">
          {t("att_settings.subtitle")}
        </div>
      </div>

      {/* Смена */}
      <section
        className="rounded-[16px] border p-5 flex flex-col gap-3"
        style={{ borderColor: "var(--border)" }}
      >
        <h2 className="text-[15px] font-semibold">{t("att_settings.section_shift")}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={t("att_settings.shift_start")}>
            <input
              type="time"
              className="nf-input"
              value={form.shift_start}
              onChange={(e) => upd("shift_start", e.target.value)}
            />
          </Field>
          <Field label={t("att_settings.shift_end")}>
            <input
              type="time"
              className="nf-input"
              value={form.shift_end}
              onChange={(e) => upd("shift_end", e.target.value)}
            />
          </Field>
          <Field
            label={t("att_settings.default_weekly_day_off")}
            hint={t("att_settings.default_weekly_day_off_hint")}
          >
            <select
              className="nf-input"
              value={form.default_weekly_day_off}
              onChange={(e) => upd("default_weekly_day_off", parseInt(e.target.value, 10))}
            >
              {WEEKDAYS_RU.map((w, i) => (
                <option key={i} value={i}>
                  {w}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t("att_settings.auto_close_at")}
            hint={t("att_settings.auto_close_at_hint")}
          >
            <input
              type="time"
              className="nf-input"
              value={form.auto_close_at}
              onChange={(e) => upd("auto_close_at", e.target.value)}
            />
          </Field>
        </div>
      </section>

      {/* Штрафы + гейт */}
      <section
        className="rounded-[16px] border p-5 flex flex-col gap-3"
        style={{ borderColor: "var(--border)" }}
      >
        <h2 className="text-[15px] font-semibold">{t("att_settings.section_penalties")}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label={t("att_settings.default_grace_period_min")}
            hint={t("att_settings.default_grace_period_min_hint")}
          >
            <input
              type="number"
              min={0}
              max={240}
              className="nf-input"
              value={form.default_grace_period_min}
              onChange={(e) =>
                upd("default_grace_period_min", parseInt(e.target.value || "0", 10))
              }
            />
          </Field>
          <Field
            label={t("att_settings.default_late_penalty_uzs")}
            hint={t("att_settings.default_late_penalty_uzs_hint")}
          >
            <input
              type="number"
              min={0}
              className="nf-input"
              value={form.default_late_penalty_uzs}
              onChange={(e) => upd("default_late_penalty_uzs", e.target.value)}
            />
          </Field>
          <Field
            label={t("att_settings.default_weekly_free_absences")}
            hint={t("att_settings.default_weekly_free_absences_hint")}
          >
            <input
              type="number"
              min={0}
              max={7}
              className="nf-input"
              value={form.default_weekly_free_absences}
              onChange={(e) =>
                upd("default_weekly_free_absences", parseInt(e.target.value || "0", 10))
              }
            />
          </Field>
          <Field
            label={t("att_settings.default_attendance_gate_pct")}
            hint={t("att_settings.default_attendance_gate_pct_hint")}
          >
            <input
              type="number"
              min={0}
              max={100}
              className="nf-input"
              value={form.default_attendance_gate_pct}
              onChange={(e) =>
                upd("default_attendance_gate_pct", parseInt(e.target.value || "0", 10))
              }
            />
          </Field>
        </div>
      </section>

      {/* Оклад default */}
      <section
        className="rounded-[16px] border p-5 flex flex-col gap-3"
        style={{ borderColor: "var(--border)" }}
      >
        <h2 className="text-[15px] font-semibold">{t("att_settings.section_salary")}</h2>
        <Field
          label={t("att_settings.default_salary_uzs")}
          hint={t("att_settings.default_salary_uzs_hint")}
        >
          <input
            type="number"
            min={0}
            className="nf-input"
            value={form.default_salary_uzs}
            onChange={(e) => upd("default_salary_uzs", e.target.value)}
          />
        </Field>
      </section>

      {/* Сохранение */}
      <div className="flex justify-end">
        <button
          onClick={() => mut.mutate(form)}
          disabled={mut.isPending}
          className="nf-btn nf-btn--primary flex items-center gap-2"
        >
          <Save className="w-4 h-4" />
          {mut.isPending ? t("att_settings.saving") : t("att_settings.save")}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12.5px] font-medium">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-muted">{hint}</span>}
    </label>
  );
}
