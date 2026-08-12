import { Outlet } from "react-router-dom";
import { useAuth } from "../../store/auth";
import { normaliseRole } from "../RoleGate";
import { Sidebar, type SidebarGroup } from "./Sidebar";
import { Header } from "./Header";
import MorningGreeting from "../MorningGreeting";
import { useT } from "../../lib/i18n";

/**
 * Sidebar layout — sections grouped with lightweight headers so the
 * manager's 20-item nav collapses visually into 4 groups + a couple of
 * always-visible top-level entries. Section headers are purely visual;
 * clicking any leaf still routes normally.
 */
function useManagerGroups(t: (k: string) => string): SidebarGroup[] {
  return [
    {
      items: [
        { to: "/", label: t("nav.dashboard"), end: true },
        { to: "/sales", label: t("nav.sales") },
        { to: "/sales/pending", label: t("nav.sales_pending"), badgeKey: "salesPending" },
        { to: "/leads", label: t("nav.leads"), badgeKey: "leadsReview" },
        { to: "/leads/orphans", label: t("nav.orphans"), badgeKey: "orphans" },
      ],
    },
    {
      title: t("sidebar.analytics"),
      items: [
        { to: "/analytics", label: t("nav.analytics") },
        { to: "/leads-stats", label: t("nav.leads_stats") },
        { to: "/reports", label: t("nav.reports") },
        { to: "/screen", label: t("nav.screen"), external: true },
      ],
    },
    {
      title: t("sidebar.attendance"),
      items: [
        { to: "/attendance/today", label: t("nav.attendance_today") },
        { to: "/attendance/report", label: t("nav.attendance_report") },
      ],
    },
    {
      title: t("sidebar.team"),
      items: [
        { to: "/operators", label: t("nav.operators") },
        { to: "/payroll", label: t("nav.payroll") },
        { to: "/lessons/today", label: t("nav.lessons") },
        { to: "/users", label: t("nav.users") },
        { to: "/stickers", label: t("nav.stickers") },
      ],
    },
    {
      title: t("sidebar.catalogs"),
      items: [
        { to: "/catalog", label: t("nav.catalog") },
        { to: "/partners", label: t("nav.partners") },
        { to: "/sheet-sources", label: t("nav.sheet_sources") },
        { to: "/statuses", label: t("nav.statuses") },
        { to: "/calls", label: t("nav.calls") },
      ],
    },
    {
      title: t("sidebar.ai_tg"),
      items: [
        { to: "/ai-chat", label: t("nav.ai_chat") },
        { to: "/tg-queue", label: t("nav.tg_queue") },
        { to: "/bot", label: t("nav.bot") },
        { to: "/marketing", label: t("nav.marketing") },
      ],
    },
    {
      items: [
        { to: "/audit", label: t("nav.audit") },
        { to: "/settings", label: t("nav.settings") },
      ],
    },
  ];
}

function useOperatorGroups(t: (k: string) => string): SidebarGroup[] {
  return [
    {
      items: [
        { to: "/my", label: t("nav.my_leads"), end: true, badgeKey: "myBlockers" },
        { to: "/notifications", label: t("nav.notifications"), badgeKey: "notifs" },
        { to: "/lessons/today", label: t("nav.lesson_today"), badgeKey: "lessonNew" },
        { to: "/lessons/history", label: t("nav.lesson_history") },
        { to: "/profile", label: t("nav.profile") },
      ],
    },
  ];
}

export default function AppShell() {
  const t = useT();
  const role = normaliseRole(useAuth((s) => s.role)) ?? "manager";
  const managerGroups = useManagerGroups(t);
  const operatorGroups = useOperatorGroups(t);
  const groups = role === "operator" ? operatorGroups : managerGroups;

  return (
    <div className="min-h-screen flex bg-[color:var(--bg)] text-[color:var(--text)]">
      <Sidebar groups={groups} role={role} />
      <div className="flex-1 min-w-0 flex flex-col">
        <Header />
        <main
          className="flex-1"
          style={{ padding: "30px 40px 70px" }}
        >
          <Outlet />
        </main>
      </div>
      {role === "operator" && <MorningGreeting language="ru" />}
    </div>
  );
}
