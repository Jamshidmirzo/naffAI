/**
 * React Query hooks for the `/live/*` endpoints. Plain TanStack v5 —
 * no UI here, so the v2 design can re-export them as-is.
 */

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  fetchGlobalStatus,
  fetchLiveConfig,
  fetchLiveNow,
  fetchRecordings,
  patchGlobalStatus,
  type GlobalStatus,
  type LiveNowResponse,
  type LiveNowRow,
} from "./liveRoom";

export const LIVE_NOW_KEY = ["live-now"] as const;
export const LIVE_GLOBAL_STATUS_KEY = ["live-global-status"] as const;
export const LIVE_CONFIG_KEY = ["live-config"] as const;

/** Who is on air right now + which operators have the flag on. */
export function useLiveNow(opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  const { enabled = true, refetchInterval = 5000 } = opts;
  return useQuery<LiveNowResponse>({
    queryKey: LIVE_NOW_KEY,
    queryFn: fetchLiveNow,
    enabled,
    refetchInterval,
    staleTime: 2000,
  });
}

/** Global killswitch state (manager view). */
export function useLiveGlobalStatus(opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  const { enabled = true, refetchInterval = 15000 } = opts;
  return useQuery<GlobalStatus>({
    queryKey: LIVE_GLOBAL_STATUS_KEY,
    queryFn: fetchGlobalStatus,
    enabled,
    refetchInterval,
    staleTime: 5000,
  });
}

/** PATCH the killswitch; writes the answer straight into the cache. */
export function useLiveGlobalToggle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => patchGlobalStatus(enabled),
    onSuccess: (data) => {
      qc.setQueryData(LIVE_GLOBAL_STATUS_KEY, data);
      qc.invalidateQueries({ queryKey: LIVE_NOW_KEY });
    },
  });
}

/** Deployment config (configured / retention). Rarely changes. */
export function useLiveConfig(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: LIVE_CONFIG_KEY,
    queryFn: fetchLiveConfig,
    enabled: opts.enabled ?? true,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** Archive listing; `page` is 1-based, translated to limit/offset. */
export function useLiveRecordings(params: {
  operatorId?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  page: number;
  pageSize: number;
}) {
  const { operatorId = null, dateFrom = null, dateTo = null, page, pageSize } = params;
  return useQuery({
    queryKey: ["live-recordings", operatorId, dateFrom || null, dateTo || null, page, pageSize],
    queryFn: () =>
      fetchRecordings({
        operator_id: operatorId,
        date_from: dateFrom,
        date_to: dateTo,
        limit: pageSize,
        offset: Math.max(0, page - 1) * pageSize,
      }),
    placeholderData: keepPreviousData,
  });
}

/**
 * Live row for a single operator (or `null`). Shares the `["live-now"]`
 * cache with the wall, but polls slower when used standalone.
 */
export function useOperatorIsLive(
  operatorId: number | null | undefined,
  opts: { enabled?: boolean } = {},
) {
  const enabled = (opts.enabled ?? true) && operatorId != null;
  return useQuery<LiveNowResponse, unknown, LiveNowRow | null>({
    queryKey: LIVE_NOW_KEY,
    queryFn: fetchLiveNow,
    enabled,
    refetchInterval: 15000,
    staleTime: 5000,
    retry: false,
    select: (d) => d.live_now.find((r) => r.operator_id === operatorId) ?? null,
  });
}
