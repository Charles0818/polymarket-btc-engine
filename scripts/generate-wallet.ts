/**
 * Generate a fresh Ethereum wallet for the Polymarket trading engine.
 *
 * Usage:
 *   npx tsx scripts/generate-wallet.ts
 *
 * This creates a random wallet and prints the private key, address,
 * and mnemonic. Copy the private key into your .env file.
 *
 * IMPORTANT: Save your mnemonic phrase somewhere safe — it's the only
 * way to recover this wallet if you lose the private key.
 */

import { Wallet } from "ethers";

const wallet = Wallet.createRandom();

console.log("\n" + "=".repeat(55));
console.log("  New Wallet Generated");
console.log("=".repeat(55));
console.log(`  Address:      ${wallet.address}`);
console.log(`  Private Key:  ${wallet.privateKey}`);
console.log(`  Mnemonic:     ${wallet.mnemonic?.phrase}`);
console.log("=".repeat(55));
console.log("\n  Next steps:");
console.log("  1. Copy the Private Key into your .env file as PRIVATE_KEY");
console.log("  2. Save the mnemonic phrase in a secure location");
console.log("  3. Fund this address with USDC on Polygon");
console.log("  4. Approve the Polymarket CTF Exchange (see scripts/approve-exchange.ts)");
console.log("  5. Accept Polymarket ToS by signing in at polymarket.com with this wallet");
console.log("");
console.log("  ⚠  Never share your private key or mnemonic with anyone.");
console.log("");
