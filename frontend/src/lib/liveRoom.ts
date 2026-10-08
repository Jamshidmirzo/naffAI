/**
 * Live-room helpers — thin wrappers around the backend endpoints and
 * the LiveKit JS SDK. Keep API shape here so the publisher / wall /
 * archive components only import types.
 */

import { api } from "./api";

export type RoomTokenResponse = {
  ws_url: string;
  room_name: string;
  participant_identity: string;
  participant_name: string;
  token: string;
  can_publish: boolean;
  can_subscribe: boolean;
  expires_at: string;
};

export type LiveNowRow = {
  id: number;
  operator_id: number;
  operator_name: string;
  participant_identity: string;
  room_name: string;
  started_at: string | null;
};

export type LiveNowResponse = {
  live_now: LiveNowRow[];
  enabled_operators: { id: number; full_name: string; status: string }[];
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

/** POST /api/live/room-token/. Thin — just resolves a short-lived JWT. */
export async function fetchRoomToken(): Promise<RoomTokenResponse> {
  const r = await api.post<RoomTokenResponse>("/live/room-token/");
  return r.data;
}

/** GET /api/live/live-now/. Manager-only. */
export async function fetchLiveNow(): Promise<LiveNowResponse> {
  const r = await api.get<LiveNowResponse>("/live/live-now/");
  return r.data;
}

/** GET /api/live/recordings/ — list for Archive page. */
export async function fetchRecordings(params: {
  operator_id?: number | null;
  date_from?: string | null;
  date_to?: string | null;
  page_size?: number;
}): Promise<{ results: RecordingRow[] }> {
  const r = await api.get<{ results: RecordingRow[] }>("/live/recordings/", {
    params: {
      operator_id: params.operator_id ?? undefined,
      date_from: params.date_from ?? undefined,
      date_to: params.date_to ?? undefined,
      page_size: params.page_size ?? 50,
    },
  });
  return r.data;
}

/** GET /api/live/recordings/<id>/url/ — presigned S3 URL (10 min TTL). */
export async function fetchRecordingUrl(id: number): Promise<{ url: string }> {
  const r = await api.get<{ url: string; expires_in: number }>(
    `/live/recordings/${id}/url/`
  );
  return { url: r.data.url };
}

/** Format bytes compactly for the Archive page. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** Format a duration (seconds) as `MM:SS` or `H:MM:SS`. */
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
