import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";

interface BirthdayRow {
  operator_id: number;
  full_name: string;
  phone: string;
  age: number;
  status: string;
}

/**
 * Компакт-карточка на manager-dashboard: «🎂 Сегодня день рождения».
 *
 * Backend: `GET /api/operators/birthdays-today/` возвращает только
 * сегодняшних именинников (year игнорируется, inactive исключены).
 * Если список пуст — не рендерим карточку вообще (чтобы не занимать
 * место каждый день, когда никого нет).
 *
 * Refetch раз в 5 минут — если менеджер оставил CRM открытым на весь
 * день, а в полночь кто-то стал именинником, карточка появится сама.
 */
export function BirthdaysTodayCard() {
  const t = useT();
  const q = useQuery<BirthdayRow[]>({
    queryKey: ["birthdays-today"],
    queryFn: () => api.get<BirthdayRow[]>("/operators/birthdays-today/").then((r) => r.data),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const rows = q.data ?? [];
  if (!rows.length) return null;

  return (
    <div
      className="nf-card p-5 animate-nfFadeUp"
      style={{
        animationDelay: "0.16s",
        background:
          "linear-gradient(180deg, rgba(251,146,60,0.06), transparent 60%)",
        borderColor: "rgba(251,146,60,0.35)",
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span aria-hidden="true" style={{ fontSize: 20 }}>🎂</span>
        <div className="text-[15px] font-semibold tracking-tight">
          {t("birthday.managerCard.title")}
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li
            key={r.operator_id}
            className="flex items-center justify-between gap-3 text-[13.5px]"
          >
            <div className="min-w-0 flex-1">
              <span className="font-medium">{r.full_name}</span>
              <span className="text-muted ml-2 tabular-nums">
                {t("birthday.managerCard.age", { n: r.age })}
              </span>
            </div>
            {r.phone && (
              <a
                href={`tel:${r.phone}`}
                className="text-muted tabular-nums hover:text-text transition-colors"
                style={{ fontSize: 12.5 }}
              >
                {r.phone}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default BirthdaysTodayCard;
