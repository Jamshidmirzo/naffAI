/**
 * Operator live publisher — framework-free engine + zustand store + hook.
 *
 * The engine owns the whole lifecycle of the operator's camera stream:
 *
 *   enable → single-tab lock → fresh token → Room.connect → camera on → live
 *
 * and everything that can go wrong around it:
 *   • network drops        → `retrying` with exponential backoff, fresh token each time;
 *   • server-side kicks    → `disabled_operator` (no reconnect loop; one re-probe on next poll);
 *   • second tab / device  → `other_tab` (Web Locks + DUPLICATE_IDENTITY);
 *   • killswitch           → `disabled_global` (poll 30 s visible / 120 s hidden, fail-open);
 *   • camera denied/absent → `denied` / `no_camera` (retry on device change or click);
 *   • token TTL            → planned reconnect at `expires_at − 10 min`.
 *
 * All side-effects come in through `deps` (SDK loader, HTTP, locks,
 * timers, document) so the state machine is unit-tested in node with
 * fake timers — see `__tests__/livePublisher.test.ts`.
 *
 * The SDK (`livekit-client`) is loaded lazily by the default deps; this
 * module never imports it statically, so it stays in its own chunk.
 */

import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  fetchGlobalStatus,
  fetchRoomToken,
  liveErrorCode,
  type GlobalStatus,
  type RoomTokenResponse,
} from "./liveRoom";

// ---------------------------------------------------------------------------
// Public state
// ---------------------------------------------------------------------------

export type LivePublisherStatus =
  | "off"
  | "connecting"
  | "live"
  | "reconnecting"
  | "retrying"
  | "paused_by_user"
  | "other_tab"
  | "disabled_global"
  | "disabled_operator"
  | "denied"
  | "no_camera"
  | "unavailable"
  | "error";

export interface LivePublisherState {
  status: LivePublisherStatus;
  /** ms timestamp when the current status was entered. */
  since: number;
  /** ms timestamp of the next automatic attempt (retrying / error), else null. */
  retryAt: number | null;
  /** Consecutive failed attempts (0 when healthy). */
  attempt: number;
  /** Technical detail for tooltips / logs — never shown as main copy. */
  errText: string;
  /** Why the server removed us (`PARTICIPANT_REMOVED`, `livestream_disabled`, …). */
  kickReason: string | null;
  resume: () => void;
  pause: () => void;
  retryNow: () => void;
}

// ---------------------------------------------------------------------------
// Dependency surface (structural subsets of livekit-client / DOM)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PublisherTrackLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
}

export interface PublisherRoomLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
  connect(url: string, token: string, opts?: { autoSubscribe?: boolean }): Promise<void>;
  disconnect(stopTracks?: boolean): Promise<void>;
  localParticipant: {
    setCameraEnabled(enabled: boolean): Promise<{ track?: PublisherTrackLike } | undefined | void>;
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The parts of `livekit-client` the engine touches. */
export interface PublisherSdk {
  Room: new (options: Record<string, unknown>) => PublisherRoomLike;
  VideoPreset: new (width: number, height: number, maxBitrate: number, maxFramerate?: number) => unknown;
  VideoPresets: { h360: { resolution: unknown } };
  RoomEvent: {
    Reconnecting: string;
    Reconnected: string;
    Disconnected: string;
    MediaDevicesError: string;
    MediaDevicesChanged: string;
  };
  TrackEvent: { Ended: string };
  /** Numeric proto enum (with reverse mapping). */
  DisconnectReason: Record<string, number | string>;
}

export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    cb: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

export interface TimersLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DocLike {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", cb: () => void): void;
  removeEventListener(type: "visibilitychange", cb: () => void): void;
}

export interface MediaDevicesLike {
  addEventListener(type: "devicechange", cb: () => void): void;
  removeEventListener(type: "devicechange", cb: () => void): void;
}

export interface LivePublisherDeps {
  loadSdk: () => Promise<PublisherSdk>;
  fetchToken: () => Promise<RoomTokenResponse>;
  fetchGlobalStatus: () => Promise<GlobalStatus>;
  /** `navigator.locks`; null/undefined → no cross-tab coordination. */
  locks?: LockManagerLike | null;
  now: () => number;
  timers: TimersLike;
  doc?: DocLike | null;
  mediaDevices?: MediaDevicesLike | null;
  /** [0,1) — injectable for deterministic jitter in tests. */
  random?: () => number;
}

export interface LivePublisherEngine {
  store: StoreApi<LivePublisherState>;
  getState: () => LivePublisherState;
  /** Idempotent. `false` = full teardown (room, timers, lock). */
  setEnabled: (enabled: boolean) => void;
  /** Ref-counted enable; the returned release disables on the next tick when the count hits 0. */
  retain: () => () => void;
  pause: () => void;
  resume: () => void;
  retryNow: () => void;
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const PUBLISHER_LOCK_NAME = "naffai-live-publisher";
export const POLL_VISIBLE_MS = 30_000;
export const POLL_HIDDEN_MS = 120_000;
/** While the killswitch is off we wait for it to come back — poll faster. */
export const POLL_DISABLED_MS = 10_000;
export const SLOW_PROBE_MS = 60_000;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;
export const BACKOFF_JITTER_MS = 1_000;
export const TOKEN_REFRESH_LEAD_MS = 10 * 60_000;
const MIN_REFRESH_MS = 60_000;

// Fallbacks mirror @livekit/protocol `DisconnectReason`; the loaded SDK's
// enum wins when present.
const DR_FALLBACK = {
  CLIENT_INITIATED: 1,
  DUPLICATE_IDENTITY: 2,
  PARTICIPANT_REMOVED: 4,
  ROOM_DELETED: 5,
  ROOM_CLOSED: 10,
  USER_REJECTED: 12,
} as const;

/** Kicks that must NOT trigger a reconnect loop. */
const KICK_REASONS = ["PARTICIPANT_REMOVED", "ROOM_DELETED", "ROOM_CLOSED", "USER_REJECTED"] as const;

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  const m = (e as { message?: unknown })?.message;
  return typeof m === "string" ? m : String(e);
}

/** Map a getUserMedia / LiveKit media failure to a status. */
export function classifyMediaError(e: unknown, hint?: string | null): "denied" | "no_camera" | "error" {
  const name = (e as { name?: unknown })?.name;
  const s = `${typeof name === "string" ? name : ""} ${errMsg(e)} ${hint ?? ""}`;
  if (/NotAllowed|Permission|SecurityError/i.test(s)) return "denied";
  if (/NotFound|Overconstrained|DevicesNotFound|device not found/i.test(s)) return "no_camera";
  return "error";
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function createLivePublisherEngine(deps: LivePublisherDeps): LivePublisherEngine {
  const random = deps.random ?? Math.random;
  const { timers } = deps;

  const store = createStore<LivePublisherState>()(() => ({
    status: "off",
    since: deps.now(),
    retryAt: null,
    attempt: 0,
    errText: "",
    kickReason: null,
    resume: () => resume(),
    pause: () => pause(),
    retryNow: () => retryNow(),
  }));

  let enabled = false;
  let refs = 0;
  /** Bumped on every connect/teardown — stale async continuations bail out. */
  let gen = 0;
  let room: PublisherRoomLike | null = null;
  let sdkCache: PublisherSdk | null = null;

  let lock: "none" | "pending" | "held" = "none";
  let lockSeq = 0;
  let releaseLockFn: (() => void) | null = null;
  let lockAbort: AbortController | null = null;

  let pausedByUser = false;
  let attempt = 0;
  /** After a server kick: re-probe once on the next killswitch poll tick. */
  let probeOnPoll = false;
  let lastMediaErr: string | null = null;

  let retryTimer: unknown = null;
  let pollTimer: unknown = null;
  let refreshTimer: unknown = null;
  let disableTimer: unknown = null;
  let pollSeq = 0;
  let polling = false;
  let envBound = false;

  // --- state helpers -------------------------------------------------------

  function setStatus(
    status: LivePublisherStatus,
    extra: Partial<Pick<LivePublisherState, "retryAt" | "errText" | "kickReason">> = {},
  ) {
    const prev = store.getState();
    store.setState({
      status,
      since: prev.status === status ? prev.since : deps.now(),
      retryAt: null,
      errText: "",
      kickReason: null,
      attempt,
      ...extra,
    });
  }

  const isHidden = () => deps.doc?.visibilityState === "hidden";

  function clearTimer(h: unknown) {
    if (h != null) timers.clearTimeout(h);
  }
  function clearRetry() {
    clearTimer(retryTimer);
    retryTimer = null;
  }
  function clearRefresh() {
    clearTimer(refreshTimer);
    refreshTimer = null;
  }
  function clearPoll() {
    clearTimer(pollTimer);
    pollTimer = null;
  }

  /** Detach + disconnect a room we no longer want. Listeners go first so
   *  our own CLIENT_INITIATED disconnect never reaches the handlers. */
  function dropRoom(r: PublisherRoomLike | null): Promise<void> {
    if (!r) return Promise.resolve();
    if (room === r) room = null;
    try {
      r.removeAllListeners();
    } catch {
      /* ignore */
    }
    return r.disconnect().catch(() => {});
  }

  const canRun = () => enabled && !pausedByUser && lock === "held";

  // --- single-tab lock -----------------------------------------------------

  function acquireLock() {
    if (lock !== "none") return;
    const locks = deps.locks;
    if (!locks) {
      lock = "held";
      onLockHeld();
      return;
    }
    lock = "pending";
    const mySeq = ++lockSeq;
    const stale = () => !enabled || lockSeq !== mySeq;

    // Granted → keep the lock until releaseLock() resolves this promise.
    const onGranted = (l: unknown) => {
      if (!l || stale()) return undefined;
      lock = "held";
      const hold = new Promise<void>((resolve) => {
        releaseLockFn = resolve;
      });
      onLockHeld();
      return hold;
    };

    locks
      .request(PUBLISHER_LOCK_NAME, { ifAvailable: true }, (l) => {
        if (l) return onGranted(l);
        if (stale()) return undefined;
        // Another tab of this browser is publishing. Show that, and queue
        // a blocking request so we take over when that tab closes.
        setStatus("other_tab");
        const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
        lockAbort = ac;
        locks
          .request(PUBLISHER_LOCK_NAME, ac ? { signal: ac.signal } : {}, onGranted)
          .catch(() => {
            /* aborted on teardown */
          });
        return undefined;
      })
      .catch(() => {
        // Locks API broken (e.g. opaque origin) — behave as a single tab.
        if (!stale() && lock === "pending") {
          lock = "held";
          onLockHeld();
        }
      });
  }

  function releaseLock() {
    lockSeq++;
    lock = "none";
    releaseLockFn?.();
    releaseLockFn = null;
    lockAbort?.abort();
    lockAbort = null;
  }

  function onLockHeld() {
    bindEnv();
    schedulePoll();
    if (pausedByUser) {
      setStatus("paused_by_user");
      return;
    }
    void connect();
  }

  // --- environment listeners ----------------------------------------------

  const onVisibility = () => {
    if (!isHidden()) void pollTick();
  };
  const onDeviceChange = () => {
    const st = store.getState().status;
    if ((st === "denied" || st === "no_camera") && canRun()) {
      attempt = 0;
      void connect();
    }
  };

  function bindEnv() {
    if (envBound) return;
    envBound = true;
    deps.doc?.addEventListener("visibilitychange", onVisibility);
    deps.mediaDevices?.addEventListener("devicechange", onDeviceChange);
  }
  function unbindEnv() {
    if (!envBound) return;
    envBound = false;
    deps.doc?.removeEventListener("visibilitychange", onVisibility);
    deps.mediaDevices?.removeEventListener("devicechange", onDeviceChange);
  }

  // --- connect ---------------------------------------------------------------

  function roomOptions(sdk: PublisherSdk): Record<string, unknown> {
    return {
      // Publisher: adaptiveStream is a subscriber feature; dynacast pauses
      // simulcast layers nobody watches (big CPU/uplink win for 40 ops).
      adaptiveStream: false,
      dynacast: true,
      videoCaptureDefaults: {
        resolution: sdk.VideoPresets.h360.resolution,
        facingMode: "user",
      },
      publishDefaults: {
        videoCodec: "h264",
        simulcast: true,
        // Primary layer = 360p (below); one low layer for the wall grid.
        videoSimulcastLayers: [new sdk.VideoPreset(320, 180, 150_000, 15)],
        videoEncoding: { maxBitrate: 400_000, maxFramerate: 15 },
        degradationPreference: "maintain-framerate",
      },
      stopLocalTrackOnUnpublish: true,
      disconnectOnPageLeave: true,
    };
  }

  function backoff(status: "retrying" | "error", errText: string) {
    clearRetry();
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
    const delay = base + Math.floor(random() * BACKOFF_JITTER_MS);
    attempt += 1;
    setStatus(status, { retryAt: deps.now() + delay, errText });
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  }

  /** Terminal-ish states; operator/unavailable get a slow re-probe. */
  function toDisabled(
    status: "disabled_global" | "disabled_operator" | "unavailable",
    kickReason: string | null = null,
    opts: { slowProbe?: boolean } = {},
  ) {
    clearRetry();
    clearRefresh();
    attempt = 0;
    const slowProbe = opts.slowProbe ?? status !== "disabled_global";
    if (slowProbe) {
      setStatus(status, { kickReason, retryAt: deps.now() + SLOW_PROBE_MS });
      retryTimer = timers.setTimeout(() => {
        retryTimer = null;
        void connect();
      }, SLOW_PROBE_MS);
    } else {
      setStatus(status, { kickReason });
    }
  }

  function onTokenError(e: unknown) {
    const { status, code } = liveErrorCode(e);
    if (status === 503 && code === "livestream_global_disabled") return toDisabled("disabled_global");
    if (status === 403) return toDisabled("disabled_operator", code ?? "forbidden");
    if (status === 404 || status === 503) return toDisabled("unavailable", code ?? null);
    // Network error / 5xx / 401 (session refresh in-flight) → transient.
    backoff("retrying", status ? `token: HTTP ${status}` : `token: ${errMsg(e)}`);
  }

  function scheduleRefresh(expiresAt: string | undefined) {
    clearRefresh();
    const exp = expiresAt ? Date.parse(expiresAt) : NaN;
    if (Number.isNaN(exp)) return;
    const delay = Math.max(MIN_REFRESH_MS, exp - TOKEN_REFRESH_LEAD_MS - deps.now());
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      const st = store.getState().status;
      if (st === "live" || st === "reconnecting") void connect("reconnecting");
    }, delay);
  }

  function bindRoom(sdk: PublisherSdk, r: PublisherRoomLike) {
    const E = sdk.RoomEvent;
    const DR = sdk.DisconnectReason;
    const reason = (key: keyof typeof DR_FALLBACK) =>
      typeof DR[key] === "number" ? (DR[key] as number) : DR_FALLBACK[key];
    const kickCodes = new Set<number>(KICK_REASONS.map((k) => reason(k)));

    r.on(E.Reconnecting, () => {
      if (room === r) setStatus("reconnecting");
    });
    r.on(E.Reconnected, () => {
      if (room === r) setStatus("live");
    });
    r.on(E.MediaDevicesError, (err: unknown) => {
      // Classification hint for the setCameraEnabled() catch below.
      const name = (err as { name?: unknown })?.name;
      lastMediaErr = `${typeof name === "string" ? name : ""} ${errMsg(err)}`;
    });
    r.on(E.MediaDevicesChanged, onDeviceChange);
    r.on(E.Disconnected, (why?: number) => {
      if (room !== r) return;
      room = null;
      try {
        r.removeAllListeners();
      } catch {
        /* ignore */
      }
      clearRefresh();
      if (!enabled || pausedByUser) return;
      gen++;
      const name =
        typeof why === "number" && typeof DR[why] === "string" ? (DR[why] as string) : String(why ?? "UNKNOWN_REASON");
      if (why === reason("DUPLICATE_IDENTITY")) {
        // Same operator joined from another device/browser.
        setStatus("other_tab", { kickReason: name });
        return;
      }
      if (why != null && kickCodes.has(why)) {
        // Server removed us (killswitch / flag off / pause). No loop —
        // one re-probe on the next poll tick tells us which.
        probeOnPoll = true;
        clearRetry();
        attempt = 0;
        setStatus("disabled_operator", { kickReason: name });
        return;
      }
      // Network-type reasons (and CLIENT_INITIATED we did not initiate,
      // e.g. pagehide restored from bfcache) → retry with a fresh token.
      backoff("retrying", name);
    });
  }

  function onCameraEnded(r: PublisherRoomLike) {
    if (room !== r) return;
    gen++;
    clearRefresh();
    void dropRoom(r);
    // Device unplugged / revoked. `devicechange` brings us back.
    setStatus("no_camera", { errText: "track ended" });
  }

  async function connect(mode: "connecting" | "reconnecting" = "connecting"): Promise<void> {
    if (!canRun()) return;
    const my = ++gen;
    clearRetry();
    clearRefresh();
    probeOnPoll = false;
    if (room) void dropRoom(room);
    setStatus(mode);
    const alive = () => my === gen && canRun();

    let sdk: PublisherSdk;
    try {
      sdk = sdkCache ?? (sdkCache = await deps.loadSdk());
    } catch (e) {
      if (alive()) backoff("error", `sdk: ${errMsg(e)}`);
      return;
    }
    if (!alive()) return;

    let tok: RoomTokenResponse;
    try {
      tok = await deps.fetchToken();
    } catch (e) {
      if (alive()) onTokenError(e);
      return;
    }
    if (!alive()) return;
    if (!tok.can_publish) {
      toDisabled("disabled_operator", "can_publish=false");
      return;
    }

    const r = new sdk.Room(roomOptions(sdk));
    room = r;
    bindRoom(sdk, r);
    try {
      await r.connect(tok.ws_url, tok.token, { autoSubscribe: false });
    } catch (e) {
      await dropRoom(r);
      if (alive()) backoff("retrying", `connect: ${errMsg(e)}`);
      return;
    }
    if (!alive() || room !== r) {
      void dropRoom(r);
      return;
    }

    lastMediaErr = null;
    let pub: { track?: PublisherTrackLike } | undefined | void;
    try {
      pub = await r.localParticipant.setCameraEnabled(true);
    } catch (e) {
      // Never leave a connected room without video (black LIVE tile).
      await dropRoom(r);
      if (!alive()) return;
      const kind = classifyMediaError(e, lastMediaErr);
      if (kind === "denied") setStatus("denied", { errText: errMsg(e) });
      else if (kind === "no_camera") setStatus("no_camera", { errText: errMsg(e) });
      else backoff("error", `camera: ${errMsg(e)}`);
      return;
    }
    if (!alive() || room !== r) {
      void dropRoom(r);
      return;
    }

    attempt = 0;
    setStatus("live");
    pub?.track?.on(sdk.TrackEvent.Ended, () => onCameraEnded(r));
    scheduleRefresh(tok.expires_at);
  }

  // --- killswitch poll -------------------------------------------------------

  function schedulePoll() {
    clearPoll();
    if (!enabled || lock !== "held") return;
    const waitingForSwitch = store.getState().status === "disabled_global";
    pollTimer = timers.setTimeout(
      () => {
        pollTimer = null;
        void pollTick();
      },
      isHidden() ? POLL_HIDDEN_MS : waitingForSwitch ? POLL_DISABLED_MS : POLL_VISIBLE_MS,
    );
  }

  async function pollTick() {
    if (!enabled || lock !== "held" || polling) return;
    clearPoll();
    polling = true;
    const mySeq = ++pollSeq;
    let on: boolean | null = null;
    try {
      const r = await deps.fetchGlobalStatus();
      if (typeof r?.enabled === "boolean") on = r.enabled;
    } catch {
      // Fail-open: a network hiccup must never stop a healthy stream.
    }
    if (mySeq !== pollSeq) return; // torn down meanwhile
    polling = false;
    if (!enabled || lock !== "held") return;
    if (on !== null) applyGlobal(on);
    schedulePoll();
  }

  function applyGlobal(on: boolean) {
    const st = store.getState().status;
    if (!on) {
      if (pausedByUser || st === "disabled_global") return;
      gen++;
      clearRetry();
      clearRefresh();
      void dropRoom(room);
      probeOnPoll = false;
      toDisabled("disabled_global");
      return;
    }
    if (pausedByUser) return;
    if (st === "disabled_global" || (st === "disabled_operator" && probeOnPoll)) {
      attempt = 0;
      void connect();
    }
  }

  // --- public actions -------------------------------------------------------

  function teardown() {
    gen++;
    clearRetry();
    clearRefresh();
    clearPoll();
    pollSeq++;
    polling = false;
    void dropRoom(room);
    releaseLock();
    unbindEnv();
    pausedByUser = false;
    probeOnPoll = false;
    attempt = 0;
    setStatus("off");
  }

  function setEnabled(v: boolean) {
    clearTimer(disableTimer);
    disableTimer = null;
    if (v === enabled) return;
    enabled = v;
    if (v) {
      setStatus("connecting");
      acquireLock();
    } else {
      teardown();
    }
  }

  function retain() {
    refs += 1;
    setEnabled(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      refs = Math.max(0, refs - 1);
      if (refs > 0) return;
      // Deferred so StrictMode's unmount→mount doesn't tear down the room.
      clearTimer(disableTimer);
      disableTimer = timers.setTimeout(() => {
        disableTimer = null;
        if (refs === 0) setEnabled(false);
      }, 0);
    };
  }

  function pause() {
    if (!enabled || pausedByUser) return;
    pausedByUser = true;
    gen++;
    clearRetry();
    clearRefresh();
    probeOnPoll = false;
    attempt = 0;
    void dropRoom(room);
    setStatus("paused_by_user");
  }

  function resume() {
    if (!enabled) return;
    pausedByUser = false;
    attempt = 0;
    if (lock === "held") void connect();
    else if (lock === "none") acquireLock();
  }

  function retryNow() {
    if (!enabled || pausedByUser || lock !== "held") return;
    attempt = 0;
    void connect();
  }

  function dispose() {
    refs = 0;
    setEnabled(false);
  }

  return {
    store,
    getState: () => store.getState(),
    setEnabled,
    retain,
    pause,
    resume,
    retryNow,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Default (browser) instance + React bindings
// ---------------------------------------------------------------------------

function browserDeps(): LivePublisherDeps {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return {
    loadSdk: () => import("livekit-client").then((m) => m as unknown as PublisherSdk),
    fetchToken: fetchRoomToken,
    fetchGlobalStatus,
    locks: nav && "locks" in nav && nav.locks ? (nav.locks as unknown as LockManagerLike) : null,
    now: () => Date.now(),
    timers: {
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => window.clearTimeout(h as number),
    },
    doc: typeof document !== "undefined" ? document : null,
    mediaDevices: nav?.mediaDevices ?? null,
  };
}

let defaultEngine: LivePublisherEngine | null = null;

/** Module-level singleton used by the hooks (created on first use). */
export function getLivePublisher(): LivePublisherEngine {
  if (!defaultEngine) defaultEngine = createLivePublisherEngine(browserDeps());
  return defaultEngine;
}

/**
 * Headless controller: while mounted with `enabled=true` the operator
 * publishes. Ref-counted, so double mounts (StrictMode) are harmless.
 */
export function useLivePublisher({ enabled }: { enabled: boolean }): void {
  useEffect(() => {
    if (!enabled) return;
    return getLivePublisher().retain();
  }, [enabled]);
}

/** Read the global publisher state from any component. */
export function useLivePublisherStatus(): LivePublisherState;
export function useLivePublisherStatus<T>(selector: (s: LivePublisherState) => T): T;
export function useLivePublisherStatus<T>(selector?: (s: LivePublisherState) => T) {
  return useStore(
    getLivePublisher().store,
    selector ?? ((s: LivePublisherState) => s as unknown as T),
  );
}
