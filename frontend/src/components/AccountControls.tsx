import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, KeyRound, Lock, RefreshCcw, Trash2, Unlock, UserPlus } from "lucide-react";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";

/**
 * Account state as rendered next to each Operator row.
 * `has_account=false`         → "no account", show "+ Create login" button.
 * `is_active=true`            → "Активен", show View / Reset / Deactivate / Delete.
 * `is_active=false, !deleted` → "Заблокирован", show Activate / Reset / Delete.
 * `deleted=true`              → "Удалён", show "+ Create login" again.
 */
export type AccountState = {
  has_account: boolean;
  is_active: boolean;
  deleted: boolean;
  username: string | null;
};

type Props = {
  operatorId: number;
  operatorName: string;
  operatorPhone: string;
  account: AccountState | null | undefined;
  canManage: boolean;
};

function generatePassword() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let tail = "";
  for (let i = 0; i < 6; i++) tail += alphabet[bytes[i] % alphabet.length];
  return `Naff-${tail}`;
}

function PasswordField({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        className="input pr-24"
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        autoFocus={autoFocus}
      />
      <div className="absolute inset-y-0 right-2 flex items-center gap-1">
        <button
          type="button"
          className="text-gray-400 hover:text-gray-700 dark:text-slate-500 dark:hover:text-slate-200"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Скрыть" : "Показать"}
          tabIndex={-1}
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
        <button
          type="button"
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          onClick={() => onChange(generatePassword())}
          tabIndex={-1}
        >
          Generate
        </button>
      </div>
    </div>
  );
}

function BigPasswordCard({ password }: { password: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — user can still select the value
    }
  };
  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400 mb-1">
        Пароль
      </div>
      <div className="flex items-center justify-between gap-2">
        <code className="font-mono text-lg select-all break-all">{password}</code>
        <button
          type="button"
          className="btn-ghost text-xs flex items-center gap-1"
          onClick={onCopy}
        >
          <Copy className="w-4 h-4" /> {copied ? "Скопировано" : "Копировать"}
        </button>
      </div>
    </div>
  );
}

export default function AccountControls({
  operatorId,
  operatorName,
  operatorPhone,
  account,
  canManage,
}: Props) {
  const qc = useQueryClient();

  const [modal, setModal] = useState<
    null | "create" | "view" | "reset" | "confirm-delete" | "confirm-deactivate"
  >(null);
  const [password, setPassword] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (modal === "create") setPhoneInput(operatorPhone || "");
  }, [modal, operatorPhone]);

  useEffect(() => {
    if (modal == null) {
      setPassword("");
      setIssued(null);
      setError("");
    }
  }, [modal]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["operators"] });

  const createMut = useMutation({
    mutationFn: async () => {
      const trimmedPhone = phoneInput.trim();
      if (!operatorPhone && !trimmedPhone) {
        throw new Error("phone_required");
      }
      if (trimmedPhone && trimmedPhone !== operatorPhone) {
        await api.patch(`/operators/${operatorId}/`, { phone: trimmedPhone });
      }
      const body = password ? { password } : {};
      const r = await api.post(`/operators/${operatorId}/account/`, body);
      return r.data as { password: string };
    },
    onSuccess: (data) => {
      setIssued(data.password);
      invalidate();
    },
    onError: (err: unknown) => {
      if ((err as Error)?.message === "phone_required") {
        setError("Введите телефон оператора — логин будет = номеру");
        return;
      }
      setError(apiErrorMessage(err));
    },
  });

  const viewMut = useMutation({
    mutationFn: async () => {
      const r = await api.get(`/operators/${operatorId}/account/password/`);
      return r.data as { password: string };
    },
    onSuccess: (data) => setIssued(data.password),
    onError: (err: unknown) => setError(apiErrorMessage(err)),
  });

  const resetMut = useMutation({
    mutationFn: async () => {
      const body = password ? { password } : {};
      const r = await api.post(`/operators/${operatorId}/account/reset-password/`, body);
      return r.data as { password: string };
    },
    onSuccess: (data) => {
      setIssued(data.password);
      invalidate();
    },
    onError: (err: unknown) => {
      setError(apiErrorMessage(err));
    },
  });

  const deactivateMut = useMutation({
    mutationFn: () => api.post(`/operators/${operatorId}/account/deactivate/`),
    onSuccess: () => {
      invalidate();
      setModal(null);
    },
  });

  const activateMut = useMutation({
    mutationFn: () => api.post(`/operators/${operatorId}/account/activate/`),
    onSuccess: () => invalidate(),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/operators/${operatorId}/account/delete/`),
    onSuccess: () => {
      invalidate();
      setModal(null);
    },
  });

  if (!canManage) {
    if (!account?.has_account) {
      return <span className="text-xs text-gray-400 dark:text-slate-600">—</span>;
    }
    return (
      <span
        className={`badge ${
          account.deleted
            ? "bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400"
            : account.is_active
            ? "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
            : "bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300"
        }`}
      >
        {account.deleted ? "Удалён" : account.is_active ? "Активен" : "Заблокирован"}
      </span>
    );
  }

  const hasAccount = !!account?.has_account && !account.deleted;
  const isActive = !!account?.is_active;

  return (
    <>
      {!hasAccount ? (
        <button
          className="btn-ghost text-xs flex items-center gap-1"
          onClick={() => setModal("create")}
        >
          <UserPlus className="w-4 h-4" /> Создать логин
        </button>
      ) : (
        <div className="inline-flex flex-wrap items-center gap-1">
          <span
            className={`badge ${
              isActive
                ? "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                : "bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300"
            }`}
          >
            {isActive ? "Активен" : "Заблокирован"}
          </span>
          <button
            className="btn-ghost text-xs"
            title="Показать пароль"
            aria-label="Показать пароль"
            onClick={() => {
              setModal("view");
              viewMut.mutate();
            }}
          >
            <KeyRound className="w-4 h-4" />
          </button>
          <button
            className="btn-ghost text-xs"
            title="Сбросить пароль"
            aria-label="Сбросить пароль"
            onClick={() => setModal("reset")}
          >
            <RefreshCcw className="w-4 h-4" />
          </button>
          {isActive ? (
            <button
              className="btn-ghost text-xs"
              title="Заблокировать"
              aria-label="Заблокировать"
              onClick={() => setModal("confirm-deactivate")}
            >
              <Lock className="w-4 h-4" />
            </button>
          ) : (
            <button
              className="btn-ghost text-xs"
              title="Разблокировать"
              aria-label="Разблокировать"
              onClick={() => activateMut.mutate()}
            >
              <Unlock className="w-4 h-4" />
            </button>
          )}
          <button
            className="btn-ghost text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
            title="Удалить аккаунт"
            aria-label="Удалить аккаунт"
            onClick={() => setModal("confirm-delete")}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Create modal */}
      {modal === "create" && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50">
          <div className="card p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-semibold">Создать логин для {operatorName}</h2>
            {issued ? (
              <>
                <div className="text-sm text-gray-600 dark:text-slate-400">
                  Логин: <code className="font-mono">{operatorPhone}</code>
                </div>
                <BigPasswordCard password={issued} />
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Пароль виден только сейчас. Позже можно посмотреть его снова через
                  кнопку с ключом — все просмотры логируются в аудит.
                </p>
                <div className="flex justify-end">
                  <button className="btn-primary" onClick={() => setModal(null)}>
                    Готово
                  </button>
                </div>
              </>
            ) : (
              <>
                {operatorPhone ? (
                  <div className="text-sm text-gray-600 dark:text-slate-400">
                    Логин будет установлен равным номеру телефона:{" "}
                    <code className="font-mono">{operatorPhone}</code>
                  </div>
                ) : (
                  <div>
                    <label className="label">
                      Телефон <span className="text-red-500">*</span>
                    </label>
                    <input
                      className="input"
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      placeholder="+998901234567"
                      autoFocus
                    />
                    <div className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                      У оператора не указан телефон. Введите его — он станет логином и сохранится в карточке оператора.
                    </div>
                  </div>
                )}
                <div>
                  <label className="label">Пароль</label>
                  <PasswordField
                    value={password}
                    onChange={setPassword}
                    placeholder="Пусто → сгенерирую сам"
                    autoFocus={!!operatorPhone}
                  />
                  <div className="text-xs text-gray-400 mt-1">
                    Оставьте поле пустым и нажмите Generate — или введите свой (мин. 8 символов).
                  </div>
                </div>
                {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
                <div className="flex justify-end gap-2">
                  <button className="btn-ghost" onClick={() => setModal(null)}>
                    Отмена
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => {
                      setError("");
                      createMut.mutate();
                    }}
                    disabled={createMut.isPending}
                  >
                    {createMut.isPending ? "Создание…" : "Создать"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* View password modal */}
      {modal === "view" && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50">
          <div className="card p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-semibold">Пароль оператора {operatorName}</h2>
            {viewMut.isPending && (
              <div className="text-sm text-gray-500 dark:text-slate-400">Загрузка…</div>
            )}
            {issued && <BigPasswordCard password={issued} />}
            {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Просмотр залогирован в аудит.
            </p>
            <div className="flex justify-end">
              <button className="btn-primary" onClick={() => setModal(null)}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset password modal */}
      {modal === "reset" && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50">
          <div className="card p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-semibold">Сбросить пароль {operatorName}</h2>
            {issued ? (
              <>
                <BigPasswordCard password={issued} />
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Пароль изменён. Передайте новый пароль оператору.
                </p>
                <div className="flex justify-end">
                  <button className="btn-primary" onClick={() => setModal(null)}>
                    Готово
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="label">Новый пароль</label>
                  <PasswordField
                    value={password}
                    onChange={setPassword}
                    placeholder="Пусто → сгенерирую сам"
                    autoFocus
                  />
                </div>
                {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
                <div className="flex justify-end gap-2">
                  <button className="btn-ghost" onClick={() => setModal(null)}>
                    Отмена
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => {
                      setError("");
                      resetMut.mutate();
                    }}
                    disabled={resetMut.isPending}
                  >
                    {resetMut.isPending ? "Сохранение…" : "Сбросить"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Confirm deactivate */}
      {modal === "confirm-deactivate" && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50">
          <div className="card p-6 w-full max-w-sm space-y-4">
            <h2 className="text-lg font-semibold">Заблокировать вход</h2>
            <p className="text-sm text-gray-600 dark:text-slate-400">
              Оператор <span className="font-medium">{operatorName}</span> не сможет войти в систему до разблокировки.
              История продаж и лидов сохраняется.
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setModal(null)}>
                Отмена
              </button>
              <button
                className="btn-primary bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700"
                onClick={() => deactivateMut.mutate()}
                disabled={deactivateMut.isPending}
              >
                {deactivateMut.isPending ? "…" : "Заблокировать"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete */}
      {modal === "confirm-delete" && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50">
          <div className="card p-6 w-full max-w-sm space-y-4">
            <h2 className="text-lg font-semibold">Удалить аккаунт</h2>
            <p className="text-sm text-gray-600 dark:text-slate-400">
              Аккаунт будет заблокирован, сохранённый пароль стёрт. История действий
              в аудите останется. Оператор <span className="font-medium">{operatorName}</span> потеряет доступ к системе.
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setModal(null)}>
                Отмена
              </button>
              <button
                className="btn-primary bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700"
                onClick={() => deleteMut.mutate()}
                disabled={deleteMut.isPending}
              >
                {deleteMut.isPending ? "…" : "Удалить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
