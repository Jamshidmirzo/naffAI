import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { api } from "../../lib/api";
import { Button, Checkbox, Chip, Modal, toast } from "../ui";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: (id: number) => void;
  editingId?: number | string;
}

interface OperatorOpt {
  id: number;
  full_name: string;
  status?: string;
}

interface ChannelOpt {
  id: number;
  name: string;
}

interface OpLine {
  operator_id: number;
  amount: string; // percent
}

interface LookupResult {
  brand?: string;
  model?: string;
  duplicate?: boolean;
}

/**
 * Luhn check on a 15-digit IMEI (final digit is the check digit).
 */
function isLuhnValid(imei: string): boolean {
  if (!/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let n = imei.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

type ImeiState =
  | { kind: "empty" }
  | { kind: "typing"; left: number }
  | { kind: "invalid" }
  | { kind: "valid_tac" }
  | { kind: "valid_no_tac" };

function computeImeiState(imei: string, tacFound: boolean): ImeiState {
  if (imei.length === 0) return { kind: "empty" };
  if (imei.length < 15) return { kind: "typing", left: 15 - imei.length };
  if (!isLuhnValid(imei)) return { kind: "invalid" };
  return tacFound ? { kind: "valid_tac" } : { kind: "valid_no_tac" };
}

const IMEI_HINT: Record<ImeiState["kind"], (s: ImeiState) => string> = {
  empty: () => "Введите 15 цифр — модель подставится автоматически",
  typing: (s) =>
    s.kind === "typing" ? `Осталось ${s.left} ${plural(s.left)}` : "",
  invalid: () => "Неверный IMEI — не проходит проверку Луна",
  valid_tac: () => "IMEI валиден · TAC найден",
  valid_no_tac: () => "IMEI валиден · TAC неизвестен, укажите модель",
};

function plural(n: number) {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return "цифр";
  if (n1 > 1 && n1 < 5) return "цифры";
  if (n1 === 1) return "цифра";
  return "цифр";
}

export function SalesFormModal({ open, onClose, onSaved, editingId }: Props) {
  const qc = useQueryClient();
  const isEdit = !!editingId;

  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [amount, setAmount] = useState("");
  const [channelId, setChannelId] = useState<number | null>(null);
  const [operators, setOperators] = useState<OpLine[]>([]);
  const [comment, setComment] = useState("");
  const [gifts, setGifts] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const opsQ = useQuery<{ results?: OperatorOpt[] } | OperatorOpt[]>({
    queryKey: ["ops-for-sale-modal"],
    queryFn: () => api.get("/operators/?limit=200").then((r) => r.data),
    enabled: open,
  });
  const chansQ = useQuery<{ results?: ChannelOpt[] } | ChannelOpt[]>({
    queryKey: ["channels-for-sale-modal"],
    queryFn: () => api.get("/channels/?limit=200").then((r) => r.data),
    enabled: open,
  });
  const opOptions: OperatorOpt[] = useMemo(() => {
    const d = opsQ.data;
    return d ? (Array.isArray(d) ? d : d.results ?? []) : [];
  }, [opsQ.data]);
  const chanOptions: ChannelOpt[] = useMemo(() => {
    const d = chansQ.data;
    return d ? (Array.isArray(d) ? d : d.results ?? []) : [];
  }, [chansQ.data]);

  const editQ = useQuery({
    queryKey: ["sale-edit", editingId],
    queryFn: () => api.get(`/sales/${editingId}/`).then((r) => r.data),
    enabled: open && isEdit,
  });

  useEffect(() => {
    if (!open) return;
    if (!isEdit) {
      setImei("");
      setModel("");
      setAmount("");
      setChannelId(null);
      setOperators([]);
      setComment("");
      setGifts("");
      setDuplicate(false);
      setError("");
      return;
    }
    const s = editQ.data;
    if (!s) return;
    setImei(s.imei || "");
    setModel(s.phone_model || "");
    setAmount(String(Math.round(Number(s.amount) || 0)));
    setChannelId(s.channel ?? null);
    const total = Number(s.amount) || 0;
    if (s.operator_lines?.length && total > 0) {
      setOperators(
        s.operator_lines.map((l: { operator: number; amount: string | number }) => ({
          operator_id: l.operator,
          amount: String(Math.round((Number(l.amount) / total) * 100)),
        })),
      );
    }
    setComment(s.comment || "");
    setGifts(
      Array.isArray(s.gifts) && s.gifts.length > 0
        ? s.gifts.map((g: { name: string }) => g.name).join(", ")
        : "",
    );
  }, [open, isEdit, editQ.data]);

  // IMEI lookup — debounced on 15 digits.
  const [tacInfo, setTacInfo] = useState<LookupResult | null>(null);
  useEffect(() => {
    if (!open) return;
    if (imei.length !== 15 || !isLuhnValid(imei)) {
      setTacInfo(null);
      setDuplicate(false);
      return;
    }
    let cancelled = false;
    api
      .get<LookupResult>(`/imei/${imei}/lookup/`)
      .then((r) => {
        if (cancelled) return;
        setTacInfo(r.data);
        setDuplicate(!!r.data.duplicate);
        if (!isEdit && !model && (r.data.brand || r.data.model)) {
          setModel(`${r.data.brand ?? ""} ${r.data.model ?? ""}`.trim());
        }
      })
      .catch(() => {
        if (!cancelled) setTacInfo({});
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imei, open]);

  const imeiState = computeImeiState(
    imei,
    !!(tacInfo && (tacInfo.brand || tacInfo.model)),
  );
  const imeiHint = IMEI_HINT[imeiState.kind](imeiState);
  const imeiInvalid = imeiState.kind === "invalid";
  const imeiValid = imeiState.kind === "valid_tac" || imeiState.kind === "valid_no_tac";

  const splitTotal = operators.reduce((s, o) => s + (Number(o.amount) || 0), 0);
  const splitComplete = splitTotal === 100;
  const amountNum = Number(amount) || 0;
  const canSave =
    imeiValid &&
    !!model.trim() &&
    amountNum > 0 &&
    splitComplete &&
    operators.length > 0;

  const toggleOperator = (opId: number) => {
    setOperators((prev) => {
      const found = prev.find((p) => p.operator_id === opId);
      if (found) return prev.filter((p) => p.operator_id !== opId);
      const suggested =
        prev.length === 0 ? "100" : Math.max(0, 100 - splitTotal).toString();
      return [...prev, { operator_id: opId, amount: suggested }];
    });
  };

  const setOperatorPct = (opId: number, value: string) => {
    setOperators((prev) =>
      prev.map((p) =>
        p.operator_id === opId
          ? { ...p, amount: value.replace(/\D/g, "").slice(0, 3) }
          : p,
      ),
    );
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      // Convert percent split → absolute sum per operator.
      const opsPayload = operators.map((o) => ({
        operator_id: o.operator_id,
        amount: ((amountNum * Number(o.amount)) / 100).toFixed(2),
      }));
      const partnersPayload = channelId
        ? [{ partner_id: channelId, amount: amountNum.toFixed(2) }]
        : [];
      const body = {
        imei,
        phone_model: model.trim(),
        quantity: 1,
        operators: opsPayload,
        partners: partnersPayload,
        discount: "0.00",
        client_name: "",
        client_phone: "",
        comment: [comment.trim(), gifts.trim() && `Подарки: ${gifts.trim()}`]
          .filter(Boolean)
          .join("\n"),
        allow_duplicate_imei: duplicate,
        duplicate_override_comment: duplicate ? "подтверждено из модалки" : "",
      };
      let saved;
      if (isEdit && editingId) {
        const r = await api.put(`/sales/${editingId}/`, body);
        saved = r.data;
      } else {
        const r = await api.post("/sales/", body);
        saved = r.data;
      }
      qc.invalidateQueries({ queryKey: ["sales"] });
      qc.invalidateQueries({ queryKey: ["sale", String(editingId)] });
      qc.invalidateQueries({ queryKey: ["recent-sales-dash"] });
      qc.invalidateQueries({ queryKey: ["kpi-dash"] });
      toast.success("Продажа сохранена");
      onSaved?.(saved.id);
      onClose();
    } catch (err: unknown) {
      const anyErr = err as { response?: { data?: { detail?: string } } };
      setError(anyErr.response?.data?.detail || "Не удалось сохранить продажу");
    } finally {
      setSaving(false);
    }
  };

  const imeiBorder = imeiInvalid
    ? "rgba(220,60,40,.6)"
    : imeiValid
    ? "var(--accent)"
    : "var(--border)";

  return (
    <Modal open={open} onClose={onClose} width={560}>
      <form onSubmit={onSubmit} className="p-7">
        <div className="text-[18px] font-semibold tracking-tight">
          {isEdit ? "Редактировать продажу" : "Новая продажа"}
        </div>
        <div className="text-[12.5px] text-muted mt-1">
          IMEI + модель + сумма + сплит по операторам
        </div>

        <div className="mt-6 flex flex-col gap-4">
          {/* IMEI */}
          <div>
            <div className="nf-col mb-1.5">IMEI</div>
            <input
              className="nf-input font-mono"
              value={imei}
              onChange={(e) => setImei(e.target.value.replace(/\D/g, "").slice(0, 15))}
              placeholder="15 цифр"
              inputMode="numeric"
              style={{ borderColor: imeiBorder }}
              autoFocus={!isEdit}
            />
            <div
              className="text-[11.5px] mt-1.5"
              style={{
                color: imeiInvalid ? "var(--danger)" : "var(--muted)",
              }}
            >
              {imeiHint}
            </div>
          </div>

          {duplicate && (
            <div
              className="text-[13px] rounded-xl px-3.5 py-2.5 flex items-start gap-2"
              style={{
                background: "rgba(242,86,11,.1)",
                color: "var(--accent)",
                border: "1px solid rgba(242,86,11,.25)",
              }}
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Этот IMEI уже встречался. Проверьте перед сохранением — при
                отправке будет запись «дубликат подтверждён».
              </span>
            </div>
          )}

          {/* Model */}
          <div>
            <div className="nf-col mb-1.5">Модель</div>
            <input
              className="nf-input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Apple iPhone 15 Pro"
            />
          </div>

          {/* Amount */}
          <div>
            <div className="nf-col mb-1.5">Сумма</div>
            <input
              className="nf-input tabular-nums"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              placeholder="12 500 000"
            />
          </div>

          {/* Channel */}
          <div>
            <div className="nf-col mb-1.5">Канал</div>
            <div className="flex flex-wrap gap-2">
              {chanOptions.length === 0 && (
                <div className="text-[12.5px] text-muted">Каналы загружаются…</div>
              )}
              {chanOptions.map((c) => (
                <Chip
                  key={c.id}
                  active={channelId === c.id}
                  onClick={() => setChannelId(c.id === channelId ? null : c.id)}
                >
                  {c.name}
                </Chip>
              ))}
            </div>
          </div>

          {/* Operators + split */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="nf-col">Операторы и сплит</div>
              <div
                className="text-[12px] font-semibold tabular-nums"
                style={{
                  color: splitComplete
                    ? "var(--accent)"
                    : splitTotal > 0
                    ? "var(--danger)"
                    : "var(--muted)",
                }}
              >
                {splitTotal}% из 100%
              </div>
            </div>
            <div
              className="rounded-2xl overflow-hidden"
              style={{
                background: "var(--surface2)",
                border: "1px solid var(--border)",
                maxHeight: 220,
                overflowY: "auto",
              }}
            >
              {opOptions.length === 0 && (
                <div className="text-[12.5px] text-muted text-center py-6">
                  Операторы загружаются…
                </div>
              )}
              {opOptions.map((op) => {
                const line = operators.find((o) => o.operator_id === op.id);
                const checked = !!line;
                return (
                  <div
                    key={op.id}
                    className="flex items-center gap-3 px-4 py-2.5"
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <Checkbox
                      checked={checked}
                      onChange={() => toggleOperator(op.id)}
                    />
                    <div
                      className="flex-1 text-[13.5px] cursor-pointer"
                      onClick={() => toggleOperator(op.id)}
                    >
                      {op.full_name}
                    </div>
                    <div className="flex items-center gap-1">
                      <input
                        className="nf-input tabular-nums text-right"
                        style={{ width: 68, padding: "6px 8px", fontSize: 13 }}
                        disabled={!checked}
                        value={line?.amount ?? ""}
                        onChange={(e) => setOperatorPct(op.id, e.target.value)}
                      />
                      <span className="text-[12px] text-muted">%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Comment */}
          <div>
            <div className="nf-col mb-1.5">Комментарий</div>
            <textarea
              className="nf-input min-h-[70px]"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Например: клиент рассчитался наличными"
            />
          </div>

          {/* Gifts */}
          <div>
            <div className="nf-col mb-1.5">Подарки</div>
            <textarea
              className="nf-input min-h-[50px]"
              value={gifts}
              onChange={(e) => setGifts(e.target.value)}
              placeholder="Чехол, защитное стекло…"
            />
          </div>

          {error && (
            <div
              className="text-[13px] rounded-xl px-3.5 py-2.5"
              style={{
                background: "rgba(220,60,40,.08)",
                color: "var(--danger)",
                border: "1px solid rgba(220,60,40,.2)",
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div className="mt-7 flex gap-2 justify-end">
          <Button variant="ghost" type="button" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={!canSave || saving}>
            {saving ? "Сохраняем…" : "Сохранить продажу"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
