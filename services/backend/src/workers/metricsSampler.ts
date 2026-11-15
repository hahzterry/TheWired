import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { config } from "../config.js";
import { checkDependencies } from "../lib/dependencyHealth.js";
import { getTranscodeQueue } from "../lib/queue.js";
import {
  notificationQueueDepth,
  notificationQueueOldestAge,
  TRANSCODE_QUEUE_STATES,
  transcodeQueueJobs,
} from "../lib/metrics/index.js";

/** Budget for one sampling query, so a stuck dependency cannot pile samples up. */
const SAMPLE_TIMEOUT_MS = 5000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), SAMPLE_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Push-queue backlog: unsent rows and the age of the oldest one. Read from
 *  the table rather than counted in the dispatcher, so it stays true when the
 *  dispatcher itself is the thing that stopped. `created_at` is a zoneless
 *  timestamp holding UTC wall time (as the dispatcher reads it), so the age
 *  is taken against UTC now whatever the session time zone is. */
export async function sampleNotificationQueue(): Promise<void> {
  const rows = (await withTimeout(
    db.execute(
      sql`SELECT COUNT(*)::int AS depth,
                 COALESCE(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - MIN(created_at))), 0)::float8 AS oldest_age
          FROM app.notification_queue
          WHERE sent = false`,
    ),
  )) as unknown as Array<{ depth: number; oldest_age: number }>;
  notificationQueueDepth.set(Number(rows[0]?.depth ?? 0));
  notificationQueueOldestAge.set(Math.max(0, Number(rows[0]?.oldest_age ?? 0)));
}

/** Transcode queue sizes by state. Skipped unless this deployment transcodes:
 *  asking would otherwise open a queue connection nothing else needs. */
export async function sampleTranscodeQueue(): Promise<void> {
  if (!config.transcodeEnqueue && !config.transcodeWorker) return;
  const counts = await withTimeout(getTranscodeQueue().getJobCounts(...TRANSCODE_QUEUE_STATES));
  for (const state of TRANSCODE_QUEUE_STATES) transcodeQueueJobs.set({ state }, counts[state] ?? 0);
}

/** One sampling pass. Each part fails on its own: a dead database must not
 *  stop the dependency gauges from saying so. */
export async function sampleOnce(): Promise<void> {
  await Promise.all([
    checkDependencies().catch(() => {}),
    sampleNotificationQueue().catch(() => {}),
    sampleTranscodeQueue().catch(() => {}),
  ]);
}

/**
 * Keeps the pull-style gauges fresh (dependency probes, queue depths) so a
 * scrape is a memory read and never waits on a dependency. Per replica and
 * unlocked on purpose: every replica reports what IT can reach.
 */
export function startMetricsSampler(intervalMs: number = config.metricsSampleIntervalMs): { stop: () => void } {
  let running = false;
  const tick = () => {
    if (running) return; // a slow pass never stacks another behind it
    running = true;
    void sampleOnce().finally(() => {
      running = false;
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
