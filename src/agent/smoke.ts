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
import { childLogger } from "../infra/logger.js";
import {
  uniqueCoingeckoIds,
  dedupeTokens,
  findSnapshot,
  findMarketPair,
} from "./autonomous.js";

const log = childLogger({ component: "smoke" });

export async function runSmoke(deps: AgentDeps): Promise<void> {
  const { env, llm, risk, markets } = deps;

  // ── Step 1: OBSERVE ──────────────────────────────────────────────────
  log.info("step 1/6: fetching market data");
  const coingeckoIds = uniqueCoingeckoIds(markets);
  const [snapshots, prices] = await Promise.all([
    fetchMarketSnapshots(coingeckoIds),
    fetchPrices(coingeckoIds),
  ]);

  if (snapshots.length === 0) {
    log.error("no market data returned — aborting");
    process.exit(1);
  }
  log.info({ count: snapshots.length }, "market snapshots fetched");
  for (const s of snapshots) {
    log.info(
      { market: s.market, price: s.price.toFixed(2), change24h: s.change24h.toFixed(2) },
      "market snapshot",
    );
  }

  // ── Step 2: PORTFOLIO ────────────────────────────────────────────────
  log.info("step 2/6: fetching portfolio");
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
  log.info(
    { wallet: account.address, totalValueUsd: portfolio.totalValueUsd.toFixed(2) },
    "portfolio fetched",
  );
  for (const b of portfolio.balances) {
    log.info(
      { symbol: b.symbol, balance: b.balance.toFixed(6), valueUsd: b.valueUsd.toFixed(2) },
      "token balance",
    );
  }

  // ── Step 3: LLM ANALYSIS ────────────────────────────────────────────
  log.info("step 3/6: querying LLM for trade decision");

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
  log.info("step 4/6: parsing LLM response");
  const decision = parseTradeDecision(rawResponse);

  if (!decision) {
    log.error({ rawResponse }, "failed to parse LLM response");
    process.exit(1);
  }

  log.info(
    {
      action: decision.action,
      market: decision.market,
      confidence: decision.confidence,
      size: decision.size ?? "N/A",
      reasoning: decision.reasoning,
    },
    "LLM decision parsed",
  );

  // ── Step 5: RISK VALIDATION ──────────────────────────────────────────
  if (decision.action === "hold") {
    log.info("hold decision — skipping risk validation");
    log.info("smoke test PASSED (hold)");
    process.exit(0);
  }

  log.info("step 5/6: running risk engine validation");
  const marketPair = findMarketPair(markets, decision.market);
  const snapshot = findSnapshot(snapshots, decision.market);

  if (!marketPair || !snapshot) {
    log.error({ market: decision.market }, "market not found in config");
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
  log.info({ reasoning: sizerResult.reasoning }, "position size computed");

  if (tradeSize.lessThanOrEqualTo(0)) {
    log.info("smoke test PASSED (sizer returned zero — no capacity)");
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

  log.info(
    { verdict: verdict.status, reason: verdict.reason },
    "risk engine verdict",
  );

  // ── Step 6: RESULT ───────────────────────────────────────────────────
  log.info(
    { action: decision.action, market: decision.market, verdict: verdict.status },
    "smoke test PASSED",
  );
  process.exit(0);
}
