import type { NostrEvent, NostrFilter, UnsignedEvent } from "../../types/nostr";
import type { RelayMode } from "../../types/relay";
import type { RelayEventCallback, RelayEOSECallback, RelayOKCallback, RelayStatusCallback, SubscribeOptions, RelayConfig } from "./types";
import { RelayConnection } from "./relayConnection";
import { StormDetector, type RelayTier } from "./reconnect";
import { APP_RELAY, BOOTSTRAP_RELAYS, INDEXER_RELAYS, RECONNECT } from "./constants";
import { normalizeRelayUrl } from "./relayUrl";
import { createLogger, shortRelay } from "../debug/logger";

const log = createLogger("sub");
const relayLog = createLogger("relay");

/** Loopback relays (dev relay, the embedded relay) stay reachable with no
 *  network at all, so their being connected says nothing about the network. */
function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "[::1]" || host === "::1" || host.startsWith("127.");
  } catch {
    return false;
  }
}

/** Dial order when a burst is being spaced out (lower dials first). */
function dialRank(tier: RelayTier, mode: RelayMode): number {
  if (tier === "app") return 0;
  if (tier === "pinned") return mode === "read" ? 2 : 1;
  return 3;
}

/** Kinds the indexer-only relays (purplepag.es / user.kindpag.es) actually serve:
 *  metadata, contacts, relay list. They reject everything else and have strict
 *  concurrent-REQ caps, so we must never send them chat/engagement/note subs. */
const INDEXER_KINDS = new Set([0, 3, 10002]);

const INDEXER_SET = new Set<string>(INDEXER_RELAYS);

/** True if every filter is limited to indexer-served kinds (so it's safe to send
 *  to an indexer relay). A filter with no `kinds` matches everything → not safe.
 *  Exported so layers above (subscriptionManager) can mirror the same strip and
 *  not wait on EOSE from a relay that was never actually subscribed. */
export function isIndexerSafe(filters: NostrFilter[]): boolean {
  return filters.every((f) => f.kinds != null && f.kinds.every((k) => INDEXER_KINDS.has(k)));
}

/** Indexer-relay URL set (frozen — used by callers to mirror the strip). */
export const INDEXER_URL_SET = INDEXER_SET;

let subIdCounter = 0;
function nextSubId(): string {
  return `sub_${++subIdCounter}_${Date.now().toString(36)}`;
}

class RelayManagerImpl {
  private connections = new Map<string, RelayConnection>();
  private stormDetector = new StormDetector();
  private onEventCallbacks = new Map<string, RelayEventCallback>();
  private onEOSECallbacks = new Map<string, RelayEOSECallback>();
  private globalOnOK: RelayOKCallback | null = null;
  private globalOnStatusChange: RelayStatusCallback | null = null;
  /** Fired when a connection is removed via disconnect() so the Redux
   *  connections record can shrink in lockstep (wired in loginFlow). */
  private onRelayRemoved: ((url: string) => void) | null = null;

  /** Normalized URLs of the user's relay list as last applied via
   *  reconcileUserRelays — lets the next reconcile disconnect dropped relays. */
  private userRelayUrls = new Set<string>();
  /** Locally-disabled relays (normalized). Honored by reconcileUserRelays /
   *  connectFromConfig only — raw connect() stays permissive so transient
   *  feature dials (space host, DM recipients, preview, search) keep working. */
  private userDisabled = new Set<string>();

  /** Relays the user or the app chose this session (explicit connect(), a
   *  space host, DM relays). With the platform relay, bootstrap/indexer relays
   *  and the user's relay list they form the set that is never dropped. */
  private pinned = new Set<string>();
  /** Fan-out relays that struck out: not dialed again this session (until the
   *  browser reports `online`, or the relay is explicitly chosen). */
  private sessionDropped = new Set<string>();

  /** Dials waiting their turn while a burst is being spaced out. */
  private dialQueue: RelayConnection[] = [];
  private dialTimer: ReturnType<typeof setTimeout> | null = null;
  private dialBudget: number = RECONNECT.DIAL_BURST;
  private lastDialAt = 0;
  /** Relays whose NIP-11 document has been requested for the current connection. */
  private nip11Requested = new Set<string>();
  /** True inside disconnectAll(): per-relay status/removed callbacks are
   *  skipped (the caller resets its whole view of the relays instead). */
  private tearingDown = false;
  /** Whether any non-loopback relay was connected at the last status change. */
  private hadNetworkEvidence = false;
  /** When the last outside relay went away (null: never had one, or one is up). */
  private networkLostAt: number | null = null;
  /** When noteNetworkEvidence last ran a restore. */
  private lastEvidenceRestoreAt = 0;

  constructor() {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("online", () => this.handleNetworkRestored());
    }
  }

  /** Canonical connection key: normalized URL (trailing slash stripped) so
   *  `wss://x/` and `wss://x` share one socket. Falls back to the raw string
   *  for unparseable input. */
  private key(url: string): string {
    return normalizeRelayUrl(url) ?? url;
  }

  /** Transient one-shot status listeners used by waitForConnection /
   *  connectToBootstrapAndWait. Additive (a Set) so concurrent waiters — e.g.
   *  two logins racing, or an account switch — don't clobber each other's
   *  callback the way overwriting a single field did. */
  private statusWaiters = new Set<RelayStatusCallback>();

  /** Tracks active subscriptions that targeted specific relay URLs.
   *  When a relay connects for the first time, pending subs are forwarded to it. */
  private pendingSubscriptions = new Map<string, {
    filters: NostrFilter[];
    intendedUrls: string[];
    /** No-URL "broadcast" sub: forward to every read relay that connects later
     *  (not just relays connected at subscribe time) — see #24. */
    broadcast?: boolean;
    /** Whether this sub is allowed to target indexer-only relays. */
    indexerSafe?: boolean;
    /** User-initiated request: gets a slot even on a full relay (see RelayConnection.subscribe). */
    priority?: boolean;
  }>();

  /** Per-event-id callbacks for publish confirmation (used by publishWithConfirmation) */
  private publishOKCallbacks = new Map<string, (relayUrl: string, success: boolean, message: string) => void>();

  /** Relays we must NOT auto-answer NIP-42 AUTH for (AUTH-privacy). Connecting to
   *  a relay and signing its challenge reveals the user's pubkey; for relays the
   *  user hasn't opted into (e.g. an arbitrary relay dialed while *previewing* a
   *  group to import) we suppress AUTH until they actually join. */
  private authSuppressed = new Set<string>();

  /** Relays dialed only to hand a gift wrap to a recipient's kind-10050 inbox
   *  (AUTH-privacy, docs/DM_WIRE_CONTRACT.md §1). The wrap is signed by an
   *  ephemeral key, so a kind 22242 signed by the identity key would be the one
   *  frame on that socket naming the sender — to a relay the *recipient* chose.
   *  Never answer AUTH there, and keep the socket out of the read/write pools
   *  so no broadcast REQ (`authors=[me]`) and no untargeted publish reaches it
   *  either. A later plain connect() for the same URL (user relay list, space
   *  host, group import) lifts the restriction: the user chose it after all. */
  private peerOnly = new Set<string>();

  /** Relays that have reached "connected" at least once this session — lets us
   *  tell a reconnect apart from a first connect. */
  private everConnected = new Set<string>();
  /** Listeners fired when a relay reconnects (connected after a prior connect). */
  private reconnectListeners = new Set<(relayUrl: string) => void>();

  setGlobalCallbacks(cbs: {
    onOK?: RelayOKCallback;
    onStatusChange?: RelayStatusCallback;
    onRelayRemoved?: (url: string) => void;
  }) {
    if (cbs.onOK) this.globalOnOK = cbs.onOK;
    if (cbs.onStatusChange) this.globalOnStatusChange = cbs.onStatusChange;
    if (cbs.onRelayRemoved) this.onRelayRemoved = cbs.onRelayRemoved;
  }

  /** Register a listener fired when a relay reconnects (reaches "connected"
   *  after a previous connect this session). Returns an unsubscribe fn.
   *  Additive so multiple subsystems can listen without clobbering. */
  onReconnect(cb: (relayUrl: string) => void): () => void {
    this.reconnectListeners.add(cb);
    return () => this.reconnectListeners.delete(cb);
  }

  /** Dial a relay (or return the existing connection — the requested mode is
   *  ignored for an existing connection; use reconcileUserRelays to change
   *  modes). Deliberately permissive: does NOT honor the user-disabled set, so
   *  transient feature dials (space host relays, DM recipients, group preview,
   *  search) always work. User-list-driven connects go through
   *  reconcileUserRelays / connectFromConfig, which do honor it.
   *
   *  A plain connect() marks the relay as chosen: it is retried forever (with
   *  capped backoff) and never dropped, and calling it again while the relay
   *  backs off dials at once (at most every RECONNECT.KICK_INTERVAL per
   *  relay). Pass `transient` for a relay dialed
   *  only because someone else's data points at it (outbox fan-out, search):
   *  after RECONNECT.STRIKE_LIMIT failed connects it is dropped for the session. */
  connect(url: string, mode: RelayMode = "read+write", opts: { transient?: boolean } = {}): RelayConnection {
    const k = this.key(url);
    if (!opts.transient) {
      this.pinned.add(k);
      this.sessionDropped.delete(k);
    }
    const existing = this.connections.get(k);
    if (existing) {
      // A relay first dialed for a peer's inbox is now wanted for the user's
      // own reasons: allow AUTH and answer any challenge it already sent.
      if (!opts.transient && this.peerOnly.delete(k)) existing.tryAuth();
      if (existing.isIdle()) {
        this.enqueueDial(existing);
      } else if (!opts.transient) {
        // The app wants a chosen relay that is waiting out its backoff — e.g.
        // the user is sending to a space whose host just came back. Dial now
        // instead of making the send wait for the retry timer; rate-limited
        // per relay inside kick(). A transient caller never shortens a backoff.
        existing.kick();
      }
      return existing;
    }

    const conn = new RelayConnection(k, mode, this.stormDetector);
    conn.setCallbacks({
      onEvent: (subId, event, relayUrl) => {
        // Route to the specific subscription callback
        const cb = this.onEventCallbacks.get(subId);
        if (cb) {
          cb(event, relayUrl);
        }
      },
      onEOSE: (subId, relayUrl) => {
        this.onEOSECallbacks.get(subId)?.(subId, relayUrl);
      },
      onOK: (eventId, success, message, relayUrl) => {
        this.globalOnOK?.(eventId, success, message, relayUrl);
        this.publishOKCallbacks.get(eventId)?.(relayUrl, success, message);
      },
      onStatusChange: (relayUrl, status, error) => {
        if (this.tearingDown) return;
        this.globalOnStatusChange?.(relayUrl, status, error);
        for (const waiter of this.statusWaiters) waiter(relayUrl, status, error);
        if (status === "connected") {
          const isReconnect = this.everConnected.has(relayUrl);
          this.everConnected.add(relayUrl);
          this.forwardPendingSubscriptions(relayUrl, conn);
          // Fire reconnect listeners only on a genuine reconnect, not the first
          // connect (avoids needless bg-sub rebuilds during cold start).
          if (isReconnect) {
            for (const cb of this.reconnectListeners) cb(relayUrl);
          }
        }
        this.noteNetworkEvidence();
      },
      getTier: () => this.tierOf(k),
      onStrikeOut: () => this.handleStrikeOut(k),
      onAuth: async (challenge: string, relayUrl: string): Promise<NostrEvent | null> => {
        // AUTH-privacy: never reveal the user's pubkey to a relay they haven't
        // opted into (e.g. one we dialed just to preview a group for import).
        if (this.authSuppressed.has(relayUrl) || this.peerOnly.has(relayUrl)) return null;
        // Lazy imports to avoid circular dependency
        const { getSigner } = await import("./loginFlow");
        const { store } = await import("../../store");
        const signer = getSigner();
        const pubkey = store.getState().identity.pubkey;
        // Silent: this is the expected state pre-login; replayAuth retries
        // once login completes.
        if (!signer || !pubkey) return null;
        const unsigned: UnsignedEvent = {
          pubkey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 22242,
          tags: [
            ["relay", relayUrl],
            ["challenge", challenge],
          ],
          content: "",
        };
        try {
          return await signer.signEvent(unsigned);
        } catch (err) {
          console.warn(`[auth] signEvent failed for ${relayUrl}`, err);
          return null;
        }
      },
    });
    this.connections.set(k, conn);
    this.enqueueDial(conn);
    return conn;
  }

  /** Mark a relay as chosen without dialing it or changing its mode: a space
   *  host (or mirror) the app subscribes to is the user's choice, so it must
   *  keep being retried and never be dropped as a dead fan-out target. Lifts a
   *  session drop. */
  pinRelay(url: string): void {
    const k = this.key(url);
    this.pinned.add(k);
    this.sessionDropped.delete(k);
  }

  /** True while `url` is a struck-out fan-out relay that will not be dialed
   *  again this session. Layers above mirror this so they do not wait on EOSE
   *  from a relay that was never asked. */
  isSessionDropped(url: string): boolean {
    return this.sessionDropped.has(this.key(url));
  }

  /** How hard the client holds on to `k` (a normalized URL). */
  private tierOf(k: string): RelayTier {
    if (k === this.key(APP_RELAY)) return "app";
    if (this.pinned.has(k) || this.userRelayUrls.has(k)) return "pinned";
    if (BOOTSTRAP_RELAYS.some((b) => this.key(b) === k) || INDEXER_SET.has(k)) return "pinned";
    return "transient";
  }

  // ── Dial scheduling ─────────────────────────────────────────────────
  // A login or account switch asks for every relay at once. The first few
  // dials go out immediately (the platform relay always does); the rest are
  // spaced a few tens of ms apart in priority order — write-capable chosen
  // relays, then read-only ones, then fan-out targets — so the sockets, their
  // NIP-11 fetches and the status updates they trigger do not all land in the
  // same main-thread task as the first render of the new session.

  private enqueueDial(conn: RelayConnection): void {
    // Up, on its way, or waiting out its backoff: nothing to dial.
    if (!conn.isIdle()) return;
    const tier = this.tierOf(conn.url);
    const now = Date.now();
    if (this.dialQueue.length === 0 && now - this.lastDialAt >= RECONNECT.DIAL_SPACING * RECONNECT.DIAL_BURST) {
      this.dialBudget = RECONNECT.DIAL_BURST; // idle long enough: a fresh burst
    }
    if (tier === "app") {
      this.dialNow(conn);
      return;
    }
    if (this.dialQueue.length === 0 && this.dialBudget > 0) {
      this.dialBudget--;
      this.dialNow(conn);
      return;
    }
    if (!this.dialQueue.includes(conn)) this.dialQueue.push(conn);
    if (!this.dialTimer) {
      const wait = Math.max(0, this.lastDialAt + RECONNECT.DIAL_SPACING - now);
      this.dialTimer = setTimeout(() => this.drainDialQueue(), wait);
    }
  }

  private drainDialQueue(): void {
    this.dialTimer = null;
    // Rank at dial time: a relay can be promoted (pinned) while it waits.
    let best = -1;
    let bestRank = Infinity;
    for (let i = 0; i < this.dialQueue.length; i++) {
      const c = this.dialQueue[i];
      const rank = dialRank(this.tierOf(c.url), c.mode);
      if (rank < bestRank) {
        best = i;
        bestRank = rank;
      }
    }
    if (best === -1) return;
    const [conn] = this.dialQueue.splice(best, 1);
    // Skip a connection that was removed (or replaced) while it waited.
    if (this.connections.get(conn.url) === conn) this.dialNow(conn);
    if (this.dialQueue.length > 0) {
      this.dialTimer = setTimeout(() => this.drainDialQueue(), RECONNECT.DIAL_SPACING);
    }
  }

  private dialNow(conn: RelayConnection): void {
    this.lastDialAt = Date.now();
    if (!this.nip11Requested.has(conn.url)) {
      this.nip11Requested.add(conn.url);
      // Fetch NIP-11 relay info to learn subscription limits (non-blocking)
      void this.fetchNip11(conn.url, conn);
    }
    conn.connect();
  }

  private resetDialQueue(): void {
    if (this.dialTimer) clearTimeout(this.dialTimer);
    this.dialTimer = null;
    this.dialQueue = [];
    this.dialBudget = RECONNECT.DIAL_BURST;
    this.lastDialAt = 0;
  }

  // ── Dead relays ─────────────────────────────────────────────────────

  /** Any non-loopback relay connected, i.e. proof the network itself works. */
  private hasNetworkEvidence(exceptUrl?: string): boolean {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
    for (const c of this.connections.values()) {
      if (c.url !== exceptUrl && c.getStatus() === "connected" && !isLoopback(c.url)) return true;
    }
    return false;
  }

  /** A fan-out relay failed STRIKE_LIMIT connects in a row. Drop it for the
   *  session — unless nothing else is connected either, in which case the
   *  network is down and the failures say nothing about this relay. Returns
   *  true if the connection was dropped. */
  private handleStrikeOut(k: string): boolean {
    if (this.tierOf(k) !== "transient") return false;
    if (!this.hasNetworkEvidence(k)) return false;
    const conn = this.connections.get(k);
    if (!conn) return false;
    // Only the subscriptions this relay never answered: one it already sent
    // EOSE for must not get a second, made-up one.
    const unanswered = conn.getUnansweredSubscriptionIds();
    relayLog.info(`${shortRelay(k)} unreachable, not dialing it again this session`);
    this.disconnect(k);
    this.sessionDropped.add(k);
    // They get their end-of-stored-events now: the relay will never answer,
    // and an EOSE quorum must not sit out its timeout for it.
    for (const subId of unanswered) this.onEOSECallbacks.get(subId)?.(subId, k);
    return true;
  }

  /** Track whether the network has come back without the browser saying so
   *  (wake from sleep, VPN flap): an outside relay connecting after none had
   *  been connected for NETWORK_DOWN_MIN clears every other relay's backoff,
   *  at most once per RESTORE_MIN_INTERVAL. A single relay that drops and is
   *  back a second later is that relay flapping, not the network returning;
   *  treating every such flap as a restore redialed every dead relay again. */
  private noteNetworkEvidence(): void {
    const has = this.hasNetworkEvidence();
    const had = this.hadNetworkEvidence;
    this.hadNetworkEvidence = has;
    const now = Date.now();
    if (had && !has) {
      this.networkLostAt = now;
      return;
    }
    if (!has || had) return;
    const lostAt = this.networkLostAt;
    this.networkLostAt = null;
    if (lostAt === null) return; // first outside relay of the session: nothing to restore
    if (now - lostAt < RECONNECT.NETWORK_DOWN_MIN) return;
    if (now - this.lastEvidenceRestoreAt < RECONNECT.RESTORE_MIN_INTERVAL) return;
    this.lastEvidenceRestoreAt = now;
    this.handleNetworkRestored();
  }

  /** The network is back (browser `online`, or a relay just connected after
   *  none were): forget strikes, redial what was backing off — in the usual
   *  priority order — and give dropped fan-out relays another chance where a
   *  live subscription still wants them. Connected sockets are left alone. */
  private handleNetworkRestored(): void {
    const dropped = [...this.sessionDropped];
    this.sessionDropped.clear();
    for (const conn of this.connections.values()) {
      if (conn.resetBackoff()) this.enqueueDial(conn);
    }
    if (dropped.length === 0) return;
    const wanted = new Set<string>();
    for (const pending of this.pendingSubscriptions.values()) {
      for (const url of pending.intendedUrls) wanted.add(url);
    }
    for (const url of dropped) {
      if (wanted.has(url) && !this.connections.has(url)) this.connect(url, "read", { transient: true });
    }
  }

  /** Dial a relay only because a DM recipient's kind-10050 list names it
   *  (docs/DM_WIRE_CONTRACT.md §1). Unlike connect(), the socket never answers
   *  NIP-42 AUTH as the user and joins neither the read nor the write pool:
   *  only explicitly targeted frames (the wrap) go there. Relays the user or
   *  the app already chose — an existing connection, the platform relay (it
   *  needs AUTH for self-wrap detection, §7.3), bootstrap and NIP-65 relays —
   *  are dialed like connect(), since they carry the user's signed events
   *  anyway. Callers that know further user-chosen relays (the own 10050 list)
   *  route those through connect() themselves. */
  connectPeer(url: string): RelayConnection {
    const k = this.key(url);
    const existing = this.connections.get(k);
    if (existing) {
      this.enqueueDial(existing);
      return existing;
    }
    const chosen =
      k === this.key(APP_RELAY) ||
      BOOTSTRAP_RELAYS.some((b) => this.key(b) === k) ||
      this.userRelayUrls.has(k);
    if (chosen) return this.connect(url);
    this.peerOnly.add(k);
    // A DM send is the user's own action: a peer relay that struck out earlier
    // gets a fresh (bounded) set of attempts for it.
    this.sessionDropped.delete(k);
    return this.connect(url, "write", { transient: true });
  }

  /** True while `url` is held only for a peer's inbox (see connectPeer). */
  isPeerOnly(url: string): boolean {
    return this.peerOnly.has(this.key(url));
  }

  disconnect(url: string): void {
    const k = this.key(url);
    const conn = this.connections.get(k);
    if (conn) {
      conn.disconnect();
      this.connections.delete(k);
      this.peerOnly.delete(k);
      // `pinned` is kept: once chosen, a relay stays chosen for the session.
      this.nip11Requested.delete(k);
      this.dialQueue = this.dialQueue.filter((c) => c !== conn);
      // Forget the connect history so a future re-add counts as a first
      // connect, not a "reconnect" (no needless publishOutbox replay).
      this.everConnected.delete(k);
      if (!this.tearingDown) this.onRelayRemoved?.(k);
    }
  }

  /** Tear every connection down (logout, account switch). Per-relay status and
   *  removed callbacks are NOT fired: with dozens of relays that was two store
   *  updates per relay in one task. The caller clears its own record of the
   *  relays in one step instead. */
  disconnectAll(): void {
    this.tearingDown = true;
    try {
      for (const [url] of this.connections) {
        this.disconnect(url);
      }
    } finally {
      this.tearingDown = false;
    }
    this.resetDialQueue();
    this.stormDetector.reset();
    this.pinned.clear();
    this.sessionDropped.clear();
    this.nip11Requested.clear();
    this.hadNetworkEvidence = false;
    this.networkLostAt = null;
    this.lastEvidenceRestoreAt = 0;
    this.pendingSubscriptions.clear();
    this.publishOKCallbacks.clear();
    this.everConnected.clear();
    // #80: also clear the per-sub callback maps + the AUTH-suppress set so this
    // is self-sufficient. Raw relayManager.subscribe() session subs
    // (followers / user-data / DM gift-wrap) never go through
    // subscriptionManager.closeAll(), so without this their onEvent/onEOSE
    // callbacks (and stale authSuppressed entries) accumulate across
    // login → logout → login cycles.
    this.onEventCallbacks.clear();
    this.onEOSECallbacks.clear();
    this.authSuppressed.clear();
    this.peerOnly.clear();
    // User relay config is per-account — clear it so an account switch starts
    // clean (the next login reloads its own list + disabled set).
    this.userRelayUrls.clear();
    this.userDisabled.clear();
  }

  /** Publish an event to write relays. Returns the number of relays it was sent to. */
  publish(
    event: NostrEvent,
    targets?: string[],
  ): number {
    const relays = targets
      ? targets
          .map((url) => this.connections.get(this.key(url)))
          .filter((c): c is RelayConnection => !!c)
      : this.getWriteRelays();

    for (const conn of relays) {
      conn.publish(event);
    }
    return relays.length;
  }

  subscribe(opts: SubscribeOptions): string {
    const subId = nextSubId();
    const { filters, relayUrls, onEvent, onEOSE } = opts;
    const priority = opts.priority === true;

    this.onEventCallbacks.set(subId, onEvent);
    if (onEOSE) {
      this.onEOSECallbacks.set(subId, onEOSE);
    }

    // Indexer-only relays serve just kind:0/3/10002 and cap concurrent REQs hard.
    // Drop them from any subscription carrying other kinds — otherwise engagement
    // (kind 7/6/1), chat, and note subs flood them with "too many concurrent REQs"
    // and they reject the profile queries too. This guard applies even when a caller
    // explicitly targets PROFILE_RELAYS (e.g. NoteCard's reaction sub).
    const indexerSafe = isIndexerSafe(filters);

    if (relayUrls) {
      const normalized = [...new Set(relayUrls.map((u) => this.key(u)))];
      const urls = indexerSafe ? normalized : normalized.filter((u) => !INDEXER_SET.has(u));
      // Track intended URLs so deferred relays get the subscription when they connect
      this.pendingSubscriptions.set(subId, { filters, intendedUrls: urls, priority });

      let sentNow = 0;
      const notConnected: string[] = [];
      for (const url of urls) {
        let conn = this.connections.get(url);
        if (!conn && this.sessionDropped.has(url)) {
          // A fan-out relay that already struck out this session: not dialed again.
          notConnected.push(`${shortRelay(url)}:dropped`);
          continue;
        }
        if (!conn) {
          // The relay was targeted but never dialed. This is the bug behind
          // profiles stuck as hashes: PROFILE_RELAYS includes indexer-only relays
          // (purplepag.es / user.kindpag.es) that nothing else connects, so kind:0
          // REQs had nowhere to go. Dial it read-only now; forwardPendingSubscriptions
          // (re)sends the REQ once the socket opens.
          // Not a relay anyone chose (unless tierOf says otherwise): if it turns
          // out to be dead it is dropped for the session, not retried forever.
          conn = this.connect(url, "read", { transient: true });
        }
        if (conn.getStatus() === "connected") {
          conn.subscribe(subId, filters, { priority });
          sentNow++;
        } else {
          conn.subscribe(subId, filters, { priority }); // queues internally until WS opens
          notConnected.push(`${shortRelay(url)}:${conn.getStatus()}`);
        }
      }
      const kinds = [...new Set(filters.flatMap((f) => f.kinds ?? []))].join(",");
      log.debug(
        `${subId} kinds=[${kinds}] → sent to ${sentNow}/${urls.length} connected${notConnected.length ? `; waiting on: ${notConnected.join(", ")}` : ""}`,
      );
    } else {
      // No specific URLs: send to all current read relays (minus indexers unless
      // safe). Record it as a BROADCAST pending sub so a read relay that connects
      // LATER (cold start, where most read relays open after the first feed/DM
      // subs are created) still receives this REQ — previously it only ever
      // reached relays already connected at subscribe time (#24).
      this.pendingSubscriptions.set(subId, { filters, intendedUrls: [], broadcast: true, indexerSafe, priority });
      const reads = this.getReadRelays().filter((c) => indexerSafe || !INDEXER_SET.has(c.url));
      for (const conn of reads) {
        conn.subscribe(subId, filters, { priority });
      }
      const kinds = [...new Set(filters.flatMap((f) => f.kinds ?? []))].join(",");
      log.debug(`${subId} kinds=[${kinds}] → broadcast to ${reads.length} read relays`);
    }

    return subId;
  }

  /** NIP-77 reconciliation against one relay (null = unsupported / not connected). */
  negentropySync(
    url: string,
    filter: NostrFilter,
    items: Array<{ id: string; created_at: number }>,
  ): Promise<{ need: string[]; have: string[] } | null> {
    const conn = this.connections.get(this.key(url));
    if (!conn || conn.getStatus() !== "connected") return Promise.resolve(null);
    return conn.negentropySync(filter, items);
  }

  /** Where a subscription stands: how many relays track it and on how many its
   *  REQ has actually gone out. `sent === 0` means it never left the client
   *  (no relay connected, or every relay's cap was full). */
  getSubscriptionDelivery(subId: string): { relays: number; sent: number } {
    let relays = 0;
    let sent = 0;
    for (const conn of this.connections.values()) {
      if (!conn.hasSubscription(subId)) continue;
      relays++;
      if (conn.wasReqSent(subId)) sent++;
    }
    return { relays, sent };
  }

  /** Resolve true as soon as a read relay is connected (at once if one is),
   *  false if none connects within `timeout`. */
  waitForReadRelay(timeout = 4_000): Promise<boolean> {
    if (this.getReadRelays().length > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (val: boolean) => {
        clearTimeout(timer);
        this.statusWaiters.delete(waiter);
        resolve(val);
      };
      const timer = setTimeout(() => done(false), timeout);
      const waiter: RelayStatusCallback = (_url, status) => {
        if (status === "connected" && this.getReadRelays().length > 0) done(true);
      };
      this.statusWaiters.add(waiter);
    });
  }

  closeSubscription(subId: string): void {
    this.onEventCallbacks.delete(subId);
    this.onEOSECallbacks.delete(subId);
    this.pendingSubscriptions.delete(subId);
    for (const conn of this.connections.values()) {
      if (conn.hasSubscription(subId)) {
        conn.closeSubscription(subId);
      }
    }
  }

  /** Connected write relays — never a peer-only socket (connectPeer). */
  getWriteRelays(): RelayConnection[] {
    return [...this.connections.values()].filter(
      (c) =>
        (c.mode === "write" || c.mode === "read+write") &&
        c.getStatus() === "connected" &&
        !this.peerOnly.has(c.url),
    );
  }

  /** Connected read relays — never a peer-only socket (connectPeer). */
  getReadRelays(): RelayConnection[] {
    return [...this.connections.values()].filter(
      (c) =>
        (c.mode === "read" || c.mode === "read+write") &&
        c.getStatus() === "connected" &&
        !this.peerOnly.has(c.url),
    );
  }

  getAllConnections(): Map<string, RelayConnection> {
    return this.connections;
  }

  connectToBootstrap(): void {
    for (const url of BOOTSTRAP_RELAYS) {
      this.connect(url, "read+write");
    }
  }

  /** Re-attempt NIP-42 AUTH on every connection that has a pending challenge.
   *  Called after the user's signer/pubkey becomes available, to recover from
   *  the race where a relay sent its AUTH challenge before login completed. */
  replayAuth(): void {
    for (const conn of this.connections.values()) {
      conn.tryAuth();
    }
  }

  /** Suppress NIP-42 AUTH for a relay the user hasn't opted into — e.g. one
   *  dialed only to preview a group before importing it (AUTH-privacy). */
  suppressAuth(url: string): void {
    this.authSuppressed.add(this.key(url));
  }

  /** Re-allow AUTH for a relay (e.g. after the user joins a group hosted there).
   *  Pair with `replayAuth()` to answer any challenge received while suppressed. */
  allowAuth(url: string): void {
    this.authSuppressed.delete(this.key(url));
  }

  /** Wait for a specific relay to reach 'connected' status */
  waitForConnection(url: string, timeout = 10_000): Promise<boolean> {
    const k = this.key(url);
    const conn = this.connections.get(k);
    if (!conn) return Promise.resolve(false);
    if (conn.getStatus() === "connected") return Promise.resolve(true);

    return new Promise((resolve) => {
      const done = (val: boolean) => {
        clearTimeout(timer);
        this.statusWaiters.delete(waiter);
        resolve(val);
      };
      const timer = setTimeout(() => done(false), timeout);
      const waiter: RelayStatusCallback = (relayUrl, status) => {
        if (relayUrl === k && status === "connected") done(true);
      };
      this.statusWaiters.add(waiter);
    });
  }

  /** Connect to bootstrap relays and wait until at least one is connected */
  async connectToBootstrapAndWait(timeout = 10_000): Promise<void> {
    this.connectToBootstrap();

    // Check if any are already connected
    for (const url of BOOTSTRAP_RELAYS) {
      const conn = this.connections.get(url);
      if (conn?.getStatus() === "connected") return;
    }

    // Wait for any one to connect
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.statusWaiters.delete(waiter);
        resolve();
      };
      // Resolve even on timeout -- subscriptions will queue in messageQueue
      const timer = setTimeout(done, timeout);
      const waiter: RelayStatusCallback = (relayUrl, status) => {
        if (status === "connected" && BOOTSTRAP_RELAYS.includes(relayUrl)) done();
      };
      this.statusWaiters.add(waiter);
    });
  }

  connectFromConfig(configs: RelayConfig[]): void {
    for (const cfg of configs) {
      // Honor the local disable list for config-driven connects (transient
      // feature dials use connect() directly and stay permissive).
      if (this.userDisabled.has(this.key(cfg.url))) continue;
      this.connect(cfg.url, cfg.mode);
    }
  }

  /** Replace the set of locally-disabled relays (normalized). No side effects —
   *  callers decide whether to disconnect (setRelayDisabled in relayList.ts). */
  setUserDisabledRelays(urls: string[]): void {
    this.userDisabled = new Set(urls.map((u) => this.key(u)));
  }

  /** Reconcile live connections with the user's relay list (NIP-65):
   *  - connects new entries (skipping locally-disabled ones)
   *  - recreates connections whose mode changed (RelayConnection.mode is
   *    readonly; pendingSubscriptions forwarding re-sends subs on reconnect)
   *  - disconnects relays dropped since the previous reconcile
   *  - with `pruneBootstrap`, disconnects bootstrap relays absent from a
   *    non-empty list.
   *
   *  APP_RELAY is sticky: it is the platform relay (space host chat, DM relays,
   *  profile lookups, NIP-29 group metadata) that most features hinge on, so it
   *  is never pruned, dropped, or recreated-on-mode-change here regardless of
   *  whether the user's published NIP-65 list happens to include it. It used to
   *  be churned on every kind:10002 reconcile, and the relay then re-flooded its
   *  100-sub cap on each reconnect ("subscription cap reached" → dropped socket
   *  → "network connection was lost" death spiral). See commit 8fcaf79.
   */
  reconcileUserRelays(
    entries: RelayConfig[],
    opts: { pruneBootstrap?: boolean } = {},
  ): void {
    const newMap = new Map<string, RelayMode>();
    for (const e of entries) {
      const k = normalizeRelayUrl(e.url);
      if (k) newMap.set(k, e.mode); // dedupe: last entry wins
    }

    const appRelayKey = this.key(APP_RELAY);

    for (const [url, mode] of newMap) {
      if (this.userDisabled.has(url)) {
        if (this.connections.has(url)) this.disconnect(url);
        continue;
      }
      const existing = this.connections.get(url);
      // Recreate on a mode change — but NOT for APP_RELAY (sticky), and NOT
      // while the socket is still mid-handshake ("connecting"): tearing it down
      // there is what produced "WS closed between sign and send, dropping AUTH".
      // A later reconcile re-evaluates the mode once it has settled.
      if (
        existing &&
        existing.mode !== mode &&
        url !== appRelayKey &&
        existing.getStatus() !== "connecting"
      ) {
        this.disconnect(url); // mode changed → recreate
      }
      this.connect(url, mode);
    }

    // Disconnect relays dropped from the user list since the last reconcile
    // (never APP_RELAY — it is not governed by the user's NIP-65 list).
    for (const url of this.userRelayUrls) {
      if (url !== appRelayKey && !newMap.has(url)) this.disconnect(url);
    }

    if (opts.pruneBootstrap && newMap.size > 0) {
      for (const b of BOOTSTRAP_RELAYS) {
        const k = this.key(b);
        if (k !== appRelayKey && !newMap.has(k) && this.connections.has(k)) {
          this.disconnect(k);
        }
      }
    }

    this.userRelayUrls = new Set(newMap.keys());
  }

  /**
   * Publish an event and wait for OK responses from relays.
   * Resolves with relay responses when all relays respond or timeout.
   */
  publishWithConfirmation(
    event: NostrEvent,
    targets?: string[],
    timeout = 10_000,
  ): Promise<{ relayUrl: string; success: boolean; message: string }[]> {
    const relays = targets
      ? targets
          .map((url) => this.connections.get(this.key(url)))
          .filter((c): c is RelayConnection => !!c)
      : this.getWriteRelays();

    if (relays.length === 0) {
      return Promise.resolve([]);
    }

    return new Promise((resolve) => {
      const results: { relayUrl: string; success: boolean; message: string }[] = [];
      const pending = new Set(relays.map((c) => c.url));
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.publishOKCallbacks.delete(event.id);
        resolve(results);
      };

      this.publishOKCallbacks.set(event.id, (relayUrl, success, message) => {
        if (!pending.has(relayUrl)) return;
        results.push({ relayUrl, success, message });
        pending.delete(relayUrl);
        if (pending.size === 0) finish();
      });

      for (const conn of relays) {
        conn.publish(event);
      }

      const timer = setTimeout(finish, timeout);
    });
  }

  /**
   * Publish like `publish` (same targets, same count), and report whether a
   * relay that COUNTS took it: `accepted` resolves with that relay's URL at
   * the first OK true (or a `duplicate:` refusal — the relay already holds
   * it), and with null once every counting relay refused or `timeout` passed
   * without one. `countAs` names the relays whose OK counts (default: every
   * target); for a DM that is the platform relay — the only one the push
   * ingester and the phone read — plus the recipient's kind-10050 relays, so
   * a public relay's OK alone leaves the send pending. A socket that is
   * reconnecting queues the event, so the count alone proves nothing.
   *
   * `outcome` settles later — when every target answered, or at the timeout —
   * with each target's verdict, so a caller can see that the platform relay
   * refused even though another relay accepted (no push will follow).
   */
  publishTracked(
    event: NostrEvent,
    targets?: string[],
    opts: { timeout?: number; countAs?: string[] } = {},
  ): TrackedPublish {
    const timeout = opts.timeout ?? 10_000;
    const relays = targets
      ? targets
          .map((url) => this.connections.get(this.key(url)))
          .filter((c): c is RelayConnection => !!c)
      : this.getWriteRelays();
    if (relays.length === 0) {
      return { sent: 0, accepted: Promise.resolve(null), outcome: Promise.resolve({ acceptedBy: null, byRelay: {} }) };
    }

    const countKeys = opts.countAs ? new Set(opts.countAs.map((u) => this.key(u))) : null;
    const byUrl = new Map(relays.map((c) => [c.url, c]));
    const waiting = new Set(relays.filter((c) => !countKeys || countKeys.has(this.key(c.url))).map((c) => c.url));
    const byRelay: Record<string, PublishVerdict> = {};
    for (const c of relays) byRelay[c.url] = "silent";

    let resolveAccepted!: (relay: string | null) => void;
    let resolveOutcome!: (o: PublishOutcome) => void;
    const accepted = new Promise<string | null>((r) => { resolveAccepted = r; });
    const outcome = new Promise<PublishOutcome>((r) => { resolveOutcome = r; });

    let acceptedBy: string | null = null;
    let acceptedSettled = false;
    const settleAccepted = (relay: string | null) => {
      if (acceptedSettled) return;
      acceptedSettled = true;
      acceptedBy = relay;
      resolveAccepted(relay);
    };
    // `OK false rate-limited:` (docs/DM_WIRE_CONTRACT.md §7.7): the relay did
    // NOT store the event and wants it again later. Re-send with backoff
    // inside the send window; the relay stays silent (neither sent nor
    // failed) until it answers otherwise or the timeout passes.
    const rateRetries = new Map<string, number>();
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();
    const finishAll = () => {
      clearTimeout(timer);
      for (const t of retryTimers) clearTimeout(t);
      this.publishOKCallbacks.delete(event.id);
      settleAccepted(null);
      resolveOutcome({ acceptedBy, byRelay: { ...byRelay } });
    };
    // No relay whose OK could count is even a target: it can never be sent.
    if (waiting.size === 0) settleAccepted(null);

    this.publishOKCallbacks.set(event.id, (relayUrl, success, message) => {
      if (byRelay[relayUrl] !== "silent") return; // not a target, or answered already
      if (success || message.startsWith("duplicate:")) {
        byRelay[relayUrl] = "accepted";
        if (waiting.delete(relayUrl)) settleAccepted(relayUrl);
      } else if (PUBLISH_RATE_LIMITED_RE.test(message) && (rateRetries.get(relayUrl) ?? 0) < PUBLISH_RATE_LIMITED_RETRIES) {
        const n = (rateRetries.get(relayUrl) ?? 0) + 1;
        rateRetries.set(relayUrl, n);
        const conn = byUrl.get(relayUrl)!;
        const t = setTimeout(() => {
          retryTimers.delete(t);
          conn.publish(event);
        }, PUBLISH_RATE_LIMITED_BASE_MS * 2 ** (n - 1));
        retryTimers.add(t);
        return; // still waiting on this relay
      } else {
        byRelay[relayUrl] = "refused";
        if (waiting.delete(relayUrl) && waiting.size === 0) settleAccepted(null);
      }
      if (Object.values(byRelay).every((v) => v !== "silent")) finishAll();
    });
    const timer = setTimeout(finishAll, timeout);
    for (const conn of relays) conn.publish(event);
    return { sent: relays.length, accepted, outcome };
  }

  /** Fetch NIP-11 relay info document to learn subscription limits.
   *  Non-blocking — if it fails, the default cap is used. */
  private async fetchNip11(url: string, conn: RelayConnection): Promise<void> {
    try {
      const httpUrl = url.replace("wss://", "https://").replace("ws://", "http://");
      const response = await fetch(httpUrl, {
        headers: { Accept: "application/nostr+json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const info = await response.json();
      const maxSubs = info?.limitation?.max_subscriptions;
      if (typeof maxSubs === "number" && maxSubs > 0) {
        conn.setMaxSubscriptions(maxSubs);
      }
    } catch {
      // NIP-11 not available — use default cap
    }
  }

  /** Forward pending subscriptions to a newly-connected relay */
  private forwardPendingSubscriptions(relayUrl: string, conn: RelayConnection): void {
    const isReadRelay = conn.mode === "read" || conn.mode === "read+write";
    let forwarded = 0;
    for (const [subId, pending] of this.pendingSubscriptions) {
      if (conn.hasSubscription(subId)) continue;
      if (!this.onEventCallbacks.has(subId)) continue;
      if (pending.broadcast) {
        // Broadcast subs go to any read relay allowed to carry them — never a
        // peer-only socket (connectPeer), whatever its mode.
        if (!isReadRelay || this.peerOnly.has(relayUrl)) continue;
        if (!pending.indexerSafe && INDEXER_SET.has(relayUrl)) continue;
      } else if (!pending.intendedUrls.includes(relayUrl)) {
        continue;
      }
      conn.subscribe(subId, pending.filters, { priority: pending.priority });
      forwarded++;
    }
    if (forwarded > 0) {
      log.debug(`forwarded ${forwarded} pending subs to ${shortRelay(relayUrl)} on connect`);
    }
  }
}

/** One target relay's answer to a tracked publish. */
export type PublishVerdict = "accepted" | "refused" | "silent";
export interface PublishOutcome {
  /** The counting relay whose OK settled the send, or null. */
  acceptedBy: string | null;
  /** Every target relay's verdict (keys are the connection URLs as dialed). */
  byRelay: Record<string, PublishVerdict>;
}
export interface TrackedPublish {
  sent: number;
  accepted: Promise<string | null>;
  outcome: Promise<PublishOutcome>;
}

/** `OK false rate-limited:` re-sends inside publishTracked's window (§7.7). */
const PUBLISH_RATE_LIMITED_RE = /^rate-limited\s*:/i;
const PUBLISH_RATE_LIMITED_RETRIES = 3;
const PUBLISH_RATE_LIMITED_BASE_MS = 1_500;

/** Singleton relay manager */
export const relayManager = new RelayManagerImpl();
