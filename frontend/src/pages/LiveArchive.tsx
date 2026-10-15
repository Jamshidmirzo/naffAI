/**
 * LiveArchive — manager-only list of finished recordings (video-only
 * mp4, chunked by the hour) with inline playback via presigned URLs.
 * Filters: operator + date range; server-side limit/offset paging.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  formatBytes,
  formatDuration,
  formatRecordingStart,
  type RecordingRow,
} from "../lib/liveRoom";
import { useLiveConfig, useLiveRecordings } from "../lib/liveQueries";
import { api } from "../lib/api";
import { Paginator } from "../components/Paginator";
import RecordingPlayer from "../components/live/RecordingPlayer";
import { usePageHeader } from "../store/page";
import { useLangValue, useT } from "../lib/i18n";

type OperatorRow = { id: number; full_name: string };

const PAGE_SIZE = 50;
const DEFAULT_RETENTION_DAYS = 30;

export default function LiveArchive() {
  const t = useT();
  const lang = useLangValue();
  const config = useLiveConfig();
  const retention = config.data?.retention_days ?? DEFAULT_RETENTION_DAYS;
  usePageHeader(
    { title: t("live.archive.title"), subtitle: t("live.archive.retention", { n: retention }) },
    [lang, retention],
  );

  const [operatorId, setOperatorId] = useState<number | null>(null);
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [page, setPage] = useState(1);
  const [playing, setPlaying] = useState<RecordingRow | null>(null);

  // Operators dropdown — /operators/ returns either an array or {results}.
  const operatorsQuery = useQuery<OperatorRow[]>({
    queryKey: ["operators", "simple"],
    queryFn: () =>
      api
        .get<OperatorRow[] | { results: OperatorRow[] }>("/operators/")
        .then((r) => (Array.isArray(r.data) ? r.data : r.data?.results ?? [])),
    staleTime: 5 * 60_000,
  });

  const recordings = useLiveRecordings({
    operatorId,
    dateFrom,
    dateTo,
    page,
    pageSize: PAGE_SIZE,
  });
  const rows = recordings.data?.results ?? [];
  const total = recordings.data?.count ?? 0;

  const resetFilters = () => {
    setOperatorId(null);
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  const statusLabel = (s: string) => {
    const key = `live.archive.status_${s}`;
    const v = t(key);
    return v === key ? s : v;
  };

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:bg-transparent">
        <label className="flex flex-col text-xs text-slate-600">
          {t("live.archive.operator")}
          <select
            value={operatorId ?? ""}
            onChange={(e) => {
              setOperatorId(e.target.value ? parseInt(e.target.value, 10) : null);
              setPage(1);
            }}
            className="mt-1 min-w-[220px] rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">{t("live.archive.all_operators")}</option>
            {(operatorsQuery.data ?? []).map((op) => (
              <option key={op.id} value={op.id}>
                {op.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-600">
          {t("live.archive.date_from")}
          <input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(1);
            }}
            className="mt-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs text-slate-600">
          {t("live.archive.date_to")}
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(1);
            }}
            className="mt-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={resetFilters}
          className="rounded border border-slate-200 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          {t("live.archive.reset")}
        </button>
      </section>

      {playing && <RecordingPlayer recording={playing} onClose={() => setPlaying(null)} />}

      <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:bg-transparent">
        <table className="w-full text-sm" aria-busy={recordings.isFetching}>
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500 dark:bg-transparent">
            <tr>
              <th className="px-3 py-2 text-left">{t("live.archive.col_operator")}</th>
              <th className="px-3 py-2 text-left">{t("live.archive.col_start")}</th>
              <th className="px-3 py-2 text-left">{t("live.archive.col_end")}</th>
              <th className="px-3 py-2 text-right">{t("live.archive.col_duration")}</th>
              <th className="px-3 py-2 text-right">{t("live.archive.col_size")}</th>
              <th className="px-3 py-2 text-left">{t("live.archive.col_status")}</th>
              <th className="px-3 py-2 text-right">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody className={recordings.isPlaceholderData ? "opacity-60" : undefined}>
            {recordings.isLoading && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-slate-400">
                  {t("common.loading")}
                </td>
              </tr>
            )}
            {recordings.isError && !recordings.data && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-rose-600">
                  {t("live.archive.load_failed")}{" "}
                  <button type="button" className="underline" onClick={() => void recordings.refetch()}>
                    {t("common.retry")}
                  </button>
                </td>
              </tr>
            )}
            {!recordings.isLoading && !recordings.isError && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-slate-400">
                  {t("live.archive.empty")}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.id}
                className={`border-t border-slate-100 hover:bg-slate-50/60 ${playing?.id === row.id ? "bg-slate-50/80" : ""}`}
              >
                <td className="px-3 py-2 text-text">{row.operator_name ?? row.participant_identity}</td>
                <td className="px-3 py-2 text-slate-600 tabular-nums">
                  {formatRecordingStart(row.started_at, lang)}
                </td>
                <td className="px-3 py-2 text-slate-600 tabular-nums">
                  {formatRecordingStart(row.ended_at, lang)}
                </td>
                <td className="px-3 py-2 text-right text-slate-600 tabular-nums">
                  {formatDuration(row.duration_s)}
                </td>
                <td className="px-3 py-2 text-right text-slate-600 tabular-nums">
                  {formatBytes(row.size_bytes)}
                </td>
                <td className="px-3 py-2 text-slate-600">{statusLabel(row.status)}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => setPlaying(row)}
                    className="rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700"
                  >
                    {t("live.archive.watch")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="flex justify-center">
        <Paginator page={page} total={total} pageSize={PAGE_SIZE} onChange={setPage} />
      </div>
    </div>
  );
}
