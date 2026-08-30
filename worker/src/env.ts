// Loads and validates the local `.env` (repo root) for the worker.
// NEVER commit real secrets — `.env` is gitignored; only `.env.example` is pushed.
import path from 'path';

export interface Config {
  creditcoinRpcUrl: string;
  creditcoinChainId: number;
  proofBuilderUrl: string;
  sourceChainKey: number;
  sourceChainRpcUrl: string;
  deployerPrivateKey: string;
  deployerAddress: string;
  serviceRegistryAddress?: string;
  slaSettlementAddress?: string;
}

export function loadConfig(): Config {
  const cfg: Config = {
    creditcoinRpcUrl: process.env.CREDITCOIN_RPC_URL || '',
    creditcoinChainId: Number(process.env.CREDITCOIN_CHAIN_ID || 0),
    proofBuilderUrl: process.env.PROOF_BUILDER_URL || '',
    sourceChainKey: Number(process.env.SOURCE_CHAIN_KEY || 0),
    sourceChainRpcUrl: process.env.SOURCE_CHAIN_RPC_URL || '',
    deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY || '',
    deployerAddress: process.env.DEPLOYER_ADDRESS || '',
    serviceRegistryAddress: process.env.SERVICE_REGISTRY_ADDRESS || undefined,
    slaSettlementAddress: process.env.SLA_SETTLEMENT_ADDRESS || undefined,
  };

  // Contract addresses are optional for proof scripts (they only matter for on-chain submission).
  const missing = Object.entries(cfg)
    .filter(([k, v]) => k !== 'serviceRegistryAddress' && k !== 'slaSettlementAddress')
    .filter(([, v]) => v === '' || v === undefined || v === 0)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`Missing env config in ../.env: ${missing.join(', ')}`);
  }

  return cfg;
}

export function envPath(): string {
  return path.resolve(__dirname, '../../.env');
}
