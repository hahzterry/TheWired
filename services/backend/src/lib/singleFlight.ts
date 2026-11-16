/**
 * At most one outstanding operation per key.
 *
 * A timeout raced against a promise only stops the caller WAITING; the query,
 * command or request behind it keeps running until its client gives up. For
 * work that repeats on a timer, starting it again each time against a hung
 * dependency leaves one more pending operation on the shared pool per tick.
 * `run` instead hands every caller that arrives while an operation is in
 * flight that same operation, and starts a new one only once it has settled.
 */
export interface SingleFlight<K> {
  run<T>(key: K, start: () => Promise<T> | T): Promise<T>;
  /** Whether an operation for `key` has been started and has not settled. */
  pending(key: K): boolean;
  /** Forget everything in flight (tests). */
  clear(): void;
}

export function createSingleFlight<K>(): SingleFlight<K> {
  const inFlight = new Map<K, Promise<unknown>>();
  return {
    run<T>(key: K, start: () => Promise<T> | T): Promise<T> {
      const pending = inFlight.get(key);
      if (pending) return pending as Promise<T>;
      let started: Promise<T>;
      try {
        started = Promise.resolve(start());
      } catch (err) {
        return Promise.reject(err);
      }
      inFlight.set(key, started);
      const clear = () => {
        if (inFlight.get(key) === started) inFlight.delete(key);
      };
      started.then(clear, clear);
      return started;
    },
    pending: (key) => inFlight.has(key),
    clear: () => inFlight.clear(),
  };
}
