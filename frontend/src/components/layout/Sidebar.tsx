import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { useAuth } from "../../store/auth";
import { cn } from "../ui/cn";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";

export interface SidebarItem {
  to: string;
  label: string;
  end?: boolean;
  external?: boolean;
  badgeKey?: "leadsReview" | "notifs" | "lessonNew";
}

export interface SidebarGroup {
  /** Section title shown as a lightweight header. Omit for top-level items. */
  title?: string;
  items: SidebarItem[];
  /** If true — group starts collapsed (only header + count visible). */
  collapsedByDefault?: boolean;
}

interface Props {
  groups: SidebarGroup[];
  role: "manager" | "operator";
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2.5">
      <div
        className="grid place-items-center text-white font-bold text-[14px]"
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          background: "var(--accent-grad)",
          boxShadow: "0 6px 14px -6px var(--accent)",
        }}
      >
        n
      </div>
      <div className="text-[16.5px] font-semibold tracking-tight">naffAI</div>
    </div>
  );
}

function useBadges(role: "manager" | "operator") {
  const needsReview = useQuery({
    queryKey: ["needs-review-count"],
    queryFn: async () => {
      const { data } = await api.get<{ count?: number } | unknown[]>(
        "/leads/?needs_review=1&page_size=1",
      );
      return Array.isArray(data) ? data.length : (data as { count?: number }).count || 0;
    },
    enabled: role === "manager",
    refetchInterval: 30000,
  });
  const lessonPeek = useQuery({
    queryKey: ["lessons", "today", "peek"],
    queryFn: () =>
      api
        .get<{ opened_at: string | null } | null>("/lessons/today/?peek=1")
        .then((r) => r.data),
    enabled: role === "operator",
    refetchInterval: 30000,
    retry: false,
  });
  const unreadNotifs = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () =>
      api
        .get<{ unread_count: number }>("/notifications/unread-count/")
        .then((r) => r.data.unread_count),
    refetchInterval: 30000,
    retry: false,
  });
  return {
    leadsReview: role === "manager" ? needsReview.data ?? 0 : 0,
    lessonNew: role === "operator" && lessonPeek.data && !lessonPeek.data.opened_at ? 1 : 0,
    notifs: unreadNotifs.data ?? 0,
  };
}

interface NavItemProps {
  item: SidebarItem;
  badge: number;
  showDot: boolean;
}

function NavItem({ item, badge, showDot }: NavItemProps) {
  if (item.external) {
    return (
      <a
        href={item.to}
        target="_blank"
        rel="noopener noreferrer"
        className="nf-nav-item"
      >
        <span className="nf-nav-dot" data-active="false" />
        <span className="flex-1 truncate">{item.label}</span>
        <span className="text-[11px] text-muted" aria-hidden>↗</span>
      </a>
    );
  }
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn("nf-nav-item", isActive && "nf-nav-item--active")
      }
    >
      {({ isActive }) => (
        <>
          <span className="nf-nav-dot" data-active={isActive} />
          <span className="flex-1 truncate">{item.label}</span>
          {badge > 0 && !showDot && (
            <span
              className="text-white text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums leading-none"
              style={{ background: "var(--accent-grad)" }}
            >
              {badge}
            </span>
          )}
          {showDot && (
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: "var(--accent)" }}
            />
          )}
        </>
      )}
    </NavLink>
  );
}

interface GroupProps {
  group: SidebarGroup;
  badges: ReturnType<typeof useBadges>;
  index: number;
}

function Group({ group, badges, index }: GroupProps) {
  const [collapsed, setCollapsed] = useState(!!group.collapsedByDefault);

  const items = group.items.map((item) => {
    const badge = item.badgeKey ? badges[item.badgeKey] : 0;
    const showDot = item.badgeKey === "lessonNew" && badge > 0;
    return { item, badge, showDot };
  });

  const totalBadges = items.reduce(
    (a, x) => a + (x.showDot ? 0 : x.badge),
    0,
  );

  if (!group.title) {
    return (
      <div className={cn("flex flex-col gap-0.5", index > 0 && "mt-3")}>
        {items.map(({ item, badge, showDot }) => (
          <NavItem key={item.to} item={item} badge={badge} showDot={showDot} />
        ))}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-0.5", index > 0 && "mt-3")}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className={cn(
          "group flex items-center justify-between px-2.5 py-1.5",
          "text-[10.5px] uppercase tracking-[.08em] font-semibold text-muted",
          "hover:text-text transition select-none",
        )}
        aria-expanded={!collapsed}
      >
        <span className="flex items-center gap-1.5">
          <ChevronDown
            className="w-3 h-3 shrink-0 transition-transform"
            style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0)" }}
          />
          {group.title}
        </span>
        {collapsed && totalBadges > 0 && (
          <span
            className="text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums leading-none"
            style={{ background: "var(--accent-grad)" }}
          >
            {totalBadges}
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-0.5">
          {items.map(({ item, badge, showDot }) => (
            <NavItem key={item.to} item={item} badge={badge} showDot={showDot} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ groups, role }: Props) {
  const auth = useAuth();
  const nav = useNavigate();
  const t = useT();
  const badges = useBadges(role);

  const onLogout = () => {
    auth.logout();
    nav("/login");
  };

  const initials = (auth.username || "?").slice(0, 2).toUpperCase();
  const roleLabel = role === "manager" ? t("role.manager") : t("role.operator");

  return (
    <aside
      className="nf-sidebar sticky top-0 h-screen flex flex-col shrink-0 border-r"
      style={{ width: 248, padding: "24px 14px 20px" }}
    >
      <Logo />

      <nav className="mt-5 flex-1 flex flex-col overflow-y-auto nf-scroll-thin -mx-2 px-2">
        {groups.map((group, i) => (
          <Group key={group.title ?? `_top_${i}`} group={group} badges={badges} index={i} />
        ))}
      </nav>

      <div className="mt-4 pt-3 border-t border-[color:var(--border)] px-1">
        <div className="flex items-center gap-2.5 py-2 px-1.5">
          <div
            className="grid place-items-center text-white text-[12px] font-semibold shrink-0"
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              background: "var(--accent-grad)",
            }}
          >
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium truncate">{auth.username}</div>
            <div className="text-[11px] text-muted">{roleLabel}</div>
          </div>
        </div>
        <button
          onClick={onLogout}
          className="w-full text-left px-2.5 py-2 text-[12.5px] text-muted hover:text-text transition rounded-lg hover:bg-[color:var(--faint)]"
        >
          {t("common.logout")}
        </button>
      </div>
    </aside>
  );
}
