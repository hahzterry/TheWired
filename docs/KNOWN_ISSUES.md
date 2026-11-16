# Known Issues & Deferred Fixes

Tracked, intentionally-deferred work and rough edges. Each entry says **why** it
was deferred and **where** the fix would land, so it can be picked up cleanly.

Most entries below came out of the client **event-storm optimization** work
(profile/spaces floods + UI freeze). The shipped parts of that work are
summarized in the agent memory (`project_perf_optimizations.md`); what remains
is here.

---

## Deferred — Client performance

### 1. List virtualization (SHIPPED)

The long lists render through `react-virtuoso`: only the rows around the
viewport are mounted. Chosen over a headless virtualizer because it already
does what these lists need and would otherwise be hand-written: measured
variable heights, a scroll parent that is not the list itself (profile page),
prepending without moving the viewport, and opening on a given row.

**What is virtualized**

| List | Component | Shared piece |
|---|---|---|
| Space notes feed | `NotesFeed.tsx` | `VirtualFeed` |
| Profile tabs (Notes, Reposts, Replies, Media, Reads) | `ProfilePage.tsx` | `VirtualFeed` |
| Media grid | `MediaFeed.tsx` | `VirtualFeed`, one row of tiles per item |
| Space chat | `ChatView.tsx` | `VirtualMessageList` |
| DM conversation | `DMConversation.tsx` | `VirtualMessageList` |
| AI conversation | `AIMessageList.tsx` | `VirtualMessageList` |

**How it holds together** (`client/src/components/virtual/`, `client/src/lib/virtual/`)

- **Feeds** scroll inside the scroll container they always had
  (`customScrollParent`), so a composer or profile header above and the
  load-more control below scroll with them. The render-caps and their reveal
  sentinels are gone; the profile's local paging is driven by the list
  reporting that its last row is rendered. The relay "Load more" button keeps
  its loading, error and retry states.
- **Scroll restoration is anchor-based everywhere** (`useAnchoredScrollRestore`,
  now also for the space feeds, per channel and media filter tab). The saved
  card is usually not in the DOM of a virtualized list, so the hook asks the
  list to bring it in and then re-pins as before. Row heights measured during
  the session are remembered (`itemHeights.ts`) and handed back as starting
  estimates.
- **Message lists** open on the newest row or the unread divider, follow a row
  appended at the tail only while the reader is at the bottom, and keep the
  reader's place when older rows arrive above: the number of rows added at the
  head is worked out from the row keys (`prependShift.ts`) and handed to the
  virtualizer. The bottom pin is released by the reader moving up, not by the
  list correcting its own offset right after a resize.
- **Scroll anchoring at rest** (`viewportAnchor.ts`). The virtualizer turns the
  browser's scroll anchoring off and only compensates while the list is being
  scrolled up. Once scrolling has been quiet for a moment, `ViewportAnchor`
  remembers the row at the top of the viewport and puts it back when rows
  above it change height (media arriving late, AI bubbles dropping their
  action row during a stream). It never undoes a scroll: any scroll is the new
  place. The one scroll it holds through is the virtualizer making room for
  rows added above, which the list announces.
- **Engagement** follows the rendered range (`useEngagementRange`) instead of
  an observer per card or the first 100 notes, so notes far down a feed get
  their counts. Stored engagement is fetched once per note (a one-shot request
  that closes on EOSE); one live subscription covers the notes rendered right
  now and is replaced as that set changes, so a note stays live for as long as
  it is on screen. Its un-react leg is re-issued as reaction ids become known.
- **Card state survives unmounting** (`useRetainedState`): reply and quote
  drafts, open composers, expanded threads, hidden media. Kept per account:
  the next account to look at the same note does not find it.
- **Inline video and audio** stop when their card leaves the rendered window
  (the element is gone) and come back paused at the position they were left
  at (`useResumePlayback`, in `SmartVideo` and `InlineAudio`). The music
  player is a single element outside the lists and is not affected.
- Every row keeps its `ItemBoundary` and its stable key.

**Measured** (headless Chrome, 1400×900, before = the commit this branched
from, same identity and content, runs back to back):

Elements in the document with the list at rest, and rows mounted:

| List | Elements (before → after) | Rows mounted |
|---|---|---|
| Space notes feed, 500 notes | 35,689 → 711 | 30+ per reveal → 5 |
| Profile feed, 50 to 250 notes | 1,871 → 881 at the top; 18,005 → 872 after scrolling through 250 | 20 per page → 7 |
| Media grid, 650 tiles | 2,919 → 770 | 30+ per reveal → 7 rows |
| Space chat, 3,050 messages | 134,808 → 936 | 3,050 → 17 |
| DM conversation, 2,000 messages | 96,872 → 838 | 2,000 → 23 |
| AI conversation, 200 messages | 10,695 → 1,249 | 200 → 7 |

Opening the list (dev builds; median of 3, the DM row is the first open):

| List | Content on screen after | Long tasks in the first 4 s |
|---|---|---|
| Space chat, 3,050 messages | 2,464 → 140 ms | 377 → 0 ms |
| DM conversation, 2,000 messages (first open) | 1,570 → 162 ms | 2,076 → 68 ms |
| Space notes feed, 500 loaded | 55 → 133 ms | 0 → 54 ms |

Scripted scroll of 1,200 frames at 60 px per frame (down and up), 4× CPU
throttle. Chat and DM on production bundles of both:

| List | Mean frame (up / down) | Worst frame | Long tasks |
|---|---|---|---|
| Space chat | 120.5 / 94.0 → 25.9 / 21.2 ms | 2,000 → 50 ms | 1,207 (126.6 s) → 0 |
| DM conversation | 41.8 / 40.2 → 33.3 / 33.3 ms | 1,217 → 34 ms | 142 (13.5 s) → 0 |

The feeds on dev builds, which overstates the cost of mounting a row (the
local test stack went away before the feeds could be measured on production
bundles):

| List | Mean frame | p95 frame | Long tasks |
|---|---|---|---|
| Space notes feed | 26.8 → 18.6 ms | 67 → 33 ms | 57 (4.3 s) → 1 (0.05 s) |
| Profile feed | 17.7 → 19.4 ms | 17 → 33 ms | 3 (0.7 s) → 9 (0.5 s) |
| Media grid | 22.8 → 30.1 ms | 33 → 100 ms | 16 (6.8 s) → 176 (17.1 s) |

Without the throttle every list holds 16.7 ms frames on both; the worst frame
goes from 50–133 ms to 17–33 ms on the feeds. The media grid is the one place
that got worse in a measurement: rows of four tiles now mount while scrolling
in both directions, where the old render-cap mounted each tile once and kept
it. On a dev build under a 4× throttle that costs more than it saves. A CPU
profile of the dev build shows React's development-only checks dominating row
mounts, so the dev figure overstates it, but the grid was not measured on a
production bundle.

**Trade-offs and what is not covered**

- Rows outside the window are unmounted. State a row keeps in plain `useState`
  is lost when it scrolls far away; the state readers set on purpose goes
  through `useRetainedState`. New per-row state that must survive needs the
  same.
- An inline video or audio no longer keeps playing once its card is far
  outside the viewport, and a video sent to picture-in-picture or fullscreen
  from the browser's own controls closes when that happens. Before, the
  element stayed mounted and kept playing out of sight.
- The chat lists tell the virtualizer's scrolls from the reader's by wrapping
  `scrollBy` / `scrollTo` on the scroller. That relies on how `react-virtuoso`
  is built, so the dependency is pinned to an exact version and
  `virtualizerScrollContract.test.tsx` fails if a version scrolls another way.
- A smooth scroll only animates to a row that is rendered or close to it. A
  jump to a far message or a far "scroll to bottom" goes straight there.
- A feed opened at the very top lets new rows push in, as before. Further
  down, a new row at the top no longer moves what the reader is looking at.
- Find-in-page and anything else that walks the DOM only sees mounted rows.
- Live QA was done in Chromium. The desktop app's WebKit webview has not been
  exercised with these lists.
- In tests there is no layout: wrap the list in `VirtuosoMockContext`
  (`src/__tests__/helpers/virtualList.tsx`), and wait for
  `virtualListSettled()` before querying by role in a list that opens on a
  given row.
- The feed indices are still capped (500 per space feed and media index, 1000
  per author), and the chat subscription still asks for one page: a list only
  gets as long as what the client holds.

### 2. Unmemoized `articles` selector → re-render warning

**Why:** React-Redux logs *"Selector unknown returned a different result when
called with the same parameters"*. The `articles` view in `useProfileFeed`
returns `result.map(parseLongFormEvent)`, minting new objects every call, so the
`shallowEqual` equality check can never stabilize it → unnecessary re-renders
(dev-only warning, but real churn).

**Where:** `client/src/features/profile/useProfileNotes.ts` — memoize the parsed
article objects (e.g. cache `parseLongFormEvent` by event id, or select raw
events and parse in a `useMemo`).

### 3. Account-switch freeze (PARTLY SHIPPED — the longest task remains)

The original note blamed `switchAccount` → `performCleanup` →
`relayManager.disconnectAll()` and the redial storm. Profiling a switch between
two accounts in 30 spaces each (loaded feed on screen, dev build) says
otherwise: relay teardown and dialing are 1–2% of the main-thread time. About
85% is React rendering, in three places — the app shell re-mounting when the
switch overlay lifts, the feed's first page rendering, and the shell
re-rendering once per joined space as each space's member list revalidated.

**Shipped:**
- **No-op member syncs skip the store** (`store/thunks/spaceMembers.ts`). After
  a login or switch every space re-fetches the roster it just hydrated from
  IndexedDB; an unchanged answer no longer dispatches. This was the largest
  post-switch cost.
- **Staggered, prioritised redial** (`relayManager.ts`). The platform relay
  dials at once, then a burst of 4, then one relay per 40 ms in rank order:
  the user's write relays, their read-only relays, fan-out targets.
- **Quiet teardown.** `disconnectAll()` no longer fires two store updates per
  relay; `performCleanup` clears the connection rows with one action.

**Measured** (longest main-thread task / total long-task time / long tasks per
switch, medians of 5 switches, builds run back to back):

| | before | after |
|---|---|---|
| 4× CPU throttle | 213 ms / 843 ms / 8 | 221 ms / 407 ms / 2 |
| no throttle | 54 ms / 54 ms / 1 | 58 ms / 58 ms / 1 |

Total blocked time halved and the trail of long tasks after the switch is
gone, but the **longest single task did not move**: it is the shell re-mount,
which no relay-side change touches. The ~1.9 s figure in the original note was
never reproduced with these accounts.

**Still open — where the rest lives:**
- The shell mounts in one synchronous render when `identity.switchingAccount`
  flips back (`App.tsx`). Options: reveal before hydration finishes so the
  mount is cheap and data streams in, or stop rendering closed modals
  (`CreateSpaceModal`, `CreateAlbumModal`, `UploadTrackModal` render on every
  shell update).
- The feed's first paint. Since list virtualization (#1) it mounts only the
  cards in the window instead of a page of 30; the switch has not been
  re-measured since.
- `performLogin` hydration is shared with cold start (#9).

### 4. Relay connection noise from outbox fan-out (SHIPPED)

Outbox routing dials each viewed author's NIP-65 write relays (7–21 per
profile), and an unreachable one used to be redialed forever, each attempt
logging `WebSocket … failed` in the console. Two profiles with dead write
relays produced 97 fan-out dials in 150 s with no end in sight.

**Shipped** (`relayConnection.ts`, `relayManager.ts`, `reconnect.ts`):
- **Strikes.** A connect that never opens, times out (`CONNECT_TIMEOUT`, 15 s),
  or opens and closes again within `STABLE_AFTER` (5 s) is a strike. A
  connection that holds resets the count.
- **Tiers.** `relayManager` classifies every relay at failure time:
  - *app* — the platform relay. Retried forever.
  - *pinned* — relays the user or the app chose: the user's relay list, DM
    relays, anything a feature `connect()`s explicitly, space hosts and mirrors
    (`pinRelay`, called by `groupSubscriptions`), bootstrap and indexer relays.
    Retried forever.
  - *transient* — relays dialed only because someone else's data names them:
    the auto-dial in `relayManager.subscribe` (outbox), a DM recipient's inbox
    (`connectPeer`), the search relay. After `STRIKE_LIMIT` (3) strikes the
    relay is **dropped for the session**: 3 dials, then nothing. Subscriptions
    it never answered get an end-of-stored-events so no EOSE quorum sits out
    its timeout, and later subscriptions skip it.

  Every tier backs off on the same schedule as before (1, 2, 4 … capped at
  60 s). The noise came from fan-out relays, and those are now dropped, so the
  cap for chosen relays did not need to change.
- **Not the relay's fault.** A transient relay is only dropped while some
  non-loopback relay is connected (and `navigator.onLine` is true). With the
  network down it keeps backing off instead.
- **Reset.** The browser `online` event clears strikes, redials whatever was
  backing off and lifts session drops that a live subscription still wants.
  So does an outside relay connecting after none had been connected for 10 s
  (wake from sleep), at most once a minute — a single relay flapping does not
  count.
- **Asking again dials at once.** `relayManager.connect()` on a chosen relay
  that is waiting out its backoff dials immediately (a send to a space whose
  host just came back does not wait for the retry timer), at most once per
  5 s per relay. Transient callers never shorten a backoff.
- Failed dials no longer trip the reconnect-storm detector, and a past storm
  now expires on its own. Dead relays used to hold every healthy relay's
  reconnect to the 10 s storm cooldown.

**Left as is:** a dead relay in the user's own list is still dialed (at most
once a minute, as before) and still logs each attempt; that is the price of
never dropping a relay the user chose. A relay dialed for a group-import
preview is treated as chosen, not transient.

### 5. "Load more" on accounts with many joined spaces (SHIPPED)

The pagination REQ from `loadMoreSpaceFeed` was an ordinary subscription. When
an account's standing subs filled a relay's cap, the REQ went to the back of
`deferredSubs`, nothing was sent, and the button spun for the 30 s timeout and
then silently went back to "Load more".

**Shipped:**
- **Priority requests borrow a slot** (`relayConnection.ts`). Standing subs
  keep the relay's whole cap. When a priority subscription finds the relay
  full, the connection CLOSEs one standing sub (the most recently opened one
  on the wire), sends the priority REQ in its place, and re-sends the parked
  sub the moment a slot frees — normally when the one-shot closes, well under
  a second later. At most two subs are parked at a time; a third concurrent
  priority request waits at the front of the deferred queue. On reconnect
  priority subs are re-sent first.
- **"Load more" is priority** (`groupSubscriptions.ts`, `fetchPage`), for space
  feeds and the friends feed. Refreshes (including the automatic first fetch
  of a feed) stay ordinary subscriptions so they cannot crowd it out.
- **Error and retry.** `subscribeOnce` now reports how many relays the REQ was
  actually written to. If no read relay is connected (after a 4 s grace for a
  reconnect) or the request never left the client, the feed shows "Couldn't
  reach a relay to load more." with a Retry button; a request that was sent
  but not answered in time shows "The relays took too long to answer." State
  lives in `feed.meta[contextId].loadMoreError`.

**Trade-off:** the parked sub misses live events while it is closed. It is
re-sent with its original filters, so stored events inside its `since`/`limit`
window come back; a sub that only wants events newer than "now" can miss what
arrived in that gap.

**Not covered:** refresh on a saturated relay still waits for a slot, as it
always did. The profile page's older-notes fetch (`useProfileNotes`) is a
separate path and still uses plain subscriptions. Which standing subs win the
slots when an account is over the cap is still decided in insertion order —
see #8.

### 6. Media-feed video thumbnails — re-seek caching (SHIPPED, with residual)

Posterless videos (plain kind:1 videos with no `imeta` thumb) used to re-decode a
first frame every time they scrolled back into view: the near-viewport gate is
non-sticky, so the tile unmounted on scroll-away and **re-seeked from scratch** on
return. On media-dense feeds (100+ videos) those repeated 300–1100ms decodes were
the residual main-thread hitches left after the engagement-storm fix.

**Shipped** (branch `perf/media-thumb-cache`):
- **Enqueue debounce** (`ENQUEUE_DEBOUNCE_MS`, `LazyVideoFrame`): a tile scrolled
  past in <200ms never acquires a load slot, so fast scrolling stops flooding
  `videoLoadQueue` with doomed seeks.
- **Bounded poster cache** (`lib/cache/videoPosterCache.ts`): the painted first
  frame is captured (canvas → JPEG **data URL**) into a 250-entry LRU and rendered
  as a cheap `<img>` on scroll-back instead of re-mounting a `<video>`. Data URLs
  (not blob object-URLs) → no revoke lifecycle, and an evicted entry can't break a
  still-rendered `<img>`. Capture is **silent** (no mid-view re-render) so the
  on-screen tile never flickers; the `<img>` takes over only on the next scroll-by.

**Residual (CORS-bound) — left as a known limit:** reading frame pixels needs a
`<video crossorigin="anonymous">`, which only works on hosts that send permissive
CORS headers; tainted hosts fall back to the old re-seek (no cache entry). The
first video from a non-CORS host does one `crossorigin`→plain remount, then the
origin is remembered (`corsBlockedOrigins`) so later tiles skip the probe. So an
all-non-CORS feed gets only the debounce, not the cache. If that ever matters, the
universal fallback is **B2 — a bounded mounted-`<video>` LRU** (keep the N
most-recently-seeked tiles mounted; no canvas/CORS, but a smaller cap since a live
`<video>` costs more than a JPEG).

### 8. APP_RELAY subscription-cap relief (Phase 2 of the v0.6.3 churn fix)

**Why:** v0.6.3 stopped the platform relay (`relay.thewired.app` / `APP_RELAY`)
from being *churned* by relay-list reconciliation (it's now sticky in
`reconcileUserRelays` — see `project_app_relay_sticky_contract`). That killed the
connect/disconnect death spiral, but the **underlying pressure remains**:
`APP_RELAY` is in both `PROFILE_RELAYS` and `BOOTSTRAP_RELAYS` and is the
broadcast target for the feed *plus* every joined space/channel, engagement,
profile, and DM sub, so a busy account (large follow list / many spaces) still
exceeds its NIP-11 `max_subscriptions` (100). Overflow sits in
`relayConnection.deferredSubs` and is only sent as slots free, and `resubscribe()`
re-decides the deferred set "from scratch" in `Map`-iteration order — so *which*
subs win the 100 slots isn't prioritized by importance, and a background sub
(e.g. an active space's chat) can silently never subscribe. Without the churn this
is now a stable one-time deferral rather than a per-second thrash, so it's a
correctness edge, not an outage.

**Where:**
- `relayConnection.ts` (`DEFAULT_MAX_SUBS`, `subscribe`/`resubscribe`/
  `deferredSubs`/`drainDeferred`) — prioritize critical subs (active channel chat,
  the user's own feed) ahead of background ones so they're never the deferred ones.
- `relayManager.ts` broadcast fan-out (`subscribe` with no `relayUrls`) — stop
  blasting every broadcast sub at `APP_RELAY`; route by need.
- `engagementCollector.ts` / `groupSubscriptions.ts` — consolidate engagement and
  per-space subs to lower the raw sub count on a single relay.
- Same cap is behind #5 ("load more" on many-spaces accounts).

### 9. Cold-start main-thread freeze (~5.5s on initial login)

**Why:** On a fresh launch (observed on 0.6.3), `main-thread frozen 5558ms
(severe)` fires ~7.5s after start, during initial login hydration + first feed
render (IDB hydration, engagement/sub setup, first `NotesFeed` paint).
**Pre-existing** — not introduced by the relay churn fix, and distinct from the
account-switch freeze (#3, ~1900ms via `switchAccount`/`performCleanup`); this one
is the initial cold-start path. The minified stack points at a heavy synchronous
pass during first render (`qw`).

**Where:** `performLogin` (`lib/nostr/login/performLogin.ts`) initial subscribe/hydrate path + the first feed render +
engagement collector setup. Likely wants heavy first-render work deferred
(idle/chunked scheduling). List virtualization (#1) has since cut the first feed
render down to the cards in the window; re-measure before going further. Overlaps
the broader event-storm work (`project_app_freeze_investigation`). Re-measure with
`wiredDebug` to attribute the stall (IDB hydration vs render vs sub setup) before
optimizing.

### 10. In-app screen-share window picker (Meet/Zoom style)

**Why deferred:** `getDisplayMedia` never exposes the window list — the WebView
owns the chooser (macOS 14 WebKit: the "Share This Window / Share This Screen"
overlay where you must click the actual window; macOS 15+: Apple's system
picker; Windows WebView2: Edge's picker dialog). The Chromium-only hints we set
(`selfBrowserSurface: "exclude"`, `surfaceSwitching`, `systemAudio`) are ignored
by WebKit. Meet gets Chrome's picker; Zoom/Discord are Electron and use
`desktopCapturer`, which Tauri has no equivalent for. So a thumbnail grid in
our UI is not a UI change — it needs a native capture pipeline.

**Design (when picked up):**
1. Rust enumerates windows + monitors with thumbnails (`xcap` crate; macOS
   Screen Recording permission is already declared in `Info.plist`).
2. Meet-style picker grid in `features/voice/` refreshing thumbnails every ~1–2s.
3. On pick, Rust captures that source continuously (~15 fps, ≤1080p), JPEG-encodes
   frames and streams them over a local WebSocket to the WebView.
4. The WebView paints frames to a canvas and publishes `canvas.captureStream()`
   as the LiveKit screen-share track — tiles, encoding presets and focus mode
   are unchanged downstream.

**Trade-offs:** ~1 core of CPU on the sharer (capture + JPEG + H.264), 100–200ms
added latency, text slightly softer than the native path (JPEG hop), Windows
occluded-window capture quirks (`PrintWindow`), and no system audio through
this path. Ship behind a "Custom window picker" toggle with the OS picker as the
fallback. Estimate: 3–5 days for both platforms including permission prompts.

**Where:** `client/src-tauri/src/` (new `screencap.rs` + IPC commands),
`client/src/features/voice/devices/` (picker UI), `lib/webrtc/livekitClient.ts`
(`setScreenShareEnabled` gains a `source` option that publishes a canvas track
via `localParticipant.publishTrack`).

---

## Deferred — Architecture

### 7. Nostrify-style transport refactor (separate thread)

Adopting `req()`/`AbortSignal` + an `NStore`-shaped interface over
`relayConnection`/`relayManager`/`subscriptionManager`. **Does not fix
performance and is not a federation prerequisite** — it's an ergonomics/
maintainability investment. See the section below for what it must preserve.

---

## Planned Nostrify refactor — contracts the optimization work added

If/when the transport layer is refactored, these seams from the perf work are
**load-bearing** and must be preserved (or re-homed):

1. **The `relayUrl` source distinction into `processIncomingEvent` is the
   batching seam.** `isBurstSource()` (`lib/nostr/pipeline/batching.ts`) batches only `ws(s)://`
   sources; synthetic sources (`"local"` optimistic sends, `"resolve"`/`"search"`/
   `"browse"`/`"embedded"`) stay immediate so awaiting callers read fresh state.
   Whatever replaces `subscriptionManager.onEvent` **must keep passing a real
   relay URL for live subs and the synthetic strings for optimistic/resolver
   paths.** If events arrive without that tag, optimistic sends get a 50ms delay
   and resolvers read stale Redux.

2. **Keep feeding the batching buffer, not per-event dispatch.** The buffer +
   coalesced flush live in the event pipeline (`lib/nostr/pipeline/batching.ts`, downstream of transport). A
   `for await (const msg of pool.req(...))` loop should still call
   `processIncomingEvent(event, relayUrl)` per event — do **not** reintroduce
   per-event `store.dispatch`.

3. **`relayManager.onReconnect()` is now used** by the background-chat-sub rebuild
   (`groupSubscriptions.ts`) to refresh `since` on reconnect. A `req()` model
   handles reconnect internally — re-expose an equivalent reconnect signal, or
   move the fresh-`since` rebuild into the new resubscribe path.

4. **`subscriptionManager.getReconnectSince(subId)` is now wired** (was dead
   code) — the bg-sub rebuild uses it so a reconnect doesn't replay the whole
   backlog. The new model needs a per-subscription "latest event seen" to carry a
   fresh `since` on resubscribe.

5. **`relayManager.subscribe` auto-dials unconnected target relays read-only.**
   Outbox (`useAuthorWriteRelays`) relies on this: passing an author's write-relay
   URLs auto-connects them. An `NPool`-style model needs the same lazy `open(url)`.

6. **These are the call sites the refactor touches** — all go through
   `subscriptionManager.subscribe/close` + `relayManager.onReconnect/
   closeSubscription`, and map cleanly to `req()` + `AbortSignal` (abort = close):
   - `engagementCollector.ts` (`EngagementWindow` — open/close per scroll chunk; the poster child for AbortSignal)
   - `groupSubscriptions.ts` (host-relay bg chat subs, per-channel subs, pagination)
   - `useProfileNotes.ts` `useAuthorWriteRelays` (one-shot NIP-65 lookup)
   - `profileCache.ts` `relayFetch` (batched kind:0)

7. **Coalescing opportunity the refactor unlocks:** the per-host background chat
   sub (multi-`#h`) and the active-channel chat sub overlap (both query
   `kinds:[9,5,9005]` + `#h` for the active space). Dedup catches the
   double-delivery today, but a coalescing layer (which `NStore`/`req()` enables)
   could merge them.

8. **Reactions are no longer stored as full events** — they live in
   `reactionsSlice` (`byTarget`/`byEventId`). If the refactor touches the kind:7
   path, keep routing to `addReaction`, not `addEvent`.

9. **Test mocks to update:** 4 test files mock `relayManager` and/or
   `subscriptionManager` (`zap`, `profileCache`, `groupSubscriptions`,
   `subscriptionManager`). Changing these singletons' shapes requires updating the
   mocks — a partial mock that omits a now-required method (e.g. `onReconnect`)
   throws *"X is not a function"* at module load via the transitive import chain.
