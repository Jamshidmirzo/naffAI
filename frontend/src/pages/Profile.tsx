import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, LogIn, LogOut, PlayCircle, QrCode } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { useTheme } from "../store/theme";
import { useLang } from "../store/lang";
import { tgStatus, tgRevoke, TG_STATUS_KEY } from "../lib/tgUserclient";
import TgConnectWizard from "../components/TgConnectWizard";
import { StickerPicker } from "../components/StickerPicker";
import DateInput from "../components/DateInput";
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
import { useT } from "../lib/i18n";
import { formatDateTime } from "../lib/format";

type Me = {
  username: string;
  role: string;
  is_superuser: boolean;
  operator_id: number | null;
  operator_name: string | null;
  telegram_user_id: number | null;
  birth_date: string | null;
  is_birthday_today: boolean;
};

type Preferences = {
  daily_lesson_opt_out: boolean;
};

function roleLabel(t: (k: string) => string, role: string): string {
  if (role === "operator") return t("profile.role_operator");
  if (role === "manager" || role === "team_lead") return t("profile.role_manager");
  return role;
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

export default function Profile() {
  const t = useT();
  const auth = useAuth();
  const nav = useNavigate();
  const theme = useTheme();
  const lang = useLang();
  const qc = useQueryClient();

  usePageHeader({ title: t("profile.title"), subtitle: t("profile.subtitle") });

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
      toast.success(t("profile.saved"));
      qc.invalidateQueries({ queryKey: ["me", "preferences"] });
    },
    onError: (_err, nextEnabled) => {
      setDailyLessonEnabled(!nextEnabled);
      toast.error(t("profile.settings_save_failed"));
    },
  });

  // --- Attendance mini-card (operator only) ---
  type MeCur = {
    open_log: { id: number; checked_in_at: string; was_late: boolean } | null;
  };
  const meCur = useQuery<MeCur>({
    queryKey: ["me", "attendance"],
    queryFn: () => api.get<MeCur>("/attendance/me/current/").then((r) => r.data),
    enabled: !!me.data?.operator_id,
    refetchInterval: 60_000,
  });
  const [attCooldown, setAttCooldown] = useState(0);
  useEffect(() => {
    if (attCooldown <= 0) return;
    const id = setInterval(() => setAttCooldown((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(id);
  }, [attCooldown]);
  const attToggle = useMutation({
    mutationFn: () =>
      api
        .post<{ action: "check_in" | "check_out"; was_late?: boolean; duration_min?: number }>(
          "/attendance/me/toggle/",
        )
        .then((r) => r.data),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["me", "attendance"] });
      setAttCooldown(30);
      toast.success(
        d.action === "check_in"
          ? d.was_late
            ? "🟢 Приход отмечен · опоздание"
            : "🟢 Приход отмечен"
          : `🔴 Уход отмечен${d.duration_min ? ` · смена ${Math.round(d.duration_min / 60 * 10) / 10} ч` : ""}`,
      );
    },
    onError: (e: unknown) => {
      const msg =
        (e as { response?: { data?: { error?: string; detail?: string } } })?.response?.data?.error ||
        (e as { response?: { data?: { error?: string; detail?: string } } })?.response?.data?.detail ||
        "Ошибка check-in/out";
      toast.error(msg);
      if (/секунд/i.test(String(msg))) setAttCooldown(30);
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
      toast.success(t("profile.tg_disconnected"));
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
              <span>{role ? roleLabel(t, role) : "—"}</span>
              {stickerEmoji && (
                <>
                  <span>·</span>
                  <span
                    className="text-[16px] leading-none"
                    title={mySticker.data?.sticker?.is_rare ? t("profile.rare_sticker") : t("profile.sticker")}
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
              <QrCode className="w-4 h-4" /> {t("profile.qr_checkin")}
            </Button>
          )}
        </div>
      </section>

      {/* --- Attendance (operator only) --- */}
      {me.data?.operator_id && (() => {
        const open = meCur.data?.open_log;
        const isIn = !!open;
        const startedAt = open ? new Date(open.checked_in_at) : null;
        const runMin = startedAt
          ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 60000))
          : 0;
        const runH = Math.floor(runMin / 60);
        const runRest = runMin % 60;
        return (
          <section
            className="nf-card animate-nfFadeUp"
            style={{ padding: 20, animationDelay: "0.03s" }}
          >
            <div className="flex items-center gap-4">
              <div
                className="shrink-0 grid place-items-center rounded-2xl"
                style={{
                  width: 56,
                  height: 56,
                  background: isIn ? "rgba(34,197,94,.14)" : "rgba(148,163,184,.18)",
                }}
              >
                {isIn ? (
                  <PlayCircle className="w-8 h-8" style={{ color: "#16a34a" }} />
                ) : (
                  <LogOut className="w-8 h-8" style={{ color: "#94a3b8" }} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] uppercase tracking-widest font-semibold text-muted">
                  {isIn ? "СМЕНА ИДЁТ" : "СМЕНА ЗАКРЫТА"}
                </div>
                {isIn && startedAt ? (
                  <div className="text-[14px] mt-0.5">
                    Пришёл в{" "}
                    <b className="tabular-nums">
                      {startedAt.toLocaleTimeString("ru-RU", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </b>
                    {" · "}
                    <span className="text-muted tabular-nums">
                      {runH > 0 ? `${runH} ч ${runRest} мин` : `${runRest} мин`}
                    </span>
                    {open.was_late && (
                      <span
                        className="ml-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        style={{
                          background: "rgba(220,38,38,.14)",
                          color: "#dc2626",
                        }}
                      >
                        ⚠ ОПОЗДАНИЕ
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="text-[13px] text-muted mt-0.5">
                    Нажми чтобы начать смену
                  </div>
                )}
              </div>
              <button
                onClick={() => attToggle.mutate()}
                disabled={attToggle.isPending || attCooldown > 0}
                className="rounded-2xl font-bold text-white transition-all active:scale-[.98] disabled:opacity-70 inline-flex items-center gap-2"
                style={{
                  padding: "12px 20px",
                  fontSize: 14,
                  background:
                    attCooldown > 0
                      ? "linear-gradient(180deg, #64748b, #475569)"
                      : isIn
                        ? "linear-gradient(180deg, #dc2626, #b91c1c)"
                        : "linear-gradient(180deg, #16a34a, #15803d)",
                  boxShadow:
                    attCooldown > 0
                      ? "0 6px 16px -10px rgba(0,0,0,.4)"
                      : isIn
                        ? "0 8px 22px -12px rgba(220,38,38,.55)"
                        : "0 8px 22px -12px rgba(34,197,94,.55)",
                }}
              >
                {attToggle.isPending ? (
                  "…"
                ) : attCooldown > 0 ? (
                  <>⏱ {attCooldown} сек</>
                ) : isIn ? (
                  <>
                    <LogOut className="w-4 h-4" /> Завершить смену
                  </>
                ) : (
                  <>
                    <LogIn className="w-4 h-4" /> Начать смену
                  </>
                )}
              </button>
            </div>
          </section>
        );
      })()}

      {/* --- Мои данные (только оператор) --- */}
      {me.data?.operator_id && (
        <BirthDateSection
          currentBirthDate={me.data.birth_date ?? null}
          onSaved={() => {
            // Инвалидируем оба ключа /auth/me — тот, что использует
            // Profile.tsx (["me"]), и общий (["auth","me"] в useMe),
            // чтобы AppShell → BirthdayCelebration сразу увидел
            // is_birthday_today=true, если оператор ввёл сегодняшнюю дату.
            qc.invalidateQueries({ queryKey: ["me"] });
            qc.invalidateQueries({ queryKey: ["auth", "me"] });
          }}
        />
      )}

      {/* --- Settings --- */}
      <section
        className="nf-card animate-nfFadeUp"
        style={{ padding: "8px 4px", animationDelay: "0.05s" }}
      >
        <div className="px-6 pt-4 pb-2 text-[13.5px] font-semibold">{t("profile.section_settings")}</div>
        <SettingRow
          label={t("profile.theme")}
          hint={t("profile.theme_hint")}
          control={
            <TabPill
              value={theme.theme}
              onChange={(v) => theme.set(v)}
              items={[
                { value: "light", label: t("profile.theme_light") },
                { value: "dark", label: t("profile.theme_dark") },
              ]}
            />
          }
        />
        <SettingRow
          label={t("profile.language")}
          hint={t("profile.language_hint")}
          control={
            <TabPill
              value={lang.lang}
              onChange={(v) => {
                lang.set(v);
                toast.success(t("profile.lang_switched"));
              }}
              items={[
                { value: "ru", label: t("profile.lang_ru") },
                { value: "uz", label: t("profile.lang_uz") },
              ]}
            />
          }
        />
        {me.data?.operator_id && (
          <SettingRow
            label={t("profile.daily_analysis")}
            hint={t("profile.daily_analysis_hint")}
            control={
              <Toggle
                on={dailyLessonEnabled}
                onChange={(v) => updatePref.mutate(v)}
                disabled={prefs.isLoading || updatePref.isPending}
                aria-label={t("profile.daily_analysis")}
              />
            }
          />
        )}
        {me.data?.operator_id && (
          <SettingRow
            label={t("profile.my_sticker")}
            hint={
              mySticker.data?.sticker
                ? t("profile.sticker_shown_next_to_name")
                : t("profile.sticker_none")
            }
            control={
              <Button variant="ghost" onClick={() => setStickerOpen(true)}>
                {stickerEmoji ? `${stickerEmoji}  ${t("common.edit")}` : t("common.select")}
              </Button>
            }
          />
        )}
        <SettingRow
          label={t("common.password")}
          hint={t("profile.password_hint")}
          control={
            <Button variant="ghost" onClick={() => setPwdOpen(true)}>
              {t("common.reset")}
            </Button>
          }
          last
        />
      </section>

      {/* --- Telegram DM notifications (bot) --- */}
      <TelegramBotSection
        me={me.data}
        onLinked={() => me.refetch()}
      />

      {/* --- Telegram --- */}
      {me.data?.operator_id && (
        <section
          className="nf-card animate-nfFadeUp"
          style={{ padding: "22px 26px", animationDelay: "0.1s" }}
        >
          <Eyebrow>Telegram</Eyebrow>
          <div className="text-[15px] font-semibold mt-2">{t("tg.connect_title")}</div>
          <p className="text-[13px] text-muted mt-1.5 max-w-md">
            {t("profile.tg_hint")}
          </p>

          {tgStatusQ.isLoading ? (
            <div className="mt-4 text-[13px] text-muted">{t("profile.tg_checking")}</div>
          ) : tgStatusQ.data?.status === "active" ? (
            <div className="mt-4">
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge tone="hot">{t("profile.tg_connected")}</StatusBadge>
                <span className="text-[13px]">
                  @{tgStatusQ.data.tg_username}
                </span>
                {tgStatusQ.data.last_connected_at && (
                  <span className="text-[12px] text-muted">
                    · {formatDateTime(tgStatusQ.data.last_connected_at)}
                  </span>
                )}
              </div>
              {tgStatusQ.data.latest_backfill_job && (
                <div className="mt-3 text-[12.5px]">
                  {tgStatusQ.data.latest_backfill_job.status === "running" && (
                    <span style={{ color: "var(--accent)" }}>
                      ⏳ {t("profile.tg_backfill_running", {
                        chats: tgStatusQ.data.latest_backfill_job.chats_scanned,
                        msgs: tgStatusQ.data.latest_backfill_job.messages_saved,
                      })}
                    </span>
                  )}
                  {tgStatusQ.data.latest_backfill_job.status === "pending" && (
                    <span style={{ color: "var(--accent)" }}>
                      ⏳ {t("profile.tg_backfill_pending")}
                    </span>
                  )}
                  {tgStatusQ.data.latest_backfill_job.status === "done" && (
                    <span className="text-muted">
                      ✓ {t("profile.tg_backfill_done", {
                        chats: tgStatusQ.data.latest_backfill_job.chats_scanned,
                        msgs: tgStatusQ.data.latest_backfill_job.messages_saved,
                      })}
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
                  {t("profile.tg_disconnect")}
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
                {tgStatusQ.data.last_error || t("profile.tg_unknown_error")}
              </div>
              <div className="mt-3">
                <Button onClick={() => setWizardOpen(true)}>{t("profile.tg_reconnect")}</Button>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <Button onClick={() => setWizardOpen(true)}>{t("profile.tg_connect")}</Button>
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

function TelegramBotSection({
  me,
  onLinked,
}: {
  me: Me | undefined;
  onLinked: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const linked = !!me?.telegram_user_id;
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const genMut = useMutation({
    mutationFn: () =>
      api.post<{ code: string; expires_at: string; bot_username: string }>(
        "/me/telegram/link/",
      ).then((r) => r.data),
    onSuccess: (data) => {
      setCode(data.code);
    },
  });
  const unlinkMut = useMutation({
    mutationFn: () => api.delete("/me/telegram/link/"),
    onSuccess: () => {
      setCode(null);
      qc.invalidateQueries({ queryKey: ["me"] });
      onLinked();
      toast.success(t("profile.tg_notif_unlinked"));
    },
  });

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <section
      className="nf-card animate-nfFadeUp"
      style={{ padding: "22px 26px", animationDelay: "0.08s" }}
    >
      <Eyebrow>Telegram-bot</Eyebrow>
      <div className="text-[15px] font-semibold mt-2">
        {t("profile.tg_notif_title")}
      </div>
      <p className="text-[13px] text-muted mt-1.5 max-w-md">
        {t("profile.tg_notif_hint")}
      </p>

      {linked ? (
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <StatusBadge tone="hot">✓ {t("profile.tg_notif_active")}</StatusBadge>
          <span className="text-[12.5px] text-muted font-mono">
            chat_id: {me?.telegram_user_id}
          </span>
          <Button
            variant="ghost"
            onClick={() => unlinkMut.mutate()}
            disabled={unlinkMut.isPending}
          >
            {t("profile.tg_notif_unlink")}
          </Button>
        </div>
      ) : code ? (
        <div className="mt-4 flex flex-col gap-3">
          <div
            className="rounded-2xl px-5 py-4 flex items-center gap-3 flex-wrap"
            style={{
              background: "var(--faint)",
              border: "1px solid var(--border)",
            }}
          >
            <div
              className="font-mono tabular-nums tracking-[.3em] font-bold"
              style={{ fontSize: 26 }}
            >
              {code}
            </div>
            <button
              type="button"
              className="nf-btn nf-btn--ghost text-[12px]"
              onClick={copyCode}
            >
              {copied ? t("common.copied") : t("common.copy")}
            </button>
          </div>
          <div
            className="text-[13px] leading-relaxed"
            style={{ color: "var(--text)" }}
          >
            {t("profile.tg_notif_step1")}{" "}
            <a
              href="https://t.me/naffai_bot"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--accent)", fontWeight: 600 }}
            >
              @naffai_bot
            </a>
            <br />
            {t("profile.tg_notif_step2")}{" "}
            <code
              className="font-mono"
              style={{ background: "var(--faint)", padding: "2px 6px", borderRadius: 6 }}
            >
              /link {code}
            </code>
          </div>
          <div className="text-[11.5px] text-muted">
            {t("profile.tg_notif_expires")}
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <Button onClick={() => genMut.mutate()} disabled={genMut.isPending}>
            {genMut.isPending ? t("common.loading") : t("profile.tg_notif_get_code")}
          </Button>
        </div>
      )}
    </section>
  );
}

function BirthDateSection({
  currentBirthDate,
  onSaved,
}: {
  currentBirthDate: string | null;
  onSaved: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string>(currentBirthDate || "");

  useEffect(() => {
    setValue(currentBirthDate || "");
  }, [currentBirthDate]);

  const save = useMutation({
    mutationFn: (birthDate: string | null) =>
      api.patch("/auth/me/", { birth_date: birthDate }).then((r) => r.data),
    onSuccess: () => {
      toast.success(t("profile.saved"));
      setEditing(false);
      onSaved();
    },
    onError: (e: unknown) => {
      const detail =
        (e as { response?: { data?: { birth_date?: string } } })?.response?.data
          ?.birth_date || t("profile.settings_save_failed");
      toast.error(String(detail));
    },
  });

  const currentDisplay = currentBirthDate
    ? new Date(currentBirthDate).toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : null;

  return (
    <section
      className="nf-card animate-nfFadeUp"
      style={{ padding: "22px 26px", animationDelay: "0.04s" }}
    >
      <Eyebrow>{t("profile.section_personal")}</Eyebrow>
      <div className="text-[15px] font-semibold mt-2">{t("profile.birth_date_title")}</div>
      <p className="text-[13px] text-muted mt-1.5 max-w-md">
        {t("profile.birth_date_hint")}
      </p>

      {!editing ? (
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <div
            className="rounded-xl px-4 py-2 text-[14px] font-medium"
            style={{
              background: "var(--faint)",
              border: "1px solid var(--border)",
            }}
          >
            {currentDisplay ?? t("profile.birth_date_empty")}
          </div>
          <Button variant="ghost" onClick={() => setEditing(true)}>
            {currentDisplay ? t("common.edit") : t("common.select")}
          </Button>
          {currentDisplay && (
            <Button
              variant="ghost"
              onClick={() => save.mutate(null)}
              disabled={save.isPending}
            >
              {t("common.remove")}
            </Button>
          )}
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <div style={{ maxWidth: 240 }}>
            <DateInput
              value={value}
              onChange={setValue}
              ariaLabel={t("profile.birth_date_title")}
              allowClear
            />
          </div>
          <Button
            onClick={() => save.mutate(value || null)}
            disabled={save.isPending}
          >
            {save.isPending ? t("common.saving") : t("common.save")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setValue(currentBirthDate || "");
              setEditing(false);
            }}
            disabled={save.isPending}
          >
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </section>
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
  const t = useT();
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
        aria-label={show ? t("profile.hide_password") : t("profile.show_password")}
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
  const t = useT();
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
      toast.success(t("profile.password_updated"));
      onClose();
    },
    onError: (err: unknown) => {
      const d = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const text =
        (d?.old_password as string[] | undefined)?.[0] ||
        (d?.new_password as string[] | undefined)?.[0] ||
        (d?.detail as string | undefined) ||
        t("profile.password_change_failed");
      setError(text);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPwd.length < 8) {
      setError(t("profile.password_too_short"));
      return;
    }
    if (newPwd !== confirmPwd) {
      setError(t("profile.password_mismatch"));
      return;
    }
    change.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} width={440}>
      <form onSubmit={submit} className="p-7">
        <div className="text-[18px] font-semibold tracking-tight">{t("profile.password_change_title")}</div>
        <p className="text-[13px] text-muted mt-1">
          {t("profile.password_change_min")}
        </p>
        <div className="mt-5 flex flex-col gap-4">
          <div>
            <div className="nf-col mb-1.5">{t("profile.current_password")}</div>
            <PasswordInput
              value={oldPwd}
              onChange={setOldPwd}
              autoComplete="current-password"
              autoFocus
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("profile.new_password")}</div>
            <PasswordInput
              value={newPwd}
              onChange={setNewPwd}
              autoComplete="new-password"
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("profile.password_confirm")}</div>
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
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={change.isPending || !oldPwd || !newPwd || !confirmPwd}
          >
            {change.isPending ? t("common.saving") : t("profile.password_change_submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
