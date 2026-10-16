/**
 * Live-room helpers — thin wrappers around the backend `/live/*`
 * endpoints plus small formatters. Keep the API shape here so the
 * publisher / wall / archive only import types + functions from one
 * place. The LiveKit SDK itself is NEVER imported here (it is loaded
 * lazily by the publisher engine and the wall hook).
 *
 * Optional fields (`?`) are the ones the backend may not send yet —
 * every consumer must degrade gracefully when they are missing.
 */

import { api } from "./api";
import type { Lang } from "../store/lang";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type RoomTokenResponse = {
  ws_url: string;
  room_name: string;
  participant_identity: string;
  participant_name: string;
  token: string;
  can_publish: boolean;
  can_subscribe: boolean;
  /** ISO timestamp; JWT TTL (12 h at the time of writing). */
  expires_at: string;
};

/** Machine-readable `code` values the backend returns on `/live/*` errors. */
export type LiveErrorCode =
  | "livestream_global_disabled"
  | "livestream_disabled"
  | "livestream_misconfigured"
  | (string & {});

export type LiveNowRow = {
  operator_id: number;
  operator_name: string;
  participant_identity: string;
  participant_sid?: string | null;
  started_at: string | null;
  has_video?: boolean;
  on_shift?: boolean;
  is_paused?: boolean;
};

export type NotLiveReason = "disabled" | "paused" | "no_shift" | "offline";

export type EnabledOperatorRow = {
  id: number;
  full_name: string;
  status: string;
  is_live?: boolean;
  on_shift?: boolean;
  is_paused?: boolean;
  livestream_enabled?: boolean;
  reason?: NotLiveReason | null;
};

export type LiveNowResponse = {
  source?: "livekit" | "db";
  room_name?: string;
  recording_enabled?: boolean;
  live_now: LiveNowRow[];
  enabled_operators: EnabledOperatorRow[];
};

export type RecordingRow = {
  id: number;
  operator_id: number | null;
  operator_name: string | null;
  participant_identity: string;
  room_name: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  size_bytes: number | null;
};

export type RecordingsPage = { count: number; results: RecordingRow[] };

export type RecordingsParams = {
  operator_id?: number | null;
  /** `YYYY-MM-DD` */
  date_from?: string | null;
  /** `YYYY-MM-DD` */
  date_to?: string | null;
  limit?: number;
  offset?: number;
};

export type RecordingUrl = { url: string; expires_in: number };

export type GlobalStatus = { enabled: boolean };

export type LiveConfig = {
  configured: boolean;
  recording_enabled?: boolean;
  room_name?: string;
  retention_days?: number;
};

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** POST /api/live/room-token/ — always a fresh short-lived JWT. */
export async function fetchRoomToken(): Promise<RoomTokenResponse> {
  const r = await api.post<RoomTokenResponse>("/live/room-token/");
  return r.data;
}

/** GET /api/live/live-now/. Manager+, scoped to visible operators. */
export async function fetchLiveNow(): Promise<LiveNowResponse> {
  const r = await api.get<Partial<LiveNowResponse>>("/live/live-now/");
  return {
    ...r.data,
    live_now: r.data?.live_now ?? [],
    enabled_operators: r.data?.enabled_operators ?? [],
  };
}

/** GET /api/live/recordings/ — finished recordings, limit/offset paged. */
export async function fetchRecordings(params: RecordingsParams): Promise<RecordingsPage> {
  const r = await api.get<Partial<RecordingsPage> | RecordingRow[]>("/live/recordings/", {
    params: {
      operator_id: params.operator_id ?? undefined,
      date_from: params.date_from || undefined,
      date_to: params.date_to || undefined,
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
    },
  });
  const data = r.data;
  // Tolerate both a bare array and `{results}` without `count`.
  if (Array.isArray(data)) return { count: data.length, results: data };
  const results = data?.results ?? [];
  return { count: typeof data?.count === "number" ? data.count : results.length, results };
}

/** GET /api/live/recordings/<id>/url/ — presigned S3 URL (short TTL). */
export async function fetchRecordingUrl(id: number): Promise<RecordingUrl> {
  const r = await api.get<Partial<RecordingUrl>>(`/live/recordings/${id}/url/`);
  return {
    url: r.data?.url ?? "",
    expires_in: typeof r.data?.expires_in === "number" ? r.data.expires_in : 600,
  };
}

/** GET /api/live/global-status/ — killswitch state. */
export async function fetchGlobalStatus(): Promise<GlobalStatus> {
  const r = await api.get<GlobalStatus>("/live/global-status/");
  return r.data;
}

/** PATCH /api/live/global-status/ — real boolean only (400 on garbage). */
export async function patchGlobalStatus(enabled: boolean): Promise<GlobalStatus> {
  const r = await api.patch<GlobalStatus>("/live/global-status/", { enabled });
  return r.data;
}

/** POST /api/live/snapshots/<id>/upload/ — the publisher answers a
 *  snapshot request with a JPEG, or with the reason it could not. */
export async function uploadSnapshot(id: string, frame: Blob | null, error?: string): Promise<void> {
  const url = `/live/snapshots/${encodeURIComponent(id)}/upload/`;
  if (frame) {
    const fd = new FormData();
    fd.append("image", frame, "snapshot.jpg");
    await api.post(url, fd);
  } else {
    await api.post(url, { error: (error || "capture failed").slice(0, 300) });
  }
}

/** GET /api/live/config/ — deployment flags (LiveKit configured, retention). */
export async function fetchLiveConfig(): Promise<LiveConfig> {
  const r = await api.get<LiveConfig>("/live/config/");
  return r.data;
}

/**
 * Pull `{status, code}` out of an axios-style error. `status` is absent
 * for network failures (no response) — callers treat that as transient.
 */
export function liveErrorCode(e: unknown): { status?: number; code?: LiveErrorCode } {
  const err = e as { response?: { status?: number; data?: unknown } } | null | undefined;
  const status = typeof err?.response?.status === "number" ? err.response.status : undefined;
  const data = err?.response?.data as { code?: unknown } | undefined;
  const code = data && typeof data === "object" && typeof data.code === "string" ? data.code : undefined;
  return { status, code };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Format bytes compactly for the Archive page. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** Format a duration (seconds) as `M:SS` or `H:MM:SS`. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
  }
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/**
 * Time on air since `startedAtIso`: `m:ss` under an hour, `h:mm:ss`
 * after. Empty string when the start is unknown / unparsable.
 */
export function formatOnAir(startedAtIso: string | null | undefined, nowMs: number): string {
  if (!startedAtIso) return "";
  const start = Date.parse(startedAtIso);
  if (Number.isNaN(start)) return "";
  return formatDuration(Math.max(0, Math.floor((nowMs - start) / 1000)));
}

/** Recording start in Tashkent time, localised (`ru-RU` / `uz-UZ`). */
export function formatRecordingStart(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(lang === "uz" ? "uz-UZ" : "ru-RU", {
    timeZone: "Asia/Tashkent",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
