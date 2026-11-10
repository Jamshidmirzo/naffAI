import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { ArrowDown, ArrowUp, ChevronDown, GripVertical, SlidersHorizontal } from "lucide-react";
import { useAuth } from "../../store/auth";
import { isSuperManager, isSuperadmin } from "../RoleGate";
import { cn } from "../ui/cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useMe } from "../../hooks/useMe";

export interface SidebarItem {
  to: string;
  label: string;
  end?: boolean;
  external?: boolean;
  badgeKey?: "leadsReview" | "notifs" | "lessonNew" | "orphans" | "myBlockers" | "salesPending";
}

export interface SidebarGroup {
  /** Stable key — saved menu order and the super/manager nav merge use it. */
  id?: string;
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
  const orphansCount = useQuery({
    queryKey: ["orphan-leads-count"],
    queryFn: async () => {
      // Бейдж — только `free` пул. С 2026-09-02 needs_review / stranded
      // ушли в system-lost, отдельного счётчика для менеджера нет.
      const { data } = await api.get<{
        count?: number;
        counts_by_kind?: Record<string, number>;
      }>("/leads/orphans/?limit=1");
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
  // Красное число на «Мои лиды»: carry + recall_afternoon — вчерашние
  // и «застрявшие после обеда» лиды, которые оператор часто не замечает.
  // Тот же endpoint /leads/my/status/ читает баннер на самой странице —
  // react-query auto-dedup склеит вызовы в один сетевой запрос.
  const myStatus = useQuery({
    queryKey: ["leads-my-status"],
    queryFn: () =>
      api
        .get<{
          carry_count: number;
          recall_afternoon_count: number;
        }>("/leads/my/status/")
        .then((r) => r.data),
    enabled: role === "operator",
    refetchInterval: 60000,
    retry: false,
  });
  const myBlockers =
    role === "operator" && myStatus.data
      ? myStatus.data.carry_count + myStatus.data.recall_afternoon_count
      : 0;
  return {
    leadsReview: role === "manager" ? needsReview.data ?? 0 : 0,
    orphans: role === "manager" ? orphansCount.data ?? 0 : 0,
    salesPending: role === "manager" ? salesPending.data ?? 0 : 0,
    lessonNew: role === "operator" && lessonPeek.data && !lessonPeek.data.opened_at ? 1 : 0,
    notifs: unreadNotifs.data ?? 0,
    myBlockers,
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

/*
 * Own menu order («hohlagan joyimga qo'yib olaman»). The groups are
 * flattened into one list of entries — section headers, the gaps between
 * untitled groups and the items themselves — so anything can be dragged
 * anywhere, including an item into another section. The saved order is
 * just the list of entry keys (Profile.nav_order, mirrored in localStorage).
 */
type Entry =
  | { kind: "item"; key: string; item: SidebarItem }
  | { kind: "header"; key: string; title: string; collapsedByDefault?: boolean }
  | { kind: "break"; key: string };

function flatten(groups: SidebarGroup[]): Entry[] {
  const out: Entry[] = [];
  groups.forEach((g, i) => {
    const id = g.id ?? g.title ?? String(i);
    if (g.title) {
      out.push({ kind: "header", key: `h:${id}`, title: g.title, collapsedByDefault: g.collapsedByDefault });
    } else if (i > 0) {
      out.push({ kind: "break", key: `b:${id}` });
    }
    g.items.forEach((item) => out.push({ kind: "item", key: item.to, item }));
  });
  return out;
}

/** Saved keys first, in saved order; entries the saved list doesn't know
 *  (a menu item added later) land right after their default neighbour. */
function applyOrder(defaults: Entry[], saved: string[]): Entry[] {
  if (saved.length === 0) return defaults;
  const byKey = new Map(defaults.map((e) => [e.key, e]));
  const out = saved.filter((k) => byKey.has(k)).map((k) => byKey.get(k)!);
  const placed = new Set(out.map((e) => e.key));
  defaults.forEach((e, i) => {
    if (placed.has(e.key)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.findIndex((x) => x.key === defaults[j].key);
      if (idx >= 0) {
        at = idx + 1;
        break;
      }
    }
    out.splice(at, 0, e);
    placed.add(e.key);
  });
  return out;
}

function regroup(entries: Entry[]): (SidebarGroup & { key: string })[] {
  const out: (SidebarGroup & { key: string })[] = [];
  let cur: SidebarGroup & { key: string } = { key: "_top", items: [] };
  for (const e of entries) {
    if (e.kind === "item") {
      cur.items.push(e.item);
      continue;
    }
    out.push(cur);
    cur =
      e.kind === "header"
        ? { key: e.key, title: e.title, collapsedByDefault: e.collapsedByDefault, items: [] }
        : { key: e.key, items: [] };
  }
  out.push(cur);
  return out.filter((g) => g.items.length > 0);
}

const NAV_ORDER_LS = "naffai_nav_order:";

function readLocalOrder(username: string | null): string[] {
  try {
    const raw = localStorage.getItem(NAV_ORDER_LS + (username ?? ""));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function useNavOrder(username: string | null) {
  const me = useMe();
  const qc = useQueryClient();
  const [local, setLocal] = useState<string[] | null>(null);
  const timer = useRef<number | undefined>(undefined);

  // Server copy wins (another computer may have changed it); the local
  // copy covers the first paint and a backend without the field.
  const serverOrder = me.data && me.data.username === username ? me.data.nav_order : undefined;
  const order = local ?? (serverOrder && serverOrder.length > 0 ? serverOrder : readLocalOrder(username));

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const save = (next: string[]) => {
    setLocal(next);
    try {
      localStorage.setItem(NAV_ORDER_LS + (username ?? ""), JSON.stringify(next));
    } catch {
      /* private mode — the server copy still saves */
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api
        .patch("/auth/me/", { nav_order: next })
        .then(() => qc.setQueryData(["auth", "me"], (old: object | undefined) => old && { ...old, nav_order: next }))
        .catch(() => undefined);
    }, 600);
  };
  return { order, save };
}

interface EditListProps {
  entries: Entry[];
  onChange: (keys: string[]) => void;
}

function EditList({ entries, onChange }: EditListProps) {
  const t = useT();
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [drop, setDrop] = useState<number | null>(null);

  const keys = entries.map((e) => e.key);
  const move = (from: number, to: number) => {
    if (from === to || from + 1 === to) return;
    const next = [...keys];
    const [k] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, k);
    onChange(next);
  };

  return (
    <div className="flex flex-col" onDragEnd={() => {
      setDragKey(null);
      setDrop(null);
    }}>
      {entries.map((e, i) => {
        const indicator = drop === i ? "top" : drop === i + 1 && i === entries.length - 1 ? "bottom" : null;
        return (
          <div
            key={e.key}
            draggable
            onDragStart={(ev) => {
              setDragKey(e.key);
              ev.dataTransfer.effectAllowed = "move";
              ev.dataTransfer.setData("text/plain", e.key);
            }}
            onDragOver={(ev) => {
              ev.preventDefault();
              const r = ev.currentTarget.getBoundingClientRect();
              setDrop(ev.clientY < r.top + r.height / 2 ? i : i + 1);
            }}
            onDrop={(ev) => {
              ev.preventDefault();
              const from = keys.indexOf(dragKey ?? ev.dataTransfer.getData("text/plain"));
              if (from >= 0 && drop !== null) move(from, drop);
              setDragKey(null);
              setDrop(null);
            }}
            className={cn(
              "group relative flex items-center gap-1.5 rounded-lg px-1.5 cursor-grab active:cursor-grabbing select-none",
              "hover:bg-[color:var(--faint)] transition",
              e.kind === "item" ? "py-1.5 text-[13px]" : "py-1 mt-1",
              dragKey === e.key && "opacity-40",
            )}
            style={{
              boxShadow:
                indicator === "top"
                  ? "inset 0 2px 0 var(--accent)"
                  : indicator === "bottom"
                    ? "inset 0 -2px 0 var(--accent)"
                    : undefined,
            }}
          >
            <GripVertical className="w-3.5 h-3.5 shrink-0 text-muted" />
            {e.kind === "item" && <span className="flex-1 truncate">{e.item.label}</span>}
            {e.kind === "header" && (
              <span className="flex-1 truncate text-[10.5px] uppercase tracking-[.08em] font-semibold text-muted">
                {e.title}
              </span>
            )}
            {e.kind === "break" && (
              <span className="flex-1 flex items-center gap-2 text-[10.5px] text-muted">
                <span className="flex-1 border-t border-dashed border-[color:var(--border)]" />
                {t("sidebar.group_break")}
                <span className="flex-1 border-t border-dashed border-[color:var(--border)]" />
              </span>
            )}
            <span className="flex items-center opacity-0 group-hover:opacity-100 transition">
              <button
                type="button"
                title={t("sidebar.move_up")}
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
                className="grid place-items-center rounded hover:bg-[color:var(--border)] disabled:opacity-30"
                style={{ width: 20, height: 20 }}
              >
                <ArrowUp className="w-3 h-3" />
              </button>
              <button
                type="button"
                title={t("sidebar.move_down")}
                disabled={i === entries.length - 1}
                onClick={() => move(i, i + 2)}
                className="grid place-items-center rounded hover:bg-[color:var(--border)] disabled:opacity-30"
                style={{ width: 20, height: 20 }}
              >
                <ArrowDown className="w-3 h-3" />
              </button>
            </span>
          </div>
        );
      })}
    </div>
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
  const t = useT();
  const badges = useBadges(role);
  const canEdit = role === "manager";
  const [editing, setEditing] = useState(false);
  const { order, save } = useNavOrder(auth.username);
  const defaults = useMemo(() => flatten(groups), [groups]);
  const entries = useMemo(
    () => (canEdit ? applyOrder(defaults, order) : defaults),
    [canEdit, defaults, order],
  );
  const shown = useMemo(() => regroup(entries), [entries]);

  const onLogout = () => {
    auth.logout();
    // Full reload: the live publisher, intervals and stores of this user
    // must not survive into the next login on this tab.
    window.location.replace("/login");
  };

  const me = useQuery<{ operator_name: string | null; display_name: string | null }>({
    queryKey: ["auth-me-sidebar"],
    queryFn: () => api.get("/auth/me/").then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  const initials = (auth.username || "?").slice(0, 2).toUpperCase();
  // Sidebar прошёл collapse из AppShell (super_manager → "manager"), поэтому
  // лейбл роли берём по raw role, иначе super_manager видит "Menejer"
  // вместо "Super-menejer".
  const rawRole = auth.role;
  const roleLabel = isSuperadmin(rawRole)
    ? t("role.manager")
    : isSuperManager(rawRole)
      ? t("role.super_manager")
      : role === "manager"
        ? t("role.manager")
        : t("role.operator");
  const displayName = (me.data?.display_name ?? me.data?.operator_name)?.trim();
  const roleWithName = displayName ? `${roleLabel} ${displayName}` : roleLabel;

  return (
    <aside
      className="nf-sidebar sticky top-0 h-screen flex flex-col shrink-0 border-r"
      style={{ width: 248, padding: "24px 14px 20px" }}
    >
      <Logo />

      <nav className="mt-5 flex-1 flex flex-col overflow-y-auto nf-scroll-thin -mx-2 px-2">
        {editing ? (
          <>
            <div className="text-[11.5px] text-muted px-1.5 mb-2 leading-snug">{t("sidebar.edit_hint")}</div>
            <EditList entries={entries} onChange={save} />
          </>
        ) : (
          shown.map((group, i) => (
            <Group key={group.key} group={group} badges={badges} index={i} />
          ))
        )}
      </nav>

      {canEdit && (
        <div className="mt-2 flex items-center gap-1 px-1">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className={cn(
              "flex-1 flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] rounded-lg transition",
              editing
                ? "font-semibold text-white"
                : "text-muted hover:text-text hover:bg-[color:var(--faint)]",
            )}
            style={editing ? { background: "var(--accent-grad)" } : undefined}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {editing ? t("sidebar.edit_done") : t("sidebar.edit")}
          </button>
          {editing && order.length > 0 && (
            <button
              type="button"
              onClick={() => save([])}
              className="px-2.5 py-1.5 text-[12px] text-muted hover:text-text rounded-lg hover:bg-[color:var(--faint)] transition"
            >
              {t("sidebar.edit_reset")}
            </button>
          )}
        </div>
      )}

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
            <div className="text-[11px] text-muted truncate">{roleWithName}</div>
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
