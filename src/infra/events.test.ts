import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  childLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { EventBus } from "./events.js";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("emits events to listeners", () => {
    const received: unknown[] = [];
    bus.on((event) => received.push(event));

    bus.emit("trade", { market: "ETH-USDC" });

    expect(received).toHaveLength(1);
    const ev = received[0] as { type: string; data: unknown; timestamp: number };
    expect(ev.type).toBe("trade");
    expect(ev.data).toEqual({ market: "ETH-USDC" });
    expect(ev.timestamp).toBeGreaterThan(0);
  });

  it("supports multiple listeners", () => {
    let count = 0;
    bus.on(() => count++);
    bus.on(() => count++);

    bus.emit("decision", { action: "buy" });

    expect(count).toBe(2);
  });

  it("can remove listeners", () => {
    let count = 0;
    const listener = () => count++;
    bus.on(listener);
    bus.off(listener);

    bus.emit("circuit", { state: "open" });

    expect(count).toBe(0);
  });

  it("emits different event types", () => {
    const types: string[] = [];
    bus.on((event) => types.push(event.type));

    bus.emit("trade", {});
    bus.emit("decision", {});
    bus.emit("circuit", {});
    bus.emit("price", {});
    bus.emit("error", {});
    bus.emit("health", {});

    expect(types).toEqual(["trade", "decision", "circuit", "price", "error", "health"]);
  });

  it("setupWebhook fires on critical events only", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());

    bus.setupWebhook("https://example.com/webhook");

    bus.emit("trade", { market: "ETH-USDC" });
    bus.emit("decision", { action: "hold" }); // Not critical
    bus.emit("circuit", { state: "open" });
    bus.emit("price", { ethereum: 2100 }); // Not critical
    bus.emit("error", { msg: "fail" });

    // Allow async webhook calls to complete
    await new Promise((r) => setTimeout(r, 50));

    // trade, circuit, error are critical — 3 calls
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    fetchSpy.mockRestore();
  });

  it("webhook failure does not throw", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));

    bus.setupWebhook("https://example.com/webhook");

    // Should not throw
    bus.emit("error", { msg: "fail" });

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
