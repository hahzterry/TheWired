import { useSyncExternalStore } from "react";
import { Bug, Trash2 } from "lucide-react";
import { CopyDiagnosticsButton } from "@/components/ui/ErrorBoundary";
import { clearCrashRecords, getCrashCount, subscribeCrashLog } from "@/lib/crash/crashLog";

/**
 * Settings entry point for the local crash log: how many records are held,
 * a way to copy them for a bug report, and a way to wipe them.
 */
export function DiagnosticsSection() {
  const count = useSyncExternalStore(subscribeCrashLog, getCrashCount, getCrashCount);

  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="mb-1 flex items-center gap-2">
        <Bug size={14} className="text-primary" />
        <h3 className="text-sm font-semibold text-heading">Diagnostics</h3>
      </div>
      <p className="mb-3 text-xs text-muted">
        When part of the app fails, a short technical record is kept on this device so you can
        include it in a bug report. Records hold the error, where in the app it happened and the
        app version. They never include your keys, messages or post content, and nothing is sent
        anywhere unless you copy and share it yourself.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <CopyDiagnosticsButton />
        <button
          type="button"
          onClick={clearCrashRecords}
          disabled={count === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-heading transition-colors hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-50"
        >
          <Trash2 size={14} />
          Clear records
        </button>
        <span className="text-xs text-muted" data-testid="crash-count">
          {count === 0 ? "No crashes recorded" : `${count} ${count === 1 ? "record" : "records"} stored`}
        </span>
      </div>
    </div>
  );
}
