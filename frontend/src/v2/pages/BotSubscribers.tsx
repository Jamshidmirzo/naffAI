import { AxiosError } from "axios";
import { toast } from "../../components/ui";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import { useBotSubscriberToggle, useBotSubscribers, type BotSubscriber } from "../api/admin";

const COLS = "minmax(180px,1.4fr) 150px minmax(160px,1.2fr) 70px 110px 140px";

function ago(iso: string, lang: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  const uz = lang === "uz";
  if (s < 60) return uz ? "hozirgina" : "только что";
  if (s < 3600) return uz ? `${Math.floor(s / 60)} daq oldin` : `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return uz ? `${Math.floor(s / 3600)} soat oldin` : `${Math.floor(s / 3600)} ч назад`;
  const days = Math.floor(s / 86400);
  if (days < 30) return uz ? `${days} kun oldin` : `${days} дн назад`;
  return d.toLocaleDateString(uz ? "uz-UZ" : "ru-RU");
}

/** /bot-subscribers — who receives the manager broadcasts (MgBotSubs). */
export default function BotSubscribers() {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const q = useBotSubscribers();
  const toggle = useBotSubscriberToggle();
  const rows = q.data ?? [];
  const blocked = rows.filter((r) => r.blocked_at).length;

  const who = (r: BotSubscriber) => {
    if (r.linked_operator) return `${r.linked_operator.full_name} · ${t("bot_subs.role_operator")}`;
    const p = r.linked_profile;
    if (p) return `${p.full_name || p.username || `#${p.id}`} · ${p.role === "operator" ? t("bot_subs.role_operator") : t("bot_subs.role_manager")}`;
    return "—";
  };

  return (
    <>
      <PageHeader title={t("bot_subs.title")} meta={t("bot_subs.subtitle")} back="/bot">
        {q.data ? <span className="s c3">{t("v2.admin.botsubs.meta", { n: rows.length, b: blocked })}</span> : null}
      </PageHeader>
      <main className="page">
        <section className="card tbl">
          {q.isLoading ? (
            <LoadingBlock rows={6} onRetry={() => q.refetch()} />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState title={t("bot_subs.empty_title")} body={t("bot_subs.empty_hint")} />
          ) : (
            <div className="scroll-x">
              <div style={{ minWidth: 820 }}>
                <div className="tr th" style={{ gridTemplateColumns: COLS }}>
                  <span>{t("bot_subs.col.chat")}</span>
                  <span>{t("bot_subs.col.phone")}</span>
                  <span>{t("bot_subs.col.linked")}</span>
                  <span>{t("bot_subs.col.lang")}</span>
                  <span>{t("bot_subs.col.broadcast")}</span>
                  <span>{t("bot_subs.col.last_seen")}</span>
                </div>
                {rows.map((r) => (
                  <div key={r.id} className="tr" style={{ gridTemplateColumns: COLS }}>
                    <span className="row g6" style={{ minWidth: 0 }}>
                      <span className="s w6 trunc">{r.chat_title || `chat#${r.chat_id}`}</span>
                      {r.blocked_at ? (
                        <span className="badge b-bad">{t("bot_subs.blocked_badge")}</span>
                      ) : !r.is_active ? (
                        <span className="badge">{t("bot_subs.inactive_badge")}</span>
                      ) : null}
                    </span>
                    <span className="num s c2">{r.phone || "—"}</span>
                    <span className="s trunc">{who(r)}</span>
                    <span className="s c3" style={{ textTransform: "uppercase" }}>{r.language}</span>
                    <button
                      className={cx("switch", r.receives_broadcasts && "is-on")}
                      type="button"
                      role="switch"
                      aria-checked={r.receives_broadcasts}
                      aria-label={`${t("bot_subs.col.broadcast")}: ${r.chat_title || r.chat_id}`}
                      disabled={toggle.isPending && toggle.variables?.id === r.id}
                      onClick={() =>
                        toggle.mutate(
                          { id: r.id, receives_broadcasts: !r.receives_broadcasts },
                          {
                            onSuccess: () => toast.success(t("bot_subs.toggle_saved")),
                            onError: (err) => {
                              const detail = err instanceof AxiosError ? (err.response?.data as { detail?: string })?.detail : "";
                              toast.error(detail ? `${t("bot_subs.toggle_failed")}: ${detail}` : t("bot_subs.toggle_failed"));
                            },
                          },
                        )
                      }
                    >
                      <i />
                    </button>
                    <span className="s c3">{ago(r.last_seen_at, lang)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
