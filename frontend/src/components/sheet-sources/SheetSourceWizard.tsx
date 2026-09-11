/**
 * 3-step «connect a Google Sheet» wizard.
 *
 * Step 1 — paste URL, hit "Проверить" → POST /sheet-sources/preview/
 *          reads headers + a 10-row sample without touching the DB.
 * Step 2 — map wizard-suggested headers onto Lead fields
 *          (phone / full_name / product_hint / has_card / extra_phone).
 * Step 3 — writeback layout + distribution mode + name → POST
 *          /sheet-sources/ (upserts by (spreadsheet_id, gid)) and offers
 *          an immediate sync-now.
 *
 * On any step the user can navigate back — preview state is kept in
 * component state so re-editing doesn't re-fetch the sheet.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { X, ArrowLeft, ArrowRight, Loader2, Check } from "lucide-react";
import { api } from "../../lib/api";
import { Button, Modal, toast } from "../ui";
import { Select } from "../Select";
import { useT } from "../../lib/i18n";

type PreviewResponse = {
  spreadsheet_id: string;
  gid: number;
  sheet_title: string;
  headers: string[];
  sample_rows: string[][];
  total_rows: number;
  suggested_column_map: {
    phone: string | null;
    full_name: string | null;
    product_hint: string | null;
    has_card: string | null;
    extra_phone: string | null;
  };
  suggested_writeback: {
    status_col: string | null;
    operator_col: string | null;
    updated_at_col: string | null;
    comment_col: string | null;
  };
  already_connected: { id: number; name: string } | null;
};

type DistributionMode =
  | "alias_only"
  | "alias_or_default"
  | "default_only"
  | "alias_or_rr";

type Operator = { id: number; full_name: string; status: string };

type Props = {
  operators: Operator[];
  onClose: () => void;
  onDone: (createdId: number) => void;
};

const DISTRIBUTION_LABEL: Record<DistributionMode, string> = {
  alias_only: "sheet_src.mode_alias_only",
  alias_or_default: "sheet_src.mode_alias_or_default",
  default_only: "sheet_src.mode_default_only",
  alias_or_rr: "sheet_src.mode_alias_or_rr",
};

// column letters A..ZZ for writeback dropdowns
const COL_LETTERS: string[] = (() => {
  const out: string[] = [];
  for (let i = 1; i <= 26; i++) out.push(String.fromCharCode(64 + i));
  for (let a = 1; a <= 26; a++)
    for (let b = 1; b <= 26; b++)
      out.push(String.fromCharCode(64 + a) + String.fromCharCode(64 + b));
  return out;
})();

export function SheetSourceWizard({ operators, onClose, onDone }: Props) {
  const t = useT();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState("");

  // step 2 state (initialised when preview arrives)
  const [mapPhone, setMapPhone] = useState<string>("");
  const [mapFullName, setMapFullName] = useState<string>("");
  const [mapProductHint, setMapProductHint] = useState<string>("");
  const [mapHasCard, setMapHasCard] = useState<string>("");
  const [mapExtraPhone, setMapExtraPhone] = useState<string>("");

  // step 3 state
  const [name, setName] = useState("");
  const [writebackEnabled, setWritebackEnabled] = useState(false);
  const [wbStatus, setWbStatus] = useState("");
  const [wbOperator, setWbOperator] = useState("");
  const [wbUpdated, setWbUpdated] = useState("");
  const [wbComment, setWbComment] = useState("");
  const [distributionMode, setDistributionMode] =
    useState<DistributionMode>("alias_or_rr");
  const [defaultOperator, setDefaultOperator] = useState<string>("");
  const [defaultStatus, setDefaultStatus] = useState("new");
  const [createError, setCreateError] = useState("");

  const previewMut = useMutation({
    mutationFn: async () => {
      const r = await api.post<PreviewResponse>("/sheet-sources/preview/", {
        spreadsheet_url: url.trim(),
      });
      return r.data;
    },
    onSuccess: (d) => {
      setPreview(d);
      setPreviewError("");
      // pre-fill step-2 state from suggestions
      setMapPhone(d.suggested_column_map.phone || "");
      setMapFullName(d.suggested_column_map.full_name || "");
      setMapProductHint(d.suggested_column_map.product_hint || "");
      setMapHasCard(d.suggested_column_map.has_card || "");
      setMapExtraPhone(d.suggested_column_map.extra_phone || "");
      // pre-fill step-3
      setName(d.sheet_title || "");
      setWbStatus(d.suggested_writeback.status_col || "D");
      setWbOperator(d.suggested_writeback.operator_col || "E");
      setWbUpdated(d.suggested_writeback.updated_at_col || "F");
      setWbComment(d.suggested_writeback.comment_col || "G");
      // if any writeback slot was suggested, default the toggle to on
      setWritebackEnabled(
        Object.values(d.suggested_writeback).some((v) => !!v),
      );
      if (d.already_connected) {
        setPreviewError(
          t("sheet_src.wizard.already_connected", {
            name: d.already_connected.name,
          }),
        );
      }
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setPreviewError(e?.response?.data?.detail || e?.message || t("common.error"));
      setPreview(null);
    },
  });

  const createMut = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error("no preview");
      const columnMap: Record<string, string> = {};
      if (mapPhone) columnMap.phone = mapPhone;
      if (mapFullName) columnMap.full_name = mapFullName;
      if (mapProductHint) columnMap.product_hint = mapProductHint;
      if (mapHasCard) columnMap.has_card = mapHasCard;
      if (mapExtraPhone) columnMap.extra_phone = mapExtraPhone;

      const body = {
        name: name.trim() || preview.sheet_title || "New source",
        spreadsheet_id: preview.spreadsheet_id,
        gid: preview.gid,
        worksheet_name: preview.sheet_title,
        column_map: columnMap,
        default_status: defaultStatus,
        active: true,
        default_operator: defaultOperator ? Number(defaultOperator) : null,
        distribution_mode: distributionMode,
        writeback_columns: {
          enabled: writebackEnabled,
          status_col: (wbStatus || "").toUpperCase() || "D",
          operator_col: (wbOperator || "").toUpperCase() || "E",
          updated_col: (wbUpdated || "").toUpperCase() || "F",
          comment_col: (wbComment || "").toUpperCase() || "G",
        },
      };
      const r = await api.post<{ id: number }>("/sheet-sources/", body);
      return r.data;
    },
    onSuccess: async (data) => {
      // Ask if user wants an immediate sync.
      // We keep the modal open on step 3 with a success flag so the user
      // can choose without a second modal.
      toast.success(t("sheet_src.wizard.connected"));
      // fire sync-now — best effort, ignore cooldown/errors
      try {
        const r = await api.post<{ imported?: number; created?: number }>(
          `/sheet-sources/${data.id}/sync-now/`,
        );
        const d = r.data;
        toast.success(
          t("sheet_src.wizard.sync_ok", {
            n: String(d.created ?? d.imported ?? 0),
          }),
        );
      } catch (err) {
        const e = err as { response?: { data?: { detail?: string } } };
        toast.error(
          e?.response?.data?.detail || t("sheet_src.wizard.sync_failed"),
        );
      }
      onDone(data.id);
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setCreateError(e?.response?.data?.detail || e?.message || t("common.error"));
    },
  });

  const headers = preview?.headers || [];
  const headerOpts = [
    { value: "", label: t("sheet_src.wizard.column_none") },
    ...headers.filter((h) => !!h).map((h) => ({ value: h, label: h })),
  ];
  const colLetterOpts = COL_LETTERS.map((c) => ({ value: c, label: c }));

  const canGoStep2 = !!preview && preview.headers.length > 0;
  const canGoStep3 = canGoStep2 && !!mapPhone && !!mapFullName;

  return (
    <Modal open onClose={onClose} width={780}>
      <div className="p-7">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-[18px] font-semibold tracking-tight">
              {t("sheet_src.wizard.title")}
            </div>
            <div className="text-[12px] text-muted mt-0.5">
              {t("sheet_src.wizard.step_label", { n: String(step), total: "3" })}
            </div>
          </div>
          <button
            onClick={onClose}
            className="grid place-items-center rounded-full hover:bg-[color:var(--faint)] transition"
            style={{ width: 32, height: 32 }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* stepper */}
        <div className="flex items-center gap-2 mb-5 text-[12px]">
          {[1, 2, 3].map((n) => (
            <div key={n} className="flex items-center gap-2">
              <div
                className="rounded-full grid place-items-center"
                style={{
                  width: 22,
                  height: 22,
                  background:
                    step >= n ? "var(--accent)" : "var(--faint)",
                  color: step >= n ? "white" : "var(--muted)",
                  fontSize: 11,
                }}
              >
                {step > n ? <Check className="w-3 h-3" /> : n}
              </div>
              {n < 3 && (
                <div
                  style={{
                    width: 40,
                    height: 2,
                    background: step > n ? "var(--accent)" : "var(--faint)",
                    borderRadius: 2,
                  }}
                />
              )}
            </div>
          ))}
        </div>

        {/* ---- Step 1 ---- */}
        {step === 1 && (
          <div className="flex flex-col gap-3">
            <div>
              <div className="nf-col mb-1.5">
                {t("sheet_src.wizard.url_label")}
              </div>
              <textarea
                className="nf-input font-mono text-[12px]"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                rows={3}
                placeholder="https://docs.google.com/spreadsheets/d/…/edit?gid=0"
                autoFocus
              />
              <div className="text-[11.5px] text-muted mt-1">
                {t("sheet_src.wizard.url_hint")}
              </div>
            </div>
            <div>
              <Button
                onClick={() => previewMut.mutate()}
                disabled={previewMut.isPending || !url.trim()}
              >
                {previewMut.isPending && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                )}
                {t("sheet_src.wizard.check_btn")}
              </Button>
            </div>
            {previewError && (
              <div
                className="text-[13px] rounded-xl px-3.5 py-2.5"
                style={{ background: "rgba(220,60,40,.08)", color: "var(--danger)" }}
              >
                {previewError}
              </div>
            )}
            {preview && (
              <div className="mt-2 rounded-xl border p-4" style={{ borderColor: "var(--border)" }}>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="font-semibold text-[14px]">
                      {preview.sheet_title}
                    </div>
                    <div className="text-[11.5px] text-muted">
                      {t("sheet_src.wizard.rows_found", {
                        n: String(preview.total_rows),
                      })}
                    </div>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="text-[11.5px] w-full">
                    <thead>
                      <tr>
                        {preview.headers.map((h, i) => (
                          <th
                            key={i}
                            className="text-left px-2 py-1 border-b whitespace-nowrap font-semibold"
                            style={{ borderColor: "var(--border)" }}
                          >
                            {h || <span className="text-muted">—</span>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample_rows.map((r, ri) => (
                        <tr key={ri}>
                          {r.map((c, ci) => (
                            <td
                              key={ci}
                              className="px-2 py-1 border-b truncate max-w-[180px]"
                              style={{ borderColor: "var(--border)" }}
                            >
                              {c || ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---- Step 2 ---- */}
        {step === 2 && preview && (
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 text-[12.5px] text-muted">
              {t("sheet_src.wizard.map_hint")}
            </div>
            <div>
              <div className="nf-col mb-1.5">
                {t("sheet_src.wizard.map_phone")} <span style={{ color: "var(--danger)" }}>*</span>
              </div>
              <Select<string>
                value={mapPhone}
                onChange={setMapPhone}
                options={headerOpts}
                searchable
                ariaLabel="phone"
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">
                {t("sheet_src.wizard.map_full_name")} <span style={{ color: "var(--danger)" }}>*</span>
              </div>
              <Select<string>
                value={mapFullName}
                onChange={setMapFullName}
                options={headerOpts}
                searchable
                ariaLabel="full_name"
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("sheet_src.wizard.map_product_hint")}</div>
              <Select<string>
                value={mapProductHint}
                onChange={setMapProductHint}
                options={headerOpts}
                searchable
                ariaLabel="product_hint"
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("sheet_src.wizard.map_has_card")}</div>
              <Select<string>
                value={mapHasCard}
                onChange={setMapHasCard}
                options={headerOpts}
                searchable
                ariaLabel="has_card"
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("sheet_src.wizard.map_extra_phone")}</div>
              <Select<string>
                value={mapExtraPhone}
                onChange={setMapExtraPhone}
                options={headerOpts}
                searchable
                ariaLabel="extra_phone"
              />
            </div>
          </div>
        )}

        {/* ---- Step 3 ---- */}
        {step === 3 && preview && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="nf-col mb-1.5">{t("sheet_src.field_name")}</div>
              <input
                className="nf-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("sheet_src.field_default_status")}</div>
              <Select<string>
                value={defaultStatus}
                onChange={setDefaultStatus}
                options={[
                  { value: "new", label: "new" },
                  { value: "archived", label: "archived" },
                  { value: "needs_review", label: "needs_review" },
                ]}
                ariaLabel="default_status"
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("sheet_src.field_mode")}</div>
              <Select<DistributionMode>
                value={distributionMode}
                onChange={setDistributionMode}
                options={(
                  ["alias_only", "alias_or_default", "default_only", "alias_or_rr"] as DistributionMode[]
                ).map((m) => ({
                  value: m,
                  label: t(DISTRIBUTION_LABEL[m]),
                }))}
                ariaLabel="mode"
              />
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("sheet_src.field_default_op")}</div>
              <Select<string>
                value={defaultOperator}
                onChange={setDefaultOperator}
                options={[
                  { value: "", label: t("sheet_src.option_none") },
                  ...operators.map((o) => ({
                    value: String(o.id),
                    label: o.full_name,
                  })),
                ]}
                searchable={operators.length > 8}
                ariaLabel="default_op"
              />
            </div>
            <div className="col-span-2 rounded-xl border p-4" style={{ borderColor: "var(--border)" }}>
              <label className="flex items-center gap-2 text-[13.5px] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={writebackEnabled}
                  onChange={(e) => setWritebackEnabled(e.target.checked)}
                />
                {t("sheet_src.wizard.writeback_toggle")}
              </label>
              {writebackEnabled && (
                <div className="grid grid-cols-4 gap-3 mt-3">
                  <div>
                    <div className="nf-col mb-1">{t("sheet_src.wb_status_col")}</div>
                    <Select<string>
                      value={wbStatus}
                      onChange={setWbStatus}
                      options={colLetterOpts}
                      searchable
                      ariaLabel="status_col"
                    />
                  </div>
                  <div>
                    <div className="nf-col mb-1">{t("sheet_src.wb_operator_col")}</div>
                    <Select<string>
                      value={wbOperator}
                      onChange={setWbOperator}
                      options={colLetterOpts}
                      searchable
                      ariaLabel="operator_col"
                    />
                  </div>
                  <div>
                    <div className="nf-col mb-1">{t("sheet_src.wb_updated_col")}</div>
                    <Select<string>
                      value={wbUpdated}
                      onChange={setWbUpdated}
                      options={colLetterOpts}
                      searchable
                      ariaLabel="updated_col"
                    />
                  </div>
                  <div>
                    <div className="nf-col mb-1">{t("sheet_src.wb_comment_col")}</div>
                    <Select<string>
                      value={wbComment}
                      onChange={setWbComment}
                      options={colLetterOpts}
                      searchable
                      ariaLabel="comment_col"
                    />
                  </div>
                </div>
              )}
              <div className="text-[11.5px] text-muted mt-2">
                {t("sheet_src.writeback_hint")}
              </div>
            </div>
            {createError && (
              <div
                className="col-span-2 text-[13px] rounded-xl px-3.5 py-2.5"
                style={{ background: "rgba(220,60,40,.08)", color: "var(--danger)" }}
              >
                {createError}
              </div>
            )}
          </div>
        )}

        {/* footer */}
        <div className="mt-6 flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => (step > 1 ? setStep((step - 1) as 1 | 2 | 3) : onClose())}
          >
            {step > 1 ? (
              <>
                <ArrowLeft className="w-3.5 h-3.5" />
                {t("common.back")}
              </>
            ) : (
              t("common.cancel")
            )}
          </Button>
          {step < 3 ? (
            <Button
              onClick={() => setStep((step + 1) as 1 | 2 | 3)}
              disabled={step === 1 ? !canGoStep2 : !canGoStep3}
            >
              {t("common.next")}
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          ) : (
            <Button
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
            >
              {createMut.isPending && (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              )}
              {t("sheet_src.wizard.connect_btn")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
