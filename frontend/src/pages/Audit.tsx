import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { Chip, StatusBadge } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface AuditRow {
  id: number;
  created_at: string;
  user_name: string | null;
  action: string;
  entity: string;
  entity_id: number | string;
  changes: unknown;
}

export default function Audit() {
  const [search, setSearch] = useState("");
  const [entity, setEntity] = useState<string>("");

  usePageHeader({ title: (useT())("audit.title"), subtitle: "Журнал изменений" });

  const q = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.get("/audit/").then((r) => r.data),
  });

  const rows: AuditRow[] = q.data?.results || [];

  const entities = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => s.add(r.entity));
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (entity && r.entity !== entity) return false;
      if (!term) return true;
      const bag = `${r.user_name ?? ""} ${r.action} ${r.entity} ${r.entity_id} ${JSON.stringify(
        r.changes,
      )}`.toLowerCase();
      return bag.includes(term);
    });
  }, [rows, search, entity]);

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Toolbar */}
      <section className="flex flex-wrap items-center gap-3 animate-nfFadeUp">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            className="nf-input pl-11"
            placeholder="Поиск: кто / что / когда…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip active={entity === ""} onClick={() => setEntity("")}>
            Все объекты
          </Chip>
          {entities.map((e) => (
            <Chip key={e} active={entity === e} onClick={() => setEntity(e)}>
              {e}
            </Chip>
          ))}
        </div>
      </section>

      {/* Table */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: ".8fr .8fr .6fr .8fr 1.6fr" }}
        >
          <div>Когда</div>
          <div>Кто</div>
          <div>Действие</div>
          <div>Объект</div>
          <div>Изменения</div>
        </div>
        {q.isLoading ? (
          <div className="text-center text-muted py-12 text-[13px]">Загрузка…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            Пока пусто — измените запрос или фильтр
          </div>
        ) : (
          <div>
            {filtered.map((row, i) => (
              <div
                key={row.id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: ".8fr .8fr .6fr .8fr 1.6fr",
                  animationDelay: `${0.02 + i * 0.035}s`,
                  cursor: "default",
                }}
              >
                <div className="text-muted tabular-nums">{formatDate(row.created_at)}</div>
                <div className="truncate">{row.user_name || "—"}</div>
                <div>
                  <StatusBadge tone={row.action === "delete" ? "danger" : "neutral"}>
                    {row.action}
                  </StatusBadge>
                </div>
                <div className="text-muted font-mono text-[12px] truncate">
                  {row.entity}#{row.entity_id}
                </div>
                <div className="text-[11.5px] text-muted overflow-hidden">
                  <pre className="whitespace-pre-wrap font-mono truncate">
                    {JSON.stringify(row.changes)}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
