import { useEffect, useState } from "react";

/** A column count that applies from a viewport width upwards. */
export interface ColumnBreakpoint {
  /** CSS media query, e.g. `(min-width: 40rem)`. */
  query: string;
  columns: number;
}

/**
 * The grid the media feed uses in CSS: `grid-cols-2 sm:grid-cols-3
 * lg:grid-cols-4`. Tailwind's `sm` is 40rem and `lg` is 64rem; listed widest
 * first so the first match wins.
 */
export const MEDIA_GRID_COLUMNS: { base: number; breakpoints: ColumnBreakpoint[] } = {
  base: 2,
  breakpoints: [
    { query: "(min-width: 64rem)", columns: 4 },
    { query: "(min-width: 40rem)", columns: 3 },
  ],
};

/** Pure: the column count for a set of matching queries. */
export function columnsFor(
  matches: (query: string) => boolean,
  config: { base: number; breakpoints: ColumnBreakpoint[] },
): number {
  for (const bp of config.breakpoints) {
    if (matches(bp.query)) return bp.columns;
  }
  return config.base;
}

function currentColumns(config: { base: number; breakpoints: ColumnBreakpoint[] }): number {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return config.base;
  return columnsFor((q) => window.matchMedia(q).matches, config);
}

/**
 * How many columns a responsive CSS grid currently has, read from the same
 * media queries the CSS uses. A virtualized grid renders row by row, so it has
 * to know the column count to cut the items into rows that the CSS will lay
 * out as exactly one line each.
 */
export function useGridColumns(config: { base: number; breakpoints: ColumnBreakpoint[] }): number {
  const [columns, setColumns] = useState(() => currentColumns(config));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const lists = config.breakpoints.map((bp) => window.matchMedia(bp.query));
    const update = () => setColumns(currentColumns(config));
    update();
    for (const list of lists) list.addEventListener("change", update);
    return () => {
      for (const list of lists) list.removeEventListener("change", update);
    };
  }, [config]);

  return columns;
}

/** Cut a flat list into rows of `columns`. The last row may be short. */
export function toRows<T>(items: readonly T[], columns: number): T[][] {
  const size = Math.max(1, Math.floor(columns));
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
