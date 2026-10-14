import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, CheckSquare, Copy, Image as ImageIcon, X } from "lucide-react";
import { toast } from "../../components/ui";
import { useT2 } from "../i18n";
import { PageHeader, EmptyState, ErrorState, LoadingBlock, cx, fmtNum, useConfirm } from "../ui";
import { apiErrorText, useSaleDecision, useSalesBulkAction, useSalesPending, type SaleListRow } from "../api/managerDaily";

function photosOf(s: SaleListRow): string[] {
  const all = (s.contract_photos_all ?? []).map((p) => p.url).filter((u): u is string => !!u);
  if (all.length) return all;
  return s.contract_photo ? [s.contract_photo] : [];
}

function partnersOf(s: SaleListRow): { name: string; amount: string | number }[] {
  const lines = s.partner_lines ?? [];
  if (lines.length) return lines.map((l) => ({ name: l.partner_name, amount: l.amount }));
  return s.channel_name ? [{ name: s.channel_name, amount: s.total_price ?? s.amount }] : [];
}

function useAgo() {
  const t = useT2();
  return (iso?: string) => {
    if (!iso) return "";
    const d = new Date(iso).getTime();
    if (Number.isNaN(d)) return "";
    const min = Math.max(0, Math.round((Date.now() - d) / 60000));
    if (min < 1) return t("v2.pending.agoNow");
    if (min < 60) return t("v2.pending.agoMin", { n: min });
    const h = Math.round(min / 60);
    if (h < 24) return t("v2.pending.agoHour", { n: h });
    return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) + " " + new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  };
}

export default function SalesPending() {
  const t = useT2();
  const ago = useAgo();
  const confirm = useConfirm();
  const q = useSalesPending();
  const bulk = useSalesBulkAction();
  const { approve, reject } = useSaleDecision();

  const rows = useMemo(() => q.data?.results ?? [], [q.data]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focusId, setFocusId] = useState<number | null>(null);

  // Drop ids that left the queue (processed by us or another manager).
  const visible = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const validSel = useMemo(() => [...selected].filter((id) => visible.has(id)), [selected, visible]);
  const selRows = rows.filter((r) => validSel.includes(r.id));
  const selSum = selRows.reduce((a, r) => a + Number(r.total_price ?? r.amount ?? 0), 0);
  const allOn = rows.length > 0 && validSel.length === rows.length;

  const focus = rows.find((r) => r.id === focusId) ?? rows[0] ?? null;
  useEffect(() => {
    if (focusId != null && !visible.has(focusId)) setFocusId(null);
  }, [focusId, visible]);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const copyImei = async (imei: string) => {
    try {
      await navigator.clipboard.writeText(imei);
      toast.success(t("common.copied"));
    } catch {
      /* clipboard blocked — silent, as on the old page */
    }
  };

  const summaryLine = (list: SaleListRow[]) => {
    const names = list.slice(0, 3).map((r) => r.phone_model).join(" · ");
    const more = list.length > 3 ? ` +${list.length - 3}` : "";
    const sum = list.reduce((a, r) => a + Number(r.total_price ?? r.amount ?? 0), 0);
    return `${names}${more} · ${fmtNum(sum)}`;
  };

  const runBulk = async (mode: "approve" | "reject") => {
    if (!validSel.length || bulk.isPending) return;
    const ids = [...validSel];
    const list = rows.filter((r) => ids.includes(r.id));
    let reason: string | undefined;
    if (mode === "reject") {
      const r = await confirm({
        title: t("sales_pending.bulk_confirm_reject", { count: ids.length }),
        body: summaryLine(list),
        confirm: t("sales_pending.reject_all"),
        danger: true,
        reason: { label: t("sales_pending.reject_reason_label"), placeholder: t("sales_pending.reject_reason_placeholder"), minLength: 1 },
      });
      if (r === false || typeof r !== "string" || !r.trim()) return;
      reason = r.trim();
    } else {
      const ok = await confirm({
        title: t("v2.pending.approveAllTitle", { count: ids.length }),
        body: (
          <>
            {summaryLine(list)}
            <br />
            {t("v2.pending.approveAllBody")}
          </>
        ),
        confirm: t("sales_pending.approve_all"),
      });
      if (!ok) return;
    }
    bulk.mutate(
      { sale_ids: ids, mode, reason },
      {
        onSuccess: (data) => {
          const msg = t("sales_pending.bulk_success", { ok: data.counts.ok, skipped: data.counts.skipped, errors: data.counts.errors });
          if (data.counts.skipped || data.counts.errors) toast.warning(msg, { description: data.counts.skipped ? t("v2.pending.skippedHint") : undefined });
          else toast.success(msg);
          setSelected(new Set());
        },
        onError: (err) => toast.error(apiErrorText(err, t("v2.pending.error"))),
      },
    );
  };

  const approveOne = (s: SaleListRow) => {
    if (approve.isPending) return;
    approve.mutate(s.id, {
      onSuccess: () => toast.success(t("sale_pending.approve_done")),
      onError: (err) => toast.error(apiErrorText(err, t("sale_pending.approve_failed"))),
    });
  };

  const rejectOne = async (s: SaleListRow) => {
    if (reject.isPending) return;
    const r = await confirm({
      title: t("sale_pending.reject_modal_title"),
      body: `${s.phone_model} · ${fmtNum(s.total_price ?? s.amount)} · ${t("sale_pending.reject_hint")}`,
      confirm: t("sale_pending.reject"),
      danger: true,
      reason: { label: t("sale_pending.reason_label"), placeholder: t("sale_pending.reason_ph"), minLength: 1 },
    });
    if (typeof r !== "string" || !r.trim()) return;
    reject.mutate(
      { id: s.id, reason: r.trim() },
      {
        onSuccess: () => toast.success(t("sale_pending.reject_done")),
        onError: (err) => toast.error(apiErrorText(err, t("sale_pending.reject_failed"))),
      },
    );
  };

  const busy = bulk.isPending;

  return (
    <>
      <PageHeader
        title={t("v2.pending.title")}
        meta={
          rows.length ? (
            <span className="badge b-warn">
              <span className="num">{rows.length}</span> {t("v2.pending.waiting")}
            </span>
          ) : undefined
        }
      >
        <span className="s c3">{t("v2.pending.meta")}</span>
      </PageHeader>

      <main className="page">
        {q.isLoading ? (
          <section className="card">
            <LoadingBlock rows={5} onRetry={() => q.refetch()} />
          </section>
        ) : q.isError ? (
          <section className="card">
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          </section>
        ) : rows.length === 0 ? (
          <section className="card">
            <EmptyState
              icon={<Check className="ic ic-l" style={{ color: "var(--ok)" }} />}
              title={t("sales_pending.empty_title")}
              body={t("sales_pending.empty_hint")}
              action={<Link className="btn" to="/sales">{t("v2.pending.toSales")}</Link>}
            />
          </section>
        ) : (
          <div className="split">
            <section className="list col g12">
              {validSel.length > 0 ? (
                <div className="card row g12 wrap" style={{ padding: "10px 16px", background: "var(--ink)", color: "var(--surface)", borderColor: "var(--ink)", position: "sticky", top: 72, zIndex: 5 }}>
                  <input className="check" type="checkbox" checked aria-label={t("v2.pending.clear")} onChange={() => setSelected(new Set())} />
                  <span className="s w6 grow">
                    {t("sales_pending.bulk_selected", { count: validSel.length })} · <span className="num">{fmtNum(selSum)}</span> {t("v2.pending.sum")}
                  </span>
                  <button className="btn btn-sm btn-ghost" type="button" style={{ color: "var(--surface)" }} disabled={busy} onClick={() => setSelected(new Set())}>
                    {t("v2.pending.clear")}
                  </button>
                  <button className="btn btn-sm" type="button" style={{ color: "var(--bad)" }} disabled={busy} onClick={() => runBulk("reject")}>
                    <X className="ic ic-s" />
                    {t("sales_pending.reject_all")}
                  </button>
                  <button className="btn btn-sm btn-ok" type="button" disabled={busy} aria-busy={busy} onClick={() => runBulk("approve")}>
                    <Check className="ic ic-s" />
                    {busy ? t("v2.pending.working") : t("sales_pending.approve_all")}
                  </button>
                </div>
              ) : null}
              <div className="row between wrap g8">
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id)))}>
                  <CheckSquare className="ic ic-s" />
                  {allOn ? t("v2.pending.clear") : t("common.select_all")}
                </button>
                <span className="xs c3">{t("v2.pending.clickHint")}</span>
              </div>
              <div className="card">
                {rows.map((s) => {
                  const photos = photosOf(s);
                  const checked = selected.has(s.id);
                  const parts = partnersOf(s);
                  const isFocus = focus?.id === s.id;
                  return (
                    <div
                      key={s.id}
                      className={cx("row-item", (checked || isFocus) && "is-sel")}
                      style={{ alignItems: "flex-start", paddingTop: 14, paddingBottom: 14, cursor: "pointer", boxShadow: isFocus ? "inset 3px 0 0 var(--brand)" : undefined }}
                      onClick={() => setFocusId(s.id)}
                    >
                      <input
                        className="check"
                        type="checkbox"
                        checked={checked}
                        aria-label={t("v2.pending.pick", { model: s.phone_model })}
                        style={{ marginTop: 3 }}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(s.id)}
                      />
                      <div className="ph" style={{ width: 72, height: 72, flex: "none", overflow: "hidden", position: "relative", padding: 0 }}>
                        {photos[0] ? (
                          <img src={photos[0]} alt={t("sale_pending.contract_photo")} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <>
                            <ImageIcon className="ic" />
                            {t("v2.pending.noPhoto")}
                          </>
                        )}
                        {photos.length > 1 ? (
                          <span className="xs num" style={{ position: "absolute", right: 4, bottom: 4, padding: "0 5px", borderRadius: 6, background: "rgba(0,0,0,.7)", color: "#fff" }}>
                            +{photos.length - 1}
                          </span>
                        ) : null}
                      </div>
                      <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
                        <div className="row between g8">
                          <Link className="h3 trunc" to={`/sales/${s.id}`} onClick={(e) => e.stopPropagation()} style={{ color: "inherit" }}>
                            {s.phone_model}
                          </Link>
                          <span className="num w6" style={{ flex: "none" }}>{fmtNum(s.total_price ?? s.amount)}</span>
                        </div>
                        <span className="row g6">
                          <span className="lbl" style={{ fontSize: 10 }}>IMEI</span>
                          <span className="num s trunc">{s.imei}</span>
                          <button
                            className="btn btn-ghost btn-sq btn-sm"
                            type="button"
                            aria-label={t("sale_detail.copy_imei")}
                            title={t("sale_detail.copy_imei")}
                            style={{ width: 24, height: 24 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              copyImei(s.imei);
                            }}
                          >
                            <Copy className="ic ic-s" />
                          </button>
                        </span>
                        <span className="row g6 wrap">
                          {parts.map((c, i) => (
                            <span key={i} className="badge b-info" style={{ height: 22 }}>
                              {c.name} <span className="num" style={{ fontWeight: 500 }}>{fmtNum(c.amount)}</span>
                            </span>
                          ))}
                          <span className="s c2">{parts.length ? "· " : ""}{s.operator_name || "—"}</span>
                        </span>
                        <span className="xs c3">
                          {[s.client_name, s.client_phone].filter(Boolean).join(" · ")}
                          {s.client_name || s.client_phone ? " · " : ""}
                          {t("v2.pending.sent", { ago: ago(s.created_at) })}
                        </span>
                        {photos.length === 0 ? <span className="xs c-bad w6">{t("v2.pending.warnNoPhoto")}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {focus ? (
              <aside className="panel card col" aria-label={t("v2.pending.panelAria")} style={{ position: "sticky", top: 72 }}>
                <div className="card-h">
                  <div className="col" style={{ minWidth: 0 }}>
                    <span className="lbl">{t("v2.pending.saleNo", { id: focus.id })}</span>
                    <span className="h3 trunc">{focus.phone_model}</span>
                  </div>
                  <span className="badge b-warn">
                    <i className="dot" />
                    {t("v2.sales.st.pending")}
                  </span>
                </div>
                {(() => {
                  const photos = photosOf(focus);
                  return photos.length ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, padding: "16px 20px 0" }}>
                      {photos.map((u, i) => (
                        <a key={u + i} href={u} target="_blank" rel="noreferrer" className="ph" style={{ height: 150, overflow: "hidden", padding: 0 }} aria-label={t("v2.pending.photoN", { n: i + 1 })}>
                          <img src={u} alt={t("v2.pending.photoN", { n: i + 1 })} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        </a>
                      ))}
                    </div>
                  ) : (
                    <div style={{ padding: "16px 20px 0" }}>
                      <div className="banner b-bad">
                        <ImageIcon className="ic" />
                        <span>{t("v2.pending.warnNoPhoto")}</span>
                      </div>
                    </div>
                  );
                })()}
                <div className="col g8" style={{ padding: "16px 20px" }}>
                  <div className="row between g12">
                    <span className="s c3">IMEI</span>
                    <span className="row g6">
                      <span className="num s">{focus.imei}</span>
                      <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("sale_detail.copy_imei")} onClick={() => copyImei(focus.imei)}>
                        <Copy className="ic" />
                      </button>
                    </span>
                  </div>
                  <div className="row between g12">
                    <span className="s c3">{t("v2.pending.amount")}</span>
                    <span className="num s w6">{fmtNum(focus.total_price ?? focus.amount)}</span>
                  </div>
                  <div className="row between g12">
                    <span className="s c3">{t("v2.sales.partners")}</span>
                    <span className="row g6 wrap" style={{ justifyContent: "flex-end" }}>
                      {partnersOf(focus).map((c, i) => (
                        <span key={i} className="badge b-info">
                          {c.name} <span className="num" style={{ fontWeight: 500 }}>{fmtNum(c.amount)}</span>
                        </span>
                      ))}
                    </span>
                  </div>
                  <div className="row between g12">
                    <span className="s c3">{t("v2.sales.col.operator")}</span>
                    <span className="s w6">{focus.operator_name || "—"}</span>
                  </div>
                  {focus.client_name || focus.client_phone ? (
                    <div className="row between g12">
                      <span className="s c3">{t("v2.pending.client")}</span>
                      <span className="s">
                        {focus.client_name}
                        {focus.client_name && focus.client_phone ? " · " : ""}
                        <span className="num">{focus.client_phone}</span>
                      </span>
                    </div>
                  ) : null}
                  {focus.sheet_source_name ? (
                    <div className="row between g12">
                      <span className="s c3">{t("v2.sales.col.source")}</span>
                      <span className="s">{focus.sheet_source_name}</span>
                    </div>
                  ) : null}
                  {focus.comment ? <div className="well s">{focus.comment}</div> : null}
                </div>
                <hr className="hr" />
                <div className="col g8" style={{ padding: "16px 20px 20px" }}>
                  <div className="row g8">
                    <button className="btn btn-ok grow" type="button" disabled={approve.isPending || reject.isPending} aria-busy={approve.isPending} onClick={() => approveOne(focus)}>
                      <Check className="ic ic-s" />
                      {approve.isPending ? t("v2.pending.working") : t("sale_pending.approve")}
                    </button>
                    <Link className="btn grow" to={`/sales/${focus.id}/edit`}>
                      {t("sale_pending.improve")}
                    </Link>
                  </div>
                  <button className="btn btn-bad" type="button" disabled={approve.isPending || reject.isPending} onClick={() => rejectOne(focus)}>
                    {t("v2.pending.rejectWithReason")}
                  </button>
                  <Link className="btn btn-ghost btn-sm" to={`/sales/${focus.id}`}>
                    {t("v2.pending.openCard")}
                  </Link>
                </div>
              </aside>
            ) : null}
          </div>
        )}
      </main>
      {confirm.node}
    </>
  );
}
