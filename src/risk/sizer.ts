import { Decimal } from "../core/types.js";
import { childLogger } from "../infra/logger.js";

export interface SizerInput {
  proposedSizeUsd: Decimal | null;
  confidence: number;
  maxTradeSizeUsd: Decimal;
  equityUsd: Decimal;
  dailyVolumeUsedUsd: Decimal;
  maxDailyVolumeUsd: Decimal;
}

export interface SizerResult {
  sizeUsd: Decimal;
  reasoning: string;
}

const MIN_CONFIDENCE = 60;
const MAX_CONFIDENCE = 100;
const MIN_ALLOC_PCT = 20;
const MAX_ALLOC_PCT = 80;
const EQUITY_CAP_PCT = 10;

/**
 * Compute a risk-adjusted trade size in USD.
 *
 * Logic (all decimal.js, no floating point):
 *   1. Confidence-to-allocation: linear 60→20% to 100→80% of max trade size
 *   2. Equity cap: never more than 10% of equity per trade
 *   3. Daily volume headroom: maxDailyVolume - dailyVolumeUsed
 *   4. Hard cap: maxTradeSizeUsd
 *   5. Final = min(confidenceScaled, equityCap, dailyHeadroom, maxTradeSizeUsd)
 *   6. If LLM proposed a size, use min(proposed, final) — sizer only shrinks
 */
export function computeTradeSize(input: SizerInput): SizerResult {
  const log = childLogger({ component: "sizer" });
  const reasons: string[] = [];

  // 1. Confidence-to-allocation
  const clampedConfidence = Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, input.confidence));
  const t = new Decimal(clampedConfidence - MIN_CONFIDENCE).div(MAX_CONFIDENCE - MIN_CONFIDENCE);
  const allocPct = new Decimal(MIN_ALLOC_PCT).plus(
    t.mul(MAX_ALLOC_PCT - MIN_ALLOC_PCT),
  );
  const confidenceScaled = input.maxTradeSizeUsd.mul(allocPct).div(100);
  reasons.push(`confidence ${input.confidence}% → ${allocPct.toFixed(0)}% of max → $${confidenceScaled.toFixed(2)}`);

  // 2. Equity cap
  const equityCap = input.equityUsd.mul(EQUITY_CAP_PCT).div(100);
  reasons.push(`equity cap ${EQUITY_CAP_PCT}% of $${input.equityUsd.toFixed(2)} → $${equityCap.toFixed(2)}`);

  // 3. Daily volume headroom
  const dailyHeadroom = input.maxDailyVolumeUsd.minus(input.dailyVolumeUsedUsd);
  reasons.push(`daily headroom $${dailyHeadroom.toFixed(2)}`);

  // 4. Hard cap
  const hardCap = input.maxTradeSizeUsd;

  // 5. Final = min of all caps
  let final = Decimal.min(confidenceScaled, equityCap, dailyHeadroom, hardCap);

  // Floor at zero
  if (final.lessThanOrEqualTo(0)) {
    log.info({ reasons }, "sizer: all caps exhausted, size = 0");
    return { sizeUsd: new Decimal(0), reasoning: "No trade capacity: " + reasons.join("; ") };
  }

  let binding = "confidence-scaled";
  if (final.equals(equityCap)) binding = "equity-cap";
  if (final.equals(dailyHeadroom)) binding = "daily-headroom";
  if (final.equals(hardCap)) binding = "hard-cap";

  // 6. If LLM proposed a size, use min(proposed, final)
  if (input.proposedSizeUsd !== null && input.proposedSizeUsd.greaterThan(0)) {
    if (input.proposedSizeUsd.lessThan(final)) {
      final = input.proposedSizeUsd;
      binding = "llm-proposed";
    }
    reasons.push(`LLM proposed $${input.proposedSizeUsd.toFixed(2)} → ${binding === "llm-proposed" ? "used (smaller)" : "capped"}`);
  }

  const reasoning = `Size $${final.toFixed(2)} (${binding}): ${reasons.join("; ")}`;
  log.info({ sizeUsd: final.toFixed(2), binding }, "trade size computed");

  return { sizeUsd: final, reasoning };
}

/**
 * Resolve the LLM's proposed size to USD.
 *
 * Heuristic: if the raw size < 1, it's likely in base asset units (e.g. 0.1 ETH).
 * Multiply by price to get USD. Otherwise assume it's already USD.
 */
export function resolveProposedSizeUsd(
  rawSize: number | undefined,
  price: Decimal,
): Decimal | null {
  if (rawSize === undefined || rawSize === null) return null;
  const d = new Decimal(rawSize);
  if (d.lessThanOrEqualTo(0)) return null;

  // If < 1, likely base asset units — convert to USD
  if (d.lessThan(1)) {
    return d.mul(price);
  }
  return d;
}
