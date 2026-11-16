/**
 * When the lazy routes get fetched ahead of the click.
 *
 * - On intent: the sidebar's mode buttons preload their section while the
 *   pointer or focus is on them (`musicIntent`, `messagesIntent`).
 * - When idle: once the shell is up, the places people go first are fetched
 *   one at a time in idle slots, so the first navigation is usually instant.
 *   Everything else loads when it is opened.
 */
import { useEffect } from "react";
import { preloadGroup, preloadWhenIdle, type Preloadable } from "@/lib/lazyPreload";
import { DMSidebar, MusicSidebar } from "@/components/layout/lazySidebars";
import { DiscoverPage, DMView, MusicRouter, NoteThreadPage, ProfilePage } from "./lazyRoutes";

/** Messages mode: the conversation view and its sidebar. */
export const messagesIntent = preloadGroup(DMSidebar, DMView);

/** Music mode: the section and its sidebar. */
export const musicIntent = preloadGroup(MusicSidebar, MusicRouter);

/** In the order people tend to reach them from the landing view. */
export const IDLE_PRELOADS: readonly Preloadable[] = [
  messagesIntent,
  ProfilePage,
  NoteThreadPage,
  musicIntent,
  DiscoverPage,
];

/** Start the idle preloads once the shell has mounted. */
export function useIdleRoutePreload(): void {
  useEffect(() => preloadWhenIdle(IDLE_PRELOADS), []);
}
