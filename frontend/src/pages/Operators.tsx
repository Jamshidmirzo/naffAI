import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../lib/api";

export default function Operators() {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ full_name: "", phone: "", status: "active", note: "" });

  const ops = useQuery({
    queryKey: ["operators"],
    queryFn: () => api.get("/operators/").then((r) => r.data),
  });

  const create = useMutation({
    mutationFn: (data: any) => api.post("/operators/", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      setShow(false);
      setForm({ full_name: "", phone: "", status: "active", note: "" });
    },
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      api.post(`/operators/${id}/${active ? "reactivate" : "deactivate"}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operators"] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Операторы</h1>
        <button className="btn-primary" onClick={() => setShow(true)}>
          <Plus className="w-4 h-4" /> Добавить
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2 text-left">Имя</th>
              <th className="px-4 py-2 text-left">Телефон</th>
              <th className="px-4 py-2 text-left">Статус</th>
              <th className="px-4 py-2 text-right">Действие</th>
            </tr>
          </thead>
          <tbody>
            {(ops.data?.results || []).map((o: any) => (
              <tr key={o.id} className="border-t border-gray-100 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-800/40">
                <td className="px-4 py-2">{o.full_name}</td>
                <td className="px-4 py-2 text-gray-600 dark:text-slate-400">{o.phone || "—"}</td>
                <td className="px-4 py-2">
                  <span
                    className={`badge ${
                      o.status === "active"
                        ? "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                        : o.status === "trainee"
                        ? "bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300"
                        : "bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400"
                    }`}
                  >
                    {o.status === "active" ? "активен" : o.status === "trainee" ? "стажёр" : "неактивен"}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    className="btn-ghost text-xs"
                    onClick={() =>
                      toggle.mutate({ id: o.id, active: o.status === "inactive" })
                    }
                  >
                    {o.status === "inactive" ? "Активировать" : "Деактивировать"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {show && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(form);
            }}
            className="card p-6 w-full max-w-md space-y-4"
          >
            <h2 className="text-lg font-semibold">Новый оператор</h2>
            <div>
              <label className="label">ФИО</label>
              <input
                className="input"
                required
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Телефон</label>
              <input
                className="input"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Статус</label>
              <select
                className="input"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                <option value="active">Активный</option>
                <option value="trainee">Стажёр</option>
                <option value="inactive">Неактивный</option>
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setShow(false)}>
                Отмена
              </button>
              <button className="btn-primary">Сохранить</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
