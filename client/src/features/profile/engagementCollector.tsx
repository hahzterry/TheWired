import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { store } from "../../store";
import { subscriptionManager, type EoseInfo } from "../../lib/nostr/subscriptionManager";
import { selectReactionEventIdsFor } from "../../store/slices/reactionsSlice";
import { EVENT_KINDS } from "../../types/nostr";

/** Debounce window for coalescing scroll-driven visibility changes before
 *  issuing an engagement REQ (matches the legacy useProfileEngagementSub value). */
const DEFAULT_DEBOUNCE_MS = 300;

/** Most notes the live subscription covers at once. */
const LIVE_LIMIT = 100;
/** One-shot fetches of stored engagement allowed in flight at once. */
const MAX_HISTORY_SUBS = 3;
/** How often the reaction ids known for the visible notes are compared with
 *  the ones the un-react leg carries. */
const DELETION_REFRESH_MS = 10_000;
/** Margin on the live subscription's `since`: an event's timestamp is its
 *  author's clock, and it can reach a relay late. */
const SINCE_SLACK_S = 120;
/** Most reaction ids the un-react leg carries (the newest known are kept). */
const MAX_DELETION_REACTIONS = 1000;

const ENGAGEMENT_KINDS = [
  EVENT_KINDS.REACTION,
  EVENT_KINDS.REPOST,
  EVENT_KINDS.SHORT_TEXT,
  EVENT_KINDS.ZAP_RECEIPT,
] as const;

interface LiveSub {
  subId: string;
  ids: string[];
  /** The reaction ids its un-react leg was built from. */
  reactionKey: string;
}

/**
 * Tracks which note cards are in (or near) the viewport and keeps their
 * engagement (reactions, reposts, replies, zaps, and un-reacts) up to date.
 *
 * Two kinds of subscription, so that neither grows with how far the reader
 * scrolls:
 *
 * - **Stored engagement** is asked for once per note, the first time it is
 *   visible, in feed order. Each batch is a one-shot request that closes
 *   itself when the relays have answered. It is never cut short by the
 *   window moving on; at most a few run at once.
 * - **One live subscription** covers every note that is visible right now.
 *   When the visible set changes it is replaced by one for the new set, so a
 *   note keeps receiving engagement for as long as it is on screen, however
 *   many batches were fetched since. It only asks for events since the notes
 *   were last covered, so replacing it costs next to nothing.
 *
 * The live subscription also carries the un-react leg: a kind:5 e-tags the
 * *reaction* it retracts, not the note, so that leg lists the reaction ids
 * known for the visible notes and is re-issued as more become known.
 *
 * Pure (no React) so the core can be unit-tested directly.
 */
export class EngagementWindow {
  private visible = new Map<string, number>();
  /** Notes whose stored engagement has been asked for. */
  private fetched = new Set<string>();
  /** One-shot fetches of stored engagement still in flight. */
  private history = new Set<string>();
  /** When (unix seconds) the live subscription last stopped covering a note. */
  private coveredUntil = new Map<string, number>();
  private live: LiveSub | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly relayUrls?: string[],
    private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS,
    /** Reaction event ids already known for a set of notes — the kind:5
     *  (un-react) leg needs them because a kind:5 e-tags the reaction, not the
     *  note. Injected so the pure class stays store-free in tests. */
    private readonly getReactionIds: (noteIds: string[]) => string[] = () => [],
  ) {}

  /** Report a card entering/leaving the viewport. `index` is its feed position,
   *  used only to fetch in document order. */
  report(id: string, index: number, isVisible: boolean): void {
    this.disposed = false;
    if (isVisible) this.visible.set(id, index);
    else this.visible.delete(id);
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.debounceMs);
    }
  }

  /**
   * Replace the whole visible set in one call. A virtualized list knows the
   * range it has rendered, so it reports that range here instead of mounting
   * an observer per card. `startIndex` is the feed position of `ids[0]`.
   */
  setVisible(ids: readonly string[], startIndex: number): void {
    this.disposed = false;
    this.visible.clear();
    for (let i = 0; i < ids.length; i++) this.visible.set(ids[i], startIndex + i);
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.debounceMs);
    }
  }

  /** Bring the subscriptions in line with what is visible. Exposed for tests. */
  flush(): void {
    this.timer = null;
    const ids = this.visibleIds();
    this.fetchStored(ids);
    this.follow(ids);
  }

  /** The visible notes in feed order, at most `LIVE_LIMIT` of them. */
  private visibleIds(): string[] {
    return [...this.visible.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, LIVE_LIMIT)
      .map(([id]) => id);
  }

  /** Ask once for the stored engagement of notes not asked about before. */
  private fetchStored(ids: string[]): void {
    const fresh = ids.filter((id) => !this.fetched.has(id));
    // Too many in flight: these are picked up when one finishes.
    if (fresh.length === 0 || this.history.size >= MAX_HISTORY_SUBS) return;
    for (const id of fresh) this.fetched.add(id);

    let subId: string | null = null;
    let finished = false;
    const finish = (info: EoseInfo) => {
      finished = true;
      if (subId !== null) this.closeStored(subId);
      // The request never left the client: these notes are still to fetch.
      if (info.reason === "no-relays" || info.sentTo === 0) {
        for (const id of fresh) this.fetched.delete(id);
        return;
      }
      if (this.disposed) return;
      // Reactions have just arrived: their ids belong in the un-react leg.
      this.refreshDeletions();
      // Whatever had to wait for a free slot.
      this.fetchStored(this.visibleIds());
    };
    // Single REQ, multiple filters (NIP-01 OR). No `limit`: chunking by viewport
    // is the volume control, and relays ignore client limits anyway.
    subId = subscriptionManager.subscribe({
      filters: ENGAGEMENT_KINDS.map((kind) => ({ kinds: [kind], "#e": fresh })),
      relayUrls: this.relayUrls,
      onEOSE: finish,
    });
    if (finished) subscriptionManager.close(subId);
    else this.history.add(subId);
  }

  private closeStored(subId: string): void {
    this.history.delete(subId);
    subscriptionManager.close(subId);
  }

  /** Make the live subscription cover exactly `ids`. */
  private follow(ids: string[]): void {
    if (ids.length === 0) {
      this.stopLive();
      return;
    }
    const reactionIds = this.getReactionIds(ids).slice(-MAX_DELETION_REACTIONS);
    const reactionKey = reactionIds.join(",");
    const live = this.live;
    if (live && live.reactionKey === reactionKey && sameIds(live.ids, ids)) return;

    // The new subscription is opened before the old one is closed, so a note
    // that stays visible is never without one.
    const now = Math.floor(Date.now() / 1000);
    let since = now;
    for (const id of ids) {
      // A note the old subscription still covers is covered until now.
      if (live?.ids.includes(id)) continue;
      since = Math.min(since, this.coveredUntil.get(id) ?? now);
    }
    // Un-reacts: union the note ids with every reaction id known for them
    // (a retraction references the reaction id). No `since`: a reaction that
    // only just became known may have been retracted long ago.
    const deletionTargets = reactionIds.length > 0 ? [...new Set([...ids, ...reactionIds])] : ids;
    const subId = subscriptionManager.subscribe({
      filters: [
        { kinds: [...ENGAGEMENT_KINDS], "#e": ids, since: since - SINCE_SLACK_S },
        { kinds: [EVENT_KINDS.DELETION], "#e": deletionTargets },
      ],
      relayUrls: this.relayUrls,
    });
    this.stopLive();
    this.live = { subId, ids, reactionKey };
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshDeletions();
    }, DELETION_REFRESH_MS);
  }

  /** Re-issue the live subscription if more reaction ids are known by now. */
  private refreshDeletions(): void {
    const live = this.live;
    if (!live) return;
    this.follow(live.ids);
    // Nothing new: look again later.
    if (this.live === live && this.refreshTimer === null) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        this.refreshDeletions();
      }, DELETION_REFRESH_MS);
    }
  }

  private stopLive(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const live = this.live;
    if (!live) return;
    this.live = null;
    subscriptionManager.close(live.subId);
    const now = Math.floor(Date.now() / 1000);
    for (const id of live.ids) this.coveredUntil.set(id, now);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopLive();
    for (const subId of [...this.history]) this.closeStored(subId);
    this.visible.clear();
    this.fetched.clear();
    this.coveredUntil.clear();
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const Ctx = createContext<EngagementWindow | null>(null);

/** Provides an EngagementWindow to descendant note cards. One per feed/thread;
 *  fetched-state is scoped to this provider and torn down on unmount. */
export function EngagementCollectorProvider({
  relayUrls,
  children,
}: {
  relayUrls?: string[];
  children: ReactNode;
}) {
  const ref = useRef<EngagementWindow | null>(null);
  if (ref.current === null) {
    ref.current = new EngagementWindow(relayUrls, undefined, (noteIds) =>
      selectReactionEventIdsFor(store.getState(), noteIds),
    );
  }

  useEffect(() => {
    const win = ref.current;
    return () => win?.dispose();
  }, []);

  return <Ctx.Provider value={ref.current}>{children}</Ctx.Provider>;
}

/**
 * Engagement for a virtualized feed: returns a callback to hand the ids of the
 * rendered range (the virtualizer's `rangeChanged`). Each note's stored
 * engagement is fetched once, the first time it is rendered, in feed order;
 * every note in the rendered range stays live while it is there.
 *
 * The window, and with it the record of what was already fetched, is rebuilt
 * when `resetKey` or the relay set changes (another channel, another profile).
 */
export function useEngagementRange(
  relayUrls: string[] | undefined,
  resetKey: string,
): (ids: readonly string[], startIndex: number) => void {
  const ref = useRef<EngagementWindow | null>(null);
  const relayKey = relayUrls ? relayUrls.join(",") : "";

  useEffect(() => {
    const win = new EngagementWindow(relayUrls, undefined, (noteIds) =>
      selectReactionEventIdsFor(store.getState(), noteIds),
    );
    ref.current = win;
    return () => {
      win.dispose();
      if (ref.current === win) ref.current = null;
    };
    // relayUrls is compared by content (relayKey), not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayKey, resetKey]);

  return useCallback((ids: readonly string[], startIndex: number) => {
    ref.current?.setVisible(ids, startIndex);
  }, []);
}

/** Attach to a note card's root element. Reports the card's viewport visibility
 *  (with a one-screen prefetch margin) to the surrounding EngagementWindow. */
export function useEngagementReporter(id: string, index: number) {
  const win = useContext(Ctx);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!win) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) win.report(id, index, entry.isIntersecting);
      },
      { rootMargin: "200px" }, // prefetch engagement ~one screen ahead
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      win.report(id, index, false);
    };
  }, [win, id, index]);

  return ref;
}
