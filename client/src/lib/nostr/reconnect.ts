import { RECONNECT } from "./constants";

/**
 * How hard the client holds on to a relay.
 * - `app`: the platform relay. Always retried.
 * - `pinned`: a relay the user or the app chose (own relay list, DM relays, a
 *   space host, bootstrap and indexer relays). Always retried.
 * - `transient`: a relay dialed only because someone else's data points at it
 *   (outbox fan-out, a DM recipient's inbox, search). Dropped for the session
 *   once it strikes out.
 *
 * Every tier backs off on the same schedule, capped at MAX_DELAY; the tier
 * only decides whether a dead relay is given up on, and the dial order.
 */
export type RelayTier = "app" | "pinned" | "transient";

/** Compute backoff delay with jitter */
export function computeBackoff(attempt: number): number {
  const exponential = Math.min(
    RECONNECT.BASE_DELAY * Math.pow(2, attempt),
    RECONNECT.MAX_DELAY,
  );
  const jitter = exponential * RECONNECT.JITTER * (Math.random() * 2 - 1);
  return Math.round(exponential + jitter);
}

/** True once `strikes` consecutive failed connects mark a relay as dead. */
export function isStruckOut(strikes: number): boolean {
  return strikes >= RECONNECT.STRIKE_LIMIT;
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
