import { useCallback, useContext, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { ReactReduxContext } from "react-redux";
import { LRUCache } from "lru-cache";
import type { RootState } from "@/store";

/**
 * Values kept for components that are not mounted right now, keyed by the
 * account they belong to and by the caller's key. In memory only; forgotten
 * on reload.
 */
const retained = new LRUCache<string, { value: unknown }>({ max: 2000 });

/** One account's slot for a key. A pubkey is hex, so the separator is safe. */
function slotOf(account: string | null, key: string): string {
  return `${account ?? ""}|${key}`;
}

/** What `account` left under `key`, if anything. */
export function peekRetained<T>(account: string | null, key: string): T | undefined {
  return retained.get(slotOf(account, key))?.value as T | undefined;
}

/** Keep `value` for `account` under `key`; `undefined` forgets it. */
export function retain(account: string | null, key: string, value: unknown): void {
  if (value === undefined) retained.delete(slotOf(account, key));
  else retained.set(slotOf(account, key), { value });
}

const noSubscription = () => () => {};

/**
 * The pubkey of the signed-in account, or null (signed out, or rendered
 * outside the app's store, as small components are in tests).
 *
 * Everything retained here is something a person did: a half-written reply,
 * a thread they opened. It belongs to the account that did it, and must not
 * be there for the next account that looks at the same note.
 */
export function useActiveAccount(): string | null {
  const store = useContext(ReactReduxContext)?.store;
  return useSyncExternalStore(
    store ? store.subscribe : noSubscription,
    () => (store ? ((store.getState() as RootState).identity?.pubkey ?? null) : null),
  );
}

/**
 * `useState` whose value survives the component being unmounted and mounted
 * again under the same key, for the same account.
 *
 * Rows of a virtualized list are unmounted when they scroll out of the
 * rendered window, which would silently drop what the reader did to them: a
 * half-written reply, an opened thread, hidden media. State that the reader
 * set on purpose goes through this hook so it is still there when the row
 * comes back. Pass `null` as the key for plain `useState` behaviour.
 *
 * Values are kept per account: after an account switch or a logout the hook
 * shows the new account's value (usually `initial`), also in a component
 * that stayed mounted through the change.
 *
 * A value equal to `initial` is not stored, so untouched rows cost nothing.
 */
export function useRetainedState<T>(key: string | null, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const account = useActiveAccount();
  const slot = key === null ? null : slotOf(account, key);
  // The first `initial` is the one a value is compared with, as in `useState`.
  const [first] = useState(() => initial);

  const [state, setState] = useState(() => ({ slot, value: read(slot, first) }));
  let value = state.value;
  if (state.slot !== slot) {
    // Another account or another key: this is a different piece of state.
    value = read(slot, first);
    setState({ slot, value });
  }

  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      setState((prev) => {
        const current = prev.slot === slot ? prev.value : read(slot, first);
        const resolved = typeof next === "function" ? (next as (p: T) => T)(current) : next;
        if (slot !== null) {
          if (Object.is(resolved, first)) retained.delete(slot);
          else retained.set(slot, { value: resolved });
        }
        return { slot, value: resolved };
      });
    },
    [slot, first],
  );

  return [value, set];
}

function read<T>(slot: string | null, initial: T): T {
  if (slot === null) return initial;
  const kept = retained.get(slot);
  return kept ? (kept.value as T) : initial;
}

/** Test hook. */
export function resetRetainedStateForTests(): void {
  retained.clear();
}
