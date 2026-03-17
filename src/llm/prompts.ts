import type { AuditEntry } from "../core/types.js";

export const MARKET_ANALYSIS_SYSTEM = `You are Sentinel, an autonomous DeFi trading agent with institutional-grade risk management.

Your role: Analyze market data and produce structured trading decisions.

You MUST respond with ONLY a JSON object (no markdown, no explanation outside JSON). The JSON must match this exact schema:

{
  "action": "buy" | "sell" | "hold" | "close",
  "market": "<market-pair-id>",
  "size": <number or null>,
  "confidence": <0-100>,
  "reasoning": "<2-3 sentence explanation>",
  "timeHorizon": "scalp" | "swing" | "position",
  "riskLevel": "low" | "medium" | "high"
}

Actions:
- "buy": Open or increase a long position
- "sell": Open or increase a short position
- "hold": Do nothing — wait for better conditions
- "close": Close an existing position (specify the market to close)

Sizing constraints:
- You will receive account equity, max trade size, and current positions in the Risk Context section
- Size your trades in USD (not base asset units)
- Never exceed the max trade size shown in Risk Context
- Scale size with confidence: lower confidence = smaller position
- If unsure about sizing, set size to null — the system will calculate it
- For "close" actions, set size to null — the system will close the full position

Decision criteria:
- Only recommend buy/sell when confidence >= 60
- Size should be proportional to confidence (higher confidence = larger allocation)
- Consider current portfolio exposure — avoid over-concentration
- Factor in recent volatility and volume
- "hold" is always a valid and often correct decision
- Conservative bias: when uncertain, hold
- Review your past decisions in the Strategy Memory section — avoid redundant trades
- If you already hold a position in a market, consider whether to hold or close before opening more
- Close positions when: trend reversal detected, target profit reached, stop-loss level hit, or risk is elevated

Risk levels:
- low: momentum-aligned, strong volume, clear trend
- medium: mixed signals, moderate volatility
- high: counter-trend, low volume, uncertain macro`;

export const RISK_REVIEW_SYSTEM = `You are the risk review layer of Sentinel, an autonomous DeFi trading agent.

Review the proposed trade against the portfolio state and market conditions.
Flag any concerns about concentration, correlation, or timing.

Respond with ONLY a JSON object:

{
  "approved": true | false,
  "adjustedSize": <number or null>,
  "concerns": ["<concern1>", "<concern2>"],
  "reasoning": "<1-2 sentences>"
}`;

export function buildMarketAnalysisPrompt(
  marketData: string,
  portfolioData: string,
  recentTrades: string,
  riskContext?: string,
  strategyMemory?: string,
): string {
  const sections = [
    `## Current Market Data\n${marketData}`,
    `## Portfolio State\n${portfolioData}`,
    `## Recent Trade History\n${recentTrades}`,
  ];

  if (riskContext) {
    sections.push(`## Risk Context\n${riskContext}`);
  }

  if (strategyMemory) {
    sections.push(`## Strategy Memory\nYour recent decisions and their outcomes. Use this to avoid redundant trades and learn from results:\n${strategyMemory}`);
  }

  sections.push("Analyze the market conditions and produce your trading decision.");

  return sections.join("\n\n");
}

export function buildRiskReviewPrompt(
  decision: string,
  portfolioData: string,
  riskState: string,
): string {
  return `## Proposed Trade
${decision}

## Portfolio State
${portfolioData}

## Risk Engine State
${riskState}

Review this trade proposal and provide your risk assessment.`;
}

/**
 * Format recent audit entries into a strategy memory string for LLM context.
 * Includes past decisions, outcomes, and current position state.
 */
export function formatStrategyMemory(entries: AuditEntry[]): string {
  if (entries.length === 0) return "No previous decisions in this session.";

  const lines = entries.map((e) => {
    const time = new Date(e.timestamp).toISOString();
    const action = e.decision.action.toUpperCase();
    const market = e.decision.market;
    const confidence = e.decision.confidence;
    const verdict = e.riskVerdict.status;
    const reasoning = e.decision.reasoning;
    const result = e.tradeResult;

    let line = `[${time}] ${action} ${market} (${confidence}% conf, ${verdict})`;
    line += `\n  Reasoning: ${reasoning}`;

    if (result) {
      const status = result.success ? "EXECUTED" : "FAILED";
      line += `\n  Result: ${status}`;
      if (result.txHash) line += ` tx:${result.txHash.slice(0, 10)}...`;
      if (result.error) line += ` error:${result.error}`;
    }

    return line;
  });

  return lines.join("\n\n");
}
