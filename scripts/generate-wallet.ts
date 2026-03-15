/**
 * Generate a fresh agent wallet and print the address + private key.
 *
 * Usage: pnpm tsx scripts/generate-wallet.ts
 *
 * Copy the private key into your .env as AGENT_PRIVATE_KEY.
 * Then send funds to the address on whichever chains you want to trade on.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

console.log("=== New Agent Wallet ===\n");
console.log(`Address:     ${account.address}`);
console.log(`Private Key: ${privateKey}`);
console.log(
  "\nThis address is the same on ALL EVM chains (Base, Arbitrum, Ethereum, etc.)",
);
console.log("\nNext steps:");
console.log("1. Copy the private key into your .env file as AGENT_PRIVATE_KEY");
console.log("2. Send funds to the address above:");
console.log("   - Base:     ETH (~$2 for gas) + USDC (~$5-10 for swaps)");
console.log("   - Arbitrum: ETH (~$2 for gas + GMX execution fees)");
console.log("\nKeep the private key secret. Never commit it to git.");
