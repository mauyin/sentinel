import type { MarketSnapshot } from "../core/types.js";
import {
  fetchPricesWithFallback,
  fetchMarketSnapshots as oracleFetchSnapshots,
} from "./oracle.js";

/**
 * Fetch current prices with oracle aggregation (CoinGecko + DeFiLlama fallback).
 */
export async function fetchPrices(
  coingeckoIds: string[],
): Promise<Map<string, number>> {
  const result = await fetchPricesWithFallback(coingeckoIds);
  return result.prices;
}

/**
 * Fetch detailed market data for a set of coins.
 */
export async function fetchMarketSnapshots(
  coingeckoIds: string[],
): Promise<MarketSnapshot[]> {
  return oracleFetchSnapshots(coingeckoIds);
}
