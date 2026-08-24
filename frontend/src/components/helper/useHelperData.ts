import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { OperatorHelperResponse } from "./types";

/**
 * Fetch operator suggestions + FAQ. Auto-refetch every 60s while the
 * panel is open — new sale/lead action from another tab flips the state
 * within one refresh cycle. Backend has its own 30s Redis TTL so this
 * doesn't hammer the DB.
 */
export function useHelperData(enabled: boolean = true) {
  return useQuery<OperatorHelperResponse>({
    queryKey: ["helper", "operator-suggestions"],
    queryFn: () =>
      api
        .get<OperatorHelperResponse>("/helper/operator-suggestions/")
        .then((r) => r.data),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    // Не показываем прошлые данные если оператор сменился — кэш-per-role
    // не нужен: /auth/me/ уже разделяет по токену.
    staleTime: 20_000,
  });
}
