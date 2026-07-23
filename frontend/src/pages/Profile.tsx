import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, MessageCircle } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { tgStatus, tgRevoke, TG_STATUS_KEY } from "../lib/tgUserclient";
import TgConnectWizard from "../components/TgConnectWizard";
import { StickerPicker } from "../components/StickerPicker";

type Me = {
  username: string;
  role: string;
  is_superuser: boolean;
  operator_id: number | null;
  operator_name: string | null;
  telegram_user_id: number | null;
};

const ROLE_LABEL: Record<string, string> = {
  team_lead: "Тимлид",
  manager: "Менеджер",
  operator: "Оператор",
};

function PasswordInput({
  value,
  onChange,
  autoFocus,
  autoComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  autoComplete?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        className="input pr-10"
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="absolute inset-y-0 right-2 flex items-center text-gray-400 dark:text-slate-500 hover:text-gray-700"
        aria-label={show ? "Скрыть пароль" : "Показать пароль"}
        tabIndex={-1}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

export default function Profile() {
  const auth = useAuth();
  const qc = useQueryClient();
  const me = useQuery<Me>({
    queryKey: ["me"],
    queryFn: () => api.get("/auth/me/").then((r) => r.data),
  });

  const mySticker = useQuery<{ sticker: { emoji: string; is_rare: boolean } | null }>({
    queryKey: ["me", "sticker"],
    queryFn: () => api.get("/me/sticker/").then((r) => r.data),
    enabled: !!me.data?.operator_id,
  });
  const [stickerOpen, setStickerOpen] = useState(false);

  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const queryClient = useQueryClient();
  const [wizardOpen, setWizardOpen] = useState(false);
  const tgStatusQ = useQuery({
    queryKey: TG_STATUS_KEY(),
    queryFn: () => tgStatus().then((r) => r.data),
  });
  const revokeMut = useMutation({
    mutationFn: (sessionId: number) => tgRevoke(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TG_STATUS_KEY() });
      tgStatusQ.refetch();
    },
  });

  const change = useMutation({
    mutationFn: () =>
      api.post("/me/change-password/", {
        old_password: oldPwd,
        new_password: newPwd,
      }),
    onSuccess: () => {
      setStatus({ kind: "ok", text: "Пароль обновлён" });
      setOldPwd("");
      setNewPwd("");
      setConfirmPwd("");
    },
    onError: (err: any) => {
      const d = err?.response?.data;
      const text =
        d?.old_password?.[0] ||
        d?.new_password?.[0] ||
        d?.detail ||
        "Не удалось изменить пароль";
      setStatus({ kind: "err", text });
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    if (newPwd.length < 8) {
      setStatus({ kind: "err", text: "Новый пароль должен быть не короче 8 символов" });
      return;
    }
    if (newPwd !== confirmPwd) {
      setStatus({ kind: "err", text: "Пароли не совпадают" });
      return;
    }
    change.mutate();
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-semibold">Мой профиль</h1>

      <div className="card p-6 space-y-3">
        <h2 className="text-lg font-semibold">Аккаунт</h2>
        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <div className="text-gray-500 dark:text-slate-400">Логин</div>
          <div className="font-mono">{me.data?.username || auth.username}</div>
          <div className="text-gray-500 dark:text-slate-400">Роль</div>
          <div>{ROLE_LABEL[me.data?.role || auth.role || ""] || me.data?.role}</div>
          {me.data?.operator_name && (
            <>
              <div className="text-gray-500 dark:text-slate-400">Оператор</div>
              <div>{me.data.operator_name}</div>
            </>
          )}
          {me.data?.telegram_user_id && (
            <>
              <div className="text-gray-500 dark:text-slate-400">Telegram ID</div>
              <div className="font-mono">{me.data.telegram_user_id}</div>
            </>
          )}
        </div>
      </div>

      {me.data?.operator_id && (
        <div className="card p-6 space-y-3">
          <h2 className="text-lg font-semibold">Мой стикер</h2>
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 flex items-center justify-center text-4xl border rounded-lg border-gray-200 dark:border-slate-700">
              {mySticker.data?.sticker?.emoji || (
                <span className="text-gray-300 text-sm">нет</span>
              )}
            </div>
            <div className="flex-1">
              <div className="text-sm text-gray-500 dark:text-slate-400">
                Ваш личный стикер отображается рядом с именем во всех разделах.
              </div>
              {mySticker.data?.sticker?.is_rare && (
                <div className="text-xs text-amber-500 mt-1">Rare — уникальный на всю систему</div>
              )}
            </div>
            <button className="btn-secondary" onClick={() => setStickerOpen(true)}>
              Изменить
            </button>
          </div>
        </div>
      )}

      {stickerOpen && (
        <StickerPicker
          operatorId={null}
          currentEmoji={mySticker.data?.sticker?.emoji ?? null}
          currentIsRare={mySticker.data?.sticker?.is_rare ?? false}
          onChanged={() => mySticker.refetch()}
          onClose={() => setStickerOpen(false)}
        />
      )}

      <form onSubmit={onSubmit} className="card p-6 space-y-4">
        <h2 className="text-lg font-semibold">Смена пароля</h2>
        <div>
          <label className="label">Текущий пароль</label>
          <PasswordInput
            value={oldPwd}
            onChange={setOldPwd}
            autoComplete="current-password"
            autoFocus
          />
        </div>
        <div>
          <label className="label">Новый пароль</label>
          <PasswordInput value={newPwd} onChange={setNewPwd} autoComplete="new-password" />
          <div className="text-xs text-gray-400 mt-1">Минимум 8 символов.</div>
        </div>
        <div>
          <label className="label">Повторите новый пароль</label>
          <PasswordInput
            value={confirmPwd}
            onChange={setConfirmPwd}
            autoComplete="new-password"
          />
        </div>
        {status && (
          <div
            className={
              status.kind === "ok"
                ? "text-sm text-emerald-700 dark:text-emerald-400"
                : "text-sm text-red-600 dark:text-red-400"
            }
          >
            {status.text}
          </div>
        )}
        <div className="flex justify-end">
          <button
            className="btn-primary"
            disabled={change.isPending || !oldPwd || !newPwd || !confirmPwd}
          >
            {change.isPending ? "Сохранение…" : "Сменить пароль"}
          </button>
        </div>
      </form>

      <div className="card p-6 space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <MessageCircle className="w-5 h-5" /> Telegram для анализа
        </h2>
        {tgStatusQ.isLoading ? (
          <div>Загрузка...</div>
        ) : tgStatusQ.data?.status === 'active' ? (
          <div>
            <p className="text-emerald-600 dark:text-emerald-400 font-medium">
              Подключено. Аккаунт @{tgStatusQ.data.tg_username}. Последняя активность: {tgStatusQ.data.last_connected_at ? new Date(tgStatusQ.data.last_connected_at).toLocaleString('ru-RU') : '—'}
            </p>
            {tgStatusQ.data.latest_backfill_job && (
              <div className="mt-2 text-xs text-gray-600 dark:text-slate-400">
                {tgStatusQ.data.latest_backfill_job.status === "running" && (
                  <span className="text-amber-600 dark:text-amber-400">
                    ⏳ Загружаем историю переписок... Пройдено чатов: {tgStatusQ.data.latest_backfill_job.chats_scanned}, сохранено сообщений: {tgStatusQ.data.latest_backfill_job.messages_saved}
                  </span>
                )}
                {tgStatusQ.data.latest_backfill_job.status === "pending" && (
                  <span className="text-amber-600 dark:text-amber-400">
                    ⏳ В очереди на загрузку истории переписок...
                  </span>
                )}
                {tgStatusQ.data.latest_backfill_job.status === "done" && (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    ✓ История загружена ({tgStatusQ.data.latest_backfill_job.chats_scanned} чатов, {tgStatusQ.data.latest_backfill_job.messages_saved} сообщений)
                  </span>
                )}
                {tgStatusQ.data.latest_backfill_job.status === "error" && (
                  <span className="text-red-500">
                    ⚠ Ошибка загрузки истории: {tgStatusQ.data.latest_backfill_job.last_error}
                  </span>
                )}
              </div>
            )}
            <button
              className="btn-ghost text-red-500 mt-3"
              onClick={() => tgStatusQ.data?.session_id && revokeMut.mutate(tgStatusQ.data.session_id)}
              disabled={revokeMut.isPending}
            >
              Отключить
            </button>
          </div>
        ) : tgStatusQ.data?.status === 'error' ? (
          <div>
            <p className="text-red-500 font-medium">
              Ошибка: {tgStatusQ.data.last_error || 'Неизвестная ошибка'}
            </p>
            <button className="btn-primary mt-3" onClick={() => setWizardOpen(true)}>
              Переподключить
            </button>
          </div>
        ) : (
          <div>
            <p className="text-gray-500 dark:text-slate-400 mb-3">
              Подключите Telegram, чтобы система могла анализировать ваши переписки с клиентами.
            </p>
            <button className="btn-primary" onClick={() => setWizardOpen(true)}>
              Подключить Telegram
            </button>
          </div>
        )}
      </div>

      {wizardOpen && (
        <TgConnectWizard
          onClose={() => setWizardOpen(false)}
          onSuccess={() => {
            tgStatusQ.refetch();
          }}
        />
      )}
    </div>
  );
}
