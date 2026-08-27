import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface Me {
  username: string;
  role: string;
  is_superuser: boolean;
  operator_id: number | null;
  operator_name: string | null;
  display_name: string | null;
  telegram_user_id: number | null;
  preferred_language: "ru" | "uz";
  /** ISO YYYY-MM-DD, только для оператора; null пока не заполнена. */
  birth_date: string | null;
  /** True если сегодня совпадает с day/month у birth_date (год игнор). */
  is_birthday_today: boolean;
}

/**
 * Cached `/auth/me/` fetch — used by AppShell (language for morning
 * greeting), DailyLesson (language for feedback UI wiring), Sidebar,
 * Profile, Leaderboard. Single React Query key so they share the cache
 * and get invalidated together when the language toggles.
 */
export function useMe() {
  return useQuery<Me>({
    queryKey: ["auth", "me"],
    queryFn: () => api.get<Me>("/auth/me/").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}
