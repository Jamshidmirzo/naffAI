import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { api } from "../lib/api";
import { Toggle, toast } from "../components/ui";
import { apiErrorMessage } from "../lib/api-types";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface DistributionSettings {
  auto_distribution_enabled: boolean;
  updated_at: string | null;
  updated_by: { id: number; full_name: string } | null;
}

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export default function Settings() {
  const t = useT();
  usePageHeader(
    { title: t("settings.title"), subtitle: t("settings.subtitle") },
    ["settings"],
  );
  const qc = useQueryClient();

  const settingsQ = useQuery<DistributionSettings>({
    queryKey: ["settings", "distribution"],
    queryFn: () =>
      api.get<DistributionSettings>("/settings/distribution/").then((r) => r.data),
  });

  const patchMut = useMutation({
    mutationFn: (value: boolean) =>
      api
        .patch<DistributionSettings>("/settings/distribution/", {
          auto_distribution_enabled: value,
        })
        .then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(["settings", "distribution"], data);
      qc.invalidateQueries({ queryKey: ["settings", "distribution"] });
      toast.success(
        data.auto_distribution_enabled
          ? t("settings.auto_distribution.enabled_toast")
          : t("settings.auto_distribution.disabled_toast"),
      );
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const data = settingsQ.data;

  return (
    <div className="mx-auto max-w-[820px] flex flex-col gap-5">
      <section className="nf-card p-7 animate-nfFadeUp">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-tight">
              {t("settings.auto_distribution.title")}
            </div>
            <p className="text-[13px] text-muted mt-1.5 leading-relaxed">
              {t("settings.auto_distribution.hint")}
            </p>
            {data && (
              <div className="text-[11.5px] text-muted mt-3">
                {data.updated_by
                  ? t("settings.updated_with_user", {
                      date: fmtDateTime(data.updated_at),
                      name: data.updated_by.full_name,
                    })
                  : t("settings.updated_no_user", {
                      date: fmtDateTime(data.updated_at),
                    })}
              </div>
            )}
          </div>
          <div className="shrink-0 pt-1">
            <Toggle
              on={!!data?.auto_distribution_enabled}
              onChange={(v) => patchMut.mutate(v)}
              disabled={settingsQ.isLoading || patchMut.isPending}
              aria-label={t("settings.auto_distribution.aria")}
            />
          </div>
        </div>

        {data && !data.auto_distribution_enabled && (
          <div
            className="mt-5 flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-[12.5px]"
            style={{
              background: "rgba(220,60,40,.08)",
              color: "var(--danger)",
              border: "1px solid rgba(220,60,40,.2)",
            }}
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>{t("settings.disabled_warning")}</div>
          </div>
        )}
      </section>
    </div>
  );
}
