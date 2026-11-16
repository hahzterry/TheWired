import type { NostrEvent } from "../../../types/nostr";
import type { AppDispatch, RootState } from "../../../store";
import type { EventDeduplicator } from "../dedup";

export interface EventPipelineDeps {
  /** Store boundary. Thin arrows over the Redux store on desktop. */
  dispatch: AppDispatch;
  getState: () => RootState;
  /** Signature verification (desktop: the Web Worker bridge). */
  verifier: { verify(event: NostrEvent): Promise<boolean> };
  /** Event persistence (desktop: IndexedDB eventStore). */
  persistence: {
    putEvent(event: NostrEvent): Promise<void>;
    deleteEvent(id: string): Promise<void>;
    deleteAddressableEvent(kind: number, pubkey: string, dTag: string): Promise<unknown>;
  };
  /** kind:0 sink (desktop: the profileCache singleton). */
  profileCache: { handleProfileEvent(event: NostrEvent, relayUrl?: string): void };
  /** Bounded-concurrency gift-wrap decryptor. */
  decryptQueue: {
    submit(event: NostrEvent): boolean;
    clear(): void;
    setHandler(handler: (event: NostrEvent) => Promise<void> | void): void;
  };
}

/**
 * What every stage of one pipeline instance shares. Built once by
 * `createEventPipeline`; the stages are split across files but still close
 * over the same store boundary, the same dedup LRU and the same caches.
 */
export interface PipelineContext {
  deps: EventPipelineDeps;
  dispatch: AppDispatch;
  getState: () => RootState;
  /** One LRU per pipeline: every stage marks and unmarks through it. */
  dedup: EventDeduplicator;
  /** Space-author Set cache (O(1) author lookups); cleared with the other caches. */
  authorSetCache: Map<string, { set: Set<string>; fingerprint: string }>;
}
