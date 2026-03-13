import { type Chain } from "viem";
import {
  base,
  baseSepolia,
  arbitrum,
  arbitrumSepolia,
} from "viem/chains";

export type SupportedChainId = 8453 | 84532 | 42161 | 421614;

export interface ChainConfig {
  chain: Chain;
  rpcEnvKey: string;
  explorerUrl: string;
  isTestnet: boolean;
}

export const CHAIN_CONFIGS: Record<SupportedChainId, ChainConfig> = {
  // Base mainnet
  8453: {
    chain: base,
    rpcEnvKey: "BASE_RPC_URL",
    explorerUrl: "https://basescan.org",
    isTestnet: false,
  },
  // Base Sepolia
  84532: {
    chain: baseSepolia,
    rpcEnvKey: "BASE_SEPOLIA_RPC_URL",
    explorerUrl: "https://sepolia.basescan.org",
    isTestnet: true,
  },
  // Arbitrum One
  42161: {
    chain: arbitrum,
    rpcEnvKey: "ARBITRUM_RPC_URL",
    explorerUrl: "https://arbiscan.io",
    isTestnet: false,
  },
  // Arbitrum Sepolia
  421614: {
    chain: arbitrumSepolia,
    rpcEnvKey: "ARBITRUM_SEPOLIA_RPC_URL",
    explorerUrl: "https://sepolia.arbiscan.io",
    isTestnet: true,
  },
} as const;

export function getChainConfig(chainId: SupportedChainId): ChainConfig {
  return CHAIN_CONFIGS[chainId];
}

export function txUrl(chainId: SupportedChainId, txHash: string): string {
  const config = CHAIN_CONFIGS[chainId];
  return `${config.explorerUrl}/tx/${txHash}`;
}
