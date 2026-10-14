import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Lock, RefreshCw, Inbox } from "lucide-react";
import { useT2 } from "../i18n";

function SkRow() {
  return (
    <div className="row g12">
      <i className="sk" style={{ display: "block", width: 32, height: 32, borderRadius: "50%" }} />
      <i className="sk" style={{ display: "block", height: 12, width: 180 }} />
      <i className="sk" style={{ display: "block", height: 12, flex: "1 1 0" }} />
      <i className="sk" style={{ display: "block", height: 22, width: 80 }} />
    </div>
  );
}

/** Skeleton shaped like a page; after 10 s shows «Всё ещё загружаем». */
export function LoadingBlock({ rows = 4, onRetry }: { rows?: number; onRetry?: () => void }) {
  const t = useT2();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setSlow(true), 10000);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div className="col g12" style={{ padding: "16px 20px" }} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => <SkRow key={i} />)}
      {slow ? (
        <div className="banner b-info">
          <RefreshCw className="ic" />
          <span className="col g4"><span className="w6">{t("v2.state.slowTitle")}</span><span>{t("v2.state.slowBody")}</span></span>
          {onRetry ? <button className="btn btn-sm" type="button" onClick={onRetry}>{t("v2.state.retry")}</button> : null}
        </div>
      ) : null}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <main className="page">
      <div className="row g12">
        <i className="sk" style={{ display: "block", height: 64, flex: "1 1 0" }} />
        <i className="sk" style={{ display: "block", height: 64, flex: "1 1 0" }} />
        <i className="sk" style={{ display: "block", height: 64, flex: "1 1 0" }} />
      </div>
      <section className="card"><LoadingBlock rows={6} /></section>
    </main>
  );
}

export function EmptyState({ title, body, action, icon }: { title: ReactNode; body?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <span className="icon-tile" style={{ width: 56, height: 56, borderRadius: 14 }}>{icon ?? <Inbox className="ic ic-l" />}</span>
      <span className="h3" style={{ color: "var(--ink)" }}>{title}</span>
      {body ? <span className="s" style={{ maxWidth: 380 }}>{body}</span> : null}
      {action}
    </div>
  );
}

/** Error with «Повторить». Pass the axios error to show the server's message. */
export function ErrorState({ error, onRetry, title }: { error?: unknown; onRetry?: () => void; title?: ReactNode }) {
  const t = useT2();
  const detail =
    (error as { response?: { data?: { detail?: string; message?: string } } })?.response?.data?.detail ||
    (error as { response?: { data?: { message?: string } } })?.response?.data?.message ||
    (error as Error)?.message;
  return (
    <div className="col g12" style={{ padding: 20 }}>
      <div className="banner b-bad">
        <AlertTriangle className="ic" />
        <span className="col g4">
          <span className="w6">{title ?? t("v2.state.errorTitle")}</span>
          <span>{detail || t("v2.state.errorBody")}</span>
        </span>
      </div>
      {onRetry ? (
        <div className="row g8">
          <button className="btn btn-pri" type="button" onClick={onRetry}><RefreshCw className="ic" />{t("v2.state.retry")}</button>
        </div>
      ) : null}
    </div>
  );
}

export function NoAccess() {
  const t = useT2();
  return (
    <main className="page">
      <section className="card">
        <EmptyState
          icon={<Lock className="ic ic-l" />}
          title={t("v2.state.noAccessTitle")}
          body={t("v2.state.noAccessBody")}
          action={<Link className="btn btn-pri" to="/">{t("v2.state.toHome")}</Link>}
        />
      </section>
    </main>
  );
}
