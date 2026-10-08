import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Pencil, Plus, Search, Send, ShieldOff, Trash2, UserCog } from "lucide-react";
import { api } from "../lib/api";
import {
  Button,
  Chip,
  Modal,
  StatusBadge,
  toast,
} from "../components/ui";
import { usePageHeader } from "../store/page";
import { useAuth } from "../store/auth";
import { normaliseRole } from "../components/RoleGate";
import { useT } from "../lib/i18n";
import { apiErrorMessage } from "../lib/api-types";

type Role = "manager" | "team_lead" | "super_manager" | "superadmin";
type Language = "ru" | "uz";

interface UserRow {
  id: number;
  username: string;
  full_name?: string;
  role: Role | string;
  is_active: boolean;
  is_superuser: boolean;
  date_joined: string | null;
  last_login: string | null;
  preferred_language?: Language;
  reports_to_id?: number | null;
  telegram_linked?: boolean;
  operator_id?: number | null;
  operator_name?: string | null;
  operator_phone?: string | null;
}

interface Creds {
  id: number;
  username: string;
  password: string;
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

export default function Users() {
  const qc = useQueryClient();
  const t = useT();
  const meUsername = useAuth((s) => s.username);

  usePageHeader({ title: t("nav.users") }, [t("nav.users")]);

  const ROLE_LABEL: Record<string, string> = {
    manager: t("role.manager"),
    team_lead: t("users.role_team_lead"),
    super_manager: t("role.super_manager"),
    superadmin: t("role.manager"),
  };

  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<Role>("manager");
  const [newReportsToId, setNewReportsToId] = useState<number | "">("");
  const [createError, setCreateError] = useState("");
  const [credsModal, setCredsModal] = useState<Creds | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);
  const [confirmReset, setConfirmReset] = useState<UserRow | null>(null);
  // Edit modal state: editing an existing user's role / reports_to.
  // operator-rows allowed too → можно повысить оператора в manager/team_lead.
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [editRole, setEditRole] = useState<Role | "operator">("manager");
  const [editReportsToId, setEditReportsToId] = useState<number | "">("");
  const [editError, setEditError] = useState("");

  const usersQ = useQuery<UserRow[]>({
    queryKey: ["users"],
    queryFn: () => api.get<UserRow[]>("/users/").then((r) => r.data),
  });

  const createMut = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        username: newUsername.trim(),
        role: newRole,
      };
      // Attach reports_to only when assigning MANAGER to a specific
      // super_manager (otherwise backend defaults to null = unassigned).
      if (newRole === "manager" && newReportsToId !== "") {
        payload.reports_to_id = newReportsToId;
      }
      return api
        .post<Creds & { role: string; is_active: boolean }>("/users/", payload)
        .then((r) => r.data);
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setCreateOpen(false);
      setNewUsername("");
      setNewReportsToId("");
      setCredsModal({
        id: data.id,
        username: data.username,
        password: data.password,
      });
      toast.success(t("users.account_created"));
    },
    onError: (err: unknown) => setCreateError(apiErrorMessage(err)),
  });

  // reports_to options для dropdown — superadmin'ы + текущий super_manager.
  // Фронт просто показывает всех видимых senior'ов; backend сам fail'ит
  // некорректный id с 400. Operator-rows и обычные manager'ы отфильтрованы
  // (менеджер не может быть «начальником» менеджера).
  const reportsToOptions = (usersQ.data ?? []).filter(
    (u) => u.role === "super_manager" || u.role === "superadmin"
  );

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

  const deleteMut = useMutation({
    mutationFn: (user_id: number) => api.post(`/users/${user_id}/delete/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setConfirmDelete(null);
      toast.success(t("users.user_deactivated"));
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const editMut = useMutation({
    mutationFn: () => {
      if (!editingUser) throw new Error("no user");
      const payload: Record<string, unknown> = { role: editRole };
      if (editRole === "manager") {
        payload.reports_to_id = editReportsToId === "" ? null : editReportsToId;
      } else {
        // For non-manager roles reports_to has no meaning — nullify.
        payload.reports_to_id = null;
      }
      return api
        .patch(`/users/${editingUser.id}/`, payload)
        .then((r) => r.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setEditingUser(null);
      toast.success(t("users.saved") || "Сохранено");
    },
    onError: (err: unknown) => setEditError(apiErrorMessage(err)),
  });

  const openEdit = (u: UserRow) => {
    setEditingUser(u);
    setEditRole((u.role as Role | "operator") ?? "manager");
    setEditReportsToId(u.reports_to_id ?? "");
    setEditError("");
  };

  const languageMut = useMutation({
    mutationFn: ({ user_id, preferred_language }: { user_id: number; preferred_language: Language }) =>
      api
        .patch(`/users/${user_id}/`, { preferred_language })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(t("users.language_saved"));
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const allRows = usersQ.data ?? [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((u) => {
      const haystack = [
        u.username,
        u.full_name || "",
        u.operator_name || "",
        u.operator_phone || "",
        u.role || "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [allRows, search]);

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Toolbar */}
      <section className="flex items-center justify-between gap-3 animate-nfFadeUp flex-wrap">
        <div className="flex items-center gap-3 flex-1 min-w-[220px]">
          <div className="relative flex-1 max-w-[380px]">
            <Search
              className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 opacity-50 pointer-events-none"
            />
            <input
              className="nf-input"
              style={{ paddingLeft: 32 }}
              placeholder={t("users.search_ph") || "Поиск: имя, логин, телефон, оператор…"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="text-[12px] text-muted whitespace-nowrap">
            {rows.length} / {allRows.length}
          </div>
        </div>
        <Button onClick={() => { setCreateOpen(true); setCreateError(""); }}>
          <Plus className="w-3.5 h-3.5" /> {t("users.add_manager")}
        </Button>
      </section>

      {/* Table */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: "1.8fr .8fr .7fr .8fr .8fr auto" }}
        >
          <div>{t("common.login")}</div>
          <div>{t("common.role")}</div>
          <div>{t("users.language")}</div>
          <div>{t("users.col_created")}</div>
          <div>{t("profile.last_login")}</div>
          <div className="text-right">{t("common.actions")}</div>
        </div>

        {usersQ.isLoading ? (
          <div className="text-center text-muted py-12 text-[13px]">{t("common.loading")}</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">{t("common.empty")}</div>
        ) : (
          <div>
            {rows.map((u, i) => {
              const isMe = u.username === meUsername;
              return (
                <div
                  key={u.id}
                  className="nf-row animate-nfFadeUp"
                  style={{
                    gridTemplateColumns: "1.8fr .8fr .7fr .8fr .8fr auto",
                    animationDelay: `${0.02 + i * 0.035}s`,
                    cursor: "default",
                  }}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className="grid place-items-center text-white text-[11px] font-semibold shrink-0"
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 9,
                        background: "var(--accent-grad)",
                      }}
                    >
                      {(u.full_name || u.username).slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium truncate flex items-center gap-1.5">
                        {u.operator_name || u.full_name || u.username}
                        {u.telegram_linked && (
                          <Send
                            className="w-3 h-3 shrink-0 opacity-60"
                            style={{ color: "var(--accent)" }}
                          />
                        )}
                      </div>
                      <div className="text-[11px] text-muted font-mono tabular-nums truncate">
                        {u.operator_phone || u.username}
                        {u.operator_id && u.operator_name && u.operator_phone !== u.username && (
                          <span className="ml-1.5 opacity-70">· {u.username}</span>
                        )}
                      </div>
                      {isMe && (
                        <div className="text-[10.5px] text-muted">{t("users.this_is_you")}</div>
                      )}
                    </div>
                  </div>
                  <div>
                    <StatusBadge
                      tone={normaliseRole(u.role) === "manager" ? "hot" : "neutral"}
                    >
                      {ROLE_LABEL[u.role] ?? u.role}
                    </StatusBadge>
                    {u.is_superuser && (
                      <div className="text-[10.5px] text-muted mt-0.5">
                        superuser
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1">
                    {(["uz", "ru"] as Language[]).map((lang) => {
                      const active = (u.preferred_language ?? "uz") === lang;
                      return (
                        <Chip
                          key={lang}
                          active={active}
                          onClick={() =>
                            !active &&
                            languageMut.mutate({
                              user_id: u.id,
                              preferred_language: lang,
                            })
                          }
                        >
                          {lang.toUpperCase()}
                        </Chip>
                      );
                    })}
                  </div>
                  <div className="text-muted text-[12.5px]">
                    {fmtDate(u.date_joined)}
                  </div>
                  <div className="text-muted text-[12.5px]">
                    {fmtDate(u.last_login)}
                  </div>
                  <div className="flex gap-1.5 justify-end">
                    <button
                      onClick={() => openEdit(u)}
                      className="nf-btn nf-btn--ghost"
                      style={{ padding: "6px 10px", fontSize: 12 }}
                      title={t("users.edit_role") || "Редактировать роль"}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setConfirmReset(u)}
                      className="nf-btn nf-btn--ghost"
                      style={{ padding: "6px 10px", fontSize: 12 }}
                      title={t("op_detail.regenerate_password")}
                    >
                      <KeyRound className="w-3.5 h-3.5" /> {t("common.password")}
                    </button>
                    {!isMe && (
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
                    )}
                  </div>
                </div>
              );
            })}
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
              {t("users.new_manager")}
            </div>
          </div>
          <p className="text-[13px] text-muted mt-1">
            {t("op_detail.password_one_time_hint")}
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
            <div>
              <div className="nf-col mb-1.5">{t("common.role")}</div>
              <div className="flex gap-2 flex-wrap">
                <Chip
                  active={newRole === "manager"}
                  onClick={() => setNewRole("manager")}
                >
                  {t("role.manager")}
                </Chip>
                <Chip
                  active={newRole === "team_lead"}
                  onClick={() => setNewRole("team_lead")}
                >
                  {t("users.role_team_lead")}
                </Chip>
                <Chip
                  active={newRole === "super_manager"}
                  onClick={() => setNewRole("super_manager")}
                >
                  {t("role.super_manager")}
                </Chip>
              </div>
            </div>
            {/* reports_to dropdown — only for MANAGER role (super_manager
                / superadmin assignment лежит на backend). Пустое значение
                означает «пока ничей» (legacy pool). */}
            {newRole === "manager" && reportsToOptions.length > 0 && (
              <div>
                <div className="nf-col mb-1.5">{t("users.reports_to")}</div>
                <select
                  className="nf-input"
                  value={newReportsToId === "" ? "" : String(newReportsToId)}
                  onChange={(e) =>
                    setNewReportsToId(
                      e.target.value === "" ? "" : Number(e.target.value)
                    )
                  }
                >
                  <option value="">{t("users.reports_to_none")}</option>
                  {reportsToOptions.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username} ({ROLE_LABEL[u.role] ?? u.role})
                    </option>
                  ))}
                </select>
                <div className="text-[11px] text-muted mt-1">
                  {t("users.reports_to_hint")}
                </div>
              </div>
            )}
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

      {/* Edit role / reports_to */}
      <Modal open={!!editingUser} onClose={() => setEditingUser(null)} width={460}>
        {editingUser && (
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
                <Pencil className="w-4 h-4" />
              </div>
              <div className="text-[16px] font-semibold tracking-tight">
                {editingUser.username}
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-4">
              <div>
                <div className="nf-col mb-1.5">{t("common.role")}</div>
                <div className="flex gap-2 flex-wrap">
                  <Chip
                    active={editRole === "manager"}
                    onClick={() => setEditRole("manager")}
                  >
                    {t("role.manager")}
                  </Chip>
                  <Chip
                    active={editRole === "team_lead"}
                    onClick={() => setEditRole("team_lead")}
                  >
                    {t("users.role_team_lead")}
                  </Chip>
                  <Chip
                    active={editRole === "super_manager"}
                    onClick={() => setEditRole("super_manager")}
                  >
                    {t("role.super_manager")}
                  </Chip>
                  <Chip
                    active={editRole === "operator"}
                    onClick={() => setEditRole("operator")}
                  >
                    {t("role.operator") || "Оператор"}
                  </Chip>
                </div>
              </div>

              {editRole === "manager" && reportsToOptions.length > 0 && (
                <div>
                  <div className="nf-col mb-1.5">{t("users.reports_to")}</div>
                  <select
                    className="nf-input"
                    value={editReportsToId === "" ? "" : String(editReportsToId)}
                    onChange={(e) =>
                      setEditReportsToId(
                        e.target.value === "" ? "" : Number(e.target.value)
                      )
                    }
                  >
                    <option value="">{t("users.reports_to_none")}</option>
                    {reportsToOptions
                      .filter((u) => u.id !== editingUser.id)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.username} ({ROLE_LABEL[u.role] ?? u.role})
                        </option>
                      ))}
                  </select>
                </div>
              )}

              {editError && (
                <div
                  className="text-[13px] rounded-xl px-3.5 py-2.5"
                  style={{
                    background: "rgba(220,60,40,.08)",
                    color: "var(--danger)",
                    border: "1px solid rgba(220,60,40,.2)",
                  }}
                >
                  {editError}
                </div>
              )}
            </div>

            <div className="mt-7 flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setEditingUser(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => editMut.mutate()}
                disabled={editMut.isPending}
              >
                {editMut.isPending ? t("common.saving") || "Сохраняем..." : t("common.save") || "Сохранить"}
              </Button>
            </div>
          </div>
        )}
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

      {/* Confirm delete */}
      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        width={420}
      >
        {confirmDelete && (
          <div className="p-7">
            <div className="text-[18px] font-semibold tracking-tight flex items-center gap-2">
              <ShieldOff className="w-4 h-4" /> {t("users.deactivate_q")}
            </div>
            <div className="text-[13px] text-muted mt-2">
              {t("users.deactivate_hint", { name: confirmDelete.username })}
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={() => deleteMut.mutate(confirmDelete.id)}
                disabled={deleteMut.isPending}
              >
                {deleteMut.isPending ? "…" : t("users.deactivate")}
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
