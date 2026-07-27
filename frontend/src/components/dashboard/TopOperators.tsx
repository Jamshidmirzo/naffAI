import { useNavigate } from "react-router-dom";
import { formatUZS } from "../../lib/format";

interface Op {
  operator_id: number | string;
  operator_name: string;
  total: number | string;
  count?: number | string;
}

interface Props {
  operators: Op[];
}

export function TopOperators({ operators }: Props) {
  const nav = useNavigate();
  const top = operators.slice(0, 5);
  const max = Math.max(1, ...top.map((o) => Number(o.total)));
  return (
    <div className="nf-card p-5 animate-nfFadeUp" style={{ animationDelay: "0.15s" }}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[15px] font-semibold tracking-tight">Топ операторов</div>
      </div>
      <ol className="flex flex-col gap-3">
        {top.length === 0 && (
          <li className="text-[13px] text-muted py-6 text-center">Пока пусто</li>
        )}
        {top.map((op, i) => {
          const total = Number(op.total);
          const share = (total / max) * 100;
          const isFirst = i === 0;
          return (
            <li
              key={op.operator_id ?? i}
              className="grid items-center cursor-pointer group"
              style={{ gridTemplateColumns: "26px 1fr auto" }}
              onClick={() => nav(`/operators/${op.operator_id}`)}
            >
              <div
                className="grid place-items-center text-[12px] font-semibold tabular-nums"
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 99,
                  background: isFirst ? "var(--accent-grad)" : "var(--faint)",
                  color: isFirst ? "#fff" : "var(--muted)",
                }}
              >
                {i + 1}
              </div>
              <div className="pl-3 min-w-0">
                <div className="text-[13.5px] font-medium truncate group-hover:text-[color:var(--accent)] transition">
                  {op.operator_name}
                </div>
                <div
                  className="mt-1.5 h-[5px] rounded-full overflow-hidden"
                  style={{ background: "var(--faint)" }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-700 ease-nf"
                    style={{ width: `${share}%`, background: "var(--accent-grad)" }}
                  />
                </div>
              </div>
              <div className="pl-3 text-[13px] tabular-nums font-semibold">
                {formatUZS(total)}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
