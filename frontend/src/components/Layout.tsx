import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../store/auth";
import { useTheme } from "../store/theme";
import { tgStatus, TG_STATUS_KEY } from "../lib/tgUserclient";
import { api } from "../lib/api";
import MorningGreeting from "./MorningGreeting";
import {
  LayoutDashboard,
  Users,
  ShoppingCart,
  LineChart,
  Wallet,
  History,
  Handshake,
  LogOut,
  Moon,
  Sun,
  Monitor,
  Contact2,
  ClipboardList,
  FileSpreadsheet,
  UserCircle,
  AlertTriangle,
  Bot,
  BookOpen,
  Clock,
} from "lucide-react";

type NavItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
  roles?: Array<"team_lead" | "manager" | "operator">;
  badge?: number;
};

const OPERATOR_ITEMS: NavItem[] = [
  { to: "/my", label: "Мои лиды", icon: Contact2, end: true, roles: ["operator"] },
  { to: "/lessons/today", label: "Обучение", icon: BookOpen, roles: ["operator"] },
];

const TEAM_LEAD_ITEMS: NavItem[] = [
  { to: "/", label: "Дашборд", icon: LayoutDashboard, end: true, roles: ["team_lead", "manager"] },
  { to: "/leads", label: "Лиды", icon: ClipboardList, roles: ["team_lead", "manager"] },
  { to: "/leads?needs_review=1", label: "Требуют проверки", icon: AlertTriangle, roles: ["team_lead", "manager"] },
  { to: "/sales", label: "Продажи", icon: ShoppingCart, roles: ["team_lead", "manager"] },
  { to: "/attendance/today", label: "Посещаемость", icon: Clock, roles: ["team_lead", "manager"] },
  { to: "/attendance/report", label: "Отчёт посещаемости", icon: FileSpreadsheet, roles: ["team_lead", "manager"] },
  { to: "/operators", label: "Операторы", icon: Users, roles: ["team_lead", "manager"] },
  { to: "/partners", label: "Партнёры", icon: Handshake, roles: ["team_lead", "manager"] },
  { to: "/analytics", label: "Аналитика", icon: LineChart, roles: ["team_lead", "manager"] },
  { to: "/payroll", label: "Зарплата", icon: Wallet, roles: ["team_lead", "manager"] },
  { to: "/ai-chat", label: "AI-ассистент", icon: Bot, roles: ["manager"] },
  { to: "/marketing", label: "Маркетинг", icon: LineChart, roles: ["manager", "team_lead"] },
  { to: "/sheet-sources", label: "Google Sheets", icon: FileSpreadsheet, roles: ["team_lead"] },
  { to: "/audit", label: "Журнал", icon: History, roles: ["team_lead"] },
];

const SCREEN_ITEM = { href: "/screen", label: "Экран монитора", icon: Monitor };

export default function Layout() {
  const auth = useAuth();
  const theme = useTheme();
  const nav = useNavigate();
  const role = (auth.role as "team_lead" | "manager" | "operator" | null) || null;

  const tgStatusQ = useQuery({
    queryKey: TG_STATUS_KEY(),
    queryFn: () => tgStatus().then(r => r.data),
    enabled: role === 'operator',
    refetchInterval: 30000,
  });

  const needsReviewQ = useQuery({
    queryKey: ["needs-review-count"],
    queryFn: async () => {
      const { data } = await api.get<{ count?: number } | any[]>("/leads/?needs_review=1&page_size=1");
      return Array.isArray(data) ? data.length : data.count || 0;
    },
    enabled: role === "manager" || role === "team_lead",
    refetchInterval: 30000,
  });

  const myStickerQ = useQuery({
    queryKey: ["me", "sticker"],
    queryFn: () =>
      api.get<{ sticker: { emoji: string; is_rare: boolean } | null }>("/me/sticker/").then(
        (r) => r.data
      ),
    enabled: role === "operator",
    staleTime: 60000,
  });

  const todayLessonQ = useQuery({
    queryKey: ["lessons", "today", "peek"],
    queryFn: () =>
      api.get<{ opened_at: string | null } | null>("/lessons/today/?peek=1").then(
        (r) => r.data
      ),
    enabled: role === "operator",
    refetchInterval: 30000,
    retry: false,
  });

  const tgNeedsAttention = role === 'operator' && tgStatusQ.data?.status && tgStatusQ.data.status !== 'active';

  const items: NavItem[] = [];
  if (role === "operator") items.push(...OPERATOR_ITEMS);
  else items.push(...TEAM_LEAD_ITEMS.filter((it) => !it.roles || it.roles.includes(role || "team_lead")));

  const onLogout = () => {
    auth.logout();
    nav("/login");
  };
  return (
    <div className="min-h-screen flex">
      <aside className="w-60 bg-white border-r border-gray-200 flex flex-col dark:bg-slate-900 dark:border-slate-800">
        <div className="px-6 py-5 border-b border-gray-200 dark:border-slate-800">
          <div className="text-lg font-semibold tracking-tight">naffAI</div>
          <div className="text-xs text-gray-500 dark:text-slate-400">учёт продаж</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {items.map((it) => {
            const count = it.to === "/leads?needs_review=1" ? needsReviewQ.data : undefined;
            const hasNewLesson =
              it.to === "/lessons/today" &&
              todayLessonQ.data &&
              todayLessonQ.data.opened_at === null;
            return (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end}
                className={({ isActive }) =>
                  `flex items-center justify-between px-3 py-2 rounded-lg text-sm transition ${
                    isActive
                      ? "bg-accent/10 text-accent font-medium dark:bg-accent/20"
                      : "text-gray-700 hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`
                }
              >
                <div className="flex items-center gap-3">
                  <it.icon className="w-4 h-4" />
                  {it.label}
                </div>
                {count !== undefined && count > 0 && (
                  <span className="px-1.5 py-0.5 text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 rounded-full">
                    {count}
                  </span>
                )}
                {hasNewLesson && (
                  <span className="w-2.5 h-2.5 bg-red-500 rounded-full flex-shrink-0" title="Новый разбор вчерашнего дня!" />
                )}
              </NavLink>
            );
          })}
          {role !== "operator" && (
            <div className="pt-2 border-t border-gray-100 dark:border-slate-800 mt-2">
              <a
                href={SCREEN_ITEM.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition font-medium"
              >
                <SCREEN_ITEM.icon className="w-4 h-4" />
                {SCREEN_ITEM.label}
              </a>
            </div>
          )}
        </nav>
        <div className="px-3 py-4 border-t border-gray-200 dark:border-slate-800 space-y-2">
          <div className="px-3 text-xs text-gray-500 dark:text-slate-400 flex items-center gap-1">
            {myStickerQ.data?.sticker?.emoji && (
              <span className="text-base leading-none">
                {myStickerQ.data.sticker.emoji}
                {myStickerQ.data.sticker.is_rare && (
                  <span className="text-[8px] text-amber-500 align-super">★</span>
                )}
              </span>
            )}
            <span>{auth.username} · {auth.role}</span>
          </div>
          <div className="relative">
            <NavLink
              to="/profile"
              className={({ isActive }) =>
                `btn-ghost w-full justify-start ${
                  isActive ? "bg-accent/10 text-accent" : ""
                }`
              }
            >
              <UserCircle className="w-4 h-4" /> Профиль
            </NavLink>
            {tgNeedsAttention && (
              <span className="absolute top-2 right-2 w-2.5 h-2.5 bg-red-500 rounded-full" title="TG-сессия отвалилась, обнови в профиле" />
            )}
          </div>
          <button
            onClick={theme.toggle}
            className="btn-ghost w-full justify-start"
            aria-label="Переключить тему"
          >
            {theme.theme === "dark" ? (
              <>
                <Sun className="w-4 h-4" /> Светлая тема
              </>
            ) : (
              <>
                <Moon className="w-4 h-4" /> Тёмная тема
              </>
            )}
          </button>
          <button onClick={onLogout} className="btn-ghost w-full justify-start">
            <LogOut className="w-4 h-4" /> Выйти
          </button>
        </div>
      </aside>
      <main className="flex-1 p-8 max-w-[1400px] mx-auto w-full">
        <Outlet />
      </main>
      {role === "operator" && <MorningGreeting language="ru" />}
    </div>
  );
}
