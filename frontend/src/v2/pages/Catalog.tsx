import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { Camera, Eye, EyeOff, Pencil, Plus, Search, Smartphone, Trash2, Upload, X } from "lucide-react";
import { toast } from "../../components/ui";
import { useAuth } from "../../store/auth";
import { isManagerLevel } from "../../components/RoleGate";
import { copyPhoneImageOnly, copyPhoneTextOnly } from "../../components/CopyPhoneButton";
import { copyImageByUrl, copyText } from "../../lib/clipboard";
import NumericInput from "../../components/NumericInput";
import CameraCapture from "../../components/CameraCapture";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, cx, fmtNum, useConfirm } from "../ui";
import {
  fetchPhoneMarketing,
  fetchPhoneQuote,
  useCatalogPhones,
  useDeleteCatalogPhone,
  useSaveCatalogPhone,
  useToggleCatalogPhone,
  type CatalogPhone,
  type CatalogPhoneColor,
  type CatalogPhoneDraft,
  type StockStatus,
} from "../api/personal";

type T = ReturnType<typeof useT2>;
type CopyMode = "text" | "photo" | "marketing";
const STOCKS = ["", "available", "on_order", "out"] as const;

const emptyDraft = (): CatalogPhoneDraft => ({
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
  gallery_delete_ids: [],
  cover_image_file: null,
  cover_image_url: null,
});

const draftFrom = (p: CatalogPhone): CatalogPhoneDraft => ({
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

function stockTone(s: StockStatus) {
  return s === "available" ? "b-ok" : s === "on_order" ? "b-warn" : "";
}

function errMsg(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * /catalog — operators copy text / photo / marketing text for a client;
 * managers also add, edit, hide and delete phones. Same requests and query
 * keys as the old Catalog page + PhoneEditor.
 */
export default function Catalog() {
  const t = useT2();
  const canEdit = isManagerLevel(useAuth((s) => s.role));
  const confirm = useConfirm();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [stock, setStock] = useState<"" | StockStatus>("");
  const [onlyHidden, setOnlyHidden] = useState(false);
  const [editing, setEditing] = useState<CatalogPhoneDraft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [copying, setCopying] = useState<{ id: number; mode: CopyMode } | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const phones = useCatalogPhones(search, stock);
  const save = useSaveCatalogPhone();
  const remove = useDeleteCatalogPhone();
  const toggle = useToggleCatalogPhone();

  const list = useMemo(() => {
    const all = phones.data ?? [];
    // «Скрыть от операторов» means exactly that: operators never see hidden phones.
    if (!canEdit) return all.filter((p) => p.is_active);
    return onlyHidden ? all.filter((p) => !p.is_active) : all;
  }, [phones.data, canEdit, onlyHidden]);

  const closeEditor = () => {
    setEditing(null);
    setEditingId(null);
  };

  const onSave = () => {
    if (!editing) return;
    save.mutate(
      { ...editing, id: editingId ?? undefined },
      {
        onSuccess: () => {
          closeEditor();
          toast.success(t("catalog.saved"));
        },
        onError: () => toast.error(t("catalog.save_failed")),
      },
    );
  };

  const onDelete = async (p: CatalogPhone) => {
    const ok = await confirm({
      title: t("catalog.confirm_delete", { name: p.model_name }),
      body: t("v2.personal.catalog.deleteBody"),
      confirm: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    remove.mutate(p.id, {
      onSuccess: () => toast.success(t("catalog.deleted")),
      onError: (e) => toast.error(errMsg(e)),
    });
  };

  const handleCopy = async (phone: CatalogPhone, mode: CopyMode) => {
    if (copying !== null) return;
    setCopying({ id: phone.id, mode });
    try {
      if (mode === "marketing") {
        // Text baked into the list response first — keeps the user-gesture alive on Safari/iOS.
        let text = phone.marketing_text_uz || "";
        if (!text) {
          try {
            text = (await fetchPhoneMarketing(phone.id)).text || "";
          } catch (err) {
            console.error("[copy] marketing fetch failed:", err);
          }
        }
        try {
          await copyText(text);
          toast.success(t("catalog.marketing_copied"));
        } catch (err) {
          console.error("[copy] marketing clipboard failed:", err);
          toast.error(`${t("catalog.copy_failed")}: ${errMsg(err)}`);
        }
        return;
      }
      const quote = await fetchPhoneQuote(phone.id);
      if (mode === "text") {
        await copyPhoneTextOnly(quote);
        toast.success(t("catalog.copied_text_only"));
        return;
      }
      if (!quote.cover_image_url) {
        toast.error(t("catalog.no_photo"));
        return;
      }
      try {
        await copyPhoneImageOnly(quote);
        toast.success(t("catalog.photo_copied"));
      } catch (err) {
        console.error("[copy] photo-only failed:", err);
        toast.error(`${t("catalog.copy_failed")}: ${errMsg(err)}`);
      }
    } catch (err) {
      console.error("[copy] handler error:", err);
      toast.error(t("catalog.copy_failed"));
    } finally {
      setCopying(null);
    }
  };

  const filtered = !!search || !!stock || onlyHidden;

  return (
    <>
      <header className="top" style={{ flexWrap: "wrap" }}>
        <h1 className="h1">{canEdit ? t("v2.personal.catalog.titleMg") : t("catalog.title")}</h1>
        {canEdit ? (
          <nav className="seg" aria-label={t("v2.personal.catalog.titleMg")}>
            <Link className="is-on" to="/catalog" aria-current="page">{t("v2.personal.catalog.tabPhones")}</Link>
            <Link to="/catalog/tiers">{t("v2.personal.catalog.tabMore")}</Link>
          </nav>
        ) : null}
        <span className="grow" />
        <div className="inwrap" style={{ width: canEdit ? 240 : 300, maxWidth: "100%" }}>
          <Search className="ic" />
          <input className="input" type="search" placeholder={t("catalog.search_ph")} aria-label={t("catalog.search_ph")} value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </div>
        {!canEdit ? (
          <div className="seg" role="group">
            {STOCKS.map((s) => (
              <button key={s} type="button" className={cx(stock === s && "is-on")} aria-pressed={stock === s} onClick={() => setStock(s)}>
                {t(s === "" ? "catalog.stock_all" : `catalog.stock_${s}`)}
              </button>
            ))}
          </div>
        ) : (
          <button className="btn btn-pri" type="button" onClick={() => { setEditing(emptyDraft()); setEditingId(null); }}>
            <Plus className="ic" />
            {t("catalog.new_phone")}
          </button>
        )}
      </header>

      <main className="page">
        {canEdit ? (
          <div className="row g8 wrap">
            {STOCKS.map((s) => (
              <button key={s} type="button" className={cx("chip", !onlyHidden && stock === s && "is-on")} aria-pressed={!onlyHidden && stock === s} onClick={() => { setOnlyHidden(false); setStock(s); }}>
                {t(s === "" ? "catalog.stock_all" : `catalog.stock_${s}`)}
              </button>
            ))}
            <button type="button" className={cx("chip", onlyHidden && "is-on")} aria-pressed={onlyHidden} onClick={() => { setStock(""); setOnlyHidden((v) => !v); }}>
              <EyeOff className="ic ic-s" />
              {t("v2.personal.catalog.hiddenChip")}
            </button>
          </div>
        ) : null}

        {phones.isLoading ? (
          <section className="card"><LoadingBlock rows={5} onRetry={() => phones.refetch()} /></section>
        ) : phones.isError ? (
          <section className="card"><ErrorState error={phones.error} onRetry={() => phones.refetch()} /></section>
        ) : list.length === 0 ? (
          <section className="card">
            {filtered ? (
              <EmptyState
                icon={<Search className="ic ic-l" />}
                title={t("v2.personal.catalog.searchEmptyTitle")}
                body={t("v2.personal.catalog.searchEmptyBody")}
                action={<button className="btn" type="button" onClick={() => { setSearchInput(""); setSearch(""); setStock(""); setOnlyHidden(false); }}>{t("v2.personal.catalog.reset")}</button>}
              />
            ) : (
              <EmptyState
                icon={<Smartphone className="ic ic-l" />}
                title={t("catalog.empty_title")}
                body={t("catalog.empty_hint")}
                action={canEdit ? <button className="btn btn-pri" type="button" onClick={() => { setEditing(emptyDraft()); setEditingId(null); }}><Plus className="ic" />{t("catalog.new_phone")}</button> : undefined}
              />
            )}
          </section>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 }}>
            {list.map((p) => (
              <PhoneCard
                key={p.id}
                p={p}
                t={t}
                canEdit={canEdit}
                copying={copying}
                onCopy={(mode) => handleCopy(p, mode)}
                onEdit={() => { setEditing(draftFrom(p)); setEditingId(p.id); }}
                onToggle={() => toggle.mutate({ id: p.id, is_active: !p.is_active }, { onError: (e) => toast.error(errMsg(e)) })}
                onDelete={() => onDelete(p)}
              />
            ))}
          </div>
        )}

        {!canEdit && list.length > 0 ? <p className="s c3">{t("v2.personal.catalog.copyHint")}</p> : null}
      </main>

      {editing && canEdit ? (
        <PhoneEditorDialog draft={editing} onChange={setEditing} onSave={onSave} onCancel={closeEditor} saving={save.isPending} />
      ) : null}
      {confirm.node}
    </>
  );
}

/* ───────────────────────── card ───────────────────────── */

function PhoneCard({
  p,
  t,
  canEdit,
  copying,
  onCopy,
  onEdit,
  onToggle,
  onDelete,
}: {
  p: CatalogPhone;
  t: T;
  canEdit: boolean;
  copying: { id: number; mode: CopyMode } | null;
  onCopy: (m: CopyMode) => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const hidden = !p.is_active;
  const mem = [p.storage_gb ? `${p.storage_gb}GB` : "", p.ram_gb ? `${p.ram_gb}GB RAM` : ""].filter(Boolean).join(" / ");
  const busy = copying !== null;
  const isBusy = (m: CopyMode) => copying?.id === p.id && copying.mode === m;
  const preview = p.installment_preview ?? [];

  return (
    <section className="card col" style={{ overflow: "hidden", opacity: hidden ? 0.6 : 1 }}>
      <PhoneImages p={p} t={t} />
      <div className="col g8" style={{ padding: "12px 14px 14px", flex: "1 1 auto" }}>
        <div className="row between g8" style={{ alignItems: "flex-start" }}>
          <span className="col" style={{ minWidth: 0 }}>
            <span className="h3 trunc" title={`${p.brand} ${p.model_name}`}>{p.brand} {p.model_name}</span>
            {mem ? <span className="xs c3 num">{mem}</span> : null}
          </span>
          <span className={cx("badge", stockTone(p.stock_status))}>{t(`catalog.stock_${p.stock_status}`)}</span>
        </div>
        {p.colors.length > 0 ? (
          <div className="row g4 wrap">
            {p.colors.slice(0, 5).map((c, i) => (
              <span key={c.id ?? i} className="row g4 xs" style={{ padding: "1px 7px", borderRadius: 99, background: "var(--surface-3)" }} title={c.name}>
                {c.hex_code ? <i style={{ display: "block", width: 9, height: 9, borderRadius: "50%", background: c.hex_code, border: "1px solid var(--line-2)" }} /> : null}
                {c.name}
              </span>
            ))}
          </div>
        ) : null}
        <span className="num w6" style={{ fontSize: 17 }}>
          {fmtNum(p.price)} <span className="xs c3">{t("v2.personal.catalog.sum")}</span>
        </span>
        {preview.length > 0 ? (
          <div className="col g4">
            <span className="lbl" style={{ fontSize: 10 }}>{t("catalog.installment_preview_title")}</span>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${preview.length}, minmax(0, 1fr))`, gap: 4 }}>
              {preview.map((row) => (
                <span key={row.months} className="col" style={{ padding: "5px 4px", borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--line)", textAlign: "center" }}>
                  <span className="xs w6">{row.months} {t("catalog.month_short")}</span>
                  <span className="num" style={{ fontSize: 11 }}>{fmtNum(row.monthly)}</span>
                  <span className="c3" style={{ fontSize: 10 }}>{t("catalog.installment_from")}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {hidden && canEdit ? <span className="badge" style={{ alignSelf: "flex-start" }}>{t("v2.personal.catalog.hiddenBadge")}</span> : null}
        <span className="grow" />
        <div className="row g4">
          <button className="btn btn-sm grow" style={{ minWidth: 0, padding: "0 6px" }} type="button" disabled={busy} aria-busy={isBusy("text")} title={t("catalog.copy_text")} onClick={() => onCopy("text")}>
            {isBusy("text") ? t("catalog.copying") : t("catalog.copy_text")}
          </button>
          <button className="btn btn-sm grow" style={{ minWidth: 0, padding: "0 6px" }} type="button" disabled={busy || !p.cover_image_url} aria-busy={isBusy("photo")} title={p.cover_image_url ? t("catalog.copy_photo") : t("catalog.no_photo")} onClick={() => onCopy("photo")}>
            {isBusy("photo") ? t("catalog.copying") : t("catalog.copy_photo")}
          </button>
          <button className="btn btn-sm grow" style={{ minWidth: 0, padding: "0 6px" }} type="button" disabled={busy} aria-busy={isBusy("marketing")} title={t("catalog.copy_marketing")} onClick={() => onCopy("marketing")}>
            {isBusy("marketing") ? t("catalog.copying") : canEdit ? t("catalog.copy_marketing") : t("v2.personal.catalog.copyAd")}
          </button>
        </div>
        {canEdit ? (
          <div className="row g4" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
            <button className="btn btn-sm btn-ghost grow" type="button" onClick={onEdit}>
              <Pencil className="ic ic-s" />
              {t("v2.personal.catalog.edit")}
            </button>
            <button className="btn btn-sm btn-ghost" type="button" title={hidden ? t("catalog.show") : t("catalog.hide")} onClick={onToggle}>
              {hidden ? <Eye className="ic ic-s" /> : <EyeOff className="ic ic-s" />}
              {hidden ? t("v2.personal.catalog.show") : t("v2.personal.catalog.hide")}
            </button>
            <button className="btn btn-sm btn-ghost btn-sq" type="button" aria-label={`${t("common.delete")} ${p.model_name}`} title={t("common.delete")} style={{ color: "var(--bad)" }} onClick={onDelete}>
              <Trash2 className="ic ic-s" />
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Cover + gallery thumbnails. Every image is a copy button (straight into Telegram). */
function PhoneImages({ p, t }: { p: CatalogPhone; t: T }) {
  const mainUrl = p.cover_image_url ?? p.gallery[0]?.photo_url ?? null;
  const thumbs: { key: string; url: string }[] = [];
  if (p.cover_image_url) thumbs.push({ key: "cover", url: p.cover_image_url });
  for (const g of p.gallery) thumbs.push({ key: `g-${g.id}`, url: g.photo_url });

  const copyOne = async (url: string) => {
    try {
      await copyImageByUrl(url);
      toast.success(t("catalog.photo_copied"));
    } catch (err) {
      console.error("[copy] image failed", err);
      toast.error(`${t("catalog.copy_failed")}: ${errMsg(err)}`);
    }
  };

  return (
    <>
      <div className="ph" style={{ height: 150, borderRadius: 0, border: 0, borderBottom: "1px solid var(--line)", position: "relative", overflow: "hidden" }}>
        {mainUrl ? (
          <button type="button" title={t("catalog.click_to_copy")} aria-label={`${t("catalog.click_to_copy")}: ${p.model_name}`} onClick={() => copyOne(mainUrl)} style={{ position: "absolute", inset: 0, border: 0, padding: 0, background: "transparent", cursor: "copy" }}>
            <img src={mainUrl} alt={p.model_name} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
          </button>
        ) : (
          <>
            <Smartphone className="ic ic-xl" />
            {t("catalog.no_photo")}
          </>
        )}
        <span className="num xs" style={{ position: "absolute", top: 8, right: 8, padding: "1px 6px", borderRadius: 5, background: "var(--surface)", pointerEvents: "none" }}>
          {thumbs.length ? t("v2.personal.catalog.photoCount", { i: 1, n: thumbs.length }) : t("v2.personal.catalog.noPhotos")}
        </span>
      </div>
      {thumbs.length > 1 ? (
        <div className="row g6" style={{ padding: "8px 14px 0", overflowX: "auto" }}>
          {thumbs.map((th, i) => (
            <button
              key={th.key}
              type="button"
              title={t("catalog.click_to_copy")}
              aria-label={`${t("catalog.click_to_copy")} #${i + 1}`}
              onClick={() => copyOne(th.url)}
              style={{ flex: "none", width: 40, height: 40, padding: 0, borderRadius: 8, overflow: "hidden", border: "1px solid var(--line-2)", background: "var(--surface-2)", cursor: "copy" }}
            >
              <img src={th.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/* ───────────────────────── editor (old PhoneEditor) ───────────────────────── */

function NumField({ id, label, value, onChange, placeholder }: { id: string; label: string; value: number | null; onChange: (v: number | null) => void; placeholder: string }) {
  return (
    <div className="field grow" style={{ flexBasis: 0 }}>
      <label htmlFor={id}>{label}</label>
      <input className="input num" id={id} type="number" inputMode="numeric" value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} />
    </div>
  );
}

function useBlobUrls(files: File[]) {
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return urls;
}

const isImage = (f: File) => f.type.startsWith("image/");
const GALLERY_MAX = 10;

function PhoneEditorDialog({ draft, onChange, onSave, onCancel, saving }: { draft: CatalogPhoneDraft; onChange: (d: CatalogPhoneDraft) => void; onSave: () => void; onCancel: () => void; saving: boolean }) {
  const t = useT2();
  const set = <K extends keyof CatalogPhoneDraft>(k: K, v: CatalogPhoneDraft[K]) => onChange({ ...draft, [k]: v });

  // keep latest draft for the window-level paste handler
  const latest = useRef(draft);
  latest.current = draft;

  /* cover */
  const coverInput = useRef<HTMLInputElement | null>(null);
  const [camera, setCamera] = useState<null | "cover" | "gallery">(null);
  const [coverDrag, setCoverDrag] = useState(false);
  const coverBlob = useBlobUrls(useMemo(() => (draft.cover_image_file ? [draft.cover_image_file] : []), [draft.cover_image_file]));
  const coverPreview = coverBlob[0] ?? draft.cover_image_url;
  const pickCover = useCallback(
    (f: File | null | undefined) => {
      if (!f || !isImage(f)) return;
      onChange({ ...latest.current, cover_image_file: f });
    },
    [onChange],
  );

  // Ctrl/Cmd+V of an image while the editor is open → cover (as the old PhotoUploader did).
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const target = e.target as HTMLElement | null;
      const isTextField = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.getAttribute("contenteditable") === "true");
      const item = Array.from(e.clipboardData.items).find((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (!item) return;
      if (isTextField && !e.clipboardData.files.length) return;
      const f = item.getAsFile();
      if (!f) return;
      e.preventDefault();
      pickCover(f);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [pickCover]);

  /* gallery */
  const galleryInput = useRef<HTMLInputElement | null>(null);
  const [galleryDrag, setGalleryDrag] = useState(false);
  const newUrls = useBlobUrls(draft.new_gallery_files);
  const canAddMore = draft.new_gallery_files.length < GALLERY_MAX;
  const addGallery = (incoming: File[] | FileList | null) => {
    if (!incoming) return;
    const list = Array.from(incoming).filter(isImage);
    if (!list.length) return;
    const cur = latest.current;
    const slots = Math.max(0, GALLERY_MAX - cur.new_gallery_files.length);
    onChange({ ...cur, new_gallery_files: [...cur.new_gallery_files, ...list.slice(0, slots)] });
  };
  const deleteIds = draft.gallery_delete_ids ?? [];
  const toggleExisting = (id: number) =>
    set("gallery_delete_ids", deleteIds.includes(id) ? deleteIds.filter((x) => x !== id) : [...deleteIds, id]);

  /* specs (index-keyed rows, same semantics as the old editor) */
  const specEntries = Object.entries(draft.specs_json || {});
  const rebuild = (entries: [string, string][]) => {
    const obj: Record<string, string> = {};
    for (const [k, v] of entries) if (k) obj[k] = v;
    set("specs_json", obj);
  };
  const setSpecKey = (idx: number, k: string) => rebuild(specEntries.map(([kk, v], i): [string, string] => (i === idx ? [k, v] : [kk, v])));
  const setSpecValue = (idx: number, v: string) => rebuild(specEntries.map(([k, vv], i): [string, string] => (i === idx ? [k, v] : [k, vv])));
  const addSpec = () => {
    let n = 1;
    while (Object.prototype.hasOwnProperty.call(draft.specs_json, `field_${n}`)) n += 1;
    set("specs_json", { ...(draft.specs_json || {}), [`field_${n}`]: "" });
  };
  const removeSpec = (idx: number) => {
    const obj: Record<string, string> = {};
    specEntries.filter((_, i) => i !== idx).forEach(([k, v]) => (obj[k] = v));
    set("specs_json", obj);
  };

  /* colors */
  const addColor = () => set("colors", [...draft.colors, { name: "", hex_code: "", price_override: null, is_available: true, sort_order: draft.colors.length }]);
  const updateColor = (i: number, patch: Partial<CatalogPhoneColor>) => set("colors", draft.colors.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const removeColor = (i: number) => set("colors", draft.colors.filter((_, j) => j !== i));

  const canSave = !!draft.brand.trim() && !!draft.model_name.trim() && Number(draft.price) > 0 && !saving;

  const onCoverDrop = (e: DragEvent) => {
    e.preventDefault();
    setCoverDrag(false);
    pickCover(e.dataTransfer.files?.[0]);
  };
  const onGalleryDrop = (e: DragEvent) => {
    e.preventDefault();
    setGalleryDrag(false);
    if (canAddMore) addGallery(e.dataTransfer.files);
  };

  return (
    <>
      <Dialog
        open
        onClose={onCancel}
        title={t("catalog.editor_title")}
        width={640}
        footer={
          <>
            {!canSave && !saving ? <span className="xs c3 grow">{t("v2.personal.catalog.saveHint")}</span> : <span className="grow" />}
            <button className="btn" type="button" onClick={onCancel}>{t("common.cancel")}</button>
            <button className="btn btn-pri" type="button" disabled={!canSave} onClick={onSave}>
              {saving ? t("v2.personal.catalog.saving") : t("common.save")}
            </button>
          </>
        }
      >
        <div className="col g16" style={{ maxHeight: "calc(100vh - 230px)", overflowY: "auto", margin: "0 -22px", padding: "2px 22px" }}>
        <div className="row g8 wrap">
          <div className="field grow" style={{ flexBasis: 200 }}>
            <label htmlFor="pe-brand">{t("catalog.brand")}</label>
            <input className="input" id="pe-brand" value={draft.brand} placeholder="Apple" onChange={(e) => set("brand", e.target.value)} />
          </div>
          <div className="field grow" style={{ flexBasis: 200 }}>
            <label htmlFor="pe-model">{t("catalog.model_name")}</label>
            <input className="input" id="pe-model" value={draft.model_name} placeholder="iPhone 17 Pro Max" onChange={(e) => set("model_name", e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="pe-tag">{t("catalog.tagline")}</label>
          <input className="input" id="pe-tag" value={draft.tagline} placeholder={t("catalog.tagline_ph")} onChange={(e) => set("tagline", e.target.value)} />
        </div>
        <div className="row g8 wrap">
          <NumField id="pe-storage" label={t("catalog.storage")} value={draft.storage_gb} placeholder="256" onChange={(v) => set("storage_gb", v)} />
          <NumField id="pe-ram" label={t("catalog.ram")} value={draft.ram_gb} placeholder="8" onChange={(v) => set("ram_gb", v)} />
          <div className="field grow" style={{ flexBasis: 0 }}>
            <label htmlFor="pe-stock">{t("catalog.stock")}</label>
            <select className="input" id="pe-stock" value={draft.stock_status} onChange={(e) => set("stock_status", e.target.value as StockStatus)}>
              <option value="available">{t("catalog.stock_available")}</option>
              <option value="on_order">{t("catalog.stock_on_order")}</option>
              <option value="out">{t("catalog.stock_out")}</option>
            </select>
          </div>
        </div>
        <div className="row g8 wrap">
          <NumField id="pe-cam" label={t("catalog.camera_mp")} value={draft.camera_mp} placeholder="108" onChange={(v) => set("camera_mp", v)} />
          <NumField id="pe-bat" label={t("catalog.battery_mah")} value={draft.battery_mah} placeholder="7000" onChange={(v) => set("battery_mah", v)} />
          <div className="field grow" style={{ flexBasis: 0 }}>
            <label htmlFor="pe-price">{t("catalog.price")}</label>
            <NumericInput className="input num" value={draft.price} placeholder="22 500 000" onChange={(v) => set("price", v)} />
          </div>
        </div>

        {/* cover */}
        <div className="field">
          <label>{t("catalog.cover_photo")}</label>
          <div
            className="row g8 wrap"
            onDragOver={(e) => {
              e.preventDefault();
              setCoverDrag(true);
            }}
            onDragLeave={() => setCoverDrag(false)}
            onDrop={onCoverDrop}
            style={{ padding: 6, margin: -6, borderRadius: 12, outline: coverDrag ? "2px dashed var(--brand)" : undefined }}
          >
            {coverPreview ? (
              <span style={{ position: "relative", width: 72, height: 72, flex: "none" }}>
                <img src={coverPreview} alt={t("catalog.cover_photo")} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 11, border: "1px solid var(--line)" }} />
                {draft.cover_image_file ? (
                  <button className="btn btn-sq btn-sm" type="button" aria-label={t("common.remove")} title={t("common.remove")} onClick={() => set("cover_image_file", null)} style={{ position: "absolute", top: -8, right: -8, width: 24, height: 24, borderRadius: 99 }}>
                    <X className="ic ic-s" />
                  </button>
                ) : null}
              </span>
            ) : (
              <div className="ph" style={{ width: 72, height: 72 }}>{t("catalog.cover_photo")}</div>
            )}
            <button className="btn btn-sm" type="button" onClick={() => coverInput.current?.click()}>
              <Upload className="ic ic-s" />
              {coverPreview ? t("v2.personal.catalog.replace") : t("v2.personal.catalog.pickFile")}
            </button>
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => setCamera("cover")}>
              <Camera className="ic ic-s" />
              {t("photo.use_camera")}
            </button>
          </div>
          <span className="hint">{t("catalog.cover_photo_hint")} {t("v2.personal.catalog.pasteHint")}</span>
          <input ref={coverInput} type="file" accept="image/*" hidden onChange={(e) => { pickCover(e.target.files?.[0]); e.target.value = ""; }} />
        </div>

        {/* gallery */}
        <div className="field">
          <label>
            {t("catalog.gallery")} <span className="xs c3 num" style={{ fontWeight: 400 }}>{draft.new_gallery_files.length}/{GALLERY_MAX}</span>
          </label>
          <div
            className="row g6 wrap"
            onDragOver={(e) => {
              if (!canAddMore) return;
              e.preventDefault();
              setGalleryDrag(true);
            }}
            onDragLeave={() => setGalleryDrag(false)}
            onDrop={onGalleryDrop}
            style={{ padding: 6, margin: -6, borderRadius: 12, outline: galleryDrag ? "2px dashed var(--brand)" : undefined }}
          >
            {draft.gallery.map((g, i) => {
              const del = deleteIds.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  className="chip"
                  aria-pressed={del}
                  title={t("v2.personal.catalog.removeOnSave")}
                  onClick={() => toggleExisting(g.id)}
                  style={del ? { textDecoration: "line-through", opacity: 0.6 } : undefined}
                >
                  <img src={g.photo_url} alt="" style={{ width: 20, height: 20, borderRadius: 4, objectFit: "cover" }} />#{i + 1}
                  <X className="ic ic-s" />
                </button>
              );
            })}
            {draft.new_gallery_files.map((f, i) => (
              <span key={`${i}-${f.name}`} className="chip">
                {newUrls[i] ? <img src={newUrls[i]} alt="" style={{ width: 20, height: 20, borderRadius: 4, objectFit: "cover" }} /> : null}
                <span className="xs c3">{t("v2.personal.catalog.newFile")}</span>
                <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("common.remove")} style={{ width: 20, height: 20 }} onClick={() => set("new_gallery_files", draft.new_gallery_files.filter((_, j) => j !== i))}>
                  <X className="ic ic-s" />
                </button>
              </span>
            ))}
            {canAddMore ? (
              <>
                <button className="chip" type="button" style={{ borderStyle: "dashed" }} onClick={() => galleryInput.current?.click()}>
                  <Upload className="ic ic-s" />
                  {t("v2.personal.catalog.pickFiles")}
                </button>
                <button className="chip" type="button" style={{ borderStyle: "dashed" }} onClick={() => setCamera("gallery")}>
                  <Camera className="ic ic-s" />
                  {t("photo.use_camera")}
                </button>
              </>
            ) : null}
          </div>
          <span className="hint">{canAddMore ? t("catalog.gallery_hint") : t("v2.personal.catalog.galleryFull")}</span>
          <input ref={galleryInput} type="file" accept="image/*" multiple hidden onChange={(e) => { addGallery(e.target.files); e.target.value = ""; }} />
        </div>

        {/* specs */}
        <div className="field">
          <label>{t("catalog.specs")}</label>
          {specEntries.map(([key, value], i) => (
            <div key={i} className="row g6">
              <input className="input num" style={{ width: 130, flex: "none" }} placeholder={t("catalog.spec_key_ph")} aria-label={t("v2.personal.catalog.specKey")} value={key} onChange={(e) => setSpecKey(i, e.target.value)} />
              <input className="input grow" placeholder={t("catalog.spec_value_ph")} aria-label={t("v2.personal.catalog.specValue")} value={value} onChange={(e) => setSpecValue(i, e.target.value)} />
              <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.personal.catalog.removeSpec")} onClick={() => removeSpec(i)}>
                <X className="ic ic-s" />
              </button>
            </div>
          ))}
          {specEntries.length === 0 ? <span className="hint">{t("catalog.no_specs")}</span> : null}
          <button className="btn btn-sm btn-ghost" type="button" style={{ alignSelf: "flex-start" }} onClick={addSpec}>
            <Plus className="ic ic-s" />
            {t("catalog.add_spec")}
          </button>
        </div>

        {/* colors */}
        <div className="field">
          <label>{t("catalog.colors")}</label>
          {draft.colors.map((c, i) => (
            <div key={i} className="row g6">
              <input className="input grow" placeholder={t("catalog.color_name_ph")} aria-label={t("v2.personal.catalog.colorName")} value={c.name} onChange={(e) => updateColor(i, { name: e.target.value })} />
              <input
                type="color"
                title={t("catalog.color_hex")}
                aria-label={t("catalog.color_hex")}
                value={c.hex_code || "#888888"}
                onChange={(e) => updateColor(i, { hex_code: e.target.value })}
                style={{ width: 40, height: 40, padding: 2, borderRadius: 9, border: "1px solid var(--line-2)", background: "var(--surface)", flex: "none", cursor: "pointer" }}
              />
              <span className="num xs c3" style={{ width: 70, flex: "none" }}>{c.hex_code || "—"}</span>
              <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.personal.catalog.removeColor")} onClick={() => removeColor(i)}>
                <X className="ic ic-s" />
              </button>
            </div>
          ))}
          {draft.colors.length === 0 ? <span className="hint">{t("catalog.no_colors")}</span> : null}
          <button className="btn btn-sm btn-ghost" type="button" style={{ alignSelf: "flex-start" }} onClick={addColor}>
            <Plus className="ic ic-s" />
            {t("catalog.add_color")}
          </button>
        </div>

        <div className="field">
          <label htmlFor="pe-desc">{t("catalog.description")}</label>
          <textarea className="input" id="pe-desc" rows={2} value={draft.description} onChange={(e) => set("description", e.target.value)} />
        </div>
        <label className="row g8 s">
          <input className="check" type="checkbox" checked={draft.is_active} onChange={(e) => set("is_active", e.target.checked)} />
          {t("catalog.active")}
        </label>
        </div>
      </Dialog>

      {camera ? (
        <CameraCapture
          onCapture={(f) => {
            if (camera === "cover") pickCover(f);
            else addGallery([f]);
            setCamera(null);
          }}
          onCancel={() => setCamera(null)}
        />
      ) : null}
    </>
  );
}
