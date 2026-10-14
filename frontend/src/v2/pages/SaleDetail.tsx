import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, Check, ChevronLeft, ChevronRight, Copy, Gift, Image as ImageIcon, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "../../components/ui";
import { isManagerLevel, normaliseRole } from "../../components/RoleGate";
import { useAuth } from "../../store/auth";
import { useLang } from "../../store/lang";
import { isLuhnValid } from "../../lib/validation";
import { useT2 } from "../i18n";
import { CountUp, Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum } from "../ui";
import { saleActions, useSale, type SaleContractPhoto, type SaleDetailData } from "../api/operatorWork";

type TFn = (key: string, params?: Record<string, string | number>) => string;
const TZ = "Asia/Tashkent";

function parts(iso: string) {
  const f = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, year: "numeric", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const g = (k: string) => f.find((x) => x.type === k)?.value ?? "";
  return { d: g("day"), m: g("month"), y: g("year"), hh: g("hour"), mm: g("minute") };
}
function fullDate(iso?: string | null) {
  if (!iso) return "—";
  const p = parts(iso);
  return `${p.d}.${p.m}.${p.y} ${p.hh}:${p.mm}`;
}
function relDate(iso: string | null | undefined, t: TFn) {
  if (!iso) return "—";
  const p = parts(iso);
  const time = `${p.hh}:${p.mm}`;
  const today = parts(new Date().toISOString());
  const y = parts(new Date(Date.now() - 86400_000).toISOString());
  if (p.d === today.d && p.m === today.m && p.y === today.y) return t("sale_detail.time_today", { t: time });
  if (p.d === y.d && p.m === y.m && p.y === y.y) return t("sale_detail.time_yesterday", { t: time });
  return t("sale_detail.time_date", { d: `${p.d}.${p.m}.${p.y}`, t: time });
}
function groupImei(s: string) {
  if (!/^\d{15}$/.test(s)) return s;
  return `${s.slice(0, 2)} ${s.slice(2, 8)} ${s.slice(8, 14)} ${s.slice(14)}`;
}
function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((x) => x[0])
      .join("")
      .toUpperCase() || "?"
  );
}

function photosOf(s: SaleDetailData): SaleContractPhoto[] {
  const list = s.contract_photos_all ?? [];
  if (list.length) return list;
  if (s.contract_photo) return [{ id: -1, url: s.contract_photo, position: 0, uploaded_at: s.created_at ?? "" }];
  return [];
}

type StatusKind = "pending" | "confirmed" | "rejected" | "returned" | "deleted";
function kindOf(s: SaleDetailData): StatusKind {
  if (s.is_deleted) return "deleted";
  if (s.is_returned) return "returned";
  if (s.status === "pending") return "pending";
  if (s.status === "rejected") return "rejected";
  return "confirmed";
}

async function copy(text: string, t: TFn) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t("v2.saledet.imeiCopied"));
  } catch {
    toast.error(t("sale_detail.copy_failed"));
  }
}

export default function SaleDetail() {
  const rawRole = useAuth((s) => s.role);
  const { id } = useParams<{ id: string }>();
  const q = useSale(id);
  const t = useT2();
  const nav = useNavigate();
  const isOperator = normaliseRole(rawRole) === "operator";
  const back = isOperator ? "/my/sales" : "/sales";

  if (q.isLoading) {
    return (
      <>
        <PageHeader title={t("v2.saledet.title", { id: id ?? "" })} back={back} />
        <main className="page">
          <section className="card"><LoadingBlock rows={6} onRetry={() => q.refetch()} /></section>
        </main>
      </>
    );
  }
  if (q.isError || !q.data) {
    const status = (q.error as { response?: { status?: number } } | null)?.response?.status;
    return (
      <>
        <PageHeader title={t("v2.saledet.title", { id: id ?? "" })} back={back} />
        <main className="page">
          <section className="card">
            {status === 404 ? (
              <EmptyState
                title={t("sale_detail.not_found")}
                body={isOperator ? t("v2.saledet.notFoundOp") : t("v2.saledet.notFoundMg")}
                action={<button className="btn btn-pri" type="button" onClick={() => nav(back)}>{t("sale_detail.back_list")}</button>}
              />
            ) : (
              <ErrorState error={q.error} onRetry={() => q.refetch()} />
            )}
          </section>
        </main>
      </>
    );
  }
  return isOperator ? <OperatorView s={q.data} /> : <ManagerView s={q.data} canManage={isManagerLevel(rawRole)} />;
}

/* ═════════════════════ shared bits ═════════════════════ */

function StatusPill({ kind, operator }: { kind: StatusKind; operator?: boolean }) {
  const t = useT2();
  const map: Record<StatusKind, [string, string]> = {
    pending: ["b-warn", operator ? "v2.saledet.st.pendingOp" : "sale_detail.status_pending"],
    confirmed: ["b-ok", operator ? "v2.mysales.st.confirmed" : "sale_detail.status_paid"],
    rejected: ["b-bad", operator ? "v2.mysales.st.rejected" : "v2.saledet.st.rejected"],
    returned: ["b-bad", operator ? "v2.mysales.st.returned" : "sale_detail.status_return"],
    deleted: ["", "sale_detail.status_deleted_lower"],
  };
  const [tone, key] = map[kind];
  return (
    <span className={cx("badge", tone)} style={{ height: 26 }}>
      <i className="dot" />
      {t(key)}
    </span>
  );
}

function Gallery({ photos, start, onClose, saleId }: { photos: SaleContractPhoto[]; start: number; onClose: () => void; saleId: number }) {
  const t = useT2();
  const [i, setI] = useState(start);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setI((x) => (x - 1 + photos.length) % photos.length);
      if (e.key === "ArrowRight") setI((x) => (x + 1) % photos.length);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [photos.length]);
  const p = photos[i];
  return (
    <Dialog open onClose={onClose} width={920} title={t("v2.saledet.galleryTitle", { id: saleId })} sub={<span className="num">{i + 1} / {photos.length}</span>}>
      <div style={{ position: "relative", background: "var(--surface-3)", borderRadius: 12, minHeight: 300, display: "grid", placeItems: "center" }}>
        {p?.url ? <img src={p.url} alt={t("v2.opsale.photoN", { n: i + 1 })} style={{ maxWidth: "100%", maxHeight: "72vh", objectFit: "contain", borderRadius: 12 }} /> : <span className="c3">—</span>}
        {photos.length > 1 ? (
          <>
            <button className="btn btn-sq" type="button" aria-label={t("v2.saledet.prev")} onClick={() => setI((x) => (x - 1 + photos.length) % photos.length)} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }}>
              <ChevronLeft className="ic" />
            </button>
            <button className="btn btn-sq" type="button" aria-label={t("v2.saledet.nextPhoto")} onClick={() => setI((x) => (x + 1) % photos.length)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)" }}>
              <ChevronRight className="ic" />
            </button>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

function PhotoStrip({ photos, onOpen, size = { w: 170, h: 124 }, label }: { photos: SaleContractPhoto[]; onOpen: (i: number) => void; size?: { w: number; h: number }; label: (i: number) => string }) {
  return (
    <div className="row g12 wrap">
      {photos.map((p, i) => (
        <button key={p.id} type="button" className="ph" onClick={() => onOpen(i)} style={{ width: size.w, height: size.h, position: "relative", overflow: "hidden", padding: 0, cursor: "zoom-in" }} aria-label={label(i)}>
          {p.url ? <img src={p.url} alt={label(i)} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <ImageIcon className="ic" />}
          <span className="badge num" style={{ position: "absolute", right: 6, top: 6, height: 18 }}>
            {i + 1} / {photos.length}
          </span>
        </button>
      ))}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="col g4" style={{ minWidth: 0 }}>
      <span className="lbl">{label}</span>
      {children}
    </div>
  );
}

/* ═════════════════════ operator view (OpSaleDetail) ═════════════════════ */

function OperatorView({ s }: { s: SaleDetailData }) {
  const t = useT2();
  const lang = useLang((x) => x.lang);
  const kind = kindOf(s);
  const [gal, setGal] = useState<number | null>(null);
  const photos = photosOf(s);
  const partners = s.partner_lines ?? [];
  const sentAt = s.created_at || s.sold_at;
  const month = new Intl.DateTimeFormat(lang === "uz" ? "uz-Latn-UZ" : "ru-RU", { month: "long", year: "numeric", timeZone: TZ }).format(new Date(s.sold_at));
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(sentAt)) / 60000));
  const myShare = (s.operator_lines ?? []).length > 1 ? s.operator_lines : null;

  type Step = { label: string; note: string; state: "done" | "now" | "bad" | "todo" };
  const steps: Step[] =
    kind === "rejected"
      ? [
          { label: t("v2.saledet.step.sent"), note: relDate(sentAt, t), state: "done" },
          { label: t("v2.saledet.step.review"), note: t("v2.saledet.step.reviewed"), state: "done" },
          { label: t("v2.mysales.st.rejected"), note: relDate(s.rejected_at, t), state: "bad" },
          { label: t("v2.saledet.step.payroll"), note: t("v2.saledet.step.notCounted"), state: "todo" },
        ]
      : kind === "returned"
        ? [
            { label: t("v2.saledet.step.sent"), note: relDate(sentAt, t), state: "done" },
            { label: t("v2.mysales.st.confirmed"), note: "", state: "done" },
            { label: t("v2.mysales.st.returned"), note: relDate(s.returned_at, t), state: "bad" },
            { label: t("v2.saledet.step.payroll"), note: t("v2.saledet.step.notCounted"), state: "todo" },
          ]
        : [
            { label: t("v2.saledet.step.sent"), note: relDate(sentAt, t), state: "done" },
            {
              label: t("v2.saledet.step.review"),
              note: kind === "pending" ? t("v2.saledet.step.waiting", { dur: mins < 60 ? t("v2.op.dur.min", { m: mins }) : t("v2.op.dur.hm", { h: Math.floor(mins / 60), m: mins % 60 }) }) : t("v2.saledet.step.reviewed"),
              state: kind === "pending" ? "now" : "done",
            },
            { label: t("v2.mysales.st.confirmed"), note: kind === "pending" ? t("v2.saledet.step.notYet") : "", state: kind === "pending" ? "todo" : "done" },
            { label: t("v2.saledet.step.payroll"), note: month, state: kind === "confirmed" ? "done" : "todo" },
          ];

  return (
    <>
      <PageHeader title={t("v2.saledet.title", { id: s.id })} back="/my/sales">
        <StatusPill kind={kind} operator />
        <span className="s c3">{t("v2.saledet.sentAt", { when: relDate(sentAt, t) })}</span>
      </PageHeader>
      <main className="page">
        <div className="split">
          <div className="list col g16">
            <section className="card col g16" style={{ padding: "20px 24px" }}>
              <span className="lbl">{t("v2.saledet.path")}</span>
              <div className="row g8 wrap" style={{ alignItems: "flex-start" }}>
                {steps.map((st, i) => (
                  <div key={i} className="col g6 grow" style={{ minWidth: 140 }}>
                    <i className="bar" style={{ height: 6 }}>
                      <i className={st.state === "done" ? "ok" : st.state === "now" ? "warn" : st.state === "bad" ? "bad" : undefined} style={{ width: st.state === "todo" ? "0%" : "100%" }} />
                    </i>
                    <span className={cx("s w6", st.state === "todo" && "c3", st.state === "bad" && "c-bad")}>{st.label}</span>
                    {st.note ? <span className="xs c3">{st.note}</span> : null}
                  </div>
                ))}
              </div>
            </section>

            <section className="card col">
              <div className="card-h"><span className="h3">{t("v2.saledet.whatSold")}</span></div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, padding: "18px 20px" }}>
                <Fact label={t("sale_detail.model")}><span className="w6">{s.phone_model || t("sale_detail.model_unknown")}</span></Fact>
                <Fact label="IMEI"><span className="num">{groupImei(s.imei)}</span></Fact>
                <Fact label={t("sale_detail.amount")}>
                  <span className="num w6">{fmtNum(s.total_price ?? s.amount)} {t("my_sales.currency")}</span>
                </Fact>
                <Fact label={t("sale_detail.client")}>
                  <span>{s.client_name || "—"}</span>
                  {s.client_phone ? <span className="num xs c3">{s.client_phone}</span> : null}
                </Fact>
                <Fact label={t("sale_detail.partners")}>
                  {partners.length ? (
                    partners.map((p, i) => (
                      <span key={i} className="num s">{p.partner_name} {fmtNum(p.amount)}</span>
                    ))
                  ) : (
                    <span className="s">{s.channel_name || "—"}</span>
                  )}
                </Fact>
                <Fact label={t("v2.saledet.lead")}>
                  <span className="s">{s.sheet_source_name || "—"}</span>
                </Fact>
                {myShare ? (
                  <Fact label={t("v2.saledet.split")}>
                    {myShare.map((l, i) => (
                      <span key={i} className="num s">{l.operator_name} {fmtNum(l.amount)}</span>
                    ))}
                  </Fact>
                ) : null}
              </div>
              {photos.length || s.comment ? (
                <>
                  <hr className="hr" />
                  <div className="row g16 wrap" style={{ padding: "16px 20px", alignItems: "flex-start" }}>
                    {photos.length ? <PhotoStrip photos={photos} onOpen={setGal} size={{ w: 120, h: 88 }} label={(i) => t("v2.saledet.contractN", { n: i + 1 })} /> : null}
                    {s.comment ? (
                      <div className="col g4 grow" style={{ minWidth: 200 }}>
                        <span className="lbl">{t("common.comment")}</span>
                        <span className="s" style={{ whiteSpace: "pre-wrap" }}>{s.comment}</span>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}
            </section>
          </div>

          <aside className="panel col g16">
            <section className="card col g12" style={{ padding: 20 }}>
              <span className="h3">{t("v2.saledet.next")}</span>
              {kind === "pending" ? (
                <>
                  <p className="s c2">{t("v2.saledet.nextPending")}</p>
                  <div className="banner b-info">
                    <Bell className="ic" />
                    <span>{t("v2.saledet.notify")}</span>
                  </div>
                </>
              ) : kind === "confirmed" ? (
                <>
                  <p className="s c2">{t("v2.saledet.nextConfirmed", { month })}</p>
                  <Link className="btn" to="/my/payroll">{t("v2.saledet.toPayroll")}</Link>
                </>
              ) : kind === "rejected" ? (
                <>
                  <div className="banner b-bad">
                    <AlertTriangle className="ic" />
                    <span className="col g4">
                      <span className="w6">{t("v2.saledet.rejectedReason", { reason: s.rejection_reason || "—" })}</span>
                      {s.rejected_at ? <span>{relDate(s.rejected_at, t)}</span> : null}
                    </span>
                  </div>
                  <Link className="btn btn-pri" to={`/my/sale-new?from=${s.id}`}>{t("v2.saledet.fixResend")}</Link>
                  <span className="xs c3">{t("v2.saledet.fixResendHint")}</span>
                </>
              ) : kind === "returned" ? (
                <div className="banner b-bad">
                  <RotateCcw className="ic" />
                  <span className="col g4">
                    <span className="w6">{t("v2.saledet.returnedTitle")}</span>
                    {s.return_reason ? <span>{s.return_reason}</span> : null}
                    {s.returned_at ? <span>{relDate(s.returned_at, t)}</span> : null}
                  </span>
                </div>
              ) : (
                <p className="s c2">{t("v2.saledet.deletedOp")}</p>
              )}
            </section>
          </aside>
        </div>
      </main>
      {gal != null ? <Gallery photos={photos} start={gal} onClose={() => setGal(null)} saleId={s.id} /> : null}
    </>
  );
}

/* ═════════════════════ manager view (MgSaleDetail) ═════════════════════ */

function ManagerView({ s, canManage }: { s: SaleDetailData; canManage: boolean }) {
  const t = useT2();
  const nav = useNavigate();
  const qc = useQueryClient();
  const lang = useLang((x) => x.lang);
  const id = String(s.id);
  const kind = kindOf(s);
  const isPending = kind === "pending";
  const isDeleted = kind === "deleted";
  const photos = photosOf(s);
  const ops = s.operator_lines ?? [];
  const partners = s.partner_lines ?? [];
  const gifts = s.gifts ?? [];
  const opTotal = useMemo(() => ops.reduce((a, l) => a + Number(l.amount), 0), [ops]);
  const pct = (amount: string) => (opTotal > 0 ? `${Math.round((Number(amount) / opTotal) * 100)}%` : "");
  const total = Number(s.total_price ?? s.amount) || 0;
  const month = new Intl.DateTimeFormat(lang === "uz" ? "uz-Latn-UZ" : "ru-RU", { month: "long", timeZone: TZ }).format(new Date(s.sold_at));

  const [gal, setGal] = useState<number | null>(null);
  const [dlg, setDlg] = useState<"reject" | "return" | "delete" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string, fail: string, keys: unknown[][], after?: () => void) => {
    setBusy(key);
    try {
      await fn();
      keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      toast.success(ok);
      setDlg(null);
      setReason("");
      after?.();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(detail ? `${fail}: ${detail}` : fail);
    } finally {
      setBusy(null);
    }
  };
  const pendingKeys = [["sale", id], ["sales-pending"], ["sales-pending-count"], ["sales"]];

  const approve = () => act("approve", () => saleActions.confirm(id), t("sale_pending.approve_done"), t("sale_pending.approve_failed"), pendingKeys);
  const reject = () => act("reject", () => saleActions.reject(id, reason.trim()), t("sale_pending.reject_done"), t("sale_pending.reject_failed"), pendingKeys);
  const doReturn = () => act("return", () => saleActions.return(id, reason.trim()), t("sale_detail.return_success"), t("sale_detail.return_failed"), [["sale", id], ["sales"]]);
  const doDelete = () => act("delete", () => saleActions.remove(id), t("sale_detail.delete_success"), t("sale_detail.delete_failed"), [["sales"]], () => nav("/sales"));

  const primary = ops[0];
  const opName = primary ? primary.operator_name : s.operator_name || "—";

  // computed checks (real data only)
  const partnerSum = partners.reduce((a, p) => a + Number(p.amount), 0);
  const checks: Array<{ ok: boolean; text: string }> = [
    /^\d{15}$/.test(s.imei)
      ? isLuhnValid(s.imei)
        ? { ok: true, text: t("v2.saledet.chk.imeiOk") }
        : { ok: false, text: t("v2.saledet.chk.imeiWarn") }
      : { ok: false, text: t("v2.saledet.chk.imeiLen") },
    ...(partners.length > 1
      ? [Math.round(partnerSum) === Math.round(Number(s.amount))
          ? { ok: true, text: t("v2.saledet.chk.splitOk") }
          : { ok: false, text: t("v2.saledet.chk.splitBad", { a: fmtNum(partnerSum), b: fmtNum(s.amount) }) }]
      : []),
    photos.length ? { ok: true, text: t("v2.saledet.chk.photos", { n: photos.length }) } : { ok: false, text: t("v2.saledet.chk.noPhotos") },
    s.sheet_source_name ? { ok: true, text: t("v2.saledet.chk.source") } : { ok: false, text: t("v2.saledet.chk.noSource") },
  ];
  const allOk = checks.every((c) => c.ok);

  const history: Array<{ text: string; who: string; when: string }> = (s.audit_events ?? []).map((e) => ({
    text: e.description ?? t("sale_detail.audit_change"),
    who: e.actor_name ?? t("sale_detail.system"),
    when: fullDate(e.created_at),
  }));
  if (!history.length) {
    history.push({ text: t("sale_detail.return_created", { sum: fmtNum(s.amount) }), who: primary?.operator_name ?? t("sale_detail.system"), when: fullDate(s.created_at) });
    if (s.rejected_at) history.push({ text: t("v2.saledet.h.rejected", { reason: s.rejection_reason || "—" }), who: t("sale_detail.system"), when: fullDate(s.rejected_at) });
    if (s.returned_at) history.push({ text: t("v2.saledet.h.returned", { reason: s.return_reason || "—" }), who: t("sale_detail.system"), when: fullDate(s.returned_at) });
    if (s.updated_at && s.updated_at !== s.created_at && !s.rejected_at && !s.returned_at)
      history.push({ text: t("sale_detail.updated_record"), who: t("sale_detail.system"), when: fullDate(s.updated_at) });
  }

  return (
    <>
      <PageHeader title={t("v2.saledet.title", { id: fmtNum(s.id) })} back="/sales">
        <StatusPill kind={kind} />
        {canManage && isPending && !isDeleted ? (
          <>
            <button className="btn btn-bad" type="button" onClick={() => setDlg("reject")}>{t("sale_pending.reject")}</button>
            <Link className="btn" to={`/sales/${id}/edit`}>{t("sale_pending.improve")}</Link>
            <button className="btn btn-ok" type="button" disabled={busy === "approve"} onClick={() => void approve()}>
              <Check className="ic" />
              {busy === "approve" ? t("common.loading") : t("sale_pending.approve")}
            </button>
          </>
        ) : null}
        {canManage && !isPending && !isDeleted ? (
          <>
            <Link className="btn" to={`/sales/${id}/edit`}>{t("v2.saledet.edit")}</Link>
            {kind !== "returned" ? (
              <button className="btn" type="button" onClick={() => setDlg("return")}>
                <RotateCcw className="ic" />
                {t("sale_detail.return_modal_title")}
              </button>
            ) : null}
            <button className="btn btn-bad" type="button" onClick={() => setDlg("delete")}>
              <Trash2 className="ic" />
              {t("v2.saledet.delete")}
            </button>
          </>
        ) : null}
      </PageHeader>

      <main className="page">
        <div className="split">
          <div className="list col g16">
            <section className="card row g24 wrap" style={{ padding: "22px 24px", alignItems: "flex-end" }}>
              <div className="col g6 grow" style={{ minWidth: 0 }}>
                <span className="lbl">{t("sale_detail.model")}</span>
                <span className="display trunc" style={{ fontSize: 24, lineHeight: "32px" }}>{s.phone_model || t("sale_detail.model_unknown")}</span>
                <span className="row g6">
                  <span className="num c2" style={{ userSelect: "all" }}>{groupImei(s.imei)}</span>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => void copy(s.imei, t)} aria-label={t("sale_detail.copy_imei")}>
                    <Copy className="ic" />
                    {t("common.copy")}
                  </button>
                </span>
              </div>
              <div className="col g4" style={{ textAlign: "right" }}>
                <span className="lbl">{t("sale_detail.amount")}</span>
                <span className="kpi"><CountUp value={total} /></span>
                <span className="xs c3">
                  {t("my_sales.currency")} · {t("v2.saledet.qty", { n: s.quantity ?? 1 })}
                  {Number(s.discount) > 0 ? ` · ${t("v2.saledet.discount", { n: fmtNum(s.discount) })}` : ""}
                </span>
              </div>
            </section>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              <section className="card col g6 pad">
                <span className="lbl">{partners.length > 1 ? t("sale_detail.payment_split_title") : t("sale_detail.tile_channel")}</span>
                {partners.length ? (
                  partners.map((p, i) => (
                    <div key={i} className="row between s g8">
                      <span className="trunc">{p.partner_name}</span>
                      <span className="num">{fmtNum(p.amount)}</span>
                    </div>
                  ))
                ) : (
                  <span className="s w6">{s.channel_name || "—"}</span>
                )}
              </section>
              <section className="card col g6 pad">
                <span className="lbl">{t("sale_detail.tile_operator")}</span>
                <span className="s w6 row g6" style={{ minWidth: 0 }}>
                  <span className="ava ava-s">{initials(opName)}</span>
                  <span className="trunc">{opName}</span>
                  {ops.length > 1 ? <span className="badge" style={{ height: 18 }}>+{ops.length - 1}</span> : null}
                </span>
                {primary && ops.length > 1 ? <span className="xs c3">{t("v2.saledet.splitBelow", { pct: pct(primary.amount) })}</span> : null}
              </section>
              <section className="card col g6 pad">
                <span className="lbl">{t("sale_detail.tile_client")}</span>
                <span className="s w6 trunc">{s.client_name || "—"}</span>
                {s.client_phone ? <span className="num xs c3">{s.client_phone}</span> : null}
              </section>
              <section className="card col g6 pad">
                <span className="lbl">{t("v2.saledet.date")}</span>
                <span className="s w6">{relDate(s.sold_at, t)}</span>
                <span className="num xs c3">{fullDate(s.sold_at)}</span>
              </section>
              <section className="card col g6 pad">
                <span className="lbl">{t("sale_detail.tile_gifts")}</span>
                <span className="s w6">{gifts.length ? gifts.map((g) => g.name).join(", ") : "—"}</span>
                {gifts.length ? <span className="xs c3">{t("v2.saledet.giftsN", { n: gifts.length })}</span> : null}
              </section>
              <section className="card col g6 pad">
                <span className="lbl">{t("sale_detail.source_label")}</span>
                <span className="s w6">{s.sheet_source_name || "—"}</span>
              </section>
            </div>

            {ops.length > 1 ? (
              <section className="card col">
                <div className="card-h">
                  <span className="h3">{t("v2.saledet.splitTitle", { n: ops.length })}</span>
                  <span className="xs c3">{t("v2.saledet.splitNote")}</span>
                </div>
                <div className="tr th" style={{ gridTemplateColumns: "1fr 80px 140px" }}>
                  <span>{t("sale_detail.tile_operator")}</span>
                  <span className="r">{t("sale_detail.share")}</span>
                  <span className="r">{t("sale_detail.amount")}</span>
                </div>
                {ops.map((l, i) => (
                  <div key={i} className="tr" style={{ gridTemplateColumns: "1fr 80px 140px" }}>
                    <span className="row g8" style={{ minWidth: 0 }}>
                      <span className="ava ava-s">{initials(l.operator_name)}</span>
                      <span className="trunc">{l.operator_name}</span>
                    </span>
                    <span className="r num">{pct(l.amount)}</span>
                    <span className="r num w6">{fmtNum(l.amount)}</span>
                  </div>
                ))}
              </section>
            ) : null}

            {s.comment ? (
              <section className="card col g6 pad">
                <span className="lbl">{t("common.comment")}</span>
                <span className="s" style={{ whiteSpace: "pre-wrap" }}>{s.comment}</span>
              </section>
            ) : null}

            {s.bonus_note ? (
              <div className="banner b-warn">
                <Gift className="ic" />
                <span className="col g4">
                  <span className="w6">{t("sale_detail.bonus_label")}</span>
                  <span>{s.bonus_note}</span>
                </span>
              </div>
            ) : null}

            <section className="card col">
              <div className="card-h">
                <span className="h3">{t("sale_pending.contract_photo")}</span>
                <span className="xs c3">{photos.length ? t("v2.saledet.photosHint", { n: photos.length }) : ""}</span>
              </div>
              <div style={{ padding: 16 }}>
                {photos.length ? (
                  <PhotoStrip photos={photos} onOpen={setGal} label={(i) => t("v2.saledet.contractN", { n: i + 1 })} />
                ) : (
                  <span className="s c3">{t("v2.saledet.noPhotos")}</span>
                )}
              </div>
            </section>
          </div>

          <aside className="panel col g16">
            {kind === "rejected" ? (
              <section className="card col" style={{ borderColor: "var(--bad-solid)" }}>
                <div className="col g4" style={{ padding: "14px 16px", background: "var(--bad-bg)", borderRadius: 13 }}>
                  <span className="s w6 c-bad">{t("sale_pending.rejected_title")}</span>
                  <span className="s" style={{ whiteSpace: "pre-wrap" }}>{s.rejection_reason || "—"}</span>
                  {s.rejected_at ? <span className="xs c3">{fullDate(s.rejected_at)}</span> : null}
                </div>
              </section>
            ) : null}
            {kind === "returned" ? (
              <section className="card col" style={{ borderColor: "var(--bad-solid)" }}>
                <div className="col g4" style={{ padding: "14px 16px", background: "var(--bad-bg)", borderRadius: 13 }}>
                  <span className="s w6 c-bad">{t("v2.saledet.returnedTitle")}</span>
                  {s.return_reason ? <span className="s" style={{ whiteSpace: "pre-wrap" }}>{s.return_reason}</span> : null}
                  {s.returned_at ? <span className="xs c3">{fullDate(s.returned_at)}</span> : null}
                </div>
              </section>
            ) : null}
            {isDeleted ? (
              <section className="card col">
                <div className="card-h">
                  <StatusPill kind="deleted" />
                </div>
                <div className="s c2" style={{ padding: "12px 16px" }}>{t("v2.saledet.deletedMg")}</div>
              </section>
            ) : null}

            <section className="card col">
              <div className="card-h">
                <span className="h3">{t("v2.saledet.check")}</span>
                <span className={cx("badge", allOk ? "b-ok" : "b-warn")}>{allOk ? t("v2.saledet.allOk") : t("v2.saledet.hasNotes")}</span>
              </div>
              <div className="col g8" style={{ padding: "14px 16px" }}>
                {checks.map((c, i) => (
                  <div key={i} className={cx("row g8 s", !c.ok && "c-warn")}>
                    {c.ok ? <Check className="ic c-ok" /> : <AlertTriangle className="ic" />}
                    {c.text}
                  </div>
                ))}
              </div>
            </section>

            <section className="card col">
              <div className="card-h"><span className="h3">{t("sale_detail.history_title")}</span></div>
              <div className="col g12" style={{ padding: "14px 16px" }}>
                {history.map((h, i) => (
                  <div key={i} className="row g12" style={{ alignItems: "flex-start" }}>
                    <i className="dot" style={{ color: "var(--brand)", width: 7, height: 7, marginTop: 7, flex: "none" }} />
                    <span className="col grow" style={{ minWidth: 0 }}>
                      <span className="s">{h.text}</span>
                      <span className="xs c3">{h.who} · <span className="num">{h.when}</span></span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </main>

      {gal != null ? <Gallery photos={photos} start={gal} onClose={() => setGal(null)} saleId={s.id} /> : null}

      {dlg === "reject" ? (
        <Dialog
          open
          onClose={() => setDlg(null)}
          width={460}
          title={t("v2.saledet.rejectTitle", { id: fmtNum(s.id) })}
          sub={[s.phone_model, fmtNum(total), opName].filter(Boolean).join(" · ")}
          footer={
            <>
              <button className="btn" type="button" onClick={() => setDlg(null)}>{t("common.cancel")}</button>
              <button className="btn btn-bad" type="button" disabled={!reason.trim() || busy === "reject"} onClick={() => void reject()}>
                {busy === "reject" ? t("common.loading") : t("sale_pending.reject")}
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="rej-reason">{t("sale_pending.reason_label")}</label>
            <textarea id="rej-reason" className={cx("input", !reason.trim() && "is-bad")} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("sale_pending.reason_ph")} autoFocus />
            {!reason.trim() ? <span className="err">{t("v2.saledet.reasonRequired")}</span> : <span className="hint">{t("sale_pending.reject_hint")}</span>}
          </div>
          <div className="row g6 wrap">
            {["v2.saledet.r1", "v2.saledet.r2", "v2.saledet.r3"].map((k) => (
              <button key={k} type="button" className="chip" onClick={() => setReason(t(k))}>{t(k)}</button>
            ))}
          </div>
        </Dialog>
      ) : null}

      {dlg === "return" ? (
        <Dialog
          open
          onClose={() => setDlg(null)}
          width={460}
          title={t("sale_detail.return_modal_title")}
          sub={[t("v2.saledet.title", { id: fmtNum(s.id) }), s.phone_model, fmtNum(total)].filter(Boolean).join(" · ")}
          footer={
            <>
              <button className="btn" type="button" onClick={() => setDlg(null)}>{t("common.cancel")}</button>
              <button className="btn btn-pri" type="button" disabled={!reason.trim() || busy === "return"} onClick={() => void doReturn()}>
                {busy === "return" ? t("sale_detail.return_processing") : t("sale_detail.return_modal_title")}
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="ret-reason">{t("sale_detail.return_reason")}</label>
            <input id="ret-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("sale_detail.return_reason_ph")} autoFocus />
          </div>
          <div className="banner b-warn">
            <AlertTriangle className="ic" />
            <span>{t("v2.saledet.returnWarn", { name: ops.map((o) => o.operator_name).join(", ") || opName, month })}</span>
          </div>
        </Dialog>
      ) : null}

      {dlg === "delete" ? (
        <Dialog
          open
          danger
          onClose={() => setDlg(null)}
          width={440}
          title={t("v2.saledet.deleteTitle", { id: fmtNum(s.id) })}
          footer={
            <>
              <button className="btn" type="button" onClick={() => setDlg(null)}>{t("common.cancel")}</button>
              <button className="btn btn-danger" type="button" disabled={busy === "delete"} onClick={() => void doDelete()}>
                {busy === "delete" ? t("sale_detail.deleting") : t("v2.saledet.delete")}
              </button>
            </>
          }
        >
          <p className="s c2">{t("v2.saledet.deleteBody", { model: s.phone_model || "—", sum: fmtNum(total) })}</p>
        </Dialog>
      ) : null}
    </>
  );
}
