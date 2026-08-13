import { useState } from "react";
import { ChevronDown, ChevronUp, Clock } from "lucide-react";
import { useT } from "../lib/i18n";

interface Props {
  time: string; // "HH:MM:SS"
  days: string[]; // ["mon","tue",...]  empty = every day
  onChange: (next: { time: string; days: string[] }) => void;
}

const WEEKDAYS_ORDERED: { key: string; i18nKey: string }[] = [
  { key: "mon", i18nKey: "bot.weekdays.mon" },
  { key: "tue", i18nKey: "bot.weekdays.tue" },
  { key: "wed", i18nKey: "bot.weekdays.wed" },
  { key: "thu", i18nKey: "bot.weekdays.thu" },
  { key: "fri", i18nKey: "bot.weekdays.fri" },
  { key: "sat", i18nKey: "bot.weekdays.sat" },
  { key: "sun", i18nKey: "bot.weekdays.sun" },
];

const WORKWEEK = ["mon", "tue", "wed", "thu", "fri"];

type Preset = {
  key: string;
  i18nKey: string;
  time: string;
  days: string[];
};

const PRESETS: Preset[] = [
  { key: "morning_daily", i18nKey: "bot.schedule.preset_morning", time: "09:00:00", days: [] },
  { key: "evening_daily", i18nKey: "bot.schedule.preset_evening", time: "20:00:00", days: [] },
  { key: "workweek_morning", i18nKey: "bot.schedule.preset_workweek", time: "09:00:00", days: WORKWEEK },
  { key: "monday_weekly", i18nKey: "bot.schedule.preset_monday", time: "09:00:00", days: ["mon"] },
];

function sameDays(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((d, i) => d === bs[i]);
}

export default function BotSchedulePicker({ time, days, onChange }: Props) {
  const t = useT();
  const [advanced, setAdvanced] = useState(false);

  const applyPreset = (p: Preset) => {
    onChange({ time: p.time, days: p.days });
  };

  const toggleDay = (day: string) => {
    const next = days.includes(day)
      ? days.filter((d) => d !== day)
      : [...days, day];
    onChange({ time, days: next });
  };

  const currentPresetKey = PRESETS.find(
    (p) => p.time === time && sameDays(p.days, days)
  )?.key;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => applyPreset(p)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition ${
              currentPresetKey === p.key
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--faint)] text-muted hover:text-text"
            }`}
          >
            {t(p.i18nKey)}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setAdvanced(!advanced)}
        className="text-[12px] text-muted flex items-center gap-1 hover:text-text"
      >
        {advanced ? (
          <ChevronUp className="w-3.5 h-3.5" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5" />
        )}
        {t("bot.schedule.advanced")}
      </button>

      {advanced && (
        <div className="space-y-3 pt-1 border-t border-[var(--border)]">
          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <label className="nf-col mb-1.5 block">
                {t("bot.editor.time")}
              </label>
              <div className="relative">
                <Clock className="w-3.5 h-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="time"
                  className="nf-input pl-8"
                  value={time.slice(0, 5)}
                  onChange={(e) => onChange({ time: e.target.value + ":00", days })}
                />
              </div>
            </div>
            <div className="text-[11px] text-muted pb-2" title={t("bot.schedule.tz_tip")}>
              {t("bot.schedule.tz_label")}
            </div>
          </div>

          <div>
            <label className="nf-col mb-1.5 block">{t("bot.editor.days")}</label>
            <div className="flex gap-1.5 flex-wrap">
              {WEEKDAYS_ORDERED.map((d) => {
                const isSel = days.length === 0 || days.includes(d.key);
                return (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => toggleDay(d.key)}
                    className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition ${
                      isSel
                        ? "bg-[var(--accent)] text-white"
                        : "bg-[var(--faint)] text-muted"
                    }`}
                  >
                    {t(d.i18nKey)}
                  </button>
                );
              })}
            </div>
            <div className="text-[11px] text-muted mt-1.5">
              {days.length === 0
                ? t("bot.editor.every_day_hint")
                : t("bot.schedule.custom_hint")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
