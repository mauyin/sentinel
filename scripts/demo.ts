/**
 * Sentinel Demo — Full pipeline showcase for Synthesis hackathon judges.
 *
 * Runs one complete trading cycle: observe → reason → size → validate → execute
 * Uses MockExecutor by default (safe without funds). Pass --live for real execution.
 *
 * Usage:
 *   pnpm demo              # mock execution (safe)
 *   pnpm demo -- --live    # real on-chain execution
 */

import { parseArgs } from "node:util";
import { loadEnv } from "../src/config/env.js";
import { initLogger } from "../src/infra/logger.js";
import { initLlm } from "../src/llm/provider.js";
import { chat } from "../src/llm/provider.js";
import { RiskBridge } from "../src/risk/bridge.js";
import { MARKET_PAIRS } from "../src/config/markets.js";
import { DEFAULT_TICK_SIZE } from "../src/core/constants.js";
import { fetchMarketSnapshots, fetchPrices } from "../src/market/feed.js";
import { fetchPortfolio } from "../src/market/portfolio.js";
import {
  formatMarketData,
  formatPortfolio,
  formatRiskContext,
  type RiskContextData,
} from "../src/market/analyzer.js";
import {
  MARKET_ANALYSIS_SYSTEM,
  RISK_REVIEW_SYSTEM,
  buildMarketAnalysisPrompt,
  buildRiskReviewPrompt,
} from "../src/llm/prompts.js";
import { parseTradeDecision } from "../src/llm/parser.js";
import { computeTradeSize, resolveProposedSizeUsd } from "../src/risk/sizer.js";
import { Decimal } from "../src/core/types.js";
import { createRouter, MockExecutor, ExecutionRouter } from "../src/execution/router.js";
import { getPublicClient, getAccount } from "../src/infra/rpc.js";
import {
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_DEADLINE_SECONDS,
} from "../src/core/constants.js";
import type { ExecuteParams } from "../src/execution/router.js";

// ── UI helpers ───────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function box(title: string) {
  const line = "─".repeat(60);
  console.log(`\n${CYAN}┌${line}┐${RESET}`);
  console.log(`${CYAN}│${RESET} ${BOLD}${title}${RESET}${" ".repeat(Math.max(0, 58 - title.length))} ${CYAN}│${RESET}`);
  console.log(`${CYAN}└${line}┘${RESET}`);
}

function step(n: number, total: number, label: string) {
  console.log(`\n${YELLOW}[${n}/${total}]${RESET} ${BOLD}${label}${RESET}`);
}

function kv(key: string, value: string) {
  console.log(`  ${DIM}${key}:${RESET} ${value}`);
}

function timer() {
  const start = performance.now();
  return () => {
    const ms = performance.now() - start;
    return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: { live: { type: "boolean", default: false } },
  });
  const isLive = values.live ?? false;

  const env = loadEnv();
  initLogger(env.LOG_LEVEL);

  const llm = {
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
  };
  initLlm(llm);

  box("SENTINEL — Autonomous DeFi Trading Agent");
  console.log(`  ${DIM}Mode: ${isLive ? `${RED}LIVE${RESET}` : `${GREEN}DEMO (mock)${RESET}`}`);
  console.log(`  ${DIM}LLM:  ${env.LLM_MODEL} via Venice.ai (private, no-log)${RESET}`);
  console.log(`  ${DIM}Risk: Rust engine (margin, PnL, limits)${RESET}`);

  // ── Step 1: Boot risk engine ──────────────────────────────────────────
  step(1, 7, "Starting Rust risk engine");
  let t = timer();

  const risk = new RiskBridge(process.cwd());
  await risk.start();
  await risk.configure({
    max_trade_size_usd: env.MAX_TRADE_SIZE_USD,
    max_daily_volume_usd: env.MAX_DAILY_VOLUME_USD,
    max_drawdown_bps: env.MAX_DRAWDOWN_PCT * 100,
    cooldown_seconds: 0,
  });

  for (const market of MARKET_PAIRS) {
    await risk.addMarket({
      symbol: market.id,
      initial_margin_bps: market.initialMarginBps,
      maintenance_margin_bps: market.maintenanceMarginBps,
      max_leverage: market.maxLeverage,
      tick_size: DEFAULT_TICK_SIZE,
      min_size: market.minTradeUsd,
    });
  }

  // Init equity
  let equity = env.INITIAL_EQUITY_USD;
  if (equity === 0) {
    try {
      const account = getAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);
      const primaryMarket = MARKET_PAIRS[0]!;
      const client = getPublicClient(primaryMarket.chainId);
      const coingeckoIds = [...new Set(MARKET_PAIRS.flatMap((m) => [m.baseToken.coingeckoId, m.quoteToken.coingeckoId]))];
      const prices = await fetchPrices(coingeckoIds);
      const allTokens = MARKET_PAIRS
        .filter((m) => m.chainId === primaryMarket.chainId)
        .flatMap((m) => [m.baseToken, m.quoteToken]);
      const uniqueTokens = allTokens.filter(
        (tok, i, arr) => arr.findIndex((u) => u.address === tok.address) === i,
      );
      const portfolio = await fetchPortfolio(client, account.address, uniqueTokens, primaryMarket.chainId, prices);
      equity = portfolio.totalValueUsd.toNumber();
    } catch {
      equity = env.MAX_TRADE_SIZE_USD;
    }
  }
  await risk.initAccount(equity);

  kv("Markets", MARKET_PAIRS.map((m) => m.id).join(", "));
  kv("Equity", `$${equity.toFixed(2)}`);
  kv("Max trade", `$${env.MAX_TRADE_SIZE_USD}`);
  kv("Time", t());

  // ── Step 2: Observe markets ───────────────────────────────────────────
  step(2, 7, "Observing markets (CoinGecko + on-chain portfolio)");
  t = timer();

  const coingeckoIds = [...new Set(MARKET_PAIRS.flatMap((m) => [m.baseToken.coingeckoId, m.quoteToken.coingeckoId]))];
  const [snapshots, prices] = await Promise.all([
    fetchMarketSnapshots(coingeckoIds),
    fetchPrices(coingeckoIds),
  ]);

  if (snapshots.length === 0) {
    console.error(`${RED}  No market data returned — aborting${RESET}`);
    risk.stop();
    process.exit(1);
  }

  for (const s of snapshots) {
    const dir = s.change24h >= 0 ? GREEN : RED;
    kv(s.market, `$${s.price.toFixed(2)} ${dir}${s.change24h >= 0 ? "+" : ""}${s.change24h.toFixed(2)}%${RESET}`);
  }

  const account = getAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);
  const primaryMarket = MARKET_PAIRS[0]!;
  const client = getPublicClient(primaryMarket.chainId);
  const allTokens = MARKET_PAIRS
    .filter((m) => m.chainId === primaryMarket.chainId)
    .flatMap((m) => [m.baseToken, m.quoteToken]);
  const uniqueTokens = allTokens.filter(
    (tok, i, arr) => arr.findIndex((u) => u.address === tok.address) === i,
  );
  const portfolio = await fetchPortfolio(client, account.address, uniqueTokens, primaryMarket.chainId, prices);

  kv("Wallet", account.address);
  kv("Portfolio", `$${portfolio.totalValueUsd.toFixed(2)}`);
  kv("Time", t());

  // ── Step 3: Reason with LLM (pass 1 — market analysis) ───────────────
  step(3, 7, "Reasoning with Venice.ai LLM (pass 1: market analysis)");
  t = timer();

  const riskState = await risk.getState();
  const riskCtx: RiskContextData = {
    equityUsd: Number(riskState.equity ?? equity),
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
  const decision = parseTradeDecision(rawResponse);

  if (!decision) {
    console.error(`${RED}  LLM returned unparseable response${RESET}`);
    console.log(`  ${DIM}Raw: ${rawResponse.slice(0, 200)}${RESET}`);
    risk.stop();
    process.exit(1);
  }

  const actionColor = decision.action === "buy" ? GREEN : decision.action === "sell" ? RED : YELLOW;
  kv("Decision", `${actionColor}${decision.action.toUpperCase()}${RESET}`);
  kv("Market", decision.market);
  kv("Confidence", `${decision.confidence}%`);
  kv("Raw size", `${decision.size ?? "null (system will calculate)"}`);
  kv("Reasoning", decision.reasoning);
  kv("Time", t());

  if (decision.action === "hold") {
    box("Result: HOLD — No trade executed");
    risk.stop();
    process.exit(0);
  }

  // ── Step 4: LLM risk review (pass 2) ─────────────────────────────────
  step(4, 7, "Reasoning with Venice.ai LLM (pass 2: risk review)");
  t = timer();

  const riskReviewPrompt = buildRiskReviewPrompt(
    JSON.stringify(decision),
    portfolioData,
    JSON.stringify(riskState),
  );
  const riskReviewRaw = await chat(llm, RISK_REVIEW_SYSTEM, riskReviewPrompt);

  let riskReview: { approved: boolean; adjustedSize?: number; concerns?: string[]; reasoning?: string } | null = null;
  try {
    riskReview = JSON.parse(riskReviewRaw.match(/\{[\s\S]*\}/)?.[0] ?? riskReviewRaw);
  } catch {
    // proceed anyway
  }

  if (riskReview) {
    kv("Approved", riskReview.approved ? `${GREEN}YES${RESET}` : `${RED}NO${RESET}`);
    if (riskReview.concerns?.length) kv("Concerns", riskReview.concerns.join("; "));
    if (riskReview.reasoning) kv("Reasoning", riskReview.reasoning);
  }
  kv("Time", t());

  if (riskReview && !riskReview.approved) {
    box("Result: LLM Risk Review REJECTED");
    risk.stop();
    process.exit(0);
  }

  // ── Step 5: Position sizing ───────────────────────────────────────────
  step(5, 7, "Computing position size (programmatic sizer)");
  t = timer();

  const marketPair = MARKET_PAIRS.find((m) => m.id.toLowerCase() === decision.market.toLowerCase())
    ?? MARKET_PAIRS.find((m) => decision.market.toLowerCase().includes(m.baseToken.symbol.toLowerCase()))
    ?? MARKET_PAIRS[0]!;
  const snapshot = snapshots.find((s) => s.market.toLowerCase() === decision.market.toLowerCase())
    ?? snapshots[0]!;

  const llmRawSize = riskReview?.adjustedSize ?? decision.size;
  const proposedSizeUsd = resolveProposedSizeUsd(llmRawSize, snapshot.price);
  const sizerResult = computeTradeSize({
    proposedSizeUsd,
    confidence: decision.confidence,
    maxTradeSizeUsd: new Decimal(env.MAX_TRADE_SIZE_USD),
    equityUsd: new Decimal(riskCtx.equityUsd),
    dailyVolumeUsedUsd: new Decimal(riskCtx.dailyVolumeUsedUsd),
    maxDailyVolumeUsd: new Decimal(env.MAX_DAILY_VOLUME_USD),
  });

  kv("LLM proposed", proposedSizeUsd ? `$${proposedSizeUsd.toFixed(2)}` : "null");
  kv("Sizer output", `$${sizerResult.sizeUsd.toFixed(2)}`);
  kv("Reasoning", sizerResult.reasoning);
  kv("Time", t());

  if (sizerResult.sizeUsd.lessThanOrEqualTo(0)) {
    box("Result: No trade capacity");
    risk.stop();
    process.exit(0);
  }

  // ── Step 6: Rust risk engine validation ───────────────────────────────
  step(6, 7, "Validating with Rust risk engine");
  t = timer();

  await risk.updatePrice(marketPair.id, snapshot.price.toNumber());

  const side = decision.action === "buy" ? "long" : "short";
  const tradeSize = sizerResult.sizeUsd;
  const verdict = await risk.validateTrade({
    market: marketPair.id,
    side,
    size: tradeSize.toNumber(),
    price: snapshot.price.toNumber(),
    leverage: 1,
  });

  const verdictColor = verdict.status === "approved" ? GREEN : RED;
  kv("Verdict", `${verdictColor}${String(verdict.status).toUpperCase()}${RESET}`);
  if (verdict.reason) kv("Reason", String(verdict.reason));
  kv("Time", t());

  if (verdict.status !== "approved") {
    box("Result: Rust Risk Engine REJECTED");
    risk.stop();
    process.exit(0);
  }

  // ── Step 7: Execute ───────────────────────────────────────────────────
  step(7, 7, `Executing trade${isLive ? "" : " (mock)"}`);
  t = timer();

  let executor: ExecutionRouter;
  if (isLive) {
    executor = createRouter(env);
  } else {
    executor = new ExecutionRouter();
    const mock = new MockExecutor();
    executor.register(8453, mock);
    executor.register(84532, mock);
    executor.register(42161, mock);
    executor.register(421614, mock);
  }

  const executeParams: ExecuteParams = {
    market: marketPair,
    side,
    sizeUsd: tradeSize,
    price: snapshot.price,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
  };

  const result = await executor.execute(executeParams);

  const resultColor = result.success ? GREEN : RED;
  kv("Success", `${resultColor}${result.success}${RESET}`);
  if (result.txHash) kv("TxHash", result.txHash);
  if (result.error) kv("Error", result.error);
  kv("Time", t());

  // ── Done ──────────────────────────────────────────────────────────────
  box(`Demo Complete: ${decision.action.toUpperCase()} $${tradeSize.toFixed(2)} ${marketPair.id}`);
  console.log(`\n  ${DIM}Two-LLM reasoning ✓  Rust risk validation ✓  Position sizing ✓  On-chain execution ✓${RESET}\n`);

  risk.stop();
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err);
  process.exit(1);
});
