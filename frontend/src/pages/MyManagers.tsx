import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, Trash2, UserCog, Users as UsersIcon, X } from "lucide-react";
import { api } from "../lib/api";
import {
  Button,
  Modal,
  StatusBadge,
  toast,
} from "../components/ui";
import { usePageHeader } from "../store/page";
import { useAuth } from "../store/auth";
import { useT } from "../lib/i18n";
import { apiErrorMessage } from "../lib/api-types";

/**
 * Super-manager personal admin surface: список своих manager'ов
 * (Profile.reports_to = me), создание нового manager'а под собой,
 * сброс пароля. На один уровень ниже обычной /users — здесь только
 * «мои» managers, без superadmin / super_manager / team_lead.
 *
 * Backend scoping делает UserListApi.get(): super_manager видит
 * `visible_manager_user_ids(me)` = {я + мои managers (reports_to=me)}.
 * Фильтруем по role=manager на фронте.
 */
interface UserRow {
  id: number;
  username: string;
  role: string;
  is_active: boolean;
  is_superuser: boolean;
  date_joined: string | null;
  last_login: string | null;
  reports_to_id: number | null;
}

interface Creds {
  id: number;
  username: string;
  password: string;
}

interface OperatorRow {
  id: number;
  full_name: string;
  phone: string | null;
  status: string;
  managed_by_id: number | null;
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "short",
      year: "2-digit",
    });
  } catch {
    return "—";
  }
}

export default function MyManagers() {
  const qc = useQueryClient();
  const t = useT();
  const meUsername = useAuth((s) => s.username);

  usePageHeader(
    { title: t("super_manager.my_managers_title") },
    [t("super_manager.my_managers_title")]
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [createError, setCreateError] = useState("");
  const [credsModal, setCredsModal] = useState<Creds | null>(null);
  const [confirmReset, setConfirmReset] = useState<UserRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);
  // Team modal: raskaz'yvaem komandu manager'a (operatorov pod nim) +
  // dropdown dlya add из pool (unassigned operators).
  const [teamOf, setTeamOf] = useState<UserRow | null>(null);
  const [addOpSelect, setAddOpSelect] = useState<number | "">("");

  const usersQ = useQuery<UserRow[]>({
    queryKey: ["users"],
    queryFn: () => api.get<UserRow[]>("/users/").then((r) => r.data),
  });

  // All managers / team_leads system-wide (super_managers — shared tier,
  // видят всех manager'ов, не только своих). Исключаем себя (super_manager'а).
  const rows = (usersQ.data ?? []).filter(
    (u) => u.username !== meUsername && (u.role === "manager" || u.role === "team_lead")
  );

  const createMut = useMutation({
    mutationFn: () =>
      api
        .post<Creds & { role: string; is_active: boolean }>("/users/", {
          username: newUsername.trim(),
          role: "manager",
          // reports_to не ставим — super_managers общий tier, manager'ы
          // не привязываются к конкретному super_manager'у. Scope у
          // manager'ов идёт по managed_by на operator-уровне.
        })
        .then((r) => r.data),
    onSuccess: async (data) => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setCreateOpen(false);
      setNewUsername("");
      setCredsModal({
        id: data.id,
        username: data.username,
        password: data.password,
      });
      toast.success(t("super_manager.manager_created"));
    },
    onError: (err: unknown) => setCreateError(apiErrorMessage(err)),
  });

  const resetMut = useMutation({
    mutationFn: (user_id: number) =>
      api.post<Creds>(`/users/${user_id}/reset-password/`).then((r) => r.data),
    onSuccess: (data) => {
      setConfirmReset(null);
      setCredsModal(data);
      toast.success(t("users.password_reset"));
    },
    onError: () => toast.error(t("op_detail.password_reset_failed")),
  });

  // Soft-delete manager: deactivate account. Operatorы, которые были
  // managed_by этого manager'а, после cascade on_delete=SET_NULL
  // становятся unassigned и super_manager может переназначить.
  const deleteMut = useMutation({
    mutationFn: (user_id: number) => api.post(`/users/${user_id}/delete/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["operators"] });
      setConfirmDelete(null);
      toast.success(t("users.user_deactivated"));
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  // Operatorы, видимые super_manager'у: свои direct + из команд его
  // managers. Используем в team-modal для показа кто у кого + pool
  // unassigned для добавления.
  const operatorsQ = useQuery<OperatorRow[]>({
    queryKey: ["operators"],
    queryFn: () => api.get<OperatorRow[]>("/operators/").then((r) => r.data),
  });

  // Назначить/снять operator'а managed_by. PATCH /operators/{id}/ принимает
  // managed_by_id (null = снять, number = назначить). Backend валидирует,
  // что super_manager может назначать только своим managers.
  const reassignOpMut = useMutation({
    mutationFn: ({ op_id, new_manager_id }: { op_id: number; new_manager_id: number | null }) =>
      api
        .patch(`/operators/${op_id}/`, { managed_by_id: new_manager_id })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      setAddOpSelect("");
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  // Count operatorов под каждым manager'ом (для badges в table).
  const opsByManager = useMemo(() => {
    const map = new Map<number, number>();
    (operatorsQ.data ?? []).forEach((op) => {
      if (op.managed_by_id != null) {
        map.set(op.managed_by_id, (map.get(op.managed_by_id) ?? 0) + 1);
      }
    });
    return map;
  }, [operatorsQ.data]);

  // Для team-modal: operatorы ЭТОГО manager'а.
  const teamOperators = useMemo(() => {
    if (!teamOf) return [] as OperatorRow[];
    return (operatorsQ.data ?? []).filter((op) => op.managed_by_id === teamOf.id);
  }, [operatorsQ.data, teamOf]);
  // Add-pool: ВСЕ operator'ы кроме уже в этой команде. Super_manager
  // может «украсть» у другого manager'а — managed_by единственный FK,
  // при PATCH на другой owner — автоматически уходит от предыдущего.
  const availableOperators = useMemo(() => {
    if (!teamOf) return [] as OperatorRow[];
    return (operatorsQ.data ?? []).filter((op) => op.managed_by_id !== teamOf.id);
  }, [operatorsQ.data, teamOf]);
  // Map user_id → username для отображения «сейчас у X» в dropdown.
  const userById = useMemo(() => {
    const m = new Map<number, string>();
    (usersQ.data ?? []).forEach((u) => m.set(u.id, u.username));
    return m;
  }, [usersQ.data]);

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      <section className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px] text-muted">
          {t("super_manager.my_managers_subtitle")}
        </div>
        <Button onClick={() => { setCreateOpen(true); setCreateError(""); }}>
          <Plus className="w-3.5 h-3.5" /> {t("super_manager.add_manager")}
        </Button>
      </section>

      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: "1.4fr .8fr .6fr .8fr .8fr auto" }}
        >
          <div>{t("common.login")}</div>
          <div>{t("common.role")}</div>
          <div>{t("super_manager.ops_count") || "Операторов"}</div>
          <div>{t("users.col_created")}</div>
          <div>{t("profile.last_login")}</div>
          <div className="text-right">{t("common.actions")}</div>
        </div>

        {usersQ.isLoading ? (
          <div className="text-center text-muted py-12 text-[13px]">{t("common.loading")}</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("super_manager.my_managers_empty")}
          </div>
        ) : (
          <div>
            {rows.map((u, i) => (
              <div
                key={u.id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: "1.4fr .8fr .6fr .8fr .8fr auto",
                  animationDelay: `${0.02 + i * 0.035}s`,
                  cursor: "default",
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="grid place-items-center text-white text-[11px] font-semibold shrink-0"
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 9,
                      background: "var(--accent-grad)",
                    }}
                  >
                    {u.username.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="font-medium">{u.username}</div>
                </div>
                <div>
                  <StatusBadge tone="hot">
                    {t("role.manager")}
                  </StatusBadge>
                </div>
                <div>
                  <button
                    onClick={() => { setTeamOf(u); setAddOpSelect(""); }}
                    className="nf-btn nf-btn--ghost"
                    style={{ padding: "4px 10px", fontSize: 12 }}
                    title={t("super_manager.manage_team") || "Команда"}
                  >
                    <UsersIcon className="w-3.5 h-3.5" />
                    <span className="tabular-nums ml-1">
                      {opsByManager.get(u.id) ?? 0}
                    </span>
                  </button>
                </div>
                <div className="text-muted text-[12.5px]">
                  {fmtDate(u.date_joined)}
                </div>
                <div className="text-muted text-[12.5px]">
                  {fmtDate(u.last_login)}
                </div>
                <div className="flex gap-1.5 justify-end">
                  <button
                    onClick={() => setConfirmReset(u)}
                    className="nf-btn nf-btn--ghost"
                    style={{ padding: "6px 10px", fontSize: 12 }}
                    title={t("op_detail.regenerate_password")}
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setConfirmDelete(u)}
                    className="nf-btn"
                    style={{
                      padding: "6px 10px",
                      fontSize: 12,
                      background: "rgba(220,60,40,.1)",
                      color: "var(--danger)",
                    }}
                    title={t("users.deactivate")}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        width={460}
      >
        <div className="p-7">
          <div className="flex items-center gap-2.5 mb-2">
            <div
              className="grid place-items-center text-white"
              style={{
                width: 30,
                height: 30,
                borderRadius: 10,
                background: "var(--accent-grad)",
              }}
            >
              <UserCog className="w-4 h-4" />
            </div>
            <div className="text-[16px] font-semibold tracking-tight">
              {t("super_manager.new_manager")}
            </div>
          </div>
          <p className="text-[13px] text-muted mt-1">
            {t("super_manager.new_manager_hint")}
          </p>

          <div className="mt-5 flex flex-col gap-4">
            <div>
              <div className="nf-col mb-1.5">{t("common.login")}</div>
              <input
                className="nf-input"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder={t("users.login_ph")}
                autoFocus
                autoComplete="off"
              />
            </div>
            {createError && (
              <div
                className="text-[13px] rounded-xl px-3.5 py-2.5"
                style={{
                  background: "rgba(220,60,40,.08)",
                  color: "var(--danger)",
                  border: "1px solid rgba(220,60,40,.2)",
                }}
              >
                {createError}
              </div>
            )}
          </div>
          <div className="mt-7 flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending || !newUsername.trim()}
            >
              {createMut.isPending ? t("common.creating") : t("common.create")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Credentials shown once */}
      <Modal open={!!credsModal} onClose={() => setCredsModal(null)} width={460}>
        {credsModal && (
          <div className="p-7">
            <div className="text-[18px] font-semibold tracking-tight">
              {t("users.done_save_pw")}
            </div>
            <div
              className="mt-3 rounded-xl px-3.5 py-2.5 text-[12.5px]"
              style={{
                background: "rgba(242,86,11,.1)",
                color: "var(--accent)",
                border: "1px solid rgba(242,86,11,.25)",
              }}
            >
              {t("users.pw_only_now")}
            </div>
            <div className="mt-5 flex flex-col gap-3">
              <CredRow
                label={t("common.login")}
                value={credsModal.username}
                toastText={t("toast.copied_login")}
              />
              <CredRow
                label={t("common.password")}
                value={credsModal.password}
                toastText={t("toast.copied_password")}
              />
            </div>
            <div className="mt-6 flex justify-end">
              <Button onClick={() => setCredsModal(null)}>{t("common.done")}</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Confirm reset */}
      <Modal
        open={!!confirmReset}
        onClose={() => setConfirmReset(null)}
        width={420}
      >
        {confirmReset && (
          <div className="p-7">
            <div className="text-[18px] font-semibold tracking-tight">
              {t("users.reset_pw_q")}
            </div>
            <div className="text-[13px] text-muted mt-2">
              {t("users.reset_pw_hint", { name: confirmReset.username })}
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setConfirmReset(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => resetMut.mutate(confirmReset.id)}
                disabled={resetMut.isPending}
              >
                {resetMut.isPending ? "…" : t("users.generate")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Confirm delete manager */}
      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        width={420}
      >
        {confirmDelete && (
          <div className="p-7">
            <div className="text-[18px] font-semibold tracking-tight">
              {t("super_manager.delete_q")}
            </div>
            <div className="text-[13px] text-muted mt-2">
              {t("super_manager.delete_hint_tpl")
                .replace("{name}", confirmDelete.username)
                .replace("{n}", String(opsByManager.get(confirmDelete.id) ?? 0))}
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => deleteMut.mutate(confirmDelete.id)}
                disabled={deleteMut.isPending}
              >
                {deleteMut.isPending ? "…" : t("users.deactivate")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Team modal — операторы под этим manager'ом + добавить из pool */}
      <Modal
        open={!!teamOf}
        onClose={() => { setTeamOf(null); setAddOpSelect(""); }}
        width={620}
      >
        {teamOf && (
          <div className="p-7">
            <div className="flex items-center gap-2.5 mb-4">
              <div
                className="grid place-items-center text-white"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 10,
                  background: "var(--accent-grad)",
                }}
              >
                <UsersIcon className="w-4 h-4" />
              </div>
              <div>
                <div className="text-[16px] font-semibold tracking-tight">
                  {t("super_manager.team_of") || "Команда"} {teamOf.username}
                </div>
                <div className="text-[12px] text-muted">
                  {teamOperators.length} {t("super_manager.ops_count") || "операторов"}
                </div>
              </div>
            </div>

            {/* Current operators list */}
            <div className="flex flex-col gap-1.5 mb-4 max-h-[260px] overflow-auto">
              {teamOperators.length === 0 ? (
                <div className="text-[13px] text-muted py-6 text-center">
                  {t("super_manager.team_empty") || "Пока никого. Добавь из списка ниже."}
                </div>
              ) : (
                teamOperators.map((op) => (
                  <div
                    key={op.id}
                    className="nf-tile flex items-center justify-between gap-2"
                    style={{ padding: "8px 12px" }}
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate">
                        {op.full_name}
                      </div>
                      <div className="text-[11px] text-muted font-mono">
                        {op.phone ?? "—"}
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        reassignOpMut.mutate({ op_id: op.id, new_manager_id: null })
                      }
                      className="nf-btn"
                      style={{
                        padding: "4px 8px",
                        fontSize: 11,
                        background: "rgba(220,60,40,.08)",
                        color: "var(--danger)",
                      }}
                      title={t("super_manager.remove_from_team") || "Убрать из команды"}
                      disabled={reassignOpMut.isPending}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Add from pool dropdown: ВСЕ operator'ы (кроме этой команды).
                Можно "украсть" у другого manager'а — managed_by единственный
                FK, при PATCH уйдёт от предыдущего. */}
            {availableOperators.length > 0 && (
              <div className="pt-3 border-t" style={{ borderColor: "var(--border)" }}>
                <div className="nf-col mb-1.5">
                  {t("super_manager.add_from_pool")}
                </div>
                <div className="flex gap-2">
                  <select
                    className="nf-input flex-1"
                    value={addOpSelect === "" ? "" : String(addOpSelect)}
                    onChange={(e) =>
                      setAddOpSelect(e.target.value === "" ? "" : Number(e.target.value))
                    }
                  >
                    <option value="">{t("super_manager.select_operator")}</option>
                    {availableOperators.map((op) => {
                      const ownerName = op.managed_by_id
                        ? userById.get(op.managed_by_id) ?? `#${op.managed_by_id}`
                        : null;
                      const suffix = ownerName
                        ? ` — ${t("super_manager.currently_with").replace("{name}", ownerName)}`
                        : ` — ${t("super_manager.unassigned")}`;
                      return (
                        <option key={op.id} value={op.id}>
                          {op.full_name} ({op.phone ?? "—"}){suffix}
                        </option>
                      );
                    })}
                  </select>
                  <Button
                    onClick={() =>
                      typeof addOpSelect === "number" &&
                      reassignOpMut.mutate({
                        op_id: addOpSelect,
                        new_manager_id: teamOf.id,
                      })
                    }
                    disabled={addOpSelect === "" || reassignOpMut.isPending}
                  >
                    <Plus className="w-3.5 h-3.5" /> {t("common.add")}
                  </Button>
                </div>
                <div className="text-[11px] text-muted mt-1">
                  {t("super_manager.add_hint")}
                </div>
              </div>
            )}

            <div className="mt-6 flex gap-2 justify-end">
              <Button
                variant="ghost"
                onClick={() => { setTeamOf(null); setAddOpSelect(""); }}
              >
                {t("common.done")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function CredRow({
  label,
  value,
  toastText,
}: {
  label: string;
  value: string;
  toastText: string;
}) {
  const t = useT();
  return (
    <div
      className="nf-tile flex items-center justify-between gap-3"
      style={{ padding: "12px 14px" }}
    >
      <div className="min-w-0">
        <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">
          {label}
        </div>
        <div className="mt-1 font-mono text-[14px] font-semibold tabular-nums truncate">
          {value}
        </div>
      </div>
      <button
        type="button"
        className="nf-btn nf-btn--ghost"
        style={{ padding: "8px 10px" }}
        onClick={() => {
          navigator.clipboard?.writeText(value);
          toast.success(toastText);
        }}
        aria-label={`${t("common.copy")} ${label}`}
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
