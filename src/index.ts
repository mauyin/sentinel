import { parseArgs } from "node:util";
import { loadEnv } from "./config/env.js";
import { initLogger, getLogger } from "./infra/logger.js";
import { initLlm } from "./llm/provider.js";
import { RiskBridge } from "./risk/bridge.js";
import { AuditLogger } from "./audit/logger.js";
import { createRouter } from "./execution/router.js";
import { MARKET_PAIRS } from "./config/markets.js";
import { DEFAULT_TICK_SIZE } from "./core/constants.js";
import { fetchPrices } from "./market/feed.js";
import { fetchPortfolio } from "./market/portfolio.js";
import { getPublicClient, getAccount } from "./infra/rpc.js";
import { runAutonomous } from "./agent/autonomous.js";
import { runInteractive } from "./agent/interactive.js";
import { runSmoke } from "./agent/smoke.js";

type Mode = "autonomous" | "interactive" | "smoke";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", short: "m", default: "interactive" },
    },
  });

  const env = loadEnv();
  const log = initLogger(env.LOG_LEVEL);
  const mode = (values.mode ?? env.MODE) as Mode;

  const llm = {
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
  };
  initLlm(llm);

  log.info({ mode }, "sentinel starting");

  switch (mode) {
    case "autonomous":
    case "interactive":
    case "smoke": {
      const risk = new RiskBridge(process.cwd());
      await risk.start();
      await risk.configure({
        max_trade_size_usd: env.MAX_TRADE_SIZE_USD,
        max_daily_volume_usd: env.MAX_DAILY_VOLUME_USD,
        max_drawdown_bps: env.MAX_DRAWDOWN_PCT * 100,
        cooldown_seconds: env.COOLDOWN_SECONDS,
      });

      // Register all markets with the risk engine
      for (const market of MARKET_PAIRS) {
        const res = await risk.addMarket({
          symbol: market.id,
          initial_margin_bps: market.initialMarginBps,
          maintenance_margin_bps: market.maintenanceMarginBps,
          max_leverage: market.maxLeverage,
          tick_size: DEFAULT_TICK_SIZE,
          min_size: market.minTradeUsd,
        });
        if (res.status !== "market_added") {
          throw new Error(`failed to register market ${market.id}: ${JSON.stringify(res)}`);
        }
      }

      // Initialize account equity
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
            (t, i, arr) => arr.findIndex((u) => u.address === t.address) === i,
          );
          const portfolio = await fetchPortfolio(
            client,
            account.address,
            uniqueTokens,
            primaryMarket.chainId,
            prices,
          );
          equity = portfolio.totalValueUsd.toNumber();
          log.info({ equity, address: account.address }, "on-chain equity fetched");
        } catch (err) {
          equity = env.MAX_TRADE_SIZE_USD;
          log.warn({ err, fallbackEquity: equity }, "on-chain equity fetch failed, using MAX_TRADE_SIZE_USD");
        }
      }
      const initRes = await risk.initAccount(equity);
      if (initRes.status !== "account_initialized") {
        throw new Error(`failed to init account: ${JSON.stringify(initRes)}`);
      }
      log.info({ marketsRegistered: MARKET_PAIRS.length, equity }, "risk engine initialized");

      const audit = new AuditLogger(process.cwd());
      await audit.init();

      const executor = createRouter(env);

      const deps = { env, llm, risk, audit, executor, markets: MARKET_PAIRS };

      try {
        if (mode === "autonomous") {
          await runAutonomous(deps);
        } else if (mode === "smoke") {
          await runSmoke(deps);
        } else {
          await runInteractive(deps);
        }
      } finally {
        risk.stop();
      }
      break;
    }
    default:
      log.error({ mode: mode as string }, "unknown mode");
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const log = getLogger();
  log.fatal({ err }, "sentinel fatal error");
  process.exit(1);
});
