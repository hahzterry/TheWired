import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { LRUCache } from "lru-cache";

/**
 * Values kept for components that are not mounted right now, keyed by the
 * caller. In memory only; forgotten on reload.
 */
const retained = new LRUCache<string, { value: unknown }>({ max: 2000 });

/**
 * `useState` whose value survives the component being unmounted and mounted
 * again under the same key.
 *
 * Rows of a virtualized list are unmounted when they scroll out of the
 * rendered window, which would silently drop what the reader did to them: a
 * half-written reply, an opened thread, hidden media. State that the reader
 * set on purpose goes through this hook so it is still there when the row
 * comes back. Pass `null` as the key for plain `useState` behaviour.
 *
 * A value equal to `initial` is not stored, so untouched rows cost nothing.
 */
export function useRetainedState<T>(key: string | null, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    key !== null && retained.has(key) ? (retained.get(key)!.value as T) : initial,
  );
  const keyRef = useRef(key);
  keyRef.current = key;
  const initialRef = useRef(initial);

  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setValue((prev) => {
      const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      const k = keyRef.current;
      if (k !== null) {
        if (Object.is(resolved, initialRef.current)) retained.delete(k);
        else retained.set(k, { value: resolved });
      }
      return resolved;
    });
  }, []);

  return [value, set];
}

/** Test hook. */
export function resetRetainedStateForTests(): void {
  retained.clear();
}
