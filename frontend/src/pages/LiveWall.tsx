/**
 * LiveWall — manager-only grid of currently publishing operators.
 * Polls `/live/live-now/` every 5 seconds to refresh the active list,
 * subscribes to the LiveKit room once on mount with the manager JWT.
 *
 * Simple interaction model:
 *   • default = grid preview, no audio
 *   • click a tile → expands into a focused view with an audio toggle
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchLiveNow, fetchRoomToken } from "../lib/liveRoom";
import { api } from "../lib/api";

type LivekitSDK = typeof import("livekit-client");

type RemoteParticipantAdapter = {
  identity: string;
  // Each participant has a Map-like set of video tracks; we lazy-grab
  // the one tagged camera.
  videoEl: HTMLVideoElement | null;
};

type Tile = {
  identity: string;
  operatorName: string;
  operatorId: number;
  isLive: boolean;
  attachedTrack: boolean;
};

export default function LiveWall() {
  const [sdk, setSdk] = useState<LivekitSDK | null>(null);
  const [connected, setConnected] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [audioOn, setAudioOn] = useState(false);
  const [errText, setErrText] = useState<string>("");
  const roomRef = useRef<unknown>(null);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

  const liveNowQuery = useQuery({
    queryKey: ["live-now"],
    queryFn: fetchLiveNow,
    refetchInterval: 5000,
    staleTime: 2000,
  });

  const qc = useQueryClient();
  // Global killswitch state + mutation.
  const globalQuery = useQuery({
    queryKey: ["live-global-status"],
    queryFn: () => api.get<{ enabled: boolean }>("/live/global-status/").then((r) => r.data),
    refetchInterval: 5000,
    staleTime: 2000,
  });
  const killMut = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<{ enabled: boolean }>("/live/global-status/", { enabled }).then((r) => r.data),
    onSuccess: (d) => {
      qc.setQueryData(["live-global-status"], d);
      qc.invalidateQueries({ queryKey: ["live-now"] });
    },
  });
  const globalOn = globalQuery.data?.enabled !== false;

  // Lazy-load the LiveKit SDK on first mount.
  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const mod = await import("livekit-client");
        if (!aborted) setSdk(mod);
      } catch (e) {
        if (!aborted) setErrText(`SDK: ${(e as Error).message}`);
      }
    })();
    return () => {
      aborted = true;
    };
  }, []);

  // Connect to the room once SDK is ready. Reconnect only on explicit
  // user action — the token is good for 12h so a single connect lasts
  // through a normal shift.
  useEffect(() => {
    if (!sdk) return;
    let cancelled = false;
    (async () => {
      let token: Awaited<ReturnType<typeof fetchRoomToken>>;
      try {
        token = await fetchRoomToken();
      } catch (e) {
        const err = e as { response?: { status?: number } };
        if (err?.response?.status === 503 || err?.response?.status === 404) {
          setErrText(
            "Live-эфир не настроен на этом окружении (нет LIVEKIT_* в .env)."
          );
          return;
        }
        setErrText(`token: ${(e as Error).message || e}`);
        return;
      }
      const room = new sdk.Room({ adaptiveStream: true });
      roomRef.current = room;

      // When a track is subscribed, find the matching <video> element in
      // the grid and attach it. If the element isn't mounted yet (grid
      // row created async), we retry on each render via useEffect below.
      room.on(sdk.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind !== sdk.Track.Kind.Video) return;
        const el = videoRefs.current.get(participant.identity);
        if (el) {
          track.attach(el);
        }
      });
      room.on(sdk.RoomEvent.TrackUnsubscribed, (track) => {
        try {
          track.detach();
        } catch {
          // ignore
        }
      });

      try {
        await room.connect(token.ws_url, token.token, {
          autoSubscribe: true,
        });
        if (cancelled) {
          await room.disconnect();
          return;
        }
        setConnected(true);
      } catch (e) {
        setErrText(`connect: ${(e as Error).message || e}`);
      }
    })();
    return () => {
      cancelled = true;
      const room = roomRef.current as { disconnect?: () => Promise<void> } | null;
      if (room?.disconnect) room.disconnect().catch(() => {});
      roomRef.current = null;
    };
  }, [sdk]);

  // Each render — re-attach tracks for participants that already have a
  // subscribed track but whose <video> wasn't mounted during the
  // original TrackSubscribed event. This mostly matters for the first
  // few seconds after mount.
  useEffect(() => {
    if (!sdk || !connected) return;
    const room = roomRef.current as {
      remoteParticipants: Map<string, {
        identity: string;
        videoTrackPublications: Map<string, {
          isSubscribed: boolean;
          track?: { attach: (el: HTMLMediaElement) => void };
        }>;
      }>;
    } | null;
    if (!room) return;
    for (const participant of room.remoteParticipants.values()) {
      const el = videoRefs.current.get(participant.identity);
      if (!el) continue;
      for (const pub of participant.videoTrackPublications.values()) {
        if (pub.isSubscribed && pub.track) {
          pub.track.attach(el);
          break;
        }
      }
    }
  });

  // Mute/unmute audio from the focused participant. Simple approach —
  // iterate audio pubs on focused identity, toggle enable.
  useEffect(() => {
    if (!sdk || !connected) return;
    const room = roomRef.current as {
      remoteParticipants: Map<string, {
        identity: string;
        audioTrackPublications: Map<string, {
          isSubscribed: boolean;
          setSubscribed: (sub: boolean) => void;
          track?: { setMuted: (m: boolean) => void };
        }>;
      }>;
    } | null;
    if (!room) return;
    for (const participant of room.remoteParticipants.values()) {
      const wantAudio = audioOn && participant.identity === focused;
      for (const pub of participant.audioTrackPublications.values()) {
        pub.setSubscribed(wantAudio);
      }
    }
  }, [sdk, connected, focused, audioOn]);

  const tiles: Tile[] = useMemo(() => {
    const live = liveNowQuery.data?.live_now ?? [];
    return live.map((row) => ({
      identity: row.participant_identity,
      operatorName: row.operator_name,
      operatorId: row.operator_id,
      isLive: true,
      attachedTrack: videoRefs.current.has(row.participant_identity),
    }));
  }, [liveNowQuery.data]);

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Live-эфир операторов</h1>
          <p className="text-sm text-slate-500">
            {connected ? "Подключено к LiveKit." : "Подключение…"}
            {tiles.length > 0 && ` · В эфире: ${tiles.length}.`}
          </p>
        </div>
        {errText && (
          <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 border border-rose-200">
            {errText}
          </div>
        )}
      </header>

      {/* Global killswitch — one big button. */}
      <button
        type="button"
        disabled={killMut.isPending}
        onClick={() => killMut.mutate(!globalOn)}
        className={`w-full rounded-xl px-6 py-5 text-lg font-bold tracking-tight shadow-sm transition-all ${
          globalOn
            ? "bg-emerald-500 text-white hover:bg-emerald-600 border border-emerald-600"
            : "bg-rose-600 text-white hover:bg-rose-700 border border-rose-700"
        } ${killMut.isPending ? "opacity-60 cursor-wait" : "cursor-pointer"}`}
      >
        {killMut.isPending
          ? "…"
          : globalOn
          ? "🟢 Live-эфир ВКЛЮЧЁН — нажми чтобы ВЫКЛЮЧИТЬ всех"
          : "🔴 Live-эфир ВЫКЛЮЧЕН — нажми чтобы ВКЛЮЧИТЬ"}
      </button>
      <p className="text-xs text-slate-500">
        При выключении все 40 webcam-стримов остановятся в течение 10 секунд,
        SFU-сервер разгрузится. Включение — обратно (операторы автоматически
        подхватят на следующий tick).
      </p>

      {focused && (
        <div className="rounded-xl border border-slate-200 bg-black overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-slate-900 text-white">
            <span className="text-sm font-medium">
              {tiles.find((t) => t.identity === focused)?.operatorName ?? focused}
            </span>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={audioOn}
                  onChange={(e) => setAudioOn(e.target.checked)}
                />
                Звук
              </label>
              <button
                onClick={() => {
                  setFocused(null);
                  setAudioOn(false);
                }}
                className="px-2 py-0.5 rounded hover:bg-white/10"
              >
                Закрыть
              </button>
            </div>
          </div>
          <video
            ref={(el) => {
              if (el) videoRefs.current.set(focused, el);
            }}
            autoPlay
            playsInline
            muted={!audioOn}
            className="w-full aspect-video bg-black"
          />
        </div>
      )}

      {!focused && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {tiles.length === 0 && (
            <div className="col-span-full rounded-lg border border-dashed border-slate-200 bg-slate-50 p-10 text-center text-sm text-slate-500">
              Сейчас никто не в эфире.
            </div>
          )}
          {tiles.map((tile) => (
            <button
              key={tile.identity}
              type="button"
              onClick={() => setFocused(tile.identity)}
              className="group text-left rounded-xl border border-slate-200 bg-slate-900 overflow-hidden hover:ring-2 hover:ring-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-500"
            >
              <div className="relative">
                <video
                  ref={(el) => {
                    if (el) videoRefs.current.set(tile.identity, el);
                  }}
                  autoPlay
                  playsInline
                  muted
                  className="w-full aspect-video bg-black object-cover"
                />
                <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-rose-500/90 px-2 py-0.5 text-[10px] font-medium text-white">
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white"></span>
                  LIVE
                </span>
              </div>
              <div className="px-3 py-2 bg-white text-sm text-slate-900">
                {tile.operatorName}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
