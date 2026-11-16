/**
 * Request metrics on the API server: labelled by route TEMPLATE, never by the
 * request path — and the API server itself never serves the metrics (the
 * exposure guard). Uses server.inject against the real route tree.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { LUNA, MARCUS } from "../helpers/testUsers.js";
import {
  registry,
  httpRequestsTotal,
  httpRequestDuration,
  UNMATCHED_ROUTE,
} from "../../src/lib/metrics/index.js";

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});
beforeEach(() => {
  httpRequestsTotal.reset();
  httpRequestDuration.reset();
});

/** The `backend_http_requests_total` sample lines currently exported. */
function requestSeries(): string[] {
  return registry
    .render()
    .split("\n")
    .filter((l) => l.startsWith("backend_http_requests_total{"));
}

describe("route-template labelling", () => {
  it("counts a static route under its path and status", async () => {
    await server.inject({ method: "GET", url: "/health" });
    await server.inject({ method: "GET", url: "/health" });
    expect(httpRequestsTotal.get({ method: "GET", route: "/health", status: 200 })).toBe(2);
    expect(httpRequestDuration.get({ method: "GET", route: "/health" }).count).toBe(2);
  });

  it("collapses every id under one parameterised template", async () => {
    await server.inject({ method: "GET", url: `/profiles/${LUNA.pubkey}` });
    await server.inject({ method: "GET", url: `/profiles/${MARCUS.pubkey}` });
    await server.inject({ method: "GET", url: "/spaces/space-one" });
    await server.inject({ method: "GET", url: "/spaces/space-two" });
    await server.inject({ method: "GET", url: "/spaces/space-three?limit=5&pubkey=abc" });

    const series = requestSeries();
    const profile = series.filter((l) => l.includes('route="/profiles/:pubkey"'));
    const space = series.filter((l) => l.includes('route="/spaces/:id"'));
    expect(profile).toHaveLength(1);
    expect(profile[0]).toMatch(/ 2$/);
    // Three space reads, one template (one series per status code).
    expect(space.reduce((n, l) => n + Number(l.split(" ").pop()), 0)).toBe(3);

    const out = series.join("\n");
    for (const leaked of [LUNA.pubkey, MARCUS.pubkey, "space-one", "space-two", "space-three", "limit=5", "abc"]) {
      expect(out, `label leaked ${leaked}`).not.toContain(leaked);
    }
  });

  it("labels a blob hash request by the wildcard template, not the hash", async () => {
    const sha = "ab".repeat(32);
    await server.inject({ method: "GET", url: `/${sha}` });
    await server.inject({ method: "GET", url: `/${"cd".repeat(32)}.mp3` });
    const series = requestSeries();
    expect(series.filter((l) => l.includes('route="/:filename"')).length).toBeGreaterThan(0);
    expect(series.join("\n")).not.toContain(sha);
    expect(series.join("\n")).not.toContain("cdcd");
  });

  // A scanner walking random paths must not mint a series per path.
  it("puts every unmatched path under one `unmatched` label", async () => {
    for (let i = 0; i < 25; i++) {
      await server.inject({ method: "GET", url: `/no/such/route/${i}/${"x".repeat(i + 1)}` });
    }
    await server.inject({ method: "POST", url: "/wp-login.php" });

    expect(httpRequestsTotal.get({ method: "GET", route: UNMATCHED_ROUTE, status: 404 })).toBe(25);
    expect(httpRequestsTotal.get({ method: "POST", route: UNMATCHED_ROUTE, status: 404 })).toBe(1);
    expect(requestSeries()).toHaveLength(2);
    expect(requestSeries().join("\n")).not.toContain("wp-login");
  });

  it("counts error statuses with the route template intact", async () => {
    // No auth → the route answers 401, still under its template.
    const res = await server.inject({ method: "GET", url: "/spaces/my-spaces" });
    expect(res.statusCode).toBe(401);
    expect(httpRequestsTotal.get({ method: "GET", route: "/spaces/my-spaces", status: 401 })).toBe(1);
  });

  it("keeps the series count bounded by routes, not by requests", async () => {
    for (let i = 0; i < 60; i++) {
      await server.inject({ method: "GET", url: `/profiles/${i.toString(16).padStart(64, "0")}` });
      await server.inject({ method: "GET", url: `/invites/code-${i}` });
    }
    // 120 distinct paths, two templates (× the statuses they answered with).
    expect(requestSeries().length).toBeLessThanOrEqual(4);
    expect(registry.droppedSeries()).toBe(0);
  });
});

describe("exposure guard: the API server never serves metrics", () => {
  const probes = [
    "/metrics",
    "/metrics/",
    "/metrics?format=prometheus",
    "/METRICS",
    "/metrics.txt",
    "/api/metrics",
    "//metrics",
  ];

  it.each(probes)("GET %s is not a metrics endpoint", async (url) => {
    // Something to leak, if it were going to.
    await server.inject({ method: "GET", url: "/health" });

    const res = await server.inject({ method: "GET", url });
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain("backend_http_requests_total");
    expect(res.body).not.toContain("# TYPE");
    expect(res.headers["content-type"] ?? "").not.toContain("version=0.0.4");
  });

  it("no registered route is named metrics", () => {
    const routes = server.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/\/metrics\b/);
  });

  // The gateway-injected identity header must not turn it on either: the
  // gateway is exactly the public path this guard is about.
  it("does not serve metrics to an authenticated or forwarded request", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/metrics",
      headers: { "x-auth-pubkey": LUNA.pubkey, "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain("backend_");
  });
});
