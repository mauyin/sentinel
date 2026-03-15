import { describe, it, expect, vi } from "vitest";
import { computeTradeSize, resolveProposedSizeUsd } from "./sizer.js";
import { Decimal } from "../core/types.js";

vi.mock("../infra/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  initLogger: vi.fn(),
}));

describe("computeTradeSize", () => {
  const baseInput = {
    proposedSizeUsd: null,
    confidence: 80,
    maxTradeSizeUsd: new Decimal(100),
    equityUsd: new Decimal(1000),
    dailyVolumeUsedUsd: new Decimal(0),
    maxDailyVolumeUsd: new Decimal(500),
  };

  it("scales size with confidence", () => {
    const low = computeTradeSize({ ...baseInput, confidence: 60 });
    const high = computeTradeSize({ ...baseInput, confidence: 100 });
    expect(low.sizeUsd.lessThan(high.sizeUsd)).toBe(true);
  });

  it("returns $20 at confidence 60 (20% of $100 max)", () => {
    const result = computeTradeSize({ ...baseInput, confidence: 60 });
    expect(result.sizeUsd.toNumber()).toBe(20);
  });

  it("returns $80 at confidence 100 (80% of $100 max)", () => {
    const result = computeTradeSize({ ...baseInput, confidence: 100 });
    expect(result.sizeUsd.toNumber()).toBe(80);
  });

  it("caps at 10% of equity", () => {
    const result = computeTradeSize({
      ...baseInput,
      equityUsd: new Decimal(200), // 10% = $20
      confidence: 100,              // would want $80
    });
    expect(result.sizeUsd.toNumber()).toBe(20);
    expect(result.reasoning).toContain("equity-cap");
  });

  it("caps at daily volume headroom", () => {
    const result = computeTradeSize({
      ...baseInput,
      dailyVolumeUsedUsd: new Decimal(490), // headroom = $10
      confidence: 100,
    });
    expect(result.sizeUsd.toNumber()).toBe(10);
    expect(result.reasoning).toContain("daily-headroom");
  });

  it("respects max trade size through confidence scaling", () => {
    // confidence-scaled is always ≤ 80% of maxTradeSizeUsd (defense-in-depth)
    const result = computeTradeSize({
      ...baseInput,
      maxTradeSizeUsd: new Decimal(10),
      equityUsd: new Decimal(10000),
      confidence: 100,
    });
    expect(result.sizeUsd.toNumber()).toBe(8); // 80% of $10
    expect(result.sizeUsd.lessThanOrEqualTo(10)).toBe(true);
  });

  it("never inflates LLM proposed size", () => {
    const result = computeTradeSize({
      ...baseInput,
      proposedSizeUsd: new Decimal(10),
      confidence: 100,
    });
    // LLM wants $10, sizer would allow $80 — use $10
    expect(result.sizeUsd.toNumber()).toBe(10);
    expect(result.reasoning).toContain("llm-proposed");
  });

  it("shrinks LLM proposed size if too large", () => {
    const result = computeTradeSize({
      ...baseInput,
      proposedSizeUsd: new Decimal(200), // larger than all caps
      confidence: 80,
    });
    expect(result.sizeUsd.lessThan(new Decimal(200))).toBe(true);
  });

  it("returns zero when daily volume exhausted", () => {
    const result = computeTradeSize({
      ...baseInput,
      dailyVolumeUsedUsd: new Decimal(500),
    });
    expect(result.sizeUsd.toNumber()).toBe(0);
  });

  it("returns zero when equity is zero", () => {
    const result = computeTradeSize({
      ...baseInput,
      equityUsd: new Decimal(0),
    });
    expect(result.sizeUsd.toNumber()).toBe(0);
  });

  it("clamps confidence below 60 to 60", () => {
    const result = computeTradeSize({ ...baseInput, confidence: 30 });
    const at60 = computeTradeSize({ ...baseInput, confidence: 60 });
    expect(result.sizeUsd.toNumber()).toBe(at60.sizeUsd.toNumber());
  });
});

describe("resolveProposedSizeUsd", () => {
  const price = new Decimal(2000);

  it("returns null for undefined", () => {
    expect(resolveProposedSizeUsd(undefined, price)).toBeNull();
  });

  it("returns null for zero", () => {
    expect(resolveProposedSizeUsd(0, price)).toBeNull();
  });

  it("converts small values (< 1) as base units to USD", () => {
    const result = resolveProposedSizeUsd(0.05, price);
    expect(result).not.toBeNull();
    expect(result!.toNumber()).toBe(100); // 0.05 * 2000
  });

  it("treats values >= 1 as USD", () => {
    const result = resolveProposedSizeUsd(50, price);
    expect(result).not.toBeNull();
    expect(result!.toNumber()).toBe(50);
  });

  it("returns null for negative values", () => {
    expect(resolveProposedSizeUsd(-10, price)).toBeNull();
  });
});
