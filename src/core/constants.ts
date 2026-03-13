// Uniswap Trading API
export const UNISWAP_API_BASE = "https://trading-api-labs.interface.gateway.uniswap.org/v1";

// Uniswap contracts — universal across supported chains
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

// CoinGecko free API
export const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";

// DeFiLlama
export const DEFILLAMA_API_BASE = "https://api.llama.fi";

// Risk engine binary path (relative to project root)
export const RISK_ENGINE_BIN = "target/release/risk-engine";
export const RISK_ENGINE_BIN_DEBUG = "target/debug/risk-engine";

// Agent defaults
export const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
export const DEFAULT_DEADLINE_SECONDS = 180; // 3 minutes
export const POLL_INTERVAL_MS = 60_000; // 1 minute between analysis cycles
export const MIN_CONFIDENCE_TO_TRADE = 60; // 0-100 scale
