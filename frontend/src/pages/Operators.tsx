import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { formatUZS } from "../lib/format";

function PlanBar({ target, actual }: { target: string | null; actual: string | null }) {
  if (!target) return <span className="text-gray-400 dark:text-slate-600">—</span>;
  const pct = Math.min(100, Math.round((Number(actual || 0) / Number(target)) * 100));
  return (
    <div className="w-36">
      <div className="flex justify-between text-xs text-gray-500 dark:text-slate-400 mb-0.5">
        <span>{pct}%</span>
        <span>{formatUZS(Number(actual || 0))}</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-200 dark:bg-slate-700 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            pct >= 100 ? "bg-emerald-500" : pct >= 70 ? "bg-blue-500" : "bg-amber-400"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">
        из {formatUZS(Number(target))}
      </div>
    </div>
  );
}

export default function Operators() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const role = useAuth((s) => s.role);
  const isTeamLead = role === "team_lead";

  const [showInactive, setShowInactive] = useState(true);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ full_name: "", phone: "", status: "active", note: "" });
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [planModal, setPlanModal] = useState<{ id: number; name: string; current: string | null } | null>(null);
  const [planInput, setPlanInput] = useState("");

  const ops = useQuery({
    queryKey: ["operators", showInactive],
    queryFn: () =>
      api.get("/operators/", { params: { include_inactive: showInactive ? 1 : 0 } }).then((r) => r.data),
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

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/operators/${id}/delete/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["operators-list-all"] });
      setConfirmDelete(null);
      setDeleteError("");
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || "Не удалось удалить оператора";
      setDeleteError(typeof msg === "string" ? msg : "Не удалось удалить оператора");
    },
  });

  const setPlan = useMutation({
    mutationFn: ({ id, target_amount }: { id: number; target_amount: string }) =>
      api.put(`/operators/${id}/plan/`, { target_amount }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      setPlanModal(null);
      setPlanInput("");
    },
  });

  const rows = ops.data?.results || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Операторы</h1>
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost text-sm flex items-center gap-1"
            onClick={() => setShowInactive((v) => !v)}
          >
            {showInactive ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            {showInactive ? "Скрыть неактивных" : "Показать неактивных"}
          </button>
          <button className="btn-primary" onClick={() => setShow(true)}>
            <Plus className="w-4 h-4" /> Добавить
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2 text-left">Имя</th>
              <th className="px-4 py-2 text-left">Телефон</th>
              <th className="px-4 py-2 text-left">Статус</th>
              <th className="px-4 py-2 text-left">План (месяц)</th>
              <th className="px-4 py-2 text-right">Действие</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o: any) => (
              <tr
                key={o.id}
                className={`border-t border-gray-100 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-800/40 ${
                  o.status === "inactive" ? "opacity-50" : ""
                }`}
              >
                <td
                  className="px-4 py-2 cursor-pointer text-blue-700 dark:text-blue-400 hover:underline"
                  onClick={() => nav(`/operators/${o.id}`)}
                >
                  {o.full_name}
                </td>
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
                <td className="px-4 py-3">
                  <div
                    className={isTeamLead ? "cursor-pointer group inline-block" : "inline-block"}
                    onClick={
                      isTeamLead
                        ? () => {
                            setPlanModal({ id: o.id, name: o.full_name, current: o.plan_target });
                            setPlanInput(
                              o.plan_target ? String(Math.round(Number(o.plan_target))) : ""
                            );
                          }
                        : undefined
                    }
                  >
                    <PlanBar target={o.plan_target} actual={o.plan_actual} />
                    {isTeamLead && (
                      <span className="text-xs text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity block mt-0.5">
                        изменить
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button
                      className="btn-ghost text-xs"
                      onClick={() => toggle.mutate({ id: o.id, active: o.status === "inactive" })}
                    >
                      {o.status === "inactive" ? "Активировать" : "Деактивировать"}
                    </button>
                    {isTeamLead && (
                      <button
                        className="btn-ghost text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                        onClick={() => {
                          setDeleteError("");
                          setConfirmDelete({ id: o.id, name: o.full_name });
                        }}
                      >
                        Удалить
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Plan edit modal */}
      {planModal && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50">
          <div className="card p-6 w-full max-w-sm space-y-4">
            <h2 className="text-lg font-semibold">План на месяц</h2>
            <p className="text-sm text-gray-600 dark:text-slate-400">{planModal.name}</p>
            <div>
              <label className="label">Цель (сум)</label>
              <input
                className="input"
                type="number"
                min="0"
                value={planInput}
                onChange={(e) => setPlanInput(e.target.value)}
                placeholder="например 100000000"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setPlanModal(null)}>
                Отмена
              </button>
              <button
                className="btn-primary"
                disabled={!planInput || setPlan.isPending}
                onClick={() => setPlan.mutate({ id: planModal.id, target_amount: planInput })}
              >
                {setPlan.isPending ? "Сохранение…" : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50">
          <div className="card p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-semibold">Удалить оператора</h2>
            <p className="text-sm text-gray-600 dark:text-slate-400">
              Удалить оператора{" "}
              <span className="font-medium text-gray-900 dark:text-slate-100">{confirmDelete.name}</span>?
              Действие необратимо. Удаление возможно только для операторов без продаж — иначе используйте
              деактивацию.
            </p>
            {deleteError && (
              <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">
                {deleteError}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setConfirmDelete(null);
                  setDeleteError("");
                }}
                disabled={remove.isPending}
              >
                Отмена
              </button>
              <button
                type="button"
                className="btn-primary bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700"
                onClick={() => remove.mutate(confirmDelete.id)}
                disabled={remove.isPending}
              >
                {remove.isPending ? "Удаление…" : "Удалить"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create modal */}
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
