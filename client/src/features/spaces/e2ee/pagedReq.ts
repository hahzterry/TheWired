// A stored-events query that walks past the relay's per-REQ cap.
//
// A relay answers one REQ with at most its `max_limit` events (500 on ours).
// A filter that can match more than that must be paged with `until`, or the
// oldest matches are silently never seen (docs/E2EE_SPACES.md §11).

import type { NostrEvent, NostrFilter } from "@/types/nostr";

export interface PagedReqTransport {
  subscribe(opts: {
    filters: NostrFilter[];
    relayUrls: string[];
    onEvent: (event: NostrEvent, relayUrl: string) => void;
    onEOSE: () => void;
  }): string;
  close(subId: string): void;
}

export interface PagedReqOptions {
  filter: NostrFilter;
  relayUrl: string;
  /** Called once per distinct event, newest pages first. */
  onEvent: (event: NostrEvent, relayUrl: string) => void;
  /** Events asked for per page; a full page means "there may be more". */
  pageSize?: number;
  maxPages?: number;
  /** Give up on a page that neither ends nor closes within this long. */
  pageTimeoutMs?: number;
  /** Stop early (the caller was torn down). */
  cancelled?: () => boolean;
}

export interface PagedReqResult {
  /** True when the relay ran out of matches; false on a timeout, a cancel or
   *  the page limit: the caller then knows it has NOT seen everything. */
  complete: boolean;
  /** Distinct events delivered. */
  count: number;
}

export const DEFAULT_PAGE_SIZE = 500;

/** Run `filter` to exhaustion against one relay, page by page. */
export async function fetchAllPaged(transport: PagedReqTransport, opts: PagedReqOptions): Promise<PagedReqResult> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? 40;
  const timeoutMs = opts.pageTimeoutMs ?? 8_000;
  const seen = new Set<string>();
  let until: number | undefined = opts.filter.until;

  for (let page = 0; page < maxPages; page++) {
    if (opts.cancelled?.()) return { complete: false, count: seen.size };
    let received = 0;
    let oldest = Number.POSITIVE_INFINITY;

    const ended = await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (subId) transport.close(subId);
        resolve(ok);
      };
      const filter: NostrFilter = { ...opts.filter, limit: pageSize };
      if (until !== undefined) filter.until = until;
      let subId = "";
      const timer = setTimeout(() => finish(false), timeoutMs);
      try {
        subId = transport.subscribe({
        filters: [filter],
        relayUrls: [opts.relayUrl],
        onEvent: (event, relayUrl) => {
          if (done) return;
          received++;
          if (event.created_at < oldest) oldest = event.created_at;
          if (seen.has(event.id)) return;
          seen.add(event.id);
          opts.onEvent(event, relayUrl);
        },
        onEOSE: () => finish(true),
        });
      } catch {
        // The relay layer could not take the REQ: an incomplete answer.
        finish(false);
      }
    });

    if (!ended) return { complete: false, count: seen.size };
    // Fewer than a full page: the relay has nothing older.
    if (received < pageSize) return { complete: true, count: seen.size };
    // `until` is inclusive, so the boundary second is asked for again (and its
    // events de-duplicated). If a whole page sat on one second, step past it.
    until = until !== undefined && oldest >= until ? until - 1 : oldest;
  }
  return { complete: false, count: seen.size };
}
