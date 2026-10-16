/**
 * LiveStreamPublisher — mounted in AppShell for `operator`-role users.
 * `enabled` comes from `/auth/me/ → livestream_enabled` (default ON on
 * the backend; the manager can switch it off on the operator card).
 *
 * The component is two things:
 *   • a headless controller (`useLivePublisher`) that drives the
 *     framework-free engine in `lib/livePublisher.ts` — connect, camera,
 *     reconnect/backoff, single-tab lock, killswitch poll, token refresh;
 *   • a status pill (`LivePublisherPill`) that reads the global
 *     publisher state. AppShell renders it inline in the Header (it used
 *     to float bottom-left, right over the sidebar's «Выйти»).
 *
 * `ui={false}` keeps the controller and drops the pill (for layouts that
 * render `LivePublisherPill` / `useLivePublisherStatus` themselves).
 */

import { useEffect, useState } from "react";
import { useLivePublisher, useLivePublisherStatus } from "../lib/livePublisher";
import { useT } from "../lib/i18n";

interface Props {
  /** Operator has livestream enabled (from /auth/me/). */
  enabled: boolean;
  /** Render the floating status pill. */
  ui?: boolean;
}

export default function LiveStreamPublisher({ enabled, ui = true }: Props) {
  useLivePublisher({ enabled });
  if (!enabled || !ui) return null;
  return <LivePublisherPill />;
}

/** Seconds left until `retryAt`, ticking once a second while relevant. */
function useCountdown(retryAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt == null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [retryAt]);
  return retryAt == null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
}

const Dot = ({ cls }: { cls: string }) => <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />;

const pillBtn = "ml-1 rounded-full px-2 py-0.5 font-semibold underline-offset-2 hover:underline";

export function LivePublisherPill({ inline = false }: { inline?: boolean } = {}) {
  const t = useT();
  const s = useLivePublisherStatus();
  const secs = useCountdown(s.status === "retrying" || s.status === "error" ? s.retryAt : null);

  if (s.status === "off" || s.status === "unavailable" || s.status === "disabled_operator") {
    return null;
  }

  const base = inline
    ? "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium"
    : "fixed bottom-4 left-4 z-[80] flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur";
  const palette =
    s.status === "live"
      ? "bg-rose-50/90 border-rose-200 text-rose-700"
      : s.status === "connecting" || s.status === "reconnecting" || s.status === "retrying"
      ? "bg-amber-50/90 border-amber-200 text-amber-700"
      : s.status === "error" || s.status === "denied" || s.status === "no_camera"
      ? "bg-rose-50/90 border-rose-200 text-rose-800"
      : "bg-slate-50/90 border-slate-200 text-slate-700";

  let body: JSX.Element;
  switch (s.status) {
    case "live":
      body = (
        <>
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
          </span>
          <span>{t("live.pub.live")}</span>
          <button
            type="button"
            onClick={s.pause}
            className="ml-1 text-rose-900/70 hover:text-rose-900"
            title={t("live.pub.pause_title")}
            aria-label={t("live.pub.pause_title")}
          >
            ✕
          </button>
        </>
      );
      break;
    case "connecting":
      body = (
        <>
          <Dot cls="animate-pulse bg-amber-500" />
          <span>{t("live.pub.connecting")}</span>
        </>
      );
      break;
    case "reconnecting":
      body = (
        <>
          <Dot cls="animate-pulse bg-amber-500" />
          <span>{t("live.pub.reconnecting")}</span>
        </>
      );
      break;
    case "retrying":
      body = (
        <>
          <Dot cls="bg-amber-500" />
          <span title={s.errText}>{t("live.pub.retrying", { n: secs })}</span>
          <button type="button" onClick={s.retryNow} className={pillBtn}>
            {t("live.pub.retry")}
          </button>
        </>
      );
      break;
    case "paused_by_user":
      body = (
        <>
          <Dot cls="bg-slate-400" />
          <span>{t("live.pub.paused")}</span>
          <button type="button" onClick={s.resume} className={pillBtn}>
            {t("live.pub.resume")}
          </button>
        </>
      );
      break;
    case "other_tab":
      body = (
        <>
          <Dot cls="bg-slate-400" />
          <span>{t("live.pub.other_tab")}</span>
          {s.kickReason === "DUPLICATE_IDENTITY" && (
            // Kicked by another device of the same operator — let them take it back.
            <button type="button" onClick={s.retryNow} className={pillBtn}>
              {t("live.pub.take_over")}
            </button>
          )}
        </>
      );
      break;
    case "denied":
      body = (
        <>
          <Dot cls="bg-rose-500" />
          <span title={s.errText}>{t("live.pub.denied")}</span>
          <span className="hidden sm:inline font-normal opacity-80">· {t("live.pub.denied_hint")}</span>
          <button type="button" onClick={s.retryNow} className={pillBtn}>
            {t("live.pub.retry")}
          </button>
        </>
      );
      break;
    case "no_camera":
      body = (
        <>
          <Dot cls="bg-rose-500" />
          <span title={s.errText}>{t("live.pub.no_camera")}</span>
          <button type="button" onClick={s.retryNow} className={pillBtn}>
            {t("live.pub.retry")}
          </button>
        </>
      );
      break;
    case "disabled_global":
      body = (
        <>
          <Dot cls="bg-slate-400" />
          <span>{t("live.pub.disabled_global")}</span>
        </>
      );
      break;
    case "error":
    default:
      body = (
        <>
          <Dot cls="bg-rose-500" />
          <span title={s.errText}>
            {secs > 0 ? t("live.pub.error_retry", { n: secs }) : t("live.pub.error")}
          </span>
          <button type="button" onClick={s.retryNow} className={pillBtn}>
            {t("live.pub.retry")}
          </button>
        </>
      );
  }

  return (
    <div
      className={`${base} ${palette}`}
      role="status"
      aria-live="polite"
      data-testid="live-pill"
      data-status={s.status}
    >
      {body}
    </div>
  );
}
