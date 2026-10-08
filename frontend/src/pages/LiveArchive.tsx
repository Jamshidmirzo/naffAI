/**
 * LiveArchive — manager-only list of finished recordings with inline
 * playback via presigned S3 URLs. Minimum filters: operator + date range.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchRecordings,
  fetchRecordingUrl,
  formatBytes,
  formatDuration,
} from "../lib/liveRoom";
import { api } from "../lib/api";

type OperatorRow = { id: number; full_name: string };

export default function LiveArchive() {
  const [operatorId, setOperatorId] = useState<number | null>(null);
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [playing, setPlaying] = useState<{
    recordingId: number;
    url: string;
  } | null>(null);
  const [urlLoading, setUrlLoading] = useState<number | null>(null);
  const [urlErr, setUrlErr] = useState<string>("");

  // Simple operators dropdown — reuse the existing /operators/ endpoint
  // (returns the array of operator objects used across the app).
  const operatorsQuery = useQuery<OperatorRow[]>({
    queryKey: ["operators", "simple"],
    queryFn: () => api.get("/operators/").then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  const recordingsQuery = useQuery({
    queryKey: ["live-recordings", operatorId, dateFrom, dateTo],
    queryFn: () =>
      fetchRecordings({
        operator_id: operatorId,
        date_from: dateFrom || null,
        date_to: dateTo || null,
        page_size: 100,
      }),
  });

  const handlePlay = async (recordingId: number) => {
    setUrlErr("");
    setUrlLoading(recordingId);
    try {
      const { url } = await fetchRecordingUrl(recordingId);
      setPlaying({ recordingId, url });
    } catch (e) {
      const err = e as { response?: { data?: { detail?: string } } };
      setUrlErr(
        err?.response?.data?.detail || (e as Error).message || "Не удалось получить ссылку"
      );
    } finally {
      setUrlLoading(null);
    }
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Архив live-эфира</h1>
          <p className="text-sm text-slate-500">
            Записи храняться 30 дней, затем автоматически удаляются из S3.
          </p>
        </div>
      </header>

      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <label className="flex flex-col text-xs text-slate-600">
          Оператор
          <select
            value={operatorId ?? ""}
            onChange={(e) =>
              setOperatorId(e.target.value ? parseInt(e.target.value, 10) : null)
            }
            className="mt-1 min-w-[220px] rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">Все</option>
            {(operatorsQuery.data ?? []).map((op) => (
              <option key={op.id} value={op.id}>
                {op.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-600">
          С даты
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="mt-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs text-slate-600">
          По дату
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="mt-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setOperatorId(null);
            setDateFrom("");
            setDateTo("");
          }}
          className="rounded border border-slate-200 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          Сбросить фильтр
        </button>
      </section>

      {urlErr && (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {urlErr}
        </div>
      )}

      {playing && (
        <section className="rounded-xl border border-slate-200 bg-black overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-slate-900 text-white">
            <span className="text-sm font-medium">
              Запись #{playing.recordingId}
            </span>
            <button
              type="button"
              onClick={() => setPlaying(null)}
              className="px-2 py-0.5 rounded hover:bg-white/10 text-xs"
            >
              Закрыть
            </button>
          </div>
          <video
            key={playing.url}
            src={playing.url}
            controls
            autoPlay
            className="w-full aspect-video bg-black"
          />
        </section>
      )}

      <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Оператор</th>
              <th className="px-3 py-2 text-left">Начало</th>
              <th className="px-3 py-2 text-right">Длительность</th>
              <th className="px-3 py-2 text-right">Размер</th>
              <th className="px-3 py-2 text-right">Действия</th>
            </tr>
          </thead>
          <tbody>
            {recordingsQuery.isLoading && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-slate-400">
                  Загрузка…
                </td>
              </tr>
            )}
            {!recordingsQuery.isLoading &&
              (recordingsQuery.data?.results ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-slate-400">
                    Записей не найдено.
                  </td>
                </tr>
              )}
            {(recordingsQuery.data?.results ?? []).map((row) => (
              <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2 text-slate-900">
                  {row.operator_name ?? row.participant_identity}
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {row.started_at
                    ? new Date(row.started_at).toLocaleString("ru-RU")
                    : "—"}
                </td>
                <td className="px-3 py-2 text-right text-slate-600 tabular-nums">
                  {formatDuration(row.duration_s)}
                </td>
                <td className="px-3 py-2 text-right text-slate-600 tabular-nums">
                  {formatBytes(row.size_bytes)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    disabled={urlLoading === row.id}
                    onClick={() => handlePlay(row.id)}
                    className="rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-60"
                  >
                    {urlLoading === row.id ? "..." : "Смотреть"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
