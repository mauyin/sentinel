import { type PublicClient, erc20Abi, formatUnits } from "viem";
import { Decimal, type PortfolioSnapshot, type TokenBalance } from "../core/types.js";
import type { TokenConfig } from "../config/markets.js";
import { getLogger } from "../infra/logger.js";

/**
 * Fetch on-chain balances for a wallet across specified tokens.
 */
export async function fetchPortfolio(
  client: PublicClient,
  walletAddress: `0x${string}`,
  tokens: TokenConfig[],
  chainId: number,
  prices: Map<string, number>,
): Promise<PortfolioSnapshot> {
  const log = getLogger();
  const balances: TokenBalance[] = [];
  let totalValueUsd = new Decimal(0);

  // Fetch native ETH balance
  const ethBalance = await client.getBalance({ address: walletAddress });
  const ethFormatted = formatUnits(ethBalance, 18);
  const ethPrice = prices.get("ethereum") ?? 0;
  const ethValue = new Decimal(ethFormatted).mul(ethPrice);

  balances.push({
    symbol: "ETH",
    address: "0x0000000000000000000000000000000000000000",
    balance: new Decimal(ethFormatted),
    valueUsd: ethValue,
  });
  totalValueUsd = totalValueUsd.add(ethValue);

  // Fetch ERC-20 balances
  for (const token of tokens) {
    try {
      const raw = await client.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
      });

      const formatted = formatUnits(raw, token.decimals);
      const price = prices.get(token.coingeckoId) ?? 0;
      const value = new Decimal(formatted).mul(price);

      balances.push({
        symbol: token.symbol,
        address: token.address,
        balance: new Decimal(formatted),
        valueUsd: value,
      });
      totalValueUsd = totalValueUsd.add(value);
    } catch (err) {
      log.warn({ token: token.symbol, err }, "failed to fetch token balance");
    }
  }

  log.debug(
    { address: walletAddress, chainId, totalValueUsd: totalValueUsd.toString() },
    "portfolio fetched",
  );

  return {
    address: walletAddress,
    chainId,
    balances,
    totalValueUsd,
  };
}
