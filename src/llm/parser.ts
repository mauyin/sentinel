import { TradeDecisionSchema, type TradeDecision } from "../core/types.js";
import { getLogger } from "../infra/logger.js";

/**
 * Extract and validate a TradeDecision from raw LLM output.
 * Handles common LLM quirks: markdown fences, trailing text, partial JSON.
 */
export function parseTradeDecision(raw: string): TradeDecision | null {
  const log = getLogger();

  const json = extractJson(raw);
  if (!json) {
    log.warn({ raw: raw.slice(0, 500) }, "no JSON found in llm response");
    return null;
  }

  const result = TradeDecisionSchema.safeParse(json);
  if (!result.success) {
    log.warn(
      { errors: result.error.issues, json },
      "llm response failed validation",
    );
    return null;
  }

  return result.data;
}

/**
 * Extract a JSON object from a string that may contain markdown fences,
 * leading/trailing text, or other noise.
 */
function extractJson(raw: string): unknown | null {
  // Try direct parse first
  try {
    return JSON.parse(raw);
  } catch {
    // Continue to extraction strategies
  }

  // Try extracting from markdown code fence
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // Continue
    }
  }

  // Try finding first { ... } block
  const braceStart = raw.indexOf("{");
  const braceEnd = raw.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(raw.slice(braceStart, braceEnd + 1));
    } catch {
      // Give up
    }
  }

  return null;
}
