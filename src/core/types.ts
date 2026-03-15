import { z } from "zod";
import _Decimal from "decimal.js";

// decimal.js default export under NodeNext needs this pattern
// to work as both a constructor and a type.
export const Decimal = _Decimal as unknown as typeof _Decimal.default;
export type Decimal = InstanceType<typeof Decimal>;

export type Side = "long" | "short";

export const TradeDecisionSchema = z.object({
  action: z.enum(["buy", "sell", "hold"]),
  market: z.string(),
  size: z.number().positive().nullable().optional().transform(v => v ?? undefined),
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
  timeHorizon: z.enum(["scalp", "swing", "position"]).optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
});

export type TradeDecision = z.infer<typeof TradeDecisionSchema>;

export interface MarketSnapshot {
  market: string;
  price: Decimal;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
}

export interface PortfolioSnapshot {
  address: string;
  chainId: number;
  balances: TokenBalance[];
  totalValueUsd: Decimal;
}

export interface TokenBalance {
  symbol: string;
  address: string;
  balance: Decimal;
  valueUsd: Decimal;
}

export interface Position {
  market: string;
  side: Side;
  size: Decimal;
  entryPrice: Decimal;
  currentPrice: Decimal;
  unrealizedPnl: Decimal;
}

export interface RiskVerdict {
  status: "approved" | "rejected";
  marginRequired?: Decimal;
  freeCollateral?: Decimal;
  reason?: string;
}

export interface TradeResult {
  success: boolean;
  txHash?: string;
  market: string;
  side: Side;
  size: Decimal;
  price: Decimal;
  fee?: Decimal;
  error?: string;
  timestamp: number;
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  marketSnapshot: MarketSnapshot;
  decision: TradeDecision;
  riskVerdict: RiskVerdict;
  tradeResult?: TradeResult;
}
