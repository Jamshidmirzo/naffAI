import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, LogOut, Trophy } from "lucide-react";
import { useAuth } from "../../store/auth";
import { SCREEN_REFRESH_SEC, useScreenLeaderboard } from "../api/admin";
import { useT2 } from "../i18n";
import { ErrorState } from "../ui";

type T = ReturnType<typeof useT2>;

function mln(n: number, t: T) {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "").replace(".", ",")} ${t("v2.admin.analytics.mln")}`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)} ${t("v2.admin.analytics.thousand")}`;
  return String(Math.round(n));
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

const RANK_COLOR = ["var(--warn-solid)", "var(--ink-2)", "var(--hot-solid)"];

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(id);
  }, []);
  return now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** Full-screen dark TV board, outside the shell. Today's ranking, refreshed every 30 s. */
export default function Screen() {
  const t = useT2();
  const nav = useNavigate();
  const logout = useAuth((s) => s.logout);
  const clock = useClock();
  const lb = useScreenLeaderboard();
  const all = lb.data ?? [];
  const rows = all.slice(0, 5);
  const sum = all.reduce((a, r) => a + Number(r.total || 0), 0);
  const cnt = all.reduce((a, r) => a + Number(r.count || 0), 0);

  const doLogout = () => {
    logout();
    nav("/login", { replace: true });
  };

  return (
    <div
      className="nf"
      data-theme="dark"
      style={{ position: "fixed", inset: 0, zIndex: 100, overflow: "auto", display: "flex", flexDirection: "column", background: "var(--bg)", userSelect: "none" }}
    >
      <div className="row between wrap" style={{ padding: "32px 56px 8px", alignItems: "flex-start" }}>
        <div className="col g6" style={{ minWidth: 0 }}>
          <span className="lbl" style={{ color: "var(--brand-text)" }}>{t("v2.admin.screen.title")}</span>
          {lb.data ? (
            cnt > 0 ? <span className="display" style={{ fontSize: 44, lineHeight: "52px" }}>
              {mln(sum, t)} · {cnt} {t("v2.admin.screen.pcs")}
            </span> : null
          ) : (
            <i className="sk" style={{ display: "block", width: 360, height: 52 }} />
          )}
        </div>
        <div className="col g6" style={{ alignItems: "flex-end" }}>
          <span className="num" style={{ fontSize: 32, fontWeight: 600 }}>{clock}</span>
          <span className="xs c3">{t("v2.admin.screen.refresh", { n: SCREEN_REFRESH_SEC })}</span>
          <span className="row g6">
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => nav("/")}>
              <ArrowLeft className="ic ic-s" />{t("v2.admin.screen.toApp")}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={doLogout}>
              <LogOut className="ic ic-s" />{t("v2.nav.logout")}
            </button>
          </span>
        </div>
      </div>

      <div className="col g12" style={{ padding: "24px 56px 40px", flex: "1 1 auto" }}>
        {lb.isLoading ? (
          Array.from({ length: 5 }).map((_, i) => <i key={i} className="sk" style={{ display: "block", height: 106, borderRadius: 18 }} />)
        ) : lb.isError ? (
          <section className="card"><ErrorState error={lb.error} onRetry={() => lb.refetch()} /></section>
        ) : rows.length === 0 ? (
          <div className="col" style={{ alignItems: "center", justifyContent: "center", gap: 10, height: 260, borderRadius: 18, background: "var(--surface)", border: "1px solid var(--line)", textAlign: "center", padding: 24 }}>
            <Trophy className="ic ic-xl" style={{ color: "var(--ink-4)" }} />
            <span className="display c3" style={{ fontSize: 26 }}>{t("v2.admin.screen.emptyTitle")}</span>
            <span className="s c3">{t("v2.admin.screen.emptyBody")}</span>
          </div>
        ) : (
          rows.map((r, i) => (
            <div key={r.operator_id} className="row g24" style={{ padding: "16px 24px", borderRadius: 18, background: "var(--surface)", border: "1px solid var(--line)" }}>
              <span className="display" style={{ fontSize: 40, width: 64, flex: "none", color: RANK_COLOR[i] ?? "var(--ink-3)" }}>{i + 1}</span>
              <span className="ava ava-xl">{initials(r.operator_name)}</span>
              <span className="row g16 grow" style={{ alignItems: "baseline", minWidth: 0 }}>
                <span className="display trunc" style={{ fontSize: 34 }}>{r.operator_name}</span>
                <span className="num c3" style={{ fontSize: 26, flex: "none" }}>{Number(r.count ?? 0)} {t("v2.admin.screen.pcs")}</span>
              </span>
              <span className="display" style={{ fontSize: 44, flex: "none", color: i === 0 ? "var(--warn-solid)" : "var(--ink)" }}>{mln(Number(r.total), t)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
