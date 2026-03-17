import { describe, it, expect } from "vitest";
import {
  buildMarketAnalysisPrompt,
  formatStrategyMemory,
} from "./prompts.js";
import type { AuditEntry } from "../core/types.js";
import { Decimal } from "../core/types.js";

function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "test-id",
    timestamp: Date.now(),
    marketSnapshot: {
      market: "ETH-USDC-BASE",
      price: new Decimal(2100),
      change24h: 1.5,
      volume24h: 1_000_000,
      high24h: 2150,
      low24h: 2050,
      timestamp: Date.now(),
    },
    decision: {
      action: "buy",
      market: "ETH-USDC-BASE",
      size: 50,
      confidence: 75,
      reasoning: "Strong momentum with rising volume.",
    },
    riskVerdict: { status: "approved" },
    hash: "a".repeat(64),
    prevHash: "0".repeat(64),
    ...overrides,
  };
}

describe("formatStrategyMemory", () => {
  it("returns default message for empty entries", () => {
    const result = formatStrategyMemory([]);
    expect(result).toBe("No previous decisions in this session.");
  });

  it("formats a single entry with action, market, confidence, verdict", () => {
    const result = formatStrategyMemory([makeAuditEntry()]);
    expect(result).toContain("BUY");
    expect(result).toContain("ETH-USDC-BASE");
    expect(result).toContain("75% conf");
    expect(result).toContain("approved");
    expect(result).toContain("Strong momentum");
  });

  it("formats entry with trade result", () => {
    const entry = makeAuditEntry({
      tradeResult: {
        success: true,
        txHash: "0x1234567890abcdef1234567890abcdef",
        market: "ETH-USDC-BASE",
        side: "long",
        size: new Decimal(50),
        price: new Decimal(2100),
        timestamp: Date.now(),
      },
    });
    const result = formatStrategyMemory([entry]);
    expect(result).toContain("EXECUTED");
    expect(result).toContain("tx:0x12345678");
  });

  it("formats entry with failed trade result", () => {
    const entry = makeAuditEntry({
      tradeResult: {
        success: false,
        market: "ETH-USDC-BASE",
        side: "long",
        size: new Decimal(50),
        price: new Decimal(2100),
        timestamp: Date.now(),
        error: "insufficient balance",
      },
    });
    const result = formatStrategyMemory([entry]);
    expect(result).toContain("FAILED");
    expect(result).toContain("error:insufficient balance");
  });

  it("formats multiple entries separated by blank lines", () => {
    const entries = [
      makeAuditEntry(),
      makeAuditEntry({
        decision: {
          action: "hold",
          market: "ETH-USDC-BASE",
          confidence: 40,
          reasoning: "Uncertain conditions.",
        },
      }),
    ];
    const result = formatStrategyMemory(entries);
    expect(result).toContain("BUY");
    expect(result).toContain("HOLD");
    // Entries separated by double newline
    expect(result.split("\n\n").length).toBeGreaterThanOrEqual(2);
  });

  it("formats close action", () => {
    const entry = makeAuditEntry({
      decision: {
        action: "close",
        market: "ETH-USDC-BASE",
        confidence: 80,
        reasoning: "Taking profits on reversal signal.",
      },
    });
    const result = formatStrategyMemory([entry]);
    expect(result).toContain("CLOSE");
    expect(result).toContain("Taking profits");
  });

  it("formats rejected verdict", () => {
    const entry = makeAuditEntry({
      riskVerdict: { status: "rejected", reason: "daily volume exceeded" },
    });
    const result = formatStrategyMemory([entry]);
    expect(result).toContain("rejected");
  });
});

describe("buildMarketAnalysisPrompt", () => {
  it("includes strategy memory section when provided", () => {
    const result = buildMarketAnalysisPrompt(
      "market data",
      "portfolio data",
      "recent trades",
      "risk context",
      "some memory content",
    );
    expect(result).toContain("## Strategy Memory");
    expect(result).toContain("some memory content");
  });

  it("omits strategy memory section when not provided", () => {
    const result = buildMarketAnalysisPrompt(
      "market data",
      "portfolio data",
      "recent trades",
      "risk context",
    );
    expect(result).not.toContain("Strategy Memory");
  });

  it("includes all standard sections", () => {
    const result = buildMarketAnalysisPrompt(
      "market data",
      "portfolio data",
      "recent trades",
      "risk context",
      "memory",
    );
    expect(result).toContain("## Current Market Data");
    expect(result).toContain("## Portfolio State");
    expect(result).toContain("## Recent Trade History");
    expect(result).toContain("## Risk Context");
    expect(result).toContain("## Strategy Memory");
    expect(result).toContain("Analyze the market conditions");
  });
});
