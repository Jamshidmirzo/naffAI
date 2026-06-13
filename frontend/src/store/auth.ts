import { create } from "zustand";

type AuthState = {
  token: string | null;
  username: string | null;
  role: string | null;
  setAuth: (token: string, username: string, role: string) => void;
  logout: () => void;
};

export const useAuth = create<AuthState>((set) => ({
  token: localStorage.getItem("naffai_token"),
  username: localStorage.getItem("naffai_username"),
  role: localStorage.getItem("naffai_role"),
  setAuth: (token, username, role) => {
    localStorage.setItem("naffai_token", token);
    localStorage.setItem("naffai_username", username);
    localStorage.setItem("naffai_role", role);
    set({ token, username, role });
  },
  logout: () => {
    localStorage.removeItem("naffai_token");
    localStorage.removeItem("naffai_username");
    localStorage.removeItem("naffai_role");
    set({ token: null, username: null, role: null });
  },
}));
