// Day 7 E2E: prove a full SLA history on Creditcoin and settle it.
//
// Full pipeline against real testnets:
//   [1] fetch the device's ServiceWindowClosed txs from Sepolia ServiceRegistry
//   [2] register the ServiceRegistry as a trusted emitter on SLASettlement
//   [3] createSLA (operator escrows collateral + reward)
//   [4] wait for the highest close block to be attested
//   [5] getBatchProof over all close txs
//   [6] call submitProvenBatch — the contract ITSELF verifies the batch proof on the
//       Block Prover precompile, decodes the ServiceWindowClosed events from the proven
//       txBytes, and runs the deterministic SLA checks
//   [7] settle and report the outcome
//
// Usage:
//   npx tsx worker/src/submitProvenBatch.ts
//
// Env (../.env): SERVICE_REGISTRY_ADDRESS, SLA_SETTLEMENT_ADDRESS, DEPLOYER_*, RPC URLs.
import dotenv from 'dotenv';
import { JsonRpcProvider, Wallet, Contract, ethers } from 'ethers';
import { chainInfo } from '@gluwa/usc-sdk';
import { loadConfig, envPath } from './env';
import { makeProofBuilder, waitForAttestationResilient } from './attest';

dotenv.config({ path: envPath(), override: true });

// The SLA we create against the live ServiceRegistry (Day 5-6 source facts).
const REQUIRED_WINDOWS = 4;
const MIN_UPTIME_BPS = 9800; // all four recorded uptimes (9900/9920/9850/9980) >= this -> FULL PASS
const COLLATERAL = 100n * 10n ** 18n; // 100 CTC escrowed by the operator
const REWARD = 40n * 10n ** 18n; // 40 CTC payout if the device meets the SLA
const SLA_ID = ethers.id('attestops/e2e/NODE-014/v1'); // deterministic across re-runs

const SWC_TOPIC = ethers.id('ServiceWindowClosed(bytes32,uint256,uint256,uint256)');
const FROM_BLOCK = 11598000; // Sepolia RPC caps eth_getLogs range at 50k blocks

// Minimal contract ABI — only what the E2E touches. Struct shapes mirror the Solidity
// contract exactly (submitProvenBatch params == the precompile's verify params).
const SETTLEMENT_ABI = [
  'function registerSourceEmitter(address emitter)',
  'function registeredEmitters(address) view returns (bool)',
  'function createSLA(bytes32 slaId, bytes32 deviceId, address sourceEmitter, uint256 requiredWindows, uint256 minimumUptimeBps, uint256 collateral, uint256 reward) payable returns (bytes32)',
  'function submitProvenBatch(bytes32 slaId, uint64 chainKey, uint64[] heights, bytes[] txBytes, (bytes32 root, (bytes32 hash, bool isLeft)[] siblings)[] merkleProofs, (bytes32 lowerEndpointDigest, bytes32[] roots) sharedContinuityProof)',
  'function settle(bytes32 slaId)',
  'function slas(bytes32) view returns (bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)',
  'function outcomes(bytes32) view returns (uint8)',
  'function sourceChainKey() view returns (uint64)',
  'function BLOCK_PROVER_PRECOMPILE() view returns (address)',
  'event WindowVerified(bytes32 indexed slaId, uint256 windowId, uint256 uptimeBps, bool passed)',
  'event Settled(bytes32 indexed slaId, uint8 outcome)',
  'event SLACreated(bytes32 indexed slaId, address indexed operator, bytes32 deviceId, address sourceEmitter, uint256 requiredWindows, uint256 minimumUptimeBps, uint256 reward, uint256 collateral)',
];

function logSep() {
  console.log('-'.repeat(72));
}

/** A receipt log as parsed by a typed Contract — carries `fragment` + `args`. */
type ParsedLog = { fragment: { name?: string } | null; args?: ethers.Result };

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.serviceRegistryAddress) throw new Error('SERVICE_REGISTRY_ADDRESS not set in ../.env');
  if (!cfg.slaSettlementAddress) throw new Error('SLA_SETTLEMENT_ADDRESS not set in ../.env (deploy first)');

  const sourceProvider = new JsonRpcProvider(cfg.sourceChainRpcUrl);
  const ccProvider = new JsonRpcProvider(cfg.creditcoinRpcUrl);
  const wallet = new Wallet(cfg.deployerPrivateKey, ccProvider);
  const deployer = cfg.deployerAddress.toLowerCase();

  const settlement = new Contract(cfg.slaSettlementAddress, SETTLEMENT_ABI, wallet);

  const onChainKey = Number(await settlement.sourceChainKey());
  if (onChainKey !== cfg.sourceChainKey) {
    throw new Error(
      `SLASettlement pinned to sourceChainKey ${onChainKey} but .env says ${cfg.sourceChainKey}. Refusing to continue.`
    );
  }
  const precompile = String(await settlement.BLOCK_PROVER_PRECOMPILE());
  console.log(`SLASettlement: ${cfg.slaSettlementAddress} (sourceChainKey=${onChainKey}, prover precompile=${precompile})`);

  // [1] Fetch the device's closed windows from Sepolia.
  const logs = await sourceProvider.getLogs({
    address: cfg.serviceRegistryAddress,
    topics: [SWC_TOPIC],
    fromBlock: FROM_BLOCK,
    toBlock: 'latest',
  });
  const wins = logs.map((l) => {
    const [uptime, rewardAmount] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], l.data);
    return {
      deviceId: l.topics[1]!,
      windowId: BigInt(l.topics[2]!).toString(),
      uptime: uptime.toString(),
      reward: rewardAmount.toString(),
      tx: l.transactionHash!,
      block: l.blockNumber!,
    };
  });
  if (wins.length === 0) throw new Error('No ServiceWindowClosed events found on Sepolia');
  const deviceId = wins[0].deviceId;
  wins.sort((a, b) => Number(a.windowId) - Number(b.windowId));
  const closed = wins.slice(-REQUIRED_WINDOWS);
  logSep();
  console.log(`[1] Device ${deviceId}`);
  for (const w of closed) {
    console.log(`    window=${w.windowId} uptime=${w.uptime} block=${w.block} tx=${w.tx}`);
  }

  // [2] Register the ServiceRegistry as the trusted emitter (owner-only; idempotent).
  if (!(await settlement.registeredEmitters(cfg.serviceRegistryAddress))) {
    logSep();
    console.log(`[2] Registering emitter ${cfg.serviceRegistryAddress}...`);
    const tx = await settlement.registerSourceEmitter(cfg.serviceRegistryAddress);
    const rc = await tx.wait();
    console.log(`    registered. tx=${rc!.hash} gasUsed=${rc!.gasUsed}`);
  } else {
    console.log('[2] Emitter already registered (idempotent)');
  }

  // [3] Create the SLA — operator escrows collateral + reward.
  const existing = await settlement.slas(SLA_ID);
  if (existing[0] !== ethers.ZeroHash) {
    console.log(`[3] SLA ${SLA_ID} already exists (verifiedWindows=${existing[7]}/${REQUIRED_WINDOWS})`);
  } else {
    logSep();
    console.log(`[3] Creating SLA: device=${deviceId} windows=${REQUIRED_WINDOWS} minUptime=${MIN_UPTIME_BPS} value=${COLLATERAL + REWARD}`);
    const value = COLLATERAL + REWARD;
    const tx = await settlement.createSLA(
      SLA_ID,
      deviceId,
      cfg.serviceRegistryAddress,
      REQUIRED_WINDOWS,
      MIN_UPTIME_BPS,
      COLLATERAL,
      REWARD,
      { value }
    );
    const rc = await tx.wait();
    const created = rc!.logs.find((l: ParsedLog) => l.fragment?.name === 'SLACreated');
    console.log(`    created. tx=${rc!.hash} gasUsed=${rc!.gasUsed} ${created ? 'SLACreated event ✓' : ''}`);
  }

  // [4] Attestation wait on the highest close block, then [5] batch proof.
  const hashes = closed.map((w) => w.tx);
  const highest = Math.max(...closed.map((w) => w.block));
  const lowest = Math.min(...closed.map((w) => w.block));
  logSep();
  const proofBuilder = makeProofBuilder(cfg.sourceChainKey, cfg.proofBuilderUrl);
  const info = new chainInfo.PrecompileChainInfoProvider(ccProvider);
  console.log(`[4] Waiting for block ${highest} attestation (range ${lowest}..${highest})...`);
  await waitForAttestationResilient(proofBuilder, info, cfg.sourceChainKey, highest);
  console.log(`[4] Block ${highest} attested!`);

  const batchResult = await proofBuilder.getBatchProof(hashes);
  if (!batchResult.success || !batchResult.data) {
    throw new Error(`Batch proof generation failed: ${batchResult.error || 'unknown error'}`);
  }
  const data = batchResult.data;

  const rows: { height: number; txBytes: string; merkleProof: unknown }[] = [];
  for (const [height, inner] of data.merkleProofs.entries()) {
    for (const [, entry] of inner.entries()) {
      rows.push({ height, txBytes: entry.txBytes, merkleProof: entry.merkleProof });
    }
  }
  rows.sort((a, b) => a.height - b.height);
  if (rows.length !== hashes.length) {
    throw new Error(`Batch has ${rows.length} proofs but ${hashes.length} txs requested`);
  }

  const heights = rows.map((r) => r.height);
  const txBytes = rows.map((r) => r.txBytes);
  const merkleProofs = rows.map((r) => r.merkleProof);
  logSep();
  console.log(`[5] Batch proof ready: fromHeader=${data.fromHeader} toHeader=${data.toHeader} (${rows.length} txs)`);

  // [6] Submit through the contract — the contract verifies the proof itself.
  const pre = await settlement.submitProvenBatch.estimateGas(
    SLA_ID,
    cfg.sourceChainKey,
    heights,
    txBytes,
    merkleProofs,
    data.continuityProof
  );
  logSep();
  console.log(`[6] Submitting proven batch (estimated gas ${pre})...`);
  const subTx = await settlement.submitProvenBatch(
    SLA_ID,
    cfg.sourceChainKey,
    heights,
    txBytes,
    merkleProofs,
    data.continuityProof,
    { gasLimit: pre * 3n / 2n + 200_000n }
  );
  const subRc = await subTx.wait();
  const verified = subRc!.logs.filter((l: ParsedLog) => l.fragment?.name === 'WindowVerified');
  console.log(`    tx=${subRc!.hash} gasUsed=${subRc!.gasUsed} WindowVerified=${verified.length}`);
  for (const v of verified) {
    console.log(
      `    ✓ window=${v.args!.windowId} uptime=${v.args!.uptimeBps} passed=${v.args!.passed}`
    );
  }
  if (verified.length !== REQUIRED_WINDOWS) {
    throw new Error(`Expected ${REQUIRED_WINDOWS} WindowVerified events, got ${verified.length}`);
  }

  const sla = await settlement.slas(SLA_ID);
  console.log(
    `    SLA state: verifiedWindows=${sla[7]} passedWindows=${sla[8]} lastVerifiedWindow=${sla[9]} settled=${sla[10]}`
  );

  // [7] Settle and report.
  logSep();
  const balBefore = await ccProvider.getBalance(deployer);
  const settleTx = await settlement.settle(SLA_ID);
  const settleRc = await settleTx.wait();
  const balAfter = await ccProvider.getBalance(deployer);
  const outcome = Number(await settlement.outcomes(SLA_ID)); // 0=None 1=Full 2=Partial
  const settled = settleRc!.logs.find((l: ParsedLog) => l.fragment?.name === 'Settled');
  const paidBack = balAfter - balBefore;
  console.log(`[7] settle tx=${settleRc!.hash} gasUsed=${settleRc!.gasUsed}`);
  console.log(`    outcome=${outcome} (${outcome === 1 ? 'FULL PASS' : outcome === 2 ? 'PARTIAL' : 'NONE'})`);
  console.log(`    operator balance delta: +${ethers.formatEther(paidBack)} CTC (payout − gas)`);

  if (outcome !== 1) throw new Error(`Expected FULL PASS outcome, got ${outcome}`);
  logSep();
  console.log(
    `🎉 DAY 7 E2E COMPLETE: ${REQUIRED_WINDOWS}-window SLA proven on-chain + settled FULL.`
  );
  console.log(`   SLA id   : ${SLA_ID}`);
  console.log(`   Settlement: ${cfg.slaSettlementAddress}`);
  console.log(`   Submits  : ${subRc!.hash}`);
  console.log(`   Settle   : ${settleRc!.hash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
