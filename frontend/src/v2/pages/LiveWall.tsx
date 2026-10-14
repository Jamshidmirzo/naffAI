/**
 * v2 LiveWall — grid of operators currently publishing to LiveKit.
 * LiveKit logic is the same as the old page (lazy SDK, one room connect,
 * re-attach tracks on every render, audio only for the focused tile).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCw, Video, VideoOff } from "lucide-react";
import { fetchRoomToken } from "../../lib/liveRoom";
import { toast } from "../../components/ui";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, useConfirm } from "../ui";
import { useLiveGlobalStatus, useLiveGlobalToggle, useLiveNow } from "../api/team/trainingLive";

type LivekitSDK = typeof import("livekit-client");

const TILE_BG = "#1C1C1E";
const PLAYER_BG = "#000000";

type Tile = { identity: string; operatorName: string; operatorId: number };

export function LiveTabs({ at }: { at: "now" | "archive" }) {
  const t = useT2();
  return (
    <nav className="seg" aria-label={t("v2.team.trainingLive.liveTitle")}>
      <Link to="/live/wall" className={at === "now" ? "is-on" : undefined} aria-current={at === "now" ? "page" : undefined}>
        {t("v2.team.trainingLive.tabNow")}
      </Link>
      <Link to="/live/archive" className={at === "archive" ? "is-on" : undefined} aria-current={at === "archive" ? "page" : undefined}>
        {t("v2.team.trainingLive.tabArchive")}
      </Link>
    </nav>
  );
}

export default function LiveWall() {
  const t = useT2();
  const confirm = useConfirm();
  const [sdk, setSdk] = useState<LivekitSDK | null>(null);
  const [connected, setConnected] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [audioOn, setAudioOn] = useState(false);
  const [errText, setErrText] = useState("");
  const [attempt, setAttempt] = useState(0);
  const roomRef = useRef<unknown>(null);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

  const liveNowQuery = useLiveNow();
  const globalQuery = useLiveGlobalStatus();
  const killMut = useLiveGlobalToggle();
  // fail-open like the old page: unknown status counts as «on»
  const globalOn = globalQuery.data?.enabled !== false;

  // Lazy-load the LiveKit SDK.
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

  // Connect once the SDK is ready (token lives 12 h). `attempt` = manual reconnect.
  useEffect(() => {
    if (!sdk) return;
    let cancelled = false;
    setErrText("");
    setNotConfigured(false);
    (async () => {
      let token: Awaited<ReturnType<typeof fetchRoomToken>>;
      try {
        token = await fetchRoomToken();
      } catch (e) {
        if (cancelled) return;
        const status = (e as { response?: { status?: number } })?.response?.status;
        if (status === 503 || status === 404) {
          setNotConfigured(true);
          return;
        }
        setErrText(`token: ${(e as Error).message || e}`);
        return;
      }
      const room = new sdk.Room({ adaptiveStream: true });
      roomRef.current = room;
      room.on(sdk.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind !== sdk.Track.Kind.Video) return;
        const el = videoRefs.current.get(participant.identity);
        if (el) track.attach(el);
      });
      room.on(sdk.RoomEvent.TrackUnsubscribed, (track) => {
        try {
          track.detach();
        } catch {
          // ignore
        }
      });
      try {
        await room.connect(token.ws_url, token.token, { autoSubscribe: true });
        if (cancelled) {
          await room.disconnect();
          return;
        }
        setConnected(true);
      } catch (e) {
        if (!cancelled) setErrText(`connect: ${(e as Error).message || e}`);
      }
    })();
    return () => {
      cancelled = true;
      setConnected(false);
      const room = roomRef.current as { disconnect?: () => Promise<void> } | null;
      if (room?.disconnect) room.disconnect().catch(() => {});
      roomRef.current = null;
    };
  }, [sdk, attempt]);

  // Re-attach tracks whose <video> mounted after TrackSubscribed.
  useEffect(() => {
    if (!sdk || !connected) return;
    const room = roomRef.current as {
      remoteParticipants: Map<
        string,
        {
          identity: string;
          videoTrackPublications: Map<string, { isSubscribed: boolean; track?: { attach: (el: HTMLMediaElement) => void } }>;
        }
      >;
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

  // Audio only from the focused participant, only when «Звук» is on.
  useEffect(() => {
    if (!sdk || !connected) return;
    const room = roomRef.current as {
      remoteParticipants: Map<string, { identity: string; audioTrackPublications: Map<string, { setSubscribed: (sub: boolean) => void }> }>;
    } | null;
    if (!room) return;
    for (const participant of room.remoteParticipants.values()) {
      const wantAudio = audioOn && participant.identity === focused;
      for (const pub of participant.audioTrackPublications.values()) pub.setSubscribed(wantAudio);
    }
  }, [sdk, connected, focused, audioOn]);

  const tiles: Tile[] = useMemo(
    () =>
      (liveNowQuery.data?.live_now ?? []).map((row) => ({
        identity: row.participant_identity,
        operatorName: row.operator_name,
        operatorId: row.operator_id,
      })),
    [liveNowQuery.data],
  );

  // Focused operator left the air → back to the grid.
  useEffect(() => {
    if (focused && liveNowQuery.data && !tiles.some((x) => x.identity === focused)) {
      setFocused(null);
      setAudioOn(false);
    }
  }, [focused, tiles, liveNowQuery.data]);

  const toggleGlobal = async () => {
    if (globalOn) {
      const ok = await confirm({
        title: t("v2.team.trainingLive.killTitle"),
        body: t("v2.team.trainingLive.killBody", { n: tiles.length }),
        confirm: t("v2.team.trainingLive.killConfirm"),
        danger: true,
      });
      if (!ok) return;
    }
    killMut.mutate(!globalOn, {
      onSuccess: (d) => toast.success(d.enabled ? t("v2.team.trainingLive.liveTurnedOn") : t("v2.team.trainingLive.liveTurnedOff")),
      onError: (e: unknown) =>
        toast.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || t("v2.team.trainingLive.actionFailed")),
    });
  };

  const status = notConfigured ? null : connected ? (
    <span className="badge b-ok">
      <i className="dot" />
      {t("v2.team.trainingLive.connected")}
    </span>
  ) : errText ? (
    <span className="badge b-bad">
      <i className="dot" />
      {t("v2.team.trainingLive.disconnected")}
    </span>
  ) : (
    <span className="row g8 s c3">
      <span className="sk" style={{ width: 14, height: 14, borderRadius: "50%", display: "inline-block" }} />
      {t("v2.team.trainingLive.connecting")}
    </span>
  );

  const focusedTile = focused ? tiles.find((x) => x.identity === focused) : null;

  return (
    <>
      <PageHeader title={t("v2.team.trainingLive.liveTitle")} meta={<LiveTabs at="now" />}>
        {status}
        {liveNowQuery.data ? (
          <span className="s c3">
            {t("v2.team.trainingLive.onAir")}{" "}
            <span className="num w6" style={{ color: "var(--ink)" }}>
              {tiles.length}
            </span>
          </span>
        ) : null}
      </PageHeader>
      <main className="page">
        {/* Global killswitch */}
        {globalQuery.isLoading ? (
          <i className="sk" style={{ display: "block", height: 72, borderRadius: 14 }} />
        ) : globalOn ? (
          <section className="card row g16 wrap" style={{ padding: "14px 16px", borderColor: "var(--ok-solid)", background: "var(--ok-bg)" }}>
            <span className="icon-tile t-ok">
              <Video className="ic" />
            </span>
            <span className="col grow" style={{ minWidth: 220 }}>
              <span className="h3 c-ok">{t("v2.team.trainingLive.globalOn")}</span>
              <span className="xs c2">{t("v2.team.trainingLive.globalOnHint")}</span>
              {globalQuery.isError ? <span className="xs c-bad">{t("v2.team.trainingLive.globalUnknown")}</span> : null}
            </span>
            <button className="btn btn-danger" type="button" disabled={killMut.isPending} onClick={toggleGlobal}>
              {killMut.isPending ? t("common.loading") : t("v2.team.trainingLive.turnOffAll")}
            </button>
          </section>
        ) : (
          <section className="card row g16 wrap" style={{ padding: "14px 16px", borderColor: "var(--bad-solid)", background: "var(--bad-bg)" }}>
            <span className="icon-tile t-bad">
              <VideoOff className="ic" />
            </span>
            <span className="col grow" style={{ minWidth: 220 }}>
              <span className="h3 c-bad">{t("v2.team.trainingLive.globalOff")}</span>
              <span className="xs c2">{t("v2.team.trainingLive.globalOffHint")}</span>
            </span>
            <button className="btn btn-ok" type="button" disabled={killMut.isPending} onClick={toggleGlobal}>
              {killMut.isPending ? t("common.loading") : t("v2.team.trainingLive.turnOn")}
            </button>
          </section>
        )}

        {notConfigured ? (
          <section className="card">
            <EmptyState
              icon={<VideoOff className="ic ic-l" />}
              title={t("v2.team.trainingLive.notConfiguredTitle")}
              body={t("v2.team.trainingLive.notConfiguredBody")}
            />
          </section>
        ) : null}

        {errText ? (
          <div className="banner b-bad">
            <AlertTriangle className="ic" />
            <span className="col g4 grow">
              <span className="w6">{t("v2.team.trainingLive.connectFailed")}</span>
              <span className="xs">{errText}</span>
            </span>
            <button className="btn btn-sm" type="button" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw className="ic ic-s" />
              {t("v2.state.retry")}
            </button>
          </div>
        ) : null}

        {notConfigured ? null : liveNowQuery.isLoading ? (
          <section className="card">
            <LoadingBlock rows={3} onRetry={() => liveNowQuery.refetch()} />
          </section>
        ) : liveNowQuery.isError && !liveNowQuery.data ? (
          <section className="card">
            <ErrorState error={liveNowQuery.error} onRetry={() => liveNowQuery.refetch()} />
          </section>
        ) : focused ? (
          <section className="card" style={{ overflow: "hidden", padding: 0 }}>
            <div className="row between g8" style={{ padding: "8px 14px", background: TILE_BG, color: "#FFFFFF" }}>
              <span className="s w6 trunc">{focusedTile?.operatorName ?? focused}</span>
              <span className="row g12 xs">
                <label className="row g6" style={{ cursor: "pointer" }}>
                  <input className="check" type="checkbox" checked={audioOn} onChange={(e) => setAudioOn(e.target.checked)} />
                  {t("v2.team.trainingLive.sound")}
                </label>
                <button
                  className="btn btn-sm"
                  type="button"
                  style={{ background: "transparent", borderColor: "rgba(255,255,255,.25)", color: "#FFFFFF" }}
                  onClick={() => {
                    setFocused(null);
                    setAudioOn(false);
                  }}
                >
                  {t("common.close")}
                </button>
              </span>
            </div>
            <video
              ref={(el) => {
                if (el) videoRefs.current.set(focused, el);
              }}
              autoPlay
              playsInline
              muted={!audioOn}
              style={{ display: "block", width: "100%", aspectRatio: "16 / 9", background: PLAYER_BG }}
            />
          </section>
        ) : tiles.length === 0 ? (
          <section className="card">
            <EmptyState
              icon={<VideoOff className="ic ic-l" />}
              title={t("v2.team.trainingLive.nobodyLive")}
              body={
                liveNowQuery.data?.enabled_operators?.length
                  ? t("v2.team.trainingLive.enabledFor", { n: liveNowQuery.data.enabled_operators.length })
                  : t("v2.team.trainingLive.liveHint")
              }
            />
          </section>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
              {tiles.map((tile) => (
                <button
                  key={tile.identity}
                  className="card col"
                  type="button"
                  style={{ overflow: "hidden", padding: 0, textAlign: "left", cursor: "pointer" }}
                  onClick={() => setFocused(tile.identity)}
                  aria-label={t("v2.team.trainingLive.openTile", { name: tile.operatorName })}
                >
                  <span style={{ position: "relative", display: "block", width: "100%", aspectRatio: "16 / 9", background: TILE_BG }}>
                    <video
                      ref={(el) => {
                        if (el) videoRefs.current.set(tile.identity, el);
                      }}
                      autoPlay
                      playsInline
                      muted
                      style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", background: TILE_BG }}
                    />
                    <span
                      className="row g4"
                      style={{
                        position: "absolute",
                        left: 8,
                        top: 8,
                        height: 20,
                        padding: "0 8px",
                        borderRadius: 99,
                        background: "var(--bad-solid)",
                        color: "#FFFFFF",
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: ".04em",
                      }}
                    >
                      <i className="dot" style={{ background: "#FFFFFF" }} />
                      LIVE
                    </span>
                  </span>
                  <span className="s w6 trunc" style={{ padding: "9px 12px" }}>
                    {tile.operatorName}
                  </span>
                </button>
              ))}
            </div>
            <p className="xs c3" style={{ marginTop: -8 }}>
              {t("v2.team.trainingLive.liveHint")}
            </p>
          </>
        )}
      </main>
      {confirm.node}
    </>
  );
}
