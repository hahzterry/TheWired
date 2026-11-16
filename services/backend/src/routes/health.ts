import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { config } from "../config.js";
import { checkDependencies } from "../lib/dependencyHealth.js";

export const healthRoutes: FastifyPluginAsync = async (server) => {
  // Readiness, not just liveness: any dependency down makes this a 503, so the
  // container healthcheck (and `docker compose ps`) shows it instead of a
  // crash-looping search engine hiding behind an always-ok answer. Nothing
  // gates on backend health (the proxy waits on the gateway, whose /health is
  // static), so a 503 here only reports; it never takes the API down.
  server.get("/health", async (_request, reply) => {
    // Read-only: this route is reachable from outside, so it must not move
    // the dependency metrics. The metrics sampler is their only writer.
    const checks = await checkDependencies();
    const healthy = Object.values(checks).every((s) => s === "ok");
    if (!healthy) reply.code(503);

    const base = {
      status: healthy ? ("ok" as const) : ("degraded" as const),
      service: "backend",
      timestamp: Date.now(),
      checks,
    };
    if (!config.transcodeEnqueue && !config.transcodeWorker) return base;

    try {
      const rows = (await db.execute(
        sql`SELECT transcode_status, COUNT(*)::int AS count
            FROM app.music_uploads
            GROUP BY transcode_status`,
      )) as unknown as { transcode_status: string; count: number }[];
      const transcode = Object.fromEntries(
        rows.map((r) => [r.transcode_status, r.count]),
      );
      return { ...base, transcode };
    } catch {
      return base;
    }
  });
};
