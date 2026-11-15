/**
 * Module evaluation order of the login path's dependencies, pinned.
 *
 * `loginFlow.ts` used to import everything below itself, in this order. Now
 * that the login path is split across files, each file imports only what it
 * uses, and without this list the same modules would evaluate in a different
 * order. That matters here: `loginFlow.ts` is the app's way into an import
 * cycle that includes the store and the event pipeline, so the order its
 * dependencies run in is part of how the app boots.
 *
 * The entry imports this file first. It adds no module to the app; it only
 * fixes the order. Nothing needs to be added here for a new import.
 */
import "../../../store";
import "../../../store/slices/identitySlice";
import "../../../store/slices/relaysSlice";
import "../signer";
import "../relayManager";
import "../subscriptionManager";
import "../kickHandler";
import "../nip65";
import "../nip46AuthUrl";
import "../relayList";
import "../dmRelayList";
import "../dmRelayListEnsure";
import "../../../types/nostr";
import "../../db/userStateStore";
import "../../db/profileStore";
import "../../db/spaceStore";
import "../../../features/settings/featuresPersistence";
import "../../../features/profile/pinListWrite";
import "../../../features/profile/pinList";
import "../../../store/slices/featuresSlice";
import "../../../features/friends/feedPrefsPersistence";
import "../../../store/slices/feedPrefsSlice";
import "../../../features/spaces/spaceType";
import "../../db/spaceMembersStore";
import "../../../store/slices/spaceConfigSlice";
import "../../../store/slices/spacesSlice";
import "../../../store/thunks/spaceMembers";
import "../../db/musicStore";
import "../../../features/music/libraryFill";
import "../../../features/music/librarySync";
import "../../../features/music/savedVersionSync";
import "../../db/eventStore";
import "../../../store/slices/eventsSlice";
import "../../../store/slices/notificationSlice";
import "../../api/spaces";
import "../../../store/slices/musicSlice";
import "../../../features/music/trackParser";
import "../../../features/music/albumParser";
import "../../../features/music/playlistParser";
import "../../../features/music/annotationParser";
import "../constants";
import "../publish";
import "../eventBuilder";
import "../profileCache";
import "../../../features/profile/profileParser";
import "../../../features/dm/dmPersistence";
import "../../../features/dm/dmReadState";
import "../../../features/dm/dmSync";
import "../followerPersistence";
import "../friendRequestPersistence";
import "../../../features/notifications/notificationPersistence";
import "../eventPipeline";
import "../verifyWorkerBridge";
import "../groupSubscriptions";
import "../publishOutbox";
import "../../db/channelStore";
import "../../../store/thunks/channelLayout";
import "../../db/lastChannelCache";
import "../tauriSigner";
import "../secretStore";
import "../../../features/onboarding/onboardingSlice";
import "../../../features/onboarding/onboardingPersistence";
import "../../debug/logger";
import "../../../features/music/sharedKey/projectKeys";
import "../../../features/music/sharedKey/members";
import "../../media/mediaPrefs";
import "../../media/mediaGrant";
import "../../cache/tokenCache";
import "../../webrtc/mediaSession";
import "../../../features/calling/accountChangeMedia";
