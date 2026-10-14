import { useEffect, useMemo, useState } from "react";
import { NavLink, matchPath, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, ChevronDown, LogOut, Moon, Search, Sun, Volume2, VolumeX, Palette, Languages } from "lucide-react";
import { useAuth } from "../../store/auth";
import { useTheme } from "../../store/theme";
import { useLang } from "../../store/lang";
import { useSaleSound } from "../../store/saleSound";
import { useDesign } from "../../store/design";
import { isSuperadmin, isSuperManager, normaliseRole } from "../../components/RoleGate";
import { useMe } from "../../hooks/useMe";
import { useT2 } from "../i18n";
import { useCommandPalette } from "./commandStore";
import { MANAGER_GROUPS, OPERATOR_GROUPS, SUPER_GROUPS, useNavBadges, type NavGroup, type NavItem } from "./nav";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
}

function isActive(pathname: string, item: NavItem) {
  return !!matchPath({ path: item.to, end: !!item.end }, pathname);
}

export function useNavGroups(): { groups: NavGroup[]; kind: "operator" | "manager" | "super" } {
  const rawRole = useAuth((s) => s.role);
  const role = normaliseRole(rawRole) ?? "manager";
  const admin = isSuperadmin(rawRole);
  return useMemo(() => {
    const filterAdmin = (gs: NavGroup[]) => gs.map((g) => ({ ...g, items: g.items.filter((x) => !x.adminOnly || admin) }));
    if (role === "operator") return { groups: OPERATOR_GROUPS, kind: "operator" as const };
    if (admin || isSuperManager(rawRole)) return { groups: filterAdmin(SUPER_GROUPS), kind: "super" as const };
    return { groups: filterAdmin(MANAGER_GROUPS), kind: "manager" as const };
  }, [role, rawRole, admin]);
}

function Badge({ n, mute }: { n: number; mute?: boolean }) {
  if (!n) return null;
  return <span className={`cnt${mute ? " cnt-mute" : ""}`}>{n > 99 ? "99+" : n}</span>;
}

/** The selection pill glides between menu items (shared layout animation). */
const PILL_SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 } as const;
function NavPill() {
  return <motion.span layoutId="v2-nav-pill" className="nav-pill" transition={PILL_SPRING} aria-hidden />;
}

function RailItem({ item, badges }: { item: NavItem; badges: Record<string, number> }) {
  const t = useT2();
  return (
    <NavLink to={item.to} end={item.end} className={({ isActive: a }) => `rail-item${a ? " is-on" : ""}`}>
      {({ isActive: a }) => (
        <>
          {a ? <NavPill /> : null}
          <item.icon className="ic ic-l" aria-hidden />
          <span>{t(item.short ?? item.label)}</span>
          {item.badge ? <Badge n={badges[item.badge] ?? 0} mute={item.muteBadge} /> : null}
        </>
      )}
    </NavLink>
  );
}

function SideItem({ item, badges }: { item: NavItem; badges: Record<string, number> }) {
  const t = useT2();
  const inner = (
    <>
      <item.icon className="ic" aria-hidden />
      <span className="grow trunc">{t(item.label)}</span>
      {item.adminOnly ? <span className="side-tag">{t("v2.nav.tag.admin")}</span> : null}
      {item.badge ? <Badge n={badges[item.badge] ?? 0} mute={item.muteBadge} /> : null}
    </>
  );
  if (item.external) {
    return (
      <a className="side-item" href={item.to} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  }
  return (
    <NavLink to={item.to} end={item.end} className={({ isActive: a }) => `side-item${a ? " is-on" : ""}`}>
      {({ isActive: a }) => (
        <>
          {a ? <NavPill /> : null}
          {inner}
        </>
      )}
    </NavLink>
  );
}

function SettingsRow() {
  const t = useT2();
  const theme = useTheme();
  const lang = useLang();
  const sound = useSaleSound();
  const design = useDesign();
  return (
    <div className="col g4" style={{ padding: "6px 6px 0" }}>
      <div className="row g4" style={{ justifyContent: "space-between" }}>
        <button className="btn btn-ghost btn-sq btn-sm" type="button" onClick={theme.toggle} aria-label={t("v2.nav.theme")} title={t("v2.nav.theme")}>
          {theme.theme === "dark" ? <Sun className="ic" /> : <Moon className="ic" />}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={lang.toggle} aria-label={t("v2.nav.lang")} title={t("v2.nav.lang")}>
          <Languages className="ic" />
          <span className="xs w6">{lang.lang === "ru" ? "RU" : "UZ"}</span>
        </button>
        <button className="btn btn-ghost btn-sq btn-sm" type="button" onClick={sound.toggle} aria-label={t("v2.nav.sound")} title={t("v2.nav.sound")}>
          {sound.muted ? <VolumeX className="ic" /> : <Volume2 className="ic" />}
        </button>
      </div>
      <button className="btn btn-ghost btn-sm" type="button" onClick={() => design.set("v1")} style={{ justifyContent: "flex-start" }}>
        <Palette className="ic" />
        <span className="xs w6">{t("v2.nav.design.toOld")}</span>
      </button>
    </div>
  );
}

export function SideNav() {
  const t = useT2();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { groups, kind } = useNavGroups();
  const badges = useNavBadges(kind === "operator" ? "operator" : "manager");
  const auth = useAuth();
  const me = useMe();
  const openPalette = useCommandPalette((s) => s.open);

  const name = me.data?.operator_name || me.data?.display_name || auth.username || "";
  const roleLabel =
    kind === "operator" ? t("v2.nav.role.operator") : isSuperadmin(auth.role) ? t("v2.nav.role.admin") : kind === "super" ? t("v2.nav.role.super") : t("v2.nav.role.manager");

  // which groups are open: main ones + the one containing the current page; user toggles stick for the session
  const activeGroup = groups.find((g) => g.items.some((x) => isActive(pathname, x)))?.id;
  const [manual, setManual] = useState<Record<string, boolean>>({});
  useEffect(() => setManual({}), [kind]);
  const isOpen = (g: NavGroup) => manual[g.id] ?? (!!g.main || !g.title || g.id === activeGroup);

  const logout = () => {
    auth.logout();
    nav("/login", { replace: true });
  };

  if (kind === "operator") {
    return (
      <nav className="rail" aria-label={t("v2.nav.sections")}>
        <div className="col" style={{ alignItems: "center", gap: 4, padding: "2px 0 10px" }}>
          <i className="logo-mark" aria-hidden />
          <span className="display" style={{ fontSize: 13 }}>naff</span>
        </div>
        <button className="rail-item" type="button" onClick={openPalette} aria-label={t("v2.nav.search")}>
          <Search className="ic" />
          <span className="kbd" style={{ height: 16, fontSize: 9.5 }}>⌘K</span>
        </button>
        {groups.map((g) => (
          <div key={g.id} className="col" style={{ alignItems: "center", gap: 2 }}>
            <i className="hr" style={{ width: 40, margin: "4px 0" }} aria-hidden />
            {g.items.map((x) => <RailItem key={x.id} item={x} badges={badges} />)}
          </div>
        ))}
        <div className="col" style={{ alignItems: "center", gap: 8, marginTop: "auto", paddingTop: 12 }}>
          <NavLink to="/profile" className="ava" title={name}>{initials(name)}</NavLink>
          <button className="btn btn-ghost btn-sq btn-sm" type="button" onClick={useDesign.getState().toggle} aria-label={t("v2.nav.design.toOld")} title={t("v2.nav.design.toOld")}>
            <Palette className="ic" />
          </button>
          <button className="btn btn-ghost btn-sq btn-sm" type="button" onClick={logout} aria-label={t("v2.nav.logout")}>
            <LogOut className="ic" />
          </button>
        </div>
      </nav>
    );
  }

  return (
    <nav className="side" aria-label={t("v2.nav.sections")}>
      <div className="wordmark"><i className="logo-mark" aria-hidden />naff<b>AI</b></div>
      <button className="cmd" type="button" style={{ minWidth: 0, margin: "0 2px 6px" }} onClick={openPalette}>
        <Search className="ic" />
        {t("v2.nav.search")}
        <span className="kbd">⌘K</span>
      </button>
      {groups.map((g) => {
        const open = isOpen(g);
        const groupCount = g.items.reduce((n, x) => n + (x.badge && !x.muteBadge ? badges[x.badge] ?? 0 : 0), 0);
        return (
          <div key={g.id} className="col" style={{ gap: 2 }}>
            {g.title ? (
              <button className={`side-grp${open ? " is-open" : ""}`} type="button" aria-expanded={open} onClick={() => setManual((m) => ({ ...m, [g.id]: !open }))}>
                <span className="grow">{t(g.title)}</span>
                {!open ? <span className="side-n">{g.items.length}</span> : null}
                {!open && groupCount ? <span className="cnt">{groupCount}</span> : null}
                <ChevronDown className="ic chev" />
              </button>
            ) : null}
            <AnimatePresence initial={false}>
              {open ? (
                <motion.div
                  key="items"
                  className="col"
                  style={{ gap: 2, overflow: "hidden" }}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
                >
                  {g.items.map((x) => <SideItem key={x.id} item={x} badges={badges} />)}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        );
      })}
      <div className="col" style={{ marginTop: "auto", paddingTop: 12, borderTop: "1px solid var(--line)" }}>
        <div className="row g6" style={{ padding: "0 6px 0 10px" }}>
          <NavLink to="/profile" className={({ isActive: a }) => `row g8 grow${a ? " is-on" : ""}`} style={{ minWidth: 0, borderRadius: 9 }}>
            <span className="ava">{initials(name)}</span>
            <span className="col grow" style={{ minWidth: 0 }}>
              <span className="s w6 trunc">{name}</span>
              <span className="xs c3">{roleLabel}</span>
            </span>
          </NavLink>
          <NavLink to="/notifications" className={({ isActive: a }) => `btn btn-ghost btn-sq btn-sm${a ? " is-on" : ""}`} aria-label={t("v2.nav.notifBell", { n: badges.notifs })} style={{ position: "relative" }}>
            <Bell className="ic" />
            {badges.notifs ? <span className="cnt" style={{ position: "absolute", top: -4, right: -6, minWidth: 18, height: 18, fontSize: 10.5 }}>{badges.notifs}</span> : null}
          </NavLink>
          <button className="btn btn-ghost btn-sq btn-sm" type="button" onClick={logout} aria-label={t("v2.nav.logout")}>
            <LogOut className="ic" />
          </button>
        </div>
        <SettingsRow />
      </div>
    </nav>
  );
}
