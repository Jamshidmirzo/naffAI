import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, ShieldOff, Trash2, UserCog } from "lucide-react";
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
import { useT } from "../lib/i18n";
import { apiErrorMessage } from "../lib/api-types";

type Role = "manager" | "team_lead";

interface UserRow {
  id: number;
  username: string;
  role: Role | string;
  is_active: boolean;
  is_superuser: boolean;
  date_joined: string | null;
  last_login: string | null;
}

interface Creds {
  id: number;
  username: string;
  password: string;
}

const ROLE_LABEL: Record<string, string> = {
  manager: "Менеджер",
  team_lead: "Тим-лид",
};

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

  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<Role>("manager");
  const [createError, setCreateError] = useState("");
  const [credsModal, setCredsModal] = useState<Creds | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);
  const [confirmReset, setConfirmReset] = useState<UserRow | null>(null);

  const usersQ = useQuery<UserRow[]>({
    queryKey: ["users"],
    queryFn: () => api.get<UserRow[]>("/users/").then((r) => r.data),
  });

  const createMut = useMutation({
    mutationFn: () =>
      api
        .post<Creds & { role: string; is_active: boolean }>("/users/", {
          username: newUsername.trim(),
          role: newRole,
        })
        .then((r) => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setCreateOpen(false);
      setNewUsername("");
      setCredsModal({
        id: data.id,
        username: data.username,
        password: data.password,
      });
      toast.success("Аккаунт создан");
    },
    onError: (err: unknown) => setCreateError(apiErrorMessage(err)),
  });

  const resetMut = useMutation({
    mutationFn: (user_id: number) =>
      api.post<Creds>(`/users/${user_id}/reset-password/`).then((r) => r.data),
    onSuccess: (data) => {
      setConfirmReset(null);
      setCredsModal(data);
      toast.success("Пароль сброшен");
    },
    onError: () => toast.error("Не удалось сбросить пароль"),
  });

  const deleteMut = useMutation({
    mutationFn: (user_id: number) => api.post(`/users/${user_id}/delete/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setConfirmDelete(null);
      toast.success("Пользователь деактивирован");
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const rows = usersQ.data ?? [];

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Toolbar */}
      <section className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px] text-muted">
          Управление веб-аккаунтами (менеджеры и тим-лиды). Учётки операторов —
          в карточке оператора.
        </div>
        <Button onClick={() => { setCreateOpen(true); setCreateError(""); }}>
          <Plus className="w-3.5 h-3.5" /> Добавить менеджера
        </Button>
      </section>

      {/* Table */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: "1.4fr .8fr .8fr .8fr auto" }}
        >
          <div>Логин</div>
          <div>Роль</div>
          <div>Создан</div>
          <div>Последний вход</div>
          <div className="text-right">Действия</div>
        </div>

        {usersQ.isLoading ? (
          <div className="text-center text-muted py-12 text-[13px]">Загрузка…</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">Пусто</div>
        ) : (
          <div>
            {rows.map((u, i) => {
              const isMe = u.username === meUsername;
              return (
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
                    <div>
                      <div className="font-medium">{u.username}</div>
                      {isMe && (
                        <div className="text-[10.5px] text-muted">это вы</div>
                      )}
                    </div>
                  </div>
                  <div>
                    <StatusBadge tone={u.role === "manager" ? "hot" : "neutral"}>
                      {ROLE_LABEL[u.role] ?? u.role}
                    </StatusBadge>
                    {u.is_superuser && (
                      <div className="text-[10.5px] text-muted mt-0.5">
                        superuser
                      </div>
                    )}
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
                      title="Сгенерировать новый пароль"
                    >
                      <KeyRound className="w-3.5 h-3.5" /> Пароль
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
                        title="Деактивировать"
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
              Новый менеджер
            </div>
          </div>
          <p className="text-[13px] text-muted mt-1">
            Пароль будет сгенерирован автоматически, покажем один раз.
          </p>

          <div className="mt-5 flex flex-col gap-4">
            <div>
              <div className="nf-col mb-1.5">Логин</div>
              <input
                className="nf-input"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="например: azizbek"
                autoFocus
                autoComplete="off"
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">Роль</div>
              <div className="flex gap-2">
                <Chip
                  active={newRole === "manager"}
                  onClick={() => setNewRole("manager")}
                >
                  Менеджер
                </Chip>
                <Chip
                  active={newRole === "team_lead"}
                  onClick={() => setNewRole("team_lead")}
                >
                  Тим-лид
                </Chip>
              </div>
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
              Отмена
            </Button>
            <Button
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending || !newUsername.trim()}
            >
              {createMut.isPending ? "Создаём…" : "Создать"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Credentials shown once */}
      <Modal open={!!credsModal} onClose={() => setCredsModal(null)} width={460}>
        {credsModal && (
          <div className="p-7">
            <div className="text-[18px] font-semibold tracking-tight">
              Готово · сохраните пароль
            </div>
            <div
              className="mt-3 rounded-xl px-3.5 py-2.5 text-[12.5px]"
              style={{
                background: "rgba(242,86,11,.1)",
                color: "var(--accent)",
                border: "1px solid rgba(242,86,11,.25)",
              }}
            >
              Больше пароль в открытом виде показывать не будем. Сохраните сейчас.
            </div>
            <div className="mt-5 flex flex-col gap-3">
              <CredRow
                label="Логин"
                value={credsModal.username}
                toastText="Логин скопирован"
              />
              <CredRow
                label="Пароль"
                value={credsModal.password}
                toastText="Пароль скопирован"
              />
            </div>
            <div className="mt-6 flex justify-end">
              <Button onClick={() => setCredsModal(null)}>Готово</Button>
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
              Сгенерировать новый пароль?
            </div>
            <div className="text-[13px] text-muted mt-2">
              Старый пароль <b>{confirmReset.username}</b> перестанет работать
              сразу же.
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setConfirmReset(null)}>
                Отмена
              </Button>
              <Button
                onClick={() => resetMut.mutate(confirmReset.id)}
                disabled={resetMut.isPending}
              >
                {resetMut.isPending ? "…" : "Сгенерировать"}
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
              <ShieldOff className="w-4 h-4" /> Деактивировать?
            </div>
            <div className="text-[13px] text-muted mt-2">
              Пользователь <b>{confirmDelete.username}</b> потеряет доступ.
              Данные в аудите остаются, юзера можно позже активировать через
              суперюзера.
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                Отмена
              </Button>
              <Button
                variant="danger"
                onClick={() => deleteMut.mutate(confirmDelete.id)}
                disabled={deleteMut.isPending}
              >
                {deleteMut.isPending ? "…" : "Деактивировать"}
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
        aria-label={`Копировать ${label}`}
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
