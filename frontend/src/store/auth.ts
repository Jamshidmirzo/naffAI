import { create } from "zustand";
import { queryClient } from "../lib/queryClient";

type AuthState = {
  token: string | null;
  username: string | null;
  role: string | null;
  setAuth: (token: string, username: string, role: string) => void;
  logout: () => void;
};

export const useAuth = create<AuthState>((set, get) => ({
  token: localStorage.getItem("naffai_token"),
  username: localStorage.getItem("naffai_username"),
  role: localStorage.getItem("naffai_role"),
  setAuth: (token, username, role) => {
    const prev = get();
    // Another user (or a fresh login): nothing cached for the previous one
    // may leak into this session. A role-only sync keeps the cache.
    if (prev.token !== token || prev.username !== username) queryClient.clear();
    localStorage.setItem("naffai_token", token);
    localStorage.setItem("naffai_username", username);
    localStorage.setItem("naffai_role", role);
    set({ token, username, role });
  },
  logout: () => {
    localStorage.removeItem("naffai_token");
    localStorage.removeItem("naffai_username");
    localStorage.removeItem("naffai_role");
    queryClient.clear();
    set({ token: null, username: null, role: null });
  },
}));
