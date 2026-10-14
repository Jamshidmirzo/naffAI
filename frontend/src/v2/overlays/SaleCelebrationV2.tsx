import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import confetti from "canvas-confetti";
import { Volume2, VolumeX } from "lucide-react";
import { api } from "../../lib/api";
import { isSaleSoundMuted, useSaleSound } from "../../store/saleSound";
import { NAFFAI_NOTIF_EVENT, type NaffaiNotificationEventDetail } from "../../hooks/useNotificationStream";
import { useT2 } from "../i18n";
import { Layer } from "./shift";

/**
 * v2 peer-sale celebration (artboard OpCelebration). Logic = old
 * components/SaleCelebration.tsx: SSE `naffai:notif` (kind=sale_celebration)
 * for instant display + 30 s polling of unread sale_celebration notifications
 * as fallback; ≤ 2 min freshness; session de-dup; 4 s overlay; mark-read;
 * applause unless muted (useSaleSound). No sale amount is shown.
 * Like the old overlay it does not block the page (pointer-events pass through).
 */

interface CelebrationMeta {
  sale_id?: number;
  seller_id?: number | null;
  seller_name?: string;
  seller_avatar_url?: string | null;
  device?: string;
  amount?: number;
  created_at?: string | null;
}

interface NotificationRow {
  id: number;
  kind: string;
  title: string;
  body: string;
  metadata: CelebrationMeta;
  created_at: string;
  read_at: string | null;
}

interface NotifResponse {
  results: NotificationRow[];
  unread_count?: number;
}

interface QueueItem {
  id: number;
  sellerName: string;
  device: string;
  avatarUrl?: string | null;
}

const FRESH_WINDOW_MS = 2 * 60 * 1000;
const OVERLAY_MS = 4000;
const POLL_MS = 30_000;
const APPLAUSE_SRC = "/sounds/applause-office.mp3";
const APPLAUSE_VOLUME = 0.6;
// Apple system colours (blue, green, orange, yellow, pink, indigo).
const CONFETTI_COLORS = ["#0071E3", "#34C759", "#FF9F0A", "#FFD60A", "#FF375F", "#5E5CE6"];

function isFresh(createdAt: string): boolean {
  const ts = Date.parse(createdAt);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= FRESH_WINDOW_MS;
}

function nameInitials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase() || "?";
}

function playApplause(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (isSaleSoundMuted()) return null;
  try {
    const audio = new Audio(APPLAUSE_SRC);
    audio.volume = APPLAUSE_VOLUME;
    audio.preload = "auto";
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch((err: unknown) => console.debug("[SaleCelebrationV2] applause autoplay blocked:", err));
    }
    return audio;
  } catch (err) {
    console.debug("[SaleCelebrationV2] applause init failed:", err);
    return null;
  }
}

function stopApplause(audio: HTMLAudioElement | null) {
  if (!audio) return;
  try {
    audio.pause();
    audio.currentTime = 0;
    audio.src = "";
  } catch {
    /* ignore */
  }
}

function fireConfetti() {
  const shoot = (originX: number) =>
    confetti({ particleCount: 120, spread: 90, startVelocity: 45, origin: { x: originX, y: 0.6 }, colors: CONFETTI_COLORS, disableForReducedMotion: true, zIndex: 90 });
  shoot(0.5);
  window.setTimeout(() => {
    shoot(0.2);
    shoot(0.8);
  }, 200);
}

export default function SaleCelebrationV2() {
  const t = useT2();
  const qc = useQueryClient();
  const shownIds = useRef<Set<number>>(new Set());
  const [current, setCurrent] = useState<QueueItem | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const muted = useSaleSound((s) => s.muted);
  const toggleSound = useSaleSound((s) => s.toggle);

  const q = useQuery<NotifResponse>({
    queryKey: ["notifications", "sale-celebration"],
    queryFn: () => api.get<NotifResponse>("/notifications/", { params: { kind: "sale_celebration", unread: 1 } }).then((r) => r.data),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const markRead = useMutation({
    mutationFn: (id: number) => api.post("/notifications/mark-read/", { ids: [id] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const showItem = (item: QueueItem) => {
    if (current) {
      if (item.id > 0) markRead.mutate(item.id);
      return;
    }
    setCurrent(item);
    fireConfetti();
    stopApplause(audioRef.current);
    audioRef.current = playApplause();
    window.setTimeout(() => {
      setCurrent(null);
      stopApplause(audioRef.current);
      audioRef.current = null;
      if (item.id > 0) markRead.mutate(item.id);
    }, OVERLAY_MS);
  };

  // SSE push — instant display.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NaffaiNotificationEventDetail>).detail;
      if (!detail || detail.kind !== "sale_celebration") return;
      const meta = (detail.metadata || {}) as CelebrationMeta;
      showItem({
        id: -1, // SSE carries no notification id — polling marks it read
        sellerName: meta.seller_name?.trim() || t("sale_celebration.someone"),
        device: (meta.device as string | undefined)?.trim() || "",
        avatarUrl: (meta.seller_avatar_url as string | null | undefined) ?? null,
      });
    };
    window.addEventListener(NAFFAI_NOTIF_EVENT, handler);
    return () => window.removeEventListener(NAFFAI_NOTIF_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Polling fallback; also marks read what SSE already showed.
  useEffect(() => {
    const rows = q.data?.results ?? [];
    if (!rows.length) return;
    for (const n of [...rows].reverse()) {
      if (n.kind !== "sale_celebration") continue;
      if (shownIds.current.has(n.id)) continue;
      shownIds.current.add(n.id);
      if (!isFresh(n.created_at)) {
        markRead.mutate(n.id);
        continue;
      }
      const meta = n.metadata || {};
      showItem({
        id: n.id,
        sellerName: meta.seller_name?.trim() || t("sale_celebration.someone"),
        device: meta.device?.trim() || "",
        avatarUrl: meta.seller_avatar_url ?? null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  if (!current) return null;

  const dismiss = () => {
    const id = current.id;
    setCurrent(null);
    stopApplause(audioRef.current);
    audioRef.current = null;
    markRead.mutate(id);
  };

  const onSound = () => {
    // Muting while the applause plays stops it right away.
    if (!muted) {
      stopApplause(audioRef.current);
      audioRef.current = null;
    }
    toggleSound();
  };

  return (
    <Layer z={80} style={{ pointerEvents: "none" }}>
      <div className="scrim" style={{ opacity: 0.55, pointerEvents: "none" }} aria-hidden />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <section
          className="card col g12"
          role="status"
          aria-live="polite"
          style={{ width: 460, maxWidth: "100%", padding: "32px 28px 24px", alignItems: "center", textAlign: "center", boxShadow: "var(--shadow)", border: 0, overflow: "hidden", pointerEvents: "auto", animation: "v2-sale-pop 300ms ease-out" }}
        >
          {current.avatarUrl ? (
            <img src={current.avatarUrl} alt="" className="ava ava-xl" style={{ objectFit: "cover" }} />
          ) : (
            <span className="ava ava-xl" style={{ background: "var(--ok-bg)", color: "var(--ok)" }}>{nameInitials(current.sellerName)}</span>
          )}
          <span className="lbl" style={{ color: "var(--ok)" }}>{t("v2.ov.sale.label")}</span>
          <h2 className="h1" style={{ margin: 0 }}>
            {current.device ? t("v2.ov.sale.title", { name: current.sellerName }) : t("v2.ov.sale.titleNoDevice", { name: current.sellerName })}
          </h2>
          {current.device ? <p className="c2" style={{ fontSize: 16, margin: 0 }}>{current.device}</p> : null}
          <div className="row g8" style={{ marginTop: 8, width: "100%" }}>
            <button className="btn" type="button" onClick={onSound} aria-pressed={!muted} aria-label={muted ? t("v2.ov.sale.soundOn") : t("v2.ov.sale.soundOff")} title={muted ? t("v2.ov.sale.soundOn") : t("v2.ov.sale.soundOff")}>
              {muted ? <VolumeX className="ic" /> : <Volume2 className="ic" />}
              {t("v2.ov.sale.sound")}
            </button>
            <button className="btn btn-pri grow" type="button" onClick={dismiss}>{t("v2.ov.sale.ok")}</button>
          </div>
          <p className="xs c3" style={{ margin: 0 }}>{t("v2.ov.sale.note")}</p>
          <style>{`@keyframes v2-sale-pop{from{transform:scale(.9);opacity:0}to{transform:scale(1);opacity:1}}@media (prefers-reduced-motion: reduce){[style*="v2-sale-pop"]{animation:none!important}}`}</style>
        </section>
      </div>
    </Layer>
  );
}
