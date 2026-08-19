import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { formatUZS } from "../lib/format";
import { usePageHeader } from "../store/page";
import NumericInput from "../components/NumericInput";
import {
  SingleSelectCombobox,
  type ComboboxOption,
} from "../components/SingleSelectCombobox";
import type { Phone } from "./Catalog";

type CalcTierRow = {
  tier_id: number;
  months: number;
  commission_pct: string;
  ariza_narxi: string;
  komissiya_sum: string;
  total: string;
  sum_per_month: string;
  show_in_marketing: boolean;
};

type CalcResponse = {
  amount: string;
  down_payment: string;
  ariza: string;
  tiers: CalcTierRow[];
  phone?: {
    id: number;
    brand: string;
    model_name: string;
    price: string;
  };
};

function useDebounced<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export default function Calculator() {
  const t = useT();
  usePageHeader(
    { title: t("calculator.title"), subtitle: t("calculator.subtitle") },
    [t("calculator.title")],
  );

  const [phoneQuery, setPhoneQuery] = useState("");
  const [phoneId, setPhoneId] = useState<number | null>(null);
  const [amountRaw, setAmountRaw] = useState<string>("");
  const [downRaw, setDownRaw] = useState<string>("");
  const [selectedTierId, setSelectedTierId] = useState<number | null>(null);

  // Phone search suggestions (combobox options).
  const phonesQuery = useQuery({
    queryKey: ["calc-phones", phoneQuery],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (phoneQuery) params.set("search", phoneQuery);
      params.set("only_active", "1");
      const r = await api.get<{ results?: Phone[] } | Phone[]>(
        `/catalog/phones/?${params}`,
      );
      const d: any = r.data;
      return (d.results || d) as Phone[];
    },
    staleTime: 15_000,
  });

  const options: ComboboxOption[] = useMemo(() => {
    const list = phonesQuery.data || [];
    return list.map((p) => ({
      id: p.id,
      label: `${p.brand} ${p.model_name}${
        p.storage_gb ? ` · ${p.storage_gb}GB` : ""
      } — ${formatUZS(p.price)}`,
      isActive: p.is_active,
    }));
  }, [phonesQuery.data]);

  const selectedPhone = useMemo(
    () => phonesQuery.data?.find((p) => p.id === phoneId) || null,
    [phonesQuery.data, phoneId],
  );

  // When a phone is picked, seed the amount field with its price (once —
  // subsequent edits by the operator stick until they pick another phone).
  useEffect(() => {
    if (selectedPhone) {
      setAmountRaw(String(Math.round(Number(selectedPhone.price))));
    }
  }, [selectedPhone]);

  // Debounce the calc trigger so keystrokes don't hammer the API.
  const debouncedAmount = useDebounced(amountRaw, 250);
  const debouncedDown = useDebounced(downRaw, 250);
  const debouncedPhoneId = useDebounced(phoneId, 250);

  const calc = useQuery({
    queryKey: ["calculator", debouncedAmount, debouncedDown, debouncedPhoneId],
    queryFn: async () => {
      const r = await api.post<CalcResponse>("/catalog/calculate/", {
        amount: debouncedAmount || "0",
        down_payment: debouncedDown || "0",
        phone_id: debouncedPhoneId ?? undefined,
      });
      return r.data;
    },
    // Fires even when both inputs are empty — server returns zero-rows.
  });

  const tiers = calc.data?.tiers || [];
  const arizaFmt = formatUZS(calc.data?.ariza || "0");

  const copyCalc = async () => {
    if (!calc.data || tiers.length === 0) return;
    const tier = selectedTierId
      ? tiers.find((r) => r.tier_id === selectedTierId)
      : null;
    const header = selectedPhone
      ? `${selectedPhone.brand} ${selectedPhone.model_name}`
      : t("calculator.title");
    const parts: string[] = [];
    parts.push(`📊 ${header}`);
    parts.push(
      `${t("calculator.ariza")}: ${formatUZS(calc.data.ariza)}`,
    );
    if (tier) {
      parts.push("");
      parts.push(
        `🔹 ${tier.months} ${t("calculator.months_label")} · ${tier.commission_pct}% → ${formatUZS(
          tier.sum_per_month,
        )} ${t("calculator.sum_per_month_label")}`,
      );
      parts.push(
        `${t("calculator.muttadli_total")}: ${formatUZS(tier.total)}`,
      );
    } else {
      for (const row of tiers) {
        parts.push(
          `• ${row.months} ${t("calculator.months_label")} · ${row.commission_pct}% → ${formatUZS(
            row.sum_per_month,
          )}`,
        );
      }
    }
    try {
      await navigator.clipboard.writeText(parts.join("\n"));
      toast.success(t("calculator.copied"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    }
  };

  return (
    <div className="max-w-6xl space-y-6">
      {/* Inputs row */}
      <div className="nf-card p-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="nf-col mb-1.5 block">
              {t("calculator.product_placeholder")}
            </label>
            <SingleSelectCombobox
              options={options}
              value={phoneId}
              onChange={(next: number | string) => {
                if (typeof next === "number") {
                  setPhoneId(next);
                } else {
                  setPhoneId(null);
                  setPhoneQuery(next);
                }
              }}
              placeholder={t("calculator.product_placeholder")}
              allowFreeText
              searchThreshold={1}
            />
          </div>
          <div>
            <label className="nf-col mb-1.5 block">
              {t("calculator.amount_label")}
            </label>
            <NumericInput
              className="nf-input"
              value={amountRaw}
              onChange={setAmountRaw}
              placeholder={t("calculator.amount_ph")}
            />
          </div>
          <div>
            <label className="nf-col mb-1.5 block">
              {t("calculator.down_payment_label")}
            </label>
            <NumericInput
              className="nf-input"
              value={downRaw}
              onChange={setDownRaw}
              placeholder={t("calculator.down_payment_ph")}
            />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="text-[13px] text-muted">
            {t("calculator.ariza")}:{" "}
            <span className="text-[16px] font-semibold tabular-nums text-[color:var(--text)]">
              {arizaFmt}
            </span>
          </div>
          <button
            type="button"
            className="nf-btn nf-btn--secondary"
            onClick={copyCalc}
            disabled={tiers.length === 0}
          >
            <Copy className="w-4 h-4" /> {t("calculator.copy_computation")}
          </button>
        </div>
      </div>

      {/* Tier cards */}
      {tiers.length === 0 && !calc.isLoading && (
        <div className="nf-card p-8 text-center text-muted text-[13px]">
          {t("calculator.empty_tiers")}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiers.map((row) => {
          const selected = selectedTierId === row.tier_id;
          return (
            <button
              key={row.tier_id}
              type="button"
              onClick={() =>
                setSelectedTierId((cur) => (cur === row.tier_id ? null : row.tier_id))
              }
              className={`nf-card p-5 text-left transition ${
                selected
                  ? "ring-2 ring-[var(--accent)]"
                  : "hover:border-[var(--accent)]"
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted">
                    {t("catalog.months")}
                  </div>
                  <div className="text-[28px] font-semibold leading-none">
                    {row.months}
                  </div>
                </div>
                <span
                  className={`w-5 h-5 rounded-full border-2 flex-shrink-0 mt-1 ${
                    selected
                      ? "border-[var(--accent)] bg-[var(--accent)]"
                      : "border-[var(--border)]"
                  }`}
                  aria-hidden
                />
              </div>

              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  {t("calculator.sum_per_month_label")}
                </div>
                <div className="text-[20px] font-semibold tabular-nums text-[color:var(--accent)]">
                  {formatUZS(row.sum_per_month)}
                </div>
              </div>

              <div className="mt-3 space-y-1 text-[12.5px]">
                <div className="flex justify-between">
                  <span className="text-muted">{t("calculator.ariza")}</span>
                  <span className="tabular-nums">
                    {formatUZS(row.ariza_narxi)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">
                    {t("calculator.komissiya")} {row.commission_pct}%
                  </span>
                  <span className="tabular-nums">
                    {formatUZS(row.komissiya_sum)}
                  </span>
                </div>
                <div className="flex justify-between border-t border-[var(--border)] pt-1 mt-1">
                  <span className="text-muted">
                    {t("calculator.muttadli_total")}
                  </span>
                  <span className="tabular-nums font-medium">
                    {formatUZS(row.total)}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {phoneId === null && !amountRaw && (
        <div className="text-center text-muted text-[12px]">
          {t("calculator.pick_or_type")}
        </div>
      )}
    </div>
  );
}
