/** Pure: pick the ids to evict. `ids` MUST be oldest-first (the entity adapter
 *  keeps them sorted by created_at asc). Returns the oldest ids NOT referenced by
 *  any secondary index (or the editedMessages map), capped at the amount needed to
 *  reach `target`. Exported for tests. Returns [] when at/under `softCap`. */
export function computeSweep(
  ids: readonly string[],
  indices: ReadonlyArray<Record<string, string[]>>,
  editedMessages: Record<string, string>,
  softCap: number,
  target: number,
): string[] {
  if (ids.length <= softCap) return [];
  const referenced = new Set<string>();
  for (const index of indices) {
    for (const key in index) {
      const list = index[key];
      for (let i = 0; i < list.length; i++) referenced.add(list[i]);
    }
  }
  // Edit events are referenced via editedMessages, not a string[] index.
  for (const originalId in editedMessages) {
    referenced.add(originalId);
    referenced.add(editedMessages[originalId]);
  }
  const need = ids.length - target;
  const evict: string[] = [];
  for (let i = 0; i < ids.length && evict.length < need; i++) {
    if (!referenced.has(ids[i])) evict.push(ids[i]);
  }
  return evict;
}
