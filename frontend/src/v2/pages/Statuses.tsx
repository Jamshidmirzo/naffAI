import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "../../components/ui";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, useConfirm } from "../ui";
import {
  useSetLeadStatusDelete,
  useSetLeadStatusSave,
  useSetLeadStatuses,
  type SetLeadStatusRow,
  type SetLeadStatusTone,
} from "../api/admin";
import { SettingsLayout } from "./Settings";

const TONES: Array<{ v: SetLeadStatusTone; badge: string; sw: string }> = [
  { v: "neutral", badge: "", sw: "var(--ink-4)" },
  { v: "info", badge: "b-info", sw: "var(--brand)" },
  { v: "hot", badge: "b-hot", sw: "var(--hot-solid)" },
  { v: "success", badge: "b-ok", sw: "var(--ok-solid)" },
  { v: "danger", badge: "b-bad", sw: "var(--bad-solid)" },
];
const toneOf = (v: SetLeadStatusTone) => TONES.find((x) => x.v === v) ?? TONES[0];

const COLS = "48px minmax(220px,1.9fr) minmax(90px,0.9fr) 110px 52px 64px 64px 36px";

/** Same transliterating slug as the old page (code auto-filled from the RU label). */
function slugify(s: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m",
    н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9а-яё\s_]+/gi, "")
    .replace(/[а-яё]/g, (c) => map[c] || "")
    .replace(/\s+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
}

export default function Statuses() {
  const t = useT2();
  const q = useSetLeadStatuses();
  const del = useSetLeadStatusDelete();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<SetLeadStatusRow | null>(null);
  const [creating, setCreating] = useState(false);

  const rows = useMemo(() => (q.data ?? []).slice().sort((a, b) => a.sort_order - b.sort_order), [q.data]);
  const yesNo = (v: boolean) => (v ? "✓" : "—");

  const askDelete = async (r: SetLeadStatusRow) => {
    const ok = await confirm({
      title: t("v2.admin.statuses.deleteTitle", { name: r.label_ru }),
      body: t("v2.admin.statuses.deleteBody", { code: r.code }),
      confirm: t("v2.admin.statuses.deleteBtn"),
      danger: true,
    });
    if (!ok) return;
    del.mutate(r.id, {
      onSuccess: () => toast.success(t("lead_statuses.deleted")),
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  return (
    <>
      <PageHeader title={t("settings.title")}>
        <span className="s c3">{t("v2.admin.statuses.meta")}</span>
      </PageHeader>
      <main className="page">
        <SettingsLayout maxWidth={1100}>
          <section className="card tbl">
            <div className="card-h">
              <div className="col">
                <span className="h3">{t("lead_statuses.title")}</span>
                <span className="xs c3">{t("v2.admin.statuses.cardSub", { n: rows.length })}</span>
              </div>
              <button className="btn btn-pri btn-sm" type="button" onClick={() => setCreating(true)}>
                <Plus className="ic ic-s" />
                {t("lead_statuses.add")}
              </button>
            </div>
            {q.isLoading ? (
              <LoadingBlock rows={6} onRetry={() => q.refetch()} />
            ) : q.isError ? (
              <ErrorState error={q.error} onRetry={() => q.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState title={t("v2.state.empty")} body={t("v2.admin.statuses.emptyBody")} />
            ) : (
              <div className="scroll-x">
                <div style={{ minWidth: 760 }}>
                  <div className="tr th" style={{ gridTemplateColumns: COLS }}>
                    <span>{t("lead_statuses.col_emoji")}</span>
                    <span>{t("lead_statuses.col_label_ru")}</span>
                    <span>{t("lead_statuses.col_label_uz")}</span>
                    <span>{t("lead_statuses.col_tone")}</span>
                    <span style={{ textAlign: "center" }}>{t("lead_statuses.col_chip")}</span>
                    <span style={{ textAlign: "center" }}>{t("lead_statuses.col_button")}</span>
                    <span style={{ textAlign: "center" }}>{t("lead_statuses.col_active")}</span>
                    <span />
                  </div>
                  {rows.map((r) => {
                    const tone = toneOf(r.tone);
                    return (
                      <div
                        key={r.id}
                        className="tr"
                        role="button"
                        tabIndex={0}
                        style={{ gridTemplateColumns: COLS, minHeight: 42, opacity: r.is_active ? 1 : 0.55, cursor: "pointer" }}
                        onClick={() => setEditing(r)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") setEditing(r);
                        }}
                      >
                        <span style={{ fontSize: 18, lineHeight: 1 }}>{r.emoji || "·"}</span>
                        <span className="col" style={{ minWidth: 0, gap: 3, padding: "4px 0" }}>
                          <span className="row g6 wrap">
                            <span className={cx("badge", tone.badge)}><i className="dot" />{r.label_ru}</span>
                            {r.is_builtin ? (
                              <span className="badge" style={{ height: 18, fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em" }}>
                                {t("v2.admin.statuses.builtin")}
                              </span>
                            ) : null}
                            {r.blocks_new_leads ? (
                              <span className="badge b-bad" style={{ height: 18, fontSize: 10.5 }} title={t("lead_statuses.blocks_new_leads_hint")}>
                                {t("lead_statuses.blocks_short")}
                              </span>
                            ) : null}
                          </span>
                          <span className="num xs c3 trunc">{r.code}</span>
                        </span>
                        <span className="s c3 trunc">{r.label_uz || "—"}</span>
                        <span className="row g6 xs">
                          <i style={{ display: "block", width: 10, height: 10, borderRadius: "50%", background: tone.sw }} />
                          {t(`v2.admin.statuses.tone.${tone.v}`)}
                        </span>
                        <span className="s" style={{ textAlign: "center" }}>{yesNo(r.show_in_chip)}</span>
                        <span className="s" style={{ textAlign: "center" }}>{yesNo(r.show_in_button)}</span>
                        <span className="s" style={{ textAlign: "center" }}>{yesNo(r.is_active)}</span>
                        <span onClick={(e) => e.stopPropagation()}>
                          {!r.is_builtin ? (
                            <button
                              className="btn btn-ghost btn-sq btn-sm"
                              type="button"
                              aria-label={`${t("common.delete")}: ${r.label_ru}`}
                              title={t("common.delete")}
                              style={{ color: "var(--bad)" }}
                              disabled={del.isPending && del.variables === r.id}
                              onClick={() => askDelete(r)}
                            >
                              <Trash2 className="ic ic-s" />
                            </button>
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
          <p className="xs c3">{t("v2.admin.statuses.paleHint")}</p>
        </SettingsLayout>
      </main>

      {editing || creating ? (
        <StatusDialog
          value={editing}
          all={rows}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
        />
      ) : null}
      {confirm.node}
    </>
  );
}

function Toggle({ label, on, onChange, children }: { label: string; on: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <div className="li" style={{ minHeight: 48 }}>
      {children ?? <span className="s grow">{label}</span>}
      <button className={cx("switch", on && "is-on")} type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
        <i />
      </button>
    </div>
  );
}

function StatusDialog({ value, all, onClose }: { value: SetLeadStatusRow | null; all: SetLeadStatusRow[]; onClose: () => void }) {
  const t = useT2();
  const save = useSetLeadStatusSave();
  const isEdit = !!value;
  const isBuiltin = value?.is_builtin ?? false;

  const [code, setCode] = useState(value?.code || "");
  const [codeTouched, setCodeTouched] = useState(false);
  const [labelRu, setLabelRu] = useState(value?.label_ru || "");
  const [labelUz, setLabelUz] = useState(value?.label_uz || "");
  const [tone, setTone] = useState<SetLeadStatusTone>(value?.tone || "neutral");
  const [emoji, setEmoji] = useState(value?.emoji || "");
  const [sortOrder, setSortOrder] = useState(String(value?.sort_order ?? 100));
  const [showChip, setShowChip] = useState(value?.show_in_chip ?? true);
  const [showButton, setShowButton] = useState(value?.show_in_button ?? true);
  const [isActive, setIsActive] = useState(value?.is_active ?? true);
  const [blocksNew, setBlocksNew] = useState(value?.blocks_new_leads ?? false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isEdit && !codeTouched) setCode(slugify(labelRu));
  }, [labelRu, isEdit, codeTouched]);

  const takenBy = !isEdit && code.trim() ? all.find((r) => r.code === code.trim()) : undefined;
  const labelErr = tried && !labelRu.trim() ? t("v2.admin.statuses.needLabel") : "";
  const codeErr = !isEdit
    ? takenBy
      ? t("v2.admin.statuses.codeTaken", { name: takenBy.label_ru })
      : tried && !code.trim()
        ? t("v2.admin.statuses.needCode")
        : ""
    : "";

  const submit = () => {
    setTried(true);
    setError("");
    if (!labelRu.trim() || !code.trim() || takenBy) return;
    save.mutate(
      {
        id: value?.id ?? null,
        body: {
          ...(isEdit ? {} : { code: code.trim() }),
          label_ru: labelRu.trim(),
          label_uz: labelUz.trim(),
          tone,
          emoji: emoji.trim(),
          sort_order: Number(sortOrder) || 100,
          show_in_chip: showChip,
          show_in_button: showButton,
          is_active: isActive,
          blocks_new_leads: blocksNew,
        },
      },
      {
        onSuccess: () => {
          toast.success(t("toast.saved"));
          onClose();
        },
        onError: (e) => setError(apiErrorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={600}
      title={isEdit ? t("lead_statuses.edit_title") : t("lead_statuses.new_title")}
      sub={isBuiltin ? t("lead_statuses.builtin_hint") : undefined}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" disabled={save.isPending || !!takenBy} onClick={submit}>
            {save.isPending ? t("common.saving") : isEdit ? t("common.save") : t("v2.admin.statuses.create")}
          </button>
        </>
      }
    >
      {isBuiltin ? (
        <div className="banner b-info">
          <span>{t("v2.admin.statuses.builtinBanner")}</span>
        </div>
      ) : null}
      <div className="row g12 wrap" style={{ alignItems: "flex-start" }}>
        <div className="field grow" style={{ flexBasis: 200 }}>
          <label htmlFor="st-ru">{t("lead_statuses.label_ru")}</label>
          <input id="st-ru" className={cx("input", labelErr && "is-bad")} type="text" autoFocus value={labelRu} onChange={(e) => setLabelRu(e.target.value)} />
          {labelErr ? <span className="err">{labelErr}</span> : null}
        </div>
        <div className="field grow" style={{ flexBasis: 200 }}>
          <label htmlFor="st-uz">{t("lead_statuses.label_uz")}</label>
          <input id="st-uz" className="input" type="text" value={labelUz} placeholder={t("lead_statuses.label_uz_ph")} onChange={(e) => setLabelUz(e.target.value)} />
        </div>
      </div>
      <div className="row g12 wrap" style={{ alignItems: "flex-start" }}>
        <div className="field grow" style={{ flexBasis: 200 }}>
          <label htmlFor="st-code">{t("lead_statuses.code")} (slug)</label>
          <input
            id="st-code"
            className={cx("input num", codeErr && "is-bad")}
            type="text"
            value={code}
            disabled={isEdit}
            placeholder="waiting_salary"
            style={isEdit ? { background: "var(--surface-2)", color: "var(--ink-3)" } : undefined}
            onChange={(e) => {
              setCode(e.target.value);
              setCodeTouched(true);
            }}
          />
          {codeErr ? <span className="err">{codeErr}</span> : isEdit ? <span className="hint">{t("lead_statuses.code_locked")}</span> : null}
        </div>
        <div className="field" style={{ width: 90 }}>
          <label htmlFor="st-em">{t("lead_statuses.emoji")}</label>
          <input id="st-em" className="input" type="text" value={emoji} maxLength={4} style={{ textAlign: "center" }} onChange={(e) => setEmoji(e.target.value.slice(0, 4))} />
        </div>
        <div className="field" style={{ width: 110 }}>
          <label htmlFor="st-ord">{t("lead_statuses.sort_order")}</label>
          <input id="st-ord" className="input num" type="number" min={0} max={999} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          <span className="hint">{t("v2.admin.statuses.orderHint")}</span>
        </div>
      </div>
      <fieldset className="col g8" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="flabel" style={{ marginBottom: 8 }}>{t("lead_statuses.tone")}</legend>
        <div className="row g6 wrap">
          {TONES.map((o) => (
            <label key={o.v} className={cx("chip", tone === o.v && "pick-on")} style={{ cursor: "pointer" }}>
              <input type="radio" name="v2-tone" checked={tone === o.v} onChange={() => setTone(o.v)} style={{ margin: 0 }} />
              <span className={cx("badge", o.badge)}><i className="dot" />{t(`v2.admin.statuses.tone.${o.v}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="col" style={{ border: "1px solid var(--line)", borderRadius: 11, overflow: "hidden" }}>
        <Toggle label={t("lead_statuses.show_chip")} on={showChip} onChange={setShowChip} />
        <Toggle label={t("lead_statuses.show_button")} on={showButton} onChange={setShowButton} />
        <Toggle label={t("lead_statuses.active")} on={isActive} onChange={setIsActive} />
        <div style={{ background: blocksNew ? "var(--bad-bg)" : undefined }}>
          <Toggle label={t("lead_statuses.blocks_new_leads")} on={blocksNew} onChange={setBlocksNew}>
            <span className="col grow">
              <span className={cx("s w6", blocksNew && "c-bad")}>{t("lead_statuses.blocks_new_leads")}</span>
              <span className="xs c2">{t("lead_statuses.blocks_new_leads_hint")}</span>
            </span>
          </Toggle>
        </div>
      </div>
      {error ? (
        <div className="banner b-bad">
          <span>{error}</span>
        </div>
      ) : null}
    </Dialog>
  );
}
