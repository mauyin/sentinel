import { getPublicClient, getWalletClient } from "../infra/rpc.js";
import type { SupportedChainId } from "../config/chains.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ component: "erc8004" });

// ERC-8004 ABI for reading and writing agent registration
const erc8004Abi = [
  {
    name: "agentOwner",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentAddress", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "agentMetadataURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentAddress", type: "address" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "isRegisteredAgent",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentAddress", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "registerAgent",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentAddress", type: "address" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [],
  },
] as const;

export interface AgentRegistration {
  isRegistered: boolean;
  owner?: `0x${string}`;
  metadataURI?: string;
}

/**
 * Read on-chain ERC-8004 registration for an agent address.
 */
export async function getAgentRegistration(
  contractAddress: `0x${string}`,
  agentAddress: `0x${string}`,
  chainId: SupportedChainId,
): Promise<AgentRegistration> {
  const client = getPublicClient(chainId);

  try {
    const isRegistered = (await client.readContract({
      address: contractAddress,
      abi: erc8004Abi,
      functionName: "isRegisteredAgent",
      args: [agentAddress],
    })) as boolean;

    if (!isRegistered) {
      log.info({ agentAddress, chainId }, "agent not registered");
      return { isRegistered: false };
    }

    const [owner, metadataURI] = await Promise.all([
      client.readContract({
        address: contractAddress,
        abi: erc8004Abi,
        functionName: "agentOwner",
        args: [agentAddress],
      }) as Promise<`0x${string}`>,
      client.readContract({
        address: contractAddress,
        abi: erc8004Abi,
        functionName: "agentMetadataURI",
        args: [agentAddress],
      }) as Promise<string>,
    ]);

    log.info(
      { agentAddress, owner, metadataURI, chainId },
      "agent registration found",
    );

    return { isRegistered, owner, metadataURI };
  } catch (err) {
    log.warn(
      { err, agentAddress, contractAddress, chainId },
      "failed to read ERC-8004 registration",
    );
    return { isRegistered: false };
  }
}

/**
 * Register an agent on-chain by calling registerAgent() directly.
 */
export async function registerAgentOnChain(
  contractAddress: `0x${string}`,
  agentAddress: `0x${string}`,
  metadataURI: string,
  chainId: SupportedChainId,
  privateKey: `0x${string}`,
): Promise<`0x${string}`> {
  const walletClient = getWalletClient(chainId, privateKey);

  log.info({ contractAddress, agentAddress, chainId }, "registering agent on-chain");

  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: erc8004Abi,
    functionName: "registerAgent",
    args: [agentAddress, metadataURI],
  });

  log.info({ txHash: hash }, "agent registration tx submitted");
  return hash;
}

export interface SynthesisRegistrationPayload {
  name: string;
  description: string;
  image?: string;
  agentHarness: string;
  model: string;
  humanInfo: {
    name: string;
    email: string;
    socialMediaHandle?: string;
    background: string;
    cryptoExperience: string;
    aiAgentExperience: string;
    codingComfort: number;
    problemToSolve: string;
  };
}

export interface SynthesisRegistrationResult {
  participantId: string;
  teamId: string;
  name: string;
  apiKey: string;
  registrationTxn: string;
}

const SYNTHESIS_API_BASE = "https://synthesis.devfolio.co";

/**
 * Register agent via the Synthesis Devfolio platform API.
 * This handles on-chain ERC-8004 registration automatically.
 */
export async function registerAgentViaPlatform(
  payload: SynthesisRegistrationPayload,
): Promise<SynthesisRegistrationResult> {
  log.info({ name: payload.name }, "registering agent via Synthesis platform");

  const response = await fetch(`${SYNTHESIS_API_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Synthesis registration failed (${response.status}): ${body}`);
  }

  const result = (await response.json()) as SynthesisRegistrationResult;
  log.info(
    { participantId: result.participantId, teamId: result.teamId },
    "agent registered via platform",
  );

  return result;
}
