// Day 5: single Attestcoin proof end-to-end.
//
// Pipeline (all APIs verified against the official `gluwa/attestcoin-protocol-examples`
// repo and the `@gluwa/usc-sdk@0.18.0` type definitions — nothing invented):
//
//   tx hash (Sepolia)  →  wait for block attestation on Creditcoin  →  ProofBuilder.getProof
//   →  PrecompileBlockProver.verifySingle (on-chain, read-only)
//
// Usage:
//   npx tsx worker/src/generateSingleProof.ts <0x transaction hash on Sepolia>
//
import dotenv from 'dotenv';
import { JsonRpcProvider } from 'ethers';
import { proofProvider, chainInfo, blockProver } from '@gluwa/usc-sdk';
import { loadConfig, envPath } from './env';

dotenv.config({ path: envPath(), override: true });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: npx tsx worker/src/generateSingleProof.ts <txHash>');
    process.exit(1);
  }
  const txHash = args[0].toLowerCase();
  if (!txHash.startsWith('0x') || txHash.length !== 66) {
    throw new Error('Invalid transaction hash (expected 0x + 64 hex chars)');
  }

  const cfg = loadConfig();
  const sourceProvider = new JsonRpcProvider(cfg.sourceChainRpcUrl);
  const ccProvider = new JsonRpcProvider(cfg.creditcoinRpcUrl);

  // 1. Confirm the tx exists on the source chain and is mined.
  const tx = await sourceProvider.getTransaction(txHash);
  if (!tx) throw new Error(`Transaction ${txHash} does not exist on source chain`);
  if (!tx.blockNumber) throw new Error(`Transaction ${txHash} is not yet mined`);
  console.log(`[1/5] Found tx in source block #${tx.blockNumber}`);

  // 2. Wait for that block to be attested on Creditcoin (up to 20 min; usually ~8 min).
  const proofBuilder = new proofProvider.service.ProofBuilder(cfg.sourceChainKey, cfg.proofBuilderUrl);
  const info = new chainInfo.PrecompileChainInfoProvider(ccProvider);
  const latest = await info.getLatestAttestedHeightAndHash(cfg.sourceChainKey);
  console.log(`[2/5] Latest attested height for chain key ${cfg.sourceChainKey}: ${latest.height}`);
  console.log(`[2/5] Waiting for block ${tx.blockNumber} attestation (poll 15s, timeout 20m)...`);

  await proofBuilder.waitUntilHeightAttested(cfg.sourceChainKey, tx.blockNumber, 15_000, 1_200_000);

  console.log(`[3/5] Block ${tx.blockNumber} attested!`);

  // 3. Generate the Attestcoin proof of the transaction.
  const proofResult = await proofBuilder.getProof(txHash);
  if (!proofResult.success || !proofResult.data) {
    throw new Error(`Proof generation failed: ${proofResult.error || 'unknown error'}`);
  }
  const proof = proofResult.data;
  console.log(`[4/5] Proof generated for tx ${txHash}`);
  console.log(`      chainKey=${proof.chainKey} headerNumber=${proof.headerNumber} txIndex=${proof.txIndex}`);
  console.log(`      continuity roots=${proof.continuityProof.roots.length} cached=${proof.cached}`);

  // 4. Verify the proof on-chain against the Creditcoin block prover precompile (read-only call).
  //    NOTE: verified at runtime — the class lives at top-level `blockProver.PrecompileBlockProver`
  //    (SDK 0.18.0), not `proofProvider.blockProver` as the SDK docstrings claim.
  const precompile = new blockProver.PrecompileBlockProver(ccProvider);
  const verified = await precompile.verifySingle(
    proof.chainKey,
    proof.headerNumber,
    proof.txBytes,
    proof.merkleProof,
    proof.continuityProof
  );

  if (!verified) {
    throw new Error('Proof verification FAILED on the precompile');
  }

  console.log(`[5/5] verifySingle returned true — proof VERIFIED on Creditcoin precompile`);
  console.log('🎉 SINGLE ATTESTCOIN PROOF END-TO-END: SUCCESS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
