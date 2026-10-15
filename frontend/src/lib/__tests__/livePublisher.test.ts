import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLivePublisherEngine,
  POLL_DISABLED_MS,
  POLL_HIDDEN_MS,
  POLL_VISIBLE_MS,
  SLOW_PROBE_MS,
  type LivePublisherEngine,
  type LivePublisherStatus,
  type LockManagerLike,
  type PublisherSdk,
} from "../livePublisher";
import type { RoomTokenResponse } from "../liveRoom";

// ---------------------------------------------------------------------------
// Constants mirrored from livekit-client 2.22 / @livekit/protocol
// (verified against the real module in the last describe block).
// ---------------------------------------------------------------------------

const DR_NAMES = [
  "UNKNOWN_REASON",
  "CLIENT_INITIATED",
  "DUPLICATE_IDENTITY",
  "SERVER_SHUTDOWN",
  "PARTICIPANT_REMOVED",
  "ROOM_DELETED",
  "STATE_MISMATCH",
  "JOIN_FAILURE",
  "MIGRATION",
  "SIGNAL_CLOSE",
  "ROOM_CLOSED",
  "USER_UNAVAILABLE",
  "USER_REJECTED",
  "SIP_TRUNK_FAILURE",
  "CONNECTION_TIMEOUT",
  "MEDIA_FAILURE",
] as const;
const DisconnectReason: Record<string, number | string> = {};
DR_NAMES.forEach((n, i) => {
  DisconnectReason[n] = i;
  DisconnectReason[i] = n;
});
const DR = Object.fromEntries(DR_NAMES.map((n, i) => [n, i])) as Record<(typeof DR_NAMES)[number], number>;

const RoomEvent = {
  Reconnecting: "reconnecting",
  Reconnected: "reconnected",
  Disconnected: "disconnected",
  MediaDevicesError: "mediaDevicesError",
  MediaDevicesChanged: "mediaDevicesChanged",
};
const TrackEvent = { Ended: "ended" };

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Cb = (...args: unknown[]) => void;

class Emitter {
  private handlers = new Map<string, Set<Cb>>();
  on(ev: string, cb: Cb) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(cb);
    return this;
  }
  off(ev: string, cb: Cb) {
    this.handlers.get(ev)?.delete(cb);
    return this;
  }
  emit(ev: string, ...args: unknown[]) {
    for (const cb of Array.from(this.handlers.get(ev) ?? [])) cb(...args);
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  listenerCount(ev: string) {
    return this.handlers.get(ev)?.size ?? 0;
  }
}

const log: string[] = [];

/** Per-test knobs for the fake room. */
const ctl = {
  connect: async (_r: FakeRoom): Promise<void> => {},
  camera: async (r: FakeRoom): Promise<{ track?: FakeTrack } | undefined> => ({ track: r.track }),
};

class FakeTrack extends Emitter {}

class FakeRoom extends Emitter {
  static instances: FakeRoom[] = [];
  options: Record<string, unknown>;
  connectArgs: { url: string; token: string; opts?: { autoSubscribe?: boolean } } | null = null;
  disconnectCalls = 0;
  track = new FakeTrack();
  cameraCalls = 0;
  localParticipant = {
    setCameraEnabled: async (enabled: boolean) => {
      this.cameraCalls++;
      expect(enabled).toBe(true);
      return ctl.camera(this);
    },
  };
  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    FakeRoom.instances.push(this);
  }
  async connect(url: string, token: string, opts?: { autoSubscribe?: boolean }) {
    this.connectArgs = { url, token, opts };
    log.push(`connect:${token}`);
    await ctl.connect(this);
  }
  async disconnect() {
    this.disconnectCalls++;
    log.push("disconnect");
  }
}

class FakeVideoPreset {
  constructor(
    public width: number,
    public height: number,
    public maxBitrate: number,
    public maxFramerate?: number,
  ) {}
}

const FakeSdk = {
  Room: FakeRoom,
  VideoPreset: FakeVideoPreset,
  VideoPresets: { h360: { resolution: { width: 640, height: 360, frameRate: 30 } } },
  RoomEvent,
  TrackEvent,
  DisconnectReason,
} as unknown as PublisherSdk;

/** Minimal Web Locks: exclusive, FIFO queue, ifAvailable, AbortSignal. */
class FakeLocks implements LockManagerLike {
  holder: object | null = null;
  queue: { cb: (l: unknown) => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void; signal?: AbortSignal }[] = [];

  request(_name: string, opts: { ifAvailable?: boolean; signal?: AbortSignal }, cb: (l: unknown) => unknown) {
    return new Promise((resolve, reject) => {
      const entry = { cb, resolve, reject, signal: opts.signal };
      if (!this.holder) return this.grant(entry);
      if (opts.ifAvailable) {
        Promise.resolve(cb(null)).then(resolve, reject);
        return;
      }
      this.queue.push(entry);
      opts.signal?.addEventListener("abort", () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
          this.queue.splice(i, 1);
          reject(new Error("AbortError"));
        }
      });
    });
  }

  private grant(entry: (typeof this.queue)[number]) {
    const lock = { name: "naffai-live-publisher" };
    this.holder = lock;
    Promise.resolve(entry.cb(lock)).then(
      (v) => {
        this.release(lock);
        entry.resolve(v);
      },
      (e) => {
        this.release(lock);
        entry.reject(e);
      },
    );
  }

  private release(lock: object) {
    if (this.holder !== lock) return;
    this.holder = null;
    const next = this.queue.shift();
    if (next) this.grant(next);
  }

  /** Simulate another tab holding the lock; returns its release. */
  occupy(): () => void {
    let done!: () => void;
    this.request("x", {}, () => new Promise<void>((r) => (done = r)));
    return () => done();
  }
}

class FakeTarget {
  private cbs = new Map<string, Set<() => void>>();
  addEventListener(type: string, cb: () => void) {
    if (!this.cbs.has(type)) this.cbs.set(type, new Set());
    this.cbs.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: () => void) {
    this.cbs.get(type)?.delete(cb);
  }
  fire(type: string) {
    for (const cb of Array.from(this.cbs.get(type) ?? [])) cb();
  }
  count(type: string) {
    return this.cbs.get(type)?.size ?? 0;
  }
}

class FakeDoc extends FakeTarget {
  visibilityState: "visible" | "hidden" = "visible";
}

const httpErr = (status: number, code?: string) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data: code ? { code } : {} } });
const netErr = () => new Error("Network Error");
const domErr = (name: string) => Object.assign(new Error(name), { name });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tokenSeq = 0;
function makeToken(ttlMs = 12 * 3600_000): RoomTokenResponse {
  tokenSeq++;
  return {
    ws_url: "wss://lk.test",
    room_name: "callcenter",
    participant_identity: "op:7",
    participant_name: "Op 7",
    token: `tok-${tokenSeq}`,
    can_publish: true,
    can_subscribe: false,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };
}

async function flush(n = 30) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function setup(opts: { locks?: FakeLocks | null } = {}) {
  const tokenImpl = { fn: async () => makeToken() };
  const globalImpl = { fn: async () => ({ enabled: true }) };
  const fetchToken = vi.fn(() => tokenImpl.fn());
  const fetchGlobalStatus = vi.fn(() => globalImpl.fn());
  const locks = opts.locks === undefined ? new FakeLocks() : opts.locks;
  const doc = new FakeDoc();
  const media = new FakeTarget();
  const engine = createLivePublisherEngine({
    loadSdk: async () => FakeSdk,
    fetchToken,
    fetchGlobalStatus,
    locks,
    now: () => Date.now(),
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    doc,
    mediaDevices: media,
    random: () => 0,
  });
  const statuses: LivePublisherStatus[] = [];
  engine.store.subscribe((s, prev) => {
    if (s.status !== prev.status) {
      statuses.push(s.status);
      log.push(`status:${s.status}`);
    }
  });
  return { engine, fetchToken, fetchGlobalStatus, tokenImpl, globalImpl, locks, doc, media, statuses };
}

const lastRoom = () => FakeRoom.instances[FakeRoom.instances.length - 1];
const st = (e: LivePublisherEngine) => e.getState();

let engines: LivePublisherEngine[] = [];
function track<T extends { engine: LivePublisherEngine }>(h: T): T {
  engines.push(h.engine);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T09:00:00Z"));
  FakeRoom.instances = [];
  log.length = 0;
  tokenSeq = 0;
  ctl.connect = async () => {};
  ctl.camera = async (r) => ({ track: r.track });
  engines = [];
});

afterEach(() => {
  engines.forEach((e) => e.dispose());
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("livePublisher engine", () => {
  it("happy path: lock → token → connect(autoSubscribe:false) → camera → live", async () => {
    const h = track(setup());
    h.engine.setEnabled(true);
    expect(st(h.engine).status).toBe("connecting");
    await flush();

    expect(st(h.engine).status).toBe("live");
    expect(h.fetchToken).toHaveBeenCalledTimes(1);
    const room = lastRoom();
    expect(room.connectArgs).toEqual({ url: "wss://lk.test", token: "tok-1", opts: { autoSubscribe: false } });
    expect(room.cameraCalls).toBe(1);
    expect(h.locks!.holder).not.toBeNull();

    const o = room.options as Record<string, any>;
    expect(o.adaptiveStream).toBe(false);
    expect(o.dynacast).toBe(true);
    expect(o.stopLocalTrackOnUnpublish).toBe(true);
    expect(o.disconnectOnPageLeave).toBe(true);
    expect(o.videoCaptureDefaults).toEqual({ resolution: { width: 640, height: 360, frameRate: 30 }, facingMode: "user" });
    expect(o.publishDefaults.simulcast).toBe(true);
    expect(o.publishDefaults.videoCodec).toBe("h264");
    expect(o.publishDefaults.videoSimulcastLayers).toHaveLength(1);
    expect(o.publishDefaults.videoSimulcastLayers[0]).toMatchObject({ width: 320, height: 180, maxBitrate: 150_000, maxFramerate: 15 });
    expect(o.publishDefaults.videoEncoding).toEqual({ maxBitrate: 400_000, maxFramerate: 15 });
    expect(o.publishDefaults.degradationPreference).toBe("maintain-framerate");
  });

  it("camera throws NotAllowedError → room disconnected FIRST, then denied (no auto retry)", async () => {
    ctl.camera = async () => {
      throw domErr("NotAllowedError");
    };
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();

    expect(st(h.engine).status).toBe("denied");
    expect(lastRoom().disconnectCalls).toBe(1);
    expect(log.indexOf("disconnect")).toBeLessThan(log.indexOf("status:denied"));
    expect(lastRoom().listenerCount(RoomEvent.Disconnected)).toBe(0);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.fetchToken).toHaveBeenCalledTimes(1);
  });

  it("camera NotFoundError → no_camera; devicechange retries", async () => {
    let fail = true;
    ctl.camera = async (r) => {
      if (fail) throw domErr("NotFoundError");
      return { track: r.track };
    };
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    expect(st(h.engine).status).toBe("no_camera");
    expect(lastRoom().disconnectCalls).toBe(1);

    fail = false;
    h.media.fire("devicechange");
    await flush();
    expect(st(h.engine).status).toBe("live");
    expect(h.fetchToken).toHaveBeenCalledTimes(2);
  });

  it("camera track Ended while live → no_camera + room dropped", async () => {
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    const room = lastRoom();
    room.track.emit(TrackEvent.Ended);
    await flush();
    expect(st(h.engine).status).toBe("no_camera");
    expect(room.disconnectCalls).toBe(1);
  });

  it("other camera errors → error + backoff", async () => {
    ctl.camera = async () => {
      throw domErr("NotReadableError");
    };
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    expect(st(h.engine).status).toBe("error");
    expect(st(h.engine).retryAt).toBe(Date.now() + 2000);
    expect(lastRoom().disconnectCalls).toBe(1);
  });

  it("Disconnected(UNKNOWN) → retrying with growing backoff and a fresh token per attempt", async () => {
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    expect(st(h.engine).status).toBe("live");

    h.tokenImpl.fn = async () => {
      throw netErr();
    };
    lastRoom().emit(RoomEvent.Disconnected, DR.UNKNOWN_REASON);
    expect(st(h.engine).status).toBe("retrying");
    expect(st(h.engine).attempt).toBe(1);
    expect(st(h.engine).retryAt).toBe(Date.now() + 2000);

    await vi.advanceTimersByTimeAsync(1999);
    expect(h.fetchToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.fetchToken).toHaveBeenCalledTimes(2);
    expect(st(h.engine).status).toBe("retrying");
    expect(st(h.engine).attempt).toBe(2);
    expect(st(h.engine).retryAt).toBe(Date.now() + 4000);

    await vi.advanceTimersByTimeAsync(4000);
    await flush();
    expect(h.fetchToken).toHaveBeenCalledTimes(3);
    expect(st(h.engine).retryAt).toBe(Date.now() + 8000);

    h.tokenImpl.fn = async () => makeToken();
    await vi.advanceTimersByTimeAsync(8000);
    await flush();
    expect(st(h.engine).status).toBe("live");
    expect(st(h.engine).attempt).toBe(0);
    // tok-1 was the original; failed attempts consumed no token; next = tok-2.
    expect(lastRoom().connectArgs?.token).toBe("tok-2");
    expect(FakeRoom.instances).toHaveLength(2);
  });

  it("backoff is capped at 60 s", async () => {
    const h = track(setup());
    h.tokenImpl.fn = async () => {
      throw httpErr(502);
    };
    h.engine.setEnabled(true);
    await flush();
    for (let i = 0; i < 8; i++) {
      const wait = st(h.engine).retryAt! - Date.now();
      await vi.advanceTimersByTimeAsync(wait);
      await flush();
    }
    expect(st(h.engine).retryAt! - Date.now()).toBe(60_000);
  });

  it.each(["PARTICIPANT_REMOVED", "ROOM_DELETED", "ROOM_CLOSED", "USER_REJECTED"] as const)(
    "%s → disabled_operator, no reconnect timer, single re-probe on next poll tick",
    async (reason) => {
      const h = track(setup());
      h.engine.setEnabled(true);
      await flush();
      lastRoom().emit(RoomEvent.Disconnected, DR[reason]);
      expect(st(h.engine).status).toBe("disabled_operator");
      expect(st(h.engine).kickReason).toBe(reason);
      expect(st(h.engine).retryAt).toBeNull();

      await vi.advanceTimersByTimeAsync(POLL_VISIBLE_MS - 1);
      expect(h.fetchToken).toHaveBeenCalledTimes(1);

      // Re-probe says: still forbidden (operator paused).
      h.tokenImpl.fn = async () => {
        throw httpErr(403, "livestream_disabled");
      };
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(h.fetchToken).toHaveBeenCalledTimes(2);
      expect(st(h.engine).status).toBe("disabled_operator");
      expect(st(h.engine).kickReason).toBe("livestream_disabled");

      // Further poll ticks don't hammer the token endpoint; only the slow probe does.
      await vi.advanceTimersByTimeAsync(SLOW_PROBE_MS - 1);
      expect(h.fetchToken).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(h.fetchToken).toHaveBeenCalledTimes(3);
    },
  );

  it("kick then re-probe succeeds → live again", async () => {
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    lastRoom().emit(RoomEvent.Disconnected, DR.PARTICIPANT_REMOVED);
    await vi.advanceTimersByTimeAsync(POLL_VISIBLE_MS);
    await flush();
    expect(st(h.engine).status).toBe("live");
    expect(FakeRoom.instances).toHaveLength(2);
  });

  it("DUPLICATE_IDENTITY → other_tab, no reconnect", async () => {
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    lastRoom().emit(RoomEvent.Disconnected, DR.DUPLICATE_IDENTITY);
    expect(st(h.engine).status).toBe("other_tab");
    expect(st(h.engine).kickReason).toBe("DUPLICATE_IDENTITY");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flush();
    expect(h.fetchToken).toHaveBeenCalledTimes(1);
    expect(st(h.engine).status).toBe("other_tab");

    // Manual take-over.
    h.engine.retryNow();
    await flush();
    expect(st(h.engine).status).toBe("live");
  });

  it("Reconnecting / Reconnected map to reconnecting / live", async () => {
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    lastRoom().emit(RoomEvent.Reconnecting);
    expect(st(h.engine).status).toBe("reconnecting");
    lastRoom().emit(RoomEvent.Reconnected);
    expect(st(h.engine).status).toBe("live");
  });

  it("lock held by another tab → other_tab; takes over when it is released", async () => {
    const locks = new FakeLocks();
    const releaseOther = locks.occupy();
    const h = track(setup({ locks }));
    h.engine.setEnabled(true);
    await flush();
    expect(st(h.engine).status).toBe("other_tab");
    expect(h.fetchToken).not.toHaveBeenCalled();

    releaseOther();
    await flush();
    expect(h.statuses).toContain("connecting");
    expect(h.fetchToken).toHaveBeenCalledTimes(1);
    expect(st(h.engine).status).toBe("live");
  });

  it("no navigator.locks → proceeds without coordination", async () => {
    const h = track(setup({ locks: null }));
    h.engine.setEnabled(true);
    await flush();
    expect(st(h.engine).status).toBe("live");
  });

  it("token errors map to statuses", async () => {
    const cases: [unknown, LivePublisherStatus][] = [
      [httpErr(503, "livestream_global_disabled"), "disabled_global"],
      [httpErr(403, "livestream_disabled"), "disabled_operator"],
      [httpErr(503, "livestream_misconfigured"), "unavailable"],
      [httpErr(404), "unavailable"],
      [httpErr(500), "retrying"],
      [netErr(), "retrying"],
    ];
    for (const [err, expected] of cases) {
      const h = track(setup());
      h.tokenImpl.fn = async () => {
        throw err;
      };
      h.engine.setEnabled(true);
      await flush();
      expect(st(h.engine).status).toBe(expected);
      expect(FakeRoom.instances).toHaveLength(0);
      h.engine.dispose();
    }
  });

  it("killswitch: false → disconnect + disabled_global; true → reconnect", async () => {
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    const room1 = lastRoom();

    h.globalImpl.fn = async () => ({ enabled: false });
    await vi.advanceTimersByTimeAsync(POLL_VISIBLE_MS);
    await flush();
    expect(st(h.engine).status).toBe("disabled_global");
    expect(room1.disconnectCalls).toBe(1);

    // Still off on the next (faster) tick — nothing happens.
    await vi.advanceTimersByTimeAsync(POLL_DISABLED_MS);
    await flush();
    expect(h.fetchToken).toHaveBeenCalledTimes(1);

    // Back on: picked up within the short wait-for-switch interval.
    h.globalImpl.fn = async () => ({ enabled: true });
    await vi.advanceTimersByTimeAsync(POLL_DISABLED_MS);
    await flush();
    expect(st(h.engine).status).toBe("live");
    expect(h.fetchToken).toHaveBeenCalledTimes(2);
    expect(FakeRoom.instances).toHaveLength(2);
  });

  it("poll error is fail-open: status unchanged, polling continues", async () => {
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    h.globalImpl.fn = async () => {
      throw netErr();
    };
    await vi.advanceTimersByTimeAsync(POLL_VISIBLE_MS);
    await flush();
    expect(st(h.engine).status).toBe("live");
    expect(lastRoom().disconnectCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_VISIBLE_MS);
    await flush();
    expect(h.fetchGlobalStatus).toHaveBeenCalledTimes(2);
  });

  it("hidden tab polls every 120 s; becoming visible checks immediately", async () => {
    const h = track(setup());
    h.doc.visibilityState = "hidden";
    h.engine.setEnabled(true);
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_VISIBLE_MS);
    expect(h.fetchGlobalStatus).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(POLL_HIDDEN_MS - POLL_VISIBLE_MS);
    await flush();
    expect(h.fetchGlobalStatus).toHaveBeenCalledTimes(1);

    h.doc.visibilityState = "visible";
    h.doc.fire("visibilitychange");
    await flush();
    expect(h.fetchGlobalStatus).toHaveBeenCalledTimes(2);
    // Back to the 30 s cadence.
    await vi.advanceTimersByTimeAsync(POLL_VISIBLE_MS);
    await flush();
    expect(h.fetchGlobalStatus).toHaveBeenCalledTimes(3);
  });

  it("pause → disconnect + paused_by_user (polls don't resume); resume → reconnect", async () => {
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    const room1 = lastRoom();

    h.engine.getState().pause();
    expect(st(h.engine).status).toBe("paused_by_user");
    expect(room1.disconnectCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * POLL_VISIBLE_MS);
    await flush();
    expect(h.fetchToken).toHaveBeenCalledTimes(1);
    expect(st(h.engine).status).toBe("paused_by_user");

    h.engine.getState().resume();
    await flush();
    expect(st(h.engine).status).toBe("live");
    expect(h.fetchToken).toHaveBeenCalledTimes(2);
    expect(FakeRoom.instances).toHaveLength(2);
  });

  it("planned token rotation at expires_at − 10 min", async () => {
    const h = track(setup());
    h.tokenImpl.fn = async () => makeToken(30 * 60_000);
    h.engine.setEnabled(true);
    await flush();
    const room1 = lastRoom();

    await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
    expect(h.fetchToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.fetchToken).toHaveBeenCalledTimes(2);
    expect(h.statuses).toContain("reconnecting");
    expect(room1.disconnectCalls).toBe(1);
    expect(lastRoom()).not.toBe(room1);
    expect(lastRoom().connectArgs?.token).toBe("tok-2");
    expect(st(h.engine).status).toBe("live");
  });

  it("double setEnabled(true) / retain twice → exactly one connect", async () => {
    const h = track(setup());
    h.engine.setEnabled(true);
    h.engine.setEnabled(true);
    const rel1 = h.engine.retain();
    const rel2 = h.engine.retain();
    await flush();
    expect(h.fetchToken).toHaveBeenCalledTimes(1);
    expect(FakeRoom.instances).toHaveLength(1);
    rel1();
    rel2();
  });

  it("StrictMode retain → release → retain keeps the same room", async () => {
    const h = track(setup());
    const rel = h.engine.retain();
    await flush();
    rel();
    const rel2 = h.engine.retain();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(FakeRoom.instances).toHaveLength(1);
    expect(lastRoom().disconnectCalls).toBe(0);
    expect(st(h.engine).status).toBe("live");

    rel2();
    await vi.advanceTimersByTimeAsync(0);
    expect(st(h.engine).status).toBe("off");
    expect(lastRoom().disconnectCalls).toBe(1);
  });

  it("dispose releases the lock, clears timers and listeners, status off", async () => {
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(h.doc.count("visibilitychange")).toBe(1);

    h.engine.dispose();
    await flush();
    expect(st(h.engine).status).toBe("off");
    expect(lastRoom().disconnectCalls).toBe(1);
    expect(h.locks!.holder).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.doc.count("visibilitychange")).toBe(0);
    expect(h.media.count("devicechange")).toBe(0);

    // A second tab waiting on the lock gets it now.
    const h2 = track(setup({ locks: h.locks }));
    h2.engine.setEnabled(true);
    await flush();
    expect(st(h2.engine).status).toBe("live");
  });

  it("dispose while waiting for the lock aborts the queued request", async () => {
    const locks = new FakeLocks();
    const releaseOther = locks.occupy();
    const h = track(setup({ locks }));
    h.engine.setEnabled(true);
    await flush();
    expect(locks.queue).toHaveLength(1);
    h.engine.dispose();
    await flush();
    expect(locks.queue).toHaveLength(0);
    releaseOther();
    await flush();
    expect(h.fetchToken).not.toHaveBeenCalled();
    expect(st(h.engine).status).toBe("off");
  });

  it("disable mid-connect leaves no connected room behind", async () => {
    let releaseConnect!: () => void;
    ctl.connect = () => new Promise<void>((r) => (releaseConnect = r));
    const h = track(setup());
    h.engine.setEnabled(true);
    await flush();
    h.engine.setEnabled(false);
    releaseConnect();
    await flush();
    expect(st(h.engine).status).toBe("off");
    expect(lastRoom().disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(lastRoom().cameraCalls).toBe(0);
  });
});

describe("mirrored livekit-client constants", () => {
  it("match the real SDK enums", async () => {
    const lk = await import("livekit-client");
    for (const name of DR_NAMES) {
      expect(lk.DisconnectReason[name as keyof typeof lk.DisconnectReason]).toBe(DR[name]);
    }
    for (const [k, v] of Object.entries(RoomEvent)) {
      expect(lk.RoomEvent[k as keyof typeof lk.RoomEvent]).toBe(v);
    }
    expect(lk.TrackEvent.Ended).toBe(TrackEvent.Ended);
    const preset = new lk.VideoPreset(320, 180, 150_000, 15);
    expect(preset.width).toBe(320);
    expect(preset.encoding).toMatchObject({ maxBitrate: 150_000, maxFramerate: 15 });
  });
});
