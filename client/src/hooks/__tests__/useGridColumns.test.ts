import { describe, it, expect, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MEDIA_GRID_COLUMNS, columnsFor, toRows, useGridColumns } from "../useGridColumns";

describe("columnsFor", () => {
  it("uses the widest matching breakpoint", () => {
    expect(columnsFor(() => true, MEDIA_GRID_COLUMNS)).toBe(4);
    expect(columnsFor((q) => q === "(min-width: 40rem)", MEDIA_GRID_COLUMNS)).toBe(3);
  });

  it("falls back to the base count when nothing matches", () => {
    expect(columnsFor(() => false, MEDIA_GRID_COLUMNS)).toBe(2);
  });
});

describe("toRows", () => {
  it("cuts items into rows of the column count, last row short", () => {
    expect(toRows([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it("returns no rows for no items", () => {
    expect(toRows([], 4)).toEqual([]);
  });

  it("never loops on a bad column count", () => {
    expect(toRows([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe("useGridColumns", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A matchMedia whose result can be changed, notifying `change` listeners. */
  function stubMatchMedia(initial: Record<string, boolean>) {
    const state = { ...initial };
    const listeners = new Map<string, Set<() => void>>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return !!state[query];
      },
      addEventListener: (_: string, cb: () => void) => {
        if (!listeners.has(query)) listeners.set(query, new Set());
        listeners.get(query)!.add(cb);
      },
      removeEventListener: (_: string, cb: () => void) => listeners.get(query)?.delete(cb),
    }));
    return {
      set(query: string, matches: boolean) {
        state[query] = matches;
        for (const cb of listeners.get(query) ?? []) cb();
      },
      listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    };
  }

  it("reads the column count from the CSS breakpoints and follows changes", () => {
    const media = stubMatchMedia({ "(min-width: 40rem)": true, "(min-width: 64rem)": true });
    const { result } = renderHook(() => useGridColumns(MEDIA_GRID_COLUMNS));
    expect(result.current).toBe(4);

    act(() => media.set("(min-width: 64rem)", false));
    expect(result.current).toBe(3);

    act(() => media.set("(min-width: 40rem)", false));
    expect(result.current).toBe(2);
  });

  it("removes its listeners on unmount", () => {
    const media = stubMatchMedia({});
    const { unmount } = renderHook(() => useGridColumns(MEDIA_GRID_COLUMNS));
    expect(media.listenerCount()).toBe(2);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });

  it("uses the base count where matchMedia is missing", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useGridColumns(MEDIA_GRID_COLUMNS));
    expect(result.current).toBe(2);
  });
});
