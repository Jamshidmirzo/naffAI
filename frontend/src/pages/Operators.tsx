import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { normaliseRole } from "../components/RoleGate";
import { formatUZS } from "../lib/format";
import NumericInput from "../components/NumericInput";
import { StickerPicker } from "../components/StickerPicker";
import { Select } from "../components/Select";
import DateInput from "../components/DateInput";
import { PhoneInput } from "../components/ui/PhoneInput";
import {
  Button,
  Card,
  Chip,
  Modal,
  StatusBadge,
  toast,
} from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

type OperatorStatus = "active" | "trainee" | "inactive";
type StatusFilter = "all" | OperatorStatus;

interface OperatorRow {
  id: number;
  full_name: string;
  phone: string | null;
  status: OperatorStatus;
  hired_at: string | null;
  /** ISO YYYY-MM-DD; null пока не заполнено. */
  birth_date: string | null;
  plan_target: string | null;
  plan_actual: string | null;
  sticker?: { emoji: string | null; is_rare: boolean } | null;
  account?: unknown;
  month_total?: string | number | null;
  month_count?: number | null;
  blocking_gate_enabled?: boolean;
  require_checkin_enabled?: boolean;
  forgotten_checkouts_count?: number;
  // 2026-08-31 payroll overrides. Nullable — при пустом значении расчёт
  // берёт AttendanceSettings.default_* (см. attendance/services.py::
  // resolve_operator_config). Приходят в разных форматах: salary_uzs как
  // строка Decimal, times как "HH:MM:SS", остальные — целые.
  salary_uzs?: string | null;
  shift_start?: string | null;
  shift_end?: string | null;
  grace_period_min?: number | null;
  late_penalty_uzs?: string | null;
  weekly_day_off?: number | null;
  weekly_free_absences?: number | null;
  // 2026-08-31 two-gate payroll overrides (миграция 0009).
  attendance_bonus_uzs?: string | null;
  sales_bonus_uzs?: string | null;
  sales_gate_pct?: number | null;
}

/**
 * True если у оператора сегодня день рождения. Год ДР игнорируем —
 * матчим только day+month. Локально (не по backend'у), чтобы бейдж
 * появлялся мгновенно после редактирования, без ре-фетча /operators/.
 * 29 фев в невисокосный год → празднуем 28 фев (симметрия с backend
 * selector'ом `operators_with_birthday_today`).
 */
function isBirthdayToday(iso: string | null): boolean {
  if (!iso) return false;
  const bd = new Date(iso);
  if (Number.isNaN(bd.getTime())) return false;
  const today = new Date();
  const bdM = bd.getUTCMonth() + 1;
  const bdD = bd.getUTCDate();
  const tM = today.getMonth() + 1;
  const tD = today.getDate();
  if (bdM === tM && bdD === tD) return true;
  // 29 фев → в невисокосный год празднуем 28 фев
  const yr = today.getFullYear();
  const isLeap = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
  if (bdM === 2 && bdD === 29 && !isLeap && tM === 2 && tD === 28) return true;
  return false;
}

// Порог красного бейджа «Забыл выйти» — 5 auto_closed без backfill за 30 дней.
// При меньшем — серый бейдж (или скрыт при 0).
const FORGOTTEN_ALERT_THRESHOLD = 5;

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?"
  );
}

function fmtDate(iso: string | null) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export default function Operators() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const role = useAuth((s) => s.role);
  const isManager = normaliseRole(role) === "manager";
  const t = useT();

  usePageHeader({ title: t("operators.title"), subtitle: t("operators.subtitle") });

  const STATUS_TABS: { key: StatusFilter; label: string }[] = [
    { key: "all", label: t("common.all") },
    { key: "active", label: t("operators.tab_active") },
    { key: "inactive", label: t("operators.tab_fired") },
  ];

  const STATUS_LABEL: Record<OperatorStatus, string> = {
    active: t("op_detail.status_active_lower"),
    trainee: t("op_detail.status_trainee").toLowerCase(),
    inactive: t("operators.status_inactive_lower"),
  };

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    full_name: "",
    phone: "",
    status: "active" as OperatorStatus,
    note: "",
  });

  const [confirmDelete, setConfirmDelete] = useState<{ id: number; name: string } | null>(null);
  const [editModal, setEditModal] = useState<{
    id: number;
    full_name: string;
    phone: string;
    hired_at: string;
    birth_date: string;
    note: string;
    status: OperatorStatus;
    blocking_gate_enabled: boolean;
    require_checkin_enabled: boolean;
    // 2026-08-31 payroll overrides — все опциональные (пусто → default'ы
    // из AttendanceSettings). Храним как строки, чтобы «пустое поле» жило
    // корректно и не превращалось в 0 при рендере NumericInput'ов.
    salary_uzs: string;
    shift_start: string;
    shift_end: string;
    grace_period_min: string;
    late_penalty_uzs: string;
    weekly_day_off: string; // "0".."6" or "" (пусто → default)
    weekly_free_absences: string;
    // 2026-08-31 two-gate overrides.
    attendance_bonus_uzs: string;
    sales_bonus_uzs: string;
    sales_gate_pct: string;
  } | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const [planModal, setPlanModal] = useState<{ id: number; name: string; current: string | null } | null>(null);
  const [planInput, setPlanInput] = useState("");

  const [stickerModal, setStickerModal] = useState<{
    id: number;
    emoji: string | null;
    isRare: boolean;
  } | null>(null);

  const ops = useQuery({
    queryKey: ["operators", true],
    queryFn: () =>
      api.get("/operators/", { params: { include_inactive: 1 } }).then((r) => r.data),
  });

  const create = useMutation({
    mutationFn: (data: typeof form) => api.post("/operators/", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      setShowCreate(false);
      setForm({ full_name: "", phone: "", status: "active", note: "" });
      toast.success(t("operators.op_added"));
    },
    onError: () => toast.error(t("operators.op_add_failed")),
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      api
        .post<{ rebalanced_count?: number; callbacks_moved?: number }>(
          `/operators/${id}/${active ? "reactivate" : "deactivate"}/`,
        )
        .then((r) => r.data),
    onSuccess: (data, vars) => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["leads-my"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      const n = data?.rebalanced_count ?? 0;
      if (!vars.active && n > 0) {
        toast.success(t("operators.deactivated_with_rebalance", { n }));
      } else if (vars.active && n > 0) {
        toast.success(t("operators.activated_with_rebalance", { n }));
      } else {
        toast.success(t("operators.status_updated"));
      }
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/operators/${id}/delete/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["operators-list-all"] });
      setConfirmDelete(null);
      setDeleteError("");
      toast.success(t("op_detail.delete_done"));
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      const msg = typeof detail === "string" ? detail : t("operators.op_delete_failed");
      setDeleteError(msg);
    },
  });

  const editOp = useMutation({
    mutationFn: ({ id, ...body }: {
      id: number;
      full_name: string;
      phone: string;
      hired_at: string;
      birth_date: string;
      note: string;
      status: OperatorStatus;
      blocking_gate_enabled: boolean;
      require_checkin_enabled: boolean;
      salary_uzs: string;
      shift_start: string;
      shift_end: string;
      grace_period_min: string;
      late_penalty_uzs: string;
      weekly_day_off: string;
      weekly_free_absences: string;
      attendance_bonus_uzs: string;
      sales_bonus_uzs: string;
      sales_gate_pct: string;
    }) => {
      // Payroll overrides: пустая строка → null (backend возьмёт default
      // из AttendanceSettings). Числовые поля парсим — если пришёл
      // мусор (NaN), тоже null. Time-поля прокидываем как "HH:MM" —
      // Django TimeField принимает и с секундами, и без.
      const num = (v: string): number | null => {
        const s = v.trim();
        if (!s) return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      };
      const str = (v: string): string | null => (v.trim() ? v.trim() : null);
      return api.patch(`/operators/${id}/`, {
        full_name: body.full_name,
        phone: body.phone || null,
        hired_at: body.hired_at || null,
        birth_date: body.birth_date || null,
        note: body.note || "",
        status: body.status,
        blocking_gate_enabled: body.blocking_gate_enabled,
        require_checkin_enabled: body.require_checkin_enabled,
        salary_uzs: num(body.salary_uzs),
        shift_start: str(body.shift_start),
        shift_end: str(body.shift_end),
        grace_period_min: num(body.grace_period_min),
        late_penalty_uzs: num(body.late_penalty_uzs),
        weekly_day_off: num(body.weekly_day_off),
        weekly_free_absences: num(body.weekly_free_absences),
        attendance_bonus_uzs: num(body.attendance_bonus_uzs),
        sales_bonus_uzs: num(body.sales_bonus_uzs),
        sales_gate_pct: num(body.sales_gate_pct),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["operators-list-all"] });
      setEditModal(null);
      toast.success(t("op_edit.saved"));
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : t("op_edit.save_failed"));
    },
  });

  const setPlan = useMutation({
    mutationFn: ({ id, target_amount }: { id: number; target_amount: string }) =>
      api.put(`/operators/${id}/plan/`, { target_amount }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      setPlanModal(null);
      setPlanInput("");
      toast.success(t("op_detail.plan_updated"));
    },
  });

  const rows: OperatorRow[] = ops.data?.results || [];

  const filtered = useMemo(() => {
    let out = rows;
    if (statusFilter === "active") {
      out = out.filter((o) => o.status === "active" || o.status === "trainee");
    } else if (statusFilter === "inactive") {
      out = out.filter((o) => o.status === "inactive");
    }
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      out = out.filter(
        (o) =>
          o.full_name.toLowerCase().includes(s) ||
          (o.phone || "").toLowerCase().includes(s),
      );
    }
    return out;
  }, [rows, statusFilter, search]);

  const selected = useMemo(
    () => filtered.find((o) => o.id === selectedId) || null,
    [filtered, selectedId],
  );

  const totalCount = rows.length;

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Toolbar */}
      <section className="flex flex-wrap items-center gap-3 animate-nfFadeUp">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            className="nf-input pl-11"
            placeholder={t("operators.search_ph")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {STATUS_TABS.map((tab) => (
            <Chip
              key={tab.key}
              active={statusFilter === tab.key}
              onClick={() => setStatusFilter(tab.key)}
            >
              {tab.label}
            </Chip>
          ))}
        </div>
        {isManager && (
          <div className="ml-auto">
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="w-3.5 h-3.5" /> {t("operators.add_op")}
            </Button>
          </div>
        )}
      </section>

      {/* Two-column */}
      <section className="grid gap-5" style={{ gridTemplateColumns: "1.15fr 1fr" }}>
        {/* Left: list */}
        <div className="nf-card overflow-hidden">
          {ops.isLoading ? (
            <div className="text-center text-muted py-14 text-[13px]">{t("common.loading")}</div>
          ) : filtered.length === 0 ? (
            <div className="text-center text-muted py-14 text-[13px]">
              {rows.length === 0 ? t("operators.empty") : t("operators.no_matches")}
            </div>
          ) : (
            <ul className="flex flex-col">
              {filtered.map((o, i) => {
                const isSelected = selectedId === o.id;
                const inactive = o.status === "inactive";
                const monthTotal = Number(o.month_total ?? o.plan_actual ?? 0);
                const monthCount = o.month_count ?? 0;
                return (
                  <li
                    key={o.id}
                    onClick={() => setSelectedId(o.id)}
                    className="grid gap-3 items-center cursor-pointer animate-nfFadeUp"
                    style={{
                      gridTemplateColumns: "36px 1fr auto",
                      padding: "12px 18px",
                      borderTop: i === 0 ? undefined : "1px solid var(--border)",
                      background: isSelected ? "var(--faint)" : undefined,
                      opacity: inactive ? 0.55 : 1,
                      transition: "background 200ms cubic-bezier(.2,.7,.2,1)",
                      animationDelay: `${0.02 + i * 0.035}s`,
                    }}
                  >
                    <div
                      className="grid place-items-center font-semibold text-[12px]"
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 13,
                        background: isSelected ? "var(--accent-grad)" : "var(--faint2)",
                        color: isSelected ? "#fff" : "var(--muted)",
                      }}
                    >
                      {initials(o.full_name)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="text-[14.5px] font-medium truncate">
                          {o.full_name}
                        </span>
                        {o.sticker?.emoji && (
                          <span className="text-[15px] leading-none shrink-0">
                            {o.sticker.emoji}
                          </span>
                        )}
                        {isBirthdayToday(o.birth_date) && (
                          <span
                            className="text-[15px] leading-none shrink-0"
                            title={t("birthday.list_badge_title")}
                            aria-label={t("birthday.list_badge_title")}
                          >
                            🎂
                          </span>
                        )}
                        {/* «Забыл выйти» бейдж — красный при ≥5 за 30
                            дней (см. FORGOTTEN_ALERT_THRESHOLD), серый
                            при 1-4. При 0 скрыт, чтобы не шумел. */}
                        {(() => {
                          const n = o.forgotten_checkouts_count ?? 0;
                          if (n <= 0) return null;
                          const isAlert = n >= FORGOTTEN_ALERT_THRESHOLD;
                          return (
                            <span
                              title={t("operators.forgotten_tooltip", { n })}
                              className="shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
                              style={{
                                background: isAlert
                                  ? "rgba(220,38,38,.12)"
                                  : "rgba(148,163,184,.15)",
                                color: isAlert ? "#dc2626" : "var(--muted)",
                              }}
                            >
                              {isAlert ? "⚠ " : ""}
                              {t("operators.forgotten_badge", { n })}
                            </span>
                          );
                        })()}
                      </div>
                      <div className="text-[12px] text-muted truncate">
                        {o.phone || t("leads.no_phone")}
                        {o.hired_at && <> · {t("op_detail.since", { date: fmtDate(o.hired_at) })}</>}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[14px] font-semibold tabular-nums">
                        {formatUZS(monthTotal)}
                      </div>
                      <div className="text-[11.5px] text-muted tabular-nums">
                        {t("op_detail.sales_count", { n: monthCount })}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Right: sticky preview */}
        <div style={{ position: "sticky", top: 100, alignSelf: "flex-start" }}>
          {selected ? (
            <Card padded className="animate-nfFadeUp">
              <div className="flex items-start gap-3">
                <div
                  className="grid place-items-center text-white font-semibold text-[16px] shrink-0"
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 16,
                    background: "var(--accent-grad)",
                  }}
                >
                  {initials(selected.full_name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[19px] font-semibold tracking-tight truncate flex items-center gap-2">
                    <span className="truncate">{selected.full_name}</span>
                    {isBirthdayToday(selected.birth_date) && (
                      <span
                        title={t("birthday.list_badge_title")}
                        aria-label={t("birthday.list_badge_title")}
                        className="shrink-0"
                      >
                        🎂
                      </span>
                    )}
                  </div>
                  <div className="text-[13px] text-muted mt-0.5 truncate">
                    {selected.phone || t("leads.no_phone")}
                    {selected.birth_date && (
                      <>
                        {" · "}
                        {t("op_detail.birthday_manager_prefix")}{" "}
                        {new Date(selected.birth_date).toLocaleDateString("ru-RU", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                        })}
                      </>
                    )}
                  </div>
                  <div className="mt-2">
                    <StatusBadge tone={selected.status === "active" ? "hot" : "neutral"}>
                      {STATUS_LABEL[selected.status]}
                    </StatusBadge>
                  </div>
                </div>
              </div>

              <div
                className="grid gap-[13px] mt-5"
                style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
              >
                <div className="nf-tile" style={{ padding: "14px 16px" }}>
                  <div className="text-[11px] text-muted uppercase tracking-wide">{t("operators.tile_plan")}</div>
                  <div className="text-[18px] font-semibold tabular-nums mt-1">
                    {selected.plan_target ? formatUZS(Number(selected.plan_target)) : "—"}
                  </div>
                </div>
                <div className="nf-tile" style={{ padding: "14px 16px" }}>
                  <div className="text-[11px] text-muted uppercase tracking-wide">{t("operators.tile_done")}</div>
                  <div className="text-[18px] font-semibold tabular-nums mt-1">
                    {formatUZS(Number(selected.plan_actual || 0))}
                  </div>
                </div>
                <div className="nf-tile" style={{ padding: "14px 16px" }}>
                  <div className="text-[11px] text-muted uppercase tracking-wide">%</div>
                  <div className="text-[18px] font-semibold tabular-nums mt-1">
                    {selected.plan_target
                      ? `${Math.round(
                          (Number(selected.plan_actual || 0) / Number(selected.plan_target)) * 100,
                        )}%`
                      : "—"}
                  </div>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                <Button onClick={() => nav(`/operators/${selected.id}`)}>
                  {t("operators.open_card")}
                </Button>
                {isManager && (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setStickerModal({
                          id: selected.id,
                          emoji: selected.sticker?.emoji ?? null,
                          isRare: selected.sticker?.is_rare ?? false,
                        })
                      }
                    >
                      {t("op_detail.sticker")}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setEditModal({
                          id: selected.id,
                          full_name: selected.full_name,
                          phone: selected.phone || "",
                          hired_at: selected.hired_at || "",
                          birth_date: selected.birth_date || "",
                          note: (selected as any).note || "",
                          status: selected.status,
                          blocking_gate_enabled: !!selected.blocking_gate_enabled,
                          require_checkin_enabled: !!selected.require_checkin_enabled,
                          // Payroll overrides: null → "" (пустое поле в UI ⇔
                          // «использовать default из настроек»). Time-поля
                          // с backend'a приходят как "HH:MM:SS" — обрезаем
                          // до "HH:MM" для <input type="time">.
                          salary_uzs:
                            selected.salary_uzs != null
                              ? String(selected.salary_uzs)
                              : "",
                          shift_start:
                            selected.shift_start
                              ? selected.shift_start.slice(0, 5)
                              : "",
                          shift_end:
                            selected.shift_end
                              ? selected.shift_end.slice(0, 5)
                              : "",
                          grace_period_min:
                            selected.grace_period_min != null
                              ? String(selected.grace_period_min)
                              : "",
                          late_penalty_uzs:
                            selected.late_penalty_uzs != null
                              ? String(selected.late_penalty_uzs)
                              : "",
                          weekly_day_off:
                            selected.weekly_day_off != null
                              ? String(selected.weekly_day_off)
                              : "",
                          weekly_free_absences:
                            selected.weekly_free_absences != null
                              ? String(selected.weekly_free_absences)
                              : "",
                          attendance_bonus_uzs:
                            selected.attendance_bonus_uzs != null
                              ? String(selected.attendance_bonus_uzs)
                              : "",
                          sales_bonus_uzs:
                            selected.sales_bonus_uzs != null
                              ? String(selected.sales_bonus_uzs)
                              : "",
                          sales_gate_pct:
                            selected.sales_gate_pct != null
                              ? String(selected.sales_gate_pct)
                              : "",
                        })
                      }
                    >
                      {t("common.edit")}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setPlanModal({
                          id: selected.id,
                          name: selected.full_name,
                          current: selected.plan_target,
                        });
                        setPlanInput(
                          selected.plan_target
                            ? String(Math.round(Number(selected.plan_target)))
                            : "",
                        );
                      }}
                    >
                      {t("operators.tile_plan")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        toggle.mutate({ id: selected.id, active: selected.status === "inactive" })
                      }
                    >
                      {selected.status === "inactive" ? t("op_detail.activate") : t("op_detail.deactivate")}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        setDeleteError("");
                        setConfirmDelete({ id: selected.id, name: selected.full_name });
                      }}
                    >
                      {t("common.delete")}
                    </Button>
                  </>
                )}
              </div>
            </Card>
          ) : (
            <Card padded className="animate-nfFadeUp">
              <div className="text-center py-6">
                <div className="text-[14px] font-medium">{t("operators.pick_op")}</div>
                <div className="text-[12.5px] text-muted mt-1.5">
                  {totalCount === 1 ? t("operators.team_count_one", { n: totalCount }) : t("operators.team_count_many", { n: totalCount })}
                </div>
              </div>
            </Card>
          )}
        </div>
      </section>

      {/* Edit operator modal */}
      <Modal open={!!editModal} onClose={() => setEditModal(null)} width={560}>
        {editModal && (
          <div className="p-7 space-y-4">
            <div className="text-[18px] font-semibold tracking-tight">
              {t("op_edit.title")}
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("op_edit.full_name")}</div>
              <input
                className="nf-input"
                value={editModal.full_name}
                onChange={(e) => setEditModal({ ...editModal, full_name: e.target.value })}
                autoFocus
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("op_edit.phone")}</div>
              <PhoneInput
                value={editModal.phone}
                onChange={(v) => setEditModal({ ...editModal, phone: v })}
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("op_edit.hired_at")}</div>
              <DateInput
                value={editModal.hired_at ? editModal.hired_at.slice(0, 10) : ""}
                onChange={(v) => setEditModal({ ...editModal, hired_at: v })}
                ariaLabel={t("op_edit.hired_at")}
                allowClear
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">
                {t("op_edit.birth_date")}
                <span className="ml-1 text-muted" style={{ fontWeight: 400 }}>
                  · {t("op_edit.birth_date_hint")}
                </span>
              </div>
              <DateInput
                value={editModal.birth_date ? editModal.birth_date.slice(0, 10) : ""}
                onChange={(v) => setEditModal({ ...editModal, birth_date: v })}
                ariaLabel={t("op_edit.birth_date")}
                allowClear
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("op_edit.status")}</div>
              <Select<OperatorStatus>
                value={editModal.status}
                onChange={(v) => setEditModal({ ...editModal, status: v })}
                options={[
                  { value: "active", label: t("op_edit.status_active") },
                  { value: "trainee", label: t("op_edit.status_trainee") },
                  { value: "inactive", label: t("op_edit.status_inactive") },
                ]}
                ariaLabel={t("op_edit.status")}
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("op_edit.note")}</div>
              <textarea
                className="nf-input"
                rows={2}
                value={editModal.note}
                onChange={(e) => setEditModal({ ...editModal, note: e.target.value })}
              />
            </div>
            {/* Per-operator morning-gate opt-in (2026-08-16).
                Обычно OFF (prod-безопасно) → оператор получает лидов
                без блокировки. ON — используется для тестирования UX
                блокировки на demo-стенде. */}
            <label
              className="flex items-start gap-3 rounded-xl px-3 py-3 cursor-pointer"
              style={{
                border: "1.5px solid var(--border)",
                background: editModal.blocking_gate_enabled
                  ? "rgba(220,38,38,0.05)"
                  : "var(--bg-card)",
              }}
            >
              <input
                type="checkbox"
                className="mt-0.5 shrink-0 h-4 w-4 accent-red-600"
                checked={editModal.blocking_gate_enabled}
                onChange={(e) =>
                  setEditModal({
                    ...editModal,
                    blocking_gate_enabled: e.target.checked,
                  })
                }
              />
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-semibold">
                  {t("op_edit.blocking_gate")}
                </div>
                <div className="text-[12px] text-muted mt-0.5 leading-snug">
                  {t("op_edit.blocking_gate_hint")}
                </div>
              </div>
            </label>
            {/* Per-operator check-in gate opt-in (2026-08-26 enforcement wave).
                OFF по умолчанию: UI-гейт «Отметьтесь чтобы работать» не
                показывается. ON — фронт блокирует рабочие экраны до
                check-in. Backend API остаётся открытым в любом случае. */}
            <label
              className="flex items-start gap-3 rounded-xl px-3 py-3 cursor-pointer"
              style={{
                border: "1.5px solid var(--border)",
                background: editModal.require_checkin_enabled
                  ? "rgba(22,163,74,0.05)"
                  : "var(--bg-card)",
              }}
            >
              <input
                type="checkbox"
                className="mt-0.5 shrink-0 h-4 w-4 accent-green-600"
                checked={editModal.require_checkin_enabled}
                onChange={(e) =>
                  setEditModal({
                    ...editModal,
                    require_checkin_enabled: e.target.checked,
                  })
                }
              />
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-semibold">
                  {t("op_edit.require_checkin")}
                </div>
                <div className="text-[12px] text-muted mt-0.5 leading-snug">
                  {t("op_edit.require_checkin_hint")}
                </div>
              </div>
            </label>
            {/* 2026-08-31 Payroll overrides: оклад / график / grace /
                штраф / выходной / free-absences. Все поля опциональные —
                пусто ⇒ backend возьмёт default из AttendanceSettings.
                Секция вынесена под заголовок чтобы не смешивать с общими
                полями редактирования оператора. */}
            <div className="pt-2">
              <div
                className="text-[13px] font-semibold tracking-tight mb-2"
                style={{
                  color: "var(--text)",
                  borderTop: "1px solid var(--border)",
                  paddingTop: 14,
                }}
              >
                {t("operator_form.section_salary")}
              </div>
              <div className="text-[11.5px] text-muted mb-3">
                {t("operator_form.section_salary_hint")}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="nf-col mb-1.5">
                    {t("operator_form.attendance_bonus_uzs")}
                  </div>
                  <input
                    className="nf-input"
                    inputMode="numeric"
                    placeholder="1 500 000"
                    value={editModal.attendance_bonus_uzs || editModal.salary_uzs}
                    onChange={(e) =>
                      setEditModal({
                        ...editModal,
                        attendance_bonus_uzs: e.target.value.replace(/[^\d]/g, ""),
                        // Синхронизируем legacy alias'ом, чтобы старые
                        // читатели тоже видели актуальное значение (см.
                        // resolve_operator_config fallback).
                        salary_uzs: e.target.value.replace(/[^\d]/g, ""),
                      })
                    }
                  />
                </div>
                <div>
                  <div className="nf-col mb-1.5">
                    {t("operator_form.sales_bonus_uzs")}
                  </div>
                  <input
                    className="nf-input"
                    inputMode="numeric"
                    placeholder="1 500 000"
                    value={editModal.sales_bonus_uzs}
                    onChange={(e) =>
                      setEditModal({
                        ...editModal,
                        sales_bonus_uzs: e.target.value.replace(/[^\d]/g, ""),
                      })
                    }
                  />
                </div>
                <div>
                  <div className="nf-col mb-1.5">
                    {t("operator_form.sales_gate_pct")}
                  </div>
                  <input
                    className="nf-input"
                    inputMode="numeric"
                    placeholder="85"
                    value={editModal.sales_gate_pct}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/[^\d]/g, "");
                      const clamped = raw === "" ? "" : String(Math.min(100, Math.max(0, Number(raw))));
                      setEditModal({ ...editModal, sales_gate_pct: clamped });
                    }}
                  />
                </div>
                <div>
                  <div className="nf-col mb-1.5">
                    {t("operator_form.shift_start")}
                  </div>
                  <input
                    className="nf-input"
                    type="time"
                    value={editModal.shift_start}
                    onChange={(e) =>
                      setEditModal({ ...editModal, shift_start: e.target.value })
                    }
                  />
                </div>
                <div>
                  <div className="nf-col mb-1.5">
                    {t("operator_form.shift_end")}
                  </div>
                  <input
                    className="nf-input"
                    type="time"
                    value={editModal.shift_end}
                    onChange={(e) =>
                      setEditModal({ ...editModal, shift_end: e.target.value })
                    }
                  />
                </div>
                <div>
                  <div className="nf-col mb-1.5">
                    {t("operator_form.grace_period_min")}
                  </div>
                  <input
                    className="nf-input"
                    inputMode="numeric"
                    placeholder="20"
                    value={editModal.grace_period_min}
                    onChange={(e) =>
                      setEditModal({
                        ...editModal,
                        grace_period_min: e.target.value.replace(/[^\d]/g, ""),
                      })
                    }
                  />
                </div>
                <div>
                  <div className="nf-col mb-1.5">
                    {t("operator_form.late_penalty_uzs")}
                  </div>
                  <input
                    className="nf-input"
                    inputMode="numeric"
                    placeholder="50 000"
                    value={editModal.late_penalty_uzs}
                    onChange={(e) =>
                      setEditModal({
                        ...editModal,
                        late_penalty_uzs: e.target.value.replace(/[^\d]/g, ""),
                      })
                    }
                  />
                </div>
                <div>
                  <div className="nf-col mb-1.5">
                    {t("operator_form.weekly_day_off")}
                  </div>
                  {/* Native select с placeholder-опцией "" — это ОК, потому
                      что backend принимает null; при выборе пустого числовое
                      значение станет null в mutation. */}
                  <select
                    className="nf-input"
                    value={editModal.weekly_day_off}
                    onChange={(e) =>
                      setEditModal({
                        ...editModal,
                        weekly_day_off: e.target.value,
                      })
                    }
                  >
                    <option value="">
                      {t("operator_form.weekly_day_off_default")}
                    </option>
                    <option value="0">{t("weekday.mon")}</option>
                    <option value="1">{t("weekday.tue")}</option>
                    <option value="2">{t("weekday.wed")}</option>
                    <option value="3">{t("weekday.thu")}</option>
                    <option value="4">{t("weekday.fri")}</option>
                    <option value="5">{t("weekday.sat")}</option>
                    <option value="6">{t("weekday.sun")}</option>
                  </select>
                </div>
                <div>
                  <div className="nf-col mb-1.5">
                    {t("operator_form.weekly_free_absences")}
                  </div>
                  <input
                    className="nf-input"
                    inputMode="numeric"
                    placeholder="1"
                    value={editModal.weekly_free_absences}
                    onChange={(e) =>
                      setEditModal({
                        ...editModal,
                        weekly_free_absences: e.target.value.replace(
                          /[^\d]/g,
                          "",
                        ),
                      })
                    }
                  />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditModal(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => editModal && editOp.mutate(editModal)}
                disabled={editOp.isPending || !editModal.full_name.trim()}
              >
                {editOp.isPending ? t("common.loading") : t("common.save")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Plan modal */}
      <Modal open={!!planModal} onClose={() => setPlanModal(null)} width={420}>
        {planModal && (
          <div className="p-7">
            <div className="text-[18px] font-semibold tracking-tight">{t("operators.plan_month_title")}</div>
            <div className="text-[13px] text-muted mt-1">{planModal.name}</div>
            <div className="mt-5">
              <div className="nf-col mb-1.5">{t("operators.plan_goal")}</div>
              <NumericInput
                className="nf-input"
                value={planInput}
                onChange={setPlanInput}
                placeholder={t("operators.plan_goal_ph")}
                autoFocus
              />
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setPlanModal(null)}>{t("common.cancel")}</Button>
              <Button
                onClick={() => setPlan.mutate({ id: planModal.id, target_amount: planInput })}
                disabled={!planInput || setPlan.isPending}
              >
                {setPlan.isPending ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!confirmDelete} onClose={() => { setConfirmDelete(null); setDeleteError(""); }} width={460}>
        {confirmDelete && (
          <div className="p-7">
            <div className="text-[18px] font-semibold tracking-tight">{t("op_detail.delete")}</div>
            <div className="text-[13px] text-muted mt-2">
              {t("operators.delete_hint_prefix")} <span className="text-text font-medium">{confirmDelete.name}</span>{t("operators.delete_hint_suffix")}
            </div>
            {deleteError && (
              <div
                className="mt-3 text-[13px] rounded-xl px-3.5 py-2.5"
                style={{
                  background: "rgba(220,60,40,.08)",
                  color: "var(--danger)",
                  border: "1px solid rgba(220,60,40,.2)",
                }}
              >
                {deleteError}
              </div>
            )}
            <div className="mt-6 flex gap-2 justify-end">
              <Button
                variant="ghost"
                onClick={() => { setConfirmDelete(null); setDeleteError(""); }}
                disabled={remove.isPending}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={() => remove.mutate(confirmDelete.id)}
                disabled={remove.isPending}
              >
                {remove.isPending ? t("common.deleting") : t("common.delete")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Sticker picker */}
      {stickerModal && (
        <StickerPicker
          operatorId={stickerModal.id}
          currentEmoji={stickerModal.emoji}
          currentIsRare={stickerModal.isRare}
          adminMode
          onChanged={() => qc.invalidateQueries({ queryKey: ["operators"] })}
          onClose={() => setStickerModal(null)}
        />
      )}

      {/* Create modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} width={460}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(form);
          }}
          className="p-7"
        >
          <div className="text-[18px] font-semibold tracking-tight">{t("operators.new_op")}</div>
          <div className="mt-5 flex flex-col gap-4">
            <div>
              <div className="nf-col mb-1.5">{t("operators.full_name")}</div>
              <input
                className="nf-input"
                required
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("common.phone")}</div>
              <PhoneInput
                value={form.phone}
                onChange={(v) => setForm({ ...form, phone: v })}
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("common.status")}</div>
              <Select<OperatorStatus>
                value={form.status}
                onChange={(v) => setForm({ ...form, status: v })}
                options={[
                  { value: "active", label: t("op_detail.status_active") },
                  { value: "trainee", label: t("op_detail.status_trainee") },
                  { value: "inactive", label: t("op_detail.status_inactive") },
                ]}
                ariaLabel={t("common.status")}
              />
            </div>
          </div>
          <div className="mt-6 flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "…" : t("common.save")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
