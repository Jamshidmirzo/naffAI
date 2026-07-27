import { type HTMLAttributes, forwardRef } from "react";
import { cn } from "./cn";

interface Props extends HTMLAttributes<HTMLDivElement> {
  hero?: boolean;
  padded?: boolean;
}

export const Card = forwardRef<HTMLDivElement, Props>(function Card(
  { hero, padded, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        hero ? "nf-hero" : "nf-card",
        padded && "p-6",
        className,
      )}
      style={hero ? { borderRadius: 30 } : undefined}
      {...rest}
    />
  );
});
