import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Menu } from "lucide-react";
import { useAuth } from "../../store/auth";
import { useTheme } from "../../store/theme";
import { usePageStore } from "../../store/page";
import { normaliseRole } from "../../components/RoleGate";
import { useMe } from "../../hooks/useMe";
import { useNotificationStream } from "../../hooks/useNotificationStream";
import { useT2 } from "../i18n";
import { SideNav } from "./SideNav";
import { OperatorOverlays } from "./OperatorOverlays";
import CheckoutReminderBanner from "../../components/CheckoutReminderBanner";
import { CommandPalette } from "./CommandPalette";

/**
 * Old pages (not yet redesigned) set their title through usePageHeader().
 * v2 pages render their own <PageHeader/> and never set the store, so this
 * compat bar only appears for old pages shown inside the new shell.
 */
function CompatHeader() {
  const { title, subtitle, back } = usePageStore();
  const nav = useNavigate();
  const t = useT2();
  if (!title) return null;
  return (
    <header className="top">
      {back ? (
        <button
          className="btn btn-ghost btn-sq btn-sm"
          type="button"
          aria-label={t("common.back")}
          onClick={() => (typeof back === "function" ? back() : nav(back))}
        >
          <ArrowLeft className="ic" />
        </button>
      ) : null}
      <h1 className="h1">{title}</h1>
      {subtitle ? <span className="s c3 trunc">{subtitle}</span> : null}
    </header>
  );
}

export function V2Shell() {
  const role = normaliseRole(useAuth((s) => s.role)) ?? "manager";
  const theme = useTheme((s) => s.theme);
  const { pathname } = useLocation();

  // same side effects as the old AppShell
  useNotificationStream(true);
  const me = useMe();
  const auth = useAuth();
  useEffect(() => {
    if (!me.data || !auth.token || !auth.username) return;
    if (me.data.role && me.data.role !== auth.role) auth.setAuth(auth.token, auth.username, me.data.role);
  }, [me.data?.role, auth.role, auth.token, auth.username]);

  useEffect(() => {
    document.body.setAttribute("data-theme", theme);
    return () => document.body.removeAttribute("data-theme");
  }, [theme]);

  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    window.scrollTo(0, 0);
    setMenuOpen(false);
  }, [pathname]);

  const isOperator = role === "operator";
  return (
    <div className={`nf shell${menuOpen ? " menu-open" : ""}${isOperator ? " is-operator" : ""}`} data-theme={theme} style={{ minHeight: "100vh" }}>
      {!isOperator ? (
        <>
          <button className="btn btn-sq v2-burger" type="button" aria-label="Меню" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            <Menu className="ic" />
          </button>
          <div className="v2-menu-scrim" onClick={() => setMenuOpen(false)} />
        </>
      ) : null}
      <div className={isOperator ? "rail-wrap" : "side-wrap"}>
        <SideNav />
      </div>
      <div className="main-col">
        {isOperator ? <CheckoutReminderBanner /> : null}
        <CompatHeader />
        <Outlet />
      </div>
      {isOperator ? <OperatorOverlays livestream={!!me.data?.livestream_enabled} language={(me.data?.preferred_language ?? "uz") as "ru" | "uz"} /> : null}
      <CommandPalette />
    </div>
  );
}
