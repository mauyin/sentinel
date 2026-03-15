/**
 * Register the Sentinel agent with the Synthesis hackathon.
 *
 * Flow:
 *   1. Derive wallet address from AGENT_PRIVATE_KEY
 *   2. Check if already registered on-chain (if ERC8004_CONTRACT_ADDRESS set)
 *   3. If not: register via Synthesis Devfolio platform API
 *   4. Print result (participantId, apiKey, txHash)
 *
 * Usage: pnpm register
 *
 * The humanInfo fields below should be updated with actual values
 * before running registration.
 */

import { loadEnv } from "../src/config/env.js";
import { initLogger } from "../src/infra/logger.js";
import { getAgentAddress } from "../src/identity/wallet.js";
import {
  getAgentRegistration,
  registerAgentViaPlatform,
  registerAgentOnChain,
} from "../src/identity/erc8004.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

async function main() {
  const env = loadEnv();
  initLogger(env.LOG_LEVEL);

  const privateKey = env.AGENT_PRIVATE_KEY as `0x${string}`;
  const address = getAgentAddress(privateKey);

  console.log(`\n${BOLD}=== Sentinel Agent Registration ===${RESET}\n`);
  console.log(`  Agent address: ${address}`);

  // Step 1: Check existing registration
  if (env.ERC8004_CONTRACT_ADDRESS) {
    console.log(`\n${YELLOW}Checking on-chain registration...${RESET}`);
    const contractAddress = env.ERC8004_CONTRACT_ADDRESS as `0x${string}`;

    try {
      const reg = await getAgentRegistration(contractAddress, address, 8453);
      if (reg.isRegistered) {
        console.log(`${GREEN}  Already registered on-chain!${RESET}`);
        console.log(`  Owner: ${reg.owner}`);
        console.log(`  Metadata: ${reg.metadataURI}`);
        return;
      }
    } catch (err) {
      console.log(`${DIM}  Could not check on-chain registration (contract may not be deployed)${RESET}`);
    }
  }

  // Step 2: Register via Synthesis platform API
  console.log(`\n${YELLOW}Registering via Synthesis platform API...${RESET}`);

  try {
    const result = await registerAgentViaPlatform({
      name: "Sentinel",
      description: "Autonomous DeFi trading agent with private LLM reasoning (Venice.ai) and Rust risk engine. Analyzes markets, validates trades through institutional-grade risk management, and executes on-chain via Uniswap and GMX.",
      agentHarness: "claude-code",
      model: "llama-3.3-70b",
      humanInfo: {
        name: "REPLACE_WITH_NAME",
        email: "REPLACE_WITH_EMAIL",
        background: "builder",
        cryptoExperience: "yes",
        aiAgentExperience: "yes",
        codingComfort: 9,
        problemToSolve: "Building an autonomous DeFi trading agent that can reason privately about markets, manage risk deterministically, and execute real on-chain trades without exposing strategy data.",
      },
    });

    console.log(`\n${GREEN}${BOLD}Registration successful!${RESET}\n`);
    console.log(`  Participant ID: ${result.participantId}`);
    console.log(`  Team ID:        ${result.teamId}`);
    console.log(`  API Key:        ${result.apiKey}`);
    console.log(`  Registration Tx: ${result.registrationTxn}`);
    console.log(`\n${YELLOW}IMPORTANT: Save the API Key — it's shown only once!${RESET}`);
    console.log(`  Add to .env: SYNTHESIS_API_KEY=${result.apiKey}\n`);
  } catch (err) {
    console.error(`\n${RED}Platform registration failed:${RESET}`, err instanceof Error ? err.message : err);

    // Fallback: direct on-chain registration
    if (env.ERC8004_CONTRACT_ADDRESS) {
      console.log(`\n${YELLOW}Attempting direct on-chain registration...${RESET}`);
      try {
        const txHash = await registerAgentOnChain(
          env.ERC8004_CONTRACT_ADDRESS as `0x${string}`,
          address,
          "ipfs://sentinel-agent-metadata",
          8453,
          privateKey,
        );
        console.log(`${GREEN}  On-chain registration tx: ${txHash}${RESET}`);
      } catch (chainErr) {
        console.error(`${RED}  On-chain registration also failed:${RESET}`, chainErr instanceof Error ? chainErr.message : chainErr);
      }
    } else {
      console.log(`${DIM}  Set ERC8004_CONTRACT_ADDRESS in .env for direct on-chain fallback${RESET}`);
    }
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err);
  process.exit(1);
});
