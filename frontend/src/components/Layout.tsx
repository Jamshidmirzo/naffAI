import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../store/auth";
import { useTheme } from "../store/theme";
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
} from "lucide-react";

const items = [
  { to: "/", label: "Дашборд", icon: LayoutDashboard, end: true },
  { to: "/sales", label: "Продажи", icon: ShoppingCart },
  { to: "/operators", label: "Операторы", icon: Users },
  { to: "/partners", label: "Партнёры", icon: Handshake },
  { to: "/analytics", label: "Аналитика", icon: LineChart },
  { to: "/payroll", label: "Зарплата", icon: Wallet },
  { to: "/audit", label: "Журнал", icon: History },
];

export default function Layout() {
  const auth = useAuth();
  const theme = useTheme();
  const nav = useNavigate();
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
          {items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
                  isActive
                    ? "bg-accent/10 text-accent font-medium dark:bg-accent/20"
                    : "text-gray-700 hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-800"
                }`
              }
            >
              <it.icon className="w-4 h-4" />
              {it.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-3 py-4 border-t border-gray-200 dark:border-slate-800 space-y-2">
          <div className="px-3 text-xs text-gray-500 dark:text-slate-400">
            {auth.username} · {auth.role}
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
    </div>
  );
}
