import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";

export default function Login() {
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setAuth = useAuth((s) => s.setAuth);
  const nav = useNavigate();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post("/auth/login/", { username, password });
      setAuth(data.token, data.username, data.role);
      nav("/");
    } catch (err: any) {
      setError(err.response?.data?.detail || "Ошибка входа");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form onSubmit={onSubmit} className="card p-8 w-full max-w-sm space-y-5">
        <div>
          <div className="text-xl font-semibold">naffAI</div>
          <div className="text-sm text-gray-500">учёт продаж колл-центра</div>
        </div>
        <div>
          <label className="label">Логин</label>
          <input
            className="input"
            value={username}
            onChange={(e) => setU(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </div>
        <div>
          <label className="label">Пароль</label>
          <div className="relative">
            <input
              className="input pr-10"
              type={showPwd ? "text" : "password"}
              value={password}
              onChange={(e) => setP(e.target.value)}
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowPwd((v) => !v)}
              className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-700"
              aria-label={showPwd ? "Скрыть пароль" : "Показать пароль"}
              tabIndex={-1}
            >
              {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Вход…" : "Войти"}
        </button>
      </form>
    </div>
  );
}
