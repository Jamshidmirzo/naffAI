/**
 * Attendance photos gallery — superadmin/manager surface.
 *
 * Endpoint: `GET /api/attendance/photos/` (paginated,
 * LimitOffsetPagination). Показывает все фото check-in / check-out
 * с фильтрами по дате и оператору.
 *
 * Auth: RoleGate allow=["manager"] на роуте (`superadmin` в UI
 * тоже манагер благодаря normaliseRole). Backend отсеивает operator'ов.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Calendar, RefreshCw, User as UserIcon, X } from "lucide-react";
import { api, API_BASE_URL } from "../lib/api";
import { Button, Eyebrow, StatusBadge } from "../components/ui";
import { Select } from "../components/Select";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface Operator {
  id: number;
  full_name: string;
}

interface PhotoRow {
  log_id: number;
  operator_id: number;
  operator_name: string;
  date: string; // YYYY-MM-DD (Tashkent)
  checked_in_at: string;
  checked_out_at: string | null;
  checkin_photo_url: string | null;
  checkin_photo_thumb: string | null;
  checkout_photo_url: string | null;
  checkout_photo_thumb: string | null;
  was_late: boolean;
  auto_closed: boolean;
  manually_closed: boolean;
  source: "qr" | "tg" | "manual";
  duration_min: number | null;
}

interface PhotosPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: PhotoRow[];
}

function absoluteMediaUrl(u: string | null): string | null {
  if (!u) return null;
  if (u.startsWith("http")) return u;
  return `${API_BASE_URL.replace(/\/api$/, "")}${u}`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tashkent",
  });
}

function fmtDateHeader(dateStr: string, t: (k: string) => string): string {
  // Convert YYYY-MM-DD → human header. Compares to today/yesterday in
  // Tashkent-local for the row grouping. We rely on the API returning
  // `date` already localized (see selector).
  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Tashkent",
  }); // "YYYY-MM-DD"
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tashkent" });
  })();
  if (dateStr === today) return t("attendance.photos.today");
  if (dateStr === yesterday) return t("attendance.photos.yesterday");
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Fullscreen click-to-zoom overlay. Inline (no dep) to match the same
 * pattern already used in AttendanceToday.
 */
function PhotoLightbox({
  url,
  alt,
  onClose,
}: {
  url: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[300] grid place-items-center p-6"
      style={{ background: "rgba(0,0,0,.9)" }}
      onClick={onClose}
    >
      <div className="relative max-w-[92vw] max-h-[92vh]">
        <img
          src={url}
          alt={alt}
          className="max-w-[92vw] max-h-[92vh] rounded-2xl"
          onClick={(e) => e.stopPropagation()}
        />
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 rounded-full bg-white text-black grid place-items-center"
          style={{ width: 36, height: 36 }}
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

function PhotoThumb({
  url,
  label,
  onOpen,
}: {
  url: string | null;
  label: string;
  onOpen: (u: string) => void;
}) {
  const abs = absoluteMediaUrl(url);
  if (!abs) {
    return (
      <div
        className="grid place-items-center rounded-xl text-[10px] text-muted"
        style={{
          width: 88,
          height: 88,
          background: "var(--faint)",
          border: "1px dashed var(--border)",
        }}
      >
        —
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(abs)}
      className="relative overflow-hidden rounded-xl transition hover:ring-2 hover:ring-[var(--accent)]"
      style={{ width: 88, height: 88 }}
      title={label}
    >
      <img src={abs} alt={label} className="w-full h-full object-cover" />
      <span
        className="absolute bottom-0 left-0 right-0 text-white text-[10px] font-semibold text-center py-0.5"
        style={{ background: "linear-gradient(0deg,rgba(0,0,0,.7),transparent)" }}
      >
        {label}
      </span>
    </button>
  );
}

function PhotoRowCard({
  row,
  onOpen,
  t,
}: {
  row: PhotoRow;
  onOpen: (u: string) => void;
  t: (k: string) => string;
}) {
  const durationLabel =
    row.duration_min !== null
      ? `${Math.floor(row.duration_min / 60)} ч ${row.duration_min % 60} мин`
      : "—";
  return (
    <div
      className="nf-card p-4 flex flex-col gap-3"
      style={{ borderRadius: 16 }}
    >
      <div className="flex items-start gap-3">
        <PhotoThumb
          url={row.checkin_photo_thumb}
          label={t("attendance.photos.checkin")}
          onOpen={onOpen}
        />
        <PhotoThumb
          url={row.checkout_photo_thumb}
          label={t("attendance.photos.checkout")}
          onOpen={onOpen}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold truncate">
            {row.operator_name}
          </div>
          <div className="mt-1 text-[12px] text-muted tabular-nums">
            {fmtTime(row.checked_in_at)} → {fmtTime(row.checked_out_at)}
          </div>
          <div className="mt-1 text-[11px] text-muted">
            {t("attendance.photos.duration")}: <b className="text-text">{durationLabel}</b>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {row.was_late && (
              <StatusBadge tone="hot">
                {t("attendance.photos.late_badge")}
              </StatusBadge>
            )}
            <span className="text-[10px] uppercase tracking-widest text-muted">
              {row.source}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const PAGE_SIZE = 24;

export default function AttendancePhotos() {
  const t = useT();
  usePageHeader(
    {
      title: t("attendance.photos.title"),
      subtitle: t("attendance.photos.subtitle"),
    },
    [t("attendance.photos.title")]
  );

  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Tashkent",
  });

  const [dateFrom, setDateFrom] = useState<string>(today);
  const [dateTo, setDateTo] = useState<string>(today);
  const [operatorId, setOperatorId] = useState<number | "">("");
  const [offset, setOffset] = useState<number>(0);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Reset offset when filters change.
  useEffect(() => {
    setOffset(0);
  }, [dateFrom, dateTo, operatorId]);

  const operatorsQuery = useQuery({
    queryKey: ["operators-list-for-photos"],
    queryFn: () =>
      api
        .get<Operator[] | { results: Operator[] }>("/operators/")
        .then((r) => (Array.isArray(r.data) ? r.data : r.data.results ?? [])),
    staleTime: 60 * 60_000,
  });

  const photosQuery = useQuery<PhotosPage>({
    queryKey: [
      "attendance-photos",
      { dateFrom, dateTo, operatorId, offset },
    ],
    queryFn: () => {
      const params: Record<string, string | number> = {
        limit: PAGE_SIZE,
        offset,
      };
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      if (operatorId) params.operator = operatorId;
      return api
        .get<PhotosPage>("/attendance/photos/", { params })
        .then((r) => r.data);
    },
    placeholderData: keepPreviousData,
    // Живое обновление для «сегодня» — если фильтр = today, обновляем
    // раз в 60с чтобы новые check-in'ы всплывали автоматически.
    refetchInterval: dateFrom === today && dateTo === today ? 60_000 : false,
  });

  const rows = photosQuery.data?.results ?? [];
  const total = photosQuery.data?.count ?? 0;

  // Group rows by date for section headers.
  const grouped = useMemo(() => {
    const map = new Map<string, PhotoRow[]>();
    for (const r of rows) {
      const list = map.get(r.date) ?? [];
      list.push(r);
      map.set(r.date, list);
    }
    return Array.from(map.entries()); // insertion-ordered = API order (newest first)
  }, [rows]);

  const resetFilters = () => {
    setDateFrom(today);
    setDateTo(today);
    setOperatorId("");
  };

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Hero */}
      <section
        className="nf-hero animate-nfFadeUp"
        style={{
          borderRadius: 24,
          padding: "22px 28px",
          border: "1px solid var(--border)",
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <Eyebrow>ATTENDANCE PHOTOS</Eyebrow>
            <div
              className="font-semibold mt-2"
              style={{ fontSize: 22, letterSpacing: "-0.025em" }}
            >
              {t("attendance.photos.title")}
            </div>
            <div className="text-[13px] text-muted mt-1">
              {t("attendance.photos.subtitle")}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-widest text-muted">
              Всего
            </div>
            <div className="text-[24px] font-semibold tabular-nums">{total}</div>
          </div>
        </div>
      </section>

      {/* Filter bar */}
      <section className="nf-card p-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="nf-col flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5" />{" "}
            {t("attendance.photos.filter_date_from")}
          </span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="nf-input py-2 px-3.5 w-auto text-[13px]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="nf-col flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5" />{" "}
            {t("attendance.photos.filter_date_to")}
          </span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="nf-input py-2 px-3.5 w-auto text-[13px]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="nf-col flex items-center gap-1.5">
            <UserIcon className="w-3.5 h-3.5" />{" "}
            {t("attendance.photos.filter_operator")}
          </span>
          <Select<string>
            className="min-w-[220px]"
            value={operatorId === "" ? "" : String(operatorId)}
            onChange={(v) => setOperatorId(v ? Number(v) : "")}
            options={[
              { value: "", label: t("attendance.photos.filter_operator_all") },
              ...(operatorsQuery.data ?? []).map((op) => ({
                value: String(op.id),
                label: op.full_name,
              })),
            ]}
            ariaLabel={t("attendance.photos.filter_operator")}
            searchable={(operatorsQuery.data ?? []).length > 8}
          />
        </label>
        <div className="flex items-center gap-2 ml-auto">
          <Button variant="ghost" onClick={resetFilters}>
            {t("attendance.photos.filter_reset")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => photosQuery.refetch()}
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </section>

      {/* Grid */}
      <section className="flex flex-col gap-5">
        {photosQuery.isPending && (
          <div className="p-8 text-center text-[13px] text-muted">
            {t("attendance.photos.loading")}
          </div>
        )}
        {!photosQuery.isPending && rows.length === 0 && (
          <div className="nf-card p-10 text-center text-[13px] text-muted">
            {t("attendance.photos.empty")}
          </div>
        )}
        {grouped.map(([date, group]) => (
          <div key={date} className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="text-[13.5px] font-semibold tracking-tight">
                {fmtDateHeader(date, t)}
              </div>
              <span
                className="rounded-full px-2 py-0.5 text-[10.5px] font-bold text-muted"
                style={{ background: "var(--faint)" }}
              >
                {group.length}
              </span>
            </div>
            <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
              {group.map((row) => (
                <PhotoRowCard
                  key={row.log_id}
                  row={row}
                  onOpen={(u) => setLightboxUrl(u)}
                  t={t}
                />
              ))}
            </div>
          </div>
        ))}

        {/* Prev / next пагинация — по PAGE_SIZE (24) фото на страницу.
            Держим прокрутку в верху карточки: `scrollTo(0)` при смене. */}
        {(photosQuery.data?.next || photosQuery.data?.previous) && (
          <div className="flex items-center justify-center gap-3 pt-3 text-[13px] tabular-nums">
            <Button
              variant="ghost"
              disabled={!photosQuery.data?.previous || photosQuery.isFetching}
              onClick={() => {
                setOffset((o) => Math.max(0, o - PAGE_SIZE));
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              ←
            </Button>
            <div className="text-muted">
              {offset + 1}–{Math.min(offset + rows.length, total)} / {total}
            </div>
            <Button
              variant="ghost"
              disabled={!photosQuery.data?.next || photosQuery.isFetching}
              onClick={() => {
                setOffset((o) => o + PAGE_SIZE);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              →
            </Button>
          </div>
        )}
      </section>

      {lightboxUrl && (
        <PhotoLightbox
          url={lightboxUrl}
          alt="attendance"
          onClose={() => setLightboxUrl(null)}
        />
      )}
    </div>
  );
}
