import { ReactNode, useEffect, useRef } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  widthClass?: string;
}

/**
 * Legacy title-in-header modal. Still used by StickerPicker.
 * Newer surfaces should prefer `components/ui/Modal` which is a bare
 * container that lets the caller lay out its own title/body/actions.
 * Kept API-compatible; the surface, backdrop, and typography now use
 * design tokens so both light and dark themes look right.
 */
export function Modal({ open, onClose, title, children, widthClass = "max-w-md" }: Props) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable?.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) modalRef.current?.querySelector<HTMLElement>("button, input, textarea")?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{
        background: "rgba(20,12,6,.36)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className={`nf-card p-5 w-full ${widthClass} max-h-[92vh] overflow-auto nf-scroll-thin animate-nfPop`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ borderRadius: 28 }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-[color:var(--text-primary)]">{title}</h2>
          <button
            className="p-1.5 rounded-lg hover:bg-[color:var(--bg-nested)] text-[color:var(--text-muted)] text-lg leading-none"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
