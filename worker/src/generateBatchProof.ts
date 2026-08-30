// Day 6: batch Attestcoin proof — prove MANY source txs in ONE proof.
//
// Pipeline (APIs verified against @gluwa/usc-sdk@0.18.0 runtime + type defs — nothing invented):
//
//   [tx1, tx2, tx3] (Sepolia)  →  wait for highest block attested  →  ProofBuilder.getBatchProof
//   →  flatten merkleProofs Map (ascending block height)  →  PrecompileBlockProver.verifyBatch
//
// verifyBatch is a READ-ONLY static call to the Creditcoin block prover precompile (no tx, no gas).
//
// Usage:
//   npx tsx worker/src/generateBatchProof.ts <txHash1> <txHash2> ... <txHashN>
//
import dotenv from 'dotenv';
import { JsonRpcProvider } from 'ethers';
import { proofProvider, chainInfo, blockProver } from '@gluwa/usc-sdk';
import { loadConfig, envPath } from './env';
import { makeProofBuilder, waitForAttestationResilient } from './attest';

dotenv.config({ path: envPath(), override: true });

// Batch entry types come straight from the SDK's proof-provider.merkle namespace.
type TransactionMerkleProof = proofProvider.merkle.TransactionMerkleProof;

async function main(): Promise<void> {
  const hashes = process.argv.slice(2);
  if (hashes.length < 2) {
    console.error('Usage: npx tsx worker/src/generateBatchProof.ts <txHash1> <txHash2> ... <txHashN>');
    process.exit(1);
  }
  for (const h of hashes) {
    if (!h.toLowerCase().startsWith('0x') || h.length !== 66) {
      throw new Error(`Invalid tx hash: ${h}`);
    }
  }

  const cfg = loadConfig();
  const sourceProvider = new JsonRpcProvider(cfg.sourceChainRpcUrl);
  const ccProvider = new JsonRpcProvider(cfg.creditcoinRpcUrl);

  // 1. Confirm each tx exists on the source chain and find each one's block.
  const blocks: number[] = [];
  for (const h of hashes) {
    const tx = await sourceProvider.getTransaction(h);
    if (!tx) throw new Error(`Transaction ${h} does not exist on source chain`);
    if (!tx.blockNumber) throw new Error(`Transaction ${h} is not yet mined`);
    blocks.push(tx.blockNumber);
  }
  console.log(`[1/5] ${hashes.length} txs found. Blocks: ${blocks.join(', ')}`);

  const highest = Math.max(...blocks);
  const lowest = Math.min(...blocks);

  // 2. Wait for the HIGHEST block to be attested (attestation is sequential, so this
  //    covers the whole [lowest..highest] range being available in the proof builder).
  //    Resilient wait: retries transient prover API errors instead of aborting.
  const proofBuilder = makeProofBuilder(cfg.sourceChainKey, cfg.proofBuilderUrl);
  const info = new chainInfo.PrecompileChainInfoProvider(ccProvider);
  console.log(`[2/5] Waiting for block ${highest} attestation (range ${lowest}..${highest})...`);

  await waitForAttestationResilient(proofBuilder, info, cfg.sourceChainKey, highest);

  console.log(`[3/5] Block ${highest} attested!`);

  // 3. Generate ONE batch proof covering all txs.
  const batchResult = await proofBuilder.getBatchProof(hashes);
  if (!batchResult.success || !batchResult.data) {
    throw new Error(`Batch proof generation failed: ${batchResult.error || 'unknown error'}`);
  }
  const data = batchResult.data;
  console.log(
    `[4/5] Batch proof generated: fromHeader=${data.fromHeader} toHeader=${data.toHeader} chainKey=${data.chainKey}`
  );

  // 4. Flatten the merkleProofs Map (block height -> tx index -> entry) into parallel arrays,
  //    sorted ascending by block height so the precompile sees txs in order.
  const rows: { height: number; txBytes: string; merkleProof: TransactionMerkleProof }[] = [];
  for (const [height, inner] of data.merkleProofs.entries()) {
    for (const [, entry] of inner.entries()) {
      rows.push({ height, txBytes: entry.txBytes, merkleProof: entry.merkleProof });
    }
  }
  rows.sort((a, b) => a.height - b.height);

  if (rows.length !== hashes.length) {
    throw new Error(`Batch contains ${rows.length} proofs but ${hashes.length} txs were requested`);
  }

  const heights = rows.map((r) => r.height);
  const txBytes = rows.map((r) => r.txBytes);
  const merkleProofs = rows.map((r) => r.merkleProof);

  // 5. Verify the whole batch on-chain against the block prover precompile (read-only).
  const precompile = new blockProver.PrecompileBlockProver(ccProvider);
  const verified = await precompile.verifyBatch(cfg.sourceChainKey, heights, txBytes, merkleProofs, data.continuityProof);

  if (!verified) {
    throw new Error('Batch proof verification FAILED on the precompile');
  }

  console.log(`[5/5] verifyBatch returned true — ${rows.length} txs VERIFIED in one proof`);
  console.log(`🎉 BATCH ATTESTCOIN PROOF END-TO-END: SUCCESS (${rows.length} proofs, blocks ${lowest}..${highest})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
