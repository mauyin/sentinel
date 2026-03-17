import { z } from "zod";
import type { Env } from "../config/env.js";
import type { SupportedChainId } from "../config/chains.js";
import type { Executor, ExecuteParams, CloseParams } from "./router.js";
import type { TradeResult } from "../core/types.js";
import { Decimal } from "../core/types.js";
import { getWalletClient, getPublicClient } from "../infra/rpc.js";
import { httpPost } from "../infra/http.js";
import { childLogger } from "../infra/logger.js";
import { UNISWAP_API_BASE } from "../core/constants.js";

// ---------------------------------------------------------------------------
// Zod schemas for Uniswap Trading API responses
// ---------------------------------------------------------------------------

const ApprovalSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: z.string().optional(),
  gasLimit: z.string().optional(),
});

const CheckApprovalResponseSchema = z.object({
  approval: ApprovalSchema.nullable().optional(),
  permit2Approval: ApprovalSchema.nullable().optional(),
});

const PermitDataSchema = z.object({
  domain: z.record(z.unknown()),
  types: z.record(z.unknown()),
  primaryType: z.string(),
  message: z.record(z.unknown()),
});

// The /quote response is the full object — we pass it back to /swap as-is
const QuoteResponseSchema = z
  .object({
    routing: z.string(),
    quote: z
      .object({
        output: z.string().optional(),
        outputAmount: z.string().optional(),
      })
      .optional(),
    permitData: PermitDataSchema.nullable().optional(),
    requestId: z.string().optional(),
  })
  .passthrough(); // preserve all fields so we can spread into /swap

const SwapResponseSchema = z.object({
  swap: z.object({
    to: z.string(),
    data: z.string(),
    value: z.string(),
    gasLimit: z.string().optional(),
  }),
  requestId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// UniswapExecutor
// ---------------------------------------------------------------------------

export class UniswapExecutor implements Executor {
  private log = childLogger({ component: "uniswap-executor" });
  private apiKey: string;
  private chainId: SupportedChainId;
  private walletClient;
  private publicClient;

  constructor(env: Env, chainId: SupportedChainId) {
    this.apiKey = env.UNISWAP_API_KEY;
    this.chainId = chainId;
    this.walletClient = getWalletClient(
      chainId,
      env.AGENT_PRIVATE_KEY as `0x${string}`,
    );
    this.publicClient = getPublicClient(chainId);
  }

  async execute(params: ExecuteParams): Promise<TradeResult> {
    const { market, side, sizeUsd, price, slippageBps } = params;

    try {
      // Determine swap direction
      const isBuy = side === "long";
      const tokenIn = isBuy ? market.quoteToken : market.baseToken;
      const tokenOut = isBuy ? market.baseToken : market.quoteToken;

      // Calculate amount in tokenIn base units
      const amount = isBuy
        ? sizeUsd.mul(new Decimal(10).pow(tokenIn.decimals)).toFixed(0)
        : sizeUsd
            .div(price)
            .mul(new Decimal(10).pow(tokenIn.decimals))
            .toFixed(0);

      const walletAddress = this.walletClient.account.address;
      const slippageTolerance = slippageBps / 100;

      this.log.info(
        {
          market: market.id,
          side,
          tokenIn: tokenIn.symbol,
          tokenOut: tokenOut.symbol,
          amount,
        },
        "starting uniswap swap",
      );

      // Step 1: Check approval
      await this.checkAndApprove(walletAddress, tokenIn.address, amount);

      // Step 2: Get quote (chainIds must be strings per Uniswap API)
      const quoteBody = {
        type: "EXACT_INPUT",
        amount,
        tokenInChainId: String(this.chainId),
        tokenOutChainId: String(this.chainId),
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        swapper: walletAddress,
        slippageTolerance,
        autoSlippage: "DEFAULT",
        routingPreference: "BEST_PRICE",
        spreadOptimization: "EXECUTION",
        urgency: "normal",
        permitAmount: "FULL",
      };

      const quoteRaw = await httpPost(
        `${UNISWAP_API_BASE}/quote`,
        quoteBody,
        {
          headers: {
            "x-api-key": this.apiKey,
            "x-universal-router-version": "2.0",
          },
        },
      );
      const quoteResult = QuoteResponseSchema.parse(quoteRaw);

      this.log.info(
        { routing: quoteResult.routing, requestId: quoteResult.requestId },
        "quote received",
      );

      // WS2.4: Slippage guard — reject if quote output is excessively below expected
      const quoteOutput = quoteResult.quote?.output ?? quoteResult.quote?.outputAmount;
      if (quoteOutput) {
        const outputNum = Number(quoteOutput);
        const inputNum = Number(amount);
        if (inputNum > 0 && outputNum > 0) {
          // Calculate effective slippage: if output < 95% of expected output, reject
          const expectedMinOutput = inputNum * (1 - slippageBps / 10000) * 0.95;
          if (outputNum < expectedMinOutput) {
            const effectiveSlippage = ((inputNum - outputNum) / inputNum) * 10000;
            this.log.error(
              {
                inputAmount: amount,
                quoteOutput,
                expectedMinOutput,
                effectiveSlippageBps: effectiveSlippage.toFixed(0),
              },
              "EXCESSIVE_SLIPPAGE: quote output far below expected",
            );
            throw new Error(
              `EXCESSIVE_SLIPPAGE: output ${quoteOutput} < expected min ${expectedMinOutput.toFixed(0)} (${effectiveSlippage.toFixed(0)}bps)`,
            );
          }
        }
      }

      // Step 3: Handle Permit2 signing if needed
      let signature: string | undefined;
      if (quoteResult.permitData) {
        const { domain, types, primaryType, message } =
          quoteResult.permitData;

        // Remove EIP712Domain from types (viem adds it automatically)
        const filteredTypes = Object.fromEntries(
          Object.entries(types).filter(([k]) => k !== "EIP712Domain"),
        ) as Record<string, { name: string; type: string }[]>;

        signature = await this.walletClient.signTypedData({
          domain: domain as Record<string, unknown>,
          types: filteredTypes,
          primaryType,
          message: message as Record<string, unknown>,
        });

        this.log.info("permit2 signature created");
      }

      // Step 4: Send to /swap — spread quote response directly (not wrapped)
      const isUniswapX = ["DUTCH_V2", "DUTCH_V3", "PRIORITY"].includes(
        quoteResult.routing,
      );

      // CLASSIC: include both signature + permitData (or omit both)
      // UniswapX: include signature only, omit permitData
      const swapBody = {
        ...quoteResult,
        signature: signature ?? undefined,
        ...(isUniswapX
          ? { permitData: undefined }
          : { permitData: quoteResult.permitData ?? undefined }),
        simulateTransaction: true,
      };

      const swapRaw = await httpPost(
        `${UNISWAP_API_BASE}/swap`,
        swapBody,
        {
          headers: {
            "x-api-key": this.apiKey,
            "x-universal-router-version": "2.0",
          },
        },
      );
      const swapResult = SwapResponseSchema.parse(swapRaw);

      // Validate swap data before broadcasting
      if (
        !swapResult.swap.data ||
        swapResult.swap.data === "" ||
        swapResult.swap.data === "0x"
      ) {
        throw new Error("swap returned empty calldata — aborting");
      }

      // Submit transaction on-chain
      const hash = await this.walletClient.sendTransaction({
        to: swapResult.swap.to as `0x${string}`,
        data: swapResult.swap.data as `0x${string}`,
        value: BigInt(swapResult.swap.value),
        gas: swapResult.swap.gasLimit
          ? BigInt(swapResult.swap.gasLimit)
          : undefined,
      });

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
      });

      const txHash = receipt.transactionHash;

      this.log.info({ txHash, market: market.id }, "swap executed");

      return {
        success: true,
        txHash,
        market: market.id,
        side,
        size: sizeUsd,
        price,
        timestamp: Date.now(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ err, market: market.id }, "uniswap swap failed");

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

  /**
   * Close a position by executing a reverse swap.
   * Long close = sell base token for quote token.
   * Short close = buy base token with quote token.
   */
  async closePosition(params: CloseParams): Promise<TradeResult> {
    // Close is the reverse of open: close long = sell, close short = buy
    const reverseSide = params.side === "long" ? "short" : "long";
    return this.execute({
      market: params.market,
      side: reverseSide,
      sizeUsd: params.size,
      price: params.price,
      slippageBps: params.slippageBps,
      deadlineSeconds: 180,
    });
  }

  private async checkAndApprove(
    walletAddress: string,
    token: string,
    amount: string,
  ): Promise<void> {
    const approvalRaw = await httpPost(
      `${UNISWAP_API_BASE}/check_approval`,
      {
        walletAddress,
        token,
        amount,
        chainId: this.chainId,
      },
      { headers: { "x-api-key": this.apiKey } },
    );

    const approvalResult = CheckApprovalResponseSchema.parse(approvalRaw);

    // Handle Permit2 approval (ERC-20 → Permit2 contract)
    if (approvalResult.permit2Approval) {
      this.log.info("submitting permit2 approval tx");
      const hash = await this.walletClient.sendTransaction({
        to: approvalResult.permit2Approval.to as `0x${string}`,
        data: approvalResult.permit2Approval.data as `0x${string}`,
        value: approvalResult.permit2Approval.value
          ? BigInt(approvalResult.permit2Approval.value)
          : 0n,
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
      this.log.info({ txHash: hash }, "permit2 approval confirmed");
    }

    // Handle token approval to the Uniswap router
    if (approvalResult.approval) {
      this.log.info("submitting token approval tx");
      const hash = await this.walletClient.sendTransaction({
        to: approvalResult.approval.to as `0x${string}`,
        data: approvalResult.approval.data as `0x${string}`,
        value: approvalResult.approval.value
          ? BigInt(approvalResult.approval.value)
          : 0n,
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
      this.log.info({ txHash: hash }, "token approval confirmed");
    }
  }
}
