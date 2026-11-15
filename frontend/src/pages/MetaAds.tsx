import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { Modal, toast } from "../components/ui";
import { Select } from "../components/Select";
import { apiErrorMessage } from "../lib/api-types";
import { useT } from "../lib/i18n";
import { usePageHeader } from "../store/page";
import {
  fmtWhen,
  useMetaAccountSync,
  useMetaAccountUpdate,
  useMetaConnectionCheck,
  useMetaConnectionCreate,
  useMetaConnectionDelete,
  useMetaConnectionUpdate,
  useMetaConnections,
  useMetaPageSync,
  useMetaPageUpdate,
  useSmmOptions,
  type MetaAdAccountRow,
  type MetaConnectionRow,
  type MetaPageRow,
} from "../lib/meta";

/**
 * /settings/meta-ads — подключение Meta: токен (личный или системного
 * пользователя) → рекламные аккаунты (статистика раз в час) и страницы
 * Facebook (заявки из лид-форм раз в минуту → операторам).
 * Перенос v2-страницы из feat/design-atlas в текущий дизайн.
 */
export default function MetaAds() {
  const t = useT();
  const q = useMetaConnections();
  usePageHeader({ title: t("meta.title"), subtitle: t("meta.subtitle") }, []);

  const accounts = (q.data ?? []).flatMap((c) => c.accounts);
  const pages = (q.data ?? []).flatMap((c) => c.pages ?? []);

  return (
    <div className="mx-auto max-w-[1100px] flex flex-col gap-5">
      <h1 className="font-semibold" style={{ fontSize: 24, letterSpacing: "-0.02em" }}>
        {t("meta.title")}
      </h1>
      <HowTo />
      <ConnectForm />
      {q.isLoading && (
        <div className="nf-card p-8 text-center text-[13.5px] text-muted animate-pulse">{t("common.loading")}</div>
      )}
      {q.isError && <div className="nf-card p-6 text-[13.5px] text-red-600">{apiErrorMessage(q.error)}</div>}
      {q.data && (
        <>
          <section className="nf-card p-0 overflow-hidden">
            <div className="px-5 pt-4 pb-2 text-[15px] font-semibold">{t("meta.connections")}</div>
            {q.data.length === 0 && <div className="px-5 pb-4 text-[13px] text-muted">{t("meta.no_connections")}</div>}
            {q.data.map((c) => (
              <ConnectionRow key={c.id} c={c} />
            ))}
          </section>
          {q.data.length > 0 && <PagesTable pages={pages} />}
          {q.data.length > 0 && <AccountsTable accounts={accounts} />}
        </>
      )}
    </div>
  );
}

function HowTo() {
  const t = useT();
  return (
    <section className="nf-card p-5 flex flex-col gap-2.5">
      <div className="text-[15px] font-semibold">{t("meta.how")}</div>
      {["meta.how1", "meta.how2", "meta.how3", "meta.how4"].map((k, i) => (
        <div key={k} className="flex items-start gap-2.5">
          <span
            className="nf-badge nf-tnum"
            style={{ flex: "none", minWidth: 22, justifyContent: "center" }}
          >
            {i + 1}
          </span>
          <span className="text-[13px] leading-relaxed" style={{ color: "var(--text)", opacity: 0.85 }}>
            {t(k)}
          </span>
        </div>
      ))}
    </section>
  );
}

function Field({ label, htmlFor, children, className }: { label: string; htmlFor: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <label htmlFor={htmlFor} className="text-[12px] text-muted">{label}</label>
      {children}
    </div>
  );
}

function ConnectForm() {
  const t = useT();
  const create = useMetaConnectionCreate();
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    try {
      const c = await create.mutateAsync({ token: token.trim(), name: name.trim() || undefined });
      setToken("");
      setName("");
      toast.success(t("meta.connected", { who: c.meta_user_name, n: c.accounts.length, p: c.pages?.length ?? 0 }));
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };
  return (
    <form className="nf-card p-5 flex flex-wrap items-end gap-3" onSubmit={submit}>
      <Field label={t("meta.token")} htmlFor="meta-token" className="grow">
        <input
          id="meta-token"
          className="nf-input nf-tnum"
          style={{ minWidth: 280 }}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="EAAG…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>
      <Field label={t("meta.name")} htmlFor="meta-name" className="w-[220px]">
        <input id="meta-name" className="nf-input" placeholder="NAFF" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <button className="nf-btn nf-btn--primary" type="submit" disabled={!token.trim() || create.isPending}>
        <KeyRound size={16} />
        {create.isPending ? t("meta.connecting") : t("meta.connect")}
      </button>
    </form>
  );
}

function ConnectionRow({ c }: { c: MetaConnectionRow }) {
  const t = useT();
  const check = useMetaConnectionCheck();
  const del = useMetaConnectionDelete();
  const [replacing, setReplacing] = useState(false);
  const label = c.name || c.meta_user_name || `#${c.id}`;
  const expiresSoon =
    !!c.token_expires_at && new Date(c.token_expires_at).getTime() - Date.now() < 7 * 86400_000;

  const runCheck = async () => {
    try {
      const r = await check.mutateAsync(c.id);
      if (r.last_error) toast.error(r.last_error);
      else toast.success(t("meta.checked"));
    } catch (e) {
      toast.error(apiErrorMessage(e));
    }
  };
  const remove = async () => {
    if (!confirm(t("meta.delete_confirm", { name: label }))) return;
    try {
      await del.mutateAsync(c.id);
      toast.success(t("meta.deleted"));
    } catch (e) {
      toast.error(apiErrorMessage(e));
    }
  };

  const meta = [
    c.meta_user_name && c.meta_user_name !== label ? c.meta_user_name : "",
    c.token_expires_at ? t("meta.expires", { d: fmtWhen(c.token_expires_at) }) : t("meta.no_expiry"),
    c.last_checked_at ? t("meta.checked_at", { at: fmtWhen(c.last_checked_at) }) : "",
    t("meta.counts", { n: c.accounts.length, p: c.pages?.length ?? 0 }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="px-5 py-3 flex flex-col gap-2" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="flex flex-wrap items-center gap-3">
        {c.last_error ? (
          <AlertTriangle size={18} className="text-red-600" />
        ) : (
          <CheckCircle2 size={18} className="text-emerald-600" />
        )}
        <span className="flex flex-col grow min-w-0">
          <span className="text-[13.5px] font-semibold truncate">{label}</span>
          <span className="text-[12px] text-muted">{meta}</span>
        </span>
        <button className="nf-btn nf-btn--secondary text-[12.5px]" type="button" onClick={runCheck} disabled={check.isPending}>
          <RefreshCw size={14} className={check.isPending ? "animate-spin" : ""} />
          {t("meta.check")}
        </button>
        <button className="nf-btn nf-btn--secondary text-[12.5px]" type="button" onClick={() => setReplacing(true)}>
          {t("meta.replace")}
        </button>
        <button
          className="nf-btn nf-btn--ghost text-[12.5px]"
          type="button"
          onClick={remove}
          aria-label={t("common.delete")}
          title={t("common.delete")}
        >
          <Trash2 size={15} />
        </button>
      </div>
      {c.last_error && (
        <div className="rounded-xl px-3 py-2 text-[12.5px] text-red-700 bg-red-50 dark:bg-red-950/40 dark:text-red-300" role="alert">
          {c.last_error}
        </div>
      )}
      {expiresSoon && !c.last_error && (
        <div className="rounded-xl px-3 py-2 text-[12.5px] text-amber-800 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300">
          {t("meta.expires_soon", { d: fmtWhen(c.token_expires_at) })}
        </div>
      )}
      {c.accounts.length === 0 && !c.last_error && <span className="text-[12px] text-muted">{t("meta.no_accounts")}</span>}
      <ReplaceTokenModal open={replacing} c={c} onClose={() => setReplacing(false)} />
    </div>
  );
}

function ReplaceTokenModal({ open, c, onClose }: { open: boolean; c: MetaConnectionRow; onClose: () => void }) {
  const t = useT();
  const upd = useMetaConnectionUpdate();
  const [token, setToken] = useState("");
  const submit = async () => {
    try {
      await upd.mutateAsync({ id: c.id, token: token.trim() });
      toast.success(t("meta.replaced"));
      setToken("");
      onClose();
    } catch (e) {
      toast.error(apiErrorMessage(e));
    }
  };
  return (
    <Modal open={open} onClose={onClose} width={480}>
      <div className="p-5 flex flex-col gap-4">
        <div>
          <div className="text-[16px] font-semibold">{t("meta.replace")}</div>
          <div className="text-[12.5px] text-muted">{c.name || c.meta_user_name}</div>
        </div>
        <Field label={t("meta.token")} htmlFor={`meta-token-${c.id}`}>
          <input
            id={`meta-token-${c.id}`}
            className="nf-input nf-tnum"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="EAAG…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <button className="nf-btn nf-btn--secondary" type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="nf-btn nf-btn--primary" type="button" onClick={submit} disabled={!token.trim() || upd.isPending}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SmmSelect({ value, onChange }: { value: number | null | undefined; onChange: (v: number | null) => void }) {
  const t = useT();
  const smm = useSmmOptions();
  return (
    <Select<string>
      ariaLabel={t("meta.col_smm")}
      value={value ? String(value) : ""}
      onChange={(v) => onChange(v ? Number(v) : null)}
      options={[
        { value: "", label: t("meta.no_smm") },
        ...(smm.data ?? []).map((s) => ({ value: String(s.id), label: s.name })),
      ]}
    />
  );
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-5 pt-4 pb-3">
      <div className="text-[15px] font-semibold">{title}</div>
      {hint && <div className="text-[12px] text-muted mt-0.5">{hint}</div>}
    </div>
  );
}

const BACKFILL = [0, 24, 168] as const;

function PagesTable({ pages }: { pages: MetaPageRow[] }) {
  const t = useT();
  const upd = useMetaPageUpdate();
  const pull = useMetaPageSync();
  const [backfill, setBackfill] = useState<Record<number, number>>({});
  const [pulling, setPulling] = useState<number | null>(null);

  const patch = async (p: MetaPageRow, body: { smm_id?: number | null; leads_enabled?: boolean; backfill_hours?: number }) => {
    try {
      await upd.mutateAsync({ id: p.id, ...body });
      toast.success(t("meta.saved"));
    } catch (e) {
      toast.error(apiErrorMessage(e));
    }
  };
  const runPull = async (p: MetaPageRow) => {
    setPulling(p.id);
    try {
      const r = await pull.mutateAsync(p.id);
      toast.success(t("meta.pulled", { n: r.result.created ?? 0 }));
    } catch (e) {
      toast.error(apiErrorMessage(e));
    } finally {
      setPulling(null);
    }
  };

  return (
    <section className="nf-card p-0 overflow-x-auto">
      <SectionHead title={t("meta.pages")} hint={t("meta.pages_hint")} />
      {pages.length === 0 ? (
        <div className="px-5 pb-4 text-[13px] text-muted">{t("meta.no_pages")}</div>
      ) : (
        <table className="w-full text-[13px]" style={{ minWidth: 820 }}>
          <thead>
            <tr className="text-left text-[11.5px] uppercase tracking-wide text-muted">
              <th className="px-5 py-2 font-medium">{t("meta.col_page")}</th>
              <th className="px-3 py-2 font-medium w-[180px]">{t("meta.col_smm")}</th>
              <th className="px-3 py-2 font-medium w-[170px]">{t("meta.col_import")}</th>
              <th className="px-3 py-2 font-medium">{t("meta.col_sync")}</th>
              <th className="px-5 py-2 w-[150px]" />
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => {
              const imported = p.forms.reduce((n, f) => n + f.leads_imported, 0);
              const liveForms = p.forms.filter((f) => !["ARCHIVED", "DELETED"].includes(f.status.toUpperCase()));
              return (
                <tr key={p.id} className="align-top" style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-5 py-3">
                    <div className="font-semibold truncate">{p.name || p.page_id}</div>
                    <div className="text-[12px] text-muted">{t("meta.forms", { n: liveForms.length, m: imported })}</div>
                    {liveForms.slice(0, 4).map((f) => (
                      <div key={f.id} className="text-[12px] text-muted truncate" title={f.name}>
                        · {f.name || f.form_id}
                        {f.last_lead_at ? ` — ${fmtWhen(f.last_lead_at)}` : ""}
                      </div>
                    ))}
                  </td>
                  <td className="px-3 py-3">
                    <SmmSelect value={p.smm_id} onChange={(v) => patch(p, { smm_id: v })} />
                  </td>
                  <td className="px-3 py-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={p.leads_enabled}
                        onChange={(e) =>
                          patch(p, {
                            leads_enabled: e.target.checked,
                            backfill_hours: e.target.checked ? backfill[p.id] ?? 0 : 0,
                          })
                        }
                      />
                      {t(p.leads_enabled ? "meta.import_on" : "meta.import_off")}
                    </label>
                    {!p.leads_enabled ? (
                      <div className="mt-2">
                        <Select<number>
                          ariaLabel={t("meta.backfill")}
                          value={backfill[p.id] ?? 0}
                          onChange={(v) => setBackfill((b) => ({ ...b, [p.id]: v }))}
                          options={BACKFILL.map((h) => ({ value: h, label: t(`meta.backfill_${h}`) }))}
                        />
                      </div>
                    ) : p.leads_since ? (
                      <div className="text-[12px] text-muted mt-1">{t("meta.since", { at: fmtWhen(p.leads_since) })}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-[12px]">
                    <div className="text-muted">
                      {p.last_polled_at ? t("meta.last_poll", { at: fmtWhen(p.last_polled_at) }) : t("meta.never")}
                    </div>
                    {p.source_name && <div className="text-muted truncate" title={p.source_name}>→ {p.source_name}</div>}
                    {p.source_active === false && <div className="text-amber-600">{t("meta.source_off")}</div>}
                    {p.last_poll_error && (
                      <div className="text-red-600" style={{ overflowWrap: "anywhere" }}>
                        {p.last_poll_error}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      className="nf-btn nf-btn--secondary text-[12.5px]"
                      type="button"
                      onClick={() => runPull(p)}
                      disabled={!p.leads_enabled || pulling !== null}
                    >
                      <RefreshCw size={14} className={pulling === p.id ? "animate-spin" : ""} />
                      {t("meta.pull_now")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AccountsTable({ accounts }: { accounts: MetaAdAccountRow[] }) {
  const t = useT();
  const upd = useMetaAccountUpdate();
  const sync = useMetaAccountSync();
  const [syncing, setSyncing] = useState<number | null>(null);

  const patch = async (a: MetaAdAccountRow, body: { smm_id?: number | null; is_active?: boolean }) => {
    try {
      await upd.mutateAsync({ id: a.id, ...body });
      toast.success(t("meta.saved"));
    } catch (e) {
      toast.error(apiErrorMessage(e));
    }
  };
  const runSync = async (a: MetaAdAccountRow) => {
    setSyncing(a.id);
    try {
      const r = await sync.mutateAsync({ id: a.id });
      toast.success(t("meta.sync_done", { n: r.result.insight_rows }));
    } catch (e) {
      toast.error(apiErrorMessage(e));
    } finally {
      setSyncing(null);
    }
  };

  return (
    <section className="nf-card p-0 overflow-x-auto">
      <SectionHead title={t("meta.accounts")} hint={t("meta.accounts_hint")} />
      {accounts.length === 0 ? (
        <div className="px-5 pb-4 text-[13px] text-muted">{t("meta.no_accounts")}</div>
      ) : (
        <table className="w-full text-[13px]" style={{ minWidth: 780 }}>
          <thead>
            <tr className="text-left text-[11.5px] uppercase tracking-wide text-muted">
              <th className="px-5 py-2 font-medium">{t("meta.col_account")}</th>
              <th className="px-3 py-2 font-medium w-[190px]">{t("meta.col_smm")}</th>
              <th className="px-3 py-2 font-medium w-[60px]">{t("meta.col_on")}</th>
              <th className="px-3 py-2 font-medium">{t("meta.col_sync")}</th>
              <th className="px-5 py-2 w-[170px]" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td className="px-5 py-3">
                  <div className="font-semibold truncate">{a.name || a.account_id}</div>
                  <div className="text-[12px] text-muted nf-tnum">
                    {a.account_id} · {a.currency}
                    {a.account_status != null && a.account_status !== 1 ? ` · ${t("meta.disabled_account")}` : ""}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <SmmSelect value={a.smm_id} onChange={(v) => patch(a, { smm_id: v })} />
                </td>
                <td className="px-3 py-3">
                  <input
                    type="checkbox"
                    aria-label={t("meta.col_on")}
                    checked={a.is_active}
                    onChange={(e) => patch(a, { is_active: e.target.checked })}
                  />
                </td>
                <td className="px-3 py-3 text-[12px]">
                  <div className="text-muted">
                    {a.last_synced_at ? t("meta.synced_at", { at: fmtWhen(a.last_synced_at) }) : t("meta.never")}
                  </div>
                  {a.last_sync_error && (
                    <div className="text-red-600 truncate" title={a.last_sync_error}>
                      {a.last_sync_error}
                    </div>
                  )}
                </td>
                <td className="px-5 py-3 text-right">
                  <button
                    className="nf-btn nf-btn--secondary text-[12.5px]"
                    type="button"
                    onClick={() => runSync(a)}
                    disabled={syncing !== null}
                  >
                    <RefreshCw size={14} className={syncing === a.id ? "animate-spin" : ""} />
                    {t("meta.sync_now")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
