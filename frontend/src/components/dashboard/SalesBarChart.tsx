import { useMemo } from "react";
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";

/**
 * SalesBarChart — bar-chart для менеджерского дашборда «Сводка дня».
 *
 * — Один бар на день (data.day = 'YYYY-MM-DD', data.count = число продаж).
 * — Число подписано над каждым баром через <LabelList/>.
 * — Плановая линия (dashed reference line) рисуется, если targetPerDay > 0.
 * — Highlight-тон применяется к `today` и к бару с максимальным count.
 * — Оси Y скрыты — макет минималистичный, важно только соотношение.
 */
export interface SalesBarPoint {
  day: string; // ISO-YYYY-MM-DD
  count: number;
}

interface Props {
  data: SalesBarPoint[];
  targetPerDay?: number | null;
  height?: number;
}

const WEEKDAY_LABELS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

function shortLabel(iso: string): string {
  // "2026-08-18" → "18/08" — экономит место, читаемо
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}`;
}

function weekdayFor(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  // Date.getDay(): 0=sunday..6=saturday, наши подписи начинаются с пн
  const idx = (d.getDay() + 6) % 7;
  return WEEKDAY_LABELS[idx] ?? "";
}

export function SalesBarChart({ data, targetPerDay, height = 220 }: Props) {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const maxCount = useMemo(
    () => Math.max(1, ...data.map((d) => d.count)),
    [data],
  );

  const prepared = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        _label: shortLabel(d.day),
        _weekday: weekdayFor(d.day),
        _isToday: d.day === todayIso,
        _isMax: d.count > 0 && d.count === maxCount,
      })),
    [data, maxCount, todayIso],
  );

  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={prepared} margin={{ top: 26, right: 12, left: 0, bottom: 6 }}>
          <XAxis
            dataKey="_label"
            axisLine={false}
            tickLine={false}
            interval={0}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
          />
          <Tooltip
            cursor={{ fill: "rgba(0,0,0,0.04)" }}
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: 12,
              padding: "6px 10px",
            }}
            formatter={(v: number) => [`${v} шт.`, ""]}
            labelFormatter={(l: string, p: Array<{ payload?: { _weekday?: string; day?: string } }>) => {
              const row = p?.[0]?.payload;
              return row ? `${row._weekday ?? ""} ${row.day ?? l}`.trim() : l;
            }}
          />
          {typeof targetPerDay === "number" && targetPerDay > 0 && (
            <ReferenceLine
              y={targetPerDay}
              stroke="var(--muted)"
              strokeDasharray="4 4"
              strokeOpacity={0.7}
              ifOverflow="extendDomain"
              label={{
                value: `план ${targetPerDay}`,
                position: "insideTopRight",
                fill: "var(--muted)",
                fontSize: 10.5,
              }}
            />
          )}
          <Bar dataKey="count" radius={[6, 6, 2, 2]} maxBarSize={38}>
            {prepared.map((entry) => (
              <Cell
                key={entry.day}
                fill={
                  entry._isToday
                    ? "var(--accent)"
                    : entry._isMax
                      ? "var(--accent2)"
                      : "var(--faint)"
                }
              />
            ))}
            <LabelList
              dataKey="count"
              position="top"
              formatter={(v: number) => (v > 0 ? v : "")}
              style={{ fontSize: 11, fontWeight: 600, fill: "var(--text)" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
