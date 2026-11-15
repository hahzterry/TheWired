/**
 * Module evaluation order of the pipeline's dependencies, pinned.
 *
 * `eventPipeline.ts` used to import everything below itself, in this order.
 * Now that the pipeline is split across files, each stage imports only what
 * it uses, and without this list the same modules would evaluate in a
 * different order. That matters here: the pipeline sits in an import cycle
 * with the store (it is evaluated while `store/index.ts` is still evaluating),
 * so the order its dependencies run in is part of how the app boots.
 *
 * The entry imports this file first. It adds no module to the app; it only
 * fixes the order. Nothing needs to be added here for a new import.
 */
import "../../../types/nostr";
import "../dedup";
import "../forgetSeen";
import "../mutationAuthority";
import "../../../store/slices/eventsSlice";
import "../validation";
import "../verifyWorkerBridge";
import "../../../store";
import "../../db/eventStore";
import "../../../store/slices/reactionsSlice";
import "../../../store/slices/zapsSlice";
import "../../../store/slices/pollsSlice";
import "../../lightning/zapReceipt";
import "../../../features/music/savedVersionSync";
import "../../../store/slices/musicSlice";
import "../../../store/slices/dmSlice";
import "../dmSignals";
import "../../../features/music/trackParser";
import "../../../features/music/albumParser";
import "../../../features/music/playlistParser";
import "../../../features/music/annotationParser";
import "../../../store/slices/relaysSlice";
import "../../../store/slices/feedSlice";
import "../../../features/spaces/spaceChannelRoutes";
import "../../media/mediaUrlParser";
import "../../../features/spaces/noteParser";
import "../../../features/polls/pollParser";
import "../profileCache";
import "../giftWrap";
import "../../../features/music/sharedKey/projectKeyDM";
import "../../../features/music/sharedKey/projectKeys";
import "../secretStore";
import "../../../features/music/sharedKey/members";
import "../decryptQueue";
import "../notificationEvaluator";
import "../../../store/slices/friendRequestSlice";
import "../../../store/slices/identitySlice";
import "../friendRequest";
import "../follow";
import "../../../store/slices/callSlice";
import "../../webrtc/e2ee/mediaKeyInbox";
import "../../../store/slices/emojiSlice";
import "../../../features/emoji/emojiSetParser";
import "../../../store/thunks/spaceMembers";
import "../../../store/thunks/spaceConfigSync";
import "../../../features/spaces/nip29SpaceSync";
import "../../debug/logger";
