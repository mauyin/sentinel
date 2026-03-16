import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock httpGet before importing oracle
vi.mock("../infra/http.js", () => ({
  httpGet: vi.fn(),
}));

vi.mock("../infra/logger.js", () => ({
  childLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import after mocks
const { httpGet } = await import("../infra/http.js");
const mockHttpGet = vi.mocked(httpGet);

// Oracle module uses module-level state (lastUpdateTimestamp), so we re-import fresh each test
// by resetting modules
describe("oracle aggregator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Reset module state by clearing the module cache
    vi.resetModules();
  });

  it("returns CoinGecko prices on success", async () => {
    const { fetchPricesWithFallback } = await import("./oracle.js");

    mockHttpGet.mockResolvedValueOnce({
      ethereum: { usd: 2100, usd_24h_change: 1.5 },
      "usd-coin": { usd: 1.0, usd_24h_change: 0.01 },
    });

    // DeFiLlama call for deviation check (best-effort)
    mockHttpGet.mockResolvedValueOnce({
      coins: {
        "coingecko:ethereum": { price: 2105, symbol: "ETH", timestamp: Date.now() / 1000, confidence: 0.99 },
        "coingecko:usd-coin": { price: 1.0, symbol: "USDC", timestamp: Date.now() / 1000, confidence: 0.99 },
      },
    });

    const result = await fetchPricesWithFallback(["ethereum", "usd-coin"]);

    expect(result.source).toBe("coingecko");
    expect(result.prices.get("ethereum")).toBe(2100);
    expect(result.prices.get("usd-coin")).toBe(1.0);
    expect(result.stale).toBe(false);
    expect(result.deviations).toHaveLength(0);
  });

  it("falls back to DeFiLlama when CoinGecko fails", async () => {
    const { fetchPricesWithFallback } = await import("./oracle.js");

    // CoinGecko fails
    mockHttpGet.mockRejectedValueOnce(new Error("CoinGecko rate limited"));

    // DeFiLlama succeeds
    mockHttpGet.mockResolvedValueOnce({
      coins: {
        "coingecko:ethereum": { price: 2100, symbol: "ETH", timestamp: Date.now() / 1000, confidence: 0.99 },
      },
    });

    const result = await fetchPricesWithFallback(["ethereum"]);

    expect(result.source).toBe("defillama");
    expect(result.prices.get("ethereum")).toBe(2100);
  });

  it("returns empty prices when both sources fail", async () => {
    const { fetchPricesWithFallback } = await import("./oracle.js");

    mockHttpGet.mockRejectedValueOnce(new Error("CoinGecko down"));
    mockHttpGet.mockRejectedValueOnce(new Error("DeFiLlama down"));

    const result = await fetchPricesWithFallback(["ethereum"]);

    expect(result.prices.size).toBe(0);
  });

  it("detects cross-source deviation >5%", async () => {
    const { fetchPricesWithFallback } = await import("./oracle.js");

    // CoinGecko: ETH at $2100
    mockHttpGet.mockResolvedValueOnce({
      ethereum: { usd: 2100 },
    });

    // DeFiLlama: ETH at $1900 (>5% deviation)
    mockHttpGet.mockResolvedValueOnce({
      coins: {
        "coingecko:ethereum": { price: 1900, symbol: "ETH", timestamp: Date.now() / 1000, confidence: 0.99 },
      },
    });

    const result = await fetchPricesWithFallback(["ethereum"]);

    expect(result.source).toBe("coingecko");
    expect(result.prices.get("ethereum")).toBe(2100); // Uses CoinGecko when both succeed
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0]!.deviationPct).toBeGreaterThan(5);
    expect(result.deviations[0]!.coingecko).toBe(2100);
    expect(result.deviations[0]!.defillama).toBe(1900);
  });

  it("does not flag deviation <=5%", async () => {
    const { fetchPricesWithFallback } = await import("./oracle.js");

    // CoinGecko: ETH at $2100
    mockHttpGet.mockResolvedValueOnce({
      ethereum: { usd: 2100 },
    });

    // DeFiLlama: ETH at $2050 (~2.4% deviation)
    mockHttpGet.mockResolvedValueOnce({
      coins: {
        "coingecko:ethereum": { price: 2050, symbol: "ETH", timestamp: Date.now() / 1000, confidence: 0.99 },
      },
    });

    const result = await fetchPricesWithFallback(["ethereum"]);

    expect(result.deviations).toHaveLength(0);
  });

  it("isPriceStale returns true when no updates have been made", async () => {
    const { isPriceStale } = await import("./oracle.js");

    expect(isPriceStale()).toBe(true);
  });

  it("isPriceStale returns false after fresh fetch", async () => {
    const { fetchPricesWithFallback, isPriceStale } = await import("./oracle.js");

    mockHttpGet.mockResolvedValueOnce({ ethereum: { usd: 2100 } });
    mockHttpGet.mockResolvedValueOnce({ coins: {} }); // deviation check

    await fetchPricesWithFallback(["ethereum"]);

    expect(isPriceStale()).toBe(false);
  });

  it("isPriceStale returns true after 2+ minutes", async () => {
    const { fetchPricesWithFallback, isPriceStale } = await import("./oracle.js");

    mockHttpGet.mockResolvedValueOnce({ ethereum: { usd: 2100 } });
    mockHttpGet.mockResolvedValueOnce({ coins: {} });

    await fetchPricesWithFallback(["ethereum"]);
    expect(isPriceStale()).toBe(false);

    // Advance time past staleness threshold
    vi.advanceTimersByTime(121_000);

    expect(isPriceStale()).toBe(true);
  });

  it("priceAge returns Infinity when no updates", async () => {
    const { priceAge } = await import("./oracle.js");

    expect(priceAge()).toBe(Infinity);
  });

  it("priceAge returns elapsed time after fetch", async () => {
    const { fetchPricesWithFallback, priceAge } = await import("./oracle.js");

    mockHttpGet.mockResolvedValueOnce({ ethereum: { usd: 2100 } });
    mockHttpGet.mockResolvedValueOnce({ coins: {} });

    await fetchPricesWithFallback(["ethereum"]);

    vi.advanceTimersByTime(5_000);

    expect(priceAge()).toBeGreaterThanOrEqual(5_000);
    expect(priceAge()).toBeLessThan(6_000);
  });

  it("deviation check failing does not break the flow", async () => {
    const { fetchPricesWithFallback } = await import("./oracle.js");

    // CoinGecko succeeds
    mockHttpGet.mockResolvedValueOnce({
      ethereum: { usd: 2100 },
    });

    // DeFiLlama fails during deviation check
    mockHttpGet.mockRejectedValueOnce(new Error("DeFiLlama timeout"));

    const result = await fetchPricesWithFallback(["ethereum"]);

    expect(result.source).toBe("coingecko");
    expect(result.prices.get("ethereum")).toBe(2100);
    expect(result.deviations).toHaveLength(0);
  });
});
