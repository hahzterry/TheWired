/**
 * Module evaluation order of the login path's dependencies, pinned.
 *
 * `loginFlow.ts` used to import all of its dependencies itself, in one order.
 * Now that the login path is split across files, each file imports only what
 * it uses, and without this list the modules below would evaluate in a
 * different order. That matters for these modules because each one is part of
 * an import cycle that includes the store and the event pipeline, and
 * `loginFlow.ts` is the app's way into it. Inside a cycle, the order decides
 * which module is still half-initialised when another one reads it.
 *
 * The list is the old file's value imports in the old order, minus the modules
 * that neither belong to an import cycle nor import one that does. Those are
 * always complete by the time anything reads them, wherever they fall in the
 * order.
 *
 * The entry imports this file first. It adds no module to the app; it only
 * fixes the order.
 *
 * Changing it:
 *  - A new import in the folder needs no line here.
 *  - Do not reorder the lines.
 *  - These are static imports, so every module listed loads at startup. To
 *    lazy-load one with `import()`, delete its line here too, or the dynamic
 *    import changes nothing. `__tests__/entryFileBoundary.test.ts` fails when
 *    a line here is the only static import left of its module.
 *  - A line can go once its module is out of the cycle (nothing it imports,
 *    directly or through other modules, imports it back).
 *  - After removing or changing a line: run the client tests (the
 *    characterization suites load the entry files cold), then build the
 *    production bundle, open it and log in. A wrong order shows up at load as
 *    `ReferenceError: Cannot access '…' before initialization`, in the test
 *    run or in the browser console.
 */
import "../../../store";
import "../subscriptionManager";
import "../kickHandler";
import "../relayList";
import "../dmRelayList";
import "../dmRelayListEnsure";
import "../../../features/profile/pinListWrite";
import "../../../features/friends/feedPrefsPersistence";
import "../../../store/thunks/spaceMembers";
import "../../../features/music/libraryFill";
import "../../../features/music/librarySync";
import "../../../features/music/savedVersionSync";
import "../../api/spaces";
import "../../../features/music/trackParser";
import "../publish";
import "../profileCache";
import "../../../features/dm/dmPersistence";
import "../../../features/dm/dmReadState";
import "../../../features/dm/dmSync";
import "../followerPersistence";
import "../friendRequestPersistence";
import "../../../features/notifications/notificationPersistence";
import "../eventPipeline";
import "../groupSubscriptions";
import "../publishOutbox";
import "../../../store/thunks/channelLayout";
import "../../../features/music/sharedKey/projectKeys";
import "../../media/mediaPrefs";
import "../../media/mediaGrant";
import "../../cache/tokenCache";
import "../../../features/calling/accountChangeMedia";
