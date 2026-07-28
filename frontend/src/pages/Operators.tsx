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
  plan_target: string | null;
  plan_actual: string | null;
  sticker?: { emoji: string | null; is_rare: boolean } | null;
  account?: unknown;
  month_total?: string | number | null;
  month_count?: number | null;
}

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
      api.post(`/operators/${id}/${active ? "reactivate" : "deactivate"}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      toast.success(t("operators.status_updated"));
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
                  <div className="text-[19px] font-semibold tracking-tight truncate">
                    {selected.full_name}
                  </div>
                  <div className="text-[13px] text-muted mt-0.5 truncate">
                    {selected.phone || t("leads.no_phone")}
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
              <input
                className="nf-input"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("common.status")}</div>
              <select
                className="nf-input"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as OperatorStatus })}
              >
                <option value="active">{t("op_detail.status_active")}</option>
                <option value="trainee">{t("op_detail.status_trainee")}</option>
                <option value="inactive">{t("op_detail.status_inactive")}</option>
              </select>
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
