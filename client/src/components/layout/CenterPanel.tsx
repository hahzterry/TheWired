import { Outlet } from "react-router-dom";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

export function CenterPanel() {
  return (
    <div data-tour="center-panel" className="flex flex-1 flex-col overflow-hidden bg-background">
      {/* Route-level containment: a page that throws leaves the shell around
          it usable, and navigating elsewhere clears the fallback. */}
      <ErrorBoundary variant="panel" label="center">
        <Outlet />
      </ErrorBoundary>
    </div>
  );
}
