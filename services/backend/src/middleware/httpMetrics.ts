import type { FastifyInstance } from "fastify";
import { httpRequestDuration, httpRequestsTotal, methodLabel, UNMATCHED_ROUTE } from "../lib/metrics/index.js";

/**
 * Count every answered request and time it, labelled by the ROUTE TEMPLATE
 * (`/spaces/:id/members`), never the request path: ids, pubkeys and blob
 * hashes in a path would otherwise each mint a series. A request that matched
 * no route is `unmatched` whatever it asked for.
 */
export function registerHttpMetrics(server: FastifyInstance): void {
  // Callback style, not async: this runs on every response and has nothing
  // to await, so it should not cost a promise.
  server.addHook("onResponse", (request, reply, done) => {
    // `is404` covers the not-found handler, which reports the wildcard it
    // was mounted on rather than a real template.
    const route = request.is404 ? UNMATCHED_ROUTE : (request.routeOptions?.url ?? UNMATCHED_ROUTE);
    const method = methodLabel(request.method);
    httpRequestsTotal.inc({ method, route, status: reply.statusCode });
    httpRequestDuration.observe({ method, route }, reply.elapsedTime / 1000);
    done();
  });
}
