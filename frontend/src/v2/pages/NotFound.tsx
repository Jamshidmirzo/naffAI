import { Link } from "react-router-dom";
import { useT2 } from "../i18n";
import { EmptyState } from "../ui";

export default function NotFound() {
  const t = useT2();
  return (
    <main className="page">
      <section className="card">
        <EmptyState
          icon={<span className="display" style={{ fontSize: 22 }}>404</span>}
          title={t("v2.state.notFoundTitle")}
          body={t("v2.state.notFoundBody")}
          action={<Link className="btn btn-pri" to="/">{t("v2.state.toHome")}</Link>}
        />
      </section>
    </main>
  );
}
