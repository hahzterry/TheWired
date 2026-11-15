import { Worker, type Job } from "bullmq";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { musicUploads } from "../db/schema/music.js";
import { transcodeAudio } from "../lib/transcode.js";
import { config } from "../config.js";
import {
  TRANSCODE_QUEUE,
  getRedisConnectionOptions,
  type TranscodeJobData,
} from "../lib/queue.js";
import { transcodeJobDuration, transcodeJobs, transcodeJobsActive } from "../lib/metrics/index.js";

/** Run one job's work, recording that it is active, how it ended and how
 *  long it took. Exported for tests. */
export async function instrumentTranscode<T>(work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const finish = (result: "completed" | "failed") => {
    transcodeJobsActive.dec();
    transcodeJobs.inc({ result });
    transcodeJobDuration.observe({ result }, (performance.now() - startedAt) / 1000);
  };
  transcodeJobsActive.inc();
  try {
    const value = await work();
    finish("completed");
    return value;
  } catch (err) {
    finish("failed");
    throw err;
  }
}

export function startTranscodeWorker(): { stop: () => Promise<void> } {
  const worker = new Worker<TranscodeJobData>(
    TRANSCODE_QUEUE,
    (job: Job<TranscodeJobData>) => instrumentTranscode(async () => {
      const { sha256, storagePath, mimeType } = job.data;

      await db
        .update(musicUploads)
        .set({ transcodeStatus: "processing", transcodeError: null })
        .where(eq(musicUploads.sha256, sha256));

      try {
        const result = await transcodeAudio({
          inputPath: storagePath,
          sha256,
          blobDir: resolve(process.cwd(), config.blobDir),
          mimeType,
        });
        await db
          .update(musicUploads)
          .set({
            transcodeStatus: "ready",
            hlsMasterPath: result.hlsRelPath,
            loudnessI: result.loudnessI,
            loudnessTp: result.loudnessTp,
            transcodedAt: new Date(),
            transcodeError: null,
            // ffprobe ground truth beats the client-claimed duration; keep the
            // existing value only when probing failed.
            ...(result.durationSec != null ? { duration: Math.round(result.durationSec) } : {}),
          })
          .where(eq(musicUploads.sha256, sha256));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db
          .update(musicUploads)
          .set({
            transcodeStatus: "failed",
            transcodeError: msg.slice(0, 1000),
          })
          .where(eq(musicUploads.sha256, sha256));
        throw err;
      }
    }),
    {
      connection: getRedisConnectionOptions(),
      concurrency: config.transcodeConcurrency,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[transcode] job ${job?.id} failed:`, err.message);
  });
  worker.on("completed", (job) => {
    console.log(`[transcode] job ${job.id} completed in ${job.processedOn ? Date.now() - job.processedOn : "?"}ms`);
  });

  return {
    async stop() {
      await worker.close();
    },
  };
}
