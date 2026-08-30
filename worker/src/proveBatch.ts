// Shared Attestcoin pipeline: turn a set of source-chain txs into a verified batch
// proof and submit it to SLASettlement.submitProvenBatch (the contract verifies the
// proof itself on the Block Prover precompile). Used by the Day 8 worker and the E2E.
//
// Split into build + submit so callers can inspect the proof (e.g. compute the replay
// keys keccak256(txBytes) and check consumedSourceTx) before paying for the submit tx.
import { JsonRpcProvider, Contract, ethers } from 'ethers';
import { chainInfo } from '@gluwa/usc-sdk';
import type { Config } from './env';
import { makeProofBuilder, waitForAttestationResilient } from './attest';
import type { ParsedLog } from './settlementAbi';

export interface BatchProofData {
  hashes: string[]; // source tx hashes, in window order
  heights: number[]; // their source-chain block heights
  txBytes: string[]; // V1 abiEncode blobs the precompile proves
  merkleProofs: unknown[];
  continuityProof: unknown;
  fromHeader: number;
  toHeader: number;
}

/**
 * Waits for the highest source tx block to be attested and generates ONE batch proof
 * over all txs. Does not submit — call submitBatchProof with the result.
 */
export async function buildBatchProof(opts: {
  sourceProvider: JsonRpcProvider;
  ccProvider: JsonRpcProvider;
  cfg: Config;
  hashes: string[];
}): Promise<BatchProofData> {
  const { sourceProvider, ccProvider, cfg, hashes } = opts;
  if (hashes.length === 0) throw new Error('buildBatchProof: no hashes given');

  // Resolve each tx's source-chain block.
  const blocks: number[] = [];
  for (const h of hashes) {
    const tx = await sourceProvider.getTransaction(h);
    if (!tx) throw new Error(`Transaction ${h} not found on source chain`);
    if (!tx.blockNumber) throw new Error(`Transaction ${h} is not yet mined`);
    blocks.push(tx.blockNumber);
  }
  const highest = Math.max(...blocks);
  const lowest = Math.min(...blocks);

  // Attestation wait (resilient to transient prover API errors).
  const proofBuilder = makeProofBuilder(cfg.sourceChainKey, cfg.proofBuilderUrl);
  const info = new chainInfo.PrecompileChainInfoProvider(ccProvider);
  console.log(`  [attest] waiting for block ${highest} (range ${lowest}..${highest})...`);
  await waitForAttestationResilient(proofBuilder, info, cfg.sourceChainKey, highest);
  console.log(`  [attest] block ${highest} attested`);

  const batchResult = await proofBuilder.getBatchProof(hashes);
  if (!batchResult.success || !batchResult.data) {
    throw new Error(`Batch proof generation failed: ${batchResult.error || 'unknown error'}`);
  }
  const data = batchResult.data;

  // Flatten merkleProofs Map (block height -> tx index -> entry), sorted ascending by height.
  const rows: { height: number; txBytes: string; merkleProof: unknown }[] = [];
  for (const [height, inner] of data.merkleProofs.entries()) {
    for (const [, entry] of inner.entries()) {
      rows.push({ height, txBytes: entry.txBytes, merkleProof: entry.merkleProof });
    }
  }
  rows.sort((a, b) => a.height - b.height);
  if (rows.length !== hashes.length) {
    throw new Error(`Batch contains ${rows.length} proofs but ${hashes.length} txs were requested`);
  }

  return {
    hashes,
    heights: rows.map((r) => r.height),
    txBytes: rows.map((r) => r.txBytes),
    merkleProofs: rows.map((r) => r.merkleProof),
    continuityProof: data.continuityProof,
    fromHeader: data.fromHeader,
    toHeader: data.toHeader,
  };
}

/** Submits a built batch proof through the contract and returns the decoded events. */
export async function submitBatchProof(opts: {
  settlement: Contract;
  cfg: Config;
  slaId: string;
  proof: BatchProofData;
}): Promise<{ receipt: ethers.ContractTransactionReceipt; verifiedWindows: ParsedLog[] }> {
  const { settlement, cfg, slaId, proof } = opts;
  const gas = await settlement.submitProvenBatch.estimateGas(
    slaId,
    cfg.sourceChainKey,
    proof.heights,
    proof.txBytes,
    proof.merkleProofs,
    proof.continuityProof
  );
  const tx = await settlement.submitProvenBatch(
    slaId,
    cfg.sourceChainKey,
    proof.heights,
    proof.txBytes,
    proof.merkleProofs,
    proof.continuityProof,
    { gasLimit: (gas * 3n) / 2n + 200_000n }
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error('submitProvenBatch: no receipt');
  const verifiedWindows = receipt.logs.filter((l: ParsedLog) => l.fragment?.name === 'WindowVerified');
  return { receipt, verifiedWindows };
}

/** Convenience: build + submit in one call (used by the Day 7 E2E). */
export async function proveAndSubmitBatch(opts: {
  settlement: Contract;
  sourceProvider: JsonRpcProvider;
  ccProvider: JsonRpcProvider;
  cfg: Config;
  slaId: string;
  hashes: string[];
}): Promise<{
  receipt: ethers.ContractTransactionReceipt;
  verifiedWindows: ParsedLog[];
  heights: number[];
  fromHeader: number;
  toHeader: number;
}> {
  const proof = await buildBatchProof({
    sourceProvider: opts.sourceProvider,
    ccProvider: opts.ccProvider,
    cfg: opts.cfg,
    hashes: opts.hashes,
  });
  const { receipt, verifiedWindows } = await submitBatchProof({
    settlement: opts.settlement,
    cfg: opts.cfg,
    slaId: opts.slaId,
    proof,
  });
  return { receipt, verifiedWindows, heights: proof.heights, fromHeader: proof.fromHeader, toHeader: proof.toHeader };
}
