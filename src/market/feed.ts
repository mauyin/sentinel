import { Decimal } from "../core/types.js";
import type { MarketSnapshot } from "../core/types.js";
import { COINGECKO_API_BASE } from "../core/constants.js";
import { httpGet } from "../infra/http.js";
import { getLogger } from "../infra/logger.js";

interface CoinGeckoPrice {
  [id: string]: {
    usd: number;
    usd_24h_change?: number;
    usd_24h_vol?: number;
    usd_market_cap?: number;
  } | undefined;
}

interface CoinGeckoMarketData {
  id: string;
  current_price: number;
  price_change_percentage_24h: number;
  total_volume: number;
  high_24h: number;
  low_24h: number;
}

/**
 * Fetch current price for one or more coingecko IDs.
 */
export async function fetchPrices(
  coingeckoIds: string[],
): Promise<Map<string, number>> {
  const log = getLogger();
  const ids = coingeckoIds.join(",");

  const data = await httpGet<CoinGeckoPrice>(
    `${COINGECKO_API_BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
  );

  const prices = new Map<string, number>();
  for (const id of coingeckoIds) {
    const entry = data[id];
    if (entry) {
      prices.set(id, entry.usd);
    } else {
      log.warn({ id }, "no price data from coingecko");
    }
  }

  return prices;
}

/**
 * Fetch detailed market data for a set of coins.
 */
export async function fetchMarketSnapshots(
  coingeckoIds: string[],
): Promise<MarketSnapshot[]> {
  const log = getLogger();
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

  log.debug({ count: snapshots.length }, "market snapshots fetched");
  return snapshots;
}
