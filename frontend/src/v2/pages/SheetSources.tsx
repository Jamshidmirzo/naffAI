import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Activity, AlertTriangle, ArrowLeft, Check, ExternalLink, Loader2, Plus, RefreshCw, RotateCcw, Settings2, Sparkles, Users } from "lucide-react";
import { toast } from "../../components/ui";
import { OperatorDiagnosticsModal } from "../../components/operators/OperatorDiagnosticsModal";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum, useConfirm } from "../ui";
import {
  SHEET_MODES,
  sheetErrMsg,
  useSheetAliasBind,
  useSheetAliasCreate,
  useSheetAliases,
  useSheetFlushWritebacks,
  useSheetHealthOverview,
  useSheetOperators,
  useSheetPreview,
  useSheetRescan,
  useSheetSourceSave,
  useSheetSources,
  useSheetStats,
  useSheetSyncAll,
  useSheetSyncNow,
  type SheetDistributionMode,
  type SheetOperator,
  type SheetPreview,
  type SheetSource,
  type SheetSourceBody,
  type SheetSyncResult,
} from "../api/admin";

type T = ReturnType<typeof useT2>;
type Confirm = ReturnType<typeof useConfirm>;
type Tab = "sources" | "aliases";

const STATUSES = ["new", "archived", "needs_review"];

/** Column letters A..ZZ (writeback selects and the wizard preview header). */
const COL_LETTERS: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  for (let a = 0; a < 26; a++) for (let b = 0; b < 26; b++) out.push(String.fromCharCode(65 + a) + String.fromCharCode(65 + b));
  return out;
})();

const clampSla = (n: number) => Math.min(120, Math.max(1, Math.floor(Number(n) || 10)));

function ago(t: T, iso: string | null | undefined) {
  if (!iso) return t("v2.admin.sheets.never");
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 10) return t("v2.admin.sheets.justNow");
  if (sec < 60) return t("v2.admin.sheets.secAgo", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("v2.admin.sheets.minAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("v2.admin.sheets.hrAgo", { n: hr });
  return t("v2.admin.sheets.dayAgo", { n: Math.floor(hr / 24) });
}

function fmtDT(iso: string | null | undefined, withYear = true) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", ...(withYear ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit" });
}

function humanizeMap(cm: Record<string, unknown>): string {
  const slots: Array<[string, string]> = [
    ["phone", "Phone"],
    ["full_name", "Name"],
    ["product_hint", "Product"],
    ["has_card", "Card"],
    ["extra_phone", "Phone 2"],
    ["operator_alias", "Op"],
  ];
  const parts: string[] = [];
  for (const [k, label] of slots) {
    const raw = cm?.[k];
    if (!raw) continue;
    const disp = typeof raw === "string" ? raw : typeof raw === "object" && raw && "column_index" in raw ? `col#${(raw as { column_index: number }).column_index}` : "";
    if (disp) parts.push(`${label} → ${disp}`);
  }
  return parts.join(" · ") || "—";
}

/** /sheet-sources — Google Sheets lead sources and operator aliases (MgSheets, MgSheetsForm, MgSheetSources). */
export default function SheetSources() {
  const t = useT2();
  const [sp, setSp] = useSearchParams();
  const tab: Tab = sp.get("tab") === "aliases" ? "aliases" : "sources";
  const setTab = (x: Tab) => setSp(x === "sources" ? {} : { tab: x }, { replace: true });

  const sources = useSheetSources();
  const ops = useSheetOperators();
  const aliases = useSheetAliases();
  const confirm = useConfirm();

  const [edit, setEdit] = useState<SheetSource | null>(null);
  const [creating, setCreating] = useState(false);
  const [wizard, setWizard] = useState(false);

  const items = sources.data ?? [];
  const unbound = (aliases.data ?? []).filter((a) => !a.operator).length;

  return (
    <>
      <PageHeader title={t("v2.admin.sheets.title")} meta={t("v2.admin.sheets.sub")}>
        <button className="btn" type="button" title={t("sheet_src.add_manual_hint")} onClick={() => setCreating(true)}>
          <Plus className="ic ic-s" />
          {t("sheet_src.add")}
        </button>
        <button className="btn btn-pri" type="button" onClick={() => setWizard(true)}>
          <Sparkles className="ic ic-s" />
          {t("sheet_src.wizard.open_btn")}
        </button>
      </PageHeader>
      <main className="page">
        <SyncBar confirm={confirm} />

        {tab === "sources" && items.some((s) => s.active) ? (
          <div className="col g12">
            <span className="h3">{t("sheet_src.health.section_title")}</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
              {items
                .filter((s) => s.active)
                .map((s) => (
                  <HealthCard key={s.id} src={s} onConfigure={() => setEdit(s)} confirm={confirm} />
                ))}
            </div>
          </div>
        ) : null}

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "sources"} className={cx("tab", tab === "sources" && "is-on")} onClick={() => setTab("sources")}>
            {t("v2.admin.sheets.tabSources")}
            {sources.data ? <span className="num xs c3">{items.length}</span> : null}
          </button>
          <button type="button" role="tab" aria-selected={tab === "aliases"} className={cx("tab", tab === "aliases" && "is-on")} onClick={() => setTab("aliases")}>
            {t("v2.admin.sheets.tabAliases")}
            {unbound ? <span className="cnt">{unbound}</span> : null}
          </button>
        </div>

        {tab === "sources" ? (
          <SourcesTable q={sources} onEdit={setEdit} />
        ) : (
          <AliasesTab q={aliases} ops={ops.data ?? []} />
        )}
      </main>

      {edit || creating ? (
        <SourceForm
          value={edit}
          operators={ops.data ?? []}
          onClose={() => {
            setEdit(null);
            setCreating(false);
          }}
        />
      ) : null}
      {wizard ? <Wizard operators={ops.data ?? []} onClose={() => setWizard(false)} /> : null}
      {confirm.node}
    </>
  );
}

/* ------------------------------ sync bar + diagnostics ------------------------------ */

function SyncBar({ confirm }: { confirm: Confirm }) {
  const t = useT2();
  const q = useSheetHealthOverview(30_000);
  const syncAll = useSheetSyncAll();
  const [diag, setDiag] = useState(false);
  const [opDiag, setOpDiag] = useState(false);
  const d = q.data;

  const runAll = () =>
    syncAll.mutate(undefined, {
      onSuccess: (r) => toast.success(t("v2.admin.sheets.syncAllOk", { s: r?.total_sources ?? 0, r: r?.total_read ?? 0, c: r?.total_created ?? 0 })),
      onError: (e) => toast.error(sheetErrMsg(e) || t("v2.admin.sheets.syncAllFail")),
    });

  if (!d || d.total_active_sources === 0) return null;
  const bad = !d.overall_healthy;
  const errCount = d.sources.filter((s) => !s.is_healthy).length;

  return (
    <>
      <div className="card row g12 wrap" style={{ padding: "12px 16px", ...(bad ? { borderColor: "var(--bad-solid)", background: "var(--bad-bg)" } : {}) }}>
        <i className="dot" style={{ color: bad ? "var(--bad-solid)" : "var(--ok-solid)", width: 10, height: 10 }} />
        <span className="s grow" style={{ minWidth: 220 }}>
          <span className="w6">{t("v2.admin.sheets.bar.title")}</span>{" "}
          {bad ? (
            <span className="c-bad w6">
              <AlertTriangle className="ic ic-s" style={{ verticalAlign: "-2px", marginRight: 4 }} />
              {t("v2.admin.sheets.bar.bad", { n: errCount })}
            </span>
          ) : (
            <span className="c2">{t("v2.admin.sheets.bar.ok", { n: d.total_active_sources, at: ago(t, d.latest_sync_at), q: d.writeback.pending_count })}</span>
          )}
        </span>
        <button className="btn btn-sm" type="button" disabled={syncAll.isPending} onClick={runAll}>
          <RefreshCw className="ic ic-s" />
          {syncAll.isPending ? t("v2.admin.sheets.bar.checking") : t("v2.admin.sheets.bar.check")}
        </button>
        <button className="btn btn-sm" type="button" onClick={() => setDiag(true)}>
          <Activity className="ic ic-s" />
          {t("v2.admin.sheets.bar.tables")}
        </button>
        <button className="btn btn-sm" type="button" onClick={() => setOpDiag(true)}>
          <Users className="ic ic-s" />
          {t("v2.admin.sheets.bar.operators")}
        </button>
      </div>
      {diag ? <Diagnostics onClose={() => setDiag(false)} onRunAll={runAll} runningAll={syncAll.isPending} confirm={confirm} /> : null}
      <OperatorDiagnosticsModal open={opDiag} onClose={() => setOpDiag(false)} />
    </>
  );
}

function syncToast(t: T, key: string, r: SheetSyncResult | undefined) {
  toast.success(t(key, { r: fmtNum(r?.read ?? 0), c: fmtNum(r?.created ?? r?.imported ?? 0), m: fmtNum(r?.merged ?? 0) }));
}

function Diagnostics({ onClose, onRunAll, runningAll, confirm }: { onClose: () => void; onRunAll: () => void; runningAll: boolean; confirm: Confirm }) {
  const t = useT2();
  const q = useSheetHealthOverview(10_000);
  const flush = useSheetFlushWritebacks();
  const sync = useSheetSyncNow();
  const rescan = useSheetRescan();
  const d = q.data;

  const askRescan = async (id: number, name: string) => {
    const ok = await confirm({ title: t("v2.admin.sheets.rescanTitle", { name }), body: t("v2.admin.sheets.rescanBody"), confirm: t("v2.admin.sheets.rescanBtn") });
    if (!ok) return;
    rescan.mutate(id, {
      onSuccess: (r) => syncToast(t, "v2.admin.sheets.rescanOk", r),
      onError: (e) => toast.error(sheetErrMsg(e) || t("v2.admin.sheets.rescanFail")),
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={980}
      title={t("v2.admin.sheets.diag.title")}
      sub={t("v2.admin.sheets.diag.sub")}
      footer={
        <>
          <button className="btn" type="button" disabled={runningAll} onClick={onRunAll}>
            <RefreshCw className="ic ic-s" />
            {runningAll ? t("v2.admin.sheets.bar.checking") : t("v2.admin.sheets.diag.checkAll")}
          </button>
          <button className="btn btn-pri" type="button" onClick={onClose}>{t("v2.admin.sheets.diag.close")}</button>
        </>
      }
    >
      {q.isLoading ? (
        <LoadingBlock rows={4} onRetry={() => q.refetch()} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div className="well col g4">
              <span className="lbl">{t("v2.admin.sheets.diag.tables")}</span>
              <span className="s w6">{t("v2.admin.sheets.diag.tablesVal", { n: d.total_active_sources, ok: d.sources.filter((s) => s.is_healthy).length })}</span>
              <span className="xs c3">{t("v2.admin.sheets.diag.lastCheck", { at: ago(t, d.latest_sync_at) })}</span>
            </div>
            <div className="well col g4" style={d.writeback.failed_count > 0 ? { borderColor: "var(--bad-solid)" } : undefined}>
              <span className="lbl">{t("v2.admin.sheets.diag.wb")}</span>
              <span className={cx("s w6", d.writeback.failed_count > 0 && "c-bad")}>{t("v2.admin.sheets.diag.wbVal", { q: d.writeback.pending_count, f: d.writeback.failed_count })}</span>
              <span className="row between g8">
                <span className="xs c3">{t("v2.admin.sheets.diag.wbHour", { n: d.writeback.done_last_1h })}</span>
                {d.writeback.pending_count > 0 ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    disabled={flush.isPending}
                    onClick={() =>
                      flush.mutate(undefined, {
                        onSuccess: (r) => toast.success(t("v2.admin.sheets.diag.flushOk", { ok: r?.stats?.ok ?? 0, left: r?.remaining_pending ?? 0 })),
                        onError: (e) => toast.error(sheetErrMsg(e) || t("v2.admin.sheets.diag.flushFail")),
                      })
                    }
                  >
                    {t("v2.admin.sheets.diag.flush")}
                  </button>
                ) : null}
              </span>
            </div>
            <div className="well col g4" style={!d.overall_healthy ? { borderColor: "var(--bad-solid)" } : undefined}>
              <span className="lbl">{t("v2.admin.sheets.diag.total")}</span>
              <span className={cx("s w6", d.overall_healthy ? "c-ok" : "c-bad")}>{d.overall_healthy ? t("v2.admin.sheets.diag.allOk") : t("v2.admin.sheets.diag.hasErr")}</span>
            </div>
          </div>
          <span className="lbl">{t("v2.admin.sheets.diag.list")}</span>
          {d.sources.length === 0 ? (
            <span className="s c3">{t("v2.admin.sheets.diag.empty")}</span>
          ) : (
            <div className="col g8" style={{ maxHeight: 420, overflowY: "auto" }}>
              {d.sources.map((s) => (
                <div key={s.id} className="col g6" style={{ padding: "12px 14px", border: `1px solid ${s.last_sync_error ? "var(--bad-solid)" : "var(--line)"}`, borderRadius: 12 }}>
                  <div className="row g8 wrap">
                    <i className="dot" style={{ color: s.is_healthy ? "var(--ok-solid)" : "var(--bad-solid)", width: 10, height: 10 }} />
                    <span className="s w6">{s.name}</span>
                    <span className="xs c3">({s.worksheet_name || `gid: ${s.gid}`})</span>
                    <a
                      className="btn btn-ghost btn-sq btn-sm"
                      href={`https://docs.google.com/spreadsheets/d/${s.spreadsheet_id}/edit#gid=${s.gid}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t("v2.admin.sheets.diag.open")}
                      title={t("v2.admin.sheets.diag.open")}
                      style={{ width: 26, height: 26 }}
                    >
                      <ExternalLink className="ic ic-s" />
                    </a>
                    <span className="grow" />
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={sync.isPending && sync.variables?.id === s.id}
                      onClick={() =>
                        sync.mutate(
                          { id: s.id, force: true },
                          {
                            onSuccess: (r) => syncToast(t, "v2.admin.sheets.diag.checkOk", r),
                            onError: (e) => toast.error(sheetErrMsg(e) || t("v2.admin.sheets.diag.checkFail")),
                          },
                        )
                      }
                    >
                      <RefreshCw className="ic ic-s" />
                      {t("v2.admin.sheets.diag.check")}
                    </button>
                    <button className="btn btn-sm btn-ghost" type="button" title={t("sheet_src.health.full_rescan_title")} disabled={rescan.isPending && rescan.variables === s.id} onClick={() => askRescan(s.id, s.name)}>
                      <RotateCcw className="ic ic-s" />
                      {t("v2.admin.sheets.rescanBtn")}
                    </button>
                  </div>
                  <div className="row g16 wrap xs c3">
                    <span>{t("sheet_src.health.last_sync")}: <span className="w6" style={{ color: "var(--ink)" }}>{ago(t, s.last_synced_at)}</span></span>
                    <span>{t("v2.admin.sheets.diag.lastRow")}: <span className="num w6" style={{ color: "var(--ink)" }}>{fmtNum(s.last_synced_row)}</span></span>
                    <span>{t("v2.admin.sheets.diag.today", { n: fmtNum(s.leads_today), t: fmtNum(s.leads_total) })}</span>
                    <span>
                      {t("v2.admin.sheets.diag.wb")}:{" "}
                      <span className={cx("w6", s.writeback_enabled ? "c-ok" : "c3")}>
                        {s.writeback_enabled ? t("v2.admin.sheets.diag.wbOn", { cols: `${s.writeback_status_col || "D"}, ${s.writeback_operator_col || "E"}` }) : t("v2.admin.sheets.diag.wbOff")}
                      </span>
                    </span>
                  </div>
                  {s.last_sync_error ? (
                    <div className="banner b-bad" style={{ padding: "8px 12px" }}>
                      <AlertTriangle className="ic ic-s" />
                      <span className="col g4">
                        <span className="xs w6" style={{ overflowWrap: "anywhere" }}>{t("v2.admin.sheets.diag.err", { e: s.last_sync_error })}</span>
                        <span className="xs">{t("v2.admin.sheets.diag.errHint")}</span>
                      </span>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </Dialog>
  );
}

/* ------------------------------ health card ------------------------------ */

function HealthCard({ src, onConfigure, confirm }: { src: SheetSource; onConfigure: () => void; confirm: Confirm }) {
  const t = useT2();
  const q = useSheetStats(src.id);
  const sync = useSheetSyncNow();
  const [showErr, setShowErr] = useState(false);
  const s = q.data;
  const state: "ok" | "warn" | "bad" = !s ? "warn" : s.last_sync_error ? "bad" : s.is_healthy ? "ok" : "warn";
  const cls = { ok: "c-ok", warn: "c-warn", bad: "c-bad" }[state];

  const run = (force: boolean) =>
    sync.mutate(
      { id: src.id, force },
      {
        onSuccess: (r) => toast.success(t("sheet_src.health.sync_ok_detailed", { created: fmtNum(r?.created ?? 0), read: fmtNum(r?.read ?? 0), merged: fmtNum(r?.merged ?? 0) })),
        onError: (e) => toast.error(sheetErrMsg(e) || t("sheet_src.health.sync_failed")),
      },
    );

  return (
    <section className="card col g8 pad">
      <div className="row between g8">
        <span className="s w6 trunc">{s?.name || src.name}</span>
        <span className="row g6">
          <span className={cx("row g6 xs", cls)}>
            <i className="dot" />
            {t(`sheet_src.health.${state}`)}
          </span>
          <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("sheet_src.health.configure")} title={t("sheet_src.health.configure")} style={{ width: 26, height: 26 }} onClick={onConfigure}>
            <Settings2 className="ic ic-s" />
          </button>
        </span>
      </div>
      {q.isError ? (
        <span className="xs c-bad">{sheetErrMsg(q.error)}</span>
      ) : (
        <>
          <div className="row g8" style={{ alignItems: "baseline" }}>
            <span className="kpi" style={{ fontSize: 22 }}>{s ? fmtNum(s.leads_last_24h) : "—"}</span>
            <span className="xs c3">{t("sheet_src.health.leads_24h")}</span>
          </div>
          <span className="xs c3 num">
            {t("sheet_src.health.last_sync")}: {s?.last_sync_at ? fmtDT(s.last_sync_at, false) : "—"} · {t("sheet_src.health.leads_total", { n: fmtNum(s?.leads_total ?? 0) })}
          </span>
        </>
      )}
      {state === "bad" && s?.last_sync_error ? (
        <span className="col g4">
          <button type="button" className="btn btn-ghost btn-sm c-bad" style={{ alignSelf: "flex-start", padding: 0, height: "auto" }} onClick={() => setShowErr((v) => !v)}>
            {showErr ? t("sheet_src.health.hide_error") : t("sheet_src.health.show_error")}
          </button>
          {showErr ? <span className="err" style={{ alignItems: "flex-start", overflowWrap: "anywhere" }}>{s.last_sync_error}</span> : null}
        </span>
      ) : null}
      <div className="row g6">
        <button className="btn btn-sm grow" type="button" title={t("sheet_src.health.sync_now_hint")} disabled={sync.isPending} onClick={() => run(false)}>
          {sync.isPending ? <Loader2 className="ic ic-s" style={{ animation: "v2spin 1s linear infinite" }} /> : <RefreshCw className="ic ic-s" />}
          {sync.isPending ? t("sheet_src.health.syncing") : t("sheet_src.health.sync_now")}
        </button>
        <button
          className="btn btn-sm btn-ghost"
          type="button"
          title={t("sheet_src.health.full_rescan_title")}
          disabled={sync.isPending}
          onClick={async () => {
            const ok = await confirm({ title: t("v2.admin.sheets.rescanTitle", { name: src.name }), body: t("v2.admin.sheets.rescanBody"), confirm: t("sheet_src.health.full_rescan_btn") });
            if (ok) run(true);
          }}
        >
          {t("sheet_src.health.full_rescan_btn")}
        </button>
      </div>
      <style>{"@keyframes v2spin{to{transform:rotate(360deg)}}"}</style>
    </section>
  );
}

/* ------------------------------ sources table ------------------------------ */

const SRC_COLS = "minmax(160px,1.2fr) minmax(180px,1.5fr) 70px minmax(130px,1fr) minmax(180px,1.5fr) 130px 120px";

function SourcesTable({ q, onEdit }: { q: ReturnType<typeof useSheetSources>; onEdit: (s: SheetSource) => void }) {
  const t = useT2();
  const items = q.data ?? [];
  return (
    <>
      <div className="row between wrap g8">
        <span className="s">
          <span className="w6">{t("sheet_src.total", { n: items.length })}</span> <span className="c3">· {t("sheet_src.hint_paste_url")}</span>
        </span>
      </div>
      <section className="card tbl">
        {q.isLoading ? (
          <LoadingBlock rows={5} onRetry={() => q.refetch()} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title={t("sheet_src.empty")} body={t("v2.admin.sheets.emptyBody")} />
        ) : (
          <div className="scroll-x">
            <div style={{ minWidth: 1040 }}>
              <div className="tr th" style={{ gridTemplateColumns: SRC_COLS }}>
                <span>{t("sheet_src.col_name")}</span>
                <span>{t("sheet_src.col_spreadsheet")}</span>
                <span>{t("sheet_src.col_gid")}</span>
                <span>{t("v2.admin.sheets.colDefaultOp")}</span>
                <span>{t("v2.admin.sheets.colMode")}</span>
                <span>{t("sheet_src.col_last_row")}</span>
                <span />
              </div>
              {items.map((s) => {
                const map = humanizeMap(s.column_map);
                return (
                  <div key={s.id} className="tr" role="button" tabIndex={0} style={{ gridTemplateColumns: SRC_COLS, minHeight: 64, cursor: "pointer", opacity: s.active ? 1 : 0.65 }} onClick={() => onEdit(s)} onKeyDown={(e) => e.key === "Enter" && onEdit(s)}>
                    <span className="row g6" style={{ minWidth: 0 }}>
                      <span className="w6 trunc">{s.name}</span>
                      {!s.active ? <span className="badge">{t("sheet_src.off")}</span> : null}
                    </span>
                    <span className="col" style={{ minWidth: 0 }}>
                      <span className="num xs c2 trunc">{s.spreadsheet_id}</span>
                      <span className="xs c3 trunc" title={map}>{map}</span>
                    </span>
                    <span className="num xs c2">{s.gid}</span>
                    <span className="s trunc">{s.default_operator_name || "—"}</span>
                    <span className="row g4 wrap">
                      <span className="badge" style={{ whiteSpace: "normal", height: "auto", minHeight: 22, padding: "2px 8px", flex: "0 1 auto", maxWidth: "100%" }}>
                        {SHEET_MODES.includes(s.distribution_mode) ? t(`v2.admin.sheets.mode.${s.distribution_mode}`) : s.distribution_mode}
                      </span>
                      {(s.allowed_operator_ids?.length ?? 0) > 0 ? <span className="badge b-hot">{t("v2.admin.sheets.pool", { n: s.allowed_operator_ids!.length })}</span> : null}
                      {s.is_hot ? <span className="badge b-bad">{t("v2.admin.sheets.hotChip", { n: s.hot_sla_minutes ?? 10 })}</span> : null}
                    </span>
                    <span className="col">
                      <span className="num s">#{fmtNum(s.last_synced_row)}</span>
                      {s.last_synced_at ? <span className="num xs c3">{fmtDT(s.last_synced_at)}</span> : null}
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      style={{ justifySelf: "end" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(s);
                      }}
                    >
                      {t("common.edit")}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

/* ------------------------------ shared form blocks ------------------------------ */

function PoolPicker({ ops, ids, setIds, show, setShow }: { ops: SheetOperator[]; ids: number[]; setIds: (f: (p: number[]) => number[]) => void; show: boolean; setShow: (v: boolean) => void }) {
  const t = useT2();
  const active = useMemo(() => ops.filter((o) => o.status === "active").sort((a, b) => a.full_name.localeCompare(b.full_name)), [ops]);
  return (
    <div className="col g8">
      <span className="flabel">{t("sheet_src.wizard.allowed_operators.title")}</span>
      <span className="hint">{t("sheet_src.wizard.allowed_operators.hint")}</span>
      <label className="row g8 s" style={{ cursor: "pointer" }}>
        <input
          className="check"
          type="checkbox"
          checked={!show}
          onChange={(e) => {
            if (e.target.checked) {
              setIds(() => []);
              setShow(false);
            } else setShow(true);
          }}
        />
        {t("sheet_src.wizard.allowed_operators.all")}
      </label>
      {show ? (
        <>
          <span className="xs c3">{t("v2.admin.sheets.poolPick")}</span>
          <div className="row g6 wrap">
            {active.map((o) => {
              const on = ids.includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  className={cx("chip", on && "is-on")}
                  aria-pressed={on}
                  onClick={() => setIds((p) => (on ? p.filter((x) => x !== o.id) : Array.from(new Set([...p, o.id]))))}
                >
                  {on ? <Check className="ic ic-s" /> : null}
                  {o.full_name}
                </button>
              );
            })}
          </div>
          <span className={cx("xs", ids.length ? "c3" : "c-warn w6")}>{ids.length ? t("v2.admin.sheets.pool", { n: ids.length }) : t("v2.admin.sheets.poolEmpty")}</span>
        </>
      ) : null}
    </div>
  );
}

function HotBlock({ on, setOn, sla, setSla }: { on: boolean; setOn: (v: boolean) => void; sla: number; setSla: (n: number) => void }) {
  const t = useT2();
  const bad = on && (sla < 1 || sla > 120 || !Number.isFinite(sla));
  return (
    <div className="well col g8">
      <label className="row g8 s w6" style={{ cursor: "pointer" }}>
        <input className="check" type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        {t("v2.admin.sheets.hot")}
      </label>
      <span className="xs c3">{t("sheet_src.wizard.is_hot_hint")}</span>
      {on ? (
        <div className="row g8 wrap" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ width: 120 }}>
            <label htmlFor="v2-sla">{t("sheet_src.wizard.hot_sla")}</label>
            <input id="v2-sla" className={cx("input num", bad && "is-bad")} type="number" min={1} max={120} value={sla} onChange={(e) => setSla(Number(e.target.value))} />
          </div>
          <span className="hint grow" style={{ paddingBottom: 4, minWidth: 200 }}>{bad ? <span className="c-bad w6">{t("v2.admin.sheets.slaRange")}</span> : t("v2.admin.sheets.slaHint")}</span>
        </div>
      ) : null}
    </div>
  );
}

type WbCols = { status: string; operator: string; updated: string; comment: string };

function WritebackBlock({ on, setOn, cols, setCols, asSelect }: { on: boolean; setOn: (v: boolean) => void; cols: WbCols; setCols: (c: WbCols) => void; asSelect?: boolean }) {
  const t = useT2();
  const fields: Array<[keyof WbCols, string]> = [
    ["status", "sheet_src.wb_status_col"],
    ["operator", "sheet_src.wb_operator_col"],
    ["updated", "sheet_src.wb_updated_col"],
    ["comment", "sheet_src.wb_comment_col"],
  ];
  return (
    <div className="well col g8">
      <label className="row g8 s w6" style={{ cursor: "pointer" }}>
        <input className="check" type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        {t("v2.admin.sheets.writeback")}
      </label>
      {on ? (
        <div className="row g8">
          {fields.map(([k, label]) => (
            <div key={k} className="field grow">
              <label htmlFor={`v2-wb-${k}`} className="xs">{t(label)}</label>
              {asSelect ? (
                <select id={`v2-wb-${k}`} className="input num" style={{ height: 34 }} value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: e.target.value })}>
                  {COL_LETTERS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <input
                  id={`v2-wb-${k}`}
                  className="input num"
                  type="text"
                  maxLength={3}
                  value={cols[k]}
                  style={{ textTransform: "uppercase", textAlign: "center" }}
                  onChange={(e) => setCols({ ...cols, [k]: e.target.value.slice(0, 3) })}
                />
              )}
            </div>
          ))}
        </div>
      ) : null}
      <span className="hint">{t("sheet_src.writeback_hint")}</span>
    </div>
  );
}

const wbBody = (on: boolean, c: WbCols) => ({
  enabled: on,
  status_col: c.status.trim().toUpperCase() || "D",
  operator_col: c.operator.trim().toUpperCase() || "E",
  updated_col: c.updated.trim().toUpperCase() || "F",
  comment_col: c.comment.trim().toUpperCase() || "G",
});

/* ------------------------------ manual add / edit form ------------------------------ */

function SourceForm({ value, operators, onClose }: { value: SheetSource | null; operators: SheetOperator[]; onClose: () => void }) {
  const t = useT2();
  const save = useSheetSourceSave();
  const isEdit = !!value;
  const [name, setName] = useState(value?.name || "");
  const [ss, setSs] = useState(value?.spreadsheet_id || "");
  const [gid, setGid] = useState(String(value?.gid ?? ""));
  const [ws, setWs] = useState(value?.worksheet_name || "");
  const [status, setStatus] = useState(value?.default_status || "new");
  const [active, setActive] = useState(value?.active ?? true);
  const [defOp, setDefOp] = useState(value?.default_operator ? String(value.default_operator) : "");
  const [mode, setMode] = useState<SheetDistributionMode>(value?.distribution_mode || "alias_only");
  const [ids, setIds] = useState<number[]>(value?.allowed_operator_ids || []);
  const [showPool, setShowPool] = useState((value?.allowed_operator_ids?.length ?? 0) > 0);
  const [hot, setHot] = useState(value?.is_hot ?? false);
  const [sla, setSla] = useState(value?.hot_sla_minutes ?? 10);
  const [mapJson, setMapJson] = useState(JSON.stringify(value?.column_map || {}, null, 2));
  const wb = value?.writeback_columns || {};
  const [wbOn, setWbOn] = useState(wb.enabled ?? true);
  const [cols, setCols] = useState<WbCols>({ status: wb.status_col || "D", operator: wb.operator_col || "E", updated: wb.updated_col || "F", comment: wb.comment_col || "G" });
  const [tried, setTried] = useState(false);
  const [error, setError] = useState("");

  let mapOk = true;
  try {
    JSON.parse(mapJson);
  } catch {
    mapOk = false;
  }
  const gidOk = /^\d+$/.test(gid.trim());
  const errs = { name: !name.trim(), ss: !ss.trim(), gid: !gidOk, map: !mapOk };

  const submit = () => {
    setTried(true);
    setError("");
    if (errs.name || errs.ss || errs.gid || errs.map) return;
    const body: SheetSourceBody = {
      name: name.trim(),
      spreadsheet_id: ss.trim(),
      gid: Number(gid),
      worksheet_name: ws,
      column_map: JSON.parse(mapJson),
      default_status: status,
      active,
      default_operator: defOp ? Number(defOp) : null,
      distribution_mode: mode,
      allowed_operator_ids: showPool ? ids : [],
      is_hot: hot,
      hot_sla_minutes: clampSla(sla),
      writeback_columns: wbBody(wbOn, cols),
    };
    save.mutate(
      { id: value?.id ?? null, body },
      {
        onSuccess: () => {
          toast.success(t("toast.saved"));
          onClose();
        },
        onError: (e) => setError(sheetErrMsg(e) || t("common.save_failed")),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={760}
      title={isEdit ? t("sheet_src.form_edit") : t("sheet_src.form_new")}
      sub={isEdit ? value?.name : undefined}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" disabled={save.isPending} onClick={submit}>
            {save.isPending ? t("common.saving") : t("common.save")}
          </button>
        </>
      }
    >
      <div className="row g12 wrap" style={{ alignItems: "flex-start" }}>
        <div className="field grow" style={{ flexBasis: 240 }}>
          <label htmlFor="sf-name">{t("sheet_src.field_name")}</label>
          <input id="sf-name" className={cx("input", tried && errs.name && "is-bad")} type="text" value={name} onChange={(e) => setName(e.target.value)} />
          {tried && errs.name ? <span className="err">{t("v2.admin.sheets.needName")}</span> : null}
        </div>
        <div className="field" style={{ width: 240 }}>
          <label htmlFor="sf-status">{t("v2.admin.sheets.defaultStatus")}</label>
          <select id="sf-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            {(STATUSES.includes(status) ? STATUSES : [status, ...STATUSES]).map((s) => (
              <option key={s} value={s}>{STATUSES.includes(s) ? t(`v2.admin.sheets.status.${s}`) : s}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="row g12 wrap" style={{ alignItems: "flex-start" }}>
        <div className="field grow" style={{ flexBasis: 260 }}>
          <label htmlFor="sf-ss">{t("sheet_src.field_spreadsheet_id")}</label>
          <input id="sf-ss" className={cx("input num", tried && errs.ss && "is-bad")} type="text" value={ss} onChange={(e) => setSs(e.target.value)} />
          {tried && errs.ss ? <span className="err">{t("v2.admin.sheets.needSs")}</span> : null}
        </div>
        <div className="field" style={{ width: 120 }}>
          <label htmlFor="sf-gid">{t("sheet_src.field_gid")}</label>
          <input id="sf-gid" className={cx("input num", tried && errs.gid && "is-bad")} type="text" inputMode="numeric" value={gid} onChange={(e) => setGid(e.target.value)} />
          {tried && errs.gid ? <span className="err">{t("v2.admin.sheets.needGid")}</span> : null}
        </div>
        <div className="field" style={{ width: 200 }}>
          <label htmlFor="sf-ws">{t("sheet_src.field_ws")}</label>
          <input id="sf-ws" className="input" type="text" value={ws} onChange={(e) => setWs(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="sf-map">{t("v2.admin.sheets.mapLabel")}</label>
        <textarea
          id="sf-map"
          className={cx("input num", !mapOk && "is-bad")}
          rows={6}
          style={{ fontSize: 12.5 }}
          value={mapJson}
          placeholder='{"full_name": "full_name", "phone": "phone_number"}'
          onChange={(e) => setMapJson(e.target.value)}
        />
        {!mapOk ? <span className="err">{t("sheet_src.map_invalid")}</span> : null}
      </div>
      <div className="row g12 wrap" style={{ alignItems: "flex-end" }}>
        <div className="field grow" style={{ flexBasis: 240 }}>
          <label htmlFor="sf-op">{t("v2.admin.sheets.colDefaultOp")}</label>
          <select id="sf-op" className="input" value={defOp} onChange={(e) => setDefOp(e.target.value)}>
            <option value="">{t("sheet_src.option_none")}</option>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>{o.full_name}</option>
            ))}
          </select>
        </div>
        <label className="row g8 s" style={{ height: 40, cursor: "pointer" }}>
          <input className="check" type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {t("sheet_src.active_hint")}
        </label>
      </div>
      <fieldset className="col g8" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="flabel" style={{ marginBottom: 8 }}>{t("v2.admin.sheets.modeLabel")}</legend>
        {SHEET_MODES.map((m) => (
          <label key={m} className={cx("row g12", mode === m && "pick-on")} style={{ alignItems: "flex-start", padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 11, cursor: "pointer" }}>
            <input type="radio" name="sf-mode" checked={mode === m} onChange={() => setMode(m)} style={{ margin: "3px 0 0" }} />
            <span className="col g4">
              <span className="s w6">{t(`v2.admin.sheets.mode.${m}`)}</span>
              <span className="xs c3">{t(`v2.admin.sheets.modeHint.${m}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <PoolPicker ops={operators} ids={ids} setIds={setIds} show={showPool} setShow={setShowPool} />
      <HotBlock on={hot} setOn={setHot} sla={sla} setSla={setSla} />
      <WritebackBlock on={wbOn} setOn={setWbOn} cols={cols} setCols={setCols} />
      {error ? (
        <div className="banner b-bad">
          <AlertTriangle className="ic" />
          <span style={{ overflowWrap: "anywhere" }}>{error}</span>
        </div>
      ) : null}
    </Dialog>
  );
}

/* ------------------------------ aliases ------------------------------ */

function AliasesTab({ q, ops }: { q: ReturnType<typeof useSheetAliases>; ops: SheetOperator[] }) {
  const t = useT2();
  const bind = useSheetAliasBind();
  const [creating, setCreating] = useState(false);
  const items = q.data ?? [];
  const unbound = items.filter((a) => !a.operator).length;
  return (
    <>
      <section className="card tbl">
        <div className="card-h">
          <span className="s">
            {unbound ? <span className="w6 c-hot">{t("v2.admin.sheets.aliasUnbound", { n: unbound })}</span> : null}{" "}
            <span className="c3">{unbound ? "· " : ""}{t("v2.admin.sheets.aliasTotal", { n: items.length })}</span>
          </span>
          <button className="btn btn-sm btn-pri" type="button" onClick={() => setCreating(true)}>
            <Plus className="ic ic-s" />
            {t("v2.admin.sheets.aliasAdd")}
          </button>
        </div>
        {q.isLoading ? (
          <LoadingBlock rows={5} onRetry={() => q.refetch()} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title={t("v2.admin.sheets.aliasEmpty")} />
        ) : (
          <>
            <div className="tr th" style={{ gridTemplateColumns: "1fr 1.2fr" }}>
              <span>{t("v2.admin.sheets.aliasCol")}</span>
              <span>{t("sheet_src.aliases_col_op")}</span>
            </div>
            {items.map((a) => (
              <div key={a.id} className="tr" style={{ gridTemplateColumns: "1fr 1.2fr", minHeight: 50 }}>
                <span className="row g6" style={{ minWidth: 0 }}>
                  <span className="num s trunc">{a.alias_name}</span>
                  {!a.operator ? <span className="badge b-warn">{t("sheet_src.aliases_unbound_badge")}</span> : null}
                </span>
                <select
                  className={cx("input", !a.operator && "is-warn")}
                  aria-label={t("v2.admin.sheets.aliasFor", { alias: a.alias_name })}
                  style={{ height: 34 }}
                  value={a.operator ? String(a.operator) : ""}
                  disabled={bind.isPending && bind.variables?.id === a.id}
                  onChange={(e) =>
                    bind.mutate(
                      { id: a.id, operator: e.target.value ? Number(e.target.value) : null },
                      {
                        onSuccess: () => toast.success(t("sheet_src.bound")),
                        onError: (er) => toast.error(sheetErrMsg(er) || t("common.save_failed")),
                      },
                    )
                  }
                >
                  <option value="">{t("sheet_src.aliases_none")}</option>
                  {ops.map((o) => (
                    <option key={o.id} value={o.id}>{o.full_name}</option>
                  ))}
                </select>
              </div>
            ))}
          </>
        )}
      </section>
      {creating ? <NewAlias onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function NewAlias({ onClose }: { onClose: () => void }) {
  const t = useT2();
  const create = useSheetAliasCreate();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    setError("");
    create.mutate(name.trim(), {
      onSuccess: () => {
        toast.success(t("v2.admin.sheets.aliasCreated"));
        onClose();
      },
      onError: (e) => setError(sheetErrMsg(e) || t("common.save_failed")),
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={440}
      title={t("v2.admin.sheets.aliasNew")}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" disabled={create.isPending || !name.trim()} onClick={submit}>
            {create.isPending ? t("common.saving") : t("common.save")}
          </button>
        </>
      }
    >
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="v2-alias">{t("sheet_src.alias_new_field")}</label>
        <input id="v2-alias" className="input" type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </form>
      {error ? <div className="banner b-bad"><span>{error}</span></div> : null}
    </Dialog>
  );
}

/* ------------------------------ 3-step wizard ------------------------------ */

type MapKey = "phone" | "full_name" | "product_hint" | "has_card" | "extra_phone";
const MAP_FIELDS: Array<[MapKey, string, boolean]> = [
  ["phone", "sheet_src.wizard.map_phone", true],
  ["full_name", "sheet_src.wizard.map_full_name", true],
  ["product_hint", "sheet_src.wizard.map_product_hint", false],
  ["has_card", "sheet_src.wizard.map_has_card", false],
  ["extra_phone", "sheet_src.wizard.map_extra_phone", false],
];

function Wizard({ operators, onClose }: { operators: SheetOperator[]; onClose: () => void }) {
  const t = useT2();
  const previewMut = useSheetPreview();
  const save = useSheetSourceSave();
  const sync = useSheetSyncNow();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<SheetPreview | null>(null);
  const [previewErr, setPreviewErr] = useState("");
  const [map, setMap] = useState<Record<MapKey, string>>({ phone: "", full_name: "", product_hint: "", has_card: "", extra_phone: "" });
  const [tried2, setTried2] = useState(false);

  const [name, setName] = useState("");
  const [status, setStatus] = useState("new");
  const [mode, setMode] = useState<SheetDistributionMode>("alias_or_rr");
  const [defOp, setDefOp] = useState("");
  const [ids, setIds] = useState<number[]>([]);
  const [showPool, setShowPool] = useState(false);
  const [hot, setHot] = useState(false);
  const [sla, setSla] = useState(10);
  const [wbOn, setWbOn] = useState(false);
  const [cols, setCols] = useState<WbCols>({ status: "D", operator: "E", updated: "F", comment: "G" });
  const [createErr, setCreateErr] = useState("");

  const check = () =>
    previewMut.mutate(url.trim(), {
      onSuccess: (d) => {
        setPreview(d);
        setPreviewErr("");
        setMap({
          phone: d.suggested_column_map.phone || "",
          full_name: d.suggested_column_map.full_name || "",
          product_hint: d.suggested_column_map.product_hint || "",
          has_card: d.suggested_column_map.has_card || "",
          extra_phone: d.suggested_column_map.extra_phone || "",
        });
        setName(d.sheet_title || "");
        setCols({
          status: d.suggested_writeback.status_col || "D",
          operator: d.suggested_writeback.operator_col || "E",
          updated: d.suggested_writeback.updated_at_col || "F",
          comment: d.suggested_writeback.comment_col || "G",
        });
        setWbOn(Object.values(d.suggested_writeback).some((v) => !!v));
      },
      onError: (err) => {
        const msg = sheetErrMsg(err) || t("v2.state.errorBody");
        // eslint-disable-next-line no-console
        console.error("[sheet-source wizard] preview failed:", err);
        setPreviewErr(msg);
        setPreview(null);
        toast.error(msg);
      },
    });

  const headers = preview?.headers ?? [];
  const headerLabel = (h: string) => {
    const i = headers.indexOf(h);
    return i >= 0 ? t("v2.admin.sheets.wiz.col", { letter: COL_LETTERS[i], name: h }) : h;
  };
  const canStep2 = !!preview && headers.length > 0;
  const canStep3 = canStep2 && !!map.phone && !!map.full_name;
  const slaBad = hot && (sla < 1 || sla > 120);

  const connect = () => {
    if (!preview || slaBad) return;
    setCreateErr("");
    const columnMap: Record<string, string> = {};
    (Object.keys(map) as MapKey[]).forEach((k) => {
      if (map[k]) columnMap[k] = map[k];
    });
    const body: SheetSourceBody = {
      name: name.trim() || preview.sheet_title || "New source",
      spreadsheet_id: preview.spreadsheet_id,
      gid: preview.gid,
      worksheet_name: preview.sheet_title,
      column_map: columnMap,
      default_status: status,
      active: true,
      default_operator: defOp ? Number(defOp) : null,
      distribution_mode: mode,
      allowed_operator_ids: showPool ? ids : [],
      is_hot: hot,
      hot_sla_minutes: clampSla(sla),
      writeback_columns: wbBody(wbOn, cols),
    };
    (async () => {
      let created: SheetSource;
      try {
        created = await save.mutateAsync({ id: null, body });
      } catch (e) {
        const msg = sheetErrMsg(e) || t("common.save_failed");
        setCreateErr(msg);
        toast.error(msg);
        return;
      }
      toast.success(t("sheet_src.wizard.connected"));
      // best-effort first sync, like the old wizard
      try {
        const r = await sync.mutateAsync({ id: created.id });
        toast.success(t("sheet_src.wizard.sync_ok", { n: fmtNum(r?.created ?? r?.imported ?? 0) }));
      } catch (e) {
        toast.error(sheetErrMsg(e) || t("sheet_src.wizard.sync_failed"));
      }
      onClose();
    })();
  };

  const titles = { 1: "v2.admin.sheets.wiz.s1", 2: "v2.admin.sheets.wiz.s2", 3: "v2.admin.sheets.wiz.s3" } as const;

  return (
    <Dialog
      open
      onClose={onClose}
      width={step === 1 ? 820 : 640}
      title={t(titles[step])}
      sub={`${t("v2.admin.sheets.wiz.title")} · ${t("v2.admin.sheets.wiz.step", { n: step })}`}
      footer={
        <>
          <button className="btn" type="button" onClick={() => (step > 1 ? setStep((step - 1) as 1 | 2) : onClose())}>
            {step > 1 ? (
              <>
                <ArrowLeft className="ic ic-s" />
                {t("common.back")}
              </>
            ) : (
              t("common.cancel")
            )}
          </button>
          {step < 3 ? (
            <button
              className="btn btn-pri"
              type="button"
              disabled={step === 1 ? !canStep2 : false}
              onClick={() => {
                if (step === 1) setStep(2);
                else {
                  setTried2(true);
                  if (canStep3) setStep(3);
                }
              }}
            >
              {t("v2.admin.sheets.wiz.next")}
            </button>
          ) : (
            <button className="btn btn-pri" type="button" disabled={save.isPending || sync.isPending || slaBad} onClick={connect}>
              {save.isPending || sync.isPending ? <Loader2 className="ic ic-s" /> : null}
              {t("sheet_src.wizard.connect_btn")}
            </button>
          )}
        </>
      }
    >
      <div className="row g6" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} className={cx("slot", step >= n && "on")} />
        ))}
      </div>

      {step === 1 ? (
        <>
          <form
            className="col g6"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) check();
            }}
          >
            <label className="flabel" htmlFor="wz-url">{t("sheet_src.wizard.url_label")}</label>
            <div className="row g8">
              <input
                id="wz-url"
                className={cx("input grow num", previewErr && "is-bad")}
                type="text"
                autoFocus
                value={url}
                placeholder="https://docs.google.com/spreadsheets/d/…/edit?gid=0"
                style={{ fontSize: 12.5 }}
                onChange={(e) => setUrl(e.target.value)}
              />
              <button className="btn" type="submit" disabled={previewMut.isPending || !url.trim()}>
                {previewMut.isPending ? <Loader2 className="ic ic-s" /> : null}
                {t("sheet_src.wizard.check_btn")}
              </button>
            </div>
            <span className="hint">{t("sheet_src.wizard.url_hint")}</span>
          </form>
          {previewErr ? (
            <div className="banner b-bad">
              <AlertTriangle className="ic" />
              <span style={{ overflowWrap: "anywhere" }}>{previewErr}</span>
            </div>
          ) : null}
          {preview?.already_connected ? (
            <div className="banner b-warn">
              <AlertTriangle className="ic" />
              <span>{t("v2.admin.sheets.wiz.already", { name: preview.already_connected.name })}</span>
            </div>
          ) : null}
          {preview ? (
            <>
              <span className="s w6">{preview.sheet_title}</span>
              {headers.length === 0 ? (
                <div className="banner b-warn"><span>{t("v2.admin.sheets.wiz.noHeaders")}</span></div>
              ) : (
                <div className="card tbl scroll-x">
                  <div style={{ minWidth: Math.max(480, headers.length * 140) }}>
                    <div className="tr th" style={{ gridTemplateColumns: `repeat(${headers.length}, minmax(120px, 1fr))`, textTransform: "none", letterSpacing: 0 }}>
                      {headers.map((h, i) => (
                        <span key={i} className="trunc">{COL_LETTERS[i]} · {h || "—"}</span>
                      ))}
                    </div>
                    {preview.sample_rows.map((r, ri) => (
                      <div key={ri} className="tr" style={{ gridTemplateColumns: `repeat(${headers.length}, minmax(120px, 1fr))`, fontSize: 12, minHeight: 36 }}>
                        {headers.map((_, ci) => (
                          <span key={ci} className="trunc">{r[ci] || ""}</span>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <span className="xs c3">{t("sheet_src.wizard.rows_found", { n: fmtNum(preview.total_rows) })}</span>
            </>
          ) : null}
        </>
      ) : null}

      {step === 2 && preview ? (
        <>
          <span className="s c3">{t("sheet_src.wizard.map_hint")}</span>
          {MAP_FIELDS.map(([k, label, req]) => {
            const missing = req && tried2 && !map[k];
            return (
              <div key={k} className="field">
                <label htmlFor={`wz-${k}`}>{t(label)}{req ? " *" : ""}</label>
                <select id={`wz-${k}`} className={cx("input", missing && "is-bad")} value={map[k]} onChange={(e) => setMap({ ...map, [k]: e.target.value })}>
                  <option value="">{t("sheet_src.wizard.column_none")}</option>
                  {headers.filter(Boolean).map((h) => (
                    <option key={h} value={h}>{headerLabel(h)}</option>
                  ))}
                </select>
                {missing ? <span className="err">{t(k === "phone" ? "v2.admin.sheets.wiz.needPhone" : "v2.admin.sheets.wiz.needName")}</span> : null}
              </div>
            );
          })}
        </>
      ) : null}

      {step === 3 && preview ? (
        <>
          <div className="field">
            <label htmlFor="wz-name">{t("sheet_src.field_name")}</label>
            <input id="wz-name" className="input" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="row g8 wrap">
            <div className="field grow" style={{ flexBasis: 200 }}>
              <label htmlFor="wz-status">{t("v2.admin.sheets.defaultStatus")}</label>
              <select id="wz-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{t(`v2.admin.sheets.status.${s}`)}</option>
                ))}
              </select>
            </div>
            <div className="field grow" style={{ flexBasis: 200 }}>
              <label htmlFor="wz-op">{t("v2.admin.sheets.colDefaultOp")}</label>
              <select id="wz-op" className="input" value={defOp} onChange={(e) => setDefOp(e.target.value)}>
                <option value="">{t("sheet_src.option_none")}</option>
                {operators.map((o) => (
                  <option key={o.id} value={o.id}>{o.full_name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="wz-mode">{t("v2.admin.sheets.modeLabel")}</label>
            <select id="wz-mode" className="input" value={mode} onChange={(e) => setMode(e.target.value as SheetDistributionMode)}>
              {SHEET_MODES.map((m) => (
                <option key={m} value={m}>{t(`v2.admin.sheets.mode.${m}`)}</option>
              ))}
            </select>
            <span className="hint">{t(`v2.admin.sheets.modeHint.${mode}`)}</span>
          </div>
          <PoolPicker ops={operators} ids={ids} setIds={setIds} show={showPool} setShow={setShowPool} />
          <HotBlock on={hot} setOn={setHot} sla={sla} setSla={setSla} />
          <WritebackBlock on={wbOn} setOn={setWbOn} cols={cols} setCols={setCols} asSelect />
          {createErr ? (
            <div className="banner b-bad">
              <AlertTriangle className="ic" />
              <span style={{ overflowWrap: "anywhere" }}>{createErr}</span>
            </div>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
