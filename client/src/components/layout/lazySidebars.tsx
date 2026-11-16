/**
 * The sidebar bodies that belong to one mode. Each loads with its mode, the
 * same way the AI sidebar does; the spaces body is the landing view and stays
 * in the startup bundle.
 */
import { lazyView } from "@/components/ui/lazyView";
import { PanelLoading } from "@/components/ui/LazyFallbacks";

export const MusicSidebar = lazyView(
  () => import("../../features/music/MusicSidebar").then((m) => ({ default: m.MusicSidebar })),
  <PanelLoading label="Loading music" />,
);

export const DMSidebar = lazyView(
  () => import("../../features/dm/DMSidebar").then((m) => ({ default: m.DMSidebar })),
  <PanelLoading label="Loading messages" />,
);
