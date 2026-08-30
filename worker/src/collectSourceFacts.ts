// Day 7: read the provable source facts from the Sepolia ServiceRegistry.
// Queries DeviceRegistered + ServiceWindowClosed so an SLA can be created with the
// exact deviceId and the close-window txs can be batch-proven on Creditcoin.
import dotenv from 'dotenv';
import { JsonRpcProvider, ethers } from 'ethers';
import { loadConfig, envPath } from './env';

dotenv.config({ path: envPath(), override: true });

const DEVICE_TOPIC = ethers.id('DeviceRegistered(bytes32,address)');
const SWC_TOPIC = ethers.id('ServiceWindowClosed(bytes32,uint256,uint256,uint256)');

// Sepolia RPC caps eth_getLogs range at 50k blocks; the ServiceRegistry was deployed
// around block 11599100 (Day 5), so scope queries to recent blocks only.
const FROM_BLOCK = 11598000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.serviceRegistryAddress) throw new Error('SERVICE_REGISTRY_ADDRESS not set in ../.env');
  const provider = new JsonRpcProvider(cfg.sourceChainRpcUrl);

  const deviceLogs = await provider.getLogs({
    address: cfg.serviceRegistryAddress,
    topics: [DEVICE_TOPIC],
    fromBlock: FROM_BLOCK,
    toBlock: 'latest',
  });
  console.log(`\n=== Devices (${deviceLogs.length}) ===`);
  for (const l of deviceLogs) {
    console.log(`deviceId=${l.topics[1]} tx=${l.transactionHash} block=${l.blockNumber}`);
  }

  const swcLogs = await provider.getLogs({
    address: cfg.serviceRegistryAddress,
    topics: [SWC_TOPIC],
    fromBlock: FROM_BLOCK,
    toBlock: 'latest',
  });
  console.log(`\n=== ServiceWindowClosed (${swcLogs.length}) ===`);
  const byDevice: Record<string, { windowId: string; uptime: string; reward: string; block: number; tx: string }[]> = {};
  for (const l of swcLogs) {
    const windowId = BigInt(l.topics[2]!).toString();
    const [uptime, rewardAmount] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], l.data);
    const key = l.topics[1]!;
    (byDevice[key] ??= []).push({
      windowId,
      uptime: uptime.toString(),
      reward: rewardAmount.toString(),
      block: l.blockNumber!,
      tx: l.transactionHash!,
    });
  }
  for (const [dev, wins] of Object.entries(byDevice)) {
    wins.sort((a, b) => Number(a.windowId) - Number(b.windowId));
    console.log(`\ndevice=${dev}`);
    for (const w of wins) {
      console.log(`  window=${w.windowId} uptime=${w.uptime} reward=${w.reward} block=${w.block} tx=${w.tx}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
