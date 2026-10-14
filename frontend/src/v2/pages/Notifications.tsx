import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { Bell, BookOpen, Camera, Check, Clock, Gift, Info, PartyPopper, Undo2, User, Wallet, X, type LucideIcon } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../store/auth";
import { normaliseRole } from "../../components/RoleGate";
import { toast } from "../../components/ui";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { cx, EmptyState, ErrorState, LoadingBlock, PageHeader } from "../ui";
import {
  useApproveSale,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationPreferences,
  useNotificationsPage,
  usePendingSaleIds,
  useUpdateNotificationPreference,
  type NotifPref,
  type NotifResponse,
  type NotificationRow,
} from "../api/personal";

type T = ReturnType<typeof useT2>;

const KIND_META: Record<string, { icon: LucideIcon; tile: string; group: "sales" | "team" | "system" }> = {
  sale_created: { icon: Wallet, tile: "t-ok", group: "sales" },
  sale_returned: { icon: Undo2, tile: "t-bad", group: "sales" },
  sale_rejected: { icon: X, tile: "t-bad", group: "sales" },
  sale_celebration: { icon: PartyPopper, tile: "t-ok", group: "sales" },
  callback_overdue: { icon: Clock, tile: "t-bad", group: "team" },
  lead_assigned: { icon: User, tile: "t-info", group: "team" },
  birthday: { icon: Gift, tile: "t-warn", group: "team" },
  snapshot_request: { icon: Camera, tile: "t-hot", group: "system" },
  system: { icon: Info, tile: "t-info", group: "system" },
};

function metaFor(n: NotificationRow) {
  if (n.kind === "system" && /урок|dars|lesson/i.test(n.title)) return { icon: BookOpen, tile: "t-info", group: "system" as const };
  return KIND_META[n.kind] ?? { icon: Bell, tile: "", group: "system" as const };
}

/** «14:18» today, «вчера 18:05», «11.10 16:02», older years with the year. */
function fmtWhen(iso: string, t: T) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return time;
  if (diff === 1) return `${t("v2.personal.notif.yesterday")} ${time}`;
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear() ? { day: "2-digit", month: "2-digit" } : { day: "2-digit", month: "2-digit", year: "2-digit" };
  return `${d.toLocaleDateString("ru-RU", opts)} ${time}`;
}

type Tab = "all" | "sales" | "team" | "system";

export default function Notifications() {
  const t = useT2();
  const nav = useNavigate();
  const role = normaliseRole(useAuth((s) => s.role));
  const isMgr = role === "manager" || role === "super_manager";

  const first = useNotificationsPage(1);
  const [extraPages, setExtraPages] = useState(0);
  const more = useQueries({
    queries: Array.from({ length: extraPages }, (_, i) => i + 2).map((page) => ({
      queryKey: ["notifications", "list", "page", page],
      queryFn: () => api.get<NotifResponse>("/notifications/", { params: { page } }).then((r) => r.data),
    })),
  });

  const markOne = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const pending = usePendingSaleIds(isMgr);
  const approve = useApproveSale();
  const [tab, setTab] = useState<Tab>("all");

  const items = useMemo(() => {
    const all = [...(first.data?.results ?? []), ...more.flatMap((q) => q.data?.results ?? [])];
    const seen = new Set<number>();
    return all.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
  }, [first.data, more]);
  const lastMore = more[more.length - 1];
  const hasNext = extraPages === 0 ? !!first.data?.next : !!lastMore?.data?.next;
  const loadingMore = more.some((q) => q.isLoading);

  const unread = first.data?.unread_count ?? 0;
  const total = first.data?.count ?? items.length;
  const pendingIds = new Set((pending.data?.results ?? []).map((s) => s.id));
  const visible = tab === "all" ? items : items.filter((n) => metaFor(n).group === tab);

  const open = (n: NotificationRow) => {
    if (!n.read_at) markOne.mutate(n.id);
    if (n.link) nav(n.link);
  };

  const doApprove = (n: NotificationRow, saleId: number) =>
    approve.mutate(saleId, {
      onSuccess: () => {
        if (!n.read_at) markOne.mutate(n.id);
        toast.success(t("sale_pending.approve_done"));
      },
      onError: (e) => toast.error(apiErrorMessage(e) || t("sale_pending.approve_failed")),
    });

  const meta = first.data
    ? unread > 0
      ? t("notif.unread_of_total", { unread, total })
      : t("notif.total_only", { n: total })
    : undefined;

  return (
    <>
      <PageHeader title={t("notif.title")} meta={meta}>
        {unread > 0 ? (
          <button
            className="btn"
            type="button"
            disabled={markAll.isPending}
            onClick={() => markAll.mutate(undefined, { onSuccess: () => toast.success(t("notif.all_marked")), onError: (e) => toast.error(apiErrorMessage(e)) })}
          >
            <Check className="ic" />
            {t("notif.mark_all_short")}
          </button>
        ) : null}
      </PageHeader>
      <main className="page">
        <div className="split">
          <section className="list card col">
            {isMgr ? (
              <div className="tabs" role="tablist" style={{ padding: "0 12px" }}>
                {(["all", "sales", "team", "system"] as Tab[]).map((k) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k} className={cx("tab", tab === k && "is-on")} onClick={() => setTab(k)}>
                    {t(`v2.personal.notif.tab.${k}`)}
                  </button>
                ))}
              </div>
            ) : null}
            {first.isLoading ? (
              <LoadingBlock rows={6} onRetry={() => first.refetch()} />
            ) : first.isError ? (
              <ErrorState error={first.error} onRetry={() => first.refetch()} />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={<Bell className="ic ic-l" />}
                title={tab === "all" ? t("notif.empty_soft") : t("v2.personal.notif.emptyTab")}
                body={tab === "all" ? t("v2.personal.notif.emptyBody") : undefined}
              />
            ) : (
              <>
                {visible.map((n) => {
                  const m = metaFor(n);
                  const Icon = m.icon;
                  const saleId = typeof n.metadata?.sale_id === "number" ? (n.metadata.sale_id as number) : null;
                  const canApprove = isMgr && n.kind === "sale_created" && saleId !== null && pendingIds.has(saleId);
                  const clickable = !!n.link || !n.read_at;
                  return (
                    <div
                      key={n.id}
                      className="row-item"
                      role={clickable ? "button" : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onClick={clickable ? () => open(n) : undefined}
                      onKeyDown={clickable ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(n)) : undefined}
                      style={{ alignItems: "flex-start", cursor: clickable ? "pointer" : undefined, background: n.read_at ? undefined : "var(--surface-2)" }}
                    >
                      <span className={cx("icon-tile", m.tile)}><Icon className="ic" /></span>
                      <span className="col grow" style={{ gap: 4, minWidth: 0 }}>
                        <span className="row g8">
                          <span className={cx("s", n.read_at ? "w5" : "w6")}>{n.title}</span>
                          {!n.read_at ? <i className="dot" style={{ color: "var(--brand)" }} aria-label={t("v2.personal.notif.unread")} /> : null}
                        </span>
                        {n.body ? <span className="s c2" style={{ whiteSpace: "pre-line" }}>{n.body}</span> : null}
                        {canApprove ? (
                          <span className="row g6" style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                            <button className="btn btn-sm btn-ok" type="button" disabled={approve.isPending} onClick={() => doApprove(n, saleId!)}>
                              {t("sale_pending.approve")}
                            </button>
                            <button className="btn btn-sm" type="button" onClick={() => open(n)}>{t("v2.personal.notif.open")}</button>
                          </span>
                        ) : null}
                      </span>
                      <span className="num xs c3" style={{ flex: "none" }} title={new Date(n.created_at).toLocaleString("ru-RU")}>{fmtWhen(n.created_at, t)}</span>
                    </div>
                  );
                })}
                {hasNext ? (
                  <div className="row" style={{ padding: 12, justifyContent: "center" }}>
                    <button className="btn btn-ghost" type="button" disabled={loadingMore} onClick={() => setExtraPages((p) => p + 1)}>
                      {loadingMore ? t("common.loading") : t("v2.personal.notif.more")}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </section>
          <PreferencesPanel />
        </div>
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ */

const KIND_ORDER = ["lead_assigned", "callback_overdue", "sale_created", "sale_rejected", "sale_returned", "sale_celebration", "birthday", "snapshot_request", "system"];

function PreferencesPanel() {
  const t = useT2();
  const prefs = useNotificationPreferences();
  const upd = useUpdateNotificationPreference();

  // Endpoint not deployed (404) or failing → the old page only had
  // browser-local switches that saved nothing; we don't fake that.
  if (prefs.isLoading) {
    return (
      <aside className="panel card col" style={{ alignSelf: "flex-start" }}>
        <LoadingBlock rows={3} />
      </aside>
    );
  }
  if (prefs.isError || !prefs.data?.items?.length) return null;

  const items = [...prefs.data.items].sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a.kind);
    const ib = KIND_ORDER.indexOf(b.kind);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const toggle = (p: NotifPref, field: "in_app" | "telegram") =>
    upd.mutate(
      { kind: p.kind, [field]: !p[field] },
      {
        onSuccess: () => toast.success(t("toast.settings_saved")),
        onError: (e) => toast.error(apiErrorMessage(e) || t("profile.settings_save_failed")),
      },
    );

  const label = (k: string) => {
    const key = `v2.personal.notif.kind.${k}`;
    const v = t(key);
    return v === key ? k : v;
  };
  const note = (k: string) => {
    const key = `v2.personal.notif.kindNote.${k}`;
    const v = t(key);
    return v === key ? "" : v;
  };

  return (
    <aside className="panel card col" style={{ alignSelf: "flex-start" }}>
      <div className="card-h">
        <div className="col">
          <span className="h3">{t("notif.subs_title")}</span>
          <span className="xs c3">{t("notif.subs_subtitle")}</span>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <div className="tr th" style={{ gridTemplateColumns: "1fr 76px 76px" }}>
          <span>{t("v2.personal.notif.event")}</span>
          <span>{t("v2.personal.notif.inApp")}</span>
          <span>Telegram</span>
        </div>
        {items.map((p) => (
          <div key={p.kind} className="tr" style={{ gridTemplateColumns: "1fr 76px 76px", minHeight: 56 }}>
            <span className="col" style={{ minWidth: 0 }}>
              <span className="s">{label(p.kind)}</span>
              {note(p.kind) ? <span className="xs c3">{note(p.kind)}</span> : null}
            </span>
            <span>
              <button className={cx("switch", p.in_app && "is-on")} type="button" role="switch" aria-checked={p.in_app} aria-label={`${label(p.kind)}: ${t("v2.personal.notif.inApp")}`} onClick={() => toggle(p, "in_app")}>
                <i />
              </button>
            </span>
            <span>
              <button className={cx("switch", p.telegram && "is-on")} type="button" role="switch" aria-checked={p.telegram} aria-label={`${label(p.kind)}: Telegram`} onClick={() => toggle(p, "telegram")}>
                <i />
              </button>
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
