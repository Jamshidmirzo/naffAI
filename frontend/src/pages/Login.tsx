import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";

export default function Login() {
  const [username, setU] = useState("admin");
  const [password, setP] = useState("admin");
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
          <input className="input" value={username} onChange={(e) => setU(e.target.value)} />
        </div>
        <div>
          <label className="label">Пароль</label>
          <input className="input" type="password" value={password} onChange={(e) => setP(e.target.value)} />
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Вход…" : "Войти"}
        </button>
      </form>
    </div>
  );
}
