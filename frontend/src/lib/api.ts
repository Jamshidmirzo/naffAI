import axios, { AxiosError, AxiosRequestConfig } from "axios";
import { toast } from "sonner";

export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string) || "http://localhost:8001/api";

export const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const url = config.url || "";
  // Never attach a stale token to auth endpoints — a bad token there
  // makes DRF reject the request before it reaches the login view.
  if (/\/auth\/(login|logout)/.test(url)) {
    if (config.headers) delete (config.headers as Record<string, unknown>).Authorization;
    return config;
  }
  const token = localStorage.getItem("naffai_token");
  if (token) config.headers.Authorization = `Token ${token}`;
  return config;
});

// Wave-1 (2026-08-22): 401 больше не выкидывает пользователя мгновенно.
// Флоу: получили 401 → пробуем GET /auth/me/ со свежим токеном →
// - если 200 → session ещё жива, retry исходного запроса;
// - если снова 401 → окончательный logout.
// Кроме `pin_required` — это спец-сигнал, PinGate его сам обрабатывает.
//
// `_retry` — стандартный аксиомоид флаг, чтобы не зациклиться, если
// исходный запрос сам /auth/me/.
async function tryRefreshSession(): Promise<boolean> {
  try {
    // Bypass interceptor infinite loop via a flag; use a raw axios call.
    const token = localStorage.getItem("naffai_token") || "";
    await axios.get(`${API_BASE_URL}/auth/me/`, {
      withCredentials: true,
      headers: token ? { Authorization: `Token ${token}` } : {},
    });
    return true;
  } catch {
    return false;
  }
}

api.interceptors.response.use(
  (r) => r,
  async (err: AxiosError) => {
    if (err.response?.status === 401) {
      // Специальный код `pin_required` — это НЕ разлогин, а signal
      // фронту показать PIN-модалку. Никакой очистки localStorage,
      // никакого редиректа. PinGate сам обработает.
      const body = err.response?.data as { code?: string } | undefined;
      if (body?.code === "pin_required") {
        return Promise.reject(err);
      }

      const cfg = (err.config || {}) as AxiosRequestConfig & { _retry?: boolean };
      const isMeCall = (cfg.url || "").includes("/auth/me/");

      if (!cfg._retry && !isMeCall) {
        cfg._retry = true;
        const alive = await tryRefreshSession();
        if (alive) {
          // Session ещё валидна — молча retry'им оригинальный запрос.
          return api.request(cfg);
        }
      }

      // Всё, session мертва — чистим и уводим на /login.
      localStorage.removeItem("naffai_token");
      localStorage.removeItem("naffai_username");
      localStorage.removeItem("naffai_role");
      // The /scan kiosk is a phone-first standalone view for the operator
      // — it never requires login (scan endpoint itself is AllowAny). Do
      // NOT bounce them to /login just because /attendance/me/current/
      // returned 401 (token invalidated after check-out is normal).
      const onKiosk = location.pathname === "/scan";
      if (!onKiosk && location.pathname !== "/login") {
        location.href = "/login";
      }
    } else if (err.response?.status === 403) {
      // Silence role-scoped endpoints (e.g. manager hitting operator's /my/)
      // — RoleGate already routes users to their home; a global toast just
      // spams noise.
      const url = err.config?.url || "";
      if (!/\/(my|mine)\/?/.test(url)) {
        toast.error("Доступ запрещён");
      }
    }
    return Promise.reject(err);
  }
);

// Wave-1 (2026-08-22): keepalive ping /auth/me/ раз в 30 минут — освежает
// session cookie на сервере, чтобы user, оставивший вкладку открытой на
// день, не был выкинут при следующем клике. Работает пока в localStorage
// есть токен; на /login или на kiosk не мешает (запрос просто уходит без
// эффекта).
const KEEPALIVE_MS = 30 * 60 * 1000;
if (typeof window !== "undefined") {
  window.setInterval(() => {
    if (!localStorage.getItem("naffai_token")) return;
    api.get("/auth/me/").catch(() => {
      /* silent — interceptor разрулит если что */
    });
  }, KEEPALIVE_MS);
}
