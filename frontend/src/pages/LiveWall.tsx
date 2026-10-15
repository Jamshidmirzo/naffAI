/**
 * LiveWall — manager-only grid of operators currently on air.
 *
 * Data sources:
 *   • `/live/live-now/` (polled 5 s) — who is live (scoped to operators
 *     this manager can see), names, start time, shift/pause flags, and
 *     the list of operators with the flag on (for «Не в эфире»);
 *   • the LiveKit room (`useLiveWallRoom`) — actual video tracks. We only
 *     subscribe to camera tracks of tiles that pass the search filter
 *     (+ the focused one), never to anyone outside live-now.
 *
 * Video only — operators publish no audio.
 * Focus view is URL-driven (`?focus=op:<id>`), so the operator card can
 * deep-link here. Esc closes, ←/→ walk the filtered tiles, F = fullscreen.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  useLiveConfig,
  useLiveGlobalStatus,
  useLiveGlobalToggle,
  useLiveNow,
} from "../lib/liveQueries";
import { useLiveWallRoom, type WallConnection, type WallParticipant } from "../lib/liveWallRoom";
import {
  formatOnAir,
  type EnabledOperatorRow,
  type LiveNowRow,
  type NotLiveReason,
} from "../lib/liveRoom";
import LiveVideo from "../components/live/LiveVideo";
import { Modal } from "../components/Modal";
import { Button, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useLangValue, useT } from "../lib/i18n";

const EMPTY_ROWS: LiveNowRow[] = [];
const EMPTY_OPS: EnabledOperatorRow[] = [];
const FOCUS_GRACE_MS = 5_000;

type Tile = {
  identity: string;
  row: LiveNowRow;
  participant: WallParticipant | undefined;
  hasVideo: boolean;
};

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

// --- fullscreen with the webkit (Safari) fallback --------------------------

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };

const fsElement = () => {
  const d = document as FsDoc;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
};
function exitFullscreen() {
  const d = document as FsDoc;
  if (d.exitFullscreen) d.exitFullscreen().catch(() => {});
  else d.webkitExitFullscreen?.();
}
function enterFullscreen(el: HTMLElement) {
  const e = el as FsEl;
  if (e.requestFullscreen) e.requestFullscreen().catch(() => {});
  else e.webkitRequestFullscreen?.();
}

const notLiveReason = (o: EnabledOperatorRow): NotLiveReason =>
  o.reason ?? (o.is_paused ? "paused" : o.on_shift === false ? "no_shift" : "offline");
// Flag-off operators go last: they are off on purpose, not a problem.
const NOT_LIVE_ORDER = ["paused", "no_shift", "offline", "disabled"] as const;

const isPoor = (q: string | undefined) => q === "poor" || q === "lost";

export default function LiveWall() {
  const t = useT();
  const lang = useLangValue();
  usePageHeader({ title: t("live.wall.title"), subtitle: t("live.wall.subtitle") }, [lang]);

  const [sp, setSp] = useSearchParams();
  const focusId = sp.get("focus");
  const setFocus = useCallback(
    (identity: string | null) =>
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (identity) next.set("focus", identity);
          else next.delete("focus");
          return next;
        },
        { replace: true },
      ),
    [setSp],
  );

  const config = useLiveConfig();
  const liveNow = useLiveNow();
  const globalQ = useLiveGlobalStatus();
  const toggle = useLiveGlobalToggle();
  const now = useNow(1000);

  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim().toLowerCase(), 250);
  const [onlyVideo, setOnlyVideo] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const rows = liveNow.data?.live_now ?? EMPTY_ROWS;
  const enabledOps = liveNow.data?.enabled_operators ?? EMPTY_OPS;
  // Operators whose live flag is on (the rest are listed as «эфир выключен»).
  const flagOnCount = useMemo(() => enabledOps.filter((o) => o.livestream_enabled !== false).length, [enabledOps]);

  const searchMatched = useMemo(
    () =>
      rows
        .filter((r) => !q || (r.operator_name || "").toLowerCase().includes(q))
        .slice()
        .sort((a, b) => (a.operator_name || "").localeCompare(b.operator_name || "")),
    [rows, q],
  );

  // Stable Set identity: only changes when the membership changes.
  const idKey = searchMatched.map((r) => r.participant_identity).sort().join("|");
  const identities = useMemo(() => new Set(idKey ? idKey.split("|") : []), [idKey]);

  const notConfigured = config.data?.configured === false;
  const wall = useLiveWallRoom({
    identities,
    focusedIdentity: focusId,
    enabled: !config.isLoading && !notConfigured,
  });
  const connected = wall.connection === "connected";

  const allTiles: Tile[] = useMemo(
    () =>
      searchMatched.map((row) => {
        const participant = wall.participants.get(row.participant_identity);
        const hasVideo = participant ? participant.hasVideo : !connected && !!row.has_video;
        return { identity: row.participant_identity, row, participant, hasVideo };
      }),
    [searchMatched, wall.participants, connected],
  );
  const tiles = useMemo(
    () => (onlyVideo ? allTiles.filter((x) => x.hasVideo) : allTiles),
    [allTiles, onlyVideo],
  );

  // «Не в эфире» — every working operator who is not live, grouped by reason
  // (incl. «эфир выключен» — the flag is off on the operator card).
  const notLiveGroups = useMemo(() => {
    const liveIds = new Set(rows.map((r) => r.operator_id));
    const groups: Record<NotLiveReason, EnabledOperatorRow[]> = { paused: [], no_shift: [], offline: [], disabled: [] };
    for (const o of enabledOps) {
      if (o.is_live ?? liveIds.has(o.id)) continue;
      if (q && !(o.full_name || "").toLowerCase().includes(q)) continue;
      groups[notLiveReason(o)].push(o);
    }
    return groups;
  }, [rows, enabledOps, q]);
  const notLiveCount = NOT_LIVE_ORDER.reduce((n, r) => n + notLiveGroups[r].length, 0);

  // --- focus view ----------------------------------------------------------

  const focusRow = focusId ? rows.find((r) => r.participant_identity === focusId) : undefined;
  const lastFocusRowRef = useRef<LiveNowRow | undefined>(undefined);
  if (focusRow) lastFocusRowRef.current = focusRow;
  if (!focusId) lastFocusRowRef.current = undefined;
  const shownFocusRow = focusRow ?? lastFocusRowRef.current;
  const focusPresent = !!focusRow;
  const focusEnded = !!focusId && !!liveNow.data && !focusPresent;

  useEffect(() => {
    if (!focusEnded) return;
    const id = window.setTimeout(() => setFocus(null), FOCUS_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [focusEnded, setFocus]);

  const focusRef = useRef<HTMLDivElement>(null);
  const [isFs, setIsFs] = useState(false);
  useEffect(() => {
    const h = () => setIsFs(!!fsElement());
    document.addEventListener("fullscreenchange", h);
    document.addEventListener("webkitfullscreenchange", h);
    return () => {
      document.removeEventListener("fullscreenchange", h);
      document.removeEventListener("webkitfullscreenchange", h);
    };
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (fsElement()) exitFullscreen();
    else if (focusRef.current) enterFullscreen(focusRef.current);
  }, []);
  const closeFocus = useCallback(() => {
    if (fsElement()) exitFullscreen();
    setFocus(null);
  }, [setFocus]);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (tiles.length === 0) return;
      const i = tiles.findIndex((x) => x.identity === focusId);
      const next = i < 0 ? 0 : (i + dir + tiles.length) % tiles.length;
      setFocus(tiles[next].identity);
    },
    [tiles, focusId, setFocus],
  );

  useEffect(() => {
    if (!focusId) return;
    const onKey = (e: KeyboardEvent) => {
      if (confirmOpen || e.defaultPrevented) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") {
        if (!fsElement()) closeFocus();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusId, confirmOpen, closeFocus, step, toggleFullscreen]);

  // --- killswitch ------------------------------------------------------------

  const globalOn = globalQ.data?.enabled !== false;
  const confirmToggle = () => {
    toggle.mutate(!globalOn, {
      onSuccess: () => setConfirmOpen(false),
      onError: () => toast.error(t("live.wall.ks_failed")),
    });
  };

  // --- render ------------------------------------------------------------------

  const unavailable = notConfigured || wall.connection === "unavailable";

  return (
    <div className="space-y-4">
      {/* Header strip: connection + counts + filters */}
      <section className="nf-card flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <ConnectionBadge connection={wall.connection} />
          {!unavailable && wall.connection !== "connecting" && wall.connection !== "idle" && (
            <button
              type="button"
              onClick={wall.reconnect}
              className="inline-flex items-center gap-1 text-xs text-muted hover:text-text"
            >
              <RefreshCw className="w-3.5 h-3.5" /> {t("live.wall.reconnect")}
            </button>
          )}
          <span className="text-sm text-text" data-testid="live-count">
            {flagOnCount > 0
              ? t("live.wall.count", { n: rows.length, m: flagOnCount })
              : t("live.wall.count_short", { n: rows.length })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("live.wall.search")}
              aria-label={t("live.wall.search")}
              className="nf-input"
              style={{ paddingLeft: 30, minWidth: 220 }}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-text cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyVideo}
              onChange={(e) => setOnlyVideo(e.target.checked)}
              className="h-4 w-4"
            />
            {t("live.wall.only_video")}
          </label>
        </div>
      </section>

      {/* Killswitch */}
      <section
        className="nf-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
        data-testid="live-killswitch"
        data-enabled={globalOn ? "true" : "false"}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-semibold text-text">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${globalOn ? "bg-emerald-500" : "bg-rose-500"}`} />
            {globalOn ? t("live.wall.ks_on_title") : t("live.wall.ks_off_title")}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {globalOn ? t("live.wall.ks_on_hint") : t("live.wall.ks_off_hint")}
          </div>
        </div>
        <Button
          variant={globalOn ? "danger" : "primary"}
          size="sm"
          disabled={toggle.isPending || globalQ.isLoading}
          onClick={() => setConfirmOpen(true)}
          data-testid="live-killswitch-toggle"
        >
          {globalOn ? t("live.wall.ks_turn_off") : t("live.wall.ks_turn_on")}
        </Button>
      </section>

      {!wall.canPlaybackVideo && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>{t("live.wall.playback_blocked")}</span>
          <Button size="sm" onClick={() => void wall.startVideo()}>
            {t("live.wall.playback_start")}
          </Button>
        </div>
      )}

      {unavailable ? (
        <StateCard title={t("live.wall.unavailable_title")} text={t("live.wall.unavailable_text")} />
      ) : liveNow.isLoading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-busy="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-slate-200 overflow-hidden animate-pulse">
              <div className="aspect-video bg-slate-200/70" />
              <div className="h-9 bg-slate-100/70" />
            </div>
          ))}
        </div>
      ) : liveNow.isError && !liveNow.data ? (
        <StateCard
          title={t("live.wall.error_title")}
          text={t("live.wall.error_text")}
          action={
            <Button size="sm" variant="secondary" onClick={() => void liveNow.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <StateCard
          title={t("live.wall.empty_title")}
          text={
            flagOnCount > 0
              ? t("live.wall.empty_enabled", { n: flagOnCount })
              : t("live.wall.empty_none")
          }
        />
      ) : tiles.length === 0 ? (
        <StateCard title={t("live.wall.no_match")} text="" />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {tiles.map((tile) => (
            <LiveTile
              key={tile.identity}
              tile={tile}
              now={now}
              connected={connected}
              onOpen={() => setFocus(tile.identity)}
            />
          ))}
        </div>
      )}

      {!unavailable && notLiveCount > 0 && (
        <details className="nf-card p-4" data-testid="live-not-live">
          <summary className="cursor-pointer text-sm font-semibold text-text">
            {t("live.wall.not_live", { n: notLiveCount })}
          </summary>
          <div className="mt-3 grid gap-4 md:grid-cols-3">
            {NOT_LIVE_ORDER.map((reason) =>
              notLiveGroups[reason].length === 0 ? null : (
                <div key={reason}>
                  <div className="nf-col mb-1.5">
                    {t(`live.wall.reason_${reason}`)} · {notLiveGroups[reason].length}
                  </div>
                  <ul className="space-y-1 text-sm">
                    {notLiveGroups[reason].map((o) => (
                      <li key={o.id}>
                        <Link to={`/operators/${o.id}`} className="text-text hover:underline">
                          {o.full_name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </div>
        </details>
      )}

      {focusId && (
        <div
          ref={focusRef}
          className="fixed inset-0 z-[55] flex flex-col bg-black/95"
          role="dialog"
          aria-modal="true"
          aria-label={shownFocusRow?.operator_name ?? focusId}
          data-testid="live-focus"
        >
          <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-white">
            <span className="text-sm font-semibold truncate">{shownFocusRow?.operator_name ?? focusId}</span>
            {focusRow && (
              <span className="text-xs tabular-nums text-white/70">
                {formatOnAir(focusRow.started_at, now)}
              </span>
            )}
            {focusRow?.on_shift && <Badge tone="ok">{t("live.wall.badge_on_shift")}</Badge>}
            {focusRow?.is_paused && <Badge tone="warn">{t("live.wall.badge_paused")}</Badge>}
            <div className="ml-auto flex items-center gap-1">
              <FocusBtn onClick={() => step(-1)} label={t("live.wall.prev")}>
                <ChevronLeft className="w-4 h-4" />
              </FocusBtn>
              <FocusBtn onClick={() => step(1)} label={t("live.wall.next")}>
                <ChevronRight className="w-4 h-4" />
              </FocusBtn>
              <FocusBtn onClick={toggleFullscreen} label={isFs ? t("live.wall.exit_fullscreen") : t("live.wall.fullscreen")}>
                {isFs ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </FocusBtn>
              {shownFocusRow && (
                <Link
                  to={`/operators/${shownFocusRow.operator_id}`}
                  onClick={() => fsElement() && exitFullscreen()}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-white/10"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> {t("live.wall.open_card")}
                </Link>
              )}
              <FocusBtn onClick={closeFocus} label={t("common.close")}>
                <X className="w-4 h-4" />
              </FocusBtn>
            </div>
          </div>
          <div className="relative flex-1 min-h-0">
            {(() => {
              const p = wall.participants.get(focusId);
              if (focusEnded) {
                return (
                  <div className="absolute inset-0 grid place-items-center text-sm text-white/70">
                    {t("live.wall.focus_ended")}
                  </div>
                );
              }
              if (p?.videoTrack) {
                return (
                  <LiveVideo track={p.videoTrack} objectFit="contain" className="absolute inset-0 h-full w-full" />
                );
              }
              return (
                <div className="absolute inset-0 grid place-items-center text-sm text-white/60">
                  {p && !p.hasVideo && connected ? t("live.wall.no_video") : t("live.wall.tile_connecting")}
                </div>
              );
            })()}
          </div>
          <div className="px-4 py-1.5 text-[11px] text-white/40">{t("live.wall.focus_keys")}</div>
        </div>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={globalOn ? t("live.wall.ks_confirm_off_title") : t("live.wall.ks_confirm_on_title")}
      >
        <p className="text-sm text-text">
          {globalOn
            ? t("live.wall.ks_confirm_off", { n: rows.length })
            : t("live.wall.ks_confirm_on", { n: flagOnCount })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={globalOn ? "danger" : "primary"}
            size="sm"
            disabled={toggle.isPending}
            onClick={confirmToggle}
            data-testid="live-killswitch-confirm"
          >
            {toggle.isPending ? "…" : globalOn ? t("live.wall.ks_turn_off") : t("live.wall.ks_turn_on")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ConnectionBadge({ connection }: { connection: WallConnection }) {
  const t = useT();
  const map: Record<WallConnection, string> = {
    idle: "bg-slate-100 text-slate-600 border-slate-200",
    connecting: "bg-amber-50 text-amber-700 border-amber-200",
    reconnecting: "bg-amber-50 text-amber-700 border-amber-200",
    connected: "bg-emerald-50 text-emerald-700 border-emerald-200",
    disconnected: "bg-rose-50 text-rose-700 border-rose-200",
    error: "bg-rose-50 text-rose-700 border-rose-200",
    unavailable: "bg-slate-100 text-slate-600 border-slate-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${map[connection]}`}
      data-testid="live-connection"
      data-state={connection}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          connection === "connected"
            ? "bg-emerald-500"
            : connection === "connecting" || connection === "reconnecting"
            ? "animate-pulse bg-amber-500"
            : connection === "idle" || connection === "unavailable"
            ? "bg-slate-400"
            : "bg-rose-500"
        }`}
      />
      {t(`live.wall.conn_${connection}`)}
    </span>
  );
}

function Badge({ tone, children }: { tone: "ok" | "warn"; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
        tone === "ok" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
      }`}
    >
      {children}
    </span>
  );
}

function FocusBtn({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-grid place-items-center rounded p-1.5 text-white/80 hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}

function StateCard({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 p-10 text-center">
      <div className="text-sm font-semibold text-text">{title}</div>
      {text && <div className="mt-1 text-sm text-muted">{text}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

function LiveTile({
  tile,
  now,
  connected,
  onOpen,
}: {
  tile: Tile;
  now: number;
  connected: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const { row, participant: p } = tile;
  const onAir = formatOnAir(row.started_at, now);
  const receiving = !!p?.videoTrack;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      data-testid={`live-tile-${tile.identity}`}
      data-video={receiving ? "true" : "false"}
      className="group cursor-pointer rounded-xl border border-slate-200 bg-slate-900 overflow-hidden hover:ring-2 hover:ring-rose-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
    >
      <div className="relative aspect-video bg-black">
        {receiving ? (
          <LiveVideo track={p!.videoTrack} className="absolute inset-0 h-full w-full" />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-xs text-white/60">
            {p && !p.hasVideo && connected ? t("live.wall.no_video") : t("live.wall.tile_connecting")}
          </div>
        )}
        {receiving && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-rose-500/90 px-2 py-0.5 text-[10px] font-medium text-white">
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
            LIVE
          </span>
        )}
        {p && isPoor(p.quality) && (
          <span
            className="absolute right-2 top-2 inline-block h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-black/40"
            title={t("live.wall.poor_quality")}
            aria-label={t("live.wall.poor_quality")}
          />
        )}
        {onAir && (
          <span className="absolute right-2 bottom-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
            {onAir}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 px-3 py-2 text-sm" style={{ background: "var(--bg-card)" }}>
        <span className="min-w-0 flex-1 truncate font-medium text-text">{row.operator_name}</span>
        {row.on_shift && <Badge tone="ok">{t("live.wall.badge_on_shift")}</Badge>}
        {row.is_paused && <Badge tone="warn">{t("live.wall.badge_paused")}</Badge>}
        <Link
          to={`/operators/${row.operator_id}`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="shrink-0 text-muted hover:text-text"
          title={t("live.wall.open_card")}
          aria-label={t("live.wall.open_card")}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  );
}
