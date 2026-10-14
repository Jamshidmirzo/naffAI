import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Cake,
  Camera,
  CheckCircle2,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  Star,
  Target,
} from "lucide-react";
import { toast } from "../../components/ui";
import { useAuth } from "../../store/auth";
import { useLang } from "../../store/lang";
import { isManagerLevel, isSuperManager } from "../../components/RoleGate";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum, useConfirm } from "../ui";
import {
  opErrorText,
  opIsPinRequired,
  useOpAvatarUpload,
  useOpBulkReassign,
  useOpClearSticker,
  useOpCreate,
  useOpDelete,
  useOpDiagnostics,
  useOpManagers,
  useOpPatch,
  useOpPause,
  useOpResetPassword,
  useOpRevealPassword,
  useOpSetPlan,
  useOpSetSticker,
  useOpSnapshotRequest,
  useOpStickerPalette,
  useOpToggleActive,
  useOpVerifyPin,
  useOperatorsFloor,
  useOperatorsList,
  type OpDiagFilter,
  type OpFloorRow,
  type OpManagerUser,
  type OpStatus,
  type OperatorListRow,
} from "../api/team/operators";

type StatusFilter = "all" | "active" | "inactive";
/** "all" | "unassigned" (managed_by IS NULL) | manager user id. */
type ManagerFilter = "all" | "unassigned" | number;
type SortKey = "sum" | "name";

const K = "v2.team.operators.";
/** «Забыл» badge turns red at 5 auto-closed shifts in 30 days. */
const FORGOTTEN_ALERT_THRESHOLD = 5;
const TZ = "Asia/Tashkent";

// ── helpers ─────────────────────────────────────────────────────────

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

/** Day+month match; 29 Feb is celebrated on 28 Feb in non-leap years (same as backend). */
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
  const yr = today.getFullYear();
  const isLeap = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
  return bdM === 2 && bdD === 29 && !isLeap && tM === 2 && tD === 28;
}

/** Personal schedule = any shift field overridden (money fields don't count). */
function hasPersonalSchedule(o: OperatorListRow): boolean {
  return !!o.shift_start || !!o.shift_end || o.weekly_day_off != null || o.grace_period_min != null || o.weekly_free_absences != null;
}

/** ISO date (YYYY-MM-DD or datetime) → dd.mm.yyyy. */
function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("ru-RU", { timeZone: TZ });
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

/** «04:22» — time since check-in. */
function elapsed(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60000);
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function digitsOnly(v: string) {
  return v.replace(/[^\d]/g, "");
}

function pct(o: OperatorListRow): number | null {
  const target = Number(o.plan_target || 0);
  if (!target) return null;
  return Math.round((Number(o.plan_actual || 0) / target) * 100);
}

function monthSum(o: OperatorListRow): number {
  return Number(o.month_total ?? o.plan_actual ?? 0) || 0;
}

type T = ReturnType<typeof useT2>;

function shiftOf(t: T, o: OperatorListRow, f: OpFloorRow | undefined): { text: string; tone: string; dot?: string } | null {
  if (o.status === "inactive") return { text: t(K + "shift.fired"), tone: "" };
  if (!f) return o.is_paused ? { text: t(K + "shift.pause"), tone: "b-warn", dot: "pause" } : null;
  switch (f.state) {
    case "call":
      return { text: elapsed(f.checked_in_at) || t(K + "shift.call"), tone: "b-info", dot: "call" };
    case "wait":
      return { text: elapsed(f.checked_in_at) || t(K + "shift.on"), tone: "b-ok", dot: "on" };
    case "pause":
      return { text: t(K + "shift.pause"), tone: "b-warn", dot: "pause" };
    case "late":
      return { text: t(K + "shift.late"), tone: "b-bad", dot: "late" };
    case "absent":
      return { text: t(K + "shift.absent"), tone: "", dot: "off" };
    case "dayoff":
      return { text: t(K + "shift.dayoff"), tone: "", dot: "off" };
    default:
      return { text: t(K + "shift.off"), tone: "", dot: "off" };
  }
}

function monthName(t: T) {
  const list = t(K + "months").split(",");
  return list[new Date().getMonth()] ?? "";
}

// ── phone field: «+998» prefix + 9 digits, emits canonical +998XXXXXXXXX ──

function toDigits9(raw: string): string {
  const d = raw.replace(/\D+/g, "");
  return (d.startsWith("998") ? d.slice(3) : d).slice(0, 9);
}

function formatDigits9(d: string) {
  return [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean).join(" ");
}

function phoneIncomplete(v: string) {
  const d = toDigits9(v);
  return d.length > 0 && d.length < 9;
}

function PhoneField({ id, label, value, onChange }: { id: string; label: ReactNode; value: string; onChange: (v: string) => void }) {
  const t = useT2();
  const bad = phoneIncomplete(value);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row g8">
        <span className="pfx" style={{ height: 40, fontSize: 14, borderRadius: 9 }} aria-hidden="true">+998</span>
        <input
          className={cx("input num grow", bad && "is-bad")}
          id={id}
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          placeholder="90 123 45 67"
          value={formatDigits9(toDigits9(value))}
          onChange={(e) => {
            const d = toDigits9(e.target.value);
            onChange(d ? `+998${d}` : "");
          }}
        />
      </div>
      {bad ? <span className="err">{t(K + "phone_9")}</span> : null}
    </div>
  );
}

function Switch({ on, onClick, label, disabled }: { on: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button className={cx("switch", on && "is-on")} type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={disabled}>
      <i />
    </button>
  );
}

// ── page ────────────────────────────────────────────────────────────

export function OperatorsPage({ scope }: { scope: "manager" | "super" }) {
  const t = useT2();
  const nav = useNavigate();
  const role = useAuth((s) => s.role);
  const canManage = isManagerLevel(role);
  const isSuper = scope === "super";
  const confirm = useConfirm();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [managerFilter, setManagerFilter] = useState<ManagerFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "sum", desc: true });
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [editRow, setEditRow] = useState<OperatorListRow | null>(null);
  const [planRow, setPlanRow] = useState<OperatorListRow | null>(null);
  const [stickerRow, setStickerRow] = useState<OperatorListRow | null>(null);
  const [pinPrompt, setPinPrompt] = useState<{ id: number; active: boolean; name: string } | null>(null);
  const [diag, setDiag] = useState<{ open: boolean; operatorId: number | null }>({ open: false, operatorId: null });
  const [secret, setSecret] = useState<{ name: string; password: string; issued: boolean } | null>(null);

  const ops = useOperatorsList();
  const managersQ = useOpManagers(isSuper);
  const managers: OpManagerUser[] = Array.isArray(managersQ.data) ? managersQ.data : [];
  const floorQ = useOperatorsFloor(canManage);
  const floor = floorQ.data ?? null;
  const floorById = useMemo(() => {
    const m = new Map<number, OpFloorRow>();
    for (const r of floor?.operators ?? []) m.set(r.id, r);
    return m;
  }, [floor]);
  const hasFloor = !!floor;

  const toggle = useOpToggleActive();
  const pauseMut = useOpPause();
  const snapshotReq = useOpSnapshotRequest();
  const avatarUpload = useOpAvatarUpload();
  const remove = useOpDelete();
  const patch = useOpPatch();
  const reveal = useOpRevealPassword();
  const resetPw = useOpResetPassword();

  const rows: OperatorListRow[] = ops.data ?? [];

  const counts = useMemo(() => {
    let active = 0;
    let fired = 0;
    let unassigned = 0;
    for (const o of rows) {
      if (o.status === "inactive") fired++;
      else active++;
      if (o.managed_by_id == null) unassigned++;
    }
    return { all: rows.length, active, fired, unassigned };
  }, [rows]);

  const filtered = useMemo(() => {
    let out = rows;
    if (statusFilter === "active") out = out.filter((o) => o.status === "active" || o.status === "trainee");
    else if (statusFilter === "inactive") out = out.filter((o) => o.status === "inactive");
    if (isSuper && managerFilter !== "all") {
      out = managerFilter === "unassigned" ? out.filter((o) => o.managed_by_id == null) : out.filter((o) => o.managed_by_id === managerFilter);
    }
    const s = search.trim().toLowerCase();
    if (s) out = out.filter((o) => o.full_name.toLowerCase().includes(s) || (o.phone || "").toLowerCase().includes(s));
    const sorted = [...out];
    sorted.sort((a, b) => {
      // fired operators always sink to the bottom
      if ((a.status === "inactive") !== (b.status === "inactive")) return a.status === "inactive" ? 1 : -1;
      const r = sort.key === "name" ? a.full_name.localeCompare(b.full_name, "ru") : monthSum(a) - monthSum(b);
      return sort.desc ? -r : r;
    });
    return sorted;
  }, [rows, statusFilter, isSuper, managerFilter, search, sort]);

  const selected = useMemo(() => rows.find((o) => o.id === selectedId) ?? null, [rows, selectedId]);

  const managerName = (id: number | null | undefined) => {
    if (id == null) return t(K + "no_manager");
    const m = managers.find((x) => x.id === id);
    return m ? m.full_name || m.username : "—";
  };

  const setSortKey = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key === "sum" }));

  // ── actions ─────────────────────────────────────────────
  const runToggle = (vars: { id: number; active: boolean; name: string }) =>
    toggle.mutate(
      { id: vars.id, active: vars.active },
      {
        onSuccess: (data) => {
          const n = data?.rebalanced_count ?? 0;
          if (!vars.active && n > 0) toast.success(t("operators.deactivated_with_rebalance", { n }));
          else if (vars.active && n > 0) toast.success(t("operators.activated_with_rebalance", { n }));
          else toast.success(t("operators.status_updated"));
        },
        onError: (err) => {
          if (opIsPinRequired(err)) {
            setPinPrompt(vars);
            return;
          }
          toast.error(opErrorText(err, t("operators.status_update_failed")));
        },
      },
    );

  const onToggleActive = async (o: OperatorListRow) => {
    const activate = o.status === "inactive";
    if (!activate) {
      const ok = await confirm({
        title: t(K + "deactivate_title"),
        body: t(K + "deactivate_body", { name: o.full_name }),
        confirm: t("op_detail.deactivate"),
        danger: true,
      });
      if (!ok) return;
    }
    runToggle({ id: o.id, active: activate, name: o.full_name });
  };

  const onPause = (o: OperatorListRow) =>
    pauseMut.mutate(
      { id: o.id, paused: !o.is_paused },
      {
        onSuccess: (_d, v) => toast.success(v.paused ? t("operators.paused_toast") : t("operators.unpaused_toast")),
        onError: (err) => toast.error(opErrorText(err, t("operators.status_update_failed"))),
      },
    );

  const onSnapshot = (o: OperatorListRow) =>
    snapshotReq.mutate(o.id, {
      onSuccess: () => toast.success(t(K + "snapshot_sent")),
      onError: (err) => toast.error(opErrorText(err, t(K + "snapshot_failed"))),
    });

  const onAvatar = (o: OperatorListRow, file: File) =>
    avatarUpload.mutate(
      { id: o.id, file },
      {
        onSuccess: () => toast.success(t(K + "avatar_done")),
        onError: () => toast.error(t(K + "avatar_failed")),
      },
    );

  const onDelete = async (o: OperatorListRow) => {
    const reason = await confirm({
      title: t("op_detail.delete"),
      body: (
        <>
          {t("operators.delete_hint_prefix")} <b className="w6" style={{ color: "var(--ink)" }}>{o.full_name}</b>
          {t("operators.delete_hint_suffix")}
        </>
      ),
      confirm: t("common.delete"),
      danger: true,
      reason: { label: t("op_detail.delete_comment_label"), minLength: 10, placeholder: t("op_detail.delete_comment_placeholder") },
    });
    if (typeof reason !== "string" || reason.length < 10) return;
    remove.mutate(
      { id: o.id, comment: reason },
      {
        onSuccess: () => {
          if (selectedId === o.id) setSelectedId(null);
          toast.success(t("op_detail.delete_done"));
        },
        onError: (err) => toast.error(opErrorText(err, t("operators.op_delete_failed"))),
      },
    );
  };

  const onFlag = (o: OperatorListRow, field: "livestream_enabled" | "require_checkin_enabled", value: boolean) =>
    patch.mutate(
      { id: o.id, body: { [field]: value } },
      {
        onSuccess: () => toast.success(t("op_edit.saved")),
        onError: (err) => toast.error(opErrorText(err, t("op_edit.save_failed"))),
      },
    );

  const onReveal = (o: OperatorListRow) =>
    reveal.mutate(o.id, {
      onSuccess: (d) => setSecret({ name: o.full_name, password: d.password, issued: false }),
      onError: (err) => toast.error(opErrorText(err, t(K + "pw_failed"))),
    });

  const onResetPw = async (o: OperatorListRow) => {
    const ok = await confirm({
      title: t(K + "pw_reset_title"),
      body: t(K + "pw_reset_body", { name: o.full_name }),
      confirm: t(K + "pw_reset_go"),
    });
    if (!ok) return;
    resetPw.mutate(o.id, {
      onSuccess: (d) => setSecret({ name: o.full_name, password: d.password, issued: true }),
      onError: (err) => toast.error(opErrorText(err, t(K + "pw_failed"))),
    });
  };

  // ── layout ──────────────────────────────────────────────
  const cols = isSuper
    ? hasFloor
      ? "minmax(0, 2.1fr) minmax(0, 0.9fr) 84px 108px 96px"
      : "minmax(0, 2.1fr) minmax(0, 0.9fr) 108px 96px"
    : hasFloor
      ? "minmax(0, 2.4fr) 96px 118px 130px"
      : "minmax(0, 2.4fr) 118px 130px";

  const sortIcon = (key: SortKey) =>
    sort.key === key ? sort.desc ? <ArrowDown className="ic ic-s" /> : <ArrowUp className="ic ic-s" /> : null;

  let listBody: ReactNode;
  if (ops.isLoading) listBody = <LoadingBlock rows={8} onRetry={() => ops.refetch()} />;
  else if (ops.isError) listBody = <ErrorState error={ops.error} onRetry={() => ops.refetch()} />;
  else if (filtered.length === 0)
    listBody = (
      <EmptyState
        title={rows.length === 0 ? t("operators.empty") : t("operators.no_matches")}
        body={rows.length === 0 ? t(K + "empty_body") : t(K + "no_matches_body")}
        action={
          rows.length === 0 && canManage ? (
            <button className="btn btn-pri" type="button" onClick={() => setShowCreate(true)}>
              <Plus className="ic" />
              {t("operators.add_op")}
            </button>
          ) : null
        }
      />
    );
  else
    listBody = (
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: isSuper ? 680 : 600 }}>
          <div className="tr th" style={{ gridTemplateColumns: cols }}>
            <button className={cx("th-s", sort.key === "name" && "is-on")} type="button" onClick={() => setSortKey("name")}>
              {t(K + "col_operator")}
              {sortIcon("name")}
            </button>
            {isSuper ? <span>{t(K + "col_manager")}</span> : null}
            {hasFloor ? <span>{t(K + "col_shift")}</span> : null}
            <button className={cx("th-s r", sort.key === "sum" && "is-on")} type="button" onClick={() => setSortKey("sum")}>
              {t(K + "col_sum")}
              {sortIcon("sum")}
            </button>
            <span>{t(K + "col_plan")}</span>
          </div>
          {filtered.map((o) => {
            const f = floorById.get(o.id);
            const sh = shiftOf(t, o, f);
            const p = pct(o);
            const forgot = o.forgotten_checkouts_count ?? 0;
            const personal = hasPersonalSchedule(o);
            const trainee = o.status === "trainee";
            const tags = forgot > 0 || !!o.is_paused || personal || trainee;
            const inactive = o.status === "inactive";
            return (
              <div
                key={o.id}
                className={cx("tr", selectedId === o.id && "is-sel")}
                style={{ gridTemplateColumns: cols, minHeight: 60, opacity: inactive ? 0.55 : o.is_paused ? 0.85 : 1, cursor: "pointer" }}
                role="button"
                tabIndex={0}
                aria-pressed={selectedId === o.id}
                onClick={() => setSelectedId(o.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedId(o.id);
                  }
                }}
                onDoubleClick={() => nav(`/operators/${o.id}`)}
              >
                <span className="row g8" style={{ minWidth: 0, alignItems: "flex-start" }}>
                  {o.avatar_url ? (
                    <span className="ava" data-s={sh?.dot} style={{ marginTop: 2, overflow: "visible" }}>
                      <img src={o.avatar_url} alt="" style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }} />
                    </span>
                  ) : (
                    <span className="ava" data-s={sh?.dot} style={{ marginTop: 2 }}>{initials(o.full_name)}</span>
                  )}
                  <span className="col g4" style={{ minWidth: 0 }}>
                    <span className="row g6" style={{ minWidth: 0 }}>
                      <span className="w6 trunc">{o.full_name}</span>
                      {o.sticker?.emoji ? (
                        <span className="badge b-warn" style={{ height: 20, padding: "0 5px" }} title={t("op_detail.sticker")}>
                          {o.sticker.emoji}
                        </span>
                      ) : null}
                      {isBirthdayToday(o.birth_date) ? (
                        <span className="badge b-hot" style={{ height: 20, padding: "0 5px" }} title={t("birthday.list_badge_title")} aria-label={t("birthday.list_badge_title")}>
                          <Cake className="ic ic-s" />
                        </span>
                      ) : null}
                    </span>
                    <span className="xs c3 num trunc">
                      {o.phone || t("leads.no_phone")}
                      {o.hired_at ? ` · ${t("op_detail.since", { date: fmtDay(o.hired_at) })}` : ""}
                    </span>
                    {tags ? (
                      <span className="row g4" style={{ overflow: "hidden", flexWrap: "wrap" }}>
                        {forgot > 0 ? (
                          <span className={cx("badge", forgot >= FORGOTTEN_ALERT_THRESHOLD && "b-bad")} style={{ height: 20 }} title={t("operators.forgotten_tooltip", { n: forgot })}>
                            {t("operators.forgotten_badge", { n: forgot })}
                          </span>
                        ) : null}
                        {o.is_paused ? (
                          <span className="badge b-warn" style={{ height: 20 }} title={t("operators.paused_badge_title")}>
                            <Pause className="ic ic-s" />
                            {t("operators.paused_badge_label")}
                          </span>
                        ) : null}
                        {trainee ? <span className="badge" style={{ height: 20 }}>{t(K + "trainee")}</span> : null}
                        {personal ? (
                          <span className="badge b-info" style={{ height: 20 }} title={t("op_schedule.badge_tooltip")}>
                            {t(K + "personal")}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                </span>
                {isSuper ? <span className="s c2 trunc">{managerName(o.managed_by_id)}</span> : null}
                {hasFloor ? (
                  <span>{sh ? <span className={cx("badge num", sh.tone)}>{sh.text}</span> : <span className="c3">—</span>}</span>
                ) : null}
                <span className="col r" style={{ alignItems: "flex-end" }}>
                  <span className="num w6">{fmtNum(monthSum(o))}</span>
                  {o.month_count != null ? <span className="xs c3">{t("op_detail.sales_count", { n: o.month_count })}</span> : null}
                </span>
                <span className="row g8">
                  <span className="bar grow">
                    <i className={p == null ? undefined : p >= 85 ? "ok" : p >= 60 ? "warn" : "bad"} style={{ width: `${Math.min(p ?? 0, 100)}%` }} />
                  </span>
                  <span className="num xs w6" style={{ width: 38 }}>{p == null ? "—" : `${p}%`}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );

  return (
    <>
      <PageHeader title={isSuper ? t(K + "title_super") : t("operators.title")} meta={t("operators.subtitle")}>
        <div className="inwrap" style={{ width: 220, maxWidth: "100%" }}>
          <Search className="ic" />
          <input className="input" type="search" placeholder={t("operators.search_ph")} aria-label={t(K + "search_aria")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {isSuper ? (
          <select
            className="input"
            aria-label={t("operators.filter_manager_label")}
            style={{ width: 180 }}
            value={managerFilter === "all" ? "all" : managerFilter === "unassigned" ? "unassigned" : String(managerFilter)}
            onChange={(e) => {
              const v = e.target.value;
              setManagerFilter(v === "all" ? "all" : v === "unassigned" ? "unassigned" : Number(v));
            }}
          >
            <option value="all">{t("operators.filter_manager_all")}</option>
            <option value="unassigned">{t("operators.filter_manager_unassigned")}</option>
            {managers.map((m) => (
              <option key={m.id} value={String(m.id)}>{m.full_name || m.username}</option>
            ))}
          </select>
        ) : null}
        {canManage ? (
          <>
            <button className="btn" type="button" onClick={() => setDiag({ open: true, operatorId: null })}>
              <Activity className="ic" />
              {t(K + "diag")}
            </button>
            <button className="btn btn-pri" type="button" onClick={() => setShowCreate(true)}>
              <Plus className="ic" />
              {t("operators.add_op")}
            </button>
          </>
        ) : null}
      </PageHeader>

      <main className="page" style={{ gap: 16 }}>
        <div className="row g8 wrap">
          <button className={cx("chip", statusFilter === "all" && "is-on")} type="button" onClick={() => setStatusFilter("all")}>
            {t("common.all")} <span className="n">{counts.all}</span>
          </button>
          <button className={cx("chip", statusFilter === "active" && "is-on")} type="button" onClick={() => setStatusFilter("active")}>
            {t("operators.tab_active")} <span className="n">{counts.active}</span>
          </button>
          <button className={cx("chip", statusFilter === "inactive" && "is-on")} type="button" onClick={() => setStatusFilter("inactive")}>
            {t("operators.tab_fired")} <span className="n">{counts.fired}</span>
          </button>
          {isSuper ? (
            <>
              <span className="hr" style={{ width: 1, height: 22, margin: "0 4px" }} />
              <button
                className={cx("chip", managerFilter === "unassigned" && "is-on")}
                type="button"
                onClick={() => setManagerFilter((m) => (m === "unassigned" ? "all" : "unassigned"))}
              >
                {t("operators.filter_manager_unassigned")} <span className="n">{counts.unassigned}</span>
              </button>
              <Link className="chip" to="/team/deleted-operators">{t(K + "deleted")}</Link>
            </>
          ) : null}
          <span className="grow" />
          <span className="xs c3">{t(K + "sum_period", { month: monthName(t) })}</span>
        </div>

        <div className="split">
          <section className="list card tbl" style={{ overflow: "hidden" }}>{listBody}</section>

          <aside className="panel card col" style={{ flex: "0 1 400px", position: "sticky", top: 16 }}>
            {selected ? (
              <SidePanel
                o={selected}
                f={floorById.get(selected.id)}
                pinVerified={!!floor?.pin_verified}
                canManage={canManage}
                busy={{ pause: pauseMut.isPending, snapshot: snapshotReq.isPending, avatar: avatarUpload.isPending, toggle: toggle.isPending, patch: patch.isPending, pw: reveal.isPending || resetPw.isPending }}
                onOpen={() => nav(`/operators/${selected.id}`)}
                onSticker={() => setStickerRow(selected)}
                onEdit={() => setEditRow(selected)}
                onPlan={() => setPlanRow(selected)}
                onDiag={() => setDiag({ open: true, operatorId: selected.id })}
                onSnapshot={() => onSnapshot(selected)}
                onAvatar={(file) => onAvatar(selected, file)}
                onPause={() => onPause(selected)}
                onToggleActive={() => onToggleActive(selected)}
                onDelete={() => onDelete(selected)}
                onFlag={(field, v) => onFlag(selected, field, v)}
                onReveal={() => onReveal(selected)}
                onResetPw={() => onResetPw(selected)}
              />
            ) : (
              <EmptyState
                icon={<Target className="ic ic-l" />}
                title={t("operators.pick_op")}
                body={counts.all === 1 ? t("operators.team_count_one", { n: counts.all }) : t("operators.team_count_many", { n: counts.all })}
              />
            )}
          </aside>
        </div>
      </main>

      {showCreate ? <CreateDialog isSuper={isSuper} managers={managers} onClose={() => setShowCreate(false)} /> : null}
      {editRow ? <EditDialog o={editRow} onClose={() => setEditRow(null)} /> : null}
      {planRow ? <PlanDialog o={planRow} onClose={() => setPlanRow(null)} /> : null}
      {stickerRow ? <StickerDialog o={stickerRow} onClose={() => setStickerRow(null)} /> : null}
      {pinPrompt ? (
        <PinDialog
          name={pinPrompt.name}
          onClose={() => setPinPrompt(null)}
          onVerified={() => {
            const v = pinPrompt;
            setPinPrompt(null);
            runToggle(v);
          }}
        />
      ) : null}
      {diag.open ? <DiagnosticsDialog initialOperatorId={diag.operatorId} onClose={() => setDiag({ open: false, operatorId: null })} /> : null}
      {secret ? <PasswordDialog {...secret} onClose={() => setSecret(null)} /> : null}
      {confirm.node}
    </>
  );
}

export default function Operators() {
  const role = useAuth((s) => s.role);
  // Same as the old page: the super-manager sees the manager filter on /operators too.
  return <OperatorsPage scope={isSuperManager(role) ? "super" : "manager"} />;
}

// ── side panel ──────────────────────────────────────────────────────

interface SidePanelProps {
  o: OperatorListRow;
  f: OpFloorRow | undefined;
  pinVerified: boolean;
  canManage: boolean;
  busy: { pause: boolean; snapshot: boolean; avatar: boolean; toggle: boolean; patch: boolean; pw: boolean };
  onOpen: () => void;
  onSticker: () => void;
  onEdit: () => void;
  onPlan: () => void;
  onDiag: () => void;
  onSnapshot: () => void;
  onAvatar: (f: File) => void;
  onPause: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onFlag: (field: "livestream_enabled" | "require_checkin_enabled", v: boolean) => void;
  onReveal: () => void;
  onResetPw: () => void;
}

function SidePanel(p: SidePanelProps) {
  const t = useT2();
  const { o, f } = p;
  const fileRef = useRef<HTMLInputElement>(null);
  const sh = shiftOf(t, o, f);
  const pc = pct(o);
  const inactive = o.status === "inactive";
  const statusLabel = o.status === "active" ? t("op_detail.status_active_lower") : o.status === "trainee" ? t(K + "trainee") : t("operators.status_inactive_lower");
  const acc = o.account;
  const hasAccount = !!acc?.has_account && !acc.deleted;

  return (
    <>
      <div className="row g16" style={{ padding: 20, alignItems: "flex-start" }}>
        {o.avatar_url ? (
          <img src={o.avatar_url} alt={t(K + "photo_alt")} style={{ width: 76, height: 76, borderRadius: 20, objectFit: "cover", flex: "none" }} />
        ) : (
          <span className="icon-tile display" style={{ width: 76, height: 76, borderRadius: 20, fontSize: 24, background: "var(--brand-soft)", color: "var(--brand-text)" }} aria-hidden="true">
            {initials(o.full_name)}
          </span>
        )}
        <div className="col g6 grow">
          <div className="row g6" style={{ minWidth: 0 }}>
            <h2 className="h2 trunc">{o.full_name}</h2>
            {o.sticker?.emoji ? <span className="badge b-warn" style={{ height: 20, padding: "0 5px" }} title={t("op_detail.sticker")}>{o.sticker.emoji}</span> : null}
            {isBirthdayToday(o.birth_date) ? (
              <span className="badge b-hot" style={{ height: 20, padding: "0 5px" }} title={t("birthday.list_badge_title")}>
                <Cake className="ic ic-s" />
              </span>
            ) : null}
          </div>
          <span className="num s c2">
            {o.phone || t("leads.no_phone")}
            {o.birth_date ? ` · ${t("op_detail.birthday_manager_prefix")} ${fmtDay(o.birth_date)}` : ""}
          </span>
          <div className="row g6 wrap">
            <span className={cx("badge", o.status === "active" ? "b-hot" : "")}>{statusLabel}</span>
            {o.is_paused ? (
              <span className="badge b-warn" title={t("operators.paused_badge_title")}>
                <Pause className="ic ic-s" />
                {t("operators.paused_badge_label")}
              </span>
            ) : null}
            {f && sh && !inactive && sh.dot !== "pause" ? (
              <span className={cx("badge", sh.tone)}>
                {sh.dot === "on" || sh.dot === "call" ? <i className="dot" /> : null}
                {sh.dot === "on" || sh.dot === "call" ? (f.checked_in_at ? <>{t(K + "on_shift")} <span className="num">{elapsed(f.checked_in_at)}</span></> : t(K + "shift.on")) : sh.text}
              </span>
            ) : null}
            {o.hired_at ? <span className="badge">{t("op_detail.since", { date: fmtDay(o.hired_at) })}</span> : null}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, padding: "0 20px 16px" }}>
        <div className="well col g4"><span className="lbl">{t("operators.tile_plan")}</span><span className="num w6" style={{ fontSize: 13 }}>{o.plan_target ? fmtNum(o.plan_target) : "—"}</span></div>
        <div className="well col g4"><span className="lbl">{t("operators.tile_done")}</span><span className="num w6" style={{ fontSize: 13 }}>{fmtNum(Number(o.plan_actual || 0))}</span></div>
        <div className="well col g4">
          <span className="lbl">%</span>
          <span className="num w6" style={{ fontSize: 13, color: pc == null ? undefined : pc >= 85 ? "var(--ok)" : pc >= 60 ? "var(--warn)" : "var(--bad)" }}>{pc == null ? "—" : `${pc}%`}</span>
        </div>
      </div>

      <div className="row g8 wrap" style={{ padding: "0 20px 16px" }}>
        <button className="btn btn-sm btn-pri" type="button" onClick={p.onOpen}>{t("operators.open_card")}</button>
        {p.canManage ? (
          <>
            <button className="btn btn-sm" type="button" onClick={p.onSticker}><Star className="ic" />{t("op_detail.sticker")}</button>
            <button className="btn btn-sm" type="button" onClick={p.onEdit}><Pencil className="ic" />{t("common.edit")}</button>
            <button className="btn btn-sm" type="button" onClick={p.onPlan}><Target className="ic" />{t("operators.tile_plan")}</button>
            <button className="btn btn-sm" type="button" onClick={p.onDiag}><Activity className="ic" />{t(K + "diag")}</button>
            <button className="btn btn-sm" type="button" onClick={p.onSnapshot} disabled={p.busy.snapshot} title={t(K + "snapshot_title")}>
              <Camera className="ic" />
              {t(K + "snapshot")}
            </button>
            <button className="btn btn-sm" type="button" onClick={() => fileRef.current?.click()} disabled={p.busy.avatar} title={t(K + "avatar_title")}>
              <ImageIcon className="ic" />
              {t(K + "avatar")}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) p.onAvatar(file);
                e.target.value = "";
              }}
            />
            {!inactive ? (
              <button className="btn btn-sm" type="button" onClick={p.onPause} disabled={p.busy.pause}>
                {o.is_paused ? <Play className="ic" /> : <Pause className="ic" />}
                {o.is_paused ? t(K + "unpause") : t(K + "pause")}
              </button>
            ) : null}
          </>
        ) : null}
      </div>

      {f ? (
        <>
          <hr className="hr" />
          <div className="col g8" style={{ padding: "16px 20px" }}>
            <span className="lbl">{t(K + "today")}</span>
            <div className="row between s"><span className="c3">{t(K + "today_working")}</span><span className="num">{f.working_count} / {f.quota}</span></div>
            <div className="row between s"><span className="c3">{t(K + "today_sales")}</span><span className="num">{f.sales_today}</span></div>
            {f.overdue_callbacks > 0 ? (
              <div className="row between s"><span className="c3">{t(K + "today_overdue")}</span><span className="num c-bad w6">{f.overdue_callbacks}</span></div>
            ) : null}
            {p.pinVerified ? (
              <div className="row between s">
                <span className="c3">{t(K + "today_checkin")}</span>
                <span className="num">
                  {f.checked_in_at
                    ? f.late_minutes
                      ? t(K + "checkin_late", { time: fmtTime(f.checked_in_at), n: f.late_minutes })
                      : t(K + "checkin_ok", { time: fmtTime(f.checked_in_at) })
                    : f.state === "dayoff"
                      ? t(K + "shift.dayoff")
                      : t(K + "checkin_none")}
                </span>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {p.canManage ? (
        <>
          <hr className="hr" />
          <div className="col g8" style={{ padding: "16px 20px" }}>
            <span className="lbl">{t(K + "account")}</span>
            {hasAccount ? (
              <>
                <div className="row between s">
                  <span className="c3">{t(K + "login")}</span>
                  <span className="row g6">
                    <span className="num">{acc?.username || "—"}</span>
                    {!acc?.is_active ? <span className="badge b-bad" style={{ height: 20 }}>{t(K + "account_blocked")}</span> : null}
                  </span>
                </div>
                <div className="row g8">
                  <button className="btn btn-sm grow" type="button" onClick={p.onReveal} disabled={p.busy.pw}>{t(K + "pw_show")}</button>
                  <button className="btn btn-sm grow" type="button" onClick={p.onResetPw} disabled={p.busy.pw}>{t(K + "pw_new")}</button>
                </div>
              </>
            ) : (
              <div className="row between s">
                <span className="c3">{acc?.deleted ? t(K + "account_deleted") : t(K + "account_none")}</span>
                <button className="btn btn-sm" type="button" onClick={p.onOpen}>{t(K + "account_setup")}</button>
              </div>
            )}
            <div className="row between s" style={{ marginTop: 6 }}>
              <span className="c3">{t(K + "live")}</span>
              <Switch on={!!o.livestream_enabled} disabled={p.busy.patch} label={t(K + "live")} onClick={() => p.onFlag("livestream_enabled", !o.livestream_enabled)} />
            </div>
            <div className="row between s">
              <span className="c3">{t(K + "require_checkin")}</span>
              <Switch on={!!o.require_checkin_enabled} disabled={p.busy.patch} label={t(K + "require_checkin")} onClick={() => p.onFlag("require_checkin_enabled", !o.require_checkin_enabled)} />
            </div>
          </div>
          <hr className="hr" />
          <div className="row g8" style={{ padding: "14px 20px 18px" }}>
            <button className="btn btn-sm" type="button" onClick={p.onToggleActive} disabled={p.busy.toggle}>
              {inactive ? t("op_detail.activate") : t("op_detail.deactivate")}
            </button>
            <span className="grow" />
            <button className="btn btn-sm btn-bad" type="button" onClick={p.onDelete}>{t("common.delete")}</button>
          </div>
        </>
      ) : null}
    </>
  );
}

// ── dialogs ─────────────────────────────────────────────────────────

function StatusSeg({ value, onChange }: { value: OpStatus; onChange: (v: OpStatus) => void }) {
  const t = useT2();
  const opts: { v: OpStatus; l: string }[] = [
    { v: "active", l: t("op_edit.status_active") },
    { v: "trainee", l: t("op_edit.status_trainee") },
    { v: "inactive", l: t("op_edit.status_inactive") },
  ];
  return (
    <div className="seg seg-lg" role="radiogroup" aria-label={t("op_edit.status")}>
      {opts.map((x) => (
        <button key={x.v} className={cx(value === x.v && "is-on")} type="button" role="radio" aria-checked={value === x.v} onClick={() => onChange(x.v)}>
          {x.l}
        </button>
      ))}
    </div>
  );
}

function CreateDialog({ isSuper, managers, onClose }: { isSuper: boolean; managers: OpManagerUser[]; onClose: () => void }) {
  const t = useT2();
  const create = useOpCreate();
  const [form, setForm] = useState<{ full_name: string; phone: string; status: OpStatus; note: string; managed_by_id: number | null }>({
    full_name: "",
    phone: "",
    status: "active",
    note: "",
    managed_by_id: null,
  });
  const invalid = !form.full_name.trim() || phoneIncomplete(form.phone);
  const submit = () => {
    if (invalid) return;
    // A plain manager gets managed_by=self on the server; only the super-manager sends the choice.
    const { managed_by_id, ...rest } = form;
    create.mutate(isSuper ? { ...rest, managed_by_id } : rest, {
      onSuccess: () => {
        toast.success(t("operators.op_added"));
        onClose();
      },
      onError: (err) => toast.error(opErrorText(err, t("operators.op_add_failed"))),
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("operators.new_op")}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" disabled={invalid || create.isPending} onClick={submit}>
            {create.isPending ? t("common.saving") : t(K + "add")}
          </button>
        </>
      }
    >
      <form
        className="col g12"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="field">
          <label htmlFor="op-new-name">{t("operators.full_name")} *</label>
          <input className="input" id="op-new-name" type="text" required autoFocus value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </div>
        <PhoneField id="op-new-phone" label={t("common.phone")} value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
        <div className="field">
          <label>{t("common.status")}</label>
          <StatusSeg value={form.status} onChange={(v) => setForm({ ...form, status: v })} />
        </div>
        {isSuper ? (
          <div className="field">
            <label htmlFor="op-new-mgr">{t("operators.assign_manager")}</label>
            <select
              className="input"
              id="op-new-mgr"
              value={form.managed_by_id == null ? "" : String(form.managed_by_id)}
              onChange={(e) => setForm({ ...form, managed_by_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">{t("operators.assign_manager_none")}</option>
              {managers.map((m) => (
                <option key={m.id} value={String(m.id)}>{m.full_name || m.username}</option>
              ))}
            </select>
          </div>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

interface EditForm {
  full_name: string;
  phone: string;
  hired_at: string;
  birth_date: string;
  note: string;
  status: OpStatus;
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
}

const s = (v: unknown) => (v == null ? "" : String(v));

function toEditForm(o: OperatorListRow): EditForm {
  // Decimal strings like "1500000.00" → integer text for the inputs.
  const money = (v: string | null | undefined) => (v == null || v === "" ? "" : String(Math.round(Number(v)) || v));
  return {
    full_name: o.full_name,
    phone: o.phone || "",
    hired_at: o.hired_at ? o.hired_at.slice(0, 10) : "",
    birth_date: o.birth_date ? o.birth_date.slice(0, 10) : "",
    note: o.note || "",
    status: o.status,
    blocking_gate_enabled: !!o.blocking_gate_enabled,
    require_checkin_enabled: !!o.require_checkin_enabled,
    salary_uzs: money(o.salary_uzs),
    shift_start: o.shift_start ? o.shift_start.slice(0, 5) : "",
    shift_end: o.shift_end ? o.shift_end.slice(0, 5) : "",
    grace_period_min: s(o.grace_period_min),
    late_penalty_uzs: money(o.late_penalty_uzs),
    weekly_day_off: s(o.weekly_day_off),
    weekly_free_absences: s(o.weekly_free_absences),
    attendance_bonus_uzs: money(o.attendance_bonus_uzs),
    sales_bonus_uzs: money(o.sales_bonus_uzs),
    sales_gate_pct: s(o.sales_gate_pct),
  };
}

function EditDialog({ o, onClose }: { o: OperatorListRow; onClose: () => void }) {
  const t = useT2();
  const patch = useOpPatch();
  const [f, setF] = useState<EditForm>(() => toEditForm(o));
  const set = (p: Partial<EditForm>) => setF((x) => ({ ...x, ...p }));
  const invalid = !f.full_name.trim() || phoneIncomplete(f.phone);

  const save = () => {
    if (invalid) return;
    // Empty → null: the server falls back to AttendanceSettings defaults.
    const num = (v: string): number | null => {
      const x = v.trim();
      if (!x) return null;
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    };
    const str = (v: string): string | null => (v.trim() ? v.trim() : null);
    patch.mutate(
      {
        id: o.id,
        body: {
          full_name: f.full_name,
          phone: f.phone || null,
          hired_at: f.hired_at || null,
          birth_date: f.birth_date || null,
          note: f.note || "",
          status: f.status,
          blocking_gate_enabled: f.blocking_gate_enabled,
          require_checkin_enabled: f.require_checkin_enabled,
          salary_uzs: num(f.salary_uzs),
          shift_start: str(f.shift_start),
          shift_end: str(f.shift_end),
          grace_period_min: num(f.grace_period_min),
          late_penalty_uzs: num(f.late_penalty_uzs),
          weekly_day_off: num(f.weekly_day_off),
          weekly_free_absences: num(f.weekly_free_absences),
          attendance_bonus_uzs: num(f.attendance_bonus_uzs),
          sales_bonus_uzs: num(f.sales_bonus_uzs),
          sales_gate_pct: num(f.sales_gate_pct),
        },
      },
      {
        onSuccess: () => {
          toast.success(t("op_edit.saved"));
          onClose();
        },
        onError: (err) => toast.error(opErrorText(err, t("op_edit.save_failed"))),
      },
    );
  };

  const moneyInput = (id: string, label: string, key: keyof EditForm, ph: string, onSet?: (v: string) => Partial<EditForm>) => (
    <div className="field grow">
      <label htmlFor={id}>{label}</label>
      <input
        className="input num"
        id={id}
        inputMode="numeric"
        placeholder={ph}
        value={f[key] as string}
        onChange={(e) => {
          const v = digitsOnly(e.target.value);
          set(onSet ? onSet(v) : ({ [key]: v } as Partial<EditForm>));
        }}
      />
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      width={880}
      title={t("op_edit.title")}
      sub={o.full_name}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" onClick={save} disabled={invalid || patch.isPending}>
            {patch.isPending ? t("common.saving") : t("common.save")}
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "14px 24px", alignItems: "start" }}>
        <div className="col g12">
          <div className="field">
            <label htmlFor="op-e-name">{t("op_edit.full_name")} *</label>
            <input className="input" id="op-e-name" type="text" autoFocus value={f.full_name} onChange={(e) => set({ full_name: e.target.value })} />
          </div>
          <PhoneField id="op-e-phone" label={t("op_edit.phone")} value={f.phone} onChange={(v) => set({ phone: v })} />
          <div className="row g8" style={{ alignItems: "flex-start" }}>
            <div className="field grow">
              <label htmlFor="op-e-hired">{t("op_edit.hired_at")}</label>
              <input className="input num" id="op-e-hired" type="date" value={f.hired_at} onChange={(e) => set({ hired_at: e.target.value })} />
            </div>
            <div className="field grow">
              <label htmlFor="op-e-bd">{t("op_edit.birth_date")}</label>
              <input className="input num" id="op-e-bd" type="date" value={f.birth_date} onChange={(e) => set({ birth_date: e.target.value })} />
              <span className="hint">{t("op_edit.birth_date_hint")}</span>
            </div>
          </div>
          <div className="field">
            <label>{t("op_edit.status")}</label>
            <StatusSeg value={f.status} onChange={(v) => set({ status: v })} />
          </div>
          <div className="field">
            <label htmlFor="op-e-note">{t("op_edit.note")}</label>
            <textarea className="input" id="op-e-note" rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} />
          </div>
          <div className="well row g12" style={{ alignItems: "flex-start" }}>
            <span style={{ marginTop: 2 }}>
              <Switch on={f.blocking_gate_enabled} label={t("op_edit.blocking_gate")} onClick={() => set({ blocking_gate_enabled: !f.blocking_gate_enabled })} />
            </span>
            <div className="col g4">
              <span className="s w6">{t("op_edit.blocking_gate")}</span>
              <span className="hint">{t("op_edit.blocking_gate_hint")}</span>
            </div>
          </div>
          <div className="well row g12" style={{ alignItems: "flex-start" }}>
            <span style={{ marginTop: 2 }}>
              <Switch on={f.require_checkin_enabled} label={t("op_edit.require_checkin")} onClick={() => set({ require_checkin_enabled: !f.require_checkin_enabled })} />
            </span>
            <div className="col g4">
              <span className="s w6">{t("op_edit.require_checkin")}</span>
              <span className="hint">{t("op_edit.require_checkin_hint")}</span>
            </div>
          </div>
        </div>

        <div className="col g12">
          <div className="col g4">
            <span className="lbl">{t("operator_form.section_salary")}</span>
            <span className="hint">{t("operator_form.section_salary_hint")}</span>
          </div>
          <div className="row g8" style={{ alignItems: "flex-start" }}>
            {/* attendance bonus keeps the legacy salary_uzs alias in sync (resolve_operator_config fallback) */}
            <div className="field grow">
              <label htmlFor="op-e-att">{t("operator_form.attendance_bonus_uzs")}</label>
              <input
                className="input num"
                id="op-e-att"
                inputMode="numeric"
                placeholder="1 500 000"
                value={f.attendance_bonus_uzs || f.salary_uzs}
                onChange={(e) => {
                  const v = digitsOnly(e.target.value);
                  set({ attendance_bonus_uzs: v, salary_uzs: v });
                }}
              />
            </div>
            {moneyInput("op-e-sb", t("operator_form.sales_bonus_uzs"), "sales_bonus_uzs", "1 500 000")}
          </div>
          <div className="field" style={{ width: "50%" }}>
            <label htmlFor="op-e-gate">{t("operator_form.sales_gate_pct")}</label>
            <input
              className="input num"
              id="op-e-gate"
              inputMode="numeric"
              placeholder="85"
              value={f.sales_gate_pct}
              onChange={(e) => {
                const raw = digitsOnly(e.target.value);
                set({ sales_gate_pct: raw === "" ? "" : String(Math.min(100, Math.max(0, Number(raw)))) });
              }}
            />
            <span className="hint">{t(K + "gate_hint")}</span>
          </div>
          <hr className="hr" style={{ margin: "4px 0" }} />
          <div className="col g4">
            <span className="lbl">{t("op_schedule.section_title")}</span>
            <span className="hint">{t("op_schedule.section_hint")}</span>
          </div>
          <div className="row g8">
            <div className="field grow">
              <label htmlFor="op-e-ss">{t("operator_form.shift_start")}</label>
              <input className="input num" id="op-e-ss" type="time" value={f.shift_start} onChange={(e) => set({ shift_start: e.target.value })} />
            </div>
            <div className="field grow">
              <label htmlFor="op-e-se">{t("operator_form.shift_end")}</label>
              <input className="input num" id="op-e-se" type="time" value={f.shift_end} onChange={(e) => set({ shift_end: e.target.value })} />
            </div>
          </div>
          <div className="row g8" style={{ alignItems: "flex-start" }}>
            {moneyInput("op-e-grace", t("operator_form.grace_period_min"), "grace_period_min", "20")}
            {moneyInput("op-e-pen", t("operator_form.late_penalty_uzs"), "late_penalty_uzs", "50 000")}
          </div>
          <div className="row g8" style={{ alignItems: "flex-end" }}>
            <div className="field grow">
              <label htmlFor="op-e-dow">{t("operator_form.weekly_day_off")}</label>
              <select className="input" id="op-e-dow" value={f.weekly_day_off} onChange={(e) => set({ weekly_day_off: e.target.value })}>
                <option value="">{t("operator_form.weekly_day_off_default")}</option>
                {["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d, i) => (
                  <option key={d} value={String(i)}>{t(`weekday.${d}`)}</option>
                ))}
              </select>
            </div>
            {moneyInput("op-e-free", t("operator_form.weekly_free_absences"), "weekly_free_absences", "1")}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function PlanDialog({ o, onClose }: { o: OperatorListRow; onClose: () => void }) {
  const t = useT2();
  const setPlan = useOpSetPlan();
  const [value, setValue] = useState(o.plan_target ? String(Math.round(Number(o.plan_target))) : "");
  const save = () => {
    if (!value) return;
    setPlan.mutate(
      { id: o.id, target_amount: value },
      {
        onSuccess: () => {
          toast.success(t("op_detail.plan_updated"));
          onClose();
        },
        onError: (err) => toast.error(opErrorText(err, t(K + "plan_failed")), { action: { label: t("v2.state.retry"), onClick: save } }),
      },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={420}
      title={t("operators.plan_month_title")}
      sub={`${o.full_name} · ${monthName(t)}`}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" onClick={save} disabled={!value || setPlan.isPending}>
            {setPlan.isPending ? t("common.saving") : t("common.save")}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="field">
          <label htmlFor="op-plan">{t("operators.plan_goal")}</label>
          <input
            className="input num input-lg"
            id="op-plan"
            inputMode="numeric"
            autoFocus
            placeholder={t("operators.plan_goal_ph")}
            value={value ? fmtNum(value) : ""}
            onChange={(e) => setValue(digitsOnly(e.target.value))}
          />
        </div>
      </form>
    </Dialog>
  );
}

function StickerDialog({ o, onClose }: { o: OperatorListRow; onClose: () => void }) {
  const t = useT2();
  const currentEmoji = o.sticker?.emoji ?? null;
  const currentIsRare = !!o.sticker?.is_rare;
  const palette = useOpStickerPalette(true);
  const setSticker = useOpSetSticker();
  const clear = useOpClearSticker();
  const [rareMode, setRareMode] = useState(currentIsRare);
  const [rareEmoji, setRareEmoji] = useState(currentIsRare && currentEmoji ? currentEmoji : "");
  const [error, setError] = useState("");

  const taken = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of palette.data?.taken ?? []) m.set(x.emoji, x.operator_name);
    return m;
  }, [palette.data]);

  const apply = (emoji: string, is_rare: boolean) => {
    setError("");
    setSticker.mutate({ id: o.id, emoji, is_rare }, { onSuccess: onClose, onError: (e) => setError(opErrorText(e, t(K + "sticker_failed"))) });
  };

  return (
    <Dialog open onClose={onClose} width={520} title={t(K + "sticker_title")} sub={o.full_name}>
      <div className="seg seg-lg" role="radiogroup">
        <button className={cx(!rareMode && "is-on")} type="button" onClick={() => setRareMode(false)}>{t(K + "sticker_regular")}</button>
        <button className={cx(rareMode && "is-on")} type="button" onClick={() => setRareMode(true)}>{t(K + "sticker_rare")}</button>
      </div>
      {palette.isLoading ? (
        <LoadingBlock rows={3} />
      ) : palette.isError ? (
        <ErrorState error={palette.error} onRetry={() => palette.refetch()} />
      ) : rareMode ? (
        <div className="col g12">
          <div className="field">
            <label htmlFor="op-rare">{t(K + "sticker_rare_label")}</label>
            <input className="input input-lg" id="op-rare" style={{ textAlign: "center", fontSize: 24 }} value={rareEmoji} autoFocus onChange={(e) => setRareEmoji(e.target.value.slice(0, 4))} />
          </div>
          {palette.data?.rare && palette.data.rare.operator_id !== o.id ? (
            <div className="banner b-warn">
              <AlertTriangle className="ic" />
              <span>{t(K + "sticker_rare_taken", { emoji: palette.data.rare.emoji, name: palette.data.rare.operator_name })}</span>
            </div>
          ) : null}
          <button className="btn btn-pri" type="button" disabled={!rareEmoji || setSticker.isPending} onClick={() => apply(rareEmoji, true)}>
            {t(K + "sticker_rare_go")}
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(40px, 1fr))", gap: 6, maxHeight: 320, overflowY: "auto", padding: 2 }}>
            {(palette.data?.palette ?? []).map((emoji) => {
              const owner = taken.get(emoji);
              const isCurrent = emoji === currentEmoji;
              const disabled = !!owner && !isCurrent;
              return (
                <button
                  key={emoji}
                  type="button"
                  className={cx("btn", isCurrent && "pick-on")}
                  style={{ height: 40, width: "100%", padding: 0, fontSize: 22, opacity: disabled ? 0.3 : 1 }}
                  title={disabled ? t(K + "sticker_taken", { name: owner ?? "" }) : isCurrent ? t(K + "sticker_current") : t(K + "sticker_pick")}
                  disabled={disabled || setSticker.isPending}
                  onClick={() => apply(emoji, false)}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
          {currentEmoji ? (
            <button
              className="btn btn-bad"
              type="button"
              disabled={clear.isPending}
              onClick={() => clear.mutate(o.id, { onSuccess: onClose, onError: (e) => setError(opErrorText(e, t(K + "sticker_failed"))) })}
            >
              {t(K + "sticker_clear")}
            </button>
          ) : null}
        </>
      )}
      {error ? <span className="err">{error}</span> : null}
    </Dialog>
  );
}

function PinDialog({ name, onClose, onVerified }: { name: string; onClose: () => void; onVerified: () => void }) {
  const t = useT2();
  const verify = useOpVerifyPin();
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const submit = () => {
    setErr("");
    if (!/^\d{4}$/.test(pin)) {
      setErr(t(K + "pin_4"));
      return;
    }
    verify.mutate(pin, {
      onSuccess: () => {
        setPin("");
        onVerified();
      },
      onError: (e) => {
        setErr(opErrorText(e, t(K + "pin_bad")));
        setPin("");
      },
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={400}
      title={t(K + "pin_title")}
      sub={t(K + "pin_sub", { name })}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" onClick={submit} disabled={verify.isPending || pin.length !== 4}>
            {verify.isPending ? "…" : t(K + "pin_go")}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="field">
          <label htmlFor="op-pin">{t(K + "pin_label")}</label>
          <input
            className={cx("input num input-lg", err && "is-bad")}
            id="op-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            autoFocus
            placeholder="••••"
            style={{ letterSpacing: ".4em" }}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          />
          {err ? <span className="err">{err}</span> : null}
        </div>
      </form>
    </Dialog>
  );
}

/** One-time secret window: locked, closes only via «Готово». */
function PasswordDialog({ name, password, issued, onClose }: { name: string; password: string; issued: boolean; onClose: () => void }) {
  const t = useT2();
  const [handed, setHanded] = useState(!issued);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast.success(t("common.copied"));
    } catch {
      toast.error(t(K + "copy_failed"));
    }
  };
  return (
    <Dialog
      open
      locked
      onClose={onClose}
      width={420}
      title={issued ? t(K + "pw_new_title") : t(K + "pw_current_title")}
      sub={name}
      footer={
        <button className="btn btn-pri" type="button" disabled={!handed} onClick={onClose}>
          {t("common.done")}
        </button>
      }
    >
      <div className="well row between">
        <span className="num w6" style={{ fontSize: 17, wordBreak: "break-all" }}>{password}</span>
        <button className="btn btn-sm" type="button" onClick={copy}>
          <Copy className="ic" />
          {t("common.copy")}
        </button>
      </div>
      {issued ? (
        <label className="row g8 s">
          <input className="check" type="checkbox" checked={handed} onChange={(e) => setHanded(e.target.checked)} />
          {t(K + "pw_handed")}
        </label>
      ) : (
        <span className="hint">{t(K + "pw_audited")}</span>
      )}
    </Dialog>
  );
}

// ── distribution diagnostics ────────────────────────────────────────

function useAgo() {
  const t = useT2();
  return (iso: string | null | undefined) => {
    if (!iso) return t(K + "d.never");
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 10) return t(K + "d.just_now");
    if (sec < 60) return t(K + "d.sec_ago", { n: sec });
    const min = Math.floor(sec / 60);
    if (min < 60) return t(K + "d.min_ago", { n: min });
    const hr = Math.floor(min / 60);
    if (hr < 24) return t(K + "d.hour_ago", { n: hr });
    return t(K + "d.day_ago", { n: Math.floor(hr / 24) });
  };
}

function DiagnosticsDialog({ initialOperatorId, onClose }: { initialOperatorId: number | null; onClose: () => void }) {
  const t = useT2();
  const lang = useLang((x) => x.lang);
  const ago = useAgo();
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState<number | null>(initialOperatorId);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<OpDiagFilter>("all");
  const [tab, setTab] = useState<"yesterday" | "working" | "recent">("yesterday");

  const q = useOpDiagnostics(true, selectedId, search, filter);
  const pause = useOpPause();
  const patch = useOpPatch();
  const reassign = useOpBulkReassign();

  const summary = q.data?.summary;
  const operators = q.data?.operators ?? [];
  const detail = q.data?.selected_detail ?? null;

  useEffect(() => {
    if (selectedId == null && operators.length > 0) setSelectedId(operators[0].id);
  }, [operators, selectedId]);

  const effId = selectedId ?? operators[0]?.id ?? null;
  const op = operators.find((o) => o.id === effId) ?? detail?.operator ?? null;
  const uz = lang === "uz";
  const reasons = op ? (uz ? op.reasons_uz : op.reasons_ru) ?? [] : [];

  const onPause = () => {
    if (!op) return;
    pause.mutate(
      { id: op.id, paused: !op.is_paused },
      {
        onSuccess: (_d, v) => toast.success(v.paused ? t(K + "d.paused_toast") : t(K + "d.unpaused_toast")),
        onError: (e) => toast.error(opErrorText(e, t(K + "d.error"))),
      },
    );
  };
  const onGate = () => {
    if (!op) return;
    const enable = !op.blocking_gate_enabled;
    patch.mutate(
      { id: op.id, body: { blocking_gate_enabled: enable } },
      {
        onSuccess: () => toast.success(enable ? t(K + "d.gate_on_toast") : t(K + "d.gate_off_toast")),
        onError: (e) => toast.error(opErrorText(e, t(K + "d.error"))),
      },
    );
  };
  const onSpread = async () => {
    if (!op || !detail?.yesterday_leads.length) return;
    const ids = detail.yesterday_leads.map((l) => l.id);
    const ok = await confirm({
      title: t(K + "d.spread_title"),
      body: (
        <>
          <span className="c3">{op.full_name}</span>
          <br />
          {t(K + "d.spread_body", { n: ids.length })}
        </>
      ),
      confirm: t(K + "d.spread_go"),
    });
    if (!ok) return;
    reassign.mutate(
      { leadIds: ids },
      {
        onSuccess: (d) => toast.success(t(K + "d.spread_done", { n: d.total })),
        onError: (e) => toast.error(opErrorText(e, t(K + "d.spread_failed"))),
      },
    );
  };

  const kpis: { l: string; v: ReactNode; fg: string; bg: string }[] = summary
    ? [
        { l: t(K + "d.k_total"), v: summary.total_operators, fg: "--ink-2", bg: "--surface-2" },
        { l: t(K + "d.k_open"), v: summary.eligible_count, fg: "--ok", bg: "--ok-bg" },
        { l: t(K + "d.k_blocked"), v: summary.blocked_count, fg: "--bad", bg: "--bad-bg" },
        { l: t(K + "d.k_paused"), v: summary.paused_count, fg: "--warn", bg: "--warn-bg" },
        { l: t(K + "d.k_quota", { n: summary.rr_batch_size }), v: summary.quota_full_count, fg: "--hot", bg: "--hot-bg" },
        { l: t(K + "d.k_pool"), v: summary.orphans_count, fg: "--brand-text", bg: "--brand-soft" },
      ]
    : [];

  const leadRow = (l: { id: number; full_name: string; phone: string; label: string; ago: string; tone?: string }, key: number | string) => (
    <div key={key} className="well row between g8" style={{ padding: "8px 12px" }}>
      <div className="col g4" style={{ minWidth: 0 }}>
        <div className="row g8 s" style={{ minWidth: 0 }}>
          <span className="xs c3 num">#{l.id}</span>
          <span className="w6 trunc">{l.full_name || t(K + "d.client")}</span>
          {l.phone ? <span className="xs c3 num">{l.phone}</span> : null}
        </div>
        <div className="row g8 xs">
          <span className={cx("badge", l.tone)} style={{ height: 20 }}>{l.label}</span>
          <span className="c3">{l.ago}</span>
        </div>
      </div>
      <a className="btn btn-ghost btn-sq btn-sm" href={`/leads?search=${encodeURIComponent(l.phone || String(l.id))}`} target="_blank" rel="noreferrer" aria-label={t(K + "d.open_lead")} title={t(K + "d.open_lead")}>
        <ExternalLink className="ic" />
      </a>
    </div>
  );

  let right: ReactNode;
  if (!op) right = <EmptyState title={t(K + "d.pick")} />;
  else {
    const y = detail?.yesterday_leads ?? [];
    const w = detail?.working_leads ?? [];
    const r = detail?.recent_assignments ?? [];
    right = (
      <div className="col g12">
        <div className="card row between g12 wrap" style={{ padding: "12px 14px" }}>
          <div className="col g4" style={{ minWidth: 0 }}>
            <div className="row g8 wrap">
              <h3 className="h3">{op.full_name}</h3>
              <span className="xs c3 num">ID: {op.id}</span>
              {op.phone ? <span className="xs c3 num">{op.phone}</span> : null}
            </div>
            <span className="xs c3">
              {t(K + "d.last_lead")}: <b className="c2 w6">{ago(op.last_lead_assigned_at)}</b>
            </span>
          </div>
          <div className="row g6">
            <button className={cx("btn btn-sm", op.is_paused && "btn-pri")} type="button" onClick={onPause} disabled={pause.isPending}>
              {op.is_paused ? <Play className="ic" /> : <Pause className="ic" />}
              {op.is_paused ? t(K + "d.unpause") : t(K + "d.pause")}
            </button>
            <button className="btn btn-sm" type="button" onClick={onGate} disabled={patch.isPending} title={op.blocking_gate_enabled ? t(K + "d.gate_on_title") : t(K + "d.gate_off_title")}>
              {op.blocking_gate_enabled ? <ShieldAlert className="ic" /> : <Shield className="ic" />}
              {op.blocking_gate_enabled ? t(K + "d.gate_on") : t(K + "d.gate_off")}
            </button>
          </div>
        </div>

        <div className="banner" style={{ flexDirection: "column", gap: 6, background: op.eligible ? "var(--ok-bg)" : "var(--bad-bg)", color: op.eligible ? "var(--ok)" : "var(--bad)" }}>
          <div className="row g8 w7" style={{ fontSize: 14 }}>
            {op.eligible ? <CheckCircle2 className="ic" /> : <AlertTriangle className="ic" />}
            {op.eligible ? t(K + "d.open") : t(K + "d.blocked")}
          </div>
          {reasons.length ? (
            <div className="col g4 c2" style={{ paddingLeft: 26 }}>
              {reasons.map((x, i) => <span key={i}>• {x}</span>)}
            </div>
          ) : null}
          {op.yesterday_unclosed_count > 0 && !op.blocking_gate_enabled ? (
            <span className="xs c-warn" style={{ paddingLeft: 26 }}>{t(K + "d.note_nogate", { n: op.yesterday_unclosed_count })}</span>
          ) : null}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
          <div className="well col g4" style={{ padding: "10px 12px" }}><span className="xs c3">{t(K + "d.m_quota")}</span><span className="num w7">{op.working_count} / {op.quota_limit}</span></div>
          <div className="well col g4" style={{ padding: "10px 12px" }}><span className="xs c3">{t(K + "d.m_yesterday")}</span><span className={cx("num w7", op.yesterday_unclosed_count > 0 && "c-warn")}>{op.yesterday_unclosed_count}</span></div>
          <div className="well col g4" style={{ padding: "10px 12px" }}><span className="xs c3">{t(K + "d.m_today")}</span><span className="num w7">{op.today_received_count}</span></div>
          <div className="well col g4" style={{ padding: "10px 12px" }}><span className="xs c3">{t(K + "d.m_calls")}</span><span className="num w7">{op.today_calls_count}</span></div>
        </div>

        <div className="row between wrap" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="tabs" style={{ borderBottom: 0 }} role="tablist">
            <button className={cx("tab", tab === "yesterday" && "is-on")} type="button" role="tab" aria-selected={tab === "yesterday"} onClick={() => setTab("yesterday")}>
              {t(K + "d.t_yesterday")} <span className="num c3">{y.length}</span>
            </button>
            <button className={cx("tab", tab === "working" && "is-on")} type="button" role="tab" aria-selected={tab === "working"} onClick={() => setTab("working")}>
              {t(K + "d.t_working")} <span className="num c3">{w.length}</span>
            </button>
            <button className={cx("tab", tab === "recent" && "is-on")} type="button" role="tab" aria-selected={tab === "recent"} onClick={() => setTab("recent")}>
              {t(K + "d.t_recent")} <span className="num c3">{r.length}</span>
            </button>
          </div>
          {tab === "yesterday" && y.length ? (
            <button className="btn btn-sm" type="button" onClick={onSpread} disabled={reassign.isPending} title={t(K + "d.spread_hint")}>
              <RefreshCw className="ic" />
              {t(K + "d.spread")}
            </button>
          ) : null}
        </div>

        <div className="col g6" style={{ maxHeight: 280, overflowY: "auto" }}>
          {tab === "yesterday"
            ? y.length
              ? y.map((l) => leadRow({ id: l.id, full_name: l.full_name, phone: l.phone, label: (uz ? l.status_label_uz : l.status_label_ru) || l.status, ago: l.days_ago ? t(K + "d.days_ago", { n: l.days_ago }) : t(K + "d.yesterday") }, l.id))
              : <span className="xs c3" style={{ padding: 12, textAlign: "center" }}>{t(K + "d.e_yesterday")}</span>
            : null}
          {tab === "working"
            ? w.length
              ? w.map((l) => leadRow({ id: l.id, full_name: l.full_name, phone: l.phone, label: (uz ? l.status_label_uz : l.status_label_ru) || l.status, ago: l.hours_since_update ? t(K + "d.hours_ago", { n: l.hours_since_update }) : t(K + "d.recent"), tone: "b-info" }, l.id))
              : <span className="xs c3" style={{ padding: 12, textAlign: "center" }}>{t(K + "d.e_working")}</span>
            : null}
          {tab === "recent"
            ? r.length
              ? r.map((a) => leadRow({ id: a.lead_id, full_name: a.lead_name, phone: "", label: a.source, ago: ago(a.created_at) }, a.assignment_id))
              : <span className="xs c3" style={{ padding: 12, textAlign: "center" }}>{t(K + "d.e_recent")}</span>
            : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        width={1100}
        title={
          <span className="row g8 wrap">
            {t(K + "d.title")}
            <span className="badge b-ok"><i className="dot" />Real-time</span>
          </span>
        }
        sub={t(K + "d.sub")}
      >
        <div className="row g8 wrap" style={{ alignItems: "stretch" }}>
          <div className="grow" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
            {kpis.map((k) => (
              <div key={k.l} className="well col g4" style={{ alignItems: "center", textAlign: "center", padding: 10, background: `var(${k.bg})`, borderColor: "transparent" }}>
                <span className="xs w6" style={{ color: `var(${k.fg})` }}>{k.l}</span>
                <span className="num w7" style={{ fontSize: 18, color: `var(${k.fg})` }}>{k.v}</span>
              </div>
            ))}
          </div>
          <button className="btn btn-sm" type="button" onClick={() => q.refetch()} disabled={q.isFetching} title={t(K + "d.refresh")} aria-label={t(K + "d.refresh")}>
            <RefreshCw className={cx("ic", q.isFetching && "animate-spin")} />
            {t(K + "d.refresh")}
          </button>
        </div>

        {q.isError && !q.data ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <div className="row g16 wrap" style={{ alignItems: "flex-start" }}>
            <div className="col g8" style={{ flex: "5 1 300px", minWidth: 0 }}>
              <div className="inwrap">
                <Search className="ic" />
                <input className="input" type="search" placeholder={t(K + "d.search")} aria-label={t(K + "d.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <div className="row g6 wrap">
                <button className={cx("chip", filter === "all" && "is-on")} type="button" onClick={() => setFilter("all")}>{t("common.all")} <span className="n">{summary?.total_operators ?? operators.length}</span></button>
                <button className={cx("chip", filter === "blocked" && "is-on")} type="button" onClick={() => setFilter("blocked")}>{t(K + "d.f_blocked")} <span className="n">{summary?.blocked_count ?? 0}</span></button>
                <button className={cx("chip", filter === "paused" && "is-on")} type="button" onClick={() => setFilter("paused")}>{t(K + "d.f_paused")} <span className="n">{summary?.paused_count ?? 0}</span></button>
                <button className={cx("chip", filter === "eligible" && "is-on")} type="button" onClick={() => setFilter("eligible")}>{t(K + "d.f_open")} <span className="n">{summary?.eligible_count ?? 0}</span></button>
              </div>
              <div className="col g6" style={{ maxHeight: 480, overflowY: "auto", paddingRight: 2 }}>
                {q.isLoading ? (
                  <LoadingBlock rows={5} onRetry={() => q.refetch()} />
                ) : operators.length === 0 ? (
                  <span className="xs c3" style={{ padding: 16, textAlign: "center" }}>{t(K + "d.none")}</span>
                ) : (
                  operators.map((o) => {
                    const quotaFull = o.working_count >= o.quota_limit;
                    const badge = o.is_paused
                      ? { l: t(K + "d.b_paused"), tone: "b-warn" }
                      : o.eligible
                        ? { l: t(K + "d.b_open"), tone: "b-ok" }
                        : { l: quotaFull ? t(K + "d.b_quota", { a: o.working_count, b: o.quota_limit }) : (uz ? o.primary_blocker_title_uz : o.primary_blocker_title_ru) || t(K + "d.b_blocked"), tone: "b-bad" };
                    return (
                      <button
                        key={o.id}
                        type="button"
                        className={cx("well col g4", o.id === effId && "pick-on")}
                        style={{ padding: "9px 12px", background: "var(--surface)", textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer" }}
                        onClick={() => setSelectedId(o.id)}
                      >
                        <span className="row between g8" style={{ width: "100%" }}>
                          <span className="row g8" style={{ minWidth: 0 }}>
                            <i className="dot" style={{ width: 8, height: 8, color: o.eligible ? "var(--ok-solid)" : "var(--bad-solid)" }} />
                            <span className="w6 s trunc">{o.full_name}</span>
                          </span>
                          <span className={cx("badge", badge.tone)} style={{ height: 20 }}>{badge.l}</span>
                        </span>
                        <span className="row g12 xs c3" style={{ width: "100%" }}>
                          <span className="num">{t(K + "d.l_quota", { a: o.working_count, b: o.quota_limit })}</span>
                          {o.yesterday_unclosed_count > 0 ? <span className="c-warn w6 num">{t(K + "d.l_yesterday", { n: o.yesterday_unclosed_count })}</span> : null}
                          <span className="grow" />
                          <span className="num">{t(K + "d.l_today", { n: o.today_received_count })}</span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            <div style={{ flex: "7 1 380px", minWidth: 0 }}>{right}</div>
          </div>
        )}
      </Dialog>
      {confirm.node}
    </>
  );
}
