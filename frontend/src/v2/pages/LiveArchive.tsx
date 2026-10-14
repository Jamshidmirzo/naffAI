import { useState } from "react";
import { AlertTriangle, Film, Play, RefreshCw } from "lucide-react";
import { fetchRecordingUrl, formatBytes, formatDuration, type RecordingRow } from "../../lib/liveRoom";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import { useLiveOperatorOptions, useLiveRecordings } from "../api/team/trainingLive";
import { LiveTabs } from "./LiveWall";

const COLS = "minmax(0, 1fr) 168px 92px 84px 104px";
const TILE_BG = "#1C1C1E";
const PLAYER_BG = "#000000";

const fmtStart = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("ru-RU", {
        timeZone: "Asia/Tashkent",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

export default function LiveArchive() {
  const t = useT2();
  const [operatorId, setOperatorId] = useState<number | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [playing, setPlaying] = useState<{ row: RecordingRow; url: string } | null>(null);
  const [urlLoading, setUrlLoading] = useState<number | null>(null);
  const [urlErr, setUrlErr] = useState<{ row: RecordingRow; text: string } | null>(null);

  const operatorsQuery = useLiveOperatorOptions();
  const recordingsQuery = useLiveRecordings({ operatorId, dateFrom, dateTo });
  const rows = recordingsQuery.data?.results ?? [];
  const filtered = operatorId !== null || !!dateFrom || !!dateTo;

  const reset = () => {
    setOperatorId(null);
    setDateFrom("");
    setDateTo("");
  };

  const handlePlay = async (row: RecordingRow) => {
    setUrlErr(null);
    setUrlLoading(row.id);
    try {
      const { url } = await fetchRecordingUrl(row.id);
      setPlaying({ row, url });
    } catch (e) {
      const err = e as { response?: { data?: { detail?: string } } };
      setUrlErr({ row, text: err?.response?.data?.detail || t("v2.team.trainingLive.urlFailed") });
    } finally {
      setUrlLoading(null);
    }
  };

  const name = (r: RecordingRow) => r.operator_name ?? r.participant_identity;

  return (
    <>
      <PageHeader title={t("v2.team.trainingLive.archiveTitle")} meta={<LiveTabs at="archive" />}>
        <span className="s c3">{t("v2.team.trainingLive.archiveRetention")}</span>
      </PageHeader>
      <main className="page">
        <section className="card row g12 wrap" style={{ padding: "12px 16px", alignItems: "flex-end" }}>
          <div className="field" style={{ width: 240, maxWidth: "100%" }}>
            <label htmlFor="la-op">{t("v2.team.trainingLive.operator")}</label>
            <select
              className="input"
              id="la-op"
              value={operatorId ?? ""}
              onChange={(e) => setOperatorId(e.target.value ? parseInt(e.target.value, 10) : null)}
            >
              <option value="">{t("v2.team.trainingLive.all")}</option>
              {(operatorsQuery.data ?? []).map((op) => (
                <option key={op.id} value={op.id}>
                  {op.full_name}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ width: 170 }}>
            <label htmlFor="la-from">{t("v2.team.trainingLive.dateFrom")}</label>
            <input className="input num" id="la-from" type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div className="field" style={{ width: 170 }}>
            <label htmlFor="la-to">{t("v2.team.trainingLive.dateTo")}</label>
            <input className="input num" id="la-to" type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <button className="btn" type="button" disabled={!filtered} onClick={reset}>
            {t("v2.team.trainingLive.resetFilter")}
          </button>
        </section>

        <div className="split">
          <section className="list card tbl" style={{ overflowX: "auto" }}>
            {recordingsQuery.isLoading ? (
              <LoadingBlock rows={5} onRetry={() => recordingsQuery.refetch()} />
            ) : recordingsQuery.isError ? (
              <ErrorState error={recordingsQuery.error} onRetry={() => recordingsQuery.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState
                icon={<Film className="ic ic-l" />}
                title={t("v2.team.trainingLive.noRecordings")}
                body={filtered ? t("v2.team.trainingLive.noRecordingsFiltered") : t("v2.team.trainingLive.noRecordingsHint")}
                action={
                  filtered ? (
                    <button className="btn btn-sm" type="button" onClick={reset}>
                      {t("v2.team.trainingLive.resetFilter")}
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div style={{ minWidth: 600 }}>
                <div className="tr th" style={{ gridTemplateColumns: COLS }}>
                  <span>{t("v2.team.trainingLive.operator")}</span>
                  <span>{t("v2.team.trainingLive.started")}</span>
                  <span className="r">{t("v2.team.trainingLive.duration")}</span>
                  <span className="r">{t("v2.team.trainingLive.size")}</span>
                  <span className="r">{t("common.actions")}</span>
                </div>
                {rows.map((row) => (
                  <div key={row.id} className={cx("tr", playing?.row.id === row.id && "is-sel")} style={{ gridTemplateColumns: COLS }}>
                    <span className="row g8" style={{ minWidth: 0 }}>
                      <span className="ava ava-s">{initials(name(row))}</span>
                      <span className="trunc">{name(row)}</span>
                    </span>
                    <span className="num s c2">{fmtStart(row.started_at)}</span>
                    <span className="r num">{formatDuration(row.duration_s)}</span>
                    <span className="r num c3">{formatBytes(row.size_bytes)}</span>
                    <span className="r">
                      <button className="btn btn-sm" type="button" disabled={urlLoading === row.id} onClick={() => handlePlay(row)}>
                        {urlLoading === row.id ? "…" : t("v2.team.trainingLive.watch")}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {playing || urlErr ? (
            <aside className="panel card col" style={{ flex: "0 1 420px", overflow: "hidden", padding: 0 }}>
              {playing ? (
                <>
                  <div className="row between g8" style={{ padding: "8px 14px", background: TILE_BG, color: "#FFFFFF" }}>
                    <span className="s w6 trunc">{t("v2.team.trainingLive.recordingN", { id: playing.row.id, name: name(playing.row) })}</span>
                    <button
                      className="btn btn-sm"
                      type="button"
                      style={{ background: "transparent", borderColor: "rgba(255,255,255,.25)", color: "#FFFFFF" }}
                      onClick={() => setPlaying(null)}
                    >
                      {t("common.close")}
                    </button>
                  </div>
                  <video key={playing.url} src={playing.url} controls autoPlay style={{ display: "block", width: "100%", aspectRatio: "16 / 9", background: PLAYER_BG }} />
                  <div className="row g8 xs c3" style={{ padding: "10px 14px" }}>
                    <Play className="ic ic-s" />
                    <span className="num">{fmtStart(playing.row.started_at)}</span>
                    <span className="grow" />
                    <span className="num">{formatDuration(playing.row.duration_s)}</span>
                  </div>
                </>
              ) : null}
              {urlErr ? (
                <div className="col g8" style={{ padding: "14px 16px 16px" }}>
                  <div className="banner b-bad">
                    <AlertTriangle className="ic" />
                    <span className="col g4 grow">
                      <span>{urlErr.text}</span>
                      <span className="xs">{t("v2.team.trainingLive.urlFailedHint")}</span>
                    </span>
                    <button className="btn btn-sm" type="button" disabled={urlLoading === urlErr.row.id} onClick={() => handlePlay(urlErr.row)}>
                      <RefreshCw className="ic ic-s" />
                      {t("v2.state.retry")}
                    </button>
                  </div>
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>
      </main>
    </>
  );
}
