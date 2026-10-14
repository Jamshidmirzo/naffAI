import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import confetti from "canvas-confetti";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { isSaleSoundMuted } from "../store/saleSound";
import {
  NAFFAI_NOTIF_EVENT,
  type NaffaiNotificationEventDetail,
} from "../hooks/useNotificationStream";

/**
 * Peer-operator celebration overlay.
 *
 * Когда любой оператор (или менеджер за него) записывает продажу, backend
 * рассылает `Notification(kind=sale_celebration)` каждому другому активному
 * оператору. Этот компонент раз в 30 сек опрашивает
 * `/notifications/?kind=sale_celebration&unread=1`, показывает конфетти +
 * центральный overlay («Gozal iPhone 15 Pro sotdi! 🎉») на 4 сек и
 * помечает уведомление прочитанным, чтобы оно не повторилось на других
 * вкладках/устройствах того же оператора.
 *
 * Дедуп:
 *   - `shownIds: useRef<Set<number>>` — сессионный, не спамить при
 *     повторном polling'е до того, как mark-read успел проехать.
 *   - Свежесть ≤ 2 мин по `created_at` — иначе после долгого сна вкладки
 *     не устраивать «лавину» старых овагий.
 *
 * Формат overlay: имя оператора + модель девайса, БЕЗ суммы (утверждено).
 * Сумма кладётся в payload на будущее, но UI её не рендерит.
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

/** Детерминированный градиент из имени — fallback для карточек без аватара. */
function nameGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const h1 = hash % 360;
  const h2 = (h1 + 50) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 45%))`;
}

function nameInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?"
  );
}

const FRESH_WINDOW_MS = 2 * 60 * 1000; // 2 min — старше выкидываем без показа
const OVERLAY_MS = 4000;
const POLL_MS = 30_000;

function isFresh(createdAt: string): boolean {
  const ts = Date.parse(createdAt);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= FRESH_WINDOW_MS;
}

/**
 * Единственный финальный вариант аплодисментов — «office» (небольшая
 * группа коллег, умеренная громкость). Выбран пользователем после
 * A/B-прослушивания stadium/office/short на demo. Файл royalty-free
 * Mixkit, нормализован к ≈-14 LUFS, лежит в `public/sounds/`.
 */
const APPLAUSE_SRC = "/sounds/applause-office.mp3";
const APPLAUSE_VOLUME = 0.6;

/**
 * Проигрывает аплодисменты через Audio-элемент. Browsers блокируют
 * autoplay без user-gesture — на polling-ветке .play() может реджектнуть
 * с NotAllowedError; тихо проглатываем, без ошибки в консоли.
 * Возвращаем Audio, чтобы caller мог остановить трек при досрочном
 * закрытии overlay. Если пользователь нажал mute в Header — возвращаем
 * null и не создаём Audio.
 */
function playApplause(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (isSaleSoundMuted()) return null;
  try {
    const audio = new Audio(APPLAUSE_SRC);
    audio.volume = APPLAUSE_VOLUME;
    audio.preload = "auto";
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch((err: unknown) => {
        // autoplay-блокировка (NotAllowedError) — ожидаемо на polling-ветке
        // без user-gesture. Любая другая причина тоже не повод шуметь.
        if (typeof console !== "undefined") {
          console.debug("[SaleCelebration] applause autoplay blocked:", err);
        }
      });
    }
    return audio;
  } catch (err) {
    if (typeof console !== "undefined") {
      console.debug("[SaleCelebration] applause init failed:", err);
    }
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
  const shoot = (originX: number) => {
    confetti({
      particleCount: 120,
      spread: 90,
      startVelocity: 45,
      origin: { x: originX, y: 0.6 },
      colors: ["#f472b6", "#fb923c", "#fbbf24", "#a78bfa", "#60a5fa", "#34d399"],
      disableForReducedMotion: true,
    });
  };
  shoot(0.5);
  window.setTimeout(() => {
    shoot(0.2);
    shoot(0.8);
  }, 200);
}

export function SaleCelebration() {
  const t = useT();
  const qc = useQueryClient();
  const shownIds = useRef<Set<number>>(new Set());
  const [current, setCurrent] = useState<QueueItem | null>(null);
  // Текущий играющий Audio — чтобы вручную остановить при dismiss (×)
  // или при истечении OVERLAY_MS, если файл длиннее.
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const q = useQuery<NotifResponse>({
    queryKey: ["notifications", "sale-celebration"],
    queryFn: () =>
      api
        .get<NotifResponse>("/notifications/", {
          params: { kind: "sale_celebration", unread: 1 },
        })
        .then((r) => r.data),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    // Тихо игнорируем 401/403 — если polling запустился до логаута, не
    // ломаем UX ошибкой.
    retry: false,
  });

  const markRead = useMutation({
    mutationFn: (id: number) =>
      api.post("/notifications/mark-read/", { ids: [id] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  // Shared trigger: показать overlay + mark-read'ить соответствующую
  // notification (если id > 0 — он есть только для polling-ветки).
  const showItem = (item: QueueItem) => {
    if (current) {
      // Уже показываем другую овагию — mark-read и выходим без дубля.
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

  // SSE push-ветка — моментальный показ без ожидания polling.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NaffaiNotificationEventDetail>).detail;
      if (!detail || detail.kind !== "sale_celebration") return;
      const meta = (detail.metadata || {}) as CelebrationMeta;
      // created_at — опционально; у SSE события оно всегда есть, но
      // проверка на свежесть пропускаем (SSE по определению real-time).
      const item: QueueItem = {
        id: -1, // SSE: нет notification.id в payload — mark-read сделает polling-ветка
        sellerName: meta.seller_name?.trim() || t("sale_celebration.someone"),
        device: (meta.device as string | undefined)?.trim() || "",
        avatarUrl: (meta.seller_avatar_url as string | null | undefined) ?? null,
      };
      showItem(item);
    };
    window.addEventListener(NAFFAI_NOTIF_EVENT, handler);
    return () => window.removeEventListener(NAFFAI_NOTIF_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Legacy polling-ветка — fallback если SSE не работает. Также mark-read'ит
  // всё что пришло через SSE (у SSE-пути id<0, не трогается).
  useEffect(() => {
    const rows = q.data?.results ?? [];
    if (!rows.length) return;
    const chrono = [...rows].reverse();
    for (const n of chrono) {
      if (n.kind !== "sale_celebration") continue;
      if (shownIds.current.has(n.id)) continue;
      shownIds.current.add(n.id);
      if (!isFresh(n.created_at)) {
        markRead.mutate(n.id);
        continue;
      }
      const meta = n.metadata || {};
      const item: QueueItem = {
        id: n.id,
        sellerName: meta.seller_name?.trim() || t("sale_celebration.someone"),
        device: meta.device?.trim() || "",
        avatarUrl: meta.seller_avatar_url ?? null,
      };
      showItem(item);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  if (!current) return null;

  const body = current.device
    ? t("sale_celebration.body", {
        name: current.sellerName,
        device: current.device,
      })
    : t("sale_celebration.body_no_device", { name: current.sellerName });

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        zIndex: "var(--z-toast, 80)" as unknown as number,
      }}
    >
      <div
        style={{
          pointerEvents: "auto",
          maxWidth: 520,
          width: "min(92vw, 520px)",
          padding: "28px 32px",
          borderRadius: 20,
          background:
            "linear-gradient(135deg, rgba(251,113,133,0.96), rgba(251,146,60,0.96), rgba(250,204,21,0.96))",
          color: "#fff",
          textAlign: "center",
          boxShadow: "0 24px 60px rgba(0,0,0,0.35)",
          animation: "sale-celebration-pop 300ms ease-out",
          position: "relative",
        }}
      >
        <button
          type="button"
          onClick={() => {
            const id = current.id;
            setCurrent(null);
            stopApplause(audioRef.current);
            audioRef.current = null;
            markRead.mutate(id);
          }}
          aria-label={t("sale_celebration.dismiss")}
          style={{
            position: "absolute",
            top: 8,
            right: 12,
            background: "transparent",
            border: "none",
            color: "rgba(255,255,255,0.9)",
            fontSize: 22,
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          ×
        </button>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginBottom: 10,
          }}
        >
          {current.avatarUrl ? (
            <img
              src={current.avatarUrl}
              alt=""
              style={{
                width: 72,
                height: 72,
                borderRadius: "50%",
                objectFit: "cover",
                border: "3px solid rgba(255,255,255,.9)",
                boxShadow: "0 6px 20px rgba(0,0,0,.3)",
              }}
            />
          ) : (
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: "50%",
                background: nameGradient(current.sellerName),
                border: "3px solid rgba(255,255,255,.9)",
                boxShadow: "0 6px 20px rgba(0,0,0,.3)",
                color: "#fff",
                fontSize: 24,
                fontWeight: 700,
                display: "grid",
                placeItems: "center",
                letterSpacing: 0.5,
              }}
            >
              {nameInitials(current.sellerName)}
            </div>
          )}
        </div>
        <div style={{ fontSize: 32, lineHeight: 1, marginBottom: 8 }}>🎉</div>
        <div style={{ fontSize: 15, opacity: 0.9, letterSpacing: 0.4 }}>
          {t("sale_celebration.title")}
        </div>
        <div
          style={{
            marginTop: 8,
            fontSize: 24,
            fontWeight: 700,
            lineHeight: 1.25,
          }}
        >
          {body}
        </div>
      </div>
      <style>{`
        @keyframes sale-celebration-pop {
          from { transform: scale(0.85); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

export default SaleCelebration;
