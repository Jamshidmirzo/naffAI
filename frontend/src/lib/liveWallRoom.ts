/**
 * useLiveWallRoom — manager-side LiveKit subscriber for the Live wall.
 *
 * One Room per mounted wall, connected with `autoSubscribe:false`; we
 * subscribe ONLY to camera tracks of the identities the page wants
 * (visible + filtered tiles, plus the focused one). Subscriptions are
 * reconciled by the pure `computeSubscriptions()` whenever room
 * membership/publications change or the wanted set changes.
 *
 * `adaptiveStream:true` lets the SDK pick the simulcast layer from the
 * rendered <video> size, so the grid pulls the 180p layer and the focus
 * view the 360p one without manual quality juggling.
 *
 * `livekit-client` is imported lazily — only types at module top.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConnectionQuality,
  RemoteParticipant,
  RemoteVideoTrack,
  Room,
} from "livekit-client";
import { fetchRoomToken, liveErrorCode } from "./liveRoom";

type LivekitSDK = typeof import("livekit-client");

export type WallConnection =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "unavailable"
  | "error";

export type WallParticipant = {
  identity: string;
  sid: string;
  videoTrack: RemoteVideoTrack | null;
  /** Camera is published and not muted. */
  hasVideo: boolean;
  isMuted: boolean;
  quality: ConnectionQuality | string;
};

// ---------------------------------------------------------------------------
// Pure reconciliation (unit-tested)
// ---------------------------------------------------------------------------

export interface SubscribablePublication {
  kind: string;
  source: string;
  /** RemoteTrackPublication.isDesired (falls back to isSubscribed). */
  isDesired?: boolean;
  isSubscribed?: boolean;
  setSubscribed(subscribed: boolean): void;
}

export interface SubscribableParticipant {
  identity: string;
  trackPublications: Map<string, SubscribablePublication> | Iterable<[string, SubscribablePublication]>;
}

export type SubscriptionChange = {
  identity: string;
  publication: SubscribablePublication;
  subscribe: boolean;
};

const isCameraPub = (p: SubscribablePublication) =>
  p.kind === "video" && (p.source === "camera" || p.source === "unknown");

/**
 * Which camera publications must flip their subscription so that exactly
 * the `identities` are subscribed. Returns only the changes.
 */
export function computeSubscriptions(
  participants: Iterable<SubscribableParticipant>,
  identities: ReadonlySet<string>,
): SubscriptionChange[] {
  const out: SubscriptionChange[] = [];
  for (const p of participants) {
    const want = identities.has(p.identity);
    const pubs =
      p.trackPublications instanceof Map ? p.trackPublications.values() : Array.from(p.trackPublications, ([, v]) => v);
    for (const pub of pubs) {
      if (!isCameraPub(pub)) continue;
      const desired = pub.isDesired ?? pub.isSubscribed ?? false;
      if (desired !== want) out.push({ identity: p.identity, publication: pub, subscribe: want });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Connections shorter than this don't reset the one-shot auto retry. */
const STABLE_MS = 60_000;
const AUTO_RETRY_MS = 3_000;

export function useLiveWallRoom({
  identities,
  focusedIdentity,
  enabled = true,
}: {
  identities: ReadonlySet<string>;
  focusedIdentity: string | null;
  enabled?: boolean;
}) {
  const [connection, setConnection] = useState<WallConnection>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [canPlaybackVideo, setCanPlaybackVideo] = useState(true);
  const [attemptKey, setAttemptKey] = useState(0);

  const roomRef = useRef<Room | null>(null);
  const sdkRef = useRef<LivekitSDK | null>(null);
  const reconcileRef = useRef<() => void>(() => {});
  const autoRetriedRef = useRef(false);

  // Wanted = filtered identities ∪ focused. Kept in a ref so room
  // listeners always see the latest set without re-binding.
  const wanted = useMemo(() => {
    if (!focusedIdentity || identities.has(focusedIdentity)) return identities;
    const s = new Set(identities);
    s.add(focusedIdentity);
    return s;
  }, [identities, focusedIdentity]);
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;

  useEffect(() => {
    if (!enabled) {
      setConnection("idle");
      return;
    }
    let cancelled = false;
    let room: Room | null = null;
    let retryTimer: number | null = null;
    let connectedAt = 0;
    const bump = () => {
      if (!cancelled) setVersion((v) => v + 1);
    };

    (async () => {
      setConnection("connecting");
      setError(null);
      setErrorCode(null);

      let sdk: LivekitSDK;
      try {
        sdk = sdkRef.current ?? (sdkRef.current = await import("livekit-client"));
      } catch (e) {
        if (!cancelled) {
          setConnection("error");
          setError((e as Error).message || String(e));
        }
        return;
      }
      if (cancelled) return;

      let tok: Awaited<ReturnType<typeof fetchRoomToken>>;
      try {
        tok = await fetchRoomToken();
      } catch (e) {
        if (cancelled) return;
        const { status, code } = liveErrorCode(e);
        setErrorCode(code ?? (status ? String(status) : null));
        if (status === 404 || (status === 503 && code !== "livestream_global_disabled")) {
          setConnection("unavailable");
        } else {
          setConnection("error");
          setError(status ? `HTTP ${status}` : (e as Error).message || String(e));
        }
        return;
      }
      if (cancelled) return;

      const r = new sdk.Room({ adaptiveStream: true, dynacast: false });
      room = r;
      const E = sdk.RoomEvent;
      const DR = sdk.DisconnectReason;

      const reconcile = () => {
        if (cancelled || roomRef.current !== r) return;
        const changes = computeSubscriptions(
          r.remoteParticipants.values() as Iterable<SubscribableParticipant>,
          wantedRef.current,
        );
        for (const c of changes) c.publication.setSubscribed(c.subscribe);
        bump();
      };

      r.on(E.ParticipantConnected, reconcile)
        .on(E.ParticipantDisconnected, reconcile)
        .on(E.TrackPublished, reconcile)
        .on(E.TrackUnpublished, reconcile)
        .on(E.Connected, reconcile)
        .on(E.TrackSubscribed, bump)
        .on(E.TrackUnsubscribed, bump)
        .on(E.TrackMuted, bump)
        .on(E.TrackUnmuted, bump)
        .on(E.TrackStreamStateChanged, bump)
        .on(E.ConnectionQualityChanged, bump)
        .on(E.Reconnecting, () => {
          if (!cancelled) setConnection("reconnecting");
        })
        .on(E.Reconnected, () => {
          if (cancelled) return;
          setConnection("connected");
          reconcile();
        })
        .on(E.VideoPlaybackStatusChanged, () => {
          if (!cancelled) setCanPlaybackVideo(r.canPlaybackVideo);
        })
        .on(E.Disconnected, (reason) => {
          if (cancelled) return;
          if (roomRef.current === r) roomRef.current = null;
          setConnection("disconnected");
          bump();
          if (connectedAt && Date.now() - connectedAt > STABLE_MS) autoRetriedRef.current = false;
          const transient = reason === DR.UNKNOWN_REASON || reason === DR.MIGRATION || reason == null;
          if (transient && !autoRetriedRef.current) {
            autoRetriedRef.current = true;
            retryTimer = window.setTimeout(() => setAttemptKey((k) => k + 1), AUTO_RETRY_MS);
          }
        });

      try {
        await r.connect(tok.ws_url, tok.token, { autoSubscribe: false });
      } catch (e) {
        r.removeAllListeners();
        r.disconnect().catch(() => {});
        if (!cancelled) {
          setConnection("error");
          setError((e as Error).message || String(e));
        }
        return;
      }
      if (cancelled) {
        r.removeAllListeners();
        r.disconnect().catch(() => {});
        return;
      }
      connectedAt = Date.now();
      roomRef.current = r;
      reconcileRef.current = reconcile;
      setConnection("connected");
      setCanPlaybackVideo(r.canPlaybackVideo);
      reconcile();
    })();

    return () => {
      cancelled = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
      reconcileRef.current = () => {};
      if (room) {
        if (roomRef.current === room) roomRef.current = null;
        room.removeAllListeners();
        room.disconnect().catch(() => {});
      }
    };
  }, [enabled, attemptKey]);

  // Wanted set changed (search/filter/focus/live-now poll) → reconcile.
  useEffect(() => {
    reconcileRef.current();
  }, [wanted]);

  const participants = useMemo(() => {
    const map = new Map<string, WallParticipant>();
    const r = roomRef.current;
    const sdk = sdkRef.current;
    if (!r || !sdk) return map;
    r.remoteParticipants.forEach((p: RemoteParticipant) => {
      const pub = p.getTrackPublication(sdk.Track.Source.Camera);
      const track = pub?.isSubscribed && pub.track ? (pub.track as RemoteVideoTrack) : null;
      const isMuted = pub ? pub.isMuted : true;
      map.set(p.identity, {
        identity: p.identity,
        sid: p.sid,
        videoTrack: track,
        hasVideo: !!pub && !isMuted,
        isMuted,
        quality: p.connectionQuality,
      });
    });
    return map;
    // `version` is the change signal; the room itself is a mutable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, connection]);

  const startVideo = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    try {
      await r.startVideo();
    } finally {
      setCanPlaybackVideo(r.canPlaybackVideo);
    }
  }, []);

  const reconnect = useCallback(() => {
    autoRetriedRef.current = false;
    setAttemptKey((k) => k + 1);
  }, []);

  return { connection, error, errorCode, participants, canPlaybackVideo, startVideo, reconnect };
}
