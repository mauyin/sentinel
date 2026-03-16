import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SupportedChainId } from "./chains.js";
import { getLogger } from "../infra/logger.js";

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
  venue: "uniswap" | "gmx";
  gmx?: { marketAddress: string; indexToken: string };
  initialMarginBps: number;
  maintenanceMarginBps: number;
  maxLeverage: number;
  minTradeUsd: number;
}

// ---------------------------------------------------------------------------
// YAML config schema (WS3.2)
// ---------------------------------------------------------------------------

const TokenSchema = z.object({
  symbol: z.string(),
  address: z.string().startsWith("0x"),
  decimals: z.number().int().positive(),
  coingeckoId: z.string(),
});

const MarginSchema = z.object({
  initialBps: z.number().int().positive(),
  maintenanceBps: z.number().int().positive(),
  maxLeverage: z.number().positive(),
});

const GmxConfigSchema = z.object({
  marketAddress: z.string().startsWith("0x"),
  indexToken: z.string().startsWith("0x"),
}).optional();

const MarketEntrySchema = z.object({
  id: z.string(),
  base: TokenSchema,
  quote: TokenSchema,
  chainId: z.number().int(),
  venue: z.enum(["uniswap", "gmx"]).default("uniswap"),
  gmx: GmxConfigSchema,
  margin: MarginSchema,
  minTradeUsd: z.number().positive().default(1),
});

const MarketsFileSchema = z.object({
  markets: z.array(MarketEntrySchema).min(1),
});

// ---------------------------------------------------------------------------
// Hardcoded fallback (original config)
// ---------------------------------------------------------------------------

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

const FALLBACK_MARKETS: MarketPairConfig[] = [
  {
    id: "ETH-USDC-BASE",
    baseToken: TOKENS.WETH_BASE,
    quoteToken: TOKENS.USDC_BASE,
    chainId: 8453,
    venue: "uniswap",
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
    venue: "uniswap",
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
    venue: "gmx",
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    maxLeverage: 10,
    minTradeUsd: 1,
  },
];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let _markets: MarketPairConfig[] | undefined;

/**
 * Load market config from markets.yaml (if it exists) or fall back to hardcoded.
 * Validates with Zod schema.
 */
export function loadMarkets(projectRoot: string): MarketPairConfig[] {
  if (_markets) return _markets;

  const log = getLogger();
  const yamlPath = join(projectRoot, "markets.yaml");

  if (existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, "utf-8");
      // Simple YAML parser: convert YAML to JSON-like structure
      const parsed = parseSimpleYaml(raw);
      const validated = MarketsFileSchema.parse(parsed);

      _markets = validated.markets.map((m) => ({
        id: m.id,
        baseToken: {
          symbol: m.base.symbol,
          address: m.base.address as `0x${string}`,
          decimals: m.base.decimals,
          coingeckoId: m.base.coingeckoId,
        },
        quoteToken: {
          symbol: m.quote.symbol,
          address: m.quote.address as `0x${string}`,
          decimals: m.quote.decimals,
          coingeckoId: m.quote.coingeckoId,
        },
        chainId: m.chainId as SupportedChainId,
        venue: m.venue,
        gmx: m.gmx ? { marketAddress: m.gmx.marketAddress, indexToken: m.gmx.indexToken } : undefined,
        initialMarginBps: m.margin.initialBps,
        maintenanceMarginBps: m.margin.maintenanceBps,
        maxLeverage: m.margin.maxLeverage,
        minTradeUsd: m.minTradeUsd,
      }));

      log.info({ count: _markets.length, source: "markets.yaml" }, "markets loaded from config file");
      return _markets;
    } catch (err) {
      log.warn({ err }, "failed to load markets.yaml, using hardcoded fallback");
    }
  }

  _markets = FALLBACK_MARKETS;
  log.info({ count: _markets.length, source: "hardcoded" }, "using hardcoded market config");
  return _markets;
}

/**
 * Get already-loaded markets (throws if not loaded).
 */
export function getMarkets(): MarketPairConfig[] {
  if (!_markets) throw new Error("markets not loaded — call loadMarkets() first");
  return _markets;
}

// Keep backward compatibility
export const MARKET_PAIRS = FALLBACK_MARKETS;

export function getMarketPair(id: string): MarketPairConfig | undefined {
  const markets = _markets ?? FALLBACK_MARKETS;
  return markets.find((m) => m.id === id);
}

export function getMarketsForChain(chainId: SupportedChainId): MarketPairConfig[] {
  const markets = _markets ?? FALLBACK_MARKETS;
  return markets.filter((m) => m.chainId === chainId);
}

// ---------------------------------------------------------------------------
// Minimal YAML parser (handles the flat structure of markets.yaml)
// ---------------------------------------------------------------------------

function parseSimpleYaml(yaml: string): unknown {
  // For our specific YAML structure, we parse it into a JS object.
  // This avoids adding a yaml dependency — the structure is simple enough.
  const lines = yaml.split("\n");
  const result: Record<string, unknown[]> = {};
  let currentArray: Record<string, unknown>[] = [];
  let currentItem: Record<string, unknown> = {};
  let currentNested: Record<string, unknown> | null = null;
  let currentNestedKey = "";
  let arrayKey = "";

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indent = line.search(/\S/);

    if (indent === 0 && line.includes(":")) {
      // Top-level key (e.g., "markets:")
      arrayKey = line.split(":")[0]!.trim();
      currentArray = [];
      result[arrayKey] = currentArray;
      currentItem = {};
      currentNested = null;
      continue;
    }

    if (line.trim().startsWith("- ")) {
      // New array item
      if (Object.keys(currentItem).length > 0 && currentArray.length > 0) {
        // finalize any open nested
        if (currentNested && currentNestedKey) {
          currentItem[currentNestedKey] = currentNested;
          currentNested = null;
        }
      }
      if (Object.keys(currentItem).length > 0) {
        if (currentNested && currentNestedKey) {
          currentItem[currentNestedKey] = currentNested;
          currentNested = null;
        }
      }
      currentItem = {};
      currentArray.push(currentItem);
      // Parse the value on the same line as "-"
      const afterDash = line.trim().substring(2);
      if (afterDash.includes(":")) {
        const [k, ...rest] = afterDash.split(":");
        const v = rest.join(":").trim();
        if (v) {
          currentItem[k!.trim()] = parseValue(v);
        }
      }
      currentNested = null;
      currentNestedKey = "";
      continue;
    }

    if (line.trim().includes(":")) {
      const colonIdx = line.indexOf(":");
      const key = line.substring(0, colonIdx).trim();
      const val = line.substring(colonIdx + 1).trim();

      if (indent >= 6 && currentNested) {
        // Sub-nested value
        currentNested[key] = parseValue(val);
      } else if (indent >= 4 && val === "") {
        // Start of a nested object
        if (currentNested && currentNestedKey) {
          currentItem[currentNestedKey] = currentNested;
        }
        currentNestedKey = key;
        currentNested = {};
      } else if (indent >= 4 && val !== "") {
        // Close nested if open
        if (currentNested && currentNestedKey) {
          currentItem[currentNestedKey] = currentNested;
          currentNested = null;
          currentNestedKey = "";
        }
        currentItem[key] = parseValue(val);
      }
    }
  }

  // Finalize last item
  if (currentNested && currentNestedKey) {
    currentItem[currentNestedKey] = currentNested;
  }

  return result;
}

function parseValue(v: string): string | number | boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  // Remove quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  const num = Number(v);
  if (!isNaN(num) && v !== "") return num;
  return v;
}
