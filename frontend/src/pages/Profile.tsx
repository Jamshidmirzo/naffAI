import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, QrCode } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { useTheme } from "../store/theme";
import { useLang } from "../store/lang";
import { tgStatus, tgRevoke, TG_STATUS_KEY } from "../lib/tgUserclient";
import TgConnectWizard from "../components/TgConnectWizard";
import { StickerPicker } from "../components/StickerPicker";
import {
  Button,
  Eyebrow,
  Modal,
  StatusBadge,
  TabPill,
  Toggle,
  toast,
} from "../components/ui";
import { usePageHeader } from "../store/page";

type Me = {
  username: string;
  role: string;
  is_superuser: boolean;
  operator_id: number | null;
  operator_name: string | null;
  telegram_user_id: number | null;
};

type Preferences = {
  daily_lesson_opt_out: boolean;
};

const ROLE_LABEL: Record<string, string> = {
  manager: "Менеджер",
  team_lead: "Менеджер",
  operator: "Оператор",
};

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

export default function Profile() {
  const auth = useAuth();
  const nav = useNavigate();
  const theme = useTheme();
  const lang = useLang();
  const qc = useQueryClient();

  usePageHeader({ title: "Профиль", subtitle: "Настройки аккаунта" });

  const me = useQuery<Me>({
    queryKey: ["me"],
    queryFn: () => api.get("/auth/me/").then((r) => r.data),
  });

  const mySticker = useQuery<{
    sticker: { emoji: string; is_rare: boolean } | null;
  }>({
    queryKey: ["me", "sticker"],
    queryFn: () => api.get("/me/sticker/").then((r) => r.data),
    enabled: !!me.data?.operator_id,
  });

  const [stickerOpen, setStickerOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  const prefs = useQuery<Preferences>({
    queryKey: ["me", "preferences"],
    queryFn: () => api.get("/me/preferences/").then((r) => r.data),
    enabled: !!me.data?.operator_id,
  });

  const [dailyLessonEnabled, setDailyLessonEnabled] = useState<boolean>(true);
  useEffect(() => {
    if (prefs.data) setDailyLessonEnabled(!prefs.data.daily_lesson_opt_out);
  }, [prefs.data]);

  const updatePref = useMutation({
    mutationFn: (nextEnabled: boolean) =>
      api.patch("/me/preferences/", { daily_lesson_opt_out: !nextEnabled }),
    onMutate: (nextEnabled: boolean) => setDailyLessonEnabled(nextEnabled),
    onSuccess: () => {
      toast.success("Настройка сохранена");
      qc.invalidateQueries({ queryKey: ["me", "preferences"] });
    },
    onError: (_err, nextEnabled) => {
      setDailyLessonEnabled(!nextEnabled);
      toast.error("Не удалось сохранить настройку");
    },
  });

  const tgStatusQ = useQuery({
    queryKey: TG_STATUS_KEY(),
    queryFn: () => tgStatus().then((r) => r.data),
  });

  const revokeMut = useMutation({
    mutationFn: (sessionId: number) => tgRevoke(sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TG_STATUS_KEY() });
      tgStatusQ.refetch();
      toast.success("Telegram отключён");
    },
  });

  const displayName =
    me.data?.operator_name || me.data?.username || auth.username || "?";
  const role = me.data?.role || auth.role || "";
  const stickerEmoji = mySticker.data?.sticker?.emoji;

  return (
    <div className="mx-auto max-w-[760px] flex flex-col gap-5">
      {/* --- HERO --- */}
      <section
        className="nf-hero animate-nfFadeUp"
        style={{
          borderRadius: 30,
          padding: "30px 32px",
          border: "1px solid var(--border)",
        }}
      >
        <div className="flex items-center gap-5 flex-wrap">
          <div
            className="grid place-items-center text-white font-semibold shrink-0"
            style={{
              width: 62,
              height: 62,
              borderRadius: 18,
              background: "var(--accent-grad)",
              fontSize: 22,
              boxShadow: "0 14px 30px -14px var(--accent)",
            }}
          >
            {initials(displayName)}
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="font-semibold truncate"
              style={{ fontSize: 24, letterSpacing: "-0.025em" }}
            >
              {displayName}
            </div>
            <div className="mt-1 flex items-center gap-2 flex-wrap text-[13px] text-muted">
              <span>{ROLE_LABEL[role] || role || "—"}</span>
              {stickerEmoji && (
                <>
                  <span>·</span>
                  <span
                    className="text-[16px] leading-none"
                    title={mySticker.data?.sticker?.is_rare ? "Rare-стикер" : "Стикер"}
                  >
                    {stickerEmoji}
                  </span>
                  {mySticker.data?.sticker?.is_rare && (
                    <StatusBadge tone="hot">rare</StatusBadge>
                  )}
                </>
              )}
            </div>
          </div>
          {me.data?.operator_id && (
            <Button variant="secondary" onClick={() => nav("/scan")}>
              <QrCode className="w-4 h-4" /> QR check-in
            </Button>
          )}
        </div>
      </section>

      {/* --- Settings --- */}
      <section
        className="nf-card animate-nfFadeUp"
        style={{ padding: "8px 4px", animationDelay: "0.05s" }}
      >
        <div className="px-6 pt-4 pb-2 text-[13.5px] font-semibold">Настройки</div>
        <SettingRow
          label="Тема"
          hint="Светлая или тёмная"
          control={
            <TabPill
              value={theme.theme}
              onChange={(v) => theme.set(v)}
              items={[
                { value: "light", label: "Светлая" },
                { value: "dark", label: "Тёмная" },
              ]}
            />
          }
        />
        <SettingRow
          label="Язык"
          hint="Язык интерфейса"
          control={
            <TabPill
              value={lang.lang}
              onChange={(v) => {
                lang.set(v);
                toast.success("Язык переключён");
              }}
              items={[
                { value: "ru", label: "Русский" },
                { value: "uz", label: "O‘zbekcha" },
              ]}
            />
          }
        />
        {me.data?.operator_id && (
          <SettingRow
            label="Ежедневный разбор"
            hint="Утреннее сообщение с AI-анализом вчерашнего дня"
            control={
              <Toggle
                on={dailyLessonEnabled}
                onChange={(v) => updatePref.mutate(v)}
                disabled={prefs.isLoading || updatePref.isPending}
                aria-label="Ежедневный разбор"
              />
            }
          />
        )}
        {me.data?.operator_id && (
          <SettingRow
            label="Мой стикер"
            hint={
              mySticker.data?.sticker
                ? "Отображается рядом с именем"
                : "Стикер ещё не назначен"
            }
            control={
              <Button variant="ghost" onClick={() => setStickerOpen(true)}>
                {stickerEmoji ? `${stickerEmoji}  Изменить` : "Выбрать"}
              </Button>
            }
          />
        )}
        <SettingRow
          label="Пароль"
          hint="Смена пароля от учётной записи"
          control={
            <Button variant="ghost" onClick={() => setPwdOpen(true)}>
              Сбросить
            </Button>
          }
          last
        />
      </section>

      {/* --- Telegram --- */}
      {me.data?.operator_id && (
        <section
          className="nf-card animate-nfFadeUp"
          style={{ padding: "22px 26px", animationDelay: "0.1s" }}
        >
          <Eyebrow>Telegram</Eyebrow>
          <div className="text-[15px] font-semibold mt-2">Подключение Telegram</div>
          <p className="text-[13px] text-muted mt-1.5 max-w-md">
            Позволяет системе анализировать переписки с клиентами и вести операторские
            уведомления.
          </p>

          {tgStatusQ.isLoading ? (
            <div className="mt-4 text-[13px] text-muted">Проверяем статус…</div>
          ) : tgStatusQ.data?.status === "active" ? (
            <div className="mt-4">
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge tone="hot">подключено</StatusBadge>
                <span className="text-[13px]">
                  @{tgStatusQ.data.tg_username}
                </span>
                {tgStatusQ.data.last_connected_at && (
                  <span className="text-[12px] text-muted">
                    · {new Date(tgStatusQ.data.last_connected_at).toLocaleString("ru-RU")}
                  </span>
                )}
              </div>
              {tgStatusQ.data.latest_backfill_job && (
                <div className="mt-3 text-[12.5px]">
                  {tgStatusQ.data.latest_backfill_job.status === "running" && (
                    <span style={{ color: "var(--accent)" }}>
                      ⏳ Загружаем историю: {tgStatusQ.data.latest_backfill_job.chats_scanned}{" "}
                      чатов, {tgStatusQ.data.latest_backfill_job.messages_saved} сообщений
                    </span>
                  )}
                  {tgStatusQ.data.latest_backfill_job.status === "pending" && (
                    <span style={{ color: "var(--accent)" }}>
                      ⏳ В очереди на загрузку истории
                    </span>
                  )}
                  {tgStatusQ.data.latest_backfill_job.status === "done" && (
                    <span className="text-muted">
                      ✓ История загружена ({tgStatusQ.data.latest_backfill_job.chats_scanned}{" "}
                      чатов, {tgStatusQ.data.latest_backfill_job.messages_saved} сообщений)
                    </span>
                  )}
                  {tgStatusQ.data.latest_backfill_job.status === "error" && (
                    <span style={{ color: "var(--danger)" }}>
                      ⚠ {tgStatusQ.data.latest_backfill_job.last_error}
                    </span>
                  )}
                </div>
              )}
              <div className="mt-4">
                <Button
                  variant="ghost"
                  onClick={() =>
                    tgStatusQ.data?.session_id &&
                    revokeMut.mutate(tgStatusQ.data.session_id)
                  }
                  disabled={revokeMut.isPending}
                >
                  Отключить
                </Button>
              </div>
            </div>
          ) : tgStatusQ.data?.status === "error" ? (
            <div className="mt-4">
              <div
                className="text-[13px] rounded-xl px-3.5 py-2.5"
                style={{
                  background: "rgba(220,60,40,.08)",
                  color: "var(--danger)",
                  border: "1px solid rgba(220,60,40,.2)",
                }}
              >
                {tgStatusQ.data.last_error || "Неизвестная ошибка"}
              </div>
              <div className="mt-3">
                <Button onClick={() => setWizardOpen(true)}>Переподключить</Button>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <Button onClick={() => setWizardOpen(true)}>Подключить Telegram</Button>
            </div>
          )}
        </section>
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

      {wizardOpen && (
        <TgConnectWizard
          onClose={() => setWizardOpen(false)}
          onSuccess={() => tgStatusQ.refetch()}
        />
      )}

      <PasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </div>
  );
}

// -------------------------------------------------------------------------

function SettingRow({
  label,
  hint,
  control,
  last,
}: {
  label: string;
  hint?: string;
  control: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-4 px-6 py-4"
      style={last ? undefined : { borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-medium">{label}</div>
        {hint && <div className="text-[12.5px] text-muted mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function PasswordInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  autoComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  autoComplete?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        className="nf-input pr-11"
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="absolute inset-y-0 right-3 flex items-center text-muted hover:text-text transition"
        tabIndex={-1}
        aria-label={show ? "Скрыть пароль" : "Показать пароль"}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

function PasswordModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setOldPwd("");
      setNewPwd("");
      setConfirmPwd("");
      setError("");
    }
  }, [open]);

  const change = useMutation({
    mutationFn: () =>
      api.post("/me/change-password/", {
        old_password: oldPwd,
        new_password: newPwd,
      }),
    onSuccess: () => {
      toast.success("Пароль обновлён");
      onClose();
    },
    onError: (err: unknown) => {
      const d = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const text =
        (d?.old_password as string[] | undefined)?.[0] ||
        (d?.new_password as string[] | undefined)?.[0] ||
        (d?.detail as string | undefined) ||
        "Не удалось изменить пароль";
      setError(text);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPwd.length < 8) {
      setError("Новый пароль должен быть не короче 8 символов");
      return;
    }
    if (newPwd !== confirmPwd) {
      setError("Пароли не совпадают");
      return;
    }
    change.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} width={440}>
      <form onSubmit={submit} className="p-7">
        <div className="text-[18px] font-semibold tracking-tight">Смена пароля</div>
        <p className="text-[13px] text-muted mt-1">
          Минимум 8 символов
        </p>
        <div className="mt-5 flex flex-col gap-4">
          <div>
            <div className="nf-col mb-1.5">Текущий пароль</div>
            <PasswordInput
              value={oldPwd}
              onChange={setOldPwd}
              autoComplete="current-password"
              autoFocus
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">Новый пароль</div>
            <PasswordInput
              value={newPwd}
              onChange={setNewPwd}
              autoComplete="new-password"
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">Повторите новый пароль</div>
            <PasswordInput
              value={confirmPwd}
              onChange={setConfirmPwd}
              autoComplete="new-password"
            />
          </div>
          {error && (
            <div
              className="text-[13px] rounded-xl px-3.5 py-2.5"
              style={{
                background: "rgba(220,60,40,.08)",
                color: "var(--danger)",
                border: "1px solid rgba(220,60,40,.2)",
              }}
            >
              {error}
            </div>
          )}
        </div>
        <div className="mt-6 flex gap-2 justify-end">
          <Button variant="ghost" type="button" onClick={onClose}>
            Отмена
          </Button>
          <Button
            type="submit"
            disabled={change.isPending || !oldPwd || !newPwd || !confirmPwd}
          >
            {change.isPending ? "Сохранение…" : "Сменить"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
