import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import {
  BarChart3, Bell, Bot, BookOpen, Calculator, CalendarDays, Camera, CheckCheck, Clock, Coffee,
  FileText, Gauge, Handshake, Inbox, KanbanSquare, Landmark, LayoutGrid, List, MessageSquareText,
  Percent, Phone, PlayCircle, Plus, QrCode, Receipt, ScrollText, Send, Settings, Shield, SlidersHorizontal,
  Smartphone, Sparkles, Table2, Target, Trash2, Trophy, Tv, User, UserCog, Users, Video, Wallet, Archive, Focus, XCircle,
  type LucideIcon,
} from "lucide-react";

export type BadgeKey = "leadsReview" | "notifs" | "lessonNew" | "orphans" | "myBlockers" | "salesPending";

export interface NavItem {
  id: string;
  to: string;
  label: string; // v2 i18n key
  short?: string; // rail label key (operator)
  icon: LucideIcon;
  badge?: BadgeKey;
  muteBadge?: boolean;
  end?: boolean;
  external?: boolean;
  adminOnly?: boolean;
}

export interface NavGroup {
  id: string;
  title?: string; // i18n key; empty = untitled top group
  items: NavItem[];
  main?: boolean; // always expanded
}

const it = (id: string, to: string, label: string, icon: LucideIcon, extra: Partial<NavItem> = {}): NavItem => ({ id, to, label, icon, ...extra });

/** Manager menu — all sections of the old app (AppShell useManagerGroups) + «Банки», grouped. */
export const MANAGER_GROUPS: NavGroup[] = [
  {
    id: "main", main: true, items: [
      it("dash", "/", "v2.nav.dash", LayoutGrid, { end: true }),
      it("sales", "/sales", "v2.nav.sales", Receipt, { end: true }),
      it("pending", "/sales/pending", "v2.nav.pending", CheckCheck, { badge: "salesPending" }),
      it("calls", "/calls", "v2.nav.calls", Phone),
      it("leads", "/leads", "v2.nav.leads", List, { badge: "leadsReview", muteBadge: true, end: true }),
      it("orphans", "/leads/orphans", "v2.nav.orphans", Inbox, { badge: "orphans" }),
    ],
  },
  {
    id: "analytics", title: "v2.nav.g.analytics", items: [
      it("analytics", "/analytics", "v2.nav.analytics", BarChart3),
      it("leaderboard", "/leaderboard", "v2.nav.leaderboard", Trophy),
      it("leadsStats", "/leads-stats", "v2.nav.leadsStats", Target),
      it("reports", "/reports", "v2.nav.reports", FileText),
      it("screen", "/screen", "v2.nav.screen", Tv, { external: true }),
    ],
  },
  {
    id: "attendance", title: "v2.nav.g.attendance", items: [
      it("attToday", "/attendance/today", "v2.nav.attToday", Clock),
      it("kiosk", "/attendance/kiosk", "v2.nav.kiosk", QrCode),
      it("attReport", "/attendance/report", "v2.nav.attReport", CalendarDays),
      it("photos", "/attendance/photos", "v2.nav.photos", Camera, { adminOnly: true }),
      it("live", "/live/wall", "v2.nav.live", Video),
      it("liveArchive", "/live/archive", "v2.nav.liveArchive", Archive),
    ],
  },
  {
    id: "team", title: "v2.nav.g.team", items: [
      it("operators", "/operators", "v2.nav.operators", Users, { end: true }),
      it("dayOff", "/operators/day-off", "v2.nav.dayOff", Coffee),
      it("payroll", "/attendance/payroll", "v2.nav.payroll", Wallet),
      it("attSettings", "/settings/attendance", "v2.nav.attSettings", SlidersHorizontal),
      it("lessons", "/lessons/today", "v2.nav.lessons", BookOpen),
      it("training", "/training", "v2.nav.training", PlayCircle, { end: true }),
      it("trainingManage", "/training/manage", "v2.nav.trainingManage", BookOpen),
      it("users", "/users", "v2.nav.users", UserCog),
    ],
  },
  {
    id: "catalogs", title: "v2.nav.g.catalogs", items: [
      it("catalog", "/catalog", "v2.nav.catalog", Smartphone, { end: true }),
      it("calculator", "/calculator", "v2.nav.calculator", Calculator),
      it("tiers", "/catalog/tiers", "v2.nav.tiers", Percent),
      it("banks", "/catalog/banks", "v2.nav.banks", Landmark),
      it("mktTexts", "/catalog/marketing-settings", "v2.nav.mktTexts", ScrollText),
      it("partners", "/partners", "v2.nav.partners", Handshake),
      it("sheets", "/sheet-sources", "v2.nav.sheets", Table2),
      it("statuses", "/statuses", "v2.nav.statuses", List),
    ],
  },
  {
    id: "ai", title: "v2.nav.g.ai", items: [
      it("aiChat", "/ai-chat", "v2.nav.aiChat", Sparkles),
      it("tgQueue", "/tg-queue", "v2.nav.tgQueue", Send),
      it("bot", "/bot", "v2.nav.bot", Bot),
      it("botSubs", "/bot-subscribers", "v2.nav.botSubs", Users),
      it("marketing", "/marketing", "v2.nav.marketing", Target, { end: true }),
      it("mktSources", "/marketing/sources", "v2.nav.mktSources", BarChart3),
    ],
  },
  {
    id: "system", title: "v2.nav.g.system", items: [
      it("audit", "/audit", "v2.nav.audit", Shield),
      it("systemLost", "/leads/system-lost", "v2.nav.systemLost", XCircle, { adminOnly: true }),
      it("settings", "/settings", "v2.nav.settings", Settings, { end: true }),
    ],
  },
];

/** Super-manager: «Моя ветка» + the whole manager menu (as in the old app). */
export const BRANCH_GROUP: NavGroup = {
  id: "branch", title: "v2.nav.g.branch", main: true, items: [
    it("teamSales", "/team/sales", "v2.nav.teamSales", BarChart3),
    it("branchDash", "/", "v2.nav.branchDash", Gauge, { end: true }),
    it("pending", "/sales/pending", "v2.nav.pending", CheckCheck, { badge: "salesPending" }),
    it("myOperators", "/team/operators", "v2.nav.myOperators", Users),
    it("branchBoard", "/team/managers", "v2.nav.branchBoard", KanbanSquare),
    it("deleted", "/team/deleted-operators", "v2.nav.deleted", Trash2),
  ],
};

export const SUPER_GROUPS: NavGroup[] = [
  BRANCH_GROUP,
  ...MANAGER_GROUPS.map((g) =>
    g.id === "main"
      ? { ...g, main: false, title: "v2.nav.g.main", items: g.items.filter((x) => x.id !== "dash" && x.id !== "pending") }
      : g,
  ),
];

/** Operator icon rail — the old operator menu, grouped. */
export const OPERATOR_GROUPS: NavGroup[] = [
  { id: "work", items: [
    it("myLeads", "/my", "v2.nav.myLeads", Focus, { short: "v2.nav.short.myLeads", badge: "myBlockers", end: true }),
    it("newSale", "/my/sale-new", "v2.nav.newSale", Plus, { short: "v2.nav.short.newSale" }),
  ] },
  { id: "money", title: "v2.nav.g.money", items: [
    it("myPayroll", "/my/payroll", "v2.nav.myPayroll", Wallet, { short: "v2.nav.short.payroll" }),
    it("mySales", "/my/sales", "v2.nav.mySales", Receipt, { short: "v2.nav.short.sales" }),
  ] },
  { id: "tools", title: "v2.nav.g.tools", items: [
    it("calc", "/calculator", "v2.nav.calculator", Calculator, { short: "v2.nav.short.calc" }),
    it("catalog", "/catalog", "v2.nav.catalog", Smartphone, { short: "v2.nav.short.catalog" }),
    it("board", "/leaderboard", "v2.nav.leaderboard", Trophy, { short: "v2.nav.short.board" }),
  ] },
  { id: "learn", title: "v2.nav.g.learn", items: [
    it("lesson", "/lessons/today", "v2.nav.lessonToday", BookOpen, { short: "v2.nav.short.lesson", badge: "lessonNew", muteBadge: true }),
    it("courses", "/training", "v2.nav.courses", PlayCircle, { short: "v2.nav.short.courses" }),
  ] },
  { id: "personal", title: "v2.nav.g.personal", items: [
    it("notif", "/notifications", "v2.nav.notifications", Bell, { short: "v2.nav.short.notif", badge: "notifs" }),
    it("dayOff", "/my/day-off", "v2.nav.myDayOff", Coffee, { short: "v2.nav.short.dayOff" }),
    it("profile", "/profile", "v2.nav.profile", User, { short: "v2.nav.short.profile" }),
  ] },
];

export const NAV_ICONS = { MessageSquareText, Bell, User };

/** Same queries (and query keys) as the old Sidebar, so both designs share the cache. */
export function useNavBadges(role: "manager" | "operator"): Record<BadgeKey, number> {
  const needsReview = useQuery({
    queryKey: ["needs-review-count"],
    queryFn: async () => {
      const { data } = await api.get<{ count?: number } | unknown[]>("/leads/?needs_review=1&page_size=1");
      return Array.isArray(data) ? data.length : (data as { count?: number }).count || 0;
    },
    enabled: role === "manager",
    refetchInterval: 30000,
  });
  const orphansCount = useQuery({
    queryKey: ["orphan-leads-count"],
    queryFn: async () => {
      const { data } = await api.get<{ count?: number; counts_by_kind?: Record<string, number> }>("/leads/orphans/?limit=1");
      const cbk = data.counts_by_kind || {};
      return cbk.free ?? data.count ?? 0;
    },
    enabled: role === "manager",
    refetchInterval: 60000,
  });
  const salesPending = useQuery({
    queryKey: ["sales-pending-count"],
    queryFn: async () => {
      const { data } = await api.get<{ count?: number }>("/sales/pending/");
      return data.count || 0;
    },
    enabled: role === "manager",
    refetchInterval: 30000,
    retry: false,
  });
  const lessonPeek = useQuery({
    queryKey: ["lessons", "today", "peek"],
    queryFn: () => api.get<{ opened_at: string | null } | null>("/lessons/today/?peek=1").then((r) => r.data),
    enabled: role === "operator",
    refetchInterval: 30000,
    retry: false,
  });
  const unreadNotifs = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => api.get<{ unread_count: number }>("/notifications/unread-count/").then((r) => r.data.unread_count),
    refetchInterval: 30000,
    retry: false,
  });
  const myStatus = useQuery({
    queryKey: ["leads-my-status"],
    queryFn: () => api.get<{ carry_count: number; recall_afternoon_count: number }>("/leads/my/status/").then((r) => r.data),
    enabled: role === "operator",
    refetchInterval: 60000,
    retry: false,
  });
  return {
    leadsReview: role === "manager" ? needsReview.data ?? 0 : 0,
    orphans: role === "manager" ? orphansCount.data ?? 0 : 0,
    salesPending: role === "manager" ? salesPending.data ?? 0 : 0,
    lessonNew: role === "operator" && lessonPeek.data && !lessonPeek.data.opened_at ? 1 : 0,
    notifs: unreadNotifs.data ?? 0,
    myBlockers: role === "operator" && myStatus.data ? myStatus.data.carry_count + myStatus.data.recall_afternoon_count : 0,
  };
}
