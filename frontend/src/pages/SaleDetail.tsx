import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AlertTriangle, CheckCircle, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { formatDate, formatUZS, toDateInputValue } from "../lib/format";
import { useState } from "react";

export default function SaleDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [returnReason, setReturnReason] = useState("");
  const [showReturn, setShowReturn] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const [newDate, setNewDate] = useState("");

  const q = useQuery({
    queryKey: ["sale", id],
    queryFn: () => api.get(`/sales/${id}/`).then((r) => r.data),
  });

  const confirmMut = useMutation({
    mutationFn: () => api.post(`/sales/${id}/confirm/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sale", id] });
      qc.invalidateQueries({ queryKey: ["sales"] });
    },
  });

  const returnMut = useMutation({
    mutationFn: (reason: string) => api.post(`/sales/${id}/return/`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sale", id] });
      qc.invalidateQueries({ queryKey: ["sales"] });
      setShowReturn(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/sales/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales"] });
      nav("/sales");
    },
  });

  const saveDateMut = useMutation({
    mutationFn: (dateStr: string) =>
      api.patch(`/sales/${id}/`, { sold_at: `${dateStr}T12:00:00` }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sale", id] });
      qc.invalidateQueries({ queryKey: ["sales"] });
      setEditingDate(false);
    },
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500 dark:text-slate-400">
        Загрузка…
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <div className="text-center py-20">
        <div className="text-red-600 dark:text-red-400 mb-4">Продажа не найдена</div>
        <button className="btn-ghost" onClick={() => nav("/sales")}>
          <ArrowLeft className="w-4 h-4" /> Назад к списку
        </button>
      </div>
    );
  }

  const s = q.data;
  const isPending = s.status === "pending";
  const isReturned = s.is_returned;
  const isDeleted = s.is_deleted;

  const operatorLines: { operator: number; operator_name: string; amount: string }[] =
    s.operator_lines || [];
  const partnerLines: { partner: number; partner_name: string; amount: string }[] =
    s.partner_lines || [];

  const opTotal = operatorLines.reduce((sum, l) => sum + Number(l.amount), 0);
  const partnerTotal = partnerLines.reduce((sum, l) => sum + Number(l.amount), 0);

  return (
    <div className="max-w-3xl">
      <button
        className="btn-ghost mb-4"
        onClick={() => nav("/sales")}
      >
        <ArrowLeft className="w-4 h-4" /> Назад
      </button>

      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-semibold">Продажа #{s.id}</h1>
        {isReturned && (
          <span className="badge bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300">
            возврат
          </span>
        )}
        {isDeleted && (
          <span className="badge bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400">
            удалена
          </span>
        )}
        {isPending && (
          <span className="badge bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">
            ожидает подтверждения
          </span>
        )}
        {!isPending && !isReturned && !isDeleted && (
          <span className="badge bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300">
            подтверждена
          </span>
        )}
      </div>

      {/* Main info */}
      <div className="card p-6 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="label">IMEI</div>
            <div className="font-mono text-sm">{s.imei}</div>
          </div>
          <div>
            <div className="label">Модель</div>
            <div className="text-sm font-medium">{s.phone_model}</div>
          </div>
          <div>
            <div className="label">Дата продажи</div>
            {editingDate ? (
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  className="input"
                  value={newDate || toDateInputValue(s.sold_at)}
                  max={toDateInputValue(new Date())}
                  onChange={(e) => setNewDate(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-ghost px-2"
                  onClick={() =>
                    saveDateMut.mutate(newDate || toDateInputValue(s.sold_at))
                  }
                  disabled={saveDateMut.isPending}
                >
                  <CheckCircle className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  className="btn-ghost px-2"
                  onClick={() => {
                    setEditingDate(false);
                    setNewDate("");
                  }}
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setNewDate(toDateInputValue(s.sold_at));
                  setEditingDate(true);
                }}
                className="text-sm hover:text-accent inline-flex items-center gap-1 group"
                title="Изменить дату"
              >
                {formatDate(s.sold_at)}
                <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100" />
              </button>
            )}
          </div>
          <div>
            <div className="label">Итого</div>
            <div className="text-lg font-semibold">{formatUZS(s.amount)}</div>
          </div>
        </div>

        {s.comment && (
          <div className="mt-4 pt-4 border-t border-gray-100 dark:border-slate-800">
            <div className="label">Комментарий</div>
            <div className="text-sm text-gray-700 dark:text-slate-300">{s.comment}</div>
          </div>
        )}
      </div>

      {/* Operator allocation */}
      <div className="card overflow-hidden mb-4">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between">
          <div className="text-sm font-medium">Операторы</div>
          <div className="text-xs text-gray-500 dark:text-slate-400">
            {operatorLines.length} {operatorLines.length === 1 ? "оператор" : "операторов"}
          </div>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
            <tr>
              <th className="px-5 py-2 text-left">Оператор</th>
              <th className="px-5 py-2 text-right">Сумма</th>
              <th className="px-5 py-2 text-right">Доля</th>
            </tr>
          </thead>
          <tbody>
            {operatorLines.map((line, i) => {
              const pct = opTotal > 0 ? (Number(line.amount) / opTotal) * 100 : 0;
              return (
                <tr key={i} className="border-t border-gray-100 dark:border-slate-800">
                  <td className="px-5 py-3 font-medium">{line.operator_name}</td>
                  <td className="px-5 py-3 text-right">{formatUZS(line.amount)}</td>
                  <td className="px-5 py-3 text-right text-gray-500 dark:text-slate-400">
                    {pct.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
          {operatorLines.length > 1 && (
            <tfoot className="bg-gray-50 dark:bg-slate-900 font-medium">
              <tr>
                <td className="px-5 py-2">Итого</td>
                <td className="px-5 py-2 text-right">{formatUZS(opTotal)}</td>
                <td className="px-5 py-2 text-right text-gray-500 dark:text-slate-400">100%</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Partner allocation */}
      <div className="card overflow-hidden mb-4">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between">
          <div className="text-sm font-medium">Партнёры (способы оплаты)</div>
          <div className="text-xs text-gray-500 dark:text-slate-400">
            {partnerLines.length} {partnerLines.length === 1 ? "партнёр" : "партнёров"}
          </div>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
            <tr>
              <th className="px-5 py-2 text-left">Партнёр</th>
              <th className="px-5 py-2 text-right">Сумма</th>
              <th className="px-5 py-2 text-right">Доля</th>
            </tr>
          </thead>
          <tbody>
            {partnerLines.map((line, i) => {
              const pct = partnerTotal > 0 ? (Number(line.amount) / partnerTotal) * 100 : 0;
              return (
                <tr key={i} className="border-t border-gray-100 dark:border-slate-800">
                  <td className="px-5 py-3 font-medium">{line.partner_name}</td>
                  <td className="px-5 py-3 text-right">{formatUZS(line.amount)}</td>
                  <td className="px-5 py-3 text-right text-gray-500 dark:text-slate-400">
                    {pct.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
          {partnerLines.length > 1 && (
            <tfoot className="bg-gray-50 dark:bg-slate-900 font-medium">
              <tr>
                <td className="px-5 py-2">Итого</td>
                <td className="px-5 py-2 text-right">{formatUZS(partnerTotal)}</td>
                <td className="px-5 py-2 text-right text-gray-500 dark:text-slate-400">100%</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Gifts */}
      {s.gifts && s.gifts.length > 0 && (
        <div className="card overflow-hidden mb-4">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 text-sm font-medium">
            Подарки
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
              <tr>
                <th className="px-5 py-2 text-left">Название</th>
                <th className="px-5 py-2 text-right">Себестоимость</th>
              </tr>
            </thead>
            <tbody>
              {s.gifts.map((g: { id: number; name: string; cost: string | null }) => (
                <tr key={g.id} className="border-t border-gray-100 dark:border-slate-800">
                  <td className="px-5 py-3">{g.name}</td>
                  <td className="px-5 py-3 text-right">
                    {g.cost ? formatUZS(g.cost) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Return info */}
      {isReturned && (
        <div className="card p-5 mb-4 border-red-200 dark:border-red-800/40 bg-red-50/50 dark:bg-red-900/10">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-400 text-sm font-medium mb-2">
            <AlertTriangle className="w-4 h-4" /> Возврат
          </div>
          <div className="text-sm text-gray-700 dark:text-slate-300">
            <span className="text-gray-500 dark:text-slate-400">Дата возврата:</span>{" "}
            {formatDate(s.returned_at)}
          </div>
          {s.return_reason && (
            <div className="text-sm text-gray-700 dark:text-slate-300 mt-1">
              <span className="text-gray-500 dark:text-slate-400">Причина:</span>{" "}
              {s.return_reason}
            </div>
          )}
        </div>
      )}

      {/* Meta */}
      <div className="card p-5 mb-6">
        <div className="text-sm font-medium mb-3">Информация</div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-gray-500 dark:text-slate-400">Создано:</span>{" "}
            {formatDate(s.created_at)}
          </div>
          <div>
            <span className="text-gray-500 dark:text-slate-400">Обновлено:</span>{" "}
            {formatDate(s.updated_at)}
          </div>
          <div>
            <span className="text-gray-500 dark:text-slate-400">Основной оператор:</span>{" "}
            {s.operator_name}
          </div>
          <div>
            <span className="text-gray-500 dark:text-slate-400">Основной канал:</span>{" "}
            {s.channel_name}
          </div>
        </div>
      </div>

      {/* Actions */}
      {!isDeleted && (
        <div className="flex flex-wrap gap-2">
          {isPending && (
            <button
              className="btn-primary"
              onClick={() => confirmMut.mutate()}
              disabled={confirmMut.isPending}
            >
              <CheckCircle className="w-4 h-4" />
              {confirmMut.isPending ? "Подтверждение…" : "Подтвердить"}
            </button>
          )}
          {!isReturned && (
            <button
              className="btn-ghost text-amber-700 dark:text-amber-400"
              onClick={() => setShowReturn(true)}
            >
              <RotateCcw className="w-4 h-4" /> Возврат
            </button>
          )}
          <button
            className="btn-ghost text-red-600 dark:text-red-400"
            onClick={() => setShowDelete(true)}
          >
            <Trash2 className="w-4 h-4" /> Удалить
          </button>
        </div>
      )}

      {/* Return modal */}
      {showReturn && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50">
          <div className="card p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-semibold">Оформить возврат</h2>
            <div>
              <label className="label">Причина возврата</label>
              <textarea
                className="input"
                rows={3}
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value)}
                placeholder="Укажите причину возврата…"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setShowReturn(false)}>
                Отмена
              </button>
              <button
                className="btn bg-amber-600 text-white hover:bg-amber-700"
                onClick={() => returnMut.mutate(returnReason)}
                disabled={returnMut.isPending}
              >
                {returnMut.isPending ? "Оформление…" : "Оформить возврат"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {showDelete && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/60 flex items-center justify-center z-50">
          <div className="card p-6 w-full max-w-md space-y-4">
            <h2 className="text-lg font-semibold text-red-600 dark:text-red-400">Удалить продажу?</h2>
            <p className="text-sm text-gray-600 dark:text-slate-400">
              Продажа #{s.id} ({s.phone_model}, {formatUZS(s.amount)}) будет помечена как удалённая.
              Это действие можно отменить через админку.
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setShowDelete(false)}>
                Отмена
              </button>
              <button
                className="btn bg-red-600 text-white hover:bg-red-700"
                onClick={() => deleteMut.mutate()}
                disabled={deleteMut.isPending}
              >
                {deleteMut.isPending ? "Удаление…" : "Удалить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
