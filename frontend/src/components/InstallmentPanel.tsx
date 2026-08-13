import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";

type InstallmentRow = {
  bank: string;
  bank_icon: string;
  term_months: number;
  monthly: string;
  total: string;
  overpay: string;
};

type QuoteResponse = {
  text: string;
  cover_image_url: string | null;
  installments: InstallmentRow[];
};

function fmtMoney(v: string | number): string {
  const n = Math.round(Number(v || 0));
  return n.toLocaleString("ru-RU").replace(/,/g, " ");
}

/**
 * Lazy-fetched installment matrix for a single phone card.
 *
 * Renders a compact "Рассрочка ▾" toggle under the phone price. First open
 * fires GET /catalog/phones/{id}/quote/ (react-query caches the result, so
 * re-opening does not re-fetch). Matrix: rows = banks, columns = term_months,
 * cells = monthly payment.
 */
export default function InstallmentPanel({ phoneId }: { phoneId: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const quote = useQuery({
    queryKey: ["catalog-phone-quote", phoneId],
    queryFn: () =>
      api
        .get<QuoteResponse>(`/catalog/phones/${phoneId}/quote/?lang=ru`)
        .then((r) => r.data),
    enabled: open,
    staleTime: 60_000,
  });

  const matrix = useMemo(() => {
    const rows = quote.data?.installments ?? [];
    const banks = Array.from(new Set(rows.map((r) => r.bank)));
    const terms = Array.from(new Set(rows.map((r) => r.term_months))).sort(
      (a, b) => a - b,
    );
    const byBank = new Map<string, Map<number, InstallmentRow>>();
    for (const r of rows) {
      if (!byBank.has(r.bank)) byBank.set(r.bank, new Map());
      byBank.get(r.bank)!.set(r.term_months, r);
    }
    const iconByBank = new Map<string, string>();
    for (const r of rows) iconByBank.set(r.bank, r.bank_icon);
    return { banks, terms, byBank, iconByBank };
  }, [quote.data]);

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg transition"
      >
        {t("catalog.installment")}
        {open ? (
          <ChevronUp className="w-3.5 h-3.5" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5" />
        )}
      </button>

      {open && (
        <div className="mt-2 animate-nfFade">
          {quote.isLoading && (
            <div className="text-[12px] text-muted py-2">
              {t("common.loading")}
            </div>
          )}
          {quote.isError && (
            <div className="text-[12px] text-red-500 py-2">
              {t("catalog.installment_failed")}
            </div>
          )}
          {quote.data && matrix.banks.length === 0 && (
            <div className="text-[12px] text-muted py-2">
              {t("catalog.installment_empty")}
            </div>
          )}
          {quote.data && matrix.banks.length > 0 && (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-[12px]">
                <thead className="text-[10.5px] uppercase text-muted">
                  <tr>
                    <th className="text-left font-normal py-1 pr-2">
                      {t("catalog.installment_bank")}
                    </th>
                    {matrix.terms.map((term) => (
                      <th
                        key={term}
                        className="text-right font-normal py-1 px-1 whitespace-nowrap"
                      >
                        {term} {t("catalog.months")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.banks.map((bank) => (
                    <tr
                      key={bank}
                      className="border-t border-[var(--border-row)]"
                    >
                      <td className="py-1.5 pr-2 truncate">
                        {matrix.iconByBank.get(bank)} {bank}
                      </td>
                      {matrix.terms.map((term) => {
                        const cell = matrix.byBank.get(bank)?.get(term);
                        return (
                          <td
                            key={term}
                            className="py-1.5 px-1 text-right tabular-nums whitespace-nowrap"
                          >
                            {cell ? (
                              <span title={`${t("catalog.installment_overpay")}: +${fmtMoney(cell.overpay)}`}>
                                {fmtMoney(cell.monthly)}
                                <span className="text-muted text-[10.5px]">
                                  {" "}
                                  {t("catalog.per_month")}
                                </span>
                              </span>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
