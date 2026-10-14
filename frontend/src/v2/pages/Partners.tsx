import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "../../components/ui";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import { useSetPartnerCreate, useSetPartnerToggle, useSetPartners } from "../api/admin";
import { SettingsLayout } from "./Settings";

/** /partners — payment channels (Alif, Uzum, TBC, Cash…). Artboard MgPartners. */
export default function Partners() {
  const t = useT2();
  const q = useSetPartners();
  const create = useSetPartnerCreate();
  const toggle = useSetPartnerToggle();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);

  const rows = q.data ?? [];
  const active = rows.filter((r) => r.is_active).length;
  const clean = name.trim();
  const dup = clean ? rows.find((r) => r.name.trim().toLowerCase() === clean.toLowerCase()) : undefined;

  const add = () => {
    setTouched(true);
    if (!clean || dup) return;
    create.mutate(
      { name: clean, is_active: true },
      {
        onSuccess: () => {
          setName("");
          setTouched(false);
          toast.success(t("partners.added"));
        },
        onError: (e) => toast.error(apiErrorMessage(e)),
      },
    );
  };

  return (
    <>
      <PageHeader title={t("partners.title")} meta={t("v2.admin.partners.meta")} />
      <main className="page">
        <SettingsLayout maxWidth={760}>
          <section className="card col">
            <div className="card-h">
              <span className="h3">{q.data ? t("v2.admin.partners.total", { n: rows.length, m: active }) : t("partners.title")}</span>
            </div>
            {q.isLoading ? (
              <LoadingBlock rows={5} onRetry={() => q.refetch()} />
            ) : q.isError ? (
              <ErrorState error={q.error} onRetry={() => q.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState title={t("partners.empty_soft")} body={t("v2.admin.partners.emptyBody")} />
            ) : (
              rows.map((p) => {
                const pending = toggle.isPending && toggle.variables?.id === p.id;
                return (
                  <div key={p.id} className="li" style={{ minHeight: 56, opacity: p.is_active ? 1 : 0.7 }}>
                    <span className="icon-tile w7 s">{p.name.slice(0, 2)}</span>
                    <span className="col grow">
                      <span className="s w6 trunc">{p.name}</span>
                    </span>
                    <span className={cx("badge", p.is_active && "b-ok")}>{p.is_active ? t("partners.active") : t("partners.inactive")}</span>
                    <button
                      className={cx("switch", p.is_active && "is-on")}
                      type="button"
                      role="switch"
                      aria-checked={p.is_active}
                      aria-label={`${p.name}: ${p.is_active ? t("partners.disable") : t("partners.enable")}`}
                      title={p.is_active ? t("partners.disable") : t("partners.enable")}
                      disabled={pending}
                      onClick={() =>
                        toggle.mutate(
                          { id: p.id, is_active: !p.is_active },
                          {
                            onSuccess: () =>
                              toast.success(t(p.is_active ? "v2.admin.partners.toggled_off" : "v2.admin.partners.toggled_on", { name: p.name })),
                            onError: (e) => toast.error(apiErrorMessage(e)),
                          },
                        )
                      }
                    >
                      <i />
                    </button>
                  </div>
                );
              })
            )}
            <form
              className="col g8"
              style={{ padding: "14px 16px", borderTop: "1px solid var(--line)" }}
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <div className="row g8">
                <input
                  className={cx("input grow", touched && dup && "is-bad")}
                  type="text"
                  value={name}
                  placeholder={t("partners.name_ph")}
                  aria-label={t("v2.admin.partners.newName")}
                  onChange={(e) => {
                    setName(e.target.value);
                    setTouched(true);
                  }}
                />
                <button className="btn btn-pri" type="submit" disabled={!clean || !!dup || create.isPending}>
                  <Plus className="ic ic-s" />
                  {create.isPending ? t("common.saving") : t("partners.add")}
                </button>
              </div>
              {touched && dup ? <span className="err">{t("v2.admin.partners.duplicate", { name: dup.name })}</span> : null}
            </form>
          </section>
        </SettingsLayout>
      </main>
    </>
  );
}
