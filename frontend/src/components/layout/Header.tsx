import { useNavigate } from "react-router-dom";
import { ArrowLeft, Moon, Sun } from "lucide-react";
import { useTheme } from "../../store/theme";
import { useLang } from "../../store/lang";
import { usePageStore } from "../../store/page";
import { useT } from "../../lib/i18n";

export function Header() {
  const nav = useNavigate();
  const theme = useTheme();
  const lang = useLang();
  const t = useT();
  const { title, subtitle, back } = usePageStore();

  const onBack = () => {
    if (!back) return;
    if (typeof back === "function") back();
    else nav(back);
  };

  return (
    <header
      className="sticky top-0 z-30 flex items-center justify-between"
      style={{
        padding: "16px 40px",
        borderBottom: "1px solid var(--border)",
        background: "color-mix(in oklab, var(--bg) 82%, transparent)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {back && (
          <button
            onClick={onBack}
            className="grid place-items-center rounded-full transition hover:bg-[color:var(--faint)]"
            style={{ width: 34, height: 34 }}
            aria-label={t("common.back")}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        )}
        <div className="min-w-0">
          {title && (
            <div className="text-[17px] font-semibold tracking-tight truncate">
              {title}
            </div>
          )}
          {subtitle && (
            <div className="text-[12px] text-muted truncate">{subtitle}</div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="nf-tabs" role="tablist" aria-label={t("common.language")}>
          <button
            type="button"
            onClick={() => lang.set("ru")}
            className={`nf-tab ${lang.lang === "ru" ? "nf-tab--active" : ""}`}
          >
            RU
          </button>
          <button
            type="button"
            onClick={() => lang.set("uz")}
            className={`nf-tab ${lang.lang === "uz" ? "nf-tab--active" : ""}`}
          >
            UZ
          </button>
        </div>
        <button
          type="button"
          onClick={theme.toggle}
          className="nf-btn nf-btn--ghost"
          style={{ padding: "9px 14px" }}
          aria-label={theme.theme === "dark" ? t("common.theme_light") : t("common.theme_dark")}
        >
          {theme.theme === "dark" ? (
            <>
              <Sun className="w-3.5 h-3.5" /> {t("common.theme_light")}
            </>
          ) : (
            <>
              <Moon className="w-3.5 h-3.5" /> {t("common.theme_dark")}
            </>
          )}
        </button>
      </div>
    </header>
  );
}
