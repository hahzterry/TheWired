import { Loader2, RotateCw } from "lucide-react";
import type { LoadMoreError } from "../../store/slices/feedSlice";

interface LoadMoreButtonProps {
  isLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  /** Set when the last attempt failed (rather than reached the end). */
  error?: LoadMoreError | null;
}

const ERROR_TEXT: Record<LoadMoreError, string> = {
  unreachable: "Couldn't reach a relay to load more.",
  timeout: "The relays took too long to answer.",
};

const BUTTON_CLASS =
  "flex items-center gap-2 rounded-xl bg-surface border border-border px-4 py-2 text-xs font-medium text-body transition-all duration-150 hover:bg-surface-hover hover:text-heading disabled:opacity-50";

export function LoadMoreButton({ isLoading, hasMore, onLoadMore, error }: LoadMoreButtonProps) {
  if (!hasMore) {
    return (
      <div className="py-6 text-center text-xs text-faint">
        No more to load
      </div>
    );
  }

  if (error && !isLoading) {
    return (
      <div role="alert" className="flex flex-col items-center gap-2 py-4">
        <p className="text-xs text-muted">{ERROR_TEXT[error]}</p>
        <button onClick={onLoadMore} className={BUTTON_CLASS}>
          <RotateCw size={14} />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex justify-center py-4">
      <button onClick={onLoadMore} disabled={isLoading} className={BUTTON_CLASS}>
        {isLoading ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            Loading...
          </>
        ) : (
          "Load more"
        )}
      </button>
    </div>
  );
}
