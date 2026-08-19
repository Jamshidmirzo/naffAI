import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { usePageHeader } from "../store/page";

type MarketingSettings = {
  id: number;
  default_tagline: string;
  phone_primary: string;
  phone_secondary: string;
  telegram_handle: string;
  address: string;
  benefits: string;
  updated_at: string;
};

export default function MarketingSettingsPage() {
  const t = useT();
  const qc = useQueryClient();
  usePageHeader(
    {
      title: t("marketing_settings.title"),
      subtitle: t("marketing_settings.subtitle"),
    },
    [t("marketing_settings.title")],
  );

  const q = useQuery({
    queryKey: ["marketing-settings"],
    queryFn: () =>
      api.get<MarketingSettings>("/catalog/marketing-settings/").then((r) => r.data),
  });

  const [form, setForm] = useState<MarketingSettings | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);

  const save = useMutation({
    mutationFn: (body: Partial<MarketingSettings>) =>
      api.patch<MarketingSettings>("/catalog/marketing-settings/", body).then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(["marketing-settings"], data);
      setForm(data);
      toast.success(t("marketing_settings.saved"));
    },
    onError: () => toast.error(t("marketing_settings.save_failed")),
  });

  if (!form) {
    return <div className="text-muted">{t("common.loading")}</div>;
  }

  const set = <K extends keyof MarketingSettings>(k: K, v: MarketingSettings[K]) =>
    setForm({ ...form, [k]: v });

  return (
    <div className="max-w-2xl space-y-4">
      <div className="nf-card p-5 space-y-4">
        <div>
          <label className="nf-col mb-1.5 block">
            {t("marketing_settings.default_tagline")}
          </label>
          <input
            className="nf-input"
            value={form.default_tagline}
            onChange={(e) => set("default_tagline", e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="nf-col mb-1.5 block">
              {t("marketing_settings.phone_primary")}
            </label>
            <input
              className="nf-input"
              value={form.phone_primary}
              onChange={(e) => set("phone_primary", e.target.value)}
              placeholder="+998 88 750 20 53"
            />
          </div>
          <div>
            <label className="nf-col mb-1.5 block">
              {t("marketing_settings.phone_secondary")}
            </label>
            <input
              className="nf-input"
              value={form.phone_secondary}
              onChange={(e) => set("phone_secondary", e.target.value)}
              placeholder="+998 88 750 20 42"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="nf-col mb-1.5 block">
              {t("marketing_settings.telegram_handle")}
            </label>
            <input
              className="nf-input"
              value={form.telegram_handle}
              onChange={(e) => set("telegram_handle", e.target.value)}
              placeholder="@naff_ss"
            />
          </div>
          <div>
            <label className="nf-col mb-1.5 block">
              {t("marketing_settings.address")}
            </label>
            <input
              className="nf-input"
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
              placeholder="Yunusobod, 11-k."
            />
          </div>
        </div>

        <div>
          <label className="nf-col mb-1.5 block">
            {t("marketing_settings.benefits")}
          </label>
          <textarea
            className="nf-input"
            rows={7}
            value={form.benefits}
            onChange={(e) => set("benefits", e.target.value)}
          />
          <div className="text-[11px] text-muted mt-1">
            {t("marketing_settings.benefits_hint")}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
          <button
            type="button"
            className="nf-btn nf-btn--primary"
            onClick={() => save.mutate(form)}
            disabled={save.isPending}
          >
            {save.isPending ? t("common.loading") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
