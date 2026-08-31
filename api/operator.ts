// AttestOps — demo operator (Vercel serverless function).
//
// This is the "operator desk" behind the frontend. The visitor at the console never
// signs anything: THIS function holds a funded testnet wallet (Vercel env vars) and
// broadcasts the real transactions on their behalf, so the demo shows the genuine
// mechanism — real source facts on Sepolia, a real escrowed SLA on Creditcoin, real
// Attestcoin batch proofs verified by the Block Prover precompile, real settlement.
//
// Actions:
//   POST /api/operator { action: 'start',   deviceName, requiredWindows?, minUptimeBps?,
//                                                  collateralCTC?, rewardCTC? }
//       -> registers the device on Sepolia, closes N windows (real facts), creates the
//          escrowed SLA on Creditcoin. Returns slaId + the close txs.
//   POST /api/operator { action: 'advance', slaId }
//       -> proves the next contiguous run of closed-but-unverified windows. If the
//          highest block is not yet attested, returns { status: 'waiting-attestation',
//          retryIn: 15 } and the browser polls again (attestation can take minutes, which
//          exceeds a serverless function timeout — so the wait happens across calls).
//   POST /api/operator { action: 'settle',  slaId }
//       -> settles the completed SLA; returns the outcome + settle tx.
//
// Security posture: public + testnet-only. Device names are unique on-chain (a second
// SLA on the same device is impossible by design), the demo wallet holds worthless test
// CTC, and an in-process rate limiter dampens abuse. Never put a funded mainnet key here.
import { JsonRpcProvider, Wallet, Contract, ethers } from 'ethers';
import { proofProvider, chainInfo } from '@gluwa/usc-sdk';

// ---- env (Vercel Environment Variables) -------------------------------------
const env = (k: string) => process.env[k] || '';
const C = {
  ccRpc: env('CREDITCOIN_RPC_URL'),
  srcRpc: env('SOURCE_CHAIN_RPC_URL'),
  chainKey: Number(env('SOURCE_CHAIN_KEY') || 1),
  proofBuilder: env('PROOF_BUILDER_URL'),
  srcReg: env('SERVICE_REGISTRY_ADDRESS'),
  settle: env('SLA_SETTLEMENT_ADDRESS'),
  // Vercel: OPERATOR_PRIVATE_KEY. Local: falls back to the repo's DEPLOYER_PRIVATE_KEY.
  operatorKey: env('OPERATOR_PRIVATE_KEY') || env('DEPLOYER_PRIVATE_KEY'),
};

const SWC_TOPIC = ethers.id('ServiceWindowClosed(bytes32,uint256,uint256,uint256)');
const FROM_BLOCK = 11598000; // Sepolia RPC caps eth_getLogs range at 50k blocks

// Uptimes per window, all >= 9800 bps so a 9800-bps commitment settles FULL.
// The brief's demo SLA is 10 windows (story §8.1, script §24).
const WINDOW_UPTIMES = [9850, 9900, 9920, 9880, 9950, 9840, 9890, 9930, 9860, 9910];

const SRC_ABI = [
  'function devices(bytes32) view returns (address operator, bool exists)',
  'function registerDevice(bytes32 deviceId)',
  'function createServiceWindow(bytes32 deviceId, uint256 uptimeBps, uint256 rewardAmount) returns (uint256 windowId)',
  'function closeServiceWindow(bytes32 deviceId, uint256 windowId)',
];

const SETTLE_ABI = [
  'function registerSourceEmitter(address)',
  'function registeredEmitters(address) view returns (bool)',
  'function createSLA(bytes32 slaId, bytes32 deviceId, address sourceEmitter, uint256 requiredWindows, uint256 minimumUptimeBps, uint256 collateral, uint256 reward) payable returns (bytes32)',
  'function submitProvenBatch(bytes32 slaId, uint64 chainKey, uint64[] heights, bytes[] txBytes, (bytes32 root, (bytes32 hash, bool isLeft)[] siblings)[] merkleProofs, (bytes32 lowerEndpointDigest, bytes32[] roots) sharedContinuityProof)',
  'function settle(bytes32 slaId)',
  'function slas(bytes32) view returns (bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)',
  'function outcomes(bytes32) view returns (uint8)',
  'function consumedSourceTx(bytes32) view returns (bool)',
];

// ---- tiny helpers -----------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v ?? dflt));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const clampNum = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v ?? dflt);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const parseEth = (n: number) => ethers.parseEther(String(n));
const slaIdFor = (deviceId: string) =>
  ethers.keccak256(deviceId + ethers.id('attestops-sla-v1').slice(2));

async function latestAttested(cc: JsonRpcProvider): Promise<number> {
  const info = new chainInfo.PrecompileChainInfoProvider(cc);
  return Number((await info.getLatestAttestedHeightAndHash(C.chainKey)).height);
}

// In-process rate limiter (module state; resets on cold start — fine for a demo).
const startsByIp = new Map<string, number[]>();
function allowStart(ip: string): boolean {
  const now = Date.now();
  const recent = (startsByIp.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  startsByIp.set(ip, recent);
  return recent.length <= 4;
}

function missingEnv(): string[] {
  return Object.entries({ ...C }).filter(([, v]) => !v).map(([k]) => k);
}

// ---- actions ----------------------------------------------------------------
async function start(body: Record<string, unknown>, ip: string) {
  const name = String(body.deviceName ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(name)) throw new Error('deviceName must be 1–24 chars [A-Za-z0-9_-]');
  if (!allowStart(ip)) throw new Error('Too many commitments from this IP — slow down (demo rate limit)');

  const requiredWindows = clampInt(body.requiredWindows, 2, 10, 10);
  const minUptimeBps = clampInt(body.minUptimeBps, 5000, 10000, 9800);
  const collateral = parseEth(clampNum(body.collateralCTC, 1, 200, 100));
  const reward = parseEth(clampNum(body.rewardCTC, 1, 200, 40));

  const deviceId = ethers.id(name);
  const slaId = slaIdFor(deviceId);

  // [1] Source facts on Sepolia. Resume-safe: a retry after a mid-broadcast timeout
  //     reuses windows already closed instead of clashing on a new device/window.
  const srcProvider = new JsonRpcProvider(C.srcRpc, undefined, { staticNetwork: true });
  const srcWallet = new Wallet(C.operatorKey, srcProvider);
  const srcReg = new Contract(C.srcReg, SRC_ABI, srcWallet);

  const dev = await srcReg.devices(deviceId);
  if (dev.exists && dev.operator.toLowerCase() !== srcWallet.address.toLowerCase()) {
    throw new Error(`Device "${name}" is owned by another operator — pick a new name`);
  }
  if (!dev.exists) {
    await (await srcReg.registerDevice(deviceId)).wait();
  }

  const swcLogs = await srcProvider.getLogs({
    address: C.srcReg, topics: [SWC_TOPIC, deviceId], fromBlock: FROM_BLOCK, toBlock: 'latest',
  });
  const closed = new Map<number, { tx: string; block: number; uptime: number }>();
  for (const l of swcLogs) {
    const [uptime] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], l.data);
    closed.set(Number(BigInt(l.topics[2])), { tx: l.transactionHash!, block: l.blockNumber!, uptime: Number(uptime) });
  }

  const closeTxs: string[] = [];
  const closeBlocks: number[] = [];
  const uptimes: string[] = [];
  for (let i = 0; i < requiredWindows; i++) {
    const c = closed.get(i);
    if (c) { closeTxs.push(c.tx); closeBlocks.push(c.block); uptimes.push(String(c.uptime)); continue; }
    const u = WINDOW_UPTIMES[i % WINDOW_UPTIMES.length];
    await (await srcReg.createServiceWindow(deviceId, u, reward)).wait();
    const rc = await (await srcReg.closeServiceWindow(deviceId, i)).wait();
    closeTxs.push(rc!.hash);
    closeBlocks.push(rc!.blockNumber ?? 0);
    uptimes.push(String(u));
  }

  // [2] Escrowed SLA on Creditcoin.
  const ccProvider = new JsonRpcProvider(C.ccRpc, undefined, { staticNetwork: true });
  const ccWallet = new Wallet(C.operatorKey, ccProvider);
  const settle = new Contract(C.settle, SETTLE_ABI, ccWallet);

  if (!(await settle.registeredEmitters(C.srcReg))) {
    await (await settle.registerSourceEmitter(C.srcReg)).wait();
  }
  const existing = await settle.slas(slaId);
  const base = {
    ok: true,
    action: 'start',
    slaId,
    deviceId,
    deviceName: name,
    requiredWindows,
    minUptimeBps,
    collateral: collateral.toString(),
    reward: reward.toString(),
    uptimes,
    closeTxs,
    closeBlocks,
  };
  if (existing[0] !== ethers.ZeroHash) {
    // Already created by a prior attempt — nothing to do, report it.
    return { ...base, resume: true, createTx: '0x' };
  }

  const value = collateral + reward;
  const rc = await (
    await settle.createSLA(
      slaId, deviceId, C.srcReg, requiredWindows, minUptimeBps, collateral, reward,
      { value }
    )
  ).wait();

  return { ...base, createTx: rc!.hash };
}

async function advance(slaId: string) {
  const ccProvider = new JsonRpcProvider(C.ccRpc, undefined, { staticNetwork: true });
  const wallet = new Wallet(C.operatorKey, ccProvider);
  const settle = new Contract(C.settle, SETTLE_ABI, wallet);
  const src = new JsonRpcProvider(C.srcRpc, undefined, { staticNetwork: true });

  const slaTuple = await settle.slas(slaId);
  if (slaTuple[0] === ethers.ZeroHash) throw new Error('SLA not found on chain');
  const deviceId = slaTuple[0];
  const required = Number(slaTuple[3]);
  const verified = Number(slaTuple[7]);
  const lastVerified = Number(slaTuple[9]);
  if (slaTuple[10]) {
    return { ok: true, action: 'advance', status: 'settled', outcome: Number(await settle.outcomes(slaId)) };
  }
  if (verified >= required) {
    return { ok: true, action: 'advance', status: 'complete', verified, required };
  }

  const nextExpected = verified === 0 ? 0 : lastVerified + 1;
  const logs = await src.getLogs({
    address: C.srcReg, topics: [SWC_TOPIC, deviceId], fromBlock: FROM_BLOCK, toBlock: 'latest',
  });
  const wins = logs
    .map((l) => {
      const [uptime] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], l.data);
      return { windowId: Number(BigInt(l.topics[2])), uptime: Number(uptime), tx: l.transactionHash!, block: l.blockNumber! };
    })
    .filter((w) => w.windowId >= nextExpected)
    .sort((a, b) => a.windowId - b.windowId);

  const run: typeof wins = [];
  let exp = nextExpected;
  for (const w of wins) { if (w.windowId !== exp) break; run.push(w); exp += 1; }
  if (run.length === 0) {
    return { ok: true, action: 'advance', status: 'idle', verified, required, nextExpected };
  }

  const highest = Math.max(...run.map((w) => w.block));
  const latest = await latestAttested(ccProvider);
  if (latest < highest) {
    return { ok: true, action: 'advance', status: 'waiting-attestation', target: highest, latest, retryIn: 15, verified, required };
  }

  await sleep(3000); // prover-cache consistency after on-chain attestation

  const proofBuilder = new proofProvider.service.ProofBuilder(C.chainKey, C.proofBuilder, 30_000);
  const batchResult = await proofBuilder.getBatchProof(run.map((w) => w.tx));
  if (!batchResult.success || !batchResult.data) {
    throw new Error(`Batch proof failed: ${batchResult.error || 'unknown'}`);
  }
  const data: any = batchResult.data;
  const rows: { height: number; txBytes: string; merkleProof: unknown }[] = [];
  for (const [height, inner] of data.merkleProofs.entries()) {
    for (const [, entry] of inner.entries()) {
      rows.push({ height, txBytes: entry.txBytes, merkleProof: entry.merkleProof });
    }
  }
  rows.sort((a, b) => a.height - b.height);
  if (rows.length !== run.length) throw new Error(`Batch has ${rows.length} proofs but ${run.length} txs`);

  const heights = rows.map((r) => r.height);
  const txBytes = rows.map((r) => r.txBytes);
  const merkleProofs = rows.map((r) => r.merkleProof);

  for (let i = 0; i < txBytes.length; i++) {
    if (await settle.consumedSourceTx(ethers.keccak256(txBytes[i]))) {
      throw new Error('replay: a window tx is already consumed by another SLA');
    }
  }

  const gas = await settle.submitProvenBatch.estimateGas(
    slaId, C.chainKey, heights, txBytes, merkleProofs, data.continuityProof
  );
  const tx = await settle.submitProvenBatch(
    slaId, C.chainKey, heights, txBytes, merkleProofs, data.continuityProof,
    { gasLimit: (gas * 3n) / 2n + 200_000n }
  );
  const rc = await tx.wait();
  return {
    ok: true,
    action: 'advance',
    status: 'advanced',
    submitTx: rc!.hash,
    advanced: rows.length,
    verified: verified + rows.length,
    required,
    fromHeader: data.fromHeader,
    toHeader: data.toHeader,
  };
}

async function settleAction(slaId: string) {
  const ccProvider = new JsonRpcProvider(C.ccRpc, undefined, { staticNetwork: true });
  const wallet = new Wallet(C.operatorKey, ccProvider);
  const settle = new Contract(C.settle, SETTLE_ABI, wallet);

  const slaTuple = await settle.slas(slaId);
  if (slaTuple[0] === ethers.ZeroHash) throw new Error('SLA not found on chain');
  const required = Number(slaTuple[3]);
  const verified = Number(slaTuple[7]);
  if (slaTuple[10]) {
    return { ok: true, action: 'settle', status: 'already-settled', outcome: Number(await settle.outcomes(slaId)) };
  }
  if (verified < required) {
    return { ok: false, action: 'settle', status: 'not-ready', verified, required };
  }
  const tx = await settle.settle(slaId);
  const rc = await tx.wait();
  return {
    ok: true, action: 'settle', status: 'settled',
    settleTx: rc!.hash, outcome: Number(await settle.outcomes(slaId)),
  };
}

// ---- handler ----------------------------------------------------------------
export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  const missing = missingEnv();
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `server not configured: ${missing.join(', ')}` });
  }

  let body: Record<string, unknown> = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
  catch { return res.status(400).json({ ok: false, error: 'bad JSON body' }); }

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local';
  try {
    const action = body.action;
    if (action === 'start') return res.status(200).json(await start(body, String(ip)));
    if (action === 'advance') {
      if (!body.slaId) return res.status(400).json({ ok: false, error: 'slaId required' });
      return res.status(200).json(await advance(String(body.slaId)));
    }
    if (action === 'settle') {
      if (!body.slaId) return res.status(400).json({ ok: false, error: 'slaId required' });
      return res.status(200).json(await settleAction(String(body.slaId)));
    }
    return res.status(400).json({ ok: false, error: `unknown action: ${String(action)}` });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
