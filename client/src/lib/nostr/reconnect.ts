import { RECONNECT } from "./constants";

/**
 * How hard the client holds on to a relay.
 * - `app`: the platform relay. Always retried, backoff capped at MAX_DELAY.
 * - `pinned`: a relay the user or the app chose (own relay list, DM relays, a
 *   space host, bootstrap and indexer relays). Always retried; once it has
 *   struck out the cap rises to DEAD_MAX_DELAY.
 * - `transient`: a relay dialed only because someone else's data points at it
 *   (outbox fan-out, a DM recipient's inbox, search). Dropped for the session
 *   once it strikes out.
 */
export type RelayTier = "app" | "pinned" | "transient";

/** Compute backoff delay with jitter */
export function computeBackoff(attempt: number, maxDelay: number = RECONNECT.MAX_DELAY): number {
  const exponential = Math.min(
    RECONNECT.BASE_DELAY * Math.pow(2, attempt),
    maxDelay,
  );
  const jitter = exponential * RECONNECT.JITTER * (Math.random() * 2 - 1);
  return Math.round(exponential + jitter);
}

/** True once `strikes` consecutive failed connects mark a relay as dead. */
export function isStruckOut(strikes: number): boolean {
  return strikes >= RECONNECT.STRIKE_LIMIT;
}

/** Backoff cap for a relay of `tier` that has failed `strikes` times in a row. */
export function maxDelayFor(tier: RelayTier, strikes: number): number {
  if (tier === "app" || !isStruckOut(strikes)) return RECONNECT.MAX_DELAY;
  return RECONNECT.DEAD_MAX_DELAY;
}

/** Detect reconnection storms (multiple relays dropping at once) */
export class StormDetector {
  private disconnectTimestamps: number[] = [];

  recordDisconnect(): void {
    const now = Date.now();
    this.disconnectTimestamps.push(now);
    // Prune old entries
    this.disconnectTimestamps = this.disconnectTimestamps.filter(
      (t) => now - t < RECONNECT.STORM_WINDOW,
    );
  }

  /** Disconnects still inside the window. Counted at read time: the list is
   *  only pruned when a new disconnect is recorded, so reading its raw length
   *  kept a past storm "active" (and its cooldown applied to every reconnect)
   *  until some later disconnect happened to prune it. */
  isStorm(): boolean {
    const now = Date.now();
    const recent = this.disconnectTimestamps.filter(
      (t) => now - t >= 0 && now - t < RECONNECT.STORM_WINDOW,
    );
    return recent.length >= RECONNECT.STORM_THRESHOLD;
  }

  /** Forget recorded disconnects (a new session starts clean). */
  reset(): void {
    this.disconnectTimestamps = [];
  }

  getCooldown(): number {
    return this.isStorm() ? RECONNECT.STORM_COOLDOWN : 0;
  }
}
