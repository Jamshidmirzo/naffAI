import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { SingleSelectCombobox } from "../components/SingleSelectCombobox";

type OpLine = { operator_id?: number; operator_name?: string; amount: string };
type PLine = { partner_id?: number; partner_name?: string; amount: string };

export default function SaleCreate() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();

  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [operators, setOperators] = useState<OpLine[]>([{ amount: "" }]);
  const [partners, setPartners] = useState<PLine[]>([{ amount: "" }]);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [allowDup, setAllowDup] = useState(false);
  const [dupComment, setDupComment] = useState("");
  const [loaded, setLoaded] = useState(false);

  const saleQ = useQuery({
    queryKey: ["sale", id],
    queryFn: () => api.get(`/sales/${id}/`).then((r) => r.data),
    enabled: isEdit,
  });

  useEffect(() => {
    if (isEdit && saleQ.data && !loaded) {
      const s = saleQ.data;
      setImei(s.imei || "");
      setModel(s.phone_model || "");
      setClientName(s.client_name || "");
      setClientPhone(s.client_phone || "");
      setComment(s.comment || "");
      if (s.operator_lines?.length) {
        setOperators(
          s.operator_lines.map((l: any) => ({
            operator_id: l.operator,
            amount: String(Math.round(Number(l.amount))),
          }))
        );
      }
      if (s.partner_lines?.length) {
        setPartners(
          s.partner_lines.map((l: any) => ({
            partner_id: l.partner,
            amount: String(Math.round(Number(l.amount))),
          }))
        );
      }
      setLoaded(true);
    }
  }, [isEdit, saleQ.data, loaded]);

  const opsQ = useQuery({
    queryKey: ["operators-list-all"],
    queryFn: () => api.get("/operators/?limit=200").then((r) => r.data),
  });
  const partnersQ = useQuery({
    queryKey: ["partners-list-all"],
    queryFn: () => api.get("/channels/?limit=200").then((r) => r.data),
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
    if (!isEdit && imei.length >= 6 && /^\d+$/.test(imei) && imei.length === 15) {
      api
        .get(`/imei/${imei}/lookup/`)
        .then((r) => {
          if (r.data.brand || r.data.model) {
            setModel(`${r.data.brand} ${r.data.model}`.trim());
          }
        })
        .catch(() => {});
    }
  }, [imei, isEdit]);

  const opTotal = useMemo(
    () => operators.reduce((s, o) => s + (Number(o.amount) || 0), 0),
    [operators],
  );
  const partnerTotal = useMemo(
    () => partners.reduce((s, p) => s + (Number(p.amount) || 0), 0),
    [partners],
  );
  const mismatch = opTotal > 0 && partnerTotal > 0 && opTotal !== partnerTotal;
  const total = partnerTotal;

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
    if (operators.some((o) => (o.operator_id || o.operator_name?.trim()) && !(Number(o.amount) > 0))) {
      setError("У всех операторов должна быть положительная сумма");
      return;
    }
    if (partners.some((p) => (p.partner_id || p.partner_name?.trim()) && !(Number(p.amount) > 0))) {
      setError("У всех партнёров должна быть положительная сумма");
      return;
    }
    if ([...operators, ...partners].some((l) => Number(l.amount) > 0 && Number(l.amount) < 1000)) {
      setError("Минимальная сумма по строке — 1 000 сум");
      return;
    }
    if (mismatch) {
      setError(
        `Сумма по операторам (${opTotal.toLocaleString("ru-RU")}) ≠ ` +
          `сумма по партнёрам (${partnerTotal.toLocaleString("ru-RU")})`,
      );
      return;
    }

    const body = {
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
      client_name: clientName.trim(),
      client_phone: clientPhone.trim(),
      comment,
      allow_duplicate_imei: allowDup,
      duplicate_override_comment: dupComment,
    };

    try {
      if (isEdit) {
        await api.put(`/sales/${id}/`, body);
        qc.invalidateQueries({ queryKey: ["sale", id] });
        qc.invalidateQueries({ queryKey: ["sales"] });
        nav(`/sales/${id}`);
      } else {
        await api.post("/sales/", body);
        nav("/sales");
      }
    } catch (err: any) {
      const d = err.response?.data || {};
      const msg = d.detail || d.imei?.[0] || d.amount?.[0] || "Ошибка сохранения";
      setError(typeof msg === "string" ? msg : "Ошибка сохранения");
      if (d.duplicate_count) setAllowDup(true);
    }
  };

  const opOptions: { id: number; full_name: string; status?: string }[] = opsQ.data?.results || [];
  const partnerOptions: { id: number; name: string; is_active?: boolean }[] = partnersQ.data?.results || [];

  if (isEdit && saleQ.isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500 dark:text-slate-400">
        Загрузка…
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold mb-6">
        {isEdit ? "Редактировать продажу" : "Новая продажа"}
      </h1>
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
            <div className="text-xs text-gray-500 dark:text-slate-400 mt-1">
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
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Имя клиента</label>
            <input
              className="input"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Иванов Иван"
            />
          </div>
          <div>
            <label className="label">Телефон клиента</label>
            <input
              className="input"
              value={clientPhone}
              onChange={(e) => setClientPhone(e.target.value)}
              placeholder="+998 90 123 45 67"
            />
          </div>
        </div>

        <LineEditor
          title="Операторы"
          lines={operators}
          setLines={setOperators}
          options={opOptions.map((o) => ({
            id: o.id,
            label: o.full_name,
            isActive: o.status !== "inactive",
          }))}
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
          options={partnerOptions.map((p) => ({
            id: p.id,
            label: p.name,
            isActive: p.is_active !== false,
          }))}
          getId={(l) => l.partner_id}
          getName={(l) => l.partner_name || ""}
          setLine={(l, patch) => ({ ...l, ...patch })}
          empty={() => ({ amount: "" }) as PLine}
          idKey="partner_id"
          nameKey="partner_name"
        />

        <div
          className={`rounded-lg border p-3 text-sm ${
            mismatch
              ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700/40"
              : "bg-gray-50 dark:bg-slate-800/40 border-gray-200 dark:border-slate-700"
          }`}
        >
          <div className="flex justify-between">
            <span className="text-gray-600 dark:text-slate-400">Сумма по операторам:</span>
            <span className="font-medium">{opTotal.toLocaleString("ru-RU")} сум</span>
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-gray-600 dark:text-slate-400">Сумма по партнёрам:</span>
            <span className="font-medium">{partnerTotal.toLocaleString("ru-RU")} сум</span>
          </div>
          {mismatch && (
            <div className="mt-2 text-xs text-amber-800 dark:text-amber-300">
              Суммы не совпадают на {Math.abs(opTotal - partnerTotal).toLocaleString("ru-RU")} сум.
              Проверьте строки.
            </div>
          )}
          <div className="border-t border-gray-200 dark:border-slate-700 mt-2 pt-2 flex justify-between">
            <span className="text-gray-700 dark:text-slate-300 font-medium">Итого продажи:</span>
            <span className="text-lg font-semibold">{total.toLocaleString("ru-RU")} сум</span>
          </div>
        </div>

        <div>
          <label className="label">Комментарий</label>
          <textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>

        {allowDup && (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 p-3 space-y-2">
            <div className="text-sm text-amber-800 dark:text-amber-300">
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

        {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={() => nav(-1)}>
            Отмена
          </button>
          <button className="btn-primary" type="submit">
            {isEdit ? "Сохранить изменения" : "Сохранить"}
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
  options: { id: number; label: string; isActive?: boolean }[];
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
          const value: number | string | null = id ?? (name.trim() ? name : null);
          return (
            <div key={i} className="flex gap-2 items-start">
              <div className="flex-1 min-w-0">
                <SingleSelectCombobox
                  options={options}
                  value={value}
                  allowFreeText
                  placeholder="Выбрать или ввести имя…"
                  onChange={(next) => {
                    const patch: any = {};
                    if (typeof next === "number") {
                      patch[idKey] = next;
                      patch[nameKey] = undefined;
                    } else {
                      patch[idKey] = undefined;
                      patch[nameKey] = next;
                    }
                    const arr = [...lines];
                    arr[i] = setLine(line, patch);
                    setLines(arr);
                  }}
                />
              </div>
              {(() => {
                const hasName = !!(id || name.trim());
                const amt = Number(line.amount);
                const invalid = hasName && (line.amount === "" || amt < 1000);
                return (
                  <div className="w-48 flex-shrink-0">
                    <input
                      className={`input ${invalid ? "is-invalid" : ""}`}
                      inputMode="numeric"
                      placeholder="Сумма"
                      value={line.amount}
                      onChange={(e) => {
                        const next = [...lines];
                        next[i] = setLine(line, { amount: e.target.value.replace(/\D/g, "") } as any);
                        setLines(next);
                      }}
                    />
                    {line.amount && amt > 0 && (
                      <div className="text-[10px] text-gray-500 dark:text-slate-500 mt-0.5 text-right">
                        ≈ {amt.toLocaleString("ru-RU")}
                      </div>
                    )}
                    {invalid && line.amount !== "" && (
                      <div className="text-[10px] text-red-600 dark:text-red-400 mt-0.5 text-right">
                        мин 1 000
                      </div>
                    )}
                  </div>
                );
              })()}
              {lines.length > 1 && (
                <button
                  type="button"
                  className="btn-ghost flex-shrink-0"
                  onClick={() => setLines(lines.filter((_, j) => j !== i))}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="text-xs text-gray-500 dark:text-slate-400 mt-2">
        {lines.filter((l) => !getId(l) && getName(l).trim()).length > 0 &&
          "Новые имена добавятся автоматически при сохранении."}
      </div>
    </div>
  );
}
