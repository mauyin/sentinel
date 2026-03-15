import type { Env } from "../config/env.js";
import type { SupportedChainId } from "../config/chains.js";
import type { Executor, ExecuteParams } from "./router.js";
import type { TradeResult } from "../core/types.js";
import { Decimal } from "../core/types.js";
import { getWalletClient, getPublicClient } from "../infra/rpc.js";
import { childLogger } from "../infra/logger.js";
import { exchangeRouterAbi, erc20ApproveAbi } from "./abis/exchange-router.js";
import {
  GMX_EXCHANGE_ROUTER,
  GMX_ROUTER,
  GMX_ORDER_VAULT,
  GMX_ETH_USD_MARKET,
} from "../core/constants.js";
import { encodeFunctionData } from "viem";

// GMX V2 order types
const ORDER_TYPE_MARKET_INCREASE = 2; // Open/increase position
// Execution gas estimate for GMX keepers
const EXECUTION_GAS_LIMIT = 3_000_000n;

// Zero address and bytes32
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export class GmxExecutor implements Executor {
  private log = childLogger({ component: "gmx-executor" });
  private walletClient;
  private publicClient;

  constructor(env: Env, chainId: SupportedChainId) {
    this.walletClient = getWalletClient(
      chainId,
      env.AGENT_PRIVATE_KEY as `0x${string}`,
    );
    this.publicClient = getPublicClient(chainId);
  }

  async execute(params: ExecuteParams): Promise<TradeResult> {
    const { market, side, sizeUsd, price, slippageBps } = params;

    try {
      const isLong = side === "long";
      const walletAddress = this.walletClient.account.address;

      // Determine order type: increase for opening, decrease for closing
      // For hackathon, always use increase (we don't track open positions here)
      const orderType = ORDER_TYPE_MARKET_INCREASE;

      // Calculate sizeDeltaUsd in GMX 10^30 precision
      const sizeDeltaUsd =
        BigInt(sizeUsd.mul(new Decimal(10).pow(30)).toFixed(0));

      // Collateral: use USDC for longs, WETH for shorts
      const collateralToken = isLong
        ? market.quoteToken // USDC
        : market.baseToken; // WETH

      // Calculate collateral amount in base units
      const collateralAmount = isLong
        ? BigInt(
            sizeUsd
              .mul(new Decimal(10).pow(collateralToken.decimals))
              .toFixed(0),
          )
        : BigInt(
            sizeUsd
              .div(price)
              .mul(new Decimal(10).pow(collateralToken.decimals))
              .toFixed(0),
          );

      // Estimate execution fee
      const gasPrice = await this.publicClient.getGasPrice();
      const executionFee = gasPrice * EXECUTION_GAS_LIMIT;

      // Calculate acceptable price with slippage
      const slippageMultiplier = isLong
        ? 1 + slippageBps / 10000
        : 1 - slippageBps / 10000;
      const acceptablePrice = BigInt(
        price
          .mul(new Decimal(slippageMultiplier))
          .mul(new Decimal(10).pow(30))
          .toFixed(0),
      );

      this.log.info(
        {
          market: market.id,
          side,
          sizeDeltaUsd: sizeDeltaUsd.toString(),
          collateral: collateralToken.symbol,
          collateralAmount: collateralAmount.toString(),
          executionFee: executionFee.toString(),
        },
        "creating gmx order",
      );

      // Approve collateral token to GMX Router if needed
      await this.ensureApproval(
        collateralToken.address,
        GMX_ROUTER,
        collateralAmount,
      );

      // Build multicall data
      const sendWntData = encodeFunctionData({
        abi: exchangeRouterAbi,
        functionName: "sendWnt",
        args: [GMX_ORDER_VAULT, executionFee],
      });

      const sendTokensData = encodeFunctionData({
        abi: exchangeRouterAbi,
        functionName: "sendTokens",
        args: [
          collateralToken.address,
          GMX_ORDER_VAULT,
          collateralAmount,
        ],
      });

      const createOrderData = encodeFunctionData({
        abi: exchangeRouterAbi,
        functionName: "createOrder",
        args: [
          {
            addresses: {
              receiver: walletAddress,
              cancellationReceiver: walletAddress,
              callbackContract: ZERO_ADDRESS,
              uiFeeReceiver: ZERO_ADDRESS,
              market: GMX_ETH_USD_MARKET,
              initialCollateralToken: collateralToken.address,
              swapPath: [],
            },
            numbers: {
              sizeDeltaUsd,
              initialCollateralDeltaAmount: collateralAmount,
              triggerPrice: 0n,
              acceptablePrice,
              executionFee,
              callbackGasLimit: 0n,
              minOutputAmount: 0n,
            },
            orderType,
            decreasePositionSwapType: 0,
            isLong,
            shouldUnwrapNativeToken: false,
            autoCancel: false,
            referralCode: ZERO_BYTES32,
          },
        ],
      });

      // Execute multicall
      const hash = await this.walletClient.writeContract({
        address: GMX_EXCHANGE_ROUTER,
        abi: exchangeRouterAbi,
        functionName: "multicall",
        args: [[sendWntData, sendTokensData, createOrderData]],
        value: executionFee,
      });

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
      });

      this.log.info(
        { txHash: receipt.transactionHash, market: market.id },
        "gmx order created (awaiting keeper execution)",
      );

      return {
        success: true,
        txHash: receipt.transactionHash,
        market: market.id,
        side,
        size: sizeUsd,
        price,
        timestamp: Date.now(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err, market: market.id }, "gmx order failed");

      return {
        success: false,
        market: market.id,
        side,
        size: sizeUsd,
        price,
        error: message,
        timestamp: Date.now(),
      };
    }
  }

  private async ensureApproval(
    token: `0x${string}`,
    spender: `0x${string}`,
    amount: bigint,
  ): Promise<void> {
    const allowance = (await this.publicClient.readContract({
      address: token,
      abi: erc20ApproveAbi,
      functionName: "allowance",
      args: [this.walletClient.account.address, spender],
    })) as bigint;

    if (allowance >= amount) return;

    this.log.info(
      { token, spender, amount: amount.toString() },
      "approving token for gmx",
    );

    const hash = await this.walletClient.writeContract({
      address: token,
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [spender, 2n ** 256n - 1n], // max approval
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    this.log.info({ txHash: hash }, "token approval confirmed");
  }
}
