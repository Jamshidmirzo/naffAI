import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";

export default function Audit() {
  const q = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.get("/audit/").then((r) => r.data),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Журнал изменений</h1>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-600">
            <tr>
              <th className="px-4 py-2 text-left">Когда</th>
              <th className="px-4 py-2 text-left">Кто</th>
              <th className="px-4 py-2 text-left">Действие</th>
              <th className="px-4 py-2 text-left">Объект</th>
              <th className="px-4 py-2 text-left">Изменения</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.results || []).map((row: any) => (
              <tr key={row.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-600">{formatDate(row.created_at)}</td>
                <td className="px-4 py-2">{row.user_name || "—"}</td>
                <td className="px-4 py-2">{row.action}</td>
                <td className="px-4 py-2 text-gray-600 font-mono text-xs">
                  {row.entity}#{row.entity_id}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  <pre className="whitespace-pre-wrap font-mono">{JSON.stringify(row.changes, null, 0)}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
