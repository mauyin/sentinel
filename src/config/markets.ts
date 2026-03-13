import type { SupportedChainId } from "./chains.js";

export interface TokenConfig {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  coingeckoId: string;
}

export interface MarketPairConfig {
  id: string;
  baseToken: TokenConfig;
  quoteToken: TokenConfig;
  chainId: SupportedChainId;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  maxLeverage: number;
  minTradeUsd: number;
}

// Well-known token addresses
const TOKENS = {
  WETH_BASE: {
    symbol: "WETH",
    address: "0x4200000000000000000000000000000000000006" as const,
    decimals: 18,
    coingeckoId: "ethereum",
  },
  USDC_BASE: {
    symbol: "USDC",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
    decimals: 6,
    coingeckoId: "usd-coin",
  },
  WETH_BASE_SEPOLIA: {
    symbol: "WETH",
    address: "0x4200000000000000000000000000000000000006" as const,
    decimals: 18,
    coingeckoId: "ethereum",
  },
  USDC_BASE_SEPOLIA: {
    symbol: "USDC",
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
    decimals: 6,
    coingeckoId: "usd-coin",
  },
  WETH_ARBITRUM: {
    symbol: "WETH",
    address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const,
    decimals: 18,
    coingeckoId: "ethereum",
  },
  USDC_ARBITRUM: {
    symbol: "USDC",
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const,
    decimals: 6,
    coingeckoId: "usd-coin",
  },
} as const;

export const MARKET_PAIRS: MarketPairConfig[] = [
  {
    id: "ETH-USDC-BASE",
    baseToken: TOKENS.WETH_BASE,
    quoteToken: TOKENS.USDC_BASE,
    chainId: 8453,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    maxLeverage: 10,
    minTradeUsd: 1,
  },
  {
    id: "ETH-USDC-BASE-SEPOLIA",
    baseToken: TOKENS.WETH_BASE_SEPOLIA,
    quoteToken: TOKENS.USDC_BASE_SEPOLIA,
    chainId: 84532,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    maxLeverage: 10,
    minTradeUsd: 1,
  },
  {
    id: "ETH-USDC-ARBITRUM",
    baseToken: TOKENS.WETH_ARBITRUM,
    quoteToken: TOKENS.USDC_ARBITRUM,
    chainId: 42161,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    maxLeverage: 10,
    minTradeUsd: 1,
  },
];

export function getMarketPair(id: string): MarketPairConfig | undefined {
  return MARKET_PAIRS.find((m) => m.id === id);
}

export function getMarketsForChain(chainId: SupportedChainId): MarketPairConfig[] {
  return MARKET_PAIRS.filter((m) => m.chainId === chainId);
}
