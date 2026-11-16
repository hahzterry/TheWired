import { LRUCache } from "lru-cache";

/**
 * Heights of list rows measured this session, keyed by `scope:id`.
 *
 * A virtualized list only knows the height of rows it has rendered; the rest
 * are a guess. When a feed is left and reopened the guess is all it has, so
 * the scrollbar and the restored position drift until rows are measured again.
 * Remembering what each row measured last time turns that guess into the real
 * number for every row the reader has already seen.
 */
const heights = new LRUCache<string, number>({ max: 8000 });

export function rememberItemHeight(scope: string, id: string, height: number): void {
  if (height > 0) heights.set(`${scope}:${id}`, Math.round(height));
}

export function peekItemHeight(scope: string, id: string): number | undefined {
  return heights.get(`${scope}:${id}`);
}

/**
 * Starting height for every row: what it measured before, else `fallback`.
 * Returns undefined when nothing is remembered, so the list can use its plain
 * default instead of carrying an array of identical guesses.
 */
export function initialHeightEstimates(
  scope: string,
  ids: readonly string[],
  fallback: number,
): number[] | undefined {
  let known = 0;
  const out = new Array<number>(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const h = heights.get(`${scope}:${ids[i]}`);
    if (h !== undefined) known++;
    out[i] = h ?? fallback;
  }
  return known > 0 ? out : undefined;
}

/** Test hook. */
export function resetItemHeightsForTests(): void {
  heights.clear();
}
