import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { RiskBridge } from "../risk/bridge.js";
import type { AuditLogger } from "../audit/logger.js";
import type { EventBus, EventPayload } from "../infra/events.js";
import { childLogger } from "../infra/logger.js";
import { priceAge } from "../market/oracle.js";

const log = childLogger({ component: "dashboard" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DashboardDeps {
  risk: RiskBridge;
  audit: AuditLogger;
  eventBus: EventBus;
  port: number;
}

/**
 * Embedded HTTP server for the web dashboard.
 * Endpoints:
 *   GET /          → serve static dashboard HTML
 *   GET /api/state → risk engine state, positions, equity
 *   GET /api/decisions → recent audit entries
 *   GET /api/health → agent alive, circuit breaker, last price age
 *   GET /events    → SSE stream of real-time events
 */
export function startDashboard(deps: DashboardDeps): void {
  const { risk, audit, eventBus, port } = deps;
  const sseClients: Set<ServerResponse> = new Set();

  // Subscribe to EventBus and forward to SSE clients
  eventBus.on((event: EventPayload) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      client.write(data);
    }
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    try {
      if (url === "/" || url === "/index.html") {
        const htmlPath = join(__dirname, "public", "index.html");
        const html = await readFile(htmlPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      if (url === "/api/state") {
        const state = await risk.getState();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(state));
        return;
      }

      if (url === "/api/decisions") {
        const entries = audit.getRecentEntries(50);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(entries));
        return;
      }

      if (url === "/api/health") {
        const circuitState = await risk.checkCircuit();
        const health = {
          alive: true,
          timestamp: Date.now(),
          circuitBreaker: circuitState.state ?? "unknown",
          priceAgeMs: priceAge(),
          uptime: process.uptime(),
        };
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(health));
        return;
      }

      if (url === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write("retry: 5000\n\n");
        sseClients.add(res);

        req.on("close", () => {
          sseClients.delete(res);
        });
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    } catch (err) {
      log.error({ err, url }, "dashboard request error");
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  });

  server.listen(port, () => {
    log.info({ port }, "dashboard server started");
  });
}
