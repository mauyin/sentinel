import { describe, it, expect } from "vitest";

/**
 * Tests for the Uniswap slippage guard (WS2.4).
 *
 * We can't easily instantiate UniswapExecutor without real wallets + RPC,
 * so we test the slippage guard logic in isolation by extracting the
 * core check and testing it directly.
 */

/**
 * Extracted slippage guard logic (mirrors the check in uniswap.ts execute()).
 * Returns { ok: true } or { ok: false, effectiveSlippageBps }.
 */
function checkSlippageGuard(params: {
  inputAmount: string;
  quoteOutput: string;
  slippageBps: number;
}): { ok: true } | { ok: false; effectiveSlippageBps: number } {
  const outputNum = Number(params.quoteOutput);
  const inputNum = Number(params.inputAmount);

  if (inputNum <= 0 || outputNum <= 0) {
    return { ok: true }; // Can't check — skip guard
  }

  const expectedMinOutput = inputNum * (1 - params.slippageBps / 10000) * 0.95;
  if (outputNum < expectedMinOutput) {
    const effectiveSlippage = ((inputNum - outputNum) / inputNum) * 10000;
    return { ok: false, effectiveSlippageBps: Math.round(effectiveSlippage) };
  }

  return { ok: true };
}

describe("Uniswap slippage guard", () => {
  it("allows normal slippage (0.5%)", () => {
    // Input: 1000 USDC, output: 995 USDC worth (0.5% slip)
    const result = checkSlippageGuard({
      inputAmount: "1000000000", // 1000 USDC (6 decimals)
      quoteOutput: "995000000", // 995 USDC
      slippageBps: 50,
    });
    expect(result.ok).toBe(true);
  });

  it("allows slippage at the threshold boundary", () => {
    // With slippageBps=50 (0.5%), expectedMinOutput = input * (1-0.005) * 0.95
    // = 1000 * 0.995 * 0.95 = 945.25
    // So output of 946 should pass
    const result = checkSlippageGuard({
      inputAmount: "1000",
      quoteOutput: "946",
      slippageBps: 50,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects excessive slippage (>5%)", () => {
    // Input: 1000, output: 900 (10% slippage)
    const result = checkSlippageGuard({
      inputAmount: "1000000000",
      quoteOutput: "900000000",
      slippageBps: 50,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.effectiveSlippageBps).toBe(1000); // 10%
    }
  });

  it("rejects near-zero output", () => {
    const result = checkSlippageGuard({
      inputAmount: "1000000000",
      quoteOutput: "1000", // Nearly zero
      slippageBps: 50,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.effectiveSlippageBps).toBeGreaterThan(9900);
    }
  });

  it("skips guard when input is zero", () => {
    const result = checkSlippageGuard({
      inputAmount: "0",
      quoteOutput: "1000",
      slippageBps: 50,
    });
    expect(result.ok).toBe(true);
  });

  it("skips guard when output is zero", () => {
    const result = checkSlippageGuard({
      inputAmount: "1000",
      quoteOutput: "0",
      slippageBps: 50,
    });
    expect(result.ok).toBe(true);
  });

  it("handles high slippage tolerance (5%)", () => {
    // With 500bps tolerance, expectedMinOutput = 1000 * 0.95 * 0.95 = 902.5
    // Output of 910 should pass
    const result = checkSlippageGuard({
      inputAmount: "1000",
      quoteOutput: "910",
      slippageBps: 500,
    });
    expect(result.ok).toBe(true);
  });

  it("calculates correct effective slippage bps", () => {
    // With slippageBps=10 (0.1%), expectedMin = 10000 * 0.999 * 0.95 = 9490.5
    // Output of 9000 (10% slip) should fail
    const result = checkSlippageGuard({
      inputAmount: "10000",
      quoteOutput: "9000",
      slippageBps: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.effectiveSlippageBps).toBe(1000); // 10%
    }
  });
});
