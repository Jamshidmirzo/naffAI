import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, X } from "lucide-react";
import { useTheme } from "../../store/theme";
import { useT2 } from "../i18n";

export { PageSkeleton, LoadingBlock, EmptyState, ErrorState, NoAccess } from "./states";
export { Pager } from "./Pager";
export { CountText, CountUp } from "./motion";

import { cx } from "./format";

export { cx, fmtNum, fmtMln } from "./format";

/** Page header as on the artboards: back button, h1, meta, actions on the right. */
export function PageHeader({ title, meta, back, after, children }: { title: ReactNode; meta?: ReactNode; back?: string | (() => void); after?: ReactNode; children?: ReactNode }) {
  const nav = useNavigate();
  const t = useT2();
  return (
    <header className="top">
      {back ? (
        <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("common.back")} onClick={() => (typeof back === "function" ? back() : nav(back))}>
          <ArrowLeft className="ic" />
        </button>
      ) : null}
      <h1 className="h1" style={{ flex: "none", whiteSpace: "nowrap" }}>{title}</h1>
      {meta ? <span className="s c3 trunc" style={{ flex: "0 1 auto" }} title={typeof meta === "string" ? meta : undefined}>{meta}</span> : null}
      {after}
      <span className="grow" />
      {children}
    </header>
  );
}

/** Portal root that carries the Атлас tokens (works outside the shell too). */
function V2Portal({ children, leaving }: { children: ReactNode; leaving?: boolean }) {
  const theme = useTheme((s) => s.theme);
  return createPortal(
    <div className={leaving ? "nf is-leaving" : "nf"} data-theme={theme} style={{ position: "fixed", inset: 0, zIndex: 60, background: "transparent", pointerEvents: leaving ? "none" : undefined }}>
      {children}
    </div>,
    document.body,
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** One-time secrets: no close on backdrop/Esc/×; only an explicit footer action closes. */
  locked?: boolean;
  danger?: boolean;
}

/**
 * Keeps a closing overlay mounted for a short exit animation (`leaving`).
 * Skipped under prefers-reduced-motion.
 */
function usePresence(open: boolean, ms = 170) {
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const shown = useRef(open);
  useEffect(() => {
    if (open) {
      shown.current = true;
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!shown.current) return;
    shown.current = false;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setMounted(false);
      return;
    }
    setLeaving(true);
    const id = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, ms);
    return () => window.clearTimeout(id);
  }, [open, ms]);
  return { mounted, leaving };
}

/** The standard v2 window (.dlg): header with ×, body, footer buttons on the right. */
export function Dialog(props: DialogProps) {
  const { open, onClose, width = 480, locked, danger } = props;
  const t = useT2();
  const { mounted, leaving } = usePresence(open);
  // While the window animates out, keep showing what it showed last
  // (callers often clear the data that fills it at the same moment).
  const last = useRef(props);
  if (open) last.current = props;
  const { title, sub, children, footer } = open ? props : last.current;
  useEffect(() => {
    if (!open || locked) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, locked, onClose]);
  if (!mounted) return null;
  return (
    <V2Portal leaving={leaving}>
      <div className="scrim" onClick={locked ? undefined : onClose} />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, pointerEvents: "none" }}>
        <section className="dlg" role="dialog" aria-modal="true" style={{ width, maxWidth: "100%", maxHeight: "calc(100vh - 48px)", overflow: "hidden", display: "flex", flexDirection: "column", pointerEvents: "auto" }}>
          <div className="dlg-h" style={{ flex: "none" }}>
            <div className="col g4">
              <h2 className="h2" style={danger ? { color: "var(--bad)" } : undefined}>{title}</h2>
              {sub ? <span className="s c3">{sub}</span> : null}
            </div>
            {!locked ? (
              <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("common.close")} onClick={onClose}>
                <X className="ic" />
              </button>
            ) : null}
          </div>
          {children ? <div className="dlg-b" style={{ overflow: "auto", minHeight: 0, flex: "1 1 auto" }}>{children}</div> : null}
          {footer ? <div className="dlg-f" style={{ flex: "none" }}>{footer}</div> : null}
        </section>
      </div>
    </V2Portal>
  );
}

export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  confirm: string;
  danger?: boolean;
  /** Ask for a reason; minLength enforces it (e.g. 10 for deletions). */
  reason?: { label: string; minLength?: number; placeholder?: string };
}

/**
 * Promise-based confirm that replaces window.confirm():
 *   const confirm = useConfirm(); const ok = await confirm({...});
 * With `reason`, resolves to the entered text (string) or false.
 */
export function useConfirm() {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean | string) => void }) | null>(null);
  const [reason, setReason] = useState("");
  const ref = useRef(state);
  ref.current = state;
  const t = useT2();
  const ask = (o: ConfirmOptions) =>
    new Promise<boolean | string>((resolve) => {
      setReason("");
      setState({ ...o, resolve });
    });
  const done = (v: boolean | string) => {
    ref.current?.resolve(v);
    setState(null);
  };
  const min = state?.reason?.minLength ?? 0;
  const node = state ? (
    <Dialog
      open
      onClose={() => done(false)}
      title={state.title}
      danger={state.danger}
      footer={
        <>
          <button className="btn" type="button" onClick={() => done(false)}>{t("common.cancel")}</button>
          <button
            className={cx("btn", state.danger ? "btn-danger" : "btn-pri")}
            type="button"
            disabled={!!state.reason && reason.trim().length < min}
            onClick={() => done(state.reason ? reason.trim() : true)}
          >
            {state.confirm}
          </button>
        </>
      }
    >
      {state.body ? <div className="s c2">{state.body}</div> : null}
      {state.reason ? (
        <div className="field">
          <label htmlFor="v2-confirm-reason">{state.reason.label}</label>
          <textarea id="v2-confirm-reason" className="input" rows={3} value={reason} placeholder={state.reason.placeholder} onChange={(e) => setReason(e.target.value)} />
          {min > 1 ? <span className="xs c3">{reason.trim().length} / {min}</span> : null}
        </div>
      ) : null}
    </Dialog>
  ) : null;
  return Object.assign(ask, { node });
}
