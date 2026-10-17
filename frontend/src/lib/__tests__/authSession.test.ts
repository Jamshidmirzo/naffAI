// Session hygiene (2026-10-17): a previous user's cache must not leak into
// the next login, and a dead token must send the tab to /login.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AxiosAdapter } from "axios";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});
const fakeLocation = { pathname: "/dashboard", href: "" };
vi.stubGlobal("location", fakeLocation);

const { queryClient } = await import("../queryClient");
const { useAuth } = await import("../../store/auth");
const { api } = await import("../api");

describe("auth store and the query cache", () => {
  beforeEach(() => {
    store.clear();
    queryClient.clear();
    useAuth.setState({ token: null, username: null, role: null });
  });

  it("logout drops everything cached for the user", () => {
    useAuth.getState().setAuth("t-op", "op", "operator");
    queryClient.setQueryData(["auth", "me"], { username: "op", role: "operator" });
    useAuth.getState().logout();
    expect(queryClient.getQueryData(["auth", "me"])).toBeUndefined();
    expect(store.get("naffai_token")).toBeUndefined();
  });

  it("logging in as someone else drops the previous user's cache", () => {
    useAuth.getState().setAuth("t-op", "op", "operator");
    queryClient.setQueryData(["auth", "me"], { username: "op", role: "operator" });
    useAuth.getState().setAuth("t-mgr", "mgr", "manager");
    expect(queryClient.getQueryData(["auth", "me"])).toBeUndefined();
    expect(useAuth.getState().role).toBe("manager");
  });

  it("a role-only sync keeps the cache", () => {
    useAuth.getState().setAuth("t-mgr", "mgr", "manager");
    queryClient.setQueryData(["auth", "me"], { username: "mgr", role: "super_manager" });
    useAuth.getState().setAuth("t-mgr", "mgr", "super_manager");
    expect(queryClient.getQueryData(["auth", "me"])).toEqual({ username: "mgr", role: "super_manager" });
  });
});

describe("api: dead token", () => {
  const reply = (status: number, data: unknown): AxiosAdapter => async (config) => {
    const err = Object.assign(new Error(`HTTP ${status}`), {
      isAxiosError: true,
      config,
      response: { status, data, headers: {}, config, statusText: "" },
    });
    throw err;
  };

  beforeEach(() => {
    store.clear();
    store.set("naffai_token", "dead");
    fakeLocation.pathname = "/dashboard";
    fakeLocation.href = "";
  });

  it("an old-style 403 «invalid token» logs out to /login", async () => {
    api.defaults.adapter = reply(403, { detail: "Недействительный токен." });
    await expect(api.get("/leads/")).rejects.toBeTruthy();
    expect(store.get("naffai_token")).toBeUndefined();
    expect(fakeLocation.href).toBe("/login");
  });

  it("a real 403 (role) keeps the session", async () => {
    api.defaults.adapter = reply(403, { detail: "У вас недостаточно прав для выполнения данного действия." });
    await expect(api.get("/users/")).rejects.toBeTruthy();
    expect(store.get("naffai_token")).toBe("dead");
    expect(fakeLocation.href).toBe("");
  });
});
