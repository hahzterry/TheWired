import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { BoundaryResetContext } from "@/components/ui/boundaryReset";
import { useAppSelector } from "@/store/hooks";

/**
 * Supplies the navigation epoch that error boundaries reset on.
 *
 * "Where the user is" is only partly in the URL: the sidebar mode, the active
 * space and channel, and the music view are Redux state. All of them count as
 * navigation here, so leaving a broken view by any of those routes clears its
 * fallback and gives the destination a clean render.
 */
export function BoundaryResetProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const sidebarMode = useAppSelector((s) => s.ui.sidebarMode);
  const activeSpaceId = useAppSelector((s) => s.spaces.activeSpaceId);
  const activeChannelId = useAppSelector((s) => s.spaces.activeChannelId);
  const musicView = useAppSelector((s) => s.music?.activeView);
  const musicDetailId = useAppSelector((s) => s.music?.activeDetailId);

  const epoch = [
    pathname,
    sidebarMode,
    activeSpaceId ?? "",
    activeChannelId ?? "",
    musicView ?? "",
    musicDetailId ?? "",
  ].join("|");

  return <BoundaryResetContext.Provider value={epoch}>{children}</BoundaryResetContext.Provider>;
}
