import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardPaste, Search, Send, X } from "lucide-react";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { Button, Checkbox, Chip, StatusBadge, toast } from "../components/ui";
import { Select } from "../components/Select";
import { usePageHeader } from "../store/page";
import { useLangValue, useT } from "../lib/i18n";
import { useLeadStatuses } from "../hooks/useLeadStatuses";
import {
  PASTE_ROLES,
  buildRows,
  guessRoles,
  splitPaste,
  type PasteRole,
  type PasteRow,
  type PasteTable,
} from "../lib/pasteParse";

const MAX_ROWS = 500;
const SAMPLE_ROWS = 8;

interface OperatorRow {
  id: number;
  full_name: string;
  working_count: number;
  is_paused?: boolean;
  unavailable_reason?: "paused" | "not_on_shift" | null;
}

interface SheetSource {
  id: number;
  name: string;
  active: boolean;
}

type Kind = "new" | "take" | "keep" | "invalid" | "duplicate";

interface PreviewRow {
  index: number;
  kind: Kind;
  full_name: string;
  phone: string;
  phone_raw: string;
  product_hint: string;
  called_today: boolean;
  lead_id: number | null;
  lead_status: string | null;
  lead_operator_id: number | null;
  lead_operator: string | null;
}

interface PreviewResponse {
  rows: PreviewRow[];
  summary: Record<Kind, number>;
}

interface DistributeResponse {
  total: number;
  created: number;
  taken: number;
  skipped: Record<string, number>;
  assigned: Record<string, number>;
}

const EMPTY: PasteTable = { header: null, rows: [], width: 0 };

function withHeader(table: PasteTable, on: boolean): PasteTable {
  if (on === !!table.header) return table;
  if (on) {
    const [first, ...rest] = table.rows;
    return first ? { ...table, header: first, rows: rest } : table;
  }
  return table.header ? { ...table, header: null, rows: [table.header, ...table.rows] } : table;
}

export default function PasteDistribute() {
  const t = useT();
  const lang = useLangValue();
  const qc = useQueryClient();
  usePageHeader({ title: t("paste.title"), subtitle: t("paste.subtitle") }, ["paste", lang]);

  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<PasteTable>(EMPTY);
  const [headerOn, setHeaderOn] = useState(false);
  const [roles, setRoles] = useState<PasteRole[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [opSearch, setOpSearch] = useState("");
  const [sourceId, setSourceId] = useState<number>(0);
  const [takeExisting, setTakeExisting] = useState(true);
  const [preview, setPreview] = useState<{ sig: string; data: PreviewResponse } | null>(null);
  const [done, setDone] = useState<DistributeResponse | null>(null);

  const table = useMemo(() => withHeader(parsed, headerOn), [parsed, headerOn]);
  const rows: PasteRow[] = useMemo(
    () => buildRows(table, roles).slice(0, MAX_ROWS),
    [table, roles],
  );
  const hasPhone = roles.includes("phone");

  const onText = (value: string) => {
    setText(value);
    setDone(null);
    const next = splitPaste(value);
    setParsed(next);
    setHeaderOn(!!next.header);
    setRoles(guessRoles(next));
  };

  const toggleHeader = (on: boolean) => {
    setHeaderOn(on);
    const next = withHeader(parsed, on);
    setRoles(guessRoles(next));
  };

  const reset = () => {
    setText("");
    setParsed(EMPTY);
    setHeaderOn(false);
    setRoles([]);
    setPreview(null);
    setDone(null);
  };

  const opsQ = useQuery({
    queryKey: ["distribution-status"],
    queryFn: async () => {
      const { data } = await api.get<{ operators: OperatorRow[] }>("/leads/distribution-status/");
      return data;
    },
    refetchInterval: 60_000,
  });
  const sourcesQ = useQuery({
    queryKey: ["sheet-sources"],
    queryFn: async (): Promise<SheetSource[]> => {
      const { data } = await api.get<{ results?: SheetSource[] } | SheetSource[]>("/sheet-sources/");
      return Array.isArray(data) ? data : data.results || [];
    },
  });
  const statusesQ = useLeadStatuses();
  const statusLabel = (code: string | null) => {
    if (!code) return "";
    const row = statusesQ.data?.find((r) => r.code === code);
    if (!row) return code;
    return lang === "uz" && row.label_uz ? row.label_uz : row.label_ru;
  };

  const operators = useMemo(() => {
    const order = (o: OperatorRow) =>
      o.unavailable_reason == null ? 0 : o.unavailable_reason === "paused" ? 1 : 2;
    return [...(opsQ.data?.operators ?? [])].sort(
      (a, b) => order(a) - order(b) || a.full_name.localeCompare(b.full_name),
    );
  }, [opsQ.data]);
  const opById = useMemo(() => new Map(operators.map((o) => [o.id, o])), [operators]);
  const shownOps = useMemo(() => {
    const q = opSearch.trim().toLowerCase();
    return q ? operators.filter((o) => o.full_name.toLowerCase().includes(q)) : operators;
  }, [operators, opSearch]);
  const togglePick = (id: number) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const pickOnShift = () =>
    setPicked(operators.filter((o) => o.unavailable_reason === null).map((o) => o.id));
  const unavailablePicked = picked.filter((id) => {
    const r = opById.get(id)?.unavailable_reason;
    return r === "paused" || r === "not_on_shift";
  }).length;

  const sig = JSON.stringify([rows, picked, takeExisting]);
  const freshPreview = preview && preview.sig === sig ? preview.data : null;

  const previewMut = useMutation({
    mutationFn: () =>
      api.post<PreviewResponse>("/leads/paste/preview/", { rows, operator_ids: picked }),
    onSuccess: (r) => setPreview({ sig, data: r.data }),
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });
  const distributeMut = useMutation({
    mutationFn: () =>
      api.post<DistributeResponse>("/leads/paste/distribute/", {
        rows,
        operator_ids: picked,
        sheet_source_id: sourceId || null,
        take_existing: takeExisting,
      }),
    onSuccess: (r) => {
      setDone(r.data);
      setPreview(null);
      qc.invalidateQueries({ queryKey: ["distribution-status"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["orphan-leads"] });
      qc.invalidateQueries({ queryKey: ["orphan-leads-count"] });
      toast.success(t("paste.toast.done", { n: r.data.total }));
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const willGive = freshPreview
    ? freshPreview.summary.new + (takeExisting ? freshPreview.summary.take : 0)
    : 0;
  const calledToday = freshPreview?.rows.filter((r) => r.called_today && r.kind === "take").length ?? 0;

  const roleOptions = PASTE_ROLES.map((r) => ({ value: r, label: t(`paste.role.${r}`) }));
  const sourceOptions = [
    { value: 0, label: t("paste.source_none") },
    ...(sourcesQ.data ?? [])
      .filter((s) => s.active)
      .map((s) => ({ value: s.id, label: s.name })),
  ];

  if (done) {
    const skipped = Object.values(done.skipped).reduce((a, b) => a + b, 0);
    return (
      <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
        <section className="nf-card p-7 animate-nfFadeUp">
          <div className="text-[20px] font-semibold">{t("paste.done_title", { n: done.total })}</div>
          <div className="text-muted text-[13px] mt-1">
            {t("paste.done_line", { created: done.created, taken: done.taken, skipped })}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {Object.entries(done.assigned)
              .filter(([, n]) => n > 0)
              .map(([id, n]) => (
                <span key={id} className="nf-chip">
                  {opById.get(Number(id))?.full_name ?? `#${id}`}
                  <span className="tabular-nums font-semibold ml-1">{n}</span>
                </span>
              ))}
          </div>
          <div className="mt-6">
            <Button onClick={reset}>
              <ClipboardPaste className="w-3.5 h-3.5" /> {t("paste.again")}
            </Button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* 1. Вставка */}
      <section className="nf-card p-6 animate-nfFadeUp">
        <div className="flex items-center justify-between gap-3">
          <div className="font-semibold">{t("paste.step1")}</div>
          {text && (
            <button className="nf-btn nf-btn--ghost" style={{ padding: "6px 12px" }} onClick={reset}>
              <X className="w-3.5 h-3.5" /> {t("paste.clear")}
            </button>
          )}
        </div>
        <textarea
          className="nf-input font-mono text-[12px] mt-3 w-full"
          rows={text ? 4 : 8}
          value={text}
          placeholder={t("paste.placeholder")}
          onChange={(e) => onText(e.target.value)}
          spellCheck={false}
        />
        {table.width > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
            <span className="text-muted tabular-nums">
              {t("paste.parsed", { rows: table.rows.length, cols: table.width })}
            </span>
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox checked={headerOn} onChange={toggleHeader} />
              {t("paste.header_toggle")}
            </label>
            {table.rows.length > MAX_ROWS && (
              <span style={{ color: "var(--danger)" }}>{t("paste.too_many", { max: MAX_ROWS })}</span>
            )}
          </div>
        )}
      </section>

      {/* 2. Колонки */}
      {table.rows.length > 0 && (
        <section className="nf-card p-6 animate-nfFadeUp">
          <div className="font-semibold">{t("paste.step2")}</div>
          <div className="text-muted text-[12.5px] mt-1">{t("paste.step2_hint")}</div>
          <div className="mt-4 overflow-x-auto">
            <div
              className="grid gap-2 min-w-max"
              style={{ gridTemplateColumns: `repeat(${table.width}, minmax(150px, 1fr))` }}
            >
              {roles.map((role, c) => (
                <div key={`h${c}`} className="flex flex-col gap-1">
                  <Select<PasteRole>
                    value={role}
                    options={roleOptions}
                    onChange={(v) => setRoles((prev) => prev.map((r, i) => (i === c ? v : r)))}
                    ariaLabel={t("paste.step2")}
                  />
                  <div className="text-[11px] text-muted truncate px-1" title={table.header?.[c]}>
                    {table.header?.[c] || " "}
                  </div>
                </div>
              ))}
              {table.rows.slice(0, SAMPLE_ROWS).map((cells, r) =>
                cells.map((v, c) => (
                  <div
                    key={`${r}-${c}`}
                    className="text-[12.5px] truncate px-1 py-1 border-t"
                    style={{
                      borderColor: "var(--border-row)",
                      color: roles[c] === "skip" ? "var(--muted)" : undefined,
                      opacity: roles[c] === "skip" ? 0.55 : 1,
                    }}
                    title={v}
                  >
                    {v || "—"}
                  </div>
                )),
              )}
            </div>
          </div>
          {table.rows.length > SAMPLE_ROWS && (
            <div className="text-muted text-[12px] mt-2">
              {t("paste.more_rows", { n: table.rows.length - SAMPLE_ROWS })}
            </div>
          )}
          {!hasPhone && (
            <div className="mt-3 text-[13px]" style={{ color: "var(--danger)" }}>
              {t("paste.no_phone_col")}
            </div>
          )}
        </section>
      )}

      {/* 3. Операторы */}
      {table.rows.length > 0 && (
        <section className="nf-card p-6 animate-nfFadeUp">
          <div className="flex flex-wrap items-center gap-3">
            <div className="font-semibold">{t("paste.step3")}</div>
            <span className="text-muted text-[13px] tabular-nums">
              {t("paste.ops_selected", { n: picked.length })}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Chip onClick={pickOnShift}>{t("paste.ops_on_shift")}</Chip>
              {picked.length > 0 && <Chip onClick={() => setPicked([])}>{t("paste.ops_clear")}</Chip>}
            </div>
          </div>
          {operators.length > 12 && (
            <div className="relative mt-3 max-w-[320px]">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                className="nf-input w-full"
                style={{ paddingLeft: 32 }}
                value={opSearch}
                placeholder={t("paste.ops_search")}
                onChange={(e) => setOpSearch(e.target.value)}
              />
            </div>
          )}
          <div
            className="mt-3 grid gap-2 max-h-[300px] overflow-y-auto pr-1"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
          >
            {shownOps.map((o) => {
              const on = picked.includes(o.id);
              const reason = o.unavailable_reason;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => togglePick(o.id)}
                  className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-left border"
                  style={{
                    borderColor: on ? "var(--accent)" : "var(--border-row)",
                    background: on ? "var(--faint)" : undefined,
                  }}
                >
                  <span onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={on} onChange={() => togglePick(o.id)} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{o.full_name}</span>
                    <span className="block text-[11.5px] text-muted">
                      {reason === undefined ? null : (
                        <span
                          style={{
                            color: reason == null ? "var(--success, #1f9d55)" : reason === "paused" ? "var(--warning, #b7791f)" : "var(--muted)",
                          }}
                        >
                          {t(reason == null ? "paste.op.on_shift" : `paste.op.${reason}`)}
                          {" · "}
                        </span>
                      )}
                      {t("paste.op.working", { n: o.working_count })}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {unavailablePicked > 0 && (
            <div className="mt-3 text-[12.5px]" style={{ color: "var(--warning, #b7791f)" }}>
              {t("paste.warn_unavailable", { n: unavailablePicked })}
            </div>
          )}
          <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-4">
            <div className="flex flex-col gap-1.5 min-w-[260px]">
              <span className="text-[12px] text-muted">{t("paste.source")}</span>
              <Select<number>
                value={sourceId}
                options={sourceOptions}
                onChange={setSourceId}
                searchable={sourceOptions.length > 8}
                ariaLabel={t("paste.source")}
              />
            </div>
            <label className="flex items-start gap-2.5 cursor-pointer max-w-[520px]">
              <Checkbox checked={takeExisting} onChange={setTakeExisting} />
              <span>
                <span className="block text-[13px] font-medium">{t("paste.take_existing")}</span>
                <span className="block text-[12px] text-muted">{t("paste.take_existing_hint")}</span>
              </span>
            </label>
          </div>
          <div className="mt-5">
            <Button
              disabled={!hasPhone || picked.length === 0 || rows.length === 0 || previewMut.isPending}
              onClick={() => previewMut.mutate()}
              variant={freshPreview ? "secondary" : "primary"}
            >
              {t("paste.check")}
            </Button>
            {preview && !freshPreview && (
              <span className="ml-3 text-[12.5px] text-muted">{t("paste.recheck")}</span>
            )}
          </div>
        </section>
      )}

      {/* 4. Что будет */}
      {freshPreview && (
        <section className="nf-card overflow-hidden animate-nfFadeUp">
          <div className="p-6 pb-3">
            <div className="font-semibold">{t("paste.step4")}</div>
            <div className="mt-3 flex flex-wrap gap-2 text-[12.5px]">
              {(["new", "take", "keep", "invalid", "duplicate"] as Kind[])
                .filter((k) => freshPreview.summary[k] > 0)
                .map((k) => (
                  <StatusBadge key={k} tone={k === "invalid" ? "danger" : k === "take" ? "hot" : "neutral"}>
                    {t(`paste.sum.${k}`, { n: freshPreview.summary[k] })}
                  </StatusBadge>
                ))}
              {calledToday > 0 && (
                <StatusBadge tone="danger">{t("paste.sum.called_today", { n: calledToday })}</StatusBadge>
              )}
            </div>
          </div>
          <div
            className="grid gap-2 px-6 pb-2 nf-col items-center"
            style={{ gridTemplateColumns: "44px 1.3fr 1fr 1.6fr" }}
          >
            <div>#</div>
            <div>{t("paste.col.lead")}</div>
            <div>{t("paste.col.product")}</div>
            <div>{t("paste.col.result")}</div>
          </div>
          <div className="max-h-[460px] overflow-y-auto">
            {freshPreview.rows.map((r) => {
              let label: string;
              if (r.kind === "take") {
                const who = r.lead_operator ?? t("paste.kind.take_pool");
                label = takeExisting
                  ? r.lead_operator
                    ? t("paste.kind.take", { op: who })
                    : t("paste.kind.take_pool")
                  : t("paste.kind.take_off", { op: who });
              } else if (r.kind === "keep") {
                label = t("paste.kind.keep", { op: r.lead_operator ?? "" });
              } else {
                label = t(`paste.kind.${r.kind}`);
              }
              const dim = r.kind === "invalid" || r.kind === "duplicate" || r.kind === "keep" || (r.kind === "take" && !takeExisting);
              return (
                <div
                  key={r.index}
                  className="nf-row"
                  style={{ gridTemplateColumns: "44px 1.3fr 1fr 1.6fr", opacity: dim ? 0.6 : 1 }}
                >
                  <div className="text-muted tabular-nums text-[12px]">{r.index + 1}</div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.full_name || "—"}</div>
                    <div
                      className="text-[12px] truncate"
                      style={{ color: r.kind === "invalid" ? "var(--danger)" : "var(--muted)" }}
                    >
                      {r.phone || r.phone_raw || "—"}
                    </div>
                  </div>
                  <div className="truncate text-[12.5px]">{r.product_hint || "—"}</div>
                  <div className="min-w-0 text-[12.5px]">
                    <span style={{ color: r.kind === "invalid" ? "var(--danger)" : undefined }}>{label}</span>
                    {r.lead_status && (r.kind === "take" || r.kind === "keep") && (
                      <span className="text-muted"> · {statusLabel(r.lead_status)}</span>
                    )}
                    {r.called_today && (
                      <span style={{ color: "var(--danger)" }}> · {t("paste.called_today")}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="p-6 pt-4 flex items-center gap-3 border-t" style={{ borderColor: "var(--border-row)" }}>
            <Button disabled={willGive === 0 || distributeMut.isPending} onClick={() => distributeMut.mutate()}>
              <Send className="w-3.5 h-3.5" /> {willGive > 0 ? t("paste.distribute", { n: willGive }) : t("paste.nothing")}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
