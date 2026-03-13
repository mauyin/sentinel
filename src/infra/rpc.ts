import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { type SupportedChainId, getChainConfig } from "../config/chains.js";
import { getLogger } from "./logger.js";

const clients = new Map<SupportedChainId, PublicClient>();

export function getPublicClient(
  chainId: SupportedChainId,
  rpcUrl?: string,
): PublicClient {
  const existing = clients.get(chainId);
  if (existing) return existing;

  const config = getChainConfig(chainId);
  const url = rpcUrl ?? process.env[config.rpcEnvKey];

  const client = createPublicClient({
    chain: config.chain,
    transport: http(url, {
      retryCount: 3,
      retryDelay: 1000,
      timeout: 30_000,
    }),
  });

  clients.set(chainId, client as PublicClient);
  getLogger().debug({ chainId, url }, "rpc client created");
  return client as PublicClient;
}

export function getWalletClient(
  chainId: SupportedChainId,
  privateKey: `0x${string}`,
  rpcUrl?: string,
): WalletClient<Transport, Chain, PrivateKeyAccount> {
  const config = getChainConfig(chainId);
  const url = rpcUrl ?? process.env[config.rpcEnvKey];
  const account = privateKeyToAccount(privateKey);

  return createWalletClient({
    account,
    chain: config.chain,
    transport: http(url, {
      retryCount: 3,
      retryDelay: 1000,
      timeout: 30_000,
    }),
  });
}

export function getAccount(privateKey: `0x${string}`): PrivateKeyAccount {
  return privateKeyToAccount(privateKey);
}
