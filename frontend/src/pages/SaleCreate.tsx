import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

type Gift = { name: string; cost?: string };

export default function SaleCreate() {
  const nav = useNavigate();
  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [operator, setOperator] = useState("");
  const [channel, setChannel] = useState("");
  const [amount, setAmount] = useState("");
  const [comment, setComment] = useState("");
  const [gifts, setGifts] = useState<Gift[]>([]);
  const [error, setError] = useState("");
  const [allowDup, setAllowDup] = useState(false);
  const [dupComment, setDupComment] = useState("");

  const ops = useQuery({
    queryKey: ["operators-list"],
    queryFn: () => api.get("/operators/?status=active").then((r) => r.data),
  });
  const channels = useQuery({
    queryKey: ["channels-list"],
    queryFn: () => api.get("/channels/?active_only=1").then((r) => r.data),
  });

  useEffect(() => {
    if (imei.length === 15 && /^\d+$/.test(imei)) {
      api
        .get(`/imei/${imei}/lookup/`)
        .then((r) => {
          if (r.data.brand || r.data.model) {
            setModel(`${r.data.brand} ${r.data.model}`.trim());
          }
        })
        .catch(() => {});
    }
  }, [imei]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api.post("/sales/", {
        imei,
        phone_model: model,
        operator: Number(operator),
        channel: Number(channel),
        amount,
        comment,
        gifts: gifts.filter((g) => g.name),
        allow_duplicate_imei: allowDup,
        duplicate_override_comment: dupComment,
      });
      nav("/sales");
    } catch (err: any) {
      const d = err.response?.data || {};
      setError(d.detail || "Ошибка сохранения");
      if (d.duplicate_count) setAllowDup(true);
    }
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-6">Новая продажа</h1>
      <form onSubmit={onSubmit} className="card p-6 space-y-4">
        <div>
          <label className="label">IMEI (15 цифр)</label>
          <input
            className="input font-mono"
            value={imei}
            onChange={(e) => setImei(e.target.value.replace(/\D/g, ""))}
            maxLength={15}
            placeholder="490154203237518"
            required
          />
          {imei.length === 15 && (
            <div className="text-xs text-gray-500 mt-1">
              {model ? `→ ${model}` : "модель не определена, заполни вручную"}
            </div>
          )}
        </div>

        <div>
          <label className="label">Модель</label>
          <input className="input" value={model} onChange={(e) => setModel(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Оператор</label>
            <select className="input" value={operator} onChange={(e) => setOperator(e.target.value)} required>
              <option value="">—</option>
              {(ops.data?.results || []).map((o: any) => (
                <option key={o.id} value={o.id}>
                  {o.full_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Канал</label>
            <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)} required>
              <option value="">—</option>
              {(channels.data?.results || []).map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label">Сумма (сум)</label>
          <input
            className="input"
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min="0"
            step="1000"
            required
          />
        </div>

        <div>
          <label className="label">Подарки (входят в сумму, на премию не влияют)</label>
          {gifts.map((g, i) => (
            <div key={i} className="flex gap-2 mb-2">
              <input
                className="input"
                placeholder="Название"
                value={g.name}
                onChange={(e) => {
                  const next = [...gifts];
                  next[i] = { ...next[i], name: e.target.value };
                  setGifts(next);
                }}
              />
              <input
                className="input max-w-[180px]"
                type="number"
                placeholder="Себестоимость"
                value={g.cost || ""}
                onChange={(e) => {
                  const next = [...gifts];
                  next[i] = { ...next[i], cost: e.target.value };
                  setGifts(next);
                }}
              />
              <button
                type="button"
                onClick={() => setGifts(gifts.filter((_, j) => j !== i))}
                className="btn-ghost"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => setGifts([...gifts, { name: "" }])}
          >
            + добавить подарок
          </button>
        </div>

        <div>
          <label className="label">Комментарий</label>
          <textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>

        {allowDup && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-2">
            <div className="text-sm text-amber-800">
              IMEI уже встречался. Подтвердите дубликат с комментарием:
            </div>
            <input
              className="input"
              placeholder="Причина (замена, обмен, ошибка ранее…)"
              value={dupComment}
              onChange={(e) => setDupComment(e.target.value)}
            />
          </div>
        )}

        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={() => nav(-1)}>
            Отмена
          </button>
          <button className="btn-primary" type="submit">
            Сохранить
          </button>
        </div>
      </form>
    </div>
  );
}
