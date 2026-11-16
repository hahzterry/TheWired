/**
 * Reads what an `EngagementWindow` asked the (mocked) subscription manager
 * for. It makes two kinds of request: one-shot fetches of stored engagement
 * (one filter per kind, no `since`, closed on EOSE) and the live subscription
 * (carries the kind:5 un-react leg and a `since`).
 */
import type { Mock } from "vitest";

export interface EngagementFilter {
  kinds: number[];
  "#e": string[];
  since?: number;
}
export interface EngagementRequest {
  subId: string;
  filters: EngagementFilter[];
  relayUrls?: string[];
  onEOSE?: (info: { reason: "all-eose" | "timeout" | "no-relays"; sentTo?: number }) => void;
}

export function engagementSubs(subscribe: Mock, close: Mock) {
  const all = (): EngagementRequest[] =>
    subscribe.mock.calls.map((call, i) => ({
      ...(call[0] as Omit<EngagementRequest, "subId">),
      subId: subscribe.mock.results[i].value as string,
    }));
  const isLive = (r: EngagementRequest) => r.filters.some((f) => f.kinds.includes(5));
  const closed = () => new Set(close.mock.calls.map((c) => c[0] as string));
  return {
    all,
    /** One-shot fetches of stored engagement, in the order they were made. */
    stored: () => all().filter((r) => !isLive(r)),
    /** Every live subscription ever opened, in order. */
    live: () => all().filter(isLive),
    /** Subscriptions that are open right now. */
    open: () => all().filter((r) => !closed().has(r.subId)),
    /** The live subscription that is open right now, if any. */
    openLive: () => {
      const open = all().filter((r) => isLive(r) && !closed().has(r.subId));
      if (open.length > 1) throw new Error(`${open.length} live subscriptions open at once`);
      return open[0] as EngagementRequest | undefined;
    },
    /** The relays answered a request in full. */
    eose: (r: EngagementRequest) => r.onEOSE?.({ reason: "all-eose", sentTo: 1 }),
  };
}

/** Note ids a request's engagement filters (not the un-react leg) ask about. */
export function noteIds(r: EngagementRequest): string[] {
  return r.filters.find((f) => !f.kinds.includes(5))!["#e"];
}

/** Ids the un-react (kind:5) leg of a live subscription asks about. */
export function deletionTargets(r: EngagementRequest): string[] {
  return r.filters.find((f) => f.kinds.includes(5))!["#e"];
}
