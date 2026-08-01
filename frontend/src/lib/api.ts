import axios from "axios";
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

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
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
