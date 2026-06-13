import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";

type OpLine = { operator_id?: number; operator_name?: string; amount: string };
type PLine = { partner_id?: number; partner_name?: string; amount: string };

export default function SaleCreate() {
  const nav = useNavigate();
  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [operators, setOperators] = useState<OpLine[]>([{ amount: "" }]);
  const [partners, setPartners] = useState<PLine[]>([{ amount: "" }]);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [allowDup, setAllowDup] = useState(false);
  const [dupComment, setDupComment] = useState("");

  const opsQ = useQuery({
    queryKey: ["operators-list"],
    queryFn: () => api.get("/operators/?status=active").then((r) => r.data),
  });
  const partnersQ = useQuery({
    queryKey: ["partners-list"],
    queryFn: () => api.get("/channels/?active_only=1").then((r) => r.data),
  });
  const modelsQ = useQuery({
    queryKey: ["models-suggest", model],
    queryFn: () =>
      api
        .get(`/imei/models/`, { params: model ? { q: model } : undefined })
        .then((r) => r.data),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (imei.length >= 6 && /^\d+$/.test(imei) && imei.length === 15) {
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

  const total = useMemo(
    () => partners.reduce((s, p) => s + (Number(p.amount) || 0), 0),
    [partners],
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (imei.length < 6 || imei.length > 15 || !/^\d+$/.test(imei)) {
      setError("IMEI: только цифры, от 6 до 15");
      return;
    }
    const okOps = operators.filter((o) => (o.operator_id || o.operator_name?.trim()) && Number(o.amount) > 0);
    const okPartners = partners.filter((p) => (p.partner_id || p.partner_name?.trim()) && Number(p.amount) > 0);
    if (okOps.length === 0) {
      setError("Добавьте минимум одного оператора с суммой > 0");
      return;
    }
    if (okPartners.length === 0) {
      setError("Добавьте минимум одного партнёра с суммой > 0");
      return;
    }
    try {
      await api.post("/sales/", {
        imei,
        phone_model: model,
        operators: okOps.map((o) => ({
          operator_id: o.operator_id,
          operator_name: o.operator_name?.trim(),
          amount: Number(o.amount).toFixed(2),
        })),
        partners: okPartners.map((p) => ({
          partner_id: p.partner_id,
          partner_name: p.partner_name?.trim(),
          amount: Number(p.amount).toFixed(2),
        })),
        comment,
        allow_duplicate_imei: allowDup,
        duplicate_override_comment: dupComment,
      });
      nav("/sales");
    } catch (err: any) {
      const d = err.response?.data || {};
      const msg = d.detail || d.imei?.[0] || d.amount?.[0] || "Ошибка сохранения";
      setError(typeof msg === "string" ? msg : "Ошибка сохранения");
      if (d.duplicate_count) setAllowDup(true);
    }
  };

  const opOptions: { id: number; full_name: string }[] = opsQ.data?.results || [];
  const partnerOptions: { id: number; name: string }[] = partnersQ.data?.results || [];

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold mb-6">Новая продажа</h1>
      <form onSubmit={onSubmit} className="card p-6 space-y-5">
        <div>
          <label className="label">IMEI (6–15 цифр)</label>
          <input
            className="input font-mono"
            value={imei}
            onChange={(e) => setImei(e.target.value.replace(/\D/g, ""))}
            minLength={6}
            maxLength={15}
            placeholder="490154203237518"
            required
          />
          {imei.length >= 6 && (
            <div className="text-xs text-gray-500 mt-1">
              {imei.length === 15 && model
                ? `→ ${model}`
                : imei.length === 15
                ? "модель не определена, заполни вручную"
                : `${imei.length} цифр (минимум 6)`}
            </div>
          )}
        </div>

        <div>
          <label className="label">Модель</label>
          <input
            className="input"
            list="phone-models-list"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Начни вводить — выпадет список. Нет в списке? Впиши свой"
            autoComplete="off"
          />
          <datalist id="phone-models-list">
            {((modelsQ.data?.results as string[]) || []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {model && !((modelsQ.data?.results as string[]) || []).includes(model) && (
            <div className="text-xs text-gray-500 mt-1">
              «{model}» — новая модель, сохранится как есть.
            </div>
          )}
        </div>

        <LineEditor
          title="Операторы"
          lines={operators}
          setLines={setOperators}
          options={opOptions.map((o) => ({ id: o.id, label: o.full_name }))}
          getId={(l) => l.operator_id}
          getName={(l) => l.operator_name || ""}
          setLine={(l, patch) => ({ ...l, ...patch })}
          empty={() => ({ amount: "" }) as OpLine}
          idKey="operator_id"
          nameKey="operator_name"
        />

        <LineEditor
          title="Партнёры"
          lines={partners}
          setLines={setPartners}
          options={partnerOptions.map((p) => ({ id: p.id, label: p.name }))}
          getId={(l) => l.partner_id}
          getName={(l) => l.partner_name || ""}
          setLine={(l, patch) => ({ ...l, ...patch })}
          empty={() => ({ amount: "" }) as PLine}
          idKey="partner_id"
          nameKey="partner_name"
        />

        <div className="flex justify-between items-baseline">
          <div className="text-sm text-gray-600">Итого по партнёрам:</div>
          <div className="text-lg font-semibold">
            {total.toLocaleString("ru-RU")} сум
          </div>
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

type LineEditorProps<L> = {
  title: string;
  lines: L[];
  setLines: (v: L[]) => void;
  options: { id: number; label: string }[];
  getId: (l: L) => number | undefined;
  getName: (l: L) => string;
  setLine: (l: L, patch: Partial<L>) => L;
  empty: () => L;
  idKey: keyof L;
  nameKey: keyof L;
};

function LineEditor<L extends { amount: string }>(props: LineEditorProps<L>) {
  const { title, lines, setLines, options, getId, getName, setLine, empty, idKey, nameKey } = props;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="label">{title}</label>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => setLines([...lines, empty()])}
        >
          <Plus className="w-3 h-3" /> добавить
        </button>
      </div>
      <div className="space-y-2">
        {lines.map((line, i) => {
          const id = getId(line);
          const name = getName(line);
          const matchedById = id ? options.find((o) => o.id === id) : null;
          return (
            <div key={i} className="flex gap-2">
              <input
                className="input flex-1"
                list={`${title}-list`}
                placeholder="Имя (выбери или впиши)"
                value={matchedById ? matchedById.label : name}
                onChange={(e) => {
                  const v = e.target.value;
                  const exact = options.find((o) => o.label.toLowerCase() === v.toLowerCase());
                  const patch: any = {};
                  if (exact) {
                    patch[idKey] = exact.id;
                    patch[nameKey] = undefined;
                  } else {
                    patch[idKey] = undefined;
                    patch[nameKey] = v;
                  }
                  const next = [...lines];
                  next[i] = setLine(line, patch);
                  setLines(next);
                }}
              />
              <datalist id={`${title}-list`}>
                {options.map((o) => (
                  <option key={o.id} value={o.label} />
                ))}
              </datalist>
              <input
                className="input w-44"
                inputMode="numeric"
                placeholder="Сумма"
                value={line.amount}
                onChange={(e) => {
                  const next = [...lines];
                  next[i] = setLine(line, { amount: e.target.value.replace(/\D/g, "") } as any);
                  setLines(next);
                }}
              />
              {lines.length > 1 && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setLines(lines.filter((_, j) => j !== i))}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="text-xs text-gray-500 mt-2">
        {lines.filter((l) => !getId(l) && getName(l).trim()).length > 0 &&
          "Новые имена добавятся автоматически при сохранении."}
      </div>
    </div>
  );
}
