import { Plus, X } from "lucide-react";
import PhotoUploader from "./PhotoUploader";
import NumericInput from "./NumericInput";
import { useT } from "../lib/i18n";
import type { PhoneColor } from "../pages/Catalog";

export type PhoneDraft = {
  brand: string;
  model_name: string;
  storage_gb: number | null;
  ram_gb: number | null;
  price: string;
  description: string;
  stock_status: "available" | "on_order" | "out";
  is_active: boolean;
  sort_order: number;
  colors: PhoneColor[];
  cover_image_file: File | null;
  cover_image_url: string | null;
};

interface Props {
  draft: PhoneDraft;
  onChange: (d: PhoneDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}

export default function PhoneEditor({ draft, onChange, onSave, onCancel, saving }: Props) {
  const t = useT();
  const set = <K extends keyof PhoneDraft>(k: K, v: PhoneDraft[K]) =>
    onChange({ ...draft, [k]: v });

  const addColor = () =>
    set("colors", [
      ...draft.colors,
      { name: "", hex_code: "", price_override: null, is_available: true, sort_order: draft.colors.length },
    ]);
  const updateColor = (i: number, patch: Partial<PhoneColor>) => {
    const next = [...draft.colors];
    next[i] = { ...next[i], ...patch };
    set("colors", next);
  };
  const removeColor = (i: number) => set("colors", draft.colors.filter((_, j) => j !== i));

  const canSave =
    draft.brand.trim() &&
    draft.model_name.trim() &&
    Number(draft.price) > 0 &&
    !saving;

  return (
    <div className="p-6 max-h-[85vh] overflow-y-auto space-y-4">
      <div className="text-[18px] font-semibold tracking-tight">
        {t("catalog.editor_title")}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="nf-col mb-1.5 block">{t("catalog.brand")}</label>
          <input
            className="nf-input"
            value={draft.brand}
            onChange={(e) => set("brand", e.target.value)}
            placeholder="Apple"
          />
        </div>
        <div>
          <label className="nf-col mb-1.5 block">{t("catalog.model_name")}</label>
          <input
            className="nf-input"
            value={draft.model_name}
            onChange={(e) => set("model_name", e.target.value)}
            placeholder="iPhone 17 Pro Max"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="nf-col mb-1.5 block">{t("catalog.storage")}</label>
          <input
            className="nf-input"
            type="number"
            value={draft.storage_gb ?? ""}
            onChange={(e) => set("storage_gb", e.target.value ? Number(e.target.value) : null)}
            placeholder="256"
          />
        </div>
        <div>
          <label className="nf-col mb-1.5 block">{t("catalog.ram")}</label>
          <input
            className="nf-input"
            type="number"
            value={draft.ram_gb ?? ""}
            onChange={(e) => set("ram_gb", e.target.value ? Number(e.target.value) : null)}
            placeholder="8"
          />
        </div>
        <div>
          <label className="nf-col mb-1.5 block">{t("catalog.stock")}</label>
          <select
            className="nf-input"
            value={draft.stock_status}
            onChange={(e) => set("stock_status", e.target.value as any)}
          >
            <option value="available">{t("catalog.stock_available")}</option>
            <option value="on_order">{t("catalog.stock_on_order")}</option>
            <option value="out">{t("catalog.stock_out")}</option>
          </select>
        </div>
      </div>

      <div>
        <label className="nf-col mb-1.5 block">{t("catalog.price")}</label>
        <NumericInput
          className="nf-input"
          value={draft.price}
          onChange={(v) => set("price", v)}
          placeholder="22 500 000"
        />
      </div>

      <PhotoUploader
        value={draft.cover_image_file}
        onChange={(f) => set("cover_image_file", f)}
        label={t("catalog.cover_photo")}
        hint={t("catalog.cover_photo_hint")}
        existingUrl={draft.cover_image_url || undefined}
      />

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="nf-col">{t("catalog.colors")}</label>
          <button
            type="button"
            className="nf-btn nf-btn--ghost !py-1 !px-2 text-[12px]"
            onClick={addColor}
          >
            <Plus className="w-3 h-3" /> {t("catalog.add_color")}
          </button>
        </div>
        <div className="space-y-2">
          {draft.colors.map((c, i) => (
            <div key={i} className="flex gap-2 items-start">
              <input
                className="nf-input flex-1"
                placeholder={t("catalog.color_name_ph")}
                value={c.name}
                onChange={(e) => updateColor(i, { name: e.target.value })}
              />
              <input
                type="color"
                className="w-12 h-11 rounded-lg border border-[var(--border)] cursor-pointer"
                value={c.hex_code || "#888888"}
                onChange={(e) => updateColor(i, { hex_code: e.target.value })}
                title={t("catalog.color_hex")}
              />
              <button
                type="button"
                className="nf-btn nf-btn--ghost !p-2 text-red-500 flex-shrink-0"
                onClick={() => removeColor(i)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
          {draft.colors.length === 0 && (
            <div className="text-[12px] text-muted">{t("catalog.no_colors")}</div>
          )}
        </div>
      </div>

      <div>
        <label className="nf-col mb-1.5 block">{t("catalog.description")}</label>
        <textarea
          className="nf-input"
          rows={2}
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
        />
      </div>

      <label className="flex items-center gap-2 text-[13px] cursor-pointer">
        <input
          type="checkbox"
          checked={draft.is_active}
          onChange={(e) => set("is_active", e.target.checked)}
        />
        {t("catalog.active")}
      </label>

      <div className="flex justify-end gap-2 pt-3 border-t border-[var(--border)]">
        <button type="button" className="nf-btn nf-btn--ghost" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="nf-btn nf-btn--primary"
          onClick={onSave}
          disabled={!canSave}
        >
          {saving ? t("common.loading") : t("common.save")}
        </button>
      </div>
    </div>
  );
}
