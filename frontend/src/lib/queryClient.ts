import { QueryClient } from "@tanstack/react-query";

/**
 * The app's one react-query cache. Lives in its own module so the auth store
 * can drop it when the user changes: a cached `/auth/me/` of the previous
 * user used to rewrite the new user's role (operator → manager login showed
 * the operator UI).
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});
