/**
 * LiveStreamPublisher — mounts in AppShell for `operator`-role users
 * whose `/auth/me/` returned `livestream_enabled=true`. Lazily imports
 * `livekit-client` so the SDK bundle (~250 KB gz) stays off every other
 * page.
 *
 * Visible UI = a small floating indicator in the bottom-left corner:
 *   • «● в эфире» when the local track is publishing
 *   • «● включение…» during connection
 *   • «✖ камера выключена» when the user denied permission
 *
 * Opt-OUT is per-session via the «✖ закрыть эфир» button, but the
 * backend `livestream_enabled` flag is the source of truth across
 * reloads. Manager flips it from the operator card.
 *
 * Note on failure modes: if LiveKit is misconfigured (503 from the
 * backend) we show «эфир недоступен» and silently stop; nothing else
 * on the page is affected.
 */

import { useEffect, useRef, useState } from "react";
import { fetchRoomToken } from "../lib/liveRoom";
import { api } from "../lib/api";

// LiveKit SDK is heavy — load it dynamically on first mount.
type LivekitSDK = typeof import("livekit-client");

type Status =
  | "idle"
  | "connecting"
  | "live"
  | "disabled"
  | "denied"
  | "error"
  | "unavailable";

interface Props {
  /** Only mount the component when this is true (operator opt-in). */
  enabled: boolean;
}

export default function LiveStreamPublisher({ enabled }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [errText, setErrText] = useState<string>("");
  const [sdkReady, setSdkReady] = useState(false);
  // Global killswitch: start as true, poll every 10s. If backend reports
  // enabled=false — publisher stops. Re-enable spins up again on next tick.
  const [globalOn, setGlobalOn] = useState<boolean>(true);
  const sdkRef = useRef<LivekitSDK | null>(null);
  // Hold a reference to the active Room so cleanup can gracefully
  // disconnect; `any` because LivekitSDK isn't loaded at mount.
  const roomRef = useRef<unknown>(null);
  const cancelledRef = useRef(false);

  // Polling: /api/live/global-status/ every 10s.
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const check = async () => {
      try {
        const r = await api.get<{ enabled: boolean }>("/live/global-status/");
        if (!stopped) setGlobalOn(!!r.data?.enabled);
      } catch {
        // network / 503 — предполагаем выключено (fail-closed)
        if (!stopped) setGlobalOn(false);
      }
    };
    check();
    const id = window.setInterval(check, 10_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [enabled]);

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled || !globalOn) {
      setStatus("disabled");
      return;
    }
    let aborted = false;
    (async () => {
      try {
        setStatus("connecting");
        const sdk = await import("livekit-client");
        if (aborted) return;
        sdkRef.current = sdk;
        setSdkReady(true);
      } catch (e) {
        if (!aborted) {
          setStatus("error");
          setErrText(`SDK: ${(e as Error).message || e}`);
        }
      }
    })();
    return () => {
      aborted = true;
      cancelledRef.current = true;
    };
  }, [enabled, globalOn]);

  useEffect(() => {
    if (!enabled || !globalOn || !sdkReady || !sdkRef.current) {
      // Killswitch disabled mid-session — stop any active room immediately.
      const room = roomRef.current as { disconnect?: () => Promise<void> } | null;
      if (room?.disconnect) {
        room.disconnect().catch(() => {});
        roomRef.current = null;
      }
      return;
    }
    const sdk = sdkRef.current;
    let cancelled = false;

    (async () => {
      let token: Awaited<ReturnType<typeof fetchRoomToken>>;
      try {
        token = await fetchRoomToken();
      } catch (e) {
        const err = e as { response?: { status?: number } };
        if (err?.response?.status === 503 || err?.response?.status === 404) {
          setStatus("unavailable");
          return;
        }
        if (err?.response?.status === 403) {
          setStatus("disabled");
          return;
        }
        setStatus("error");
        setErrText(`token: ${(e as Error).message || e}`);
        return;
      }
      if (!token.can_publish) {
        setStatus("disabled");
        return;
      }

      const room = new sdk.Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: sdk.VideoPresets.h360.resolution,
          facingMode: "user",
        },
        publishDefaults: {
          videoSimulcastLayers: [sdk.VideoPresets.h360, sdk.VideoPresets.h360],
          videoCodec: "h264",
        },
      });
      roomRef.current = room;

      room.on(sdk.RoomEvent.Disconnected, () => {
        if (!cancelled) setStatus("idle");
      });
      room.on(sdk.RoomEvent.MediaDevicesError, (err) => {
        if (cancelled) return;
        const msg = (err as Error).message || String(err);
        if (/NotAllowed|Permission/i.test(msg)) {
          setStatus("denied");
        } else {
          setStatus("error");
          setErrText(msg);
        }
      });

      try {
        await room.connect(token.ws_url, token.token);
        if (cancelled) {
          await room.disconnect();
          return;
        }
        // Publish camera only — audio stays OFF until the manager
        // explicitly asks for it (future enhancement: data-channel
        // request).
        await room.localParticipant.setCameraEnabled(true);
        setStatus("live");
      } catch (e) {
        const msg = (e as Error).message || String(e);
        if (/NotAllowed|Permission/i.test(msg)) {
          setStatus("denied");
        } else {
          setStatus("error");
          setErrText(msg);
        }
      }
    })();

    return () => {
      cancelled = true;
      const room = roomRef.current as { disconnect?: () => Promise<void> } | null;
      if (room?.disconnect) {
        room.disconnect().catch(() => {});
      }
      roomRef.current = null;
    };
  }, [enabled, globalOn, sdkReady]);

  const handleCloseClick = async () => {
    const room = roomRef.current as { disconnect?: () => Promise<void> } | null;
    if (room?.disconnect) {
      try {
        await room.disconnect();
      } catch {
        // ignore
      }
    }
    setStatus("idle");
  };

  if (!enabled || status === "disabled") return null;
  // Operator chose to close the stream for this session — surface a
  // tiny "resume" affordance but don't dim the whole UI.
  if (status === "idle") return null;
  if (status === "unavailable") {
    // LiveKit not configured (503) — hide silently; no need to spam
    // operators with ops-level errors.
    return null;
  }

  const base =
    "fixed bottom-4 left-4 z-[80] flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur";
  const palette =
    status === "live"
      ? "bg-rose-50/90 border-rose-200 text-rose-700"
      : status === "connecting"
      ? "bg-amber-50/90 border-amber-200 text-amber-700"
      : "bg-slate-50/90 border-slate-200 text-slate-700";

  return (
    <div className={`${base} ${palette}`} role="status" aria-live="polite">
      {status === "live" && (
        <>
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-70"></span>
            <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500"></span>
          </span>
          <span>Вы в эфире</span>
          <button
            type="button"
            onClick={handleCloseClick}
            className="ml-1 text-rose-900/70 hover:text-rose-900"
            title="Закрыть эфир на эту сессию"
          >
            ✕
          </button>
        </>
      )}
      {status === "connecting" && (
        <>
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          <span>Включение камеры…</span>
        </>
      )}
      {status === "denied" && (
        <>
          <span className="inline-block h-2 w-2 rounded-full bg-slate-500" />
          <span>Камера заблокирована браузером</span>
        </>
      )}
      {status === "error" && (
        <>
          <span className="inline-block h-2 w-2 rounded-full bg-rose-500" />
          <span title={errText}>Ошибка эфира</span>
        </>
      )}
    </div>
  );
}
