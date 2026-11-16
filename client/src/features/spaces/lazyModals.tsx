/**
 * The space dialogs that are heavy and opened rarely, as lazy chunks. Each is
 * a drop-in for the modal it loads (same name, same props): the chunk is
 * fetched on first open, and `lazyModal` supplies the loading state and the
 * error boundary for a failed load.
 */
import { lazyModal } from "@/components/ui/lazyView";

/** Create / join / import a space (the sidebar's "+"). */
export const SpaceActionModal = lazyModal(
  () => import("./SpaceActionModal").then((m) => ({ default: m.SpaceActionModal })),
  "space-action",
);

/** Space settings, with all of its tabs. */
export const SpaceSettingsModal = lazyModal(
  () => import("./settings/SpaceSettingsModal").then((m) => ({ default: m.SpaceSettingsModal })),
  "space-settings",
);

export const InviteGenerateModal = lazyModal(
  () => import("./InviteGenerateModal").then((m) => ({ default: m.InviteGenerateModal })),
  "invite-generate",
);

// Channel management (people who can manage channels; opened from the sidebar).
export const CreateChannelModal = lazyModal(
  () => import("./CreateChannelModal").then((m) => ({ default: m.CreateChannelModal })),
  "create-channel",
);

export const EditChannelModal = lazyModal(
  () => import("./EditChannelModal").then((m) => ({ default: m.EditChannelModal })),
  "edit-channel",
);

export const CategoryModal = lazyModal(
  () => import("./CategoryModal").then((m) => ({ default: m.CategoryModal })),
  "category",
);
