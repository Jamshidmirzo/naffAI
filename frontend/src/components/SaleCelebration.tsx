import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import confetti from "canvas-confetti";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";

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
}

const FRESH_WINDOW_MS = 2 * 60 * 1000; // 2 min — старше выкидываем без показа
const OVERLAY_MS = 4000;
const POLL_MS = 30_000;

function isFresh(createdAt: string): boolean {
  const ts = Date.parse(createdAt);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= FRESH_WINDOW_MS;
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

  // Enqueue fresh unseen celebrations; show them one at a time.
  useEffect(() => {
    const rows = q.data?.results ?? [];
    if (!rows.length) return;
    // Backend отдаёт `-created_at`; для показа берём в хронологическом
    // порядке, чтобы «первый пришёл — первым показался».
    const chrono = [...rows].reverse();
    for (const n of chrono) {
      if (n.kind !== "sale_celebration") continue;
      if (shownIds.current.has(n.id)) continue;
      shownIds.current.add(n.id);
      if (!isFresh(n.created_at)) {
        // Протухшие тихо dismiss'им — mark-read чтобы не всплывали снова.
        markRead.mutate(n.id);
        continue;
      }
      const meta = n.metadata || {};
      const item: QueueItem = {
        id: n.id,
        sellerName: meta.seller_name?.trim() || t("sale_celebration.someone"),
        device: meta.device?.trim() || "",
      };
      if (!current) {
        setCurrent(item);
        fireConfetti();
        window.setTimeout(() => {
          setCurrent(null);
          markRead.mutate(item.id);
        }, OVERLAY_MS);
      } else {
        // Уже показываем другую овагию — не дублируем экран, просто
        // mark-read'им «пропущенную», чтобы не всплыла на следующем poll.
        markRead.mutate(n.id);
      }
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
        <div style={{ fontSize: 44, lineHeight: 1, marginBottom: 12 }}>🎉</div>
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
