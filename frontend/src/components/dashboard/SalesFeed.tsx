import { useNavigate } from "react-router-dom";
import { formatUZS } from "../../lib/format";

interface Sale {
  id: number;
  sold_at: string;
  operator_name?: string;
  channel_name?: string;
  phone_model?: string;
  imei?: string;
  amount: number | string;
}

interface Props {
  sales: Sale[];
}

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function SalesFeed({ sales }: Props) {
  const nav = useNavigate();
  return (
    <div className="nf-card overflow-hidden animate-nfFadeUp" style={{ animationDelay: "0.2s" }}>
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <div className="flex items-center gap-2">
          <div className="text-[15px] font-semibold tracking-tight">Лента продаж</div>
          <span className="relative flex w-2 h-2">
            <span
              className="animate-nfPulse absolute inline-flex h-full w-full rounded-full"
              style={{ background: "var(--accent)" }}
            />
            <span
              className="relative inline-flex w-2 h-2 rounded-full"
              style={{ background: "var(--accent)" }}
            />
          </span>
          <span className="text-[11.5px] text-muted">реалтайм</span>
        </div>
      </div>
      <div
        className="grid gap-2 px-6 pb-2 nf-col"
        style={{ gridTemplateColumns: "90px 1.1fr 1fr 1.2fr .8fr .9fr" }}
      >
        <div>Время</div>
        <div>Оператор</div>
        <div>Канал</div>
        <div>Модель</div>
        <div>IMEI</div>
        <div className="text-right">Сумма</div>
      </div>
      <div>
        {sales.length === 0 && (
          <div className="text-center text-muted py-10 text-[13px]">
            Пока нет продаж — они появятся здесь в реальном времени
          </div>
        )}
        {sales.map((s, i) => (
          <div
            key={s.id}
            onClick={() => nav(`/sales/${s.id}`)}
            className="nf-row animate-nfFadeUp"
            style={{
              gridTemplateColumns: "90px 1.1fr 1fr 1.2fr .8fr .9fr",
              animationDelay: `${0.03 + i * 0.045}s`,
            }}
          >
            <div className="text-muted tabular-nums">{fmtTime(s.sold_at)}</div>
            <div className="truncate">{s.operator_name ?? "—"}</div>
            <div className="text-muted truncate">{s.channel_name ?? "—"}</div>
            <div className="truncate">{s.phone_model ?? "—"}</div>
            <div className="text-muted font-mono text-[12px] truncate">{s.imei ?? "—"}</div>
            <div className="text-right font-semibold tabular-nums">
              {formatUZS(Number(s.amount))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
