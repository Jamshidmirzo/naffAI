import { useEffect, type ReactNode } from "react";
import { cn } from "./cn";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  width?: number;
  closeOnBackdrop?: boolean;
}

export function Modal({
  open,
  onClose,
  children,
  className,
  width = 560,
  closeOnBackdrop = true,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{
        background: "rgba(20,12,6,.36)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        className={cn(
          "nf-card animate-nfPop max-h-[92vh] overflow-auto nf-scroll-thin",
          className,
        )}
        style={{ width, borderRadius: 28 }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
