import { privateKeyToAccount } from "viem/accounts";
import { formatEther, formatUnits } from "viem";
import { getPublicClient } from "../infra/rpc.js";
import type { SupportedChainId } from "../config/chains.js";
import { CHAIN_CONFIGS } from "../config/chains.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ component: "wallet" });

export interface WalletInfo {
  address: `0x${string}`;
  balances: Record<string, string>;
}

/**
 * Derive the agent wallet address from a private key.
 */
export function getAgentAddress(privateKey: `0x${string}`): `0x${string}` {
  return privateKeyToAccount(privateKey).address;
}

/**
 * Fetch native token (ETH) balance across all supported chains.
 */
export async function getWalletInfo(
  privateKey: `0x${string}`,
): Promise<WalletInfo> {
  const address = getAgentAddress(privateKey);
  const balances: Record<string, string> = {};

  const chainIds = Object.keys(CHAIN_CONFIGS).map(Number) as SupportedChainId[];

  const results = await Promise.allSettled(
    chainIds.map(async (chainId) => {
      const client = getPublicClient(chainId);
      const balance = await client.getBalance({ address });
      const config = CHAIN_CONFIGS[chainId];
      return {
        chain: config.chain.name,
        balance: formatEther(balance),
      };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      balances[result.value.chain] = result.value.balance;
    }
  }

  log.info({ address, balances }, "wallet info fetched");
  return { address, balances };
}

/**
 * Fetch ERC-20 token balance for the agent wallet.
 */
export async function getTokenBalance(
  privateKey: `0x${string}`,
  chainId: SupportedChainId,
  tokenAddress: `0x${string}`,
  decimals: number,
): Promise<string> {
  const address = getAgentAddress(privateKey);
  const client = getPublicClient(chainId);

  const balance = (await client.readContract({
    address: tokenAddress,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [address],
  })) as bigint;

  return formatUnits(balance, decimals);
}
