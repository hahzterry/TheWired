/**
 * The internal metrics listener: address parsing, that it serves /metrics and
 * nothing else, and — over real sockets — that the API port and the metrics
 * port are different doors.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer as createApiServer } from "../../src/server.js";
import { parseMetricsAddr, startMetricsServer } from "../../src/metricsServer.js";
import { httpRequestsTotal } from "../../src/lib/metrics/index.js";

describe("parseMetricsAddr", () => {
  it("is off when unset or blank", () => {
    expect(parseMetricsAddr(undefined)).toBeNull();
    expect(parseMetricsAddr("")).toBeNull();
    expect(parseMetricsAddr("   ")).toBeNull();
  });

  it("defaults the host to loopback", () => {
    expect(parseMetricsAddr("9464")).toEqual({ host: "127.0.0.1", port: 9464 });
    expect(parseMetricsAddr(":9464")).toEqual({ host: "127.0.0.1", port: 9464 });
  });

  it("accepts an explicit host", () => {
    expect(parseMetricsAddr("0.0.0.0:9464")).toEqual({ host: "0.0.0.0", port: 9464 });
    expect(parseMetricsAddr("backend:9464")).toEqual({ host: "backend", port: 9464 });
    expect(parseMetricsAddr("[::1]:9464")).toEqual({ host: "::1", port: 9464 });
  });

  it.each(["abc", "host:", "host:abc", "0", ":0", "70000", "::1:9464", "http://x:1", "[::1]", "1.2.3.4:99999"])(
    "rejects %s so a typo fails the boot",
    (raw) => {
      expect(() => parseMetricsAddr(raw)).toThrow(/METRICS_ADDR/);
    },
  );
});

describe("metrics listener", () => {
  let stop: (() => Promise<void>) | null = null;
  let closeApi: (() => Promise<unknown>) | null = null;

  afterEach(async () => {
    await stop?.();
    stop = null;
    await closeApi?.();
    closeApi = null;
  });

  async function listen() {
    const handle = await startMetricsServer({ host: "127.0.0.1", port: 0 });
    stop = handle.stop;
    const { port } = handle.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("serves the registry at /metrics in the Prometheus text format", async () => {
    const base = await listen();
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("# TYPE backend_http_requests_total counter");
    expect(body).toContain("# TYPE backend_dependency_up gauge");
    expect(body).toContain("process_resident_memory_bytes ");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("ignores a query string and answers HEAD without a body", async () => {
    const base = await listen();
    expect((await fetch(`${base}/metrics?x=1`)).status).toBe(200);
    const head = await fetch(`${base}/metrics`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("serves nothing else — it is not a second way into the API", async () => {
    const base = await listen();
    for (const path of ["/", "/health", "/metrics/", "/metrics/x", "/spaces", "/api/metrics", "/upload"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain("backend_");
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await fetch(`${base}/metrics`, { method })).status, method).toBe(405);
    }
  });

  it("binds to the address it was given (loopback), not every interface", async () => {
    const handle = await startMetricsServer({ host: "127.0.0.1", port: 0 });
    stop = handle.stop;
    expect((handle.server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("fails to start on a port that is taken instead of silently exporting nothing", async () => {
    const first = await startMetricsServer({ host: "127.0.0.1", port: 0 });
    stop = first.stop;
    const { port } = first.server.address() as AddressInfo;
    await expect(startMetricsServer({ host: "127.0.0.1", port })).rejects.toThrow(/EADDRINUSE/);
  });

  // The whole point, end to end: traffic on the API socket moves counters
  // that are readable only on the metrics socket.
  it("API port answers 404 for /metrics while the metrics port shows the traffic", async () => {
    const api = await createApiServer();
    closeApi = () => api.close();
    await api.listen({ port: 0, host: "127.0.0.1" });
    const apiBase = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    const metricsBase = await listen();

    httpRequestsTotal.reset();
    expect((await fetch(`${apiBase}/health`)).status).toBe(200);
    expect((await fetch(`${apiBase}/health`)).status).toBe(200);

    const onApi = await fetch(`${apiBase}/metrics`);
    expect(onApi.status).toBeGreaterThanOrEqual(400);
    expect(await onApi.text()).not.toContain("backend_http_requests_total");

    const body = await (await fetch(`${metricsBase}/metrics`)).text();
    expect(body).toContain('backend_http_requests_total{method="GET",route="/health",status="200"} 2\n');
  });
});
