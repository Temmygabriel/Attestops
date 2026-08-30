// Operator tool: sign a DePIN SLA commitment on Creditcoin.
//
// The operator registers the source emitter (idempotent), then calls createSLA with the
// device, required windows, minimum uptime, and escrows collateral + reward (msg.value).
// The SLA id is deterministic from the device (override with an explicit id if needed).
//
// Usage:
//   npx tsx worker/src/createSLA.ts <deviceId> <requiredWindows> <minimumUptimeBps> <collateralCTC> <rewardCTC> [slaId]
//   e.g. npx tsx worker/src/createSLA.ts 0xc2e5... 4 9800 100 40
import dotenv from 'dotenv';
import { JsonRpcProvider, Wallet, Contract, ethers } from 'ethers';
import { loadConfig, envPath } from './env';
import { SETTLEMENT_ABI, ParsedLog } from './settlementAbi';

dotenv.config({ path: envPath(), override: true });

async function main(): Promise<void> {
  const [deviceId, windowsArg, uptimeArg, collateralArg, rewardArg, explicitSlaId] = process.argv.slice(2);
  if (!deviceId || !windowsArg || !uptimeArg || !collateralArg || !rewardArg) {
    console.error(
      'Usage: npx tsx worker/src/createSLA.ts <deviceId> <requiredWindows> <minimumUptimeBps> <collateralCTC> <rewardCTC> [slaId]'
    );
    process.exit(1);
  }
  if (!deviceId.startsWith('0x') || deviceId.length !== 66) {
    throw new Error(`deviceId must be a 32-byte hex string, got: ${deviceId}`);
  }

  const cfg = loadConfig();
  if (!cfg.serviceRegistryAddress) throw new Error('SERVICE_REGISTRY_ADDRESS not set in ../.env');
  if (!cfg.slaSettlementAddress) throw new Error('SLA_SETTLEMENT_ADDRESS not set in ../.env');

  const requiredWindows = BigInt(windowsArg);
  const minimumUptimeBps = BigInt(uptimeArg);
  const collateral = ethers.parseEther(collateralArg);
  const reward = ethers.parseEther(rewardArg);
  const value = collateral + reward;

  const slaId = explicitSlaId || ethers.keccak256(deviceId + ethers.id('attestops-sla-v1').slice(2));
  if (!slaId.startsWith('0x') || slaId.length !== 66) throw new Error(`bad slaId: ${slaId}`);

  const ccProvider = new JsonRpcProvider(cfg.creditcoinRpcUrl);
  const wallet = new Wallet(cfg.deployerPrivateKey, ccProvider);
  const settlement = new Contract(cfg.slaSettlementAddress, SETTLEMENT_ABI, wallet);

  if (!(await settlement.registeredEmitters(cfg.serviceRegistryAddress))) {
    console.log(`Registering emitter ${cfg.serviceRegistryAddress}...`);
    const tx = await settlement.registerSourceEmitter(cfg.serviceRegistryAddress);
    const rc = await tx.wait();
    console.log(`  registered. tx=${rc!.hash}`);
  }

  const existing = await settlement.slas(slaId);
  if (existing[0] !== ethers.ZeroHash) {
    console.log(`SLA ${slaId} already exists (operator=${existing[1]}) — nothing to do`);
    return;
  }

  console.log(
    `Creating SLA:\n  slaId=${slaId}\n  device=${deviceId}\n  windows=${requiredWindows} minUptime=${minimumUptimeBps}` +
      `\n  collateral=${collateralArg} CTC + reward=${rewardArg} CTC = value ${ethers.formatEther(value)} CTC`
  );
  const tx = await settlement.createSLA(
    slaId,
    deviceId,
    cfg.serviceRegistryAddress,
    requiredWindows,
    minimumUptimeBps,
    collateral,
    reward,
    { value }
  );
  const rc = await tx.wait();
  const created = rc!.logs.find((l: ParsedLog) => l.fragment?.name === 'SLACreated');
  console.log(`Created. tx=${rc!.hash} gasUsed=${rc!.gasUsed} ${created ? 'SLACreated ✓' : ''}`);
  console.log(`\nRun the worker with:\n  npx tsx worker/src/worker.ts ${slaId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
