import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Download, Plus } from "lucide-react";
import { api, API_BASE_URL } from "../lib/api";
import { formatDate, formatUZS } from "../lib/format";

export default function Sales() {
  const [search, setSearch] = useState("");

  const sales = useQuery({
    queryKey: ["sales", search],
    queryFn: () =>
      api.get("/sales/", { params: { search: search || undefined } }).then((r) => r.data),
  });

  const exportUrl = `${API_BASE_URL}/sales/export.xlsx${
    search ? `?search=${encodeURIComponent(search)}` : ""
  }`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Продажи</h1>
        <div className="flex gap-2">
          <a href={exportUrl} className="btn-ghost">
            <Download className="w-4 h-4" /> Excel
          </a>
          <Link to="/sales/new" className="btn-primary">
            <Plus className="w-4 h-4" /> Новая продажа
          </Link>
        </div>
      </div>

      <div className="card p-4">
        <input
          className="input max-w-md"
          placeholder="Поиск по IMEI, модели, оператору…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Дата</th>
              <th className="px-4 py-2 text-left">IMEI</th>
              <th className="px-4 py-2 text-left">Модель</th>
              <th className="px-4 py-2 text-left">Оператор</th>
              <th className="px-4 py-2 text-left">Канал</th>
              <th className="px-4 py-2 text-right">Сумма</th>
              <th className="px-4 py-2 text-center">Статус</th>
            </tr>
          </thead>
          <tbody>
            {(sales.data?.results || []).map((s: any) => (
              <tr key={s.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-600">{formatDate(s.sold_at)}</td>
                <td className="px-4 py-2 font-mono text-xs">{s.imei}</td>
                <td className="px-4 py-2">{s.phone_model}</td>
                <td className="px-4 py-2">{s.operator_name}</td>
                <td className="px-4 py-2 text-gray-600">{s.channel_name}</td>
                <td className="px-4 py-2 text-right">{formatUZS(s.amount)}</td>
                <td className="px-4 py-2 text-center">
                  {s.is_returned ? (
                    <span className="badge bg-red-100 text-red-700">возврат</span>
                  ) : s.status === "pending" ? (
                    <span className="badge bg-amber-100 text-amber-700">ожидает</span>
                  ) : (
                    <span className="badge bg-emerald-100 text-emerald-700">ОК</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sales.data?.results?.length === 0 && (
          <div className="px-4 py-12 text-center text-gray-500 text-sm">Нет продаж</div>
        )}
      </div>
    </div>
  );
}
