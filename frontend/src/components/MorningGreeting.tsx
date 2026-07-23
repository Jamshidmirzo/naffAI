import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sun } from "lucide-react";
import { api } from "../lib/api";

interface Payload {
  quote: string;
  author: string;
  language: string;
  should_show: boolean;
  generated_by_model: string;
}

interface Props {
  language?: string;
}

/**
 * Shows a one-time-per-day motivational modal for operators. It is safe to
 * mount unconditionally — the modal only opens when the API says
 * ``should_show=true``. On close, we POST to /morning-greeting/dismiss/ so
 * the flag stays flipped until the calendar date rolls.
 */
export default function MorningGreeting({ language = "ru" }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery<Payload>({
    queryKey: ["morning-greeting", language],
    queryFn: async () =>
      (await api.get<Payload>(`/me/morning-greeting/?language=${language}`)).data,
    staleTime: 60_000,
  });

  const dismiss = useMutation({
    mutationFn: () => api.post("/me/morning-greeting/dismiss/"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["morning-greeting"] }),
  });

  useEffect(() => {
    if (q.data?.should_show) setOpen(true);
  }, [q.data?.should_show]);

  if (!open || !q.data) return null;

  const onClose = () => {
    setOpen(false);
    dismiss.mutate();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 dark:from-slate-900 dark:to-slate-800 border border-amber-200/40 dark:border-slate-700 shadow-2xl p-8"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center gap-3 mb-4">
          <Sun className="w-6 h-6 text-amber-500" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">
            Доброе утро!
          </h2>
        </div>

        <blockquote className="text-lg leading-relaxed text-gray-800 dark:text-slate-100 italic border-l-4 border-amber-400 pl-4 mb-4">
          {q.data.quote}
        </blockquote>

        {q.data.author && (
          <div className="text-sm text-gray-500 dark:text-slate-400 text-right mb-6">
            — {q.data.author}
          </div>
        )}

        <button
          className="btn-primary w-full"
          onClick={onClose}
          disabled={dismiss.isPending}
        >
          Приступить
        </button>
      </div>
    </div>
  );
}
