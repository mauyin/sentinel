import type { AgentDeps } from "./autonomous.js";
import { Decimal } from "../core/types.js";
import { chat } from "../llm/provider.js";
import { parseTradeDecision } from "../llm/parser.js";
import {
  MARKET_ANALYSIS_SYSTEM,
  buildMarketAnalysisPrompt,
} from "../llm/prompts.js";
import { fetchMarketSnapshots, fetchPrices } from "../market/feed.js";
import { fetchPortfolio } from "../market/portfolio.js";
import {
  formatMarketData,
  formatPortfolio,
  formatRiskContext,
  type RiskContextData,
} from "../market/analyzer.js";
import { computeTradeSize, resolveProposedSizeUsd } from "../risk/sizer.js";
import { getPublicClient, getAccount } from "../infra/rpc.js";
import {
  uniqueCoingeckoIds,
  dedupeTokens,
  findSnapshot,
  findMarketPair,
} from "./autonomous.js";

export async function runSmoke(deps: AgentDeps): Promise<void> {
  const { env, llm, risk, markets } = deps;

  // ── Step 1: OBSERVE ──────────────────────────────────────────────────
  console.log("\n[1/6] Fetching market data...");
  const coingeckoIds = uniqueCoingeckoIds(markets);
  const [snapshots, prices] = await Promise.all([
    fetchMarketSnapshots(coingeckoIds),
    fetchPrices(coingeckoIds),
  ]);

  if (snapshots.length === 0) {
    console.error("No market data returned — aborting");
    process.exit(1);
  }
  console.log(`  ${snapshots.length} market snapshot(s) fetched`);
  for (const s of snapshots) {
    console.log(`  ${s.market}: $${s.price.toFixed(2)} (${s.change24h > 0 ? "+" : ""}${s.change24h.toFixed(2)}%)`);
  }

  // ── Step 2: PORTFOLIO ────────────────────────────────────────────────
  console.log("\n[2/6] Fetching portfolio...");
  const account = getAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);
  const primaryMarket = markets[0]!;
  const client = getPublicClient(primaryMarket.chainId);
  const allTokens = markets
    .filter((m) => m.chainId === primaryMarket.chainId)
    .flatMap((m) => [m.baseToken, m.quoteToken]);
  const uniqueTokens = dedupeTokens(allTokens);
  const portfolio = await fetchPortfolio(
    client,
    account.address,
    uniqueTokens,
    primaryMarket.chainId,
    prices,
  );
  console.log(`  Wallet: ${account.address}`);
  console.log(`  Total value: $${portfolio.totalValueUsd.toFixed(2)}`);
  for (const b of portfolio.balances) {
    console.log(`  ${b.symbol}: ${b.balance.toFixed(6)} ($${b.valueUsd.toFixed(2)})`);
  }

  // ── Step 3: LLM ANALYSIS ────────────────────────────────────────────
  console.log("\n[3/6] Querying LLM for trade decision...");

  const riskState = await risk.getState();
  const riskCtx: RiskContextData = {
    equityUsd: Number(riskState.equity ?? 0),
    maxTradeSizeUsd: env.MAX_TRADE_SIZE_USD,
    maxDailyVolumeUsd: env.MAX_DAILY_VOLUME_USD,
    dailyVolumeUsedUsd: Number(riskState.daily_volume ?? 0),
    maxDrawdownPct: env.MAX_DRAWDOWN_PCT,
    openPositions: [],
  };

  const marketData = formatMarketData(snapshots);
  const portfolioData = formatPortfolio(portfolio);
  const riskContextStr = formatRiskContext(riskCtx);
  const userPrompt = buildMarketAnalysisPrompt(marketData, portfolioData, "", riskContextStr);

  const rawResponse = await chat(llm, MARKET_ANALYSIS_SYSTEM, userPrompt);

  // ── Step 4: PARSE ────────────────────────────────────────────────────
  console.log("\n[4/6] Parsing LLM response...");
  const decision = parseTradeDecision(rawResponse);

  if (!decision) {
    console.error("Failed to parse LLM response");
    console.error("Raw response:", rawResponse);
    process.exit(1);
  }

  console.log(`  Action: ${decision.action}`);
  console.log(`  Market: ${decision.market}`);
  console.log(`  Confidence: ${decision.confidence}%`);
  console.log(`  Size: ${decision.size ?? "N/A"}`);
  console.log(`  Reasoning: ${decision.reasoning}`);

  // ── Step 5: RISK VALIDATION ──────────────────────────────────────────
  if (decision.action === "hold") {
    console.log("\n[5/6] Hold decision — skipping risk validation");
    console.log("\n[6/6] Smoke test PASSED (hold)");
    process.exit(0);
  }

  console.log("\n[5/6] Running risk engine validation...");
  const marketPair = findMarketPair(markets, decision.market);
  const snapshot = findSnapshot(snapshots, decision.market);

  if (!marketPair || !snapshot) {
    console.error(`Market "${decision.market}" not found in config`);
    process.exit(1);
  }

  await risk.updatePrice(marketPair.id, snapshot.price.toNumber());

  const proposedSizeUsd = resolveProposedSizeUsd(decision.size, snapshot.price);
  const sizerResult = computeTradeSize({
    proposedSizeUsd,
    confidence: decision.confidence,
    maxTradeSizeUsd: new Decimal(env.MAX_TRADE_SIZE_USD),
    equityUsd: new Decimal(riskCtx.equityUsd),
    dailyVolumeUsedUsd: new Decimal(riskCtx.dailyVolumeUsedUsd),
    maxDailyVolumeUsd: new Decimal(env.MAX_DAILY_VOLUME_USD),
  });

  const tradeSize = sizerResult.sizeUsd;
  console.log(`  Sizer: ${sizerResult.reasoning}`);

  if (tradeSize.lessThanOrEqualTo(0)) {
    console.log("\n[6/6] Smoke test PASSED (sizer returned zero — no capacity)");
    process.exit(0);
  }

  const side = decision.action === "buy" ? "long" : "short";
  const verdict = await risk.validateTrade({
    market: marketPair.id,
    side,
    size: tradeSize.toNumber(),
    price: snapshot.price.toNumber(),
    leverage: 1,
  });

  console.log(`  Verdict: ${verdict.status}`);
  if (verdict.reason) {
    console.log(`  Reason: ${verdict.reason}`);
  }

  // ── Step 6: RESULT ───────────────────────────────────────────────────
  console.log(`\n[6/6] Smoke test PASSED (${decision.action} ${decision.market} → ${verdict.status})`);
  process.exit(0);
}
