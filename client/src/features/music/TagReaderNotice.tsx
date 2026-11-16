import type { ReactNode } from "react";

interface TagReaderNoticeProps {
  /** What was not read and what that means here. */
  children: ReactNode;
  onRetry: () => void;
  retrying?: boolean;
}

/** Shown under a file picker when the file's tags could not be read because the reader did not load. */
export function TagReaderNotice({ children, onRetry, retrying = false }: TagReaderNoticeProps) {
  return (
    <div role="alert" className="mt-1.5 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
      <span className="min-w-0 flex-1">{children}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="shrink-0 font-medium underline transition-colors hover:text-amber-300 disabled:opacity-50"
      >
        {retrying ? "Reading…" : "Try again"}
      </button>
    </div>
  );
}
