import { createServer, type Server } from "node:http";
import { METRICS_CONTENT_TYPE, registry } from "./lib/metrics/index.js";

/**
 * The internal metrics listener.
 *
 * Deliberately a separate socket from the API server: the gateway forwards
 * `/api/*` to the API port and the web proxy forwards share-page paths to it,
 * so anything served there is one routing mistake away from public. This
 * listener is on its own address (METRICS_ADDR), which no proxy routes to,
 * and it serves exactly one thing.
 */

export interface MetricsAddr {
  host: string;
  port: number;
}

/**
 * Parse METRICS_ADDR: `host:port`, `[v6]:port`, `:port` or a bare port. A
 * missing host means loopback — reachable from other containers only when a
 * host is given on purpose. Returns null for empty (listener off); throws on
 * garbage so a typo is a boot error instead of silently no metrics.
 */
export function parseMetricsAddr(raw: string | undefined): MetricsAddr | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  const bad = () => new Error(`METRICS_ADDR "${v}": expected host:port, [v6]:port, :port or a port`);

  let host = "127.0.0.1";
  let portText = v;
  if (v.startsWith("[")) {
    const end = v.indexOf("]:");
    if (end < 0) throw bad();
    host = v.slice(1, end);
    portText = v.slice(end + 2);
  } else if (v.includes(":")) {
    const i = v.lastIndexOf(":");
    if (v.indexOf(":") !== i) throw bad(); // unbracketed IPv6
    if (i > 0) host = v.slice(0, i);
    portText = v.slice(i + 1);
  }
  if (!/^\d{1,5}$/.test(portText)) throw bad();
  const port = Number(portText);
  if (port < 1 || port > 65535 || host === "") throw bad();
  return { host, port };
}

/** The request handler, exported so tests can drive it without a socket. */
export function metricsRequestListener(): Parameters<typeof createServer>[1] {
  return (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      res.end("method not allowed\n");
      return;
    }
    const body = registry.render();
    res.writeHead(200, {
      "Content-Type": METRICS_CONTENT_TYPE,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

export async function startMetricsServer(addr: MetricsAddr): Promise<{ server: Server; stop: () => Promise<void> }> {
  const server = createServer(metricsRequestListener());
  // A scraper sends one small GET; nothing here needs long-lived requests.
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(addr.port, addr.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
