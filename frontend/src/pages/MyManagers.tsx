import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, UserCog } from "lucide-react";
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

  const usersQ = useQuery<UserRow[]>({
    queryKey: ["users"],
    queryFn: () => api.get<UserRow[]>("/users/").then((r) => r.data),
  });

  // Keep only managers (role=manager / team_lead) и исключаем себя.
  // Super_manager не должен видеть «себя» в этом списке — у него для
  // этого /profile. Backend возвращает self + direct_reports; фильтр
  // «только managers, не я» делает список чисто подчинёнными.
  const rows = (usersQ.data ?? []).filter(
    (u) => u.username !== meUsername && (u.role === "manager" || u.role === "team_lead")
  );

  const createMut = useMutation({
    mutationFn: () =>
      api
        .post<Creds & { role: string; is_active: boolean }>("/users/", {
          username: newUsername.trim(),
          role: "manager",
          // reports_to_id = me implicitly via UserListCreateApi.post —
          // но backend сам не ставит, нужно передать. На фронте мы id
          // текущего юзера не держим напрямую, поэтому полагаемся на
          // отдельный follow-up PATCH /users/{id}/ сразу после create.
        })
        .then((r) => r.data),
    onSuccess: async (data) => {
      // Follow-up PATCH: привязать нового manager'а себе через
      // reports_to_id=self. API-слой само на себя — т.е. PATCH на
      // /users/{data.id}/ с reports_to_id=<my-user-id>. Текущий user
      // id мы знаем из /auth/me/, но здесь напрямую — через чуть более
      // окольный путь: сначала попросим API найти my-id через рефреш
      // списка (super_manager видит сам себя как первую строку).
      try {
        const list = await api
          .get<UserRow[]>("/users/")
          .then((r) => r.data);
        const myRow = list.find((u) => u.username === meUsername);
        if (myRow) {
          await api.patch(`/users/${data.id}/`, {
            reports_to_id: myRow.id,
          });
        }
      } catch {
        // Non-fatal — manager создан, просто reports_to не выставлен.
        // Super_manager может потом вручную привязать через /users или
        // backend-cli. Toast об успехе всё равно показываем.
      }
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
          style={{ gridTemplateColumns: "1.4fr .8fr .8fr .8fr auto" }}
        >
          <div>{t("common.login")}</div>
          <div>{t("common.role")}</div>
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
                  gridTemplateColumns: "1.4fr .8fr .8fr .8fr auto",
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
                    <KeyRound className="w-3.5 h-3.5" /> {t("common.password")}
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
