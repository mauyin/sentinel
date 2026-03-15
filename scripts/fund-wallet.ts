/**
 * Show agent wallet address and balances across all supported chains.
 * Prints faucet links for testnets and deposit addresses for mainnet.
 *
 * Usage: pnpm fund
 */

import { loadEnv } from "../src/config/env.js";
import { initLogger } from "../src/infra/logger.js";
import { getAgentAddress, getWalletInfo } from "../src/identity/wallet.js";
import { CHAIN_CONFIGS, type SupportedChainId } from "../src/config/chains.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

async function main() {
  const env = loadEnv();
  initLogger(env.LOG_LEVEL);

  const address = getAgentAddress(env.AGENT_PRIVATE_KEY as `0x${string}`);

  console.log(`\n${CYAN}${BOLD}=== Sentinel Agent Wallet ===${RESET}\n`);
  console.log(`  ${BOLD}Address:${RESET} ${address}`);
  console.log(`  ${DIM}(Same address on all EVM chains)${RESET}\n`);

  console.log(`${YELLOW}Fetching balances...${RESET}\n`);

  const wallet = await getWalletInfo(env.AGENT_PRIVATE_KEY as `0x${string}`);

  console.log(`  ${BOLD}Chain Balances (ETH):${RESET}`);
  for (const [chain, balance] of Object.entries(wallet.balances)) {
    const bal = parseFloat(balance);
    const color = bal > 0 ? GREEN : DIM;
    console.log(`    ${color}${chain}: ${balance} ETH${RESET}`);
  }

  console.log(`\n${BOLD}Testnet Faucets:${RESET}`);
  console.log(`  Base Sepolia:     https://www.alchemy.com/faucets/base-sepolia`);
  console.log(`  Arbitrum Sepolia: https://www.alchemy.com/faucets/arbitrum-sepolia`);

  console.log(`\n${BOLD}Mainnet Deposit:${RESET}`);
  console.log(`  Send ETH + USDC to: ${GREEN}${address}${RESET}`);
  console.log(`  ${DIM}Base:     ETH (~$2 gas) + USDC ($5-10 for swaps)${RESET}`);
  console.log(`  ${DIM}Arbitrum: ETH (~$2 gas + GMX execution fees)${RESET}`);
  console.log();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
