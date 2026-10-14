import { useMemo, useState } from "react";
import { AlertTriangle, Copy, KeyRound, Pencil, Plus, Search, Send, Trash2 } from "lucide-react";
import { toast } from "../../components/ui";
import { useAuth } from "../../store/auth";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, useConfirm } from "../ui";
import {
  useUsersCreate,
  useUsersDeactivate,
  useUsersList,
  useUsersResetPassword,
  useUsersUpdate,
  type UsersCreds,
  type UsersLanguage,
  type UsersRow,
} from "../api/team/people";

/** Roles a manager may pick in the UI. team_lead is hidden by project rule. */
const EDIT_ROLES = ["operator", "manager", "super_manager"] as const;
const CREATE_ROLES = ["manager", "super_manager"] as const;

type Group = "all" | "manager" | "super_manager" | "operator" | "superadmin" | "other";
const GROUP_ORDER: Group[] = ["manager", "super_manager", "operator", "superadmin", "other"];

function groupOf(role: string): Group {
  if (role === "manager" || role === "team_lead") return "manager";
  if (role === "super_manager" || role === "operator" || role === "superadmin") return role;
  return "other";
}

const COLS = "minmax(0, 1.7fr) 130px minmax(0, 1fr) 96px 96px 130px 150px";

function fmtDay(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric" });
}

function initials(name: string) {
  const parts = name.replace(/^\+/, "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.replace(/^\+/, "").slice(0, 2).toUpperCase();
}

export default function Users() {
  const t = useT2();
  const meUsername = useAuth((s) => s.username);
  const confirm = useConfirm();

  const usersQ = useUsersList();
  const createMut = useUsersCreate();
  const updateMut = useUsersUpdate();
  const resetMut = useUsersResetPassword();
  const deactivateMut = useUsersDeactivate();

  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<Group>("all");

  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<(typeof CREATE_ROLES)[number]>("manager");
  const [newReportsTo, setNewReportsTo] = useState<number | "">("");
  const [createError, setCreateError] = useState("");

  const [editing, setEditing] = useState<UsersRow | null>(null);
  const [editRole, setEditRole] = useState<string>("manager");
  const [editReportsTo, setEditReportsTo] = useState<number | "">("");
  const [editError, setEditError] = useState("");

  const [creds, setCreds] = useState<(UsersCreds & { kind: "created" | "reset"; name: string }) | null>(null);
  const [saved, setSaved] = useState(false);

  const roleLabel = (role: string) => {
    switch (role) {
      case "manager": return t("role.manager");
      case "team_lead": return t("users.role_team_lead");
      case "super_manager": return t("role.super_manager");
      case "superadmin": return t("v2.team.people.roleSuperadmin");
      case "operator": return t("role.operator");
      case "smm": return "SMM";
      default: return t("v2.team.people.roleOther");
    }
  };
  const groupLabel = (g: Group) => t(`v2.team.people.group.${g}`);

  const all = usersQ.data ?? [];
  const byId = useMemo(() => new Map(all.map((u) => [u.id, u])), [all]);
  const counts = useMemo(() => {
    const c: Record<Group, number> = { all: all.length, manager: 0, super_manager: 0, operator: 0, superadmin: 0, other: 0 };
    all.forEach((u) => c[groupOf(u.role)]++);
    return c;
  }, [all]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((u) => {
      if (group !== "all" && groupOf(u.role) !== group) return false;
      if (!q) return true;
      return [u.username, u.full_name || "", u.operator_name || "", u.operator_phone || "", u.role || "", roleLabel(u.role)]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, search, group]);

  // Possible owners for a manager: super_manager / superadmin accounts.
  const reportsToOptions = all.filter((u) => u.role === "super_manager" || u.role === "superadmin");
  const displayName = (u: UsersRow) => u.operator_name || u.full_name || u.username;
  const bossName = (u: UsersRow) => {
    if (!u.reports_to_id) return "—";
    const b = byId.get(u.reports_to_id);
    return b ? displayName(b) : `#${u.reports_to_id}`;
  };

  const openCreate = () => {
    setNewUsername("");
    setNewRole("manager");
    setNewReportsTo("");
    setCreateError("");
    setCreateOpen(true);
  };

  const submitCreate = () => {
    setCreateError("");
    const payload: { username: string; role: string; reports_to_id?: number } = { username: newUsername.trim(), role: newRole };
    if (newRole === "manager" && newReportsTo !== "") payload.reports_to_id = newReportsTo;
    createMut.mutate(payload, {
      onSuccess: (data) => {
        setCreateOpen(false);
        setSaved(false);
        setCreds({ id: data.id, username: data.username, password: data.password, kind: "created", name: data.username });
        toast.success(t("users.account_created"));
      },
      onError: (err) => setCreateError(apiErrorMessage(err)),
    });
  };

  const openEdit = (u: UsersRow) => {
    if (u.username === meUsername) {
      toast.error(t("v2.team.people.ownRole"));
      return;
    }
    setEditing(u);
    setEditRole(u.role || "manager");
    setEditReportsTo(u.reports_to_id ?? "");
    setEditError("");
  };

  const submitEdit = () => {
    if (!editing) return;
    setEditError("");
    updateMut.mutate(
      {
        id: editing.id,
        role: editRole,
        reports_to_id: editRole === "manager" ? (editReportsTo === "" ? null : editReportsTo) : null,
      },
      {
        onSuccess: () => {
          setEditing(null);
          toast.success(t("v2.team.people.roleSaved"));
        },
        onError: (err) => setEditError(apiErrorMessage(err)),
      },
    );
  };

  const setLanguage = (u: UsersRow, lang: UsersLanguage) => {
    updateMut.mutate(
      { id: u.id, preferred_language: lang },
      {
        onSuccess: () => toast.success(t("users.language_saved")),
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );
  };

  const askReset = async (u: UsersRow) => {
    const ok = await confirm({
      title: t("v2.team.people.resetTitle", { name: displayName(u) }),
      body: t("v2.team.people.resetBody", { name: u.username }),
      confirm: t("v2.team.people.resetConfirm"),
    });
    if (!ok) return;
    resetMut.mutate(u.id, {
      onSuccess: (data) => {
        setSaved(false);
        setCreds({ ...data, kind: "reset", name: displayName(u) });
        toast.success(t("users.password_reset"));
      },
      onError: () => toast.error(t("op_detail.password_reset_failed")),
    });
  };

  const askDeactivate = async (u: UsersRow) => {
    const ok = await confirm({
      title: t("v2.team.people.deactivateTitle", { name: displayName(u) }),
      body: (
        <div className="col g8">
          {u.role === "manager" || u.role === "team_lead" ? (
            <div className="banner b-warn">
              <AlertTriangle className="ic" />
              <span>{t("v2.team.people.deactivateOps")}</span>
            </div>
          ) : null}
          <span>{t("users.deactivate_hint", { name: u.username })}</span>
        </div>
      ),
      confirm: t("users.deactivate"),
      danger: true,
    });
    if (!ok) return;
    deactivateMut.mutate(u.id, {
      onSuccess: () => toast.success(t("users.user_deactivated")),
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  const copy = (value: string, msg: string) => {
    navigator.clipboard?.writeText(value).then(
      () => toast.success(msg),
      () => toast.error(t("v2.team.people.copyFailed")),
    );
  };

  const otherSuper = editing ? all.filter((u) => u.role === "super_manager" && u.id !== editing.id) : [];

  return (
    <>
      <PageHeader title={t("nav.users")} meta={t("v2.team.people.usersSub")}>
        <div className="inwrap" style={{ width: 300, maxWidth: "100%" }}>
          <Search className="ic" />
          <input
            className="input"
            type="search"
            placeholder={t("v2.team.people.searchPh")}
            aria-label={t("v2.team.people.searchAria")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="num s c3" title={t("v2.team.people.shownOfTotal")}>
          {rows.length} / {all.length}
        </span>
        <button className="btn btn-pri" type="button" onClick={openCreate}>
          <Plus className="ic" />
          {t("users.add_manager")}
        </button>
      </PageHeader>

      <main className="page">
        {all.length > 0 ? (
          <div className="row g8 wrap">
            {(["all", ...GROUP_ORDER] as Group[])
              .filter((g) => g === "all" || counts[g] > 0)
              .map((g) => (
                <button key={g} className={cx("chip", group === g && "is-on")} type="button" onClick={() => setGroup(g)}>
                  {groupLabel(g)} <span className="n">{counts[g]}</span>
                </button>
              ))}
          </div>
        ) : null}

        <section className="card tbl" style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 960 }}>
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <span>{t("common.login")}</span>
              <span>{t("common.role")}</span>
              <span>{t("users.reports_to")}</span>
              <span>{t("users.language")}</span>
              <span>{t("users.col_created")}</span>
              <span>{t("v2.team.people.lastLogin")}</span>
              <span className="r">{t("common.actions")}</span>
            </div>

            {usersQ.isLoading ? (
              <LoadingBlock rows={6} onRetry={() => usersQ.refetch()} />
            ) : usersQ.isError ? (
              <ErrorState error={usersQ.error} onRetry={() => usersQ.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState
                title={all.length === 0 ? t("v2.team.people.usersEmpty") : t("v2.team.people.usersNoMatch")}
                body={all.length === 0 ? t("v2.team.people.usersEmptyBody") : t("v2.team.people.usersNoMatchBody")}
              />
            ) : (
              rows.map((u) => {
                const isMe = u.username === meUsername;
                const name = displayName(u);
                const lang = u.preferred_language ?? "uz";
                return (
                  <div key={u.id} className="tr" style={{ gridTemplateColumns: COLS, minHeight: 58 }}>
                    <span className="row g8" style={{ minWidth: 0 }}>
                      <span className="ava ava-s">{initials(name)}</span>
                      <span className="col" style={{ minWidth: 0 }}>
                        <span className="row g6" style={{ minWidth: 0 }}>
                          <span className="w6 trunc">{name}</span>
                          {u.telegram_linked ? (
                            <span title={t("v2.team.people.tgLinked")} style={{ display: "inline-flex", color: "var(--brand)" }}>
                              <Send className="ic ic-s" />
                            </span>
                          ) : null}
                          {isMe ? <span className="badge b-info" style={{ height: 20 }}>{t("users.this_is_you")}</span> : null}
                        </span>
                        <span className="num xs c3 trunc">
                          {u.operator_phone || u.username}
                          {u.operator_id && u.operator_name && u.operator_phone !== u.username ? ` · ${u.username}` : ""}
                        </span>
                      </span>
                    </span>
                    <span className="col g4" style={{ alignItems: "flex-start" }}>
                      <span className={cx("badge", groupOf(u.role) === "manager" && "b-hot")}>{roleLabel(u.role)}</span>
                      {u.is_superuser ? <span className="xs c3">superuser</span> : null}
                    </span>
                    <span className="s c2 trunc">{bossName(u)}</span>
                    <span className="row g4">
                      {(["uz", "ru"] as UsersLanguage[]).map((l) => (
                        <button
                          key={l}
                          className={cx("chip", lang === l && "is-on")}
                          type="button"
                          style={{ height: 24, padding: "0 8px", fontSize: 12 }}
                          aria-pressed={lang === l}
                          disabled={updateMut.isPending}
                          onClick={() => lang !== l && setLanguage(u, l)}
                        >
                          {l.toUpperCase()}
                        </button>
                      ))}
                    </span>
                    <span className="num s c3">{fmtDay(u.date_joined)}</span>
                    <span className="num s c3">{fmtDay(u.last_login)}</span>
                    <span className="row g6" style={{ justifyContent: "flex-end" }}>
                      <button
                        className="btn btn-ghost btn-sq btn-sm"
                        type="button"
                        aria-label={t("v2.team.people.editRole")}
                        title={isMe ? t("v2.team.people.ownRole") : t("v2.team.people.editRole")}
                        disabled={isMe}
                        onClick={() => openEdit(u)}
                      >
                        <Pencil className="ic" />
                      </button>
                      <button
                        className="btn btn-sm"
                        type="button"
                        title={isMe ? t("v2.team.people.ownPassword") : t("v2.team.people.resetHint")}
                        disabled={isMe || resetMut.isPending}
                        onClick={() => askReset(u)}
                      >
                        <KeyRound className="ic" />
                        {t("common.password")}
                      </button>
                      {!isMe ? (
                        <button
                          className="btn btn-ghost btn-sq btn-sm c-bad"
                          type="button"
                          aria-label={t("v2.team.people.deactivateAria", { name })}
                          title={t("users.deactivate")}
                          disabled={deactivateMut.isPending}
                          onClick={() => askDeactivate(u)}
                        >
                          <Trash2 className="ic" />
                        </button>
                      ) : null}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <p className="s c3">{t("v2.team.people.usersFoot")}</p>
      </main>

      {/* Create */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("users.new_manager")}
        sub={t("v2.team.people.createSub")}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</button>
            <button className="btn btn-pri" type="button" disabled={createMut.isPending || !newUsername.trim()} onClick={submitCreate}>
              {createMut.isPending ? t("common.creating") : t("common.create")}
            </button>
          </>
        }
      >
        <form
          className="col g16"
          onSubmit={(e) => {
            e.preventDefault();
            if (newUsername.trim() && !createMut.isPending) submitCreate();
          }}
        >
          <div className="field">
            <label htmlFor="v2-user-login">{t("common.login")}</label>
            <input
              id="v2-user-login"
              className={cx("input", createError && "is-bad")}
              type="text"
              value={newUsername}
              placeholder={t("users.login_ph")}
              autoFocus
              autoComplete="off"
              onChange={(e) => {
                setNewUsername(e.target.value);
                setCreateError("");
              }}
            />
            {createError ? <span className="err">{createError}</span> : null}
          </div>
          <div className="field">
            <label>{t("common.role")}</label>
            <div className="seg seg-lg">
              {CREATE_ROLES.map((r) => (
                <button key={r} type="button" className={cx(newRole === r && "is-on")} onClick={() => setNewRole(r)}>
                  {roleLabel(r)}
                </button>
              ))}
            </div>
          </div>
          {newRole === "manager" && reportsToOptions.length > 0 ? (
            <div className="field">
              <label htmlFor="v2-user-boss">{t("v2.team.people.reportsTo")}</label>
              <select
                id="v2-user-boss"
                className="input"
                value={newReportsTo === "" ? "" : String(newReportsTo)}
                onChange={(e) => setNewReportsTo(e.target.value === "" ? "" : Number(e.target.value))}
              >
                <option value="">{t("users.reports_to_none")}</option>
                {reportsToOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {displayName(u)} · {roleLabel(u.role).toLowerCase()}
                  </option>
                ))}
              </select>
              <span className="xs c3">{t("v2.team.people.reportsToHint")}</span>
            </div>
          ) : null}
        </form>
      </Dialog>

      {/* Edit role */}
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? t("v2.team.people.roleTitle", { name: displayName(editing) }) : ""}
        sub={editing ? t("v2.team.people.roleNow", { role: roleLabel(editing.role).toLowerCase() }) : undefined}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setEditing(null)}>{t("common.cancel")}</button>
            <button
              className="btn btn-pri"
              type="button"
              disabled={updateMut.isPending || !(EDIT_ROLES as readonly string[]).includes(editRole)}
              onClick={submitEdit}
            >
              {updateMut.isPending ? t("common.saving") : t("common.save")}
            </button>
          </>
        }
      >
        {editing ? (
          <div className="col g16">
            <div className="col g6" role="radiogroup" aria-label={t("common.role")}>
              {EDIT_ROLES.map((r) => {
                const blocked = r === "super_manager" && otherSuper.length > 0 && editing.role !== "super_manager";
                return (
                  <label
                    key={r}
                    className={cx("keycap", editRole === r && "is-on")}
                    style={{ minHeight: 52, opacity: blocked ? 0.55 : 1, cursor: blocked ? "not-allowed" : "pointer" }}
                  >
                    <input
                      type="radio"
                      name="v2-user-role"
                      style={{ margin: 0 }}
                      checked={editRole === r}
                      disabled={blocked}
                      onChange={() => setEditRole(r)}
                    />
                    <span>
                      <b>{roleLabel(r)}</b>
                      {r === "super_manager" && otherSuper.length > 0 ? (
                        <span>{t("v2.team.people.superSingleton", { name: otherSuper.map(displayName).join(", ") })}</span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
            {editRole === "manager" && reportsToOptions.length > 0 ? (
              <div className="field">
                <label htmlFor="v2-user-edit-boss">{t("v2.team.people.reportsTo")}</label>
                <select
                  id="v2-user-edit-boss"
                  className="input"
                  value={editReportsTo === "" ? "" : String(editReportsTo)}
                  onChange={(e) => setEditReportsTo(e.target.value === "" ? "" : Number(e.target.value))}
                >
                  <option value="">{t("users.reports_to_none")}</option>
                  {reportsToOptions
                    .filter((u) => u.id !== editing.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {displayName(u)} · {roleLabel(u.role).toLowerCase()}
                      </option>
                    ))}
                </select>
              </div>
            ) : null}
            {editError ? (
              <div className="banner b-bad">
                <AlertTriangle className="ic" />
                <span>{editError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      {/* One-time password: locked — only «Готово» closes it */}
      <Dialog
        open={!!creds}
        locked
        onClose={() => setCreds(null)}
        title={creds?.kind === "created" ? t("v2.team.people.credsCreated") : t("v2.team.people.credsReset")}
        sub={creds?.name}
        footer={
          <button className="btn btn-pri" type="button" disabled={!saved} onClick={() => setCreds(null)}>
            {t("common.done")}
          </button>
        }
      >
        {creds ? (
          <div className="col g12">
            <div className="banner b-warn">
              <AlertTriangle className="ic" />
              <span>{t("users.pw_only_now")}</span>
            </div>
            <div className="well row between">
              <span className="col" style={{ minWidth: 0 }}>
                <span className="xs c3">{t("common.login")}</span>
                <span className="num w6 trunc">{creds.username}</span>
              </span>
              <button className="btn btn-sm" type="button" onClick={() => copy(creds.username, t("toast.copied_login"))}>
                <Copy className="ic" />
                {t("v2.team.people.copy")}
              </button>
            </div>
            <div className="well row between">
              <span className="col" style={{ minWidth: 0 }}>
                <span className="xs c3">{t("common.password")}</span>
                <span className="num w6 trunc">{creds.password}</span>
              </span>
              <button className="btn btn-sm" type="button" onClick={() => copy(creds.password, t("toast.copied_password"))}>
                <Copy className="ic" />
                {t("v2.team.people.copy")}
              </button>
            </div>
            <label className="row g8 s">
              <input className="check" type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              {t("v2.team.people.iSaved")}
            </label>
          </div>
        ) : null}
      </Dialog>

      {confirm.node}
    </>
  );
}
