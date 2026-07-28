/**
 * Admin CRUD for `SheetSource` (per-worksheet column mapping) and
 * `OperatorSheetAlias` (sheet alias → real operator binding).
 */

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { api } from "../lib/api";
import {
  Button,
  Modal,
  StatusBadge,
  TabPill,
  toast,
  type TabItem,
} from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

type DistributionMode =
  | "alias_only"
  | "alias_or_default"
  | "default_only"
  | "alias_or_rr";

type SheetSource = {
  id: number;
  name: string;
  spreadsheet_id: string;
  gid: number;
  worksheet_name: string;
  column_map: Record<string, unknown>;
  default_status: string;
  active: boolean;
  last_synced_at: string | null;
  last_synced_row: number;
  default_operator: number | null;
  default_operator_name: string | null;
  distribution_mode: DistributionMode;
};

const DISTRIBUTION_KEY: Record<DistributionMode, string> = {
  alias_only: "sheet_src.mode_alias_only",
  alias_or_default: "sheet_src.mode_alias_or_default",
  default_only: "sheet_src.mode_default_only",
  alias_or_rr: "sheet_src.mode_alias_or_rr",
};

type Alias = {
  id: number;
  alias_name: string;
  operator: number | null;
  operator_name: string | null;
};

type Operator = { id: number; full_name: string; status: string };
type TabKey = "sources" | "aliases";

export default function SheetSources() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("sources");
  const t = useT();

  const TABS: TabItem<TabKey>[] = [
    { value: "sources", label: t("sheet_src.tab_sources") },
    { value: "aliases", label: t("sheet_src.tab_aliases") },
  ];

  usePageHeader({
    title: t("sheet_src.title"),
    subtitle: t("sheet_src.subtitle"),
  });

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      <div className="animate-nfFadeUp">
        <TabPill value={tab} onChange={setTab} items={TABS} />
      </div>
      {tab === "sources" ? <SheetSourcesPanel qc={qc} /> : <AliasesPanel qc={qc} />}
    </div>
  );
}

// -------- Sheet sources -----------------------------------------------------

function SheetSourcesPanel({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const t = useT();
  const q = useQuery({
    queryKey: ["sheet-sources"],
    queryFn: () =>
      api
        .get<SheetSource[] | { results?: SheetSource[] }>("/sheet-sources/")
        .then((r) => (Array.isArray(r.data) ? r.data : r.data.results || [])),
  });

  const ops = useQuery({
    queryKey: ["operators-active"],
    queryFn: () =>
      api
        .get<Operator[] | { results?: Operator[] }>("/operators/?include_inactive=0")
        .then((r) => (Array.isArray(r.data) ? r.data : r.data.results || [])),
  });

  const [edit, setEdit] = useState<SheetSource | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const items = q.data || [];
  const gridCols = "1.1fr 1.1fr .5fr .8fr 1fr .8fr .6fr";

  return (
    <>
      <div className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px] text-muted">{t("sheet_src.total", { n: items.length })}</div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="w-3.5 h-3.5" /> {t("sheet_src.add")}
        </Button>
      </div>
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: gridCols }}
        >
          <div>{t("sheet_src.col_name")}</div>
          <div>{t("sheet_src.col_spreadsheet")}</div>
          <div>{t("sheet_src.col_gid")}</div>
          <div>{t("sheet_src.col_default_op")}</div>
          <div>{t("sheet_src.col_mode_short")}</div>
          <div>{t("sheet_src.col_last_row")}</div>
          <div className="text-right">{t("sheet_src.col_actions")}</div>
        </div>
        {items.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("sheet_src.empty")}
          </div>
        ) : (
          <div>
            {items.map((src, i) => (
              <div
                key={src.id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: gridCols,
                  animationDelay: `${0.02 + i * 0.035}s`,
                  cursor: "default",
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium truncate">{src.name}</span>
                  {!src.active && (
                    <StatusBadge tone="neutral">{t("sheet_src.off")}</StatusBadge>
                  )}
                </div>
                <div className="font-mono text-[12px] text-muted truncate">
                  {src.spreadsheet_id}
                </div>
                <div className="font-mono text-[12px] text-muted tabular-nums">
                  {src.gid}
                </div>
                <div className="text-[13px] truncate">
                  {src.default_operator_name || (
                    <span className="text-muted">—</span>
                  )}
                </div>
                <div className="text-[12px]">
                  <StatusBadge tone="neutral">
                    {DISTRIBUTION_KEY[src.distribution_mode]
                      ? t(DISTRIBUTION_KEY[src.distribution_mode])
                      : src.distribution_mode}
                  </StatusBadge>
                </div>
                <div>
                  <div className="tabular-nums">#{src.last_synced_row}</div>
                  {src.last_synced_at && (
                    <div className="text-[11px] text-muted">
                      {new Date(src.last_synced_at).toLocaleString("ru-RU")}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <button
                    className="nf-btn nf-btn--ghost"
                    style={{ padding: "7px 12px", fontSize: 12 }}
                    onClick={() => setEdit(src)}
                  >
                    {t("common.edit")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {(edit || showCreate) && (
        <SheetSourceForm
          value={edit}
          operators={ops.data || []}
          onClose={() => {
            setEdit(null);
            setShowCreate(false);
          }}
          onDone={() => {
            setEdit(null);
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ["sheet-sources"] });
            toast.success(t("toast.saved"));
          }}
        />
      )}
    </>
  );
}

function SheetSourceForm({
  value,
  operators,
  onClose,
  onDone,
}: {
  value: SheetSource | null;
  operators: Operator[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const isEdit = !!value;
  const [name, setName] = useState(value?.name || "");
  const [ss, setSs] = useState(value?.spreadsheet_id || "");
  const [gid, setGid] = useState(String(value?.gid || ""));
  const [ws, setWs] = useState(value?.worksheet_name || "");
  const [defaultStatus, setDefaultStatus] = useState(value?.default_status || "new");
  const [active, setActive] = useState(value?.active ?? true);
  const [defaultOperator, setDefaultOperator] = useState<string>(
    value?.default_operator ? String(value.default_operator) : "",
  );
  const [distributionMode, setDistributionMode] = useState<DistributionMode>(
    value?.distribution_mode || "alias_only",
  );
  const [mapJson, setMapJson] = useState(
    JSON.stringify(value?.column_map || {}, null, 2),
  );
  const [error, setError] = useState("");

  const modes: DistributionMode[] = [
    "alias_only",
    "alias_or_default",
    "default_only",
    "alias_or_rr",
  ];

  const mut = useMutation({
    mutationFn: async () => {
      let columnMap: unknown;
      try {
        columnMap = JSON.parse(mapJson);
      } catch {
        throw new Error(t("sheet_src.map_invalid"));
      }
      const body = {
        name,
        spreadsheet_id: ss,
        gid: Number(gid),
        worksheet_name: ws,
        column_map: columnMap,
        default_status: defaultStatus,
        active,
        default_operator: defaultOperator ? Number(defaultOperator) : null,
        distribution_mode: distributionMode,
      };
      if (isEdit) await api.patch(`/sheet-sources/${value!.id}/`, body);
      else await api.post("/sheet-sources/", body);
    },
    onSuccess: onDone,
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail || e?.message || t("common.error"));
    },
  });

  return (
    <Modal open onClose={onClose} width={640}>
      <div className="p-7">
        <div className="flex items-start justify-between mb-4">
          <div className="text-[18px] font-semibold tracking-tight">
            {isEdit ? t("sheet_src.form_edit") : t("sheet_src.form_new")}
          </div>
          <button
            onClick={onClose}
            className="grid place-items-center rounded-full hover:bg-[color:var(--faint)] transition"
            style={{ width: 32, height: 32 }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("sheet_src.field_name")}>
            <input
              className="nf-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t("sheet_src.field_default_status")}>
            <select
              className="nf-input"
              value={defaultStatus}
              onChange={(e) => setDefaultStatus(e.target.value)}
            >
              <option value="new">new</option>
              <option value="archived">archived</option>
              <option value="needs_review">needs_review</option>
            </select>
          </Field>
          <div className="col-span-2">
            <Field label={t("sheet_src.field_spreadsheet_id")}>
              <input
                className="nf-input font-mono"
                value={ss}
                onChange={(e) => setSs(e.target.value)}
              />
            </Field>
          </div>
          <Field label={t("sheet_src.field_gid")}>
            <input
              className="nf-input font-mono"
              value={gid}
              onChange={(e) => setGid(e.target.value)}
            />
          </Field>
          <Field label={t("sheet_src.field_ws")}>
            <input
              className="nf-input"
              value={ws}
              onChange={(e) => setWs(e.target.value)}
            />
          </Field>
          <div className="col-span-2">
            <Field label={t("sheet_src.field_map")}>
              <textarea
                className="nf-input font-mono text-[12px] min-h-[220px]"
                value={mapJson}
                onChange={(e) => setMapJson(e.target.value)}
                placeholder='{"full_name": "full_name", "phone": "phone_number"}'
              />
            </Field>
          </div>
          <Field label={t("sheet_src.field_default_op")}>
            <select
              className="nf-input"
              value={defaultOperator}
              onChange={(e) => setDefaultOperator(e.target.value)}
            >
              <option value="">{t("sheet_src.option_none")}</option>
              {operators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.full_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("sheet_src.field_mode")}>
            <select
              className="nf-input"
              value={distributionMode}
              onChange={(e) =>
                setDistributionMode(e.target.value as DistributionMode)
              }
            >
              {modes.map((m) => (
                <option key={m} value={m}>
                  {t(DISTRIBUTION_KEY[m])}
                </option>
              ))}
            </select>
          </Field>
          <div className="col-span-2 text-[12px] text-muted">
            {distributionMode === "alias_only" &&
              t("sheet_src.mode_hint_alias_only")}
            {distributionMode === "alias_or_default" &&
              t("sheet_src.mode_hint_alias_or_default")}
            {distributionMode === "default_only" &&
              t("sheet_src.mode_hint_default_only")}
            {distributionMode === "alias_or_rr" &&
              t("sheet_src.mode_hint_alias_or_rr")}
          </div>
          <div className="col-span-2 flex items-center gap-2 text-[13.5px]">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              id="active"
            />
            <label htmlFor="active">{t("sheet_src.active_hint")}</label>
          </div>
        </div>
        {error && (
          <div
            className="mt-4 text-[13px] rounded-xl px-3.5 py-2.5"
            style={{ background: "rgba(220,60,40,.08)", color: "var(--danger)" }}
          >
            {error}
          </div>
        )}
        <div className="mt-6 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------- Aliases ----------------------------------------------------------

function AliasesPanel({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const t = useT();
  const q = useQuery({
    queryKey: ["operator-sheet-aliases"],
    queryFn: () =>
      api
        .get<Alias[] | { results?: Alias[] }>("/operator-sheet-aliases/")
        .then((r) => (Array.isArray(r.data) ? r.data : r.data.results || [])),
  });
  const ops = useQuery({
    queryKey: ["operators-active"],
    queryFn: () =>
      api
        .get<Operator[] | { results?: Operator[] }>("/operators/?include_inactive=0")
        .then((r) => (Array.isArray(r.data) ? r.data : r.data.results || [])),
  });
  const [creating, setCreating] = useState(false);
  const items = q.data || [];
  const unboundCount = items.filter((a) => !a.operator).length;

  const bind = async (alias: Alias, operatorId: number | null) => {
    await api.patch(`/operator-sheet-aliases/${alias.id}/`, { operator: operatorId });
    qc.invalidateQueries({ queryKey: ["operator-sheet-aliases"] });
    toast.success(t("sheet_src.bound"));
  };

  return (
    <>
      <div className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px]">
          {unboundCount > 0 ? (
            <span style={{ color: "var(--accent)" }} className="font-semibold">
              {t("sheet_src.aliases_unbound", { n: unboundCount })}
            </span>
          ) : (
            <span className="text-muted">{t("sheet_src.aliases_total", { n: items.length })}</span>
          )}
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="w-3.5 h-3.5" /> {t("sheet_src.aliases_add")}
        </Button>
      </div>
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: "1fr 1.2fr" }}
        >
          <div>{t("sheet_src.aliases_col_alias")}</div>
          <div>{t("sheet_src.aliases_col_op")}</div>
        </div>
        {items.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("sheet_src.aliases_empty")}
          </div>
        ) : (
          <div>
            {items.map((a, i) => (
              <div
                key={a.id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: "1fr 1.2fr",
                  animationDelay: `${0.02 + i * 0.035}s`,
                  cursor: "default",
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{a.alias_name}</span>
                  {!a.operator && (
                    <StatusBadge tone="hot">{t("sheet_src.aliases_unbound_badge")}</StatusBadge>
                  )}
                </div>
                <div>
                  <select
                    className="nf-input py-1.5 px-3 text-[13px]"
                    value={a.operator || ""}
                    onChange={(e) =>
                      bind(a, e.target.value ? Number(e.target.value) : null)
                    }
                  >
                    <option value="">{t("sheet_src.aliases_none")}</option>
                    {(ops.data || []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.full_name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {creating && (
        <NewAliasModal
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ["operator-sheet-aliases"] });
            toast.success(t("sheet_src.alias_created"));
          }}
        />
      )}
    </>
  );
}

function NewAliasModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      await api.post("/operator-sheet-aliases/", { alias_name: name });
    },
    onSuccess: onDone,
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail || e?.message || t("common.error"));
    },
  });

  return (
    <Modal open onClose={onClose} width={440}>
      <div className="p-7">
        <div className="text-[18px] font-semibold tracking-tight">{t("sheet_src.alias_new_title")}</div>
        <div className="mt-5">
          <div className="nf-col mb-1.5">{t("sheet_src.alias_new_field")}</div>
          <input
            className="nf-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        {error && (
          <div
            className="mt-3 text-[13px] rounded-xl px-3.5 py-2.5"
            style={{ background: "rgba(220,60,40,.08)", color: "var(--danger)" }}
          >
            {error}
          </div>
        )}
        <div className="mt-6 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !name.trim()}
          >
            {mut.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="nf-col mb-1.5">{label}</div>
      {children}
    </div>
  );
}
