import type { MarketSnapshot, PortfolioSnapshot, TradeResult } from "../core/types.js";

/**
 * Format market data into a string suitable for LLM analysis.
 */
export function formatMarketData(snapshots: MarketSnapshot[]): string {
  if (snapshots.length === 0) return "No market data available.";

  const lines = snapshots.map((s) => {
    const direction = s.change24h >= 0 ? "+" : "";
    return [
      `${s.market.toUpperCase()}:`,
      `  Price: $${s.price.toFixed(2)}`,
      `  24h Change: ${direction}${s.change24h.toFixed(2)}%`,
      `  24h Volume: $${formatNumber(s.volume24h)}`,
      `  24h Range: $${s.low24h.toFixed(2)} - $${s.high24h.toFixed(2)}`,
    ].join("\n");
  });

  return lines.join("\n\n");
}

/**
 * Format portfolio into a string suitable for LLM analysis.
 */
export function formatPortfolio(portfolio: PortfolioSnapshot): string {
  const lines = [
    `Wallet: ${portfolio.address}`,
    `Chain: ${portfolio.chainId}`,
    `Total Value: $${portfolio.totalValueUsd.toFixed(2)}`,
    "",
    "Holdings:",
  ];

  for (const b of portfolio.balances) {
    if (b.balance.isZero()) continue;
    lines.push(
      `  ${b.symbol}: ${b.balance.toFixed(6)} ($${b.valueUsd.toFixed(2)})`,
    );
  }

  return lines.join("\n");
}

/**
 * Format recent trades for LLM context.
 */
export function formatRecentTrades(trades: TradeResult[]): string {
  if (trades.length === 0) return "No recent trades.";

  const lines = trades.slice(-10).map((t) => {
    const status = t.success ? "OK" : "FAILED";
    const time = new Date(t.timestamp).toISOString();
    return `[${status}] ${time} ${t.side.toUpperCase()} ${t.size.toString()} ${t.market} @ $${t.price.toFixed(2)}${t.txHash ? ` tx:${t.txHash.slice(0, 10)}...` : ""}`;
  });

  return lines.join("\n");
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}
