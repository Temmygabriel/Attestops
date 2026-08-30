// Day 8: the thin AttestOps worker.
//
//   read -> attest -> proof -> submit -> log
//
// Watches ONE SLA on Creditcoin and moves its evidence from the source chain
// (Sepolia ServiceRegistry) into SLASettlement as verified batch proofs:
//
//   1. read    — pull the SLA's on-chain state (device, verified/last window, settled)
//   2. read    — find newly closed ServiceWindowClosed txs for that device on Sepolia
//   3. attest  — wait for the highest new block to be attested by Attestcoin
//   4. proof   — getBatchProof over the new txs
//   5. submit  — submitProvenBatch (the contract verifies the proof itself)
//   6. log     — print WindowVerified events + tx hashes
//
// The worker submits the contiguous run of unverified windows starting exactly at
// `lastVerifiedWindow + 1`. Replay protection on the contract keys on
// keccak256(txBytes), so the worker builds the proof first, computes those keys, drops
// any tx already consumed by another SLA, and only then submits. If the very next
// expected window is already consumed the SLA can never advance (replay protection is
// doing its job) — the worker reports that instead of burning gas on a revert.
//
// Usage:
//   npx tsx worker/src/worker.ts <slaId> [--watch]   # one-shot, or poll forever
//   SLA id is the bytes32 from the operator's createSLA (see createSLA.ts).
import dotenv from 'dotenv';
import { JsonRpcProvider, Wallet, Contract, ethers } from 'ethers';
import { loadConfig, envPath, Config } from './env';
import { buildBatchProof, submitBatchProof } from './proveBatch';
import { SETTLEMENT_ABI, decodeSla } from './settlementAbi';

dotenv.config({ path: envPath(), override: true });

const SWC_TOPIC = ethers.id('ServiceWindowClosed(bytes32,uint256,uint256,uint256)');
const FROM_BLOCK = 11598000; // Sepolia RPC caps eth_getLogs range at 50k blocks
const POLL_MS = 60_000;

type TickResult = 'submitted' | 'idle' | 'complete' | 'settled';

interface SourceWindow {
  windowId: bigint;
  uptime: bigint;
  tx: string;
  block: number;
}

function logSep() {
  console.log('-'.repeat(72));
}

async function tick(opts: {
  settlement: Contract;
  sourceProvider: JsonRpcProvider;
  ccProvider: JsonRpcProvider;
  cfg: Config;
  slaId: string;
}): Promise<TickResult> {
  const { settlement, sourceProvider, ccProvider, cfg, slaId } = opts;

  // 1. On-chain SLA state.
  const sla = decodeSla(await settlement.slas(slaId));
  if (sla.operator === ethers.ZeroAddress) {
    throw new Error(`SLA ${slaId} not found on ${cfg.slaSettlementAddress} — create it first (see createSLA.ts)`);
  }
  console.log(
    `SLA ${slaId.slice(0, 10)}… device=${sla.deviceId.slice(0, 12)}… ` +
      `windows=${sla.verifiedWindows}/${sla.requiredWindows} lastVerified=${sla.lastVerifiedWindow} settled=${sla.settled}`
  );

  if (sla.settled) {
    const outcome = Number(await settlement.outcomes(slaId)); // 0=None 1=Full 2=Partial
    console.log(`SLA already settled (outcome=${outcome} ${outcome === 1 ? 'FULL' : outcome === 2 ? 'PARTIAL' : 'NONE'})`);
    return 'settled';
  }
  if (sla.verifiedWindows >= sla.requiredWindows) {
    console.log(`SLA complete (${sla.verifiedWindows}/${sla.requiredWindows} verified) — operator should call settle()`);
    return 'complete';
  }

  const nextExpected = sla.verifiedWindows === 0n ? 0n : sla.lastVerifiedWindow + 1n;
  console.log(`Next expected window: ${nextExpected}`);

  // 2. Newly closed windows for this device on the source chain.
  const logs = await sourceProvider.getLogs({
    address: cfg.serviceRegistryAddress,
    topics: [SWC_TOPIC, sla.deviceId],
    fromBlock: FROM_BLOCK,
    toBlock: 'latest',
  });
  const wins: SourceWindow[] = logs
    .map((l) => {
      const [uptime] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], l.data);
      return {
        windowId: BigInt(l.topics[2]!),
        uptime: uptime as bigint,
        tx: l.transactionHash!,
        block: l.blockNumber!,
      };
    })
    .filter((w) => w.windowId >= nextExpected)
    .sort((a, b) => (a.windowId < b.windowId ? -1 : 1));

  // Contiguous run starting exactly at nextExpected (the contract enforces strict ordering).
  const run: SourceWindow[] = [];
  let expected = nextExpected;
  for (const w of wins) {
    if (w.windowId !== expected) break;
    run.push(w);
    expected += 1n;
  }

  if (run.length === 0) {
    if (wins.length === 0) {
      console.log(`No new windows for device (next expected ${nextExpected}) — nothing to do`);
    } else {
      console.log(`Next window is ${wins[0].windowId}, but the SLA needs ${nextExpected} first (gap) — nothing to submit`);
    }
    return 'idle';
  }

  console.log(`Found ${run.length} unverified window(s): ${run.map((w) => `${w.windowId}@${w.block}`).join(', ')}`);
  for (const w of run) {
    console.log(`  window=${w.windowId} uptime=${w.uptime} tx=${w.tx}`);
  }

  // 3-4. Attest + proof.
  logSep();
  const proof = await buildBatchProof({ sourceProvider, ccProvider, cfg, hashes: run.map((w) => w.tx) });

  // Replay guard: the contract keys consumedSourceTx on keccak256(txBytes). Drop any tx
  // another SLA already consumed. If the FIRST expected window is consumed, this SLA
  // cannot advance (replay protection) — report and stop rather than revert on-chain.
  const keys = proof.txBytes.map((b) => ethers.keccak256(b));
  const consumedFlags: boolean[] = [];
  for (const k of keys) consumedFlags.push(await settlement.consumedSourceTx(k));
  const firstConsumed = consumedFlags.indexOf(true);

  if (firstConsumed === 0) {
    logSep();
    console.log(`Window ${nextExpected} is already consumed by another SLA — replay protection; this SLA can never advance.`);
    return 'idle';
  }
  if (firstConsumed > 0) {
    console.log(`Trimming ${firstConsumed} already-consumed tx(s) off the front of the batch`);
    const kept = run.slice(0, firstConsumed);
    logSep();
    const trimmed = await buildBatchProof({ sourceProvider, ccProvider, cfg, hashes: kept.map((w) => w.tx) });
    await submitAndLog(settlement, cfg, slaId, trimmed, kept);
    return 'submitted';
  }

  // 5-6. Submit + log.
  await submitAndLog(settlement, cfg, slaId, proof, run);
  return 'submitted';
}

async function submitAndLog(
  settlement: Contract,
  cfg: Config,
  slaId: string,
  proof: Awaited<ReturnType<typeof buildBatchProof>>,
  run: SourceWindow[]
): Promise<void> {
  logSep();
  const { receipt, verifiedWindows } = await submitBatchProof({ settlement, cfg, slaId, proof });
  logSep();
  console.log(`submitProvenBatch tx=${receipt.hash} gasUsed=${receipt.gasUsed} blocks=${proof.fromHeader}..${proof.toHeader}`);
  for (const v of verifiedWindows) {
    console.log(`  ✓ WindowVerified window=${v.args!.windowId} uptime=${v.args!.uptimeBps} passed=${v.args!.passed}`);
  }
  if (verifiedWindows.length !== run.length) {
    throw new Error(`Expected ${run.length} WindowVerified events, got ${verifiedWindows.length}`);
  }

  const after = decodeSla(await settlement.slas(slaId));
  console.log(`SLA now: verifiedWindows=${after.verifiedWindows}/${after.requiredWindows} passedWindows=${after.passedWindows}`);
}

async function main(): Promise<void> {
  const slaId = process.argv[2];
  const watch = process.argv.includes('--watch');
  if (!slaId || !slaId.startsWith('0x') || slaId.length !== 66) {
    console.error('Usage: npx tsx worker/src/worker.ts <slaId> [--watch]');
    console.error('  slaId = the bytes32 SLA id from createSLA.ts');
    process.exit(1);
  }

  const cfg = loadConfig();
  if (!cfg.serviceRegistryAddress) throw new Error('SERVICE_REGISTRY_ADDRESS not set in ../.env');
  if (!cfg.slaSettlementAddress) throw new Error('SLA_SETTLEMENT_ADDRESS not set in ../.env');

  const sourceProvider = new JsonRpcProvider(cfg.sourceChainRpcUrl);
  const ccProvider = new JsonRpcProvider(cfg.creditcoinRpcUrl);
  const wallet = new Wallet(cfg.deployerPrivateKey, ccProvider);
  const settlement = new Contract(cfg.slaSettlementAddress, SETTLEMENT_ABI, wallet);

  const onChainKey = Number(await settlement.sourceChainKey());
  if (onChainKey !== cfg.sourceChainKey) {
    throw new Error(`SLASettlement pinned to chain key ${onChainKey}, .env says ${cfg.sourceChainKey}`);
  }
  console.log(`Worker watching SLA ${slaId} on ${cfg.slaSettlementAddress} (chain key ${onChainKey})`);
  console.log(`Source: ServiceRegistry ${cfg.serviceRegistryAddress} on Sepolia`);

  do {
    try {
      const result = await tick({ settlement, sourceProvider, ccProvider, cfg, slaId });
      if (!watch || result === 'settled' || result === 'complete') break;
    } catch (e) {
      console.error(`tick failed: ${(e as Error).message}`);
      if (!watch) throw e;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  } while (watch);

  if (watch) console.log('Worker stopped (SLA settled or complete).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
