import { Decimal } from "../core/types.js";
import type { MarketSnapshot } from "../core/types.js";
import { COINGECKO_API_BASE, DEFILLAMA_API_BASE } from "../core/constants.js";
import { httpGet } from "../infra/http.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ component: "oracle" });

const STALENESS_THRESHOLD_MS = 120_000; // 2 minutes
const DEVIATION_THRESHOLD_PCT = 5; // 5% deviation triggers warning

interface CoinGeckoPrice {
  [id: string]:
    | {
        usd: number;
        usd_24h_change?: number;
        usd_24h_vol?: number;
      }
    | undefined;
}

interface CoinGeckoMarketData {
  id: string;
  current_price: number;
  price_change_percentage_24h: number;
  total_volume: number;
  high_24h: number;
  low_24h: number;
}

interface DefiLlamaPrice {
  coins: {
    [key: string]:
      | {
          price: number;
          symbol: string;
          timestamp: number;
          confidence: number;
        }
      | undefined;
  };
}

export interface OracleResult {
  prices: Map<string, number>;
  source: "coingecko" | "defillama";
  stale: boolean;
  deviations: Array<{ id: string; coingecko: number; defillama: number; deviationPct: number }>;
}

let lastUpdateTimestamp = 0;

/**
 * Oracle aggregator: CoinGecko primary, DeFiLlama fallback.
 * Checks staleness and cross-source deviation (WS2.3).
 */
export async function fetchPricesWithFallback(
  coingeckoIds: string[],
): Promise<OracleResult> {
  const result: OracleResult = {
    prices: new Map(),
    source: "coingecko",
    stale: false,
    deviations: [],
  };

  // Try CoinGecko first
  let coingeckoPrices: Map<string, number> | null = null;
  try {
    coingeckoPrices = await fetchCoinGeckoPrices(coingeckoIds);
    result.source = "coingecko";
    result.prices = coingeckoPrices;
    lastUpdateTimestamp = Date.now();
  } catch (err) {
    log.warn({ err }, "CoinGecko fetch failed, trying DeFiLlama fallback");
  }

  // If CoinGecko failed, try DeFiLlama
  if (!coingeckoPrices || coingeckoPrices.size === 0) {
    try {
      const llamaPrices = await fetchDefiLlamaPrices(coingeckoIds);
      result.source = "defillama";
      result.prices = llamaPrices;
      lastUpdateTimestamp = Date.now();
      log.info({ source: "defillama", count: llamaPrices.size }, "using DeFiLlama fallback prices");
    } catch (err) {
      log.error({ err }, "DeFiLlama fallback also failed");
    }
  }

  // Check staleness
  if (lastUpdateTimestamp > 0) {
    const age = Date.now() - lastUpdateTimestamp;
    if (age > STALENESS_THRESHOLD_MS) {
      result.stale = true;
      log.warn({ ageMs: age, threshold: STALENESS_THRESHOLD_MS }, "price data is stale");
    }
  }

  // Cross-source deviation check (if CoinGecko succeeded, also check DeFiLlama)
  if (coingeckoPrices && coingeckoPrices.size > 0) {
    try {
      const llamaPrices = await fetchDefiLlamaPrices(coingeckoIds);
      for (const [id, cgPrice] of coingeckoPrices) {
        const llPrice = llamaPrices.get(id);
        if (llPrice && cgPrice > 0) {
          const deviationPct = Math.abs((cgPrice - llPrice) / cgPrice) * 100;
          if (deviationPct > DEVIATION_THRESHOLD_PCT) {
            result.deviations.push({
              id,
              coingecko: cgPrice,
              defillama: llPrice,
              deviationPct,
            });
            log.warn(
              { id, coingecko: cgPrice, defillama: llPrice, deviationPct: deviationPct.toFixed(2) },
              "price deviation between oracles",
            );
          }
        }
      }
    } catch {
      // Deviation check is best-effort — don't fail the whole flow
    }
  }

  return result;
}

/**
 * Fetch prices from CoinGecko.
 */
async function fetchCoinGeckoPrices(
  coingeckoIds: string[],
): Promise<Map<string, number>> {
  const ids = coingeckoIds.join(",");
  const data = await httpGet<CoinGeckoPrice>(
    `${COINGECKO_API_BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
  );

  const prices = new Map<string, number>();
  for (const id of coingeckoIds) {
    const entry = data[id];
    if (entry) {
      prices.set(id, entry.usd);
    }
  }

  return prices;
}

/**
 * Fetch prices from DeFiLlama.
 */
async function fetchDefiLlamaPrices(
  coingeckoIds: string[],
): Promise<Map<string, number>> {
  // DeFiLlama uses "coingecko:{id}" format
  const coins = coingeckoIds.map((id) => `coingecko:${id}`).join(",");
  const data = await httpGet<DefiLlamaPrice>(
    `${DEFILLAMA_API_BASE}/prices/current/${coins}`,
  );

  const prices = new Map<string, number>();
  for (const id of coingeckoIds) {
    const entry = data.coins[`coingecko:${id}`];
    if (entry) {
      prices.set(id, entry.price);
    }
  }

  return prices;
}

/**
 * Fetch detailed market snapshots (still uses CoinGecko for the full data).
 */
export async function fetchMarketSnapshots(
  coingeckoIds: string[],
): Promise<MarketSnapshot[]> {
  const ids = coingeckoIds.join(",");

  const data = await httpGet<CoinGeckoMarketData[]>(
    `${COINGECKO_API_BASE}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false`,
  );

  const snapshots: MarketSnapshot[] = [];
  for (const coin of data) {
    snapshots.push({
      market: coin.id,
      price: new Decimal(coin.current_price),
      change24h: coin.price_change_percentage_24h ?? 0,
      volume24h: coin.total_volume ?? 0,
      high24h: coin.high_24h ?? 0,
      low24h: coin.low_24h ?? 0,
      timestamp: Date.now(),
    });
  }

  lastUpdateTimestamp = Date.now();
  log.debug({ count: snapshots.length }, "market snapshots fetched");
  return snapshots;
}

/**
 * Check if price data is currently stale.
 */
export function isPriceStale(): boolean {
  if (lastUpdateTimestamp === 0) return true;
  return Date.now() - lastUpdateTimestamp > STALENESS_THRESHOLD_MS;
}

/**
 * Get the age of the last price update in milliseconds.
 */
export function priceAge(): number {
  if (lastUpdateTimestamp === 0) return Infinity;
  return Date.now() - lastUpdateTimestamp;
}
