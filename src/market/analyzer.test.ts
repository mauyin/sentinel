import { describe, it, expect } from "vitest";
import {
  formatMarketData,
  formatPortfolio,
  formatRecentTrades,
  formatRiskContext,
  type RiskContextData,
} from "./analyzer.js";
import { Decimal } from "../core/types.js";
import type { MarketSnapshot, PortfolioSnapshot, TradeResult } from "../core/types.js";

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    market: "ETH-USDC-BASE",
    price: new Decimal(2100),
    change24h: 2.5,
    volume24h: 18_000_000_000,
    high24h: 2150,
    low24h: 2050,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("formatMarketData", () => {
  it("formats a single snapshot", () => {
    const result = formatMarketData([makeSnapshot()]);
    expect(result).toContain("ETH-USDC-BASE:");
    expect(result).toContain("$2100.00");
    expect(result).toContain("+2.50%");
  });

  it("formats multiple snapshots", () => {
    const result = formatMarketData([
      makeSnapshot(),
      makeSnapshot({ market: "BTC-USDC", price: new Decimal(97000), change24h: -0.5 }),
    ]);
    expect(result).toContain("ETH-USDC-BASE:");
    expect(result).toContain("BTC-USDC:");
    expect(result).toContain("-0.50%");
  });

  it("returns message for empty array", () => {
    expect(formatMarketData([])).toBe("No market data available.");
  });

  it("formats negative change correctly", () => {
    const result = formatMarketData([makeSnapshot({ change24h: -3.2 })]);
    expect(result).toContain("-3.20%");
    expect(result).not.toContain("+-");
  });
});

describe("formatPortfolio", () => {
  it("formats standard portfolio", () => {
    const portfolio: PortfolioSnapshot = {
      address: "0xabc",
      chainId: 8453,
      totalValueUsd: new Decimal(5000),
      balances: [
        { symbol: "WETH", address: "0x1", balance: new Decimal("1.5"), valueUsd: new Decimal(3150) },
        { symbol: "USDC", address: "0x2", balance: new Decimal(1850), valueUsd: new Decimal(1850) },
      ],
    };
    const result = formatPortfolio(portfolio);
    expect(result).toContain("0xabc");
    expect(result).toContain("$5000.00");
    expect(result).toContain("WETH: 1.500000");
    expect(result).toContain("USDC: 1850.000000");
  });

  it("skips zero-balance tokens", () => {
    const portfolio: PortfolioSnapshot = {
      address: "0xabc",
      chainId: 8453,
      totalValueUsd: new Decimal(1000),
      balances: [
        { symbol: "WETH", address: "0x1", balance: new Decimal(0), valueUsd: new Decimal(0) },
        { symbol: "USDC", address: "0x2", balance: new Decimal(1000), valueUsd: new Decimal(1000) },
      ],
    };
    const result = formatPortfolio(portfolio);
    expect(result).not.toContain("WETH");
    expect(result).toContain("USDC");
  });
});

describe("formatRecentTrades", () => {
  it("returns message for empty array", () => {
    expect(formatRecentTrades([])).toBe("No recent trades.");
  });

  it("formats a single trade", () => {
    const trade: TradeResult = {
      success: true,
      market: "ETH-USDC-BASE",
      side: "long",
      size: new Decimal(50),
      price: new Decimal(2100),
      timestamp: Date.now(),
      txHash: "0x1234567890abcdef",
    };
    const result = formatRecentTrades([trade]);
    expect(result).toContain("[OK]");
    expect(result).toContain("LONG");
    expect(result).toContain("ETH-USDC-BASE");
    expect(result).toContain("tx:0x12345678");
  });

  it("formats a failed trade", () => {
    const trade: TradeResult = {
      success: false,
      market: "ETH-USDC-BASE",
      side: "short",
      size: new Decimal(25),
      price: new Decimal(2100),
      timestamp: Date.now(),
      error: "insufficient balance",
    };
    const result = formatRecentTrades([trade]);
    expect(result).toContain("[FAILED]");
    expect(result).toContain("SHORT");
  });

  it("truncates to last 10 trades", () => {
    const trades: TradeResult[] = Array.from({ length: 15 }, (_, i) => ({
      success: true,
      market: `TRADE-${i}`,
      side: "long" as const,
      size: new Decimal(10),
      price: new Decimal(100),
      timestamp: Date.now() + i,
    }));
    const result = formatRecentTrades(trades);
    const lines = result.split("\n");
    expect(lines).toHaveLength(10);
    expect(result).toContain("TRADE-5");
    expect(result).not.toContain("TRADE-4");
  });
});

describe("formatRiskContext", () => {
  it("formats context with no positions", () => {
    const data: RiskContextData = {
      equityUsd: 1000,
      maxTradeSizeUsd: 100,
      maxDailyVolumeUsd: 500,
      dailyVolumeUsedUsd: 0,
      maxDrawdownPct: 10,
      openPositions: [],
    };
    const result = formatRiskContext(data);
    expect(result).toContain("Account Equity: $1000.00");
    expect(result).toContain("Max Trade Size: $100.00");
    expect(result).toContain("Daily Volume Used: $0.00 / $500.00");
    expect(result).toContain("Max Drawdown: 10%");
    expect(result).toContain("Open Positions: none");
  });

  it("formats context with open positions", () => {
    const data: RiskContextData = {
      equityUsd: 5000,
      maxTradeSizeUsd: 200,
      maxDailyVolumeUsd: 1000,
      dailyVolumeUsedUsd: 300,
      maxDrawdownPct: 15,
      openPositions: [
        { market: "ETH-USDC", side: "long", size: 0.5, entryPrice: 2000, unrealizedPnl: 50 },
      ],
    };
    const result = formatRiskContext(data);
    expect(result).toContain("ETH-USDC long 0.5 @ $2000.00 (PnL: +$50.00)");
    expect(result).not.toContain("Open Positions: none");
  });
});
