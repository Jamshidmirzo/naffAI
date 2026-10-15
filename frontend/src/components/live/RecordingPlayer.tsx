/**
 * RecordingPlayer — inline player for one archived recording.
 *
 * Presigned S3 URLs are short-lived (≈10 min) while chunks run up to an
 * hour, so the browser's range requests can start failing mid-playback.
 * `useRecordingPlayback` fetches the URL, refreshes it right before the
 * user plays/seeks near expiry, refetches once on a <video> error, and
 * restores the playback position after swapping `src`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  fetchRecordingUrl,
  formatDuration,
  formatRecordingStart,
  liveErrorCode,
  type RecordingRow,
} from "../../lib/liveRoom";
import { useLangValue, useT } from "../../lib/i18n";

const EXPIRY_MARGIN_MS = 30_000;

export type PlaybackError = "not_found" | "url_failed" | "playback_failed";

export function useRecordingPlayback(recording: Pick<RecordingRow, "id"> | null) {
  const id = recording?.id ?? null;
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PlaybackError | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const expiresAtRef = useRef(0);
  const reqRef = useRef(0);
  const refetchedRef = useRef(false);
  const resumeRef = useRef<{ time: number; play: boolean } | null>(null);

  const load = useCallback(async (recId: number) => {
    const my = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const r = await fetchRecordingUrl(recId);
      if (my !== reqRef.current) return;
      expiresAtRef.current = Date.now() + r.expires_in * 1000;
      setUrl(r.url || null);
      if (!r.url) setError("url_failed");
    } catch (e) {
      if (my !== reqRef.current) return;
      setError(liveErrorCode(e).status === 404 ? "not_found" : "url_failed");
    } finally {
      if (my === reqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    reqRef.current++;
    setUrl(null);
    setError(null);
    refetchedRef.current = false;
    resumeRef.current = null;
    if (id != null) void load(id);
  }, [id, load]);

  const snapshot = (play: boolean) => {
    const v = videoRef.current;
    resumeRef.current = v ? { time: v.currentTime, play } : null;
  };

  /** play/seek close to expiry → swap in a fresh URL first. */
  const refreshIfExpiring = useCallback(() => {
    if (id == null || loading) return;
    if (Date.now() < expiresAtRef.current - EXPIRY_MARGIN_MS) return;
    snapshot(true);
    void load(id);
  }, [id, loading, load]);

  const onError = useCallback(() => {
    if (id == null) return;
    if (refetchedRef.current) {
      setError("playback_failed");
      return;
    }
    refetchedRef.current = true;
    snapshot(true);
    void load(id);
  }, [id, load]);

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    const r = resumeRef.current;
    if (!v || !r) return;
    resumeRef.current = null;
    try {
      v.currentTime = r.time;
    } catch {
      /* ignore */
    }
    if (r.play) v.play().catch(() => {});
  }, []);

  const onPlaying = useCallback(() => {
    // Healthy again — allow one more refetch for the next expiry.
    refetchedRef.current = false;
  }, []);

  const retry = useCallback(() => {
    if (id == null) return;
    refetchedRef.current = false;
    snapshot(true);
    void load(id);
  }, [id, load]);

  return {
    url,
    loading,
    error,
    retry,
    videoProps: {
      ref: videoRef,
      src: url ?? undefined,
      onError,
      onLoadedMetadata,
      onPlaying,
      onPlay: refreshIfExpiring,
      onSeeking: refreshIfExpiring,
    },
  };
}

interface Props {
  recording: RecordingRow;
  onClose: () => void;
}

export default function RecordingPlayer({ recording, onClose }: Props) {
  const t = useT();
  const lang = useLangValue();
  const pb = useRecordingPlayback(recording);

  return (
    <section className="rounded-xl border border-slate-200 bg-black overflow-hidden" data-testid="recording-player">
      <div className="flex items-center justify-between gap-3 px-4 py-2 bg-slate-900 text-white">
        <span className="text-sm font-medium truncate">
          {recording.operator_name ?? recording.participant_identity}
          <span className="ml-2 text-white/60 font-normal">
            {formatRecordingStart(recording.started_at, lang)} · {formatDuration(recording.duration_s)}
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded hover:bg-white/10 text-xs"
          aria-label={t("common.close")}
        >
          <X className="w-3.5 h-3.5" /> {t("common.close")}
        </button>
      </div>
      {pb.error ? (
        <div className="aspect-video grid place-items-center text-center text-sm text-white/80 px-6">
          <div>
            <div>{t(`live.archive.err_${pb.error}`)}</div>
            {pb.error !== "not_found" && (
              <button
                type="button"
                onClick={pb.retry}
                className="mt-3 rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20"
              >
                {t("common.retry")}
              </button>
            )}
          </div>
        </div>
      ) : pb.url ? (
        <video
          {...pb.videoProps}
          key={recording.id}
          controls
          autoPlay
          playsInline
          className="w-full aspect-video bg-black"
        />
      ) : (
        <div className="aspect-video grid place-items-center text-sm text-white/60">
          {t("common.loading")}
        </div>
      )}
    </section>
  );
}
