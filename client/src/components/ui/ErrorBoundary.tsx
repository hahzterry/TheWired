import {
  Component,
  useContext,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { AlertTriangle, Check, Copy, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyDiagnostics, recordCrash } from "@/lib/crash/crashLog";
import { DevCrashProbe } from "@/lib/crash/devCrashProbe";
import { isChunkLoadError, retryFailedLazyImports } from "@/lib/lazyWithRetry";
import { BoundaryResetContext } from "./boundaryReset";
import { Button } from "./Button";

/**
 * Where a boundary sits decides what its fallback looks like:
 * - `screen`: the whole window (app root, route level).
 * - `panel`: one region of the shell; the rest of the app stays usable.
 * - `inline`: one item in a list; its neighbours keep rendering.
 */
export type BoundaryVariant = "screen" | "panel" | "inline";

export interface BoundaryFallbackProps {
  /** Re-mount the children. */
  retry: () => void;
  variant: BoundaryVariant;
  /** Redacted one-line summary of the error (`TypeError: …`). */
  summary: string | null;
  /**
   * The failure was a piece of the app that could not be loaded (a lazy chunk).
   * Retry may not be enough, so the fallback should offer a reload too.
   */
  reloadSuggested: boolean;
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Short code-side name recorded with the crash (`sidebar`, `note`). It ends
   * up in diagnostics, so it must be a constant, never data.
   */
  label: string;
  variant?: BoundaryVariant;
  /** Prefix recorded before the label; defaults to the variant (`panel:sidebar`). */
  scope?: string;
  /**
   * A boundary showing its fallback resets when any entry changes (compared
   * with `Object.is`). Pass the identity of whatever is rendered inside, e.g.
   * an event id, so a different item gets a fresh attempt.
   */
  resetKeys?: readonly unknown[];
  /**
   * Replace the built-in fallback. `null` renders nothing, for overlays whose
   * absence is the right degraded state.
   */
  fallback?: ReactNode | ((props: BoundaryFallbackProps) => ReactNode);
  /** What the user was looking at, for the inline message ("note", "message"). */
  noun?: string;
  /** Extra classes for the built-in fallback's container, to match the slot it fills. */
  className?: string;
  onError?: (error: unknown, info: ErrorInfo) => void;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  failed: boolean;
  summary: string | null;
  reloadSuggested: boolean;
}

/**
 * Resets a failed boundary when the navigation epoch changes. It is rendered
 * only inside a fallback, so only failed boundaries subscribe to the context:
 * a healthy boundary (there is one around every list item) does no work at all
 * when the user navigates.
 */
function ResetOnNavigation({ onNavigate }: { onNavigate: () => void }) {
  const epoch = useContext(BoundaryResetContext);
  // Mounted in the same render that caught the failure, so this is the epoch
  // the children failed under.
  const failedUnder = useRef(epoch);
  useEffect(() => {
    if (epoch !== failedUnder.current) onNavigate();
  }, [epoch, onNavigate]);
  return null;
}

function sameKeys(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, i) => Object.is(value, b[i]));
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false, summary: null, reloadSuggested: false };

  /**
   * The keys in effect when the children failed. Reset compares against this
   * snapshot rather than the previous props: a key change and the throw it
   * causes land in the same render, and comparing to the previous props would
   * treat that as "changed since the failure" and retry at once.
   */
  private failedWith: { keys: readonly unknown[] | undefined } | null = null;

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { failed: true, reloadSuggested: isChunkLoadError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const variant = this.props.variant ?? "panel";
    const record = recordCrash(error, {
      source: "boundary",
      boundary: `${this.props.scope ?? variant}:${this.props.label}`,
      componentStack: info.componentStack,
    });
    if (record) this.setState({ summary: `${record.name}: ${record.message}` });
    this.props.onError?.(error, info);
  }

  componentDidUpdate(): void {
    if (!this.state.failed || !this.failedWith) return;
    if (!sameKeys(this.failedWith.keys, this.props.resetKeys)) this.reset();
  }

  reset = (): void => {
    this.failedWith = null;
    // React.lazy caches a rejected import, so remounting alone would re-throw
    // it forever. Re-arm any failed lazy import before the children remount.
    retryFailedLazyImports();
    this.props.onReset?.();
    this.setState({ failed: false, summary: null, reloadSuggested: false });
  };

  render(): ReactNode {
    if (!this.state.failed) {
      if (import.meta.env.DEV) {
        // Dev builds only: lets `wiredDebug.crash("<scope>:<label>")` make this
        // boundary's content throw. Compiled out of production bundles.
        const first = this.props.resetKeys?.[0];
        return (
          <>
            <DevCrashProbe
              target={`${this.props.scope ?? this.props.variant ?? "panel"}:${this.props.label}`}
              id={typeof first === "string" ? first : undefined}
            />
            {this.props.children}
          </>
        );
      }
      return this.props.children;
    }

    if (!this.failedWith) {
      this.failedWith = { keys: this.props.resetKeys };
    }

    // Every fallback, including a custom or an empty one, carries the
    // navigation watcher so that moving elsewhere always clears the failure.
    return (
      <>
        <ResetOnNavigation onNavigate={this.reset} />
        {this.renderFallback()}
      </>
    );
  }

  private renderFallback(): ReactNode {
    const variant = this.props.variant ?? "panel";
    const { summary, reloadSuggested } = this.state;
    const { fallback } = this.props;
    if (typeof fallback === "function") {
      return fallback({ retry: this.reset, variant, summary, reloadSuggested });
    }
    if (fallback !== undefined) return fallback;

    return (
      <BoundaryFallback
        variant={variant}
        retry={this.reset}
        summary={summary}
        reloadSuggested={reloadSuggested}
        noun={this.props.noun}
        className={this.props.className}
      />
    );
  }
}

interface ItemBoundaryProps {
  children: ReactNode;
  /** Identity of the item (event id, message id). A different id gets a fresh attempt. */
  id: string;
  /** Code-side name recorded with the crash (`note`, `chat-message`). */
  label: string;
  /** What the user sees it as, for the fallback text ("note", "message"). */
  noun?: string;
  className?: string;
}

/**
 * Per-item boundary for lists that render untrusted event data. It wraps one
 * item at its call site and adds no DOM of its own while the item renders, so
 * the list container around it can change (pagination, virtualization)
 * without this having to.
 */
export function ItemBoundary({ children, id, label, noun, className }: ItemBoundaryProps) {
  return (
    <ErrorBoundary
      variant="inline"
      scope="item"
      label={label}
      noun={noun}
      resetKeys={[id]}
      className={className}
    >
      {children}
    </ErrorBoundary>
  );
}

interface CopyDiagnosticsButtonProps {
  /** `icon` is the compact form used by inline fallbacks. */
  appearance?: "button" | "icon";
  className?: string;
}

/**
 * Copies the local crash log to the clipboard. The text is built from redacted
 * records only (see `lib/crash/redact.ts` for what redaction does and does not
 * cover).
 */
export function CopyDiagnosticsButton({
  appearance = "button",
  className,
}: CopyDiagnosticsButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = async () => {
    const ok = await copyDiagnostics();
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };

  const icon = state === "copied" ? <Check size={14} /> : <Copy size={14} />;
  const text =
    state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy diagnostics";

  if (appearance === "icon") {
    return (
      <button
        type="button"
        onClick={onCopy}
        title={text}
        aria-label={text}
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-heading",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {icon}
      </button>
    );
  }

  return (
    <Button type="button" variant="secondary" size="sm" onClick={onCopy} className={cn("gap-1.5", className)}>
      {icon}
      {text}
    </Button>
  );
}

interface BoundaryFallbackUiProps {
  variant: BoundaryVariant;
  retry: () => void;
  summary: string | null;
  /** Show a Reload action: the failure was a part of the app that did not load. */
  reloadSuggested?: boolean;
  noun?: string;
  className?: string;
}

function reloadApp(): void {
  window.location.reload();
}

/** The built-in fallback for each variant. Exported for custom compositions. */
export function BoundaryFallback({
  variant,
  retry,
  summary,
  reloadSuggested = false,
  noun,
  className,
}: BoundaryFallbackUiProps) {
  if (variant === "inline") {
    return (
      <div
        role="status"
        data-boundary-fallback="inline"
        className={cn(
          // Wraps rather than truncates: the same fallback has to read in a
          // full-width feed row and in a narrow grid tile.
          "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted",
          className,
        )}
      >
        <AlertTriangle size={14} className="shrink-0 text-warning" />
        <span className="min-w-0 flex-1 basis-20">
          {reloadSuggested
            ? "Part of the app didn't load."
            : noun
              ? `This ${noun} couldn't be displayed.`
              : "This couldn't be displayed."}
        </span>
        <button type="button" onClick={retry} className={INLINE_ACTION}>
          Retry
        </button>
        {reloadSuggested && (
          <button type="button" onClick={reloadApp} className={INLINE_ACTION}>
            Reload
          </button>
        )}
        <CopyDiagnosticsButton appearance="icon" />
      </div>
    );
  }

  if (variant === "screen") {
    return (
      <div
        role="alert"
        data-boundary-fallback="screen"
        className={cn(
          "flex h-screen w-full flex-col items-center justify-center gap-5 bg-background px-6 text-center",
          className,
        )}
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-card">
          <AlertTriangle size={24} className="text-warning" />
        </div>
        <div className="max-w-sm space-y-1.5">
          <h1 className="text-lg font-semibold text-heading">The Wired hit a problem</h1>
          <p className="text-sm text-soft">
            Something went wrong while drawing this screen. Try again, or reload the app if it
            keeps happening.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" size="sm" onClick={retry} className="gap-1.5">
            <RotateCcw size={14} />
            Try again
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={reloadApp}>
            Reload app
          </Button>
          <CopyDiagnosticsButton />
        </div>
        <ErrorSummary summary={summary} />
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-boundary-fallback="panel"
      className={cn(
        "flex h-full min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 overflow-hidden p-4 text-center",
        className,
      )}
    >
      <AlertTriangle size={20} className="shrink-0 text-warning" />
      <div className="max-w-xs space-y-1">
        <p className="text-sm font-medium text-heading">
          {reloadSuggested ? "This part of the app didn't load" : "This part of the app hit a problem"}
        </p>
        <p className="text-xs text-muted">
          {reloadSuggested
            ? "Try again, or reload the app to fetch it fresh."
            : "The rest of the app is still working."}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" variant="accent" size="sm" onClick={retry} className="gap-1.5">
          <RotateCcw size={14} />
          Try again
        </Button>
        {reloadSuggested && (
          <Button type="button" variant="secondary" size="sm" onClick={reloadApp}>
            Reload app
          </Button>
        )}
        <CopyDiagnosticsButton />
      </div>
      <ErrorSummary summary={summary} />
    </div>
  );
}

const INLINE_ACTION =
  "shrink-0 rounded-md px-1.5 py-0.5 font-medium text-soft transition-colors hover:bg-surface-hover hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The redacted error line. Development builds only: users get the copy button instead. */
function ErrorSummary({ summary }: { summary: string | null }) {
  if (!import.meta.env.DEV || !summary) return null;
  return (
    <code className="max-w-full break-words rounded-md bg-field px-2 py-1 font-mono text-[11px] text-faint">
      {summary}
    </code>
  );
}
