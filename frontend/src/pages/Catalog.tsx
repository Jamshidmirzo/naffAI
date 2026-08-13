import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Search,
  Settings2,
  Copy,
  Trash2,
  Edit3,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { usePageHeader } from "../store/page";
import { Modal } from "../components/ui";
import PhoneEditor, { type PhoneDraft } from "../components/PhoneEditor";
import { copyPhoneToClipboard } from "../components/CopyPhoneButton";
import InstallmentPanel from "../components/InstallmentPanel";

export type Phone = {
  id: number;
  brand: string;
  model_name: string;
  storage_gb: number | null;
  ram_gb: number | null;
  price: string;
  cover_image_url: string | null;
  description: string;
  stock_status: "available" | "on_order" | "out";
  is_active: boolean;
  sort_order: number;
  colors: PhoneColor[];
};

export type PhoneColor = {
  id?: number;
  name: string;
  hex_code: string;
  price_override: string | null;
  is_available: boolean;
  sort_order: number;
};

const emptyDraft = (): PhoneDraft => ({
  brand: "",
  model_name: "",
  storage_gb: null,
  ram_gb: null,
  price: "",
  description: "",
  stock_status: "available",
  is_active: true,
  sort_order: 0,
  colors: [],
  cover_image_file: null,
  cover_image_url: null,
});

function fmtPrice(v: string | number): string {
  const n = Math.round(Number(v || 0));
  return n.toLocaleString("ru-RU").replace(/,/g, " ");
}

export default function Catalog() {
  const t = useT();
  const qc = useQueryClient();
  usePageHeader({ title: t("catalog.title"), subtitle: t("catalog.subtitle") }, [
    t("catalog.title"),
  ]);
  const [search, setSearch] = useState("");
  const [stockFilter, setStockFilter] = useState<"" | "available" | "on_order" | "out">("");
  const [editing, setEditing] = useState<PhoneDraft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [copyingId, setCopyingId] = useState<number | null>(null);

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

  const handleCopy = async (phone: Phone) => {
    if (copyingId !== null) return;
    setCopyingId(phone.id);
    try {
      const r = await api.get<{ text: string; cover_image_url: string | null }>(
        `/catalog/phones/${phone.id}/quote/?lang=uz`,
      );
      const outcome = await copyPhoneToClipboard(r.data);
      if (outcome === "full") toast.success(t("catalog.copied_full"));
      else if (r.data.cover_image_url) toast.success(t("catalog.copied_text_no_photo"));
      else toast.success(t("catalog.copied_text_only"));
    } catch {
      toast.error(t("catalog.copy_failed"));
    } finally {
      setCopyingId(null);
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
      stock_status: p.stock_status,
      is_active: p.is_active,
      sort_order: p.sort_order,
      colors: p.colors || [],
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
        <Link to="/catalog/banks" className="nf-btn nf-btn--secondary">
          <Settings2 className="w-4 h-4" /> {t("catalog.banks_link")}
        </Link>
        <button type="button" className="nf-btn nf-btn--primary" onClick={() => openEdit()}>
          <Plus className="w-4 h-4" /> {t("catalog.new_phone")}
        </button>
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
            <div className="aspect-[4/3] bg-[var(--surface2)] flex items-center justify-center overflow-hidden">
              {p.cover_image_url ? (
                <img
                  src={p.cover_image_url}
                  alt={p.model_name}
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="text-muted text-[12px]">{t("catalog.no_photo")}</div>
              )}
            </div>
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
              {p.stock_status !== "available" && (
                <div className="text-[11.5px] text-amber-500 mt-1">
                  {t(`catalog.stock_${p.stock_status}`)}
                </div>
              )}

              <InstallmentPanel phoneId={p.id} />

              <div className="flex-1" />
              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="nf-btn nf-btn--primary flex-1"
                  onClick={() => handleCopy(p)}
                  disabled={copyingId === p.id}
                >
                  {copyingId === p.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}{" "}
                  {copyingId === p.id ? t("catalog.copying") : t("catalog.copy")}
                </button>
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
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={!!editing}
        onClose={() => {
          setEditing(null);
          setEditingId(null);
        }}
        width={640}
      >
        {editing && (
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
