import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Search,
  Trash2,
  Edit3,
  Eye,
  EyeOff,
  Loader2,
  Image as ImageIcon,
  Type,
  Megaphone,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { usePageHeader } from "../store/page";
import { Modal } from "../components/ui";
import PhoneEditor, { type PhoneDraft } from "../components/PhoneEditor";
import { useAuth } from "../store/auth";
import { normaliseRole } from "../components/RoleGate";
import {
  copyPhoneTextOnly,
  copyPhoneImageOnly,
} from "../components/CopyPhoneButton";
import { copyImageByUrl, copyText } from "../lib/clipboard";

export type Phone = {
  id: number;
  brand: string;
  model_name: string;
  storage_gb: number | null;
  ram_gb: number | null;
  price: string;
  cover_image_url: string | null;
  description: string;
  tagline: string;
  camera_mp: number | null;
  battery_mah: number | null;
  specs_json: Record<string, string>;
  stock_status: "available" | "on_order" | "out";
  is_active: boolean;
  sort_order: number;
  colors: PhoneColor[];
  gallery: PhoneGalleryPhoto[];
  marketing_text_uz?: string;
  installment_preview?: { months: number; monthly: number }[];
};

export type PhoneColor = {
  id?: number;
  name: string;
  hex_code: string;
  price_override: string | null;
  is_available: boolean;
  sort_order: number;
};

export type PhoneGalleryPhoto = {
  id: number;
  position: number;
  photo_url: string;
  uploaded_at: string;
};

const emptyDraft = (): PhoneDraft => ({
  brand: "",
  model_name: "",
  storage_gb: null,
  ram_gb: null,
  price: "",
  description: "",
  tagline: "",
  camera_mp: null,
  battery_mah: null,
  specs_json: {},
  stock_status: "available",
  is_active: true,
  sort_order: 0,
  colors: [],
  gallery: [],
  new_gallery_files: [],
  cover_image_file: null,
  cover_image_url: null,
});

function fmtPrice(v: string | number): string {
  const n = Math.round(Number(v || 0));
  return n.toLocaleString("ru-RU").replace(/,/g, " ");
}

/**
 * Product card image block: main image + thumbnail strip.
 *
 * Every image is a copy button. Click main or any thumbnail → the
 * image goes to the clipboard so the operator can paste it straight
 * into Telegram/WhatsApp. Main image is static (cover, or the first
 * gallery photo if no cover) — we deliberately do not swap it on
 * thumbnail click so operators know at a glance that each thumbnail
 * is a distinct copyable item, not a preview toggle.
 */
function PhoneImages({
  phone,
  noPhotoLabel,
  copyLabel,
  copyFailedLabel,
  t,
}: {
  phone: Phone;
  noPhotoLabel: string;
  copyLabel: string;
  copyFailedLabel: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const mainUrl =
    phone.cover_image_url ?? phone.gallery[0]?.photo_url ?? null;
  const thumbs: { key: string; url: string }[] = [];
  if (phone.cover_image_url) {
    thumbs.push({ key: "cover", url: phone.cover_image_url });
  }
  for (const g of phone.gallery) {
    thumbs.push({ key: `g-${g.id}`, url: g.photo_url });
  }
  const copyOne = async (url: string) => {
    try {
      await copyImageByUrl(url);
      toast.success(copyLabel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[copy] image failed", err);
      toast.error(`${copyFailedLabel}: ${msg}`);
    }
  };
  return (
    <>
      <div className="aspect-[4/3] bg-[var(--surface2)] flex items-center justify-center overflow-hidden">
        {mainUrl ? (
          <button
            type="button"
            onClick={() => copyOne(mainUrl)}
            className="w-full h-full block group relative"
            title={t("catalog.click_to_copy")}
          >
            <img
              src={mainUrl}
              alt={phone.model_name}
              className="w-full h-full object-contain transition group-hover:opacity-90"
            />
          </button>
        ) : (
          <div className="text-muted text-[12px]">{noPhotoLabel}</div>
        )}
      </div>
      {thumbs.length > 1 && (
        <div className="flex gap-1.5 px-3 py-2 overflow-x-auto bg-[var(--surface2)]/60">
          {thumbs.map((th) => (
            <button
              key={th.key}
              type="button"
              onClick={() => copyOne(th.url)}
              className="shrink-0 w-11 h-11 rounded-md overflow-hidden border-2 border-transparent opacity-80 hover:opacity-100 hover:border-[var(--accent)] transition"
              title={t("catalog.click_to_copy")}
            >
              <img src={th.url} alt="" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export default function Catalog() {
  const t = useT();
  const qc = useQueryClient();
  const rawRole = useAuth((s) => s.role);
  const canEdit = normaliseRole(rawRole) === "manager";
  usePageHeader({ title: t("catalog.title"), subtitle: t("catalog.subtitle") }, [
    t("catalog.title"),
  ]);
  const [search, setSearch] = useState("");
  const [stockFilter, setStockFilter] = useState<"" | "available" | "on_order" | "out">("");
  const [editing, setEditing] = useState<PhoneDraft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [copying, setCopying] = useState<{
    id: number;
    mode: "text" | "photo" | "marketing";
  } | null>(null);

  const phones = useQuery({
    queryKey: ["catalog-phones", search, stockFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (stockFilter) params.set("stock", stockFilter);
      return api.get<{ results?: Phone[] } | Phone[]>(`/catalog/phones/?${params}`).then((r) => {
        const d = r.data as any;
        return (d.results || d) as Phone[];
      });
    },
  });

  const save = useMutation({
    mutationFn: async (draft: PhoneDraft & { id?: number }) => {
      const body: any = {
        brand: draft.brand,
        model_name: draft.model_name,
        storage_gb: draft.storage_gb || null,
        ram_gb: draft.ram_gb || null,
        price: draft.price,
        description: draft.description,
        tagline: draft.tagline || "",
        camera_mp: draft.camera_mp || null,
        battery_mah: draft.battery_mah || null,
        specs_json: draft.specs_json || {},
        stock_status: draft.stock_status,
        is_active: draft.is_active,
        sort_order: draft.sort_order,
        colors: draft.colors.map((c) => ({
          name: c.name,
          hex_code: c.hex_code,
          price_override: c.price_override || null,
          is_available: c.is_available,
          sort_order: c.sort_order,
        })),
      };
      let phoneId = draft.id;
      const resp = draft.id
        ? await api.patch(`/catalog/phones/${draft.id}/`, body)
        : await api.post(`/catalog/phones/`, body);
      phoneId = (resp.data as any).id;
      if (draft.cover_image_file && phoneId) {
        const fd = new FormData();
        fd.append("cover_image", draft.cover_image_file);
        await api.post(`/catalog/phones/${phoneId}/upload_photo/`, fd);
      }
      // Append new gallery photos (one request per file — backend appends
      // to the tail of `phone.gallery` and assigns the next position).
      if (draft.new_gallery_files && draft.new_gallery_files.length > 0 && phoneId) {
        for (const f of draft.new_gallery_files) {
          const fd = new FormData();
          fd.append("photo", f);
          await api.post(`/catalog/phones/${phoneId}/gallery/upload/`, fd);
        }
      }
      // Delete gallery items marked for removal.
      if (draft.gallery_delete_ids && draft.gallery_delete_ids.length > 0 && phoneId) {
        for (const id of draft.gallery_delete_ids) {
          await api.delete(`/catalog/phones/${phoneId}/gallery/${id}/`);
        }
      }
      return resp;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog-phones"] });
      setEditing(null);
      setEditingId(null);
      toast.success(t("catalog.saved"));
    },
    onError: () => toast.error(t("catalog.save_failed")),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/catalog/phones/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog-phones"] });
      toast.success(t("catalog.deleted"));
    },
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      api.patch(`/catalog/phones/${id}/`, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog-phones"] }),
  });

  const handleCopy = async (phone: Phone, mode: "text" | "photo" | "marketing") => {
    if (copying !== null) return;
    setCopying({ id: phone.id, mode });
    try {
      if (mode === "marketing") {
        // Prefer the text baked into the list response — no fetch, so
        // the user-gesture flag stays alive on Safari/iOS. If it's
        // missing (stale cache, older backend), do a one-shot fetch;
        // most browsers still honour the gesture across a single await
        // and `copyText` falls back to the legacy execCommand path if
        // the promise API refuses.
        let text = phone.marketing_text_uz || "";
        if (!text) {
          try {
            const r = await api.get<{ text: string }>(
              `/catalog/phones/${phone.id}/marketing/?lang=uz`,
            );
            text = r.data.text || "";
          } catch (err) {
            console.error("[copy] marketing fetch failed:", err);
          }
        }
        try {
          await copyText(text);
          toast.success(t("catalog.marketing_copied"));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[copy] marketing clipboard failed:", err);
          toast.error(`${t("catalog.copy_failed")}: ${msg}`);
        }
        return;
      }
      const r = await api.get<{ text: string; cover_image_url: string | null }>(
        `/catalog/phones/${phone.id}/quote/?lang=uz`,
      );
      if (mode === "text") {
        await copyPhoneTextOnly(r.data);
        toast.success(t("catalog.copied_text_only"));
        return;
      }
      // mode === "photo"
      if (!r.data.cover_image_url) {
        toast.error(t("catalog.no_photo"));
        return;
      }
      try {
        await copyPhoneImageOnly(r.data);
        toast.success(t("catalog.photo_copied"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[copy] photo-only failed:", err);
        toast.error(`${t("catalog.copy_failed")}: ${msg}`);
      }
    } catch (err) {
      console.error("[copy] handler error:", err);
      toast.error(t("catalog.copy_failed"));
    } finally {
      setCopying(null);
    }
  };

  const openEdit = (p?: Phone) => {
    if (!p) {
      setEditing(emptyDraft());
      setEditingId(null);
      return;
    }
    setEditing({
      brand: p.brand,
      model_name: p.model_name,
      storage_gb: p.storage_gb,
      ram_gb: p.ram_gb,
      price: p.price,
      description: p.description,
      tagline: p.tagline || "",
      camera_mp: p.camera_mp ?? null,
      battery_mah: p.battery_mah ?? null,
      specs_json: p.specs_json || {},
      stock_status: p.stock_status,
      is_active: p.is_active,
      sort_order: p.sort_order,
      colors: p.colors || [],
      gallery: p.gallery || [],
      new_gallery_files: [],
      gallery_delete_ids: [],
      cover_image_file: null,
      cover_image_url: p.cover_image_url,
    });
    setEditingId(p.id);
  };

  const filtered = phones.data || [];

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-3 text-muted" />
          <input
            className="nf-input pl-9"
            placeholder={t("catalog.search_ph")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="nf-card p-1 inline-flex gap-0.5">
          {(["", "available", "on_order", "out"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStockFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-[12px] transition ${
                stockFilter === s
                  ? "bg-[var(--accent-pale-bg,rgba(228,87,27,0.12))] font-medium"
                  : "text-muted"
              }`}
            >
              {t(s === "" ? "catalog.stock_all" : `catalog.stock_${s}`)}
            </button>
          ))}
        </div>
        {canEdit && (
          <button type="button" className="nf-btn nf-btn--primary" onClick={() => openEdit()}>
            <Plus className="w-4 h-4" /> {t("catalog.new_phone")}
          </button>
        )}
      </div>

      {phones.isLoading && <div className="text-muted">{t("common.loading")}</div>}
      {!phones.isLoading && filtered.length === 0 && (
        <div className="nf-card p-12 text-center">
          <div className="text-[15px] font-semibold mb-1">{t("catalog.empty_title")}</div>
          <div className="text-muted text-[13px]">{t("catalog.empty_hint")}</div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((p) => (
          <div key={p.id} className="nf-card overflow-hidden flex flex-col">
            <PhoneImages
              phone={p}
              noPhotoLabel={t("catalog.no_photo")}
              copyLabel={t("catalog.photo_copied")}
              copyFailedLabel={t("catalog.copy_failed")}
              t={t}
            />
            <div className="p-4 flex-1 flex flex-col">
              <div className="text-[15px] font-semibold truncate">
                {p.brand} {p.model_name}
              </div>
              <div className="text-[12px] text-muted mt-0.5">
                {p.storage_gb ? `${p.storage_gb}GB` : ""}
                {p.storage_gb && p.ram_gb ? " / " : ""}
                {p.ram_gb ? `${p.ram_gb}GB RAM` : ""}
              </div>
              {p.colors.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {p.colors.slice(0, 5).map((c, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-[var(--faint)]"
                      title={c.name}
                    >
                      {c.hex_code && (
                        <span
                          className="w-2.5 h-2.5 rounded-full inline-block"
                          style={{ background: c.hex_code }}
                        />
                      )}
                      {c.name}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-3 text-[18px] font-semibold tabular-nums">
                {fmtPrice(p.price)} <span className="text-[13px] text-muted">сум</span>
              </div>
              {p.installment_preview && p.installment_preview.length > 0 && (
                <div className="mt-1.5 text-[11.5px] text-muted flex flex-wrap gap-x-2 gap-y-0.5 tabular-nums">
                  <span className="text-[var(--accent)]">💳</span>
                  {p.installment_preview.map((row, i) => (
                    <span key={row.months}>
                      {row.months} {t("catalog.month_short")} → {fmtPrice(row.monthly)}
                      {i < p.installment_preview!.length - 1 ? " ·" : ` ${t("catalog.installment_from")}`}
                    </span>
                  ))}
                </div>
              )}
              {p.stock_status !== "available" && (
                <div className="text-[11.5px] text-amber-500 mt-1">
                  {t(`catalog.stock_${p.stock_status}`)}
                </div>
              )}

              <div className="flex-1" />
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    className="nf-btn nf-btn--secondary !px-2 !text-[12px]"
                    onClick={() => handleCopy(p, "text")}
                    disabled={copying !== null}
                    title={t("catalog.copy_text")}
                  >
                    {copying?.id === p.id && copying?.mode === "text" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Type className="w-3.5 h-3.5" />
                    )}{" "}
                    {t("catalog.copy_text")}
                  </button>
                  <button
                    type="button"
                    className="nf-btn nf-btn--secondary !px-2 !text-[12px]"
                    onClick={() => handleCopy(p, "photo")}
                    disabled={copying !== null || !p.cover_image_url}
                    title={t("catalog.copy_photo")}
                  >
                    {copying?.id === p.id && copying?.mode === "photo" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ImageIcon className="w-3.5 h-3.5" />
                    )}{" "}
                    {t("catalog.copy_photo")}
                  </button>
                  <button
                    type="button"
                    className="nf-btn nf-btn--primary !px-2 !text-[12px]"
                    onClick={() => handleCopy(p, "marketing")}
                    disabled={copying !== null}
                    title={t("catalog.copy_marketing")}
                  >
                    {copying?.id === p.id && copying?.mode === "marketing" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Megaphone className="w-3.5 h-3.5" />
                    )}{" "}
                    {t("catalog.copy_marketing")}
                  </button>
                </div>
                {canEdit && (
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      className="nf-btn nf-btn--ghost !p-2"
                      onClick={() => openEdit(p)}
                      title={t("common.edit")}
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      className="nf-btn nf-btn--ghost !p-2"
                      onClick={() => toggleActive.mutate({ id: p.id, is_active: !p.is_active })}
                      title={p.is_active ? t("catalog.hide") : t("catalog.show")}
                    >
                      {p.is_active ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      type="button"
                      className="nf-btn nf-btn--ghost !p-2 text-red-500"
                      onClick={() => {
                        if (confirm(t("catalog.confirm_delete", { name: p.model_name })))
                          remove.mutate(p.id);
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={!!editing && canEdit}
        onClose={() => {
          setEditing(null);
          setEditingId(null);
        }}
        width={640}
      >
        {editing && canEdit && (
          <PhoneEditor
            draft={editing}
            onChange={setEditing}
            onSave={() => save.mutate({ ...editing, id: editingId ?? undefined } as any)}
            onCancel={() => {
              setEditing(null);
              setEditingId(null);
            }}
            saving={save.isPending}
          />
        )}
      </Modal>
    </div>
  );
}
