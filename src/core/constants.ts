// Uniswap Trading API
export const UNISWAP_API_BASE = "https://trade-api.gateway.uniswap.org/v1";

// Uniswap contracts — universal across supported chains
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

// GMX V2 contracts — Arbitrum One
export const GMX_EXCHANGE_ROUTER = "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41" as const;
export const GMX_ROUTER = "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6" as const;
export const GMX_ORDER_VAULT = "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5" as const;
export const GMX_ETH_USD_MARKET = "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336" as const;

// CoinGecko free API
export const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";

// DeFiLlama
export const DEFILLAMA_API_BASE = "https://api.llama.fi";

// Risk engine binary path (relative to project root)
export const RISK_ENGINE_BIN = "target/release/risk-engine";
export const RISK_ENGINE_BIN_DEBUG = "target/debug/risk-engine";

// Risk engine defaults
export const DEFAULT_TICK_SIZE = 0.01;

// Agent defaults
export const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
export const DEFAULT_DEADLINE_SECONDS = 180; // 3 minutes
export const POLL_INTERVAL_MS = 60_000; // 1 minute between analysis cycles
export const MIN_CONFIDENCE_TO_TRADE = 60; // 0-100 scale
