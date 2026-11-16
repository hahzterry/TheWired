/**
 * A small Prometheus registry: counters, gauges and histograms with a fixed
 * label set each, rendered in the text exposition format (0.0.4).
 *
 * Label VALUES must come from a closed set chosen in code (a route template, a
 * dependency name, a status code) — never a pubkey, an event id, a URL or
 * anything else a client controls. As a backstop against a mistake there, each
 * metric holds at most `maxSeries` label combinations; observations for a new
 * combination past the cap are dropped and counted in `droppedSeries`.
 */

export type Labels = Record<string, string | number>;

export const DEFAULT_MAX_SERIES = 2000;

/** Seconds. Covers a fast JSON read up to a slow upload / transcode reply. */
export const DEFAULT_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

interface MetricOptions<L extends string> {
  name: string;
  help: string;
  labelNames?: readonly L[];
  maxSeries?: number;
}

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeHelp(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabelValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export function formatValue(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  return String(v);
}

function formatLabels(names: readonly string[], values: readonly string[], extra?: [string, string]): string {
  const parts: string[] = [];
  for (let i = 0; i < names.length; i++) parts.push(`${names[i]}="${escapeLabelValue(values[i])}"`);
  if (extra) parts.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

abstract class Metric<L extends string, S> {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly L[];
  /** Observations dropped because the series cap was reached. */
  droppedSeries = 0;
  protected readonly series = new Map<string, { values: string[]; state: S }>();
  private readonly maxSeries: number;
  protected abstract readonly type: "counter" | "gauge" | "histogram";

  constructor(opts: MetricOptions<L>) {
    if (!NAME_RE.test(opts.name)) throw new Error(`invalid metric name: ${opts.name}`);
    for (const l of opts.labelNames ?? []) {
      if (!LABEL_RE.test(l) || l === "le") throw new Error(`invalid label name on ${opts.name}: ${l}`);
    }
    this.name = opts.name;
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
    this.maxSeries = opts.maxSeries ?? DEFAULT_MAX_SERIES;
  }

  protected abstract initial(): S;

  /** Series key: the label values in declaration order. Built by plain
   *  concatenation — this runs on every request. */
  private keyOf(labels: Partial<Record<L, string | number>> | undefined): string {
    const names = this.labelNames;
    if (names.length === 0) return "";
    let key = "";
    for (let i = 0; i < names.length; i++) {
      const v = labels?.[names[i]];
      if (i > 0) key += "\u0000";
      if (v !== undefined) key += v;
    }
    return key;
  }

  /** The series for a label set, created on first use; undefined past the cap. */
  protected slot(labels: Partial<Record<L, string | number>> | undefined): S | undefined {
    const key = this.keyOf(labels);
    const existing = this.series.get(key);
    if (existing) return existing.state;

    // First sight of this label set: validate it, then create the series.
    if (labels) {
      for (const given of Object.keys(labels)) {
        if (!this.labelNames.includes(given as L)) {
          throw new Error(`unknown label "${given}" on metric ${this.name}`);
        }
      }
    }
    if (this.series.size >= this.maxSeries) {
      this.droppedSeries += 1;
      return undefined;
    }
    const entry = { values: this.labelNames.map((name) => String(labels?.[name] ?? "")), state: this.initial() };
    this.series.set(key, entry);
    return entry.state;
  }

  protected peek(labels: Partial<Record<L, string | number>> | undefined): S | undefined {
    return this.series.get(this.keyOf(labels))?.state;
  }

  /** Drop every series (tests; a gauge family that is rebuilt from scratch). */
  reset(): void {
    this.series.clear();
    this.droppedSeries = 0;
  }

  seriesCount(): number {
    return this.series.size;
  }

  protected abstract renderSeries(values: string[], state: S, out: string[]): void;

  render(out: string[]): void {
    out.push(`# HELP ${this.name} ${escapeHelp(this.help)}`);
    out.push(`# TYPE ${this.name} ${this.type}`);
    for (const { values, state } of this.series.values()) this.renderSeries(values, state, out);
  }
}

export class Counter<L extends string = never> extends Metric<L, { value: number }> {
  protected readonly type = "counter" as const;
  protected initial() {
    return { value: 0 };
  }

  inc(labels?: Partial<Record<L, string | number>>, by = 1): void {
    if (!(by >= 0)) return; // counters never go down; ignores NaN too
    const s = this.slot(labels);
    if (s) s.value += by;
  }

  get(labels?: Partial<Record<L, string | number>>): number {
    return this.peek(labels)?.value ?? 0;
  }

  protected renderSeries(values: string[], state: { value: number }, out: string[]): void {
    out.push(`${this.name}${formatLabels(this.labelNames, values)} ${formatValue(state.value)}`);
  }
}

export class Gauge<L extends string = never> extends Metric<L, { value: number }> {
  protected readonly type = "gauge" as const;
  protected initial() {
    return { value: 0 };
  }

  set(value: number): void;
  set(labels: Partial<Record<L, string | number>>, value: number): void;
  set(a: number | Partial<Record<L, string | number>>, b?: number): void {
    const [labels, value] = typeof a === "number" ? [undefined, a] : [a, b as number];
    const s = this.slot(labels);
    if (s) s.value = value;
  }

  inc(labels?: Partial<Record<L, string | number>>, by = 1): void {
    const s = this.slot(labels);
    if (s) s.value += by;
  }

  dec(labels?: Partial<Record<L, string | number>>, by = 1): void {
    this.inc(labels, -by);
  }

  get(labels?: Partial<Record<L, string | number>>): number | undefined {
    return this.peek(labels)?.value;
  }

  protected renderSeries(values: string[], state: { value: number }, out: string[]): void {
    out.push(`${this.name}${formatLabels(this.labelNames, values)} ${formatValue(state.value)}`);
  }
}

interface HistogramState {
  /** Per-bucket (non-cumulative) counts; the last slot is the +Inf overflow. */
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram<L extends string = never> extends Metric<L, HistogramState> {
  protected readonly type = "histogram" as const;
  readonly buckets: readonly number[];

  constructor(opts: MetricOptions<L> & { buckets?: readonly number[] }) {
    super(opts);
    const buckets = [...(opts.buckets ?? DEFAULT_DURATION_BUCKETS)];
    for (let i = 1; i < buckets.length; i++) {
      if (!(buckets[i] > buckets[i - 1])) throw new Error(`buckets of ${opts.name} must increase`);
    }
    this.buckets = buckets;
  }

  protected initial(): HistogramState {
    return { counts: new Array(this.buckets.length + 1).fill(0), sum: 0, count: 0 };
  }

  observe(value: number): void;
  observe(labels: Partial<Record<L, string | number>>, value: number): void;
  observe(a: number | Partial<Record<L, string | number>>, b?: number): void {
    const [labels, value] = typeof a === "number" ? [undefined, a] : [a, b as number];
    if (!Number.isFinite(value)) return;
    const s = this.slot(labels);
    if (!s) return;
    let i = 0;
    while (i < this.buckets.length && value > this.buckets[i]) i++;
    s.counts[i] += 1;
    s.sum += value;
    s.count += 1;
  }

  get(labels?: Partial<Record<L, string | number>>): { count: number; sum: number } {
    const s = this.peek(labels);
    return { count: s?.count ?? 0, sum: s?.sum ?? 0 };
  }

  protected renderSeries(values: string[], state: HistogramState, out: string[]): void {
    let cumulative = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      cumulative += state.counts[i];
      out.push(
        `${this.name}_bucket${formatLabels(this.labelNames, values, ["le", formatValue(this.buckets[i])])} ${cumulative}`,
      );
    }
    out.push(`${this.name}_bucket${formatLabels(this.labelNames, values, ["le", "+Inf"])} ${state.count}`);
    out.push(`${this.name}_sum${formatLabels(this.labelNames, values)} ${formatValue(state.sum)}`);
    out.push(`${this.name}_count${formatLabels(this.labelNames, values)} ${state.count}`);
  }
}

type AnyMetric = Counter<string> | Gauge<string> | Histogram<string>;

export class Registry {
  private readonly metrics = new Map<string, AnyMetric>();
  private readonly collectors: Array<() => void> = [];

  private add<M extends AnyMetric>(metric: M): M {
    if (this.metrics.has(metric.name)) throw new Error(`metric ${metric.name} is already registered`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter<L extends string = never>(opts: MetricOptions<L>): Counter<L> {
    return this.add(new Counter<L>(opts) as unknown as Counter<string>) as unknown as Counter<L>;
  }

  gauge<L extends string = never>(opts: MetricOptions<L>): Gauge<L> {
    return this.add(new Gauge<L>(opts) as unknown as Gauge<string>) as unknown as Gauge<L>;
  }

  histogram<L extends string = never>(opts: MetricOptions<L> & { buckets?: readonly number[] }): Histogram<L> {
    return this.add(new Histogram<L>(opts) as unknown as Histogram<string>) as unknown as Histogram<L>;
  }

  /** Run `fn` right before every render, to refresh gauges that are read
   *  from the process rather than pushed (memory, CPU, event-loop lag).
   *  Collectors must be synchronous and cheap: nothing here does I/O. */
  onCollect(fn: () => void): void {
    this.collectors.push(fn);
  }

  names(): string[] {
    return [...this.metrics.keys()];
  }

  get(name: string): AnyMetric | undefined {
    return this.metrics.get(name);
  }

  /** Zero every metric (tests). Registrations and collectors stay. */
  reset(): void {
    for (const m of this.metrics.values()) m.reset();
  }

  /** Series dropped at the cardinality cap, summed over every metric. */
  droppedSeries(): number {
    let n = 0;
    for (const m of this.metrics.values()) n += m.droppedSeries;
    return n;
  }

  render(): string {
    for (const collect of this.collectors) {
      try {
        collect();
      } catch {
        // a broken collector must not take the whole scrape down
      }
    }
    const out: string[] = [];
    for (const m of this.metrics.values()) m.render(out);
    return out.join("\n") + "\n";
  }
}

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
