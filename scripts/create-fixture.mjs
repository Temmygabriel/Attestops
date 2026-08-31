// Creates the brief's canonical demo SLA on live testnets and emits a
// ready-to-paste SNAPSHOTS + DEVICE_NAMES entry for web/index.html.
//
// 1. start  -> 10 ServiceWindowClosed facts on Sepolia + escrowed SLA on Creditcoin
// 2. advance -> waits for Attestcoin attestation, submits ONE batch proof (retries
//               through the flaky public RPCs)
// 3. settle  -> FULL PASS, payout returned
// 4. prints  -> a JSON block with every real hash / block / uptime / gas
//
// Usage: node --env-file=.env --experimental-strip-types scripts/create-fixture.mjs [DEVICE_NAME]
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { JsonRpcProvider, ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { default: handler } = await import(
  pathToFileURL(path.join(__dirname, '..', 'api', 'operator.ts')).href
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRes() {
  const out = { statusCode: 0, body: null };
  const res = {
    setHeader() {},
    status(c) { out.statusCode = c; return res; },
    json(b) { out.body = b; return res; },
    end() {},
  };
  return { res, out };
}

// Retries through transient RPC timeouts. `advance` re-reads on-chain state on every
// entry, so a retry after a mid-broadcast timeout self-corrects (consumed txs are
// skipped because verifiedWindows already advanced).
async function call(action, payload = {}, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    const req = { method: 'POST', headers: { 'x-forwarded-for': 'local-fixture' }, body: { action, ...payload } };
    const { res, out } = makeRes();
    await handler(req, res);
    if (out.statusCode === 200 && out.body && out.body.ok !== false) {
      console.log(`\n[${action}] ${JSON.stringify(out.body)}`);
      return out.body;
    }
    last = (out.body && out.body.error) || `HTTP ${out.statusCode}`;
    console.log(`   retry ${i + 1}/${tries} after: ${last}`);
    await sleep(20000 * (i + 1));
  }
  throw new Error(`${action} failed: ${JSON.stringify(last)}`);
}

const name = process.argv[2] || 'NODE-010';
console.log(`\n=== creating 10-window fixture for "${name}" ===`);

const started = await call('start', {
  deviceName: name,
  requiredWindows: 10,
  minUptimeBps: 9800,
  collateralCTC: 100,
  rewardCTC: 40,
});
const { slaId, deviceId } = started;

let final = null;
for (let i = 0; i < 60; i++) {
  final = await call('advance', { slaId });
  if (final.status === 'complete' || final.status === 'settled') break;
  if (final.status === 'idle') { console.log('  idle — no unproven windows'); break; }
  const wait = (final.retryIn ?? 15) * 1000;
  console.log(`  poll ${i + 1}/60 — attestation latest ${final.latest} / target ${final.target} (${final.verified}/${final.required} verified) — waiting ${wait / 1000}s`);
  await sleep(wait);
}
if (final.status !== 'complete' && final.status !== 'settled') {
  console.error('\n[ABORT] did not reach complete:', JSON.stringify(final, null, 2));
  process.exit(1);
}

const settled = await call('settle', { slaId });

// Derive the on-chain record from logs (bounded fromBlock — the CC3 public RPC
// times out scanning from genesis). Works whether this run created the SLA or
// resumed an already-created one.
const cc = new JsonRpcProvider(process.env.CREDITCOIN_RPC_URL, undefined, { staticNetwork: true });
const FLOOR = 11598000;
const wvTopic = ethers.id('WindowVerified(bytes32,uint256,uint256,bool)');
const stTopic = ethers.id('Settled(bytes32,uint8)');
const scTopic = ethers.id('SLACreated(bytes32,address,bytes32,address,uint256,uint256,uint256,uint256)');
const [vLogs, sLogs, cLogs] = await Promise.all([
  cc.getLogs({ address: process.env.SLA_SETTLEMENT_ADDRESS, topics: [wvTopic, slaId], fromBlock: FLOOR, toBlock: 'latest' }),
  cc.getLogs({ address: process.env.SLA_SETTLEMENT_ADDRESS, topics: [stTopic, slaId], fromBlock: FLOOR, toBlock: 'latest' }),
  cc.getLogs({ address: process.env.SLA_SETTLEMENT_ADDRESS, topics: [scTopic, slaId], fromBlock: FLOOR, toBlock: 'latest' }),
]);
const verified = vLogs
  .map((l) => {
    const d = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'bool'], l.data);
    return { windowId: Number(d[0]), uptimeBps: Number(d[1]), passed: d[2], tx: l.transactionHash };
  })
  .sort((a, b) => a.windowId - b.windowId);
const createTx = (cLogs[0] && cLogs[0].transactionHash) || started.createTx;
const submitTx = verified.length ? verified[0].tx : undefined;
const settleTx = (sLogs[0] && sLogs[0].transactionHash) || settled.settleTx;

async function gasOf(tx) {
  if (!tx) return undefined;
  try { const rc = await cc.getTransactionReceipt(tx); return rc ? String(rc.gasUsed) : undefined; }
  catch { return undefined; }
}

const fixture = {
  label: `${name} · v1 · ${started.requiredWindows} windows · settled FULL`,
  deviceId,
  createTx,
  submitTx,
  settleTx,
  sla: {
    required: started.requiredWindows,
    minUptime: started.minUptimeBps,
    reward: started.reward,
    collateral: started.collateral,
    verified: verified.length,
    passed: verified.filter((v) => v.passed).length,
    lastVerified: verified.length ? verified[verified.length - 1].windowId : 0,
    settled: true,
  },
  outcome: settled.outcome,
  windows: started.uptimes.map((u, i) => ({
    windowId: i,
    uptimeBps: Number(u),
    tx: started.closeTxs[i],
    block: started.closeBlocks[i],
  })),
  verified: verified.map((v) => ({ windowId: v.windowId, uptimeBps: v.uptimeBps, passed: v.passed })),
  gasUsed: await gasOf(submitTx),
};

const out = { deviceName: name, slaId, fixture };
writeFileSync(path.join(__dirname, 'fixture.json'), JSON.stringify(out, null, 2));
console.log('\n=== FIXTURE (written to scripts/fixture.json) ===');
console.log(JSON.stringify(out, null, 2));
