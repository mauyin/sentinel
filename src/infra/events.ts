import { EventEmitter } from "node:events";
import { childLogger } from "./logger.js";

const log = childLogger({ component: "event-bus" });

export type EventType =
  | "trade"
  | "decision"
  | "circuit"
  | "price"
  | "error"
  | "health";

export interface EventPayload {
  type: EventType;
  timestamp: number;
  data: unknown;
}

/**
 * Typed event bus for agent pipeline events.
 * Subscribers: dashboard SSE, webhook alerting, audit logger.
 */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(type: EventType, data: unknown): void {
    const payload: EventPayload = {
      type,
      timestamp: Date.now(),
      data,
    };
    this.emitter.emit("event", payload);
    log.debug({ type }, "event emitted");
  }

  on(listener: (event: EventPayload) => void): void {
    this.emitter.on("event", listener);
  }

  off(listener: (event: EventPayload) => void): void {
    this.emitter.off("event", listener);
  }

  /**
   * Fire-and-forget webhook for critical events.
   */
  setupWebhook(webhookUrl: string): void {
    const criticalTypes: EventType[] = ["trade", "circuit", "error"];

    this.on(async (event) => {
      if (!criticalTypes.includes(event.type)) return;

      try {
        const payload = {
          event: event.type,
          timestamp: new Date(event.timestamp).toISOString(),
          data: event.data,
          severity: event.type === "error" ? "critical" : "info",
        };

        // Fire-and-forget — don't block agent on webhook failure
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        }).catch((err) => {
          log.warn({ err, webhookUrl }, "webhook delivery failed");
        });
      } catch (err) {
        log.warn({ err }, "webhook setup error");
      }
    });

    log.info({ webhookUrl }, "webhook alerting configured");
  }
}
