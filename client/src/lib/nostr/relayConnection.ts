import type { NostrEvent, NostrFilter, RelayMessage, ClientMessage } from "../../types/nostr";
import { Negentropy, NegentropyStorageVector } from "@ishtarservices/core";
import type { RelayMode, RelayStatus } from "../../types/relay";
import type { RelayEOSECallback, RelayOKCallback, RelayStatusCallback } from "./types";
import { computeBackoff, isStruckOut, maxDelayFor, StormDetector, type RelayTier } from "./reconnect";
import { RECONNECT } from "./constants";
import { createLogger } from "../debug/logger";

const log = createLogger("relay");

/** Compact filter description for logs: "kinds=[0] authors=42 #p=1". */
function summarizeFilters(filters: NostrFilter[]): string {
  return filters
    .map((f) => {
      const parts: string[] = [];
      if (f.kinds) parts.push(`kinds=[${f.kinds.join(",")}]`);
      if (f.authors) parts.push(`authors=${f.authors.length}`);
      for (const key of Object.keys(f)) {
        if (key.startsWith("#")) {
          const v = (f as Record<string, unknown>)[key];
          if (Array.isArray(v)) parts.push(`${key}=${v.length}`);
        }
      }
      if (f.limit != null) parts.push(`limit=${f.limit}`);
      if (f.since != null) parts.push(`since=${f.since}`);
      return parts.join(" ");
    })
    .join(" | ");
}

/** Internal callback that includes the subscription ID for routing */
type InternalEventCallback = (subId: string, event: NostrEvent, relayUrl: string) => void;

/** Default subscription cap per relay if NIP-11 doesn't specify one.
 *  Sized for users in many spaces: bg chat sub per joined space + a handful of
 *  priority subs (relay list, DM, gift wrap, music, followers). 100 leaves
 *  comfortable headroom; per-relay NIP-11 can still narrow this. */
const DEFAULT_MAX_SUBS = 100;

/** Slots of a relay's cap that only priority (user-initiated) subscriptions may
 *  take. Standing subs stop at `cap - reserve`, so a "load more" the user just
 *  asked for always has a free slot instead of waiting in the deferred queue
 *  behind background subs. Tiny caps reserve less so they stay usable. */
export function reservedSlots(maxSubscriptions: number): number {
  if (maxSubscriptions >= 20) return 2;
  if (maxSubscriptions >= 5) return 1;
  return 0;
}

interface DeferredSub {
  subId: string;
  filters: NostrFilter[];
  priority: boolean;
}

/** Wedge-safety: if a challenged relay never completes AUTH (signer offline),
 *  release held REQs after this long so subscriptions don't hang forever. */
const AUTH_WEDGE_MS = 3000;

/** Max times a sub is re-deferred after a server CLOSED "too many subscriptions"
 *  before we give up — bounds the retry even if a relay's real cap is below ours. */
const MAX_CLOSED_RETRIES = 3;
/** A `CLOSED rate-limited:` / `CLOSED error:` (docs/DM_WIRE_CONTRACT.md §7.7)
 *  means the REQ was not registered and the relay wants it again later: re-REQ
 *  with exponential backoff, this many times, before giving the sub up. */
const MAX_RETRYABLE_CLOSED = 5;
const RETRYABLE_CLOSED_BASE_MS = 1_000;
const RETRYABLE_CLOSED_MAX_MS = 30_000;
const RETRYABLE_CLOSED_RE = /^(rate-limited|error)\s*:/i;

interface NegSession {
  neg: Negentropy;
  need: string[];
  have: string[];
  resolve: (r: { need: string[]; have: string[] } | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RelayConnection {
  readonly url: string;
  readonly mode: RelayMode;

  private ws: WebSocket | null = null;
  private status: RelayStatus = "disconnected";
  /** Reconnects scheduled since the last stable connection (drives the delay). */
  private reconnectAttempts = 0;
  /** Consecutive failed connects: never opened, timed out, or opened and
   *  closed again before STABLE_AFTER. Reset by a stable connection and by
   *  resetBackoff() (browser `online`). */
  private strikes = 0;
  /** The current socket has stayed open for STABLE_AFTER. */
  private stable = false;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<string, NostrFilter[]>();
  private pendingEOSE = new Set<string>();
  private messageQueue: ClientMessage[] = [];
  private latencyMs = 0;
  private pingStart = 0;
  private eventCount = 0;

  /** Per-relay subscription cap (from NIP-11 or default). */
  private maxSubscriptions = DEFAULT_MAX_SUBS;
  /** Overflow queue: subs that couldn't be sent because we're at the cap. */
  private deferredSubs: DeferredSub[] = [];
  /** User-initiated subs (pagination): may use the reserved slots and jump the
   *  deferred queue. */
  private prioritySubs = new Set<string>();
  /** Subs whose REQ has been written to a socket at least once. Lets callers
   *  tell "asked and got nothing" from "never left the client". */
  private reqSent = new Set<string>();
  /** Warn once per connection lifetime when the cap is first hit. Silent
   *  deferral was the failure mode that hid the original NIP-29 chat bug —
   *  surface it so future regressions don't quietly queue forever. */
  private hasWarnedDeferral = false;
  /** subId → number of times re-deferred after a server CLOSED "too many
   *  subscriptions". Cleared on EOSE (success) or close. Bounds the retry (#A5). */
  private closedRetries = new Map<string, number>();
  /** subId → pending re-REQ timer after a retryable CLOSED (§7.7). */
  private reqRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Callbacks
  private onEvent: InternalEventCallback | null = null;
  private onEOSE: RelayEOSECallback | null = null;
  private onOK: RelayOKCallback | null = null;
  private onStatusChange: RelayStatusCallback | null = null;
  /** NIP-42 AUTH callback: receives (challenge, relayUrl) and should return a signed kind:22242 event */
  private onAuth: ((challenge: string, relayUrl: string) => Promise<NostrEvent | null>) | null = null;
  /** Last AUTH challenge from this relay that hasn't been answered successfully yet.
   *  Cached so we can replay AUTH after the user's signer becomes available
   *  (when the relay connects before login completes). */
  private pendingAuthChallenge: string | null = null;
  private stormDetector: StormDetector;
  /** How hard to hold on to this relay; asked at failure time because a relay
   *  can be promoted (the user adds it) while it is backing off. Defaults to
   *  never dropping. */
  private getTier: (() => RelayTier) | null = null;
  /** Called when a transient relay strikes out. Returns true if the owner
   *  dropped this connection (it must not schedule another dial). */
  private onStrikeOut: (() => boolean) | null = null;

  // ── REQ-AUTH cold-start race (NIP29_CHAT Phase 3) ──────────────────────
  // A relay that requires NIP-42 returns ZERO h-tagged history to a REQ that
  // arrives before AUTH completes. On (re)connect we send REQs in onopen,
  // *before* the buffered AUTH challenge is processed — so private/space history
  // came back empty. Fix: once a relay has challenged us, hold REQs on each
  // subsequent connect until AUTH succeeds (or a wedge timeout). Only engaged
  // when an `onAuth` handler exists AND the relay has challenged before, so
  // non-AUTH relays (and tests without onAuth) pay nothing.
  private reqGate: "open" | "holding" = "open";
  private heldReqs = new Map<string, NostrFilter[]>();
  private everChallenged = false;
  private authWedgeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Event id of the last AUTH (kind:22242) we sent, to match its OK. */
  private lastAuthEventId: string | null = null;

  // ── NIP-77 negentropy sessions (docs/DM_WIRE_CONTRACT.md §7.5) ──
  private negSessions = new Map<string, NegSession>();
  private negCounter = 0;
  /** Set once this relay answers NEG-OPEN with "unknown message type" —
   *  further reconciliations short-circuit to null (since-window fallback). */
  private negUnsupported = false;

  /** Short relay name for logging (computed once). */
  private shortUrl: string;

  constructor(url: string, mode: RelayMode, stormDetector: StormDetector) {
    this.url = url;
    this.mode = mode;
    this.stormDetector = stormDetector;
    this.shortUrl = url.replace("wss://", "").replace("ws://", "").replace(/\/$/, "");
  }

  setCallbacks(cbs: {
    onEvent?: InternalEventCallback;
    onEOSE?: RelayEOSECallback;
    onOK?: RelayOKCallback;
    onStatusChange?: RelayStatusCallback;
    onAuth?: (challenge: string, relayUrl: string) => Promise<NostrEvent | null>;
    getTier?: () => RelayTier;
    onStrikeOut?: () => boolean;
  }) {
    if (cbs.onEvent) this.onEvent = cbs.onEvent;
    if (cbs.onEOSE) this.onEOSE = cbs.onEOSE;
    if (cbs.onOK) this.onOK = cbs.onOK;
    if (cbs.onStatusChange) this.onStatusChange = cbs.onStatusChange;
    if (cbs.onAuth) this.onAuth = cbs.onAuth;
    if (cbs.getTier) this.getTier = cbs.getTier;
    if (cbs.onStrikeOut) this.onStrikeOut = cbs.onStrikeOut;
  }

  /** Dial the relay. A no-op while a socket exists or a retry is already
   *  scheduled: callers all over the app call this "to be sure" before
   *  publishing, and that must not bypass the backoff of a relay that is down. */
  connect(): void {
    if (this.ws || this.reconnectTimer) return;
    this.open();
  }

  private open(): void {
    this.setStatus("connecting");
    this.pingStart = Date.now();
    this.stable = false;

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.setStatus("error", "Failed to create WebSocket");
      this.handleDrop();
      return;
    }
    this.ws = ws;

    // Every handler checks it still belongs to the current socket: an
    // abandoned one (connect timeout) must not touch the state of its successor.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.ws !== ws || ws.readyState === WebSocket.OPEN) return;
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close();
      this.ws = null;
      this.setStatus("error", "Connect timed out");
      this.setStatus("disconnected");
      this.handleDrop();
    }, RECONNECT.CONNECT_TIMEOUT);

    let opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.clearConnectTimer();
      this.latencyMs = Date.now() - this.pingStart;
      // Only a connection that lasts counts as a success (see STABLE_AFTER).
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        this.stable = true;
        this.strikes = 0;
        this.reconnectAttempts = 0;
      }, RECONNECT.STABLE_AFTER);
      // Hold REQs until AUTH if this relay is known to require it (see reqGate).
      this.maybeBeginAuthHold();
      this.flushQueue();
      // Re-send our own subs BEFORE announcing "connected": the status callback
      // makes relayManager forward pending subscriptions, which skips subs we
      // already track — announcing first made it forward+send them and then
      // resubscribe() re-sent the same REQs (double-send per sub).
      this.resubscribe();
      this.setStatus("connected");
    };

    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(e.data as string) as RelayMessage;
        this.handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.setStatus("error", "WebSocket error");
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearConnectTimer();
      this.failAllNeg();
      // Old AUTH challenge is invalid for the next session; clear it so we
      // don't replay a stale challenge that the relay will reject.
      this.pendingAuthChallenge = null;
      // Reset the REQ gate for the next connection (everChallenged persists so
      // the reconnect re-holds; heldReqs are rebuilt by resubscribe()).
      this.reqGate = "open";
      this.heldReqs.clear();
      this.lastAuthEventId = null;
      if (this.authWedgeTimer) {
        clearTimeout(this.authWedgeTimer);
        this.authWedgeTimer = null;
      }
      if (this.status !== "disconnected") {
        // A storm is several live connections dropping together. A dial that
        // never opened is not one: dead relays failing over and over used to
        // keep the detector tripped and held every healthy relay's reconnect
        // to the storm cooldown.
        if (opened) this.stormDetector.recordDisconnect();
        this.setStatus("disconnected");
        this.handleDrop();
      }
    };
  }

  /** The socket is gone (or never came up): count the strike and decide
   *  between another dial and giving up. */
  private handleDrop(): void {
    this.clearConnectTimer();
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    if (this.stable) {
      // A healthy connection dropped: not a failed connect.
      this.stable = false;
    } else {
      this.strikes++;
      if (isStruckOut(this.strikes)) {
        if (this.tier() === "transient" && this.onStrikeOut?.()) return; // dropped for the session
        if (this.strikes === RECONNECT.STRIKE_LIMIT) {
          log.info(`${this.shortUrl} unreachable after ${this.strikes} attempts, backing off`);
        }
      }
    }
    this.scheduleReconnect();
  }

  private tier(): RelayTier {
    return this.getTier?.() ?? "pinned";
  }

  /** No socket and no retry scheduled: connect() would dial right now. */
  isIdle(): boolean {
    return !this.ws && !this.reconnectTimer;
  }

  /** Consecutive failed connects so far (0 once a connection has held). */
  getStrikes(): number {
    return this.strikes;
  }

  /** Forget past failures (the browser came back online, or the network is
   *  evidently back). Cancels a pending retry; returns true when the caller
   *  should dial now, false when a socket is already up or on its way. */
  resetBackoff(): boolean {
    this.strikes = 0;
    this.reconnectAttempts = 0;
    if (this.ws) return false;
    if (!this.reconnectTimer) return false; // never dialed, or already given up on
    this.clearReconnectTimer();
    return true;
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.clearConnectTimer();
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.stable = false;
    this.setStatus("disconnected");
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.subscriptions.clear();
    this.pendingEOSE.clear();
    this.messageQueue = [];
    this.deferredSubs = [];
    this.prioritySubs.clear();
    this.reqSent.clear();
    this.closedRetries.clear();
    for (const t of this.reqRetryTimers.values()) clearTimeout(t);
    this.reqRetryTimers.clear();
    this.pendingAuthChallenge = null;
    this.reqGate = "open";
    this.heldReqs.clear();
    this.lastAuthEventId = null;
    if (this.authWedgeTimer) {
      clearTimeout(this.authWedgeTimer);
      this.authWedgeTimer = null;
    }
  }

  /** Re-send a still-tracked subscription's REQ after `delay` (one timer per sub). */
  private scheduleReqRetry(subId: string, delay: number): void {
    this.clearReqRetry(subId);
    const timer = setTimeout(() => {
      this.reqRetryTimers.delete(subId);
      const filters = this.subscriptions.get(subId);
      if (!filters) return; // closed locally in the meantime
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return; // resubscribe() covers reconnects
      this.pendingEOSE.add(subId);
      this.sendReq(subId, filters);
    }, delay);
    this.reqRetryTimers.set(subId, timer);
  }

  private clearReqRetry(subId: string): void {
    const t = this.reqRetryTimers.get(subId);
    if (t) {
      clearTimeout(t);
      this.reqRetryTimers.delete(subId);
    }
  }

  /** Send a REQ, or hold it if the AUTH gate is engaged (see reqGate). */
  private sendReq(subId: string, filters: NostrFilter[]): void {
    if (this.reqGate === "holding") {
      this.heldReqs.set(subId, filters); // last filters win; dedup by subId
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      log.debug(`${this.shortUrl} REQ ${subId} ${summarizeFilters(filters)}`);
      this.ws.send(JSON.stringify(["REQ", subId, ...filters]));
      this.reqSent.add(subId);
    }
  }

  /** On (re)connect, hold REQs if this relay is known to require AUTH. */
  private maybeBeginAuthHold(): void {
    // No signer wired, or the relay has never challenged us → no point holding
    // (sending REQs immediately is correct for non-AUTH relays).
    if (!this.onAuth || !this.everChallenged) {
      this.reqGate = "open";
      return;
    }
    this.reqGate = "holding";
    if (this.authWedgeTimer) clearTimeout(this.authWedgeTimer);
    this.authWedgeTimer = setTimeout(() => this.releaseReqGate(), AUTH_WEDGE_MS);
  }

  /** Open the gate and flush any held REQs (on AUTH success or the wedge timeout). */
  private releaseReqGate(): void {
    if (this.reqGate === "open") return;
    this.reqGate = "open";
    if (this.authWedgeTimer) {
      clearTimeout(this.authWedgeTimer);
      this.authWedgeTimer = null;
    }
    const held = [...this.heldReqs];
    this.heldReqs.clear();
    for (const [subId, filters] of held) {
      // A sub may have been closed while held.
      if (this.subscriptions.has(subId)) this.sendReq(subId, filters);
    }
  }

  /** Attempt to answer the cached AUTH challenge. Safe to call multiple times.
   *  Used both at challenge-receipt time and after login, to handle the case
   *  where the relay connected before the user's signer was ready. */
  tryAuth(): void {
    const challenge = this.pendingAuthChallenge;
    const wsOpen = this.ws?.readyState === WebSocket.OPEN;
    // No challenge cached, callback not wired, or WS not open: caller will
    // retry on the next replay. Silent — `replayAuth` already logs a summary.
    if (!challenge || !this.onAuth || !wsOpen) return;

    this.onAuth(challenge, this.url).then((signedEvent) => {
      if (!signedEvent) {
        // Common during cold-start: relay challenged before signer is ready.
        // Subsequent replayAuth call (post-login) will succeed.
        return;
      }
      if (this.ws?.readyState !== WebSocket.OPEN) {
        console.warn(`[auth] ${this.shortUrl} WS closed between sign and send, dropping AUTH`);
        return;
      }
      // Verify challenge hasn't been superseded between the await and now.
      if (this.pendingAuthChallenge !== challenge) {
        console.warn(`[auth] ${this.shortUrl} challenge superseded mid-sign, dropping`);
        return;
      }
      this.ws.send(JSON.stringify(["AUTH", signedEvent]));
      this.pendingAuthChallenge = null;
      // Remember the AUTH event id so the matching OK releases the REQ gate.
      this.lastAuthEventId = signedEvent.id;
    }).catch((err) => {
      console.warn(`[auth] ${this.shortUrl} AUTH error`, err);
    });
  }

  /**
   * NIP-77 set reconciliation: tell the relay which `(created_at, id)` pairs we
   * hold for `filter`; resolves with the ids we lack (`need`) and the ids the
   * relay lacks (`have`). Resolves null when the relay doesn't speak NEG-*,
   * errors, or times out — callers fall back to a since-window REQ.
   */
  negentropySync(
    filter: NostrFilter,
    items: Array<{ id: string; created_at: number }>,
    timeoutMs = 15_000,
  ): Promise<{ need: string[]; have: string[] } | null> {
    if (this.negUnsupported || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve(null);
    }
    const storage = new NegentropyStorageVector();
    for (const it of items) storage.insert(it.created_at, it.id);
    storage.seal();
    const neg = new Negentropy(storage, 60_000);
    const id = `neg_${++this.negCounter}_${Date.now().toString(36)}`;
    let initial: string;
    try {
      initial = neg.initiate();
    } catch {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishNeg(id, null), timeoutMs);
      this.negSessions.set(id, { neg, need: [], have: [], resolve, timer });
      this.ws!.send(JSON.stringify(["NEG-OPEN", id, filter, initial]));
    });
  }

  private finishNeg(id: string, result: { need: string[]; have: string[] } | null): void {
    const session = this.negSessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    this.negSessions.delete(id);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(["NEG-CLOSE", id]));
    }
    session.resolve(result);
  }

  private failAllNeg(): void {
    for (const id of [...this.negSessions.keys()]) this.finishNeg(id, null);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.messageQueue.push(msg);
    }
  }

  /** Update the subscription cap (called after fetching NIP-11). */
  setMaxSubscriptions(max: number): void {
    this.maxSubscriptions = max;
  }

  /** Subs currently counted against the relay's cap (sent, or to be sent on
   *  connect): all of them, and the standing (non-priority) ones. */
  private sentCounts(): { total: number; standing: number } {
    let deferredPriority = 0;
    for (const d of this.deferredSubs) if (d.priority) deferredPriority++;
    const total = this.subscriptions.size - this.deferredSubs.length;
    return { total, standing: total - (this.prioritySubs.size - deferredPriority) };
  }

  /** Whether one more sub of this class fits, given the counts WITHOUT it.
   *  Standing subs may hold at most `cap − reserve` slots; a priority request
   *  may take any free slot up to the cap. */
  private fits(priority: boolean, counts: { total: number; standing: number }): boolean {
    if (counts.total >= this.maxSubscriptions) return false;
    return priority || counts.standing < this.maxSubscriptions - reservedSlots(this.maxSubscriptions);
  }

  /** Queue a sub that cannot be sent yet. Priority subs go ahead of every
   *  standing sub (and behind earlier priority ones). */
  private defer(sub: DeferredSub): void {
    if (this.deferredSubs.some((d) => d.subId === sub.subId)) return;
    if (!sub.priority) {
      this.deferredSubs.push(sub);
    } else {
      const firstNormal = this.deferredSubs.findIndex((d) => !d.priority);
      this.deferredSubs.splice(firstNormal === -1 ? this.deferredSubs.length : firstNormal, 0, sub);
    }
    this.warnIfFirstDeferral();
  }

  /**
   * Track a subscription and send its REQ when the relay's cap allows.
   * `priority` marks a request the user is waiting on (pagination): it may use
   * the reserved slots, and if even those are taken it goes to the front of
   * the deferred queue.
   */
  subscribe(subId: string, filters: NostrFilter[], opts: { priority?: boolean } = {}): void {
    const priority = opts.priority === true;
    this.subscriptions.set(subId, filters);
    this.pendingEOSE.add(subId);
    if (priority) this.prioritySubs.add(subId);
    else this.prioritySubs.delete(subId);

    // Enforce per-relay subscription cap — defer if sending this one would exceed it.
    // The counts are post-set (they already include this sub), so take it out.
    const counts = this.sentCounts();
    counts.total--;
    if (!priority) counts.standing--;
    if (!this.fits(priority, counts)) {
      this.defer({ subId, filters, priority });
      return;
    }

    // Send REQ if connected (held by the AUTH gate if engaged); otherwise
    // resubscribe() handles it on connect. Do NOT queue REQs — that causes
    // double-sends when flushQueue + resubscribe both fire.
    this.sendReq(subId, filters);
  }

  /** True once this sub's REQ has actually been written to a socket. */
  wasReqSent(subId: string): boolean {
    return this.reqSent.has(subId);
  }

  /** Ids of every subscription tracked on this connection. */
  getSubscriptionIds(): string[] {
    return [...this.subscriptions.keys()];
  }

  closeSubscription(subId: string): void {
    this.subscriptions.delete(subId);
    this.pendingEOSE.delete(subId);
    this.prioritySubs.delete(subId);
    this.reqSent.delete(subId);
    this.closedRetries.delete(subId);
    this.clearReqRetry(subId);
    // Remove from deferred queue if it was never sent
    this.deferredSubs = this.deferredSubs.filter((d) => d.subId !== subId);
    // Drop it from the AUTH hold queue too (so release doesn't resurrect it).
    this.heldReqs.delete(subId);
    this.send(["CLOSE", subId]);
    // A slot opened — drain the next deferred sub
    this.drainDeferred();
  }

  /** Warn once per connection lifetime when the subscription cap is hit.
   *  The original NIP-29 chat bug presented as "messages don't show up" because
   *  the channel REQ silently sat in `deferredSubs` after the cap was reached.
   *  Surfacing this makes that class of failure self-diagnosing in console. */
  private warnIfFirstDeferral(): void {
    if (this.hasWarnedDeferral) return;
    this.hasWarnedDeferral = true;
    console.warn(
      `[relay] ${this.shortUrl} subscription cap (${this.maxSubscriptions}) reached — new subs deferred until a slot opens`,
    );
  }

  /** Send the next deferred subscription if a slot is available. The queue
   *  holds priority subs first, so they are also the first to drain. */
  private drainDeferred(): void {
    if (this.deferredSubs.length === 0) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const next = this.deferredSubs[0];
    // The sub may have been closed while deferred
    if (!this.subscriptions.has(next.subId)) {
      this.deferredSubs.shift();
      this.drainDeferred(); // try next
      return;
    }
    if (!this.fits(next.priority, this.sentCounts())) return;

    this.deferredSubs.shift();
    this.sendReq(next.subId, next.filters);
  }

  publish(event: NostrEvent): void {
    this.send(["EVENT", event]);
  }

  getStatus(): RelayStatus {
    return this.status;
  }

  getLatency(): number {
    return this.latencyMs;
  }

  getEventCount(): number {
    return this.eventCount;
  }

  hasSubscription(subId: string): boolean {
    return this.subscriptions.has(subId);
  }

  private handleMessage(msg: RelayMessage): void {
    switch (msg[0]) {
      case "EVENT": {
        this.eventCount++;
        this.onEvent?.(msg[1], msg[2], this.url);
        break;
      }
      case "EOSE": {
        this.pendingEOSE.delete(msg[1]);
        this.closedRetries.delete(msg[1]); // succeeded — reset any retry counter
        this.onEOSE?.(msg[1], this.url);
        break;
      }
      case "OK": {
        // If this OK acknowledges our AUTH event, AUTH succeeded — release any
        // REQs we held waiting for it.
        if (msg[1] === this.lastAuthEventId) {
          this.lastAuthEventId = null;
          if (msg[2] === true) this.releaseReqGate();
        }
        this.onOK?.(msg[1], msg[2], msg[3], this.url);
        break;
      }
      case "NOTICE": {
        const text = String(msg[1] ?? "");
        // Our relay: "unknown message type: NEG-OPEN"; strfry: "bad msg: negentropy
        // disabled" — either way this relay won't reconcile, fall back.
        if (this.negSessions.size > 0 && /NEG-|negentropy/i.test(text)) {
          this.negUnsupported = true;
          this.failAllNeg();
          break;
        }
        console.warn(`[Relay ${this.shortUrl}] NOTICE: ${text}`);
        break;
      }
      case "NEG-MSG": {
        const session = this.negSessions.get(msg[1] as string);
        if (!session) break;
        try {
          const next = session.neg.reconcile(
            msg[2] as string,
            (id) => session.have.push(id),
            (id) => session.need.push(id),
          );
          if (next === null) {
            this.finishNeg(msg[1] as string, { need: session.need, have: session.have });
          } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(["NEG-MSG", msg[1], next]));
          }
        } catch (err) {
          console.warn(`[Relay ${this.shortUrl}] NEG-MSG error`, err);
          this.finishNeg(msg[1] as string, null);
        }
        break;
      }
      case "NEG-ERR": {
        console.warn(`[Relay ${this.shortUrl}] NEG-ERR ${msg[1]}: ${msg[2]}`);
        this.finishNeg(msg[1] as string, null);
        break;
      }
      case "CLOSED": {
        // Surface unexpected server-side closes (cap exceeded, rate-limited, etc.).
        // An empty reason is the normal response to our own CLOSE — not noteworthy.
        const subId = msg[1];
        const reason = (msg[2] ?? "").toString();
        if (reason) {
          console.warn(`[relay] ${this.shortUrl} CLOSED ${subId}: ${reason}`);
        }
        // "too many subscriptions" is recoverable — the relay is momentarily full.
        // Re-defer the sub (bounded) so it's re-sent when a local slot frees,
        // instead of silently dropping it and letting the 5 s EOSE backstop mask
        // an empty result (the original NIP-29 "messages don't show up" signature).
        // drainDeferred only fires on a real closeSubscription(), so this can't
        // busy-loop; MAX_CLOSED_RETRIES bounds it even if a relay's real cap is
        // below ours. Safe because the client cap is kept in lockstep with relays.
        // NIP-42 `auth-required:` (e.g. a kind-1059 REQ sent before AUTH
        // completed — docs/DM_WIRE_CONTRACT.md §7.1). Keep the sub tracked,
        // hold it until the AUTH OK (or the wedge timeout) and re-send it.
        if (/^auth-required/i.test(reason) && this.subscriptions.has(subId)) {
          this.everChallenged = true;
          this.pendingEOSE.delete(subId);
          this.heldReqs.set(subId, this.subscriptions.get(subId)!);
          if (this.reqGate !== "holding") {
            this.reqGate = "holding";
            if (this.authWedgeTimer) clearTimeout(this.authWedgeTimer);
            this.authWedgeTimer = setTimeout(() => this.releaseReqGate(), AUTH_WEDGE_MS);
          }
          this.tryAuth();
          break;
        }
        if (/too many subscriptions/i.test(reason) && this.subscriptions.has(subId)) {
          const tries = (this.closedRetries.get(subId) ?? 0) + 1;
          if (tries <= MAX_CLOSED_RETRIES) {
            this.closedRetries.set(subId, tries);
            this.pendingEOSE.delete(subId);
            this.defer({
              subId,
              filters: this.subscriptions.get(subId)!,
              priority: this.prioritySubs.has(subId),
            });
            break; // keep it tracked; a future drainDeferred re-sends it
          }
          // out of retries → fall through and drop it
        }
        // `rate-limited:` / `error:` (§7.7; checked after the cap case, whose
        // text is `error: too many subscriptions`): the REQ was not registered and the
        // relay is asking for it again later, not refusing it. Keep the sub
        // tracked and re-REQ with backoff (bounded); EOSE resets the counter.
        if (
          RETRYABLE_CLOSED_RE.test(reason) &&
          !/too many subscriptions/i.test(reason) && // the cap case above ran out of retries: drop
          this.subscriptions.has(subId)
        ) {
          const tries = (this.closedRetries.get(subId) ?? 0) + 1;
          if (tries <= MAX_RETRYABLE_CLOSED) {
            this.closedRetries.set(subId, tries);
            this.pendingEOSE.delete(subId);
            this.scheduleReqRetry(
              subId,
              Math.min(RETRYABLE_CLOSED_BASE_MS * 2 ** (tries - 1), RETRYABLE_CLOSED_MAX_MS),
            );
            break;
          }
          // out of retries → fall through and drop it
        }
        this.subscriptions.delete(subId);
        this.pendingEOSE.delete(subId);
        this.prioritySubs.delete(subId);
        this.reqSent.delete(subId);
        this.closedRetries.delete(subId);
        break;
      }
      case "AUTH": {
        // NIP-42 auth challenge — sign and respond with kind:22242
        const challenge = msg[1] as string;
        if (!challenge) break;
        // This relay requires AUTH — remember it so future reconnects hold REQs
        // until AUTH completes (avoids the empty-history cold-start race).
        this.everChallenged = true;
        // Cache the challenge so we can replay AUTH if the signer isn't ready yet.
        this.pendingAuthChallenge = challenge;
        this.tryAuth();
        break;
      }
    }
  }

  private setStatus(status: RelayStatus, error?: string): void {
    const prev = this.status;
    this.status = status;
    if (prev !== status) {
      const subCount = this.subscriptions.size;
      if (status === "connected") {
        log.info(`${this.shortUrl} connected (${this.latencyMs}ms, ${subCount} subs to resend)`);
      } else if (status === "error") {
        log.warn(`${this.shortUrl} error${error ? `: ${error}` : ""}`);
      } else if (status === "disconnected") {
        log.info(`${this.shortUrl} disconnected (had ${subCount} subs)`);
      } else {
        log.debug(`${this.shortUrl} → ${status}`);
      }
    }
    this.onStatusChange?.(this.url, status, error);
  }

  private flushQueue(): void {
    const queue = this.messageQueue;
    this.messageQueue = [];
    for (const msg of queue) {
      this.send(msg);
    }
  }

  /** Re-send active subscriptions after reconnect, staggered in batches
   *  to avoid overwhelming relays with concurrent REQs. Respects the relay
   *  subscription cap so the server doesn't reject overflow with CLOSED
   *  (which would permanently delete those subs from this connection). */
  private resubscribe(): void {
    const all = [...this.subscriptions.entries()];
    if (all.length === 0) return;
    // Priority (user-initiated) subs first, then the rest in insertion order.
    const entries = [
      ...all.filter(([subId]) => this.prioritySubs.has(subId)),
      ...all.filter(([subId]) => !this.prioritySubs.has(subId)),
    ];

    // Server state is fresh after reconnect — re-decide what's deferred from scratch.
    this.deferredSubs = [];

    const toSend: Array<[string, NostrFilter[]]> = [];
    const counts = { total: 0, standing: 0 };
    for (const entry of entries) {
      const priority = this.prioritySubs.has(entry[0]);
      if (this.fits(priority, counts)) {
        toSend.push(entry);
        counts.total++;
        if (!priority) counts.standing++;
      } else {
        this.deferredSubs.push({ subId: entry[0], filters: entry[1], priority });
      }
    }
    if (this.deferredSubs.length > 0) {
      this.warnIfFirstDeferral();
    }

    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 150;

    for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
      const batch = toSend.slice(i, i + BATCH_SIZE);
      const delay = (i / BATCH_SIZE) * BATCH_DELAY_MS;

      if (delay === 0) {
        for (const [subId, filters] of batch) {
          this.pendingEOSE.add(subId);
          this.sendReq(subId, filters);
        }
      } else {
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            for (const [subId, filters] of batch) {
              if (!this.subscriptions.has(subId)) continue;
              this.pendingEOSE.add(subId);
              this.sendReq(subId, filters);
            }
          }
        }, delay);
      }
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const stormCooldown = this.stormDetector.getCooldown();
    const backoff = computeBackoff(this.reconnectAttempts, maxDelayFor(this.tier(), this.strikes));
    const delay = Math.max(backoff, stormCooldown);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}
