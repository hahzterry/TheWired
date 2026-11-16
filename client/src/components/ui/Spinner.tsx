import { cn } from "@/lib/utils";

interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Announced to screen readers. Pass "" when nearby text already says so. */
  label?: string;
}

const sizeStyles = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
};

export function Spinner({ size = "md", className, label = "Loading" }: SpinnerProps) {
  return (
    <div
      role={label ? "status" : undefined}
      aria-hidden={label ? undefined : true}
      className={cn(
        "animate-spin rounded-full border-2 border-primary/20 border-t-primary",
        sizeStyles[size],
        className,
      )}
    >
      {/* A live region announces its text content; a bare aria-label on an
          empty element is not read out. */}
      {label && <span className="sr-only">{label}</span>}
    </div>
  );
}
