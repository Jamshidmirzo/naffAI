import { lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { useDesign } from "../store/design";
import { PageSkeleton } from "./ui/states";

/**
 * Route → v2 page file. A v2 page lives in src/v2/pages/<Slug>.tsx and
 * default-exports a component. Until that file exists the route keeps
 * rendering the old page (inside the v2 shell), so the app works at
 * every step of the migration. App.tsx never needs to change for a new
 * v2 page — just add the file.
 */
export const V2_SLUGS: Record<string, string> = {
  "/login": "Login",
  "/scan": "Scan",
  "/kiosk": "Kiosk",
  "/screen": "Screen",
  "/": "Home",
  "/my": "MyLeads",
  "/my/sale-new": "MySaleNew",
  "/my/sales": "MySales",
  "/my/activity": "MyActivity",
  "/my/payroll": "MyPayroll",
  "/my/day-off": "MyDayOff",
  "/profile": "Profile",
  "/notifications": "Notifications",
  "/lessons/today": "LessonToday",
  "/lessons/history": "LessonsHistory",
  "/training": "Training",
  "/training/:id": "TrainingLesson",
  "/training/manage": "TrainingManage",
  "/training/manage/new": "TrainingForm",
  "/training/manage/:id": "TrainingForm",
  "/leaderboard": "Leaderboard",
  "/calculator": "Calculator",
  "/catalog": "Catalog",
  "/catalog/banks": "CatalogMore",
  "/catalog/tiers": "CatalogMore",
  "/catalog/marketing-settings": "CatalogMore",
  "/sales": "Sales",
  "/sales/new": "SaleForm",
  "/sales/:id": "SaleDetail",
  "/sales/:id/edit": "SaleForm",
  "/sales/pending": "SalesPending",
  "/sales-today": "SalesToday",
  "/leads": "Leads",
  "/leads/orphans": "Orphans",
  "/leads/system-lost": "SystemLost",
  "/leads-stats": "LeadsStats",
  "/statuses": "Statuses",
  "/sheet-sources": "SheetSources",
  "/calls": "Calls",
  "/operators": "Operators",
  "/operators/:id": "OperatorDetail",
  "/operators/day-off": "DayOffRequests",
  "/users": "Users",
  "/audit": "Audit",
  "/attendance/today": "AttendanceToday",
  "/attendance/report": "AttendanceReport",
  "/attendance/photos": "AttendancePhotos",
  "/attendance/kiosk": "Kiosk",
  "/attendance/payroll": "Payroll",
  "/settings/attendance": "AttendanceSettings",
  "/payroll": "PayrollLegacy",
  "/analytics": "Analytics",
  "/marketing": "Marketing",
  "/marketing/sources": "MarketingSources",
  "/reports": "Reports",
  "/ai-chat": "AIChat",
  "/live/wall": "LiveWall",
  "/live/archive": "LiveArchive",
  "/settings": "Settings",
  "/partners": "Partners",
  "/bot": "Bot",
  "/bot-subscribers": "BotSubscribers",
  "/tg-queue": "TgQueue",
  "/stickers": "Stickers",
  "/team/managers": "Branch",
  "/team/operators": "TeamOperators",
  "/team/sales": "TeamSales",
  "/team/deleted-operators": "DeletedOperators",
  "*": "NotFound",
};

const loaders = import.meta.glob<{ default: ComponentType }>("./pages/*.tsx");
const cache = new Map<string, LazyExoticComponent<ComponentType>>();

export function v2PageFor(routeKey: string): LazyExoticComponent<ComponentType> | null {
  const slug = V2_SLUGS[routeKey];
  if (!slug) return null;
  const loader = loaders[`./pages/${slug}.tsx`];
  if (!loader) return null;
  let C = cache.get(slug);
  if (!C) {
    C = lazy(loader);
    cache.set(slug, C);
  }
  return C;
}

/** True when this route already has a v2 page. */
export function hasV2Page(routeKey: string): boolean {
  const slug = V2_SLUGS[routeKey];
  return !!slug && !!loaders[`./pages/${slug}.tsx`];
}

/** Renders the v2 page for `k` when design is v2 and the page exists, else the old element. */
export function Pick({ k, v1 }: { k: string; v1: ReactNode }) {
  const design = useDesign((s) => s.design);
  if (design !== "v2") return <>{v1}</>;
  const C = v2PageFor(k);
  if (!C) return <>{v1}</>;
  return (
    <Suspense fallback={<PageSkeleton />}>
      <C />
    </Suspense>
  );
}
