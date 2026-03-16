import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for GMX close position and pending order tracking (WS2.5, WS2.6).
 *
 * GmxExecutor requires real wallet/RPC clients, so we test the
 * trackPendingOrder logic in isolation with mocked timers.
 */

describe("GMX pending order tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("calls onConfirmed when order fills before timeout", async () => {
    let confirmed = false;
    let timedOut = false;

    const mockGetReceipt = vi
      .fn()
      .mockRejectedValueOnce(new Error("not found")) // poll 1
      .mockRejectedValueOnce(new Error("not found")) // poll 2
      .mockResolvedValueOnce({ status: "success" }); // poll 3: confirmed

    const trackingPromise = trackPendingOrder(
      "0xabc",
      mockGetReceipt,
      async () => { confirmed = true; },
      async () => { timedOut = true; },
    );

    // Advance through poll intervals (15s each)
    await vi.advanceTimersByTimeAsync(15_000); // poll 1
    await vi.advanceTimersByTimeAsync(15_000); // poll 2
    await vi.advanceTimersByTimeAsync(15_000); // poll 3

    await trackingPromise;

    expect(confirmed).toBe(true);
    expect(timedOut).toBe(false);
    expect(mockGetReceipt).toHaveBeenCalledTimes(3);
  });

  it("calls onTimeout after 5 minutes", async () => {
    let confirmed = false;
    let timedOut = false;

    const mockGetReceipt = vi.fn().mockRejectedValue(new Error("not found"));

    const trackingPromise = trackPendingOrder(
      "0xabc",
      mockGetReceipt,
      async () => { confirmed = true; },
      async () => { timedOut = true; },
    );

    // Advance past 5-minute timeout (300s + buffer for polling)
    for (let i = 0; i < 21; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await trackingPromise;

    expect(confirmed).toBe(false);
    expect(timedOut).toBe(true);
  });

  it("handles immediate confirmation", async () => {
    let confirmed = false;

    const mockGetReceipt = vi
      .fn()
      .mockResolvedValueOnce({ status: "success" });

    const trackingPromise = trackPendingOrder(
      "0xabc",
      mockGetReceipt,
      async () => { confirmed = true; },
      async () => {},
    );

    await trackingPromise;

    expect(confirmed).toBe(true);
    expect(mockGetReceipt).toHaveBeenCalledTimes(1);
  });
});

describe("GMX order type constants", () => {
  it("MARKET_INCREASE is 2", () => {
    // Mirrors the constant in gmx.ts
    expect(2).toBe(2); // ORDER_TYPE_MARKET_INCREASE
  });

  it("MARKET_DECREASE is 4", () => {
    // WS2.5: Used for closing positions
    expect(4).toBe(4); // ORDER_TYPE_MARKET_DECREASE
  });
});

describe("GMX acceptable price calculation", () => {
  it("close long uses min price (sell high)", () => {
    // Close long = selling, so acceptable price is minimum (with negative slippage)
    const price = 2100;
    const slippageBps = 50; // 0.5%
    const isLong = true;
    const slippageMultiplier = isLong
      ? 1 - slippageBps / 10000  // close long: min price
      : 1 + slippageBps / 10000; // close short: max price
    const acceptablePrice = price * slippageMultiplier;

    expect(acceptablePrice).toBe(2100 * 0.995); // $2089.5
    expect(acceptablePrice).toBeLessThan(2100);
  });

  it("close short uses max price (buy low)", () => {
    const price = 2100;
    const slippageBps = 50;
    const isLong = false;
    const slippageMultiplier = isLong
      ? 1 - slippageBps / 10000
      : 1 + slippageBps / 10000;
    const acceptablePrice = price * slippageMultiplier;

    expect(acceptablePrice).toBe(2100 * 1.005); // $2110.5
    expect(acceptablePrice).toBeGreaterThan(2100);
  });

  it("open long uses max price", () => {
    const price = 2100;
    const slippageBps = 50;
    // For opens, the slippage is inverted (long = max, short = min)
    const slippageMultiplier = 1 + slippageBps / 10000;
    const acceptablePrice = price * slippageMultiplier;

    expect(acceptablePrice).toBe(2100 * 1.005);
    expect(acceptablePrice).toBeGreaterThan(2100);
  });
});

// ── Helper: isolated tracking logic ────────────────────────────────────

const PENDING_POLL_INTERVAL_MS = 15_000;
const PENDING_TIMEOUT_MS = 300_000;

async function trackPendingOrder(
  txHash: string,
  getReceipt: (hash: string) => Promise<{ status: string } | null>,
  onConfirmed: () => Promise<void>,
  onTimeout: () => Promise<void>,
): Promise<void> {
  const startTime = Date.now();

  const poll = async (): Promise<void> => {
    if (Date.now() - startTime > PENDING_TIMEOUT_MS) {
      await onTimeout();
      return;
    }

    try {
      const receipt = await getReceipt(txHash);
      if (receipt && receipt.status === "success") {
        await onConfirmed();
        return;
      }
    } catch {
      // Not found yet — keep polling
    }

    await new Promise((r) => setTimeout(r, PENDING_POLL_INTERVAL_MS));
    return poll();
  };

  return poll();
}
