import { Outlet } from "react-router-dom";
import { useAuth } from "../../store/auth";
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
        { to: "/leads", label: t("nav.leads"), badgeKey: "leadsReview" },
      ],
    },
    {
      title: t("sidebar.analytics"),
      items: [
        { to: "/analytics", label: t("nav.analytics") },
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
        { to: "/calls", label: t("nav.calls") },
      ],
    },
    {
      title: t("sidebar.ai_tg"),
      items: [
        { to: "/ai-chat", label: t("nav.ai_chat") },
        { to: "/tg-queue", label: t("nav.tg_queue") },
        { to: "/marketing", label: t("nav.marketing") },
      ],
    },
    { items: [{ to: "/audit", label: t("nav.audit") }] },
  ];
}

function useOperatorGroups(t: (k: string) => string): SidebarGroup[] {
  return [
    {
      items: [
        { to: "/my", label: t("nav.my_leads"), end: true },
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
  const role = useAuth((s) => (s.role as "manager" | "operator" | null) || "manager");
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
