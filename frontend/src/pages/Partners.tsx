import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../lib/api";

export default function Partners() {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");

  const list = useQuery({
    queryKey: ["partners"],
    queryFn: () => api.get("/channels/").then((r) => r.data),
  });

  const create = useMutation({
    mutationFn: (body: { name: string; is_active: boolean }) => api.post("/channels/", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["partners"] });
      qc.invalidateQueries({ queryKey: ["partners-list"] });
      setShow(false);
      setName("");
    },
  });

  const toggle = useMutation({
    mutationFn: (p: { id: number; is_active: boolean }) =>
      api.patch(`/channels/${p.id}/`, { is_active: p.is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["partners"] });
      qc.invalidateQueries({ queryKey: ["partners-list"] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Партнёры</h1>
        <button className="btn-primary" onClick={() => setShow(true)}>
          <Plus className="w-4 h-4" /> Добавить
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2 text-left">Название</th>
              <th className="px-4 py-2 text-left">Статус</th>
              <th className="px-4 py-2 text-right">Действие</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.results || []).map((p: any) => (
              <tr key={p.id} className="border-t border-gray-100 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-800/40">
                <td className="px-4 py-2">{p.name}</td>
                <td className="px-4 py-2">
                  <span
                    className={`badge ${
                      p.is_active ? "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300" : "bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400"
                    }`}
                  >
                    {p.is_active ? "активен" : "выключен"}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    className="btn-ghost text-xs"
                    onClick={() => toggle.mutate({ id: p.id, is_active: !p.is_active })}
                  >
                    {p.is_active ? "Выключить" : "Включить"}
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
              if (!name.trim()) return;
              create.mutate({ name: name.trim(), is_active: true });
            }}
            className="card p-6 w-full max-w-md space-y-4"
          >
            <h2 className="text-lg font-semibold">Новый партнёр</h2>
            <div>
              <label className="label">Название</label>
              <input
                className="input"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alif / Uzum / Hamroh / TBC / Cash …"
                autoFocus
              />
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
