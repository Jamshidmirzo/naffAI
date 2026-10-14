import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "../../components/ui";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, useConfirm } from "../ui";
import {
  useSetBankCreate,
  useSetBankDelete,
  useSetBankPlanCreate,
  useSetBankPlanDelete,
  useSetBanks,
  useSetMarketingSettings,
  useSetMarketingSettingsSave,
  useSetTierDelete,
  useSetTierUpsert,
  useSetTiers,
  type SetBank,
  type SetMarketingSettings,
  type SetTier,
} from "../api/admin";

type Block = "tiers" | "banks" | "marketing";

/**
 * /catalog/tiers, /catalog/banks, /catalog/marketing-settings — one page
 * (artboard MgCatalogMore) with three blocks; the route decides which block
 * is scrolled to and highlighted.
 */
export default function CatalogMore() {
  const t = useT2();
  const { pathname } = useLocation();
  const focus: Block = pathname.includes("banks") ? "banks" : pathname.includes("marketing") ? "marketing" : "tiers";
  const refs = { tiers: useRef<HTMLElement>(null), banks: useRef<HTMLElement>(null), marketing: useRef<HTMLElement>(null) };
  const [flash, setFlash] = useState<Block | null>(focus);
  const confirm = useConfirm();

  useEffect(() => {
    setFlash(focus);
    const el = refs[focus].current;
    if (el && focus !== "tiers") el.scrollIntoView({ behavior: "smooth", block: "start" });
    const id = window.setTimeout(() => setFlash(null), 1800);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const ring = (b: Block) => (flash === b ? { boxShadow: "0 0 0 3px var(--brand-soft)", borderColor: "var(--brand)", transition: "box-shadow .4s, border-color .4s" } : { transition: "box-shadow .4s, border-color .4s" });

  return (
    <>
      <PageHeader title={t("v2.admin.catalog.title")}>
        <div className="seg" role="tablist">
          <Link to="/catalog">{t("v2.admin.catalog.segPhones")}</Link>
          <Link className="is-on" to={pathname} aria-current="page">{t("v2.admin.catalog.segMore")}</Link>
        </div>
      </PageHeader>
      <main className="page">
        <div className="row g16" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
          <TiersBlock refEl={refs.tiers} style={ring("tiers")} confirm={confirm} />
          <BanksBlock refEl={refs.banks} style={ring("banks")} confirm={confirm} />
          <MarketingBlock refEl={refs.marketing} style={ring("marketing")} />
        </div>
      </main>
      {confirm.node}
    </>
  );
}

type Confirm = ReturnType<typeof useConfirm>;
type BlockProps = { refEl: RefObject<HTMLElement>; style: CSSProperties; confirm: Confirm };

/* ------------------------------ tiers ------------------------------ */

const TIER_COLS = "60px minmax(84px,1fr) 40px 64px 64px 28px";

function TiersBlock({ refEl, style, confirm }: BlockProps) {
  const t = useT2();
  const q = useSetTiers();
  const rows = q.data ?? [];
  const upsert = useSetTierUpsert(rows);
  const del = useSetTierDelete();
  const [months, setMonths] = useState("");
  const [pct, setPct] = useState("");
  const existing = months ? rows.find((r) => r.months === Number(months)) : undefined;

  const save = (body: Partial<SetTier> & { months: number }) =>
    upsert.mutate(body, {
      onSuccess: () => toast.success(t("tiers.saved")),
      onError: () => toast.error(t("marketing_settings.save_failed")),
    });

  const remove = async (r: SetTier) => {
    const ok = await confirm({ title: t("tiers.confirm_delete", { months: r.months }), body: t("v2.admin.catalog.tierDeleteBody"), confirm: t("v2.admin.catalog.tierDelete"), danger: true });
    if (!ok) return;
    del.mutate(r.id, {
      onSuccess: () => toast.success(t("tiers.deleted")),
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  return (
    <section ref={refEl} id="tiers" className="card col" style={{ ...style, scrollMarginTop: 16, flex: "1.35 1 440px", minWidth: 0 }}>
      <div className="card-h">
        <div className="col">
          <span className="h3">{t("tiers.title")}</span>
          <span className="xs c3">{t("v2.admin.catalog.tiersSub")}</span>
        </div>
      </div>
      {q.isLoading ? (
        <LoadingBlock rows={4} onRetry={() => q.refetch()} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("v2.state.empty")} body={t("v2.admin.catalog.tiersEmpty")} />
      ) : (
        <div className="scroll-x">
          <div style={{ minWidth: 400 }}>
            <div className="tr th" style={{ gridTemplateColumns: TIER_COLS, columnGap: 8, padding: "0 12px" }}>
              <span>{t("tiers.months")}</span>
              <span>{t("tiers.commission_pct")}</span>
              <span title={t("tiers.is_active")}>{t("v2.admin.catalog.colActive")}</span>
              <span title={t("tiers.show_in_marketing")}>{t("v2.admin.catalog.colMkt")}</span>
              <span>{t("tiers.sort_order")}</span>
              <span />
            </div>
            {rows.map((r) => (
              <TierRow key={r.id} row={r} onSave={(p) => save({ months: r.months, ...p })} onDelete={() => remove(r)} />
            ))}
          </div>
        </div>
      )}
      <form
        className="col g6"
        style={{ padding: "12px 16px", borderTop: "1px solid var(--line)" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!months || !pct) return;
          save({
            months: Number(months),
            commission_pct: pct,
            is_active: true,
            show_in_marketing: false,
            sort_order: (rows[rows.length - 1]?.sort_order ?? 0) + 10,
          });
          setMonths("");
          setPct("");
        }}
      >
        <span className="flabel">{t("tiers.add")}</span>
        <div className="row g8">
          <input className="input num" type="number" min={1} value={months} placeholder="24" aria-label={t("tiers.months")} style={{ width: 90 }} onChange={(e) => setMonths(e.target.value)} />
          <input className="input num grow" type="number" step="0.01" value={pct} placeholder="60.00" aria-label={t("tiers.commission_pct")} onChange={(e) => setPct(e.target.value)} />
          <button className="btn btn-pri" type="submit" disabled={!months || !pct || upsert.isPending}>
            <Plus className="ic ic-s" />
            {t("common.save")}
          </button>
        </div>
        {existing ? <span className="err">{t("v2.admin.catalog.tierExists", { m: existing.months })}</span> : null}
      </form>
    </section>
  );
}

function TierRow({ row, onSave, onDelete }: { row: SetTier; onSave: (p: Partial<SetTier>) => void; onDelete: () => void }) {
  const t = useT2();
  const [pct, setPct] = useState(row.commission_pct);
  const [order, setOrder] = useState(String(row.sort_order));
  useEffect(() => setPct(row.commission_pct), [row.commission_pct]);
  useEffect(() => setOrder(String(row.sort_order)), [row.sort_order]);
  return (
    <div className="tr" style={{ gridTemplateColumns: TIER_COLS, columnGap: 8, padding: "6px 12px", opacity: row.is_active ? 1 : 0.6 }}>
      <span className="num w6">{row.months} {t("catalog.months")}</span>
      <input
        className={cx("input num", pct !== row.commission_pct && "is-warn")}
        type="number"
        step="0.01"
        value={pct}
        aria-label={`${t("tiers.commission_pct")} · ${row.months}`}
        style={{ height: 32 }}
        onChange={(e) => setPct(e.target.value)}
        onBlur={() => pct !== row.commission_pct && onSave({ commission_pct: pct })}
      />
      <input className="check" type="checkbox" checked={row.is_active} aria-label={t("tiers.is_active")} onChange={(e) => onSave({ is_active: e.target.checked })} />
      <input className="check" type="checkbox" checked={row.show_in_marketing} aria-label={t("tiers.show_in_marketing")} onChange={(e) => onSave({ show_in_marketing: e.target.checked })} />
      <input
        className="input num"
        type="number"
        value={order}
        aria-label={t("tiers.sort_order")}
        style={{ height: 32 }}
        onChange={(e) => setOrder(e.target.value)}
        onBlur={() => Number(order) !== row.sort_order && onSave({ sort_order: Number(order) })}
      />
      <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.admin.catalog.tierDelete")} style={{ width: 28, color: "var(--bad)" }} onClick={onDelete}>
        <Trash2 className="ic ic-s" />
      </button>
    </div>
  );
}

/* ------------------------------ banks ------------------------------ */

function BanksBlock({ refEl, style, confirm }: BlockProps) {
  const t = useT2();
  const q = useSetBanks();
  const addBank = useSetBankCreate();
  const delBank = useSetBankDelete();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");

  const removeBank = async (b: SetBank) => {
    const ok = await confirm({ title: t("catalog.confirm_delete_bank", { name: b.name }), body: t("v2.admin.catalog.bankDeleteBody"), confirm: t("v2.admin.catalog.bankDelete"), danger: true });
    if (!ok) return;
    delBank.mutate(b.id, {
      onSuccess: () => toast.success(t("v2.admin.catalog.bankDeleted")),
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  return (
    <section ref={refEl} id="banks" className="card col" style={{ ...style, scrollMarginTop: 16, flex: "1 1 320px", minWidth: 0 }}>
      <div className="card-h">
        <div className="col">
          <span className="h3">{t("catalog.banks_title")}</span>
          <span className="xs c3">{t("catalog.banks_subtitle")}</span>
        </div>
      </div>
      <form
        className="col g6"
        style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          addBank.mutate(
            { name: name.trim(), icon },
            {
              onSuccess: () => {
                setName("");
                setIcon("");
                toast.success(t("catalog.bank_added"));
              },
              onError: (err) => toast.error(apiErrorMessage(err)),
            },
          );
        }}
      >
        <span className="flabel">{t("catalog.banks_add")}</span>
        <div className="row g8">
          <input className="input grow" type="text" value={name} placeholder="Alif / Zoodpay / Payme…" aria-label={t("v2.admin.catalog.bankName")} onChange={(e) => setName(e.target.value)} />
          <input className="input" type="text" value={icon} placeholder={t("v2.admin.catalog.bankIcon")} aria-label={t("v2.admin.catalog.bankIcon")} style={{ width: 70, textAlign: "center" }} onChange={(e) => setIcon(e.target.value)} />
          <button className="btn btn-pri btn-sq" type="submit" aria-label={t("catalog.banks_add")} title={t("catalog.banks_add")} disabled={!name.trim() || addBank.isPending}>
            <Plus className="ic" />
          </button>
        </div>
      </form>
      {q.isLoading ? (
        <LoadingBlock rows={3} onRetry={() => q.refetch()} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (q.data ?? []).length === 0 ? (
        <EmptyState title={t("v2.admin.catalog.banksEmpty")} />
      ) : (
        (q.data ?? []).map((b) => <BankBlock key={b.id} bank={b} onDelete={() => removeBank(b)} />)
      )}
    </section>
  );
}

function BankBlock({ bank, onDelete }: { bank: SetBank; onDelete: () => void }) {
  const t = useT2();
  const addPlan = useSetBankPlanCreate();
  const delPlan = useSetBankPlanDelete();
  const [term, setTerm] = useState("");
  const [mult, setMult] = useState("");
  return (
    <div className="col g6" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
      <div className="row between">
        <span className="row g8" style={{ minWidth: 0 }}>
          <span className="icon-tile t-info" style={{ width: 26, height: 26, fontSize: 12, fontWeight: 700 }}>{bank.icon || bank.name.slice(0, 1)}</span>
          <span className="s w6 trunc">{bank.name}</span>
        </span>
        <button className="btn btn-ghost btn-sm" type="button" style={{ color: "var(--bad)" }} onClick={onDelete}>
          {t("v2.admin.catalog.bankDelete")}
        </button>
      </div>
      {(bank.plans ?? []).length === 0 ? (
        <span className="xs c3">{t("v2.admin.catalog.planNone")}</span>
      ) : (
        <>
          <div className="row lbl" style={{ fontSize: 10 }}>
            <span style={{ width: 60 }}>{t("catalog.plan_term")}</span>
            <span style={{ width: 80 }}>{t("catalog.plan_multiplier")}</span>
            <span className="grow">{t("catalog.plan_overpay")}</span>
          </div>
          {bank.plans.map((p) => (
            <div key={p.id} className="row s">
              <span className="num" style={{ width: 60 }}>{p.term_months} {t("catalog.months")}</span>
              <span className="num c3" style={{ width: 80 }}>×{p.multiplier}</span>
              <span className="num grow">+{Math.round((Number(p.multiplier) - 1) * 100)}%</span>
              <button
                className="btn btn-ghost btn-sq btn-sm"
                type="button"
                aria-label={t("v2.admin.catalog.planDelete")}
                style={{ width: 26, height: 26, color: "var(--bad)" }}
                disabled={delPlan.isPending && delPlan.variables === p.id}
                onClick={() =>
                  delPlan.mutate(p.id, {
                    onSuccess: () => toast.success(t("v2.admin.catalog.planDeleted")),
                    onError: (e) => toast.error(apiErrorMessage(e)),
                  })
                }
              >
                <Trash2 className="ic ic-s" />
              </button>
            </div>
          ))}
        </>
      )}
      <form
        className="row g6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!term || !mult) return;
          addPlan.mutate(
            { bank: bank.id, term_months: Number(term), multiplier: mult },
            {
              onSuccess: () => {
                setTerm("");
                setMult("");
                toast.success(t("v2.admin.catalog.planAdded"));
              },
              onError: (err) => toast.error(apiErrorMessage(err)),
            },
          );
        }}
      >
        <input className="input num" type="number" value={term} placeholder="12" aria-label={t("v2.admin.catalog.termMonths")} style={{ width: 70, height: 32 }} onChange={(e) => setTerm(e.target.value)} />
        <input className="input num grow" type="number" step="0.001" value={mult} placeholder="1.18" aria-label={t("catalog.plan_multiplier")} style={{ height: 32 }} onChange={(e) => setMult(e.target.value)} />
        <button className="btn btn-sm" type="submit" disabled={!term || !mult || addPlan.isPending}>
          <Plus className="ic ic-s" />
          {t("catalog.add_plan")}
        </button>
      </form>
    </div>
  );
}

/* ---------------------------- marketing texts ---------------------------- */

function MarketingBlock({ refEl, style }: Omit<BlockProps, "confirm">) {
  const t = useT2();
  const q = useSetMarketingSettings();
  const save = useSetMarketingSettingsSave();
  const [form, setForm] = useState<SetMarketingSettings | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);

  const set = <K extends keyof SetMarketingSettings>(k: K, v: SetMarketingSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const field = (k: "default_tagline" | "phone_primary" | "phone_secondary" | "telegram_handle" | "address", ph?: string, mono?: boolean) => (
    <div className="field">
      <label htmlFor={`mk-${k}`}>{t(`marketing_settings.${k}`)}</label>
      <input id={`mk-${k}`} className={cx("input", mono && "num")} type="text" value={form?.[k] ?? ""} placeholder={ph} onChange={(e) => set(k, e.target.value)} />
    </div>
  );

  return (
    <section ref={refEl} id="marketing" className="card col" style={{ ...style, scrollMarginTop: 16, flex: "1 1 320px", minWidth: 0 }}>
      <div className="card-h">
        <div className="col">
          <span className="h3">{t("marketing_settings.title")}</span>
          <span className="xs c3">{t("v2.admin.catalog.mktSub")}</span>
        </div>
      </div>
      {q.isLoading ? (
        <LoadingBlock rows={4} onRetry={() => q.refetch()} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : form ? (
        <form
          className="col g12"
          style={{ padding: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(form, {
              onSuccess: (data) => {
                setForm(data);
                toast.success(t("marketing_settings.saved"));
              },
              onError: () => toast.error(t("marketing_settings.save_failed")),
            });
          }}
        >
          {field("default_tagline")}
          {field("phone_primary", "+998 88 750 20 53", true)}
          {field("phone_secondary", "+998 88 750 20 42", true)}
          {field("telegram_handle", "@naff_ss", true)}
          {field("address", "Yunusobod, 11-k.")}
          <div className="field">
            <label htmlFor="mk-benefits">{t("marketing_settings.benefits")}</label>
            <textarea id="mk-benefits" className="input" rows={6} value={form.benefits} onChange={(e) => set("benefits", e.target.value)} />
            <span className="hint">{t("v2.admin.catalog.benefitsHint")}</span>
          </div>
          <button className="btn btn-pri" type="submit" style={{ alignSelf: "flex-start" }} disabled={save.isPending}>
            {save.isPending ? t("common.saving") : t("common.save")}
          </button>
        </form>
      ) : null}
    </section>
  );
}
