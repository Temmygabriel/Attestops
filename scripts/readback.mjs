// Recovers the on-chain record for an SLA and regenerates scripts/fixture.json.
//
// The CC3 public RPC serves empty eth_getLogs for this contract even though its
// eth_call reads are current — so this recovery avoids CC3 log queries entirely:
//   - CC3 contract views (slas, outcomes) -> required/minUptime/reward/collateral/
//     verified/passed/lastVerified/settled/outcome/deviceId
//   - Sepolia ServiceWindowClosed logs      -> the 10 source facts (uptime, tx, block)
//   - Captured hashes from the original run -> createTx / submitTx / settleTx
//   - getTransactionReceipt (best-effort)   -> gasUsed
//
// Usage: node --env-file=.env --experimental-strip-types scripts/readback.mjs [SLA_ID]
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JsonRpcProvider, Contract, ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const slaId = process.argv[2] || '0x978ccb4f3bed8e0e496bfa524173f0a7e4190e9c9d1dfa712d1ae14e4e793251';
const cc = new JsonRpcProvider(process.env.CREDITCOIN_RPC_URL, undefined, { staticNetwork: true });
const src = new JsonRpcProvider(process.env.SOURCE_CHAIN_RPC_URL, undefined, { staticNetwork: true });
const FLOOR = 11598000;

// retry wrapper — contract reads + receipts can still flake on the public RPC
async function retry(fn, tries = 6, label = '') {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e.shortMessage || e.message; console.log(`  ${label} retry ${i + 1}/${tries}: ${last}`); await sleep(8000 * (i + 1)); }
  }
  throw new Error(`${label} failed after ${tries} tries: ${last}`);
}

const settle = new Contract(process.env.SLA_SETTLEMENT_ADDRESS, [
  'function slas(bytes32) view returns (bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)',
  'function outcomes(bytes32) view returns (uint8)',
], cc);

// [1] CC3 state — ground truth for the SLA record.
const s = await retry(() => settle.slas(slaId), 6, 'slas');
if (s[0] === ethers.ZeroHash) throw new Error('SLA not found on chain');
const [deviceId, , sourceEmitter, required, minUptime, reward, collateral, verified, passed, lastVerified, settled] = s;
const outcome = Number(await retry(() => settle.outcomes(slaId), 6, 'outcomes'));

// [2] Sepolia facts — the 10 ServiceWindowClosed txs (uptime, tx, block).
const swcTopic = ethers.id('ServiceWindowClosed(bytes32,uint256,uint256,uint256)');
const swc = await retry(
  () => src.getLogs({ address: process.env.SERVICE_REGISTRY_ADDRESS, topics: [swcTopic, deviceId], fromBlock: FLOOR, toBlock: 'latest' }),
  6, 'SWC logs'
);
const windows = swc
  .map((l) => {
    const [uptimeBps] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], l.data);
    return { windowId: Number(BigInt(l.topics[2])), uptimeBps: Number(uptimeBps), tx: l.transactionHash, block: l.blockNumber };
  })
  .sort((a, b) => a.windowId - b.windowId);
if (windows.length < required) throw new Error(`found ${windows.length} source windows, expected ${required}`);

// [3] Hashes captured by the original run (all confirmed mined).
const createTx = '0x06e27d67eababe824be98f2941e060670d03c452b53234f642ac7bb359b05cab';
const submitTx = '0xecb9973fd1efd1492389a3f80950a0eab3a744a9318d9d9ed45fbaa0276ff2fa';
const settleTx = '0xbfcc3362f11365d78df31da75a299be01321799931b09eb38fb4eb9781d80967';

// [4] Best-effort gasUsed for the batch-proof submission.
let gasUsed;
try { const rc = await retry(() => cc.getTransactionReceipt(submitTx), 4, 'receipt'); gasUsed = rc ? String(rc.gasUsed) : undefined; }
catch { gasUsed = undefined; }

const old = JSON.parse(readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const deviceName = old.deviceName;
const fixture = {
  label: `${deviceName} · v1 · ${Number(required)} windows · ${outcome === 1 ? 'settled FULL' : 'settled PARTIAL'}`,
  deviceId,
  sourceEmitter,
  createTx,
  submitTx,
  settleTx,
  sla: {
    required: Number(required),
    minUptime: Number(minUptime),
    reward: reward.toString(),
    collateral: collateral.toString(),
    verified: Number(verified),
    passed: Number(passed),
    lastVerified: Number(lastVerified),
    settled,
  },
  outcome,
  windows: windows.slice(0, Number(required)).map((w) => ({ windowId: w.windowId, uptimeBps: w.uptimeBps, tx: w.tx, block: w.block })),
  verified: windows.slice(0, Number(required)).map((w) => ({ windowId: w.windowId, uptimeBps: w.uptimeBps, passed: w.uptimeBps >= Number(minUptime) })),
  gasUsed,
};

const out = { deviceName, slaId, fixture };
writeFileSync(path.join(__dirname, 'fixture.json'), JSON.stringify(out, null, 2));
console.log('\n=== FIXTURE REGENERATED (scripts/fixture.json) ===');
console.log(JSON.stringify(out, null, 2));
