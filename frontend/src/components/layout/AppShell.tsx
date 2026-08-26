import { Outlet } from "react-router-dom";
import { useAuth } from "../../store/auth";
import { normaliseRole, isSuperadmin } from "../RoleGate";
import { Sidebar, type SidebarGroup } from "./Sidebar";
import { Header } from "./Header";
import MorningGreeting from "../MorningGreeting";
import { HelperButton } from "../helper/HelperButton";
import CheckinGate from "../CheckinGate";
import CheckoutBackfillGate from "../CheckoutBackfillGate";
import CheckoutReminderBanner from "../CheckoutReminderBanner";
import { useT } from "../../lib/i18n";
import { useMe } from "../../hooks/useMe";

/**
 * Sidebar layout — sections grouped with lightweight headers so the
 * manager's 20-item nav collapses visually into 4 groups + a couple of
 * always-visible top-level entries. Section headers are purely visual;
 * clicking any leaf still routes normally.
 */
function useManagerGroups(t: (k: string) => string, showPhotos: boolean): SidebarGroup[] {
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
        { to: "/leaderboard", label: t("nav.leaderboard") },
        { to: "/leads-stats", label: t("nav.leads_stats") },
        { to: "/reports", label: t("nav.reports") },
        { to: "/screen", label: t("nav.screen"), external: true },
      ],
    },
    {
      title: t("sidebar.attendance"),
      items: [
        { to: "/attendance/today", label: t("nav.attendance_today") },
        { to: "/attendance/kiosk", label: t("nav.attendance_kiosk") },
        { to: "/attendance/report", label: t("nav.attendance_report") },
        // Только для роли `superadmin` — расширенная галерея всех
        // фото check-in/out. Обычный менеджер видит фото inline на
        // «Сегодня», ему выделенная страница не нужна.
        ...(showPhotos
          ? [{ to: "/attendance/photos", label: t("nav.attendance_photos") }]
          : []),
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
        { to: "/calculator", label: t("nav.calculator") },
        { to: "/catalog/tiers", label: t("nav.tiers") },
        { to: "/catalog/marketing-settings", label: t("nav.marketing_settings") },
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
        { to: "/leaderboard", label: t("nav.leaderboard") },
        { to: "/catalog", label: t("nav.catalog") },
        { to: "/calculator", label: t("nav.calculator") },
        { to: "/lessons/today", label: t("nav.lesson_today"), badgeKey: "lessonNew" },
        { to: "/lessons/history", label: t("nav.lesson_history") },
        { to: "/profile", label: t("nav.profile") },
      ],
    },
  ];
}

export default function AppShell() {
  const t = useT();
  const rawRole = useAuth((s) => s.role);
  const role = normaliseRole(rawRole) ?? "manager";
  const showPhotos = isSuperadmin(rawRole);
  const managerGroups = useManagerGroups(t, showPhotos);
  const operatorGroups = useOperatorGroups(t);
  const groups = role === "operator" ? operatorGroups : managerGroups;

  // Read the operator's preferred content language from the profile so
  // MorningGreeting fetches the correct RU/UZ daily quote. Default 'uz'
  // — phone-shop team is UZ-first; manager can flip individual operators
  // to 'ru' via /operators/{id}/account/language/.
  const me = useMe();
  const greetingLang = (me.data?.preferred_language ?? "uz") as "ru" | "uz";

  return (
    <div className="min-h-screen flex bg-[color:var(--bg)] text-[color:var(--text)]">
      <Sidebar groups={groups} role={role} />
      <div className="flex-1 min-w-0 flex flex-col">
        <Header />
        {/* Enforcement wave 2026-08-26 — soft reminder про уход. Только
            для роли operator: sits в самом верху контентной колонки,
            под Header'ом, чтобы был замечен но не занимал экран. */}
        {role === "operator" && <CheckoutReminderBanner />}
        <main
          className="flex-1"
          style={{ padding: "30px 40px 70px" }}
        >
          <Outlet />
        </main>
      </div>
      {role === "operator" && <MorningGreeting language={greetingLang} />}
      {/* Enforcement wave 2026-08-26 — fullscreen блокирующие модалы.
          BackfillGate имеет более высокий z-index (310) и рендерится
          сверху CheckinGate (300), чтобы «вчерашний долг» закрывался
          в первую очередь. Оба показывают-скрываются по /me/current/
          флагам, поэтому монтируем безусловно (внутренний if вернёт null).
          Только для operator: manager/team_lead к require_checkin_enabled
          вообще не относится (у них нет operator FK). */}
      {role === "operator" && (
        <>
          <CheckinGate />
          <CheckoutBackfillGate />
        </>
      )}
      {/* Floating helper — оператор-only. Manager/team_lead виджет не видят
          (у них своя админка + и так знают систему; клат-нить в углу лишний). */}
      {role === "operator" && <HelperButton />}
    </div>
  );
}
