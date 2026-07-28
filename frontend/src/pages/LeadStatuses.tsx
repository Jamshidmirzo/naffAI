/**
 * Manager-only CRUD for LeadStatusLabel. Adds new statuses («Ждёт зарплаты»)
 * and lets managers rename / recolour builtin ones. Builtin rows can't be
 * deleted and their `code` is frozen.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import {
  Button,
  Modal,
  StatusBadge,
  toast,
  Toggle,
} from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import {
  useLeadStatuses,
  type LeadStatusRow,
  type LeadStatusTone,
} from "../hooks/useLeadStatuses";

const TONE_OPTIONS: { value: LeadStatusTone; label: string; swatch: string }[] = [
  { value: "neutral", label: "нейтральный", swatch: "#94a3b8" },
  { value: "info",    label: "синий",       swatch: "#3b82f6" },
  { value: "hot",     label: "оранжевый",   swatch: "#f2560b" },
  { value: "success", label: "зелёный",     swatch: "#16a34a" },
  { value: "danger",  label: "красный",     swatch: "#dc2626" },
];

function toneToBadge(tone: LeadStatusTone): "hot" | "danger" | "neutral" {
  if (tone === "hot" || tone === "success" || tone === "info") return "hot";
  if (tone === "danger") return "danger";
  return "neutral";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9а-яё\s_]+/gi, "")
    .replace(/[а-яё]/g, (c) => {
      const map: Record<string, string> = {
        а:"a", б:"b", в:"v", г:"g", д:"d", е:"e", ё:"e", ж:"zh", з:"z",
        и:"i", й:"i", к:"k", л:"l", м:"m", н:"n", о:"o", п:"p", р:"r",
        с:"s", т:"t", у:"u", ф:"f", х:"h", ц:"ts", ч:"ch", ш:"sh", щ:"sch",
        ъ:"", ы:"y", ь:"", э:"e", ю:"yu", я:"ya",
      };
      return map[c] || "";
    })
    .replace(/\s+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
}

export default function LeadStatuses() {
  const t = useT();
  const qc = useQueryClient();
  usePageHeader({
    title: t("lead_statuses.title"),
    subtitle: t("lead_statuses.subtitle"),
  });

  const q = useLeadStatuses();
  const [editing, setEditing] = useState<LeadStatusRow | null>(null);
  const [creating, setCreating] = useState(false);

  const rows = (q.data ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/lead-statuses/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lead-statuses"] });
      toast.success(t("lead_statuses.deleted"));
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      <div className="flex items-center justify-between animate-nfFadeUp">
        <div className="text-[13px] text-muted">
          {t("lead_statuses.total", { n: rows.length })}
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="w-3.5 h-3.5" /> {t("lead_statuses.add")}
        </Button>
      </div>

      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: "60px 1.4fr 1fr 90px 60px 60px 60px 80px" }}
        >
          <div>{t("lead_statuses.col_emoji")}</div>
          <div>{t("lead_statuses.col_label_ru")}</div>
          <div>{t("lead_statuses.col_label_uz")}</div>
          <div>{t("lead_statuses.col_tone")}</div>
          <div className="text-center">{t("lead_statuses.col_chip")}</div>
          <div className="text-center">{t("lead_statuses.col_button")}</div>
          <div className="text-center">{t("lead_statuses.col_active")}</div>
          <div className="text-right">{t("common.actions")}</div>
        </div>

        {q.isLoading ? (
          <div className="text-center py-12 text-muted text-[13px]">
            {t("common.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-muted text-[13px]">
            {t("common.empty")}
          </div>
        ) : (
          rows.map((r, i) => (
            <div
              key={r.id}
              className="nf-row animate-nfFadeUp"
              style={{
                gridTemplateColumns: "60px 1.4fr 1fr 90px 60px 60px 60px 80px",
                animationDelay: `${0.02 + i * 0.02}s`,
                cursor: "pointer",
                opacity: r.is_active ? 1 : 0.55,
              }}
              onClick={() => setEditing(r)}
            >
              <div className="text-[20px]">{r.emoji || "·"}</div>
              <div className="flex items-center gap-2 min-w-0">
                <StatusBadge tone={toneToBadge(r.tone)}>{r.label_ru}</StatusBadge>
                <span className="text-[11px] text-muted font-mono truncate">
                  {r.code}
                </span>
                {r.is_builtin && (
                  <span
                    className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-full"
                    style={{ background: "var(--faint)", color: "var(--muted)" }}
                  >
                    builtin
                  </span>
                )}
              </div>
              <div className="text-[12.5px] text-muted truncate">
                {r.label_uz || "—"}
              </div>
              <div className="flex items-center gap-1.5 text-[12px]">
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    background:
                      TONE_OPTIONS.find((o) => o.value === r.tone)?.swatch ??
                      "#94a3b8",
                  }}
                />
                {TONE_OPTIONS.find((o) => o.value === r.tone)?.label ?? r.tone}
              </div>
              <div className="text-center text-[13px]">{r.show_in_chip ? "✓" : "—"}</div>
              <div className="text-center text-[13px]">{r.show_in_button ? "✓" : "—"}</div>
              <div className="text-center text-[13px]">{r.is_active ? "✓" : "—"}</div>
              <div className="text-right" onClick={(e) => e.stopPropagation()}>
                {!r.is_builtin && (
                  <button
                    className="nf-btn nf-btn--ghost"
                    style={{ padding: "6px 8px", fontSize: 12, color: "var(--danger)" }}
                    onClick={() => {
                      if (confirm(t("lead_statuses.confirm_delete"))) del.mutate(r.id);
                    }}
                    title={t("common.delete")}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </section>

      {(editing || creating) && (
        <StatusFormModal
          value={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            qc.invalidateQueries({ queryKey: ["lead-statuses"] });
            toast.success(t("toast.saved"));
          }}
        />
      )}
    </div>
  );
}

function StatusFormModal({
  value,
  onClose,
  onSaved,
}: {
  value: LeadStatusRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const isEdit = !!value;
  const isBuiltin = value?.is_builtin ?? false;

  const [code, setCode] = useState(value?.code || "");
  const [labelRu, setLabelRu] = useState(value?.label_ru || "");
  const [labelUz, setLabelUz] = useState(value?.label_uz || "");
  const [tone, setTone] = useState<LeadStatusTone>(value?.tone || "neutral");
  const [emoji, setEmoji] = useState(value?.emoji || "");
  const [sortOrder, setSortOrder] = useState(value?.sort_order ?? 100);
  const [showChip, setShowChip] = useState(value?.show_in_chip ?? true);
  const [showButton, setShowButton] = useState(value?.show_in_button ?? true);
  const [isActive, setIsActive] = useState(value?.is_active ?? true);
  const [error, setError] = useState("");
  const [codeManuallyEdited, setCodeManuallyEdited] = useState(false);

  // Live-slug code from label_ru while creating and user hasn't typed it manually.
  useEffect(() => {
    if (!isEdit && !codeManuallyEdited) {
      setCode(slugify(labelRu));
    }
  }, [labelRu, isEdit, codeManuallyEdited]);

  const mut = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        label_ru: labelRu.trim(),
        label_uz: labelUz.trim(),
        tone,
        emoji: emoji.trim(),
        sort_order: sortOrder,
        show_in_chip: showChip,
        show_in_button: showButton,
        is_active: isActive,
      };
      if (isEdit) {
        await api.patch(`/lead-statuses/${value!.id}/`, body);
      } else {
        body.code = code.trim();
        await api.post("/lead-statuses/", body);
      }
    },
    onSuccess: onSaved,
    onError: (err) => setError(apiErrorMessage(err)),
  });

  return (
    <Modal open onClose={onClose} width={520}>
      <div className="p-7">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-[18px] font-semibold tracking-tight">
              {isEdit ? t("lead_statuses.edit_title") : t("lead_statuses.new_title")}
            </div>
            {isBuiltin && (
              <div className="text-[11.5px] text-muted mt-0.5">
                {t("lead_statuses.builtin_hint")}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="grid place-items-center rounded-full hover:bg-[color:var(--faint)]"
            style={{ width: 32, height: 32 }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <div className="nf-col mb-1.5">{t("lead_statuses.label_ru")}</div>
            <input
              className="nf-input"
              value={labelRu}
              onChange={(e) => setLabelRu(e.target.value)}
              autoFocus
            />
          </div>
          <div className="col-span-2">
            <div className="nf-col mb-1.5">{t("lead_statuses.label_uz")}</div>
            <input
              className="nf-input"
              value={labelUz}
              onChange={(e) => setLabelUz(e.target.value)}
              placeholder={t("lead_statuses.label_uz_ph")}
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">
              {t("lead_statuses.code")} <span className="text-muted">(slug)</span>
            </div>
            <input
              className="nf-input font-mono"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setCodeManuallyEdited(true);
              }}
              disabled={isEdit}
              placeholder="waiting_salary"
            />
            {isEdit && (
              <div className="text-[11px] text-muted mt-1">
                {t("lead_statuses.code_locked")}
              </div>
            )}
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("lead_statuses.emoji")}</div>
            <input
              className="nf-input text-[18px]"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
              placeholder="💰"
              maxLength={4}
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("lead_statuses.tone")}</div>
            <select
              className="nf-input"
              value={tone}
              onChange={(e) => setTone(e.target.value as LeadStatusTone)}
            >
              {TONE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("lead_statuses.sort_order")}</div>
            <input
              className="nf-input"
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value) || 100)}
              min={0}
              max={999}
            />
          </div>
          <div className="col-span-2 grid grid-cols-3 gap-4 mt-1">
            <label className="flex items-center gap-2 text-[13px] cursor-pointer">
              <Toggle
                on={showChip}
                onChange={setShowChip}
                aria-label={t("lead_statuses.col_chip")}
              />
              {t("lead_statuses.show_chip")}
            </label>
            <label className="flex items-center gap-2 text-[13px] cursor-pointer">
              <Toggle
                on={showButton}
                onChange={setShowButton}
                aria-label={t("lead_statuses.col_button")}
              />
              {t("lead_statuses.show_button")}
            </label>
            <label className="flex items-center gap-2 text-[13px] cursor-pointer">
              <Toggle
                on={isActive}
                onChange={setIsActive}
                aria-label={t("lead_statuses.col_active")}
              />
              {t("lead_statuses.active")}
            </label>
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

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              setError("");
              mut.mutate();
            }}
            disabled={mut.isPending || !labelRu.trim() || !code.trim()}
          >
            {mut.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
