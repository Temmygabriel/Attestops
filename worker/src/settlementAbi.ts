// Shared SLASettlement ABI + log type used by the worker and operator tools.
// Struct shapes mirror the Solidity contract exactly (submitProvenBatch params ==
// the precompile's verify params).
import { ethers } from 'ethers';

/** A receipt log as parsed by a typed Contract — carries `fragment` + `args`. */
export type ParsedLog = { fragment: { name?: string } | null; args?: ethers.Result };

export const SETTLEMENT_ABI = [
  'function registerSourceEmitter(address emitter)',
  'function registeredEmitters(address) view returns (bool)',
  'function createSLA(bytes32 slaId, bytes32 deviceId, address sourceEmitter, uint256 requiredWindows, uint256 minimumUptimeBps, uint256 collateral, uint256 reward) payable returns (bytes32)',
  'function submitProvenBatch(bytes32 slaId, uint64 chainKey, uint64[] heights, bytes[] txBytes, (bytes32 root, (bytes32 hash, bool isLeft)[] siblings)[] merkleProofs, (bytes32 lowerEndpointDigest, bytes32[] roots) sharedContinuityProof)',
  'function settle(bytes32 slaId)',
  'function slas(bytes32) view returns (bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)',
  'function outcomes(bytes32) view returns (uint8)',
  'function consumedSourceTx(bytes32) view returns (bool)',
  'function sourceChainKey() view returns (uint64)',
  'function BLOCK_PROVER_PRECOMPILE() view returns (address)',
  'event WindowVerified(bytes32 indexed slaId, uint256 windowId, uint256 uptimeBps, bool passed)',
  'event Settled(bytes32 indexed slaId, uint8 outcome)',
  'event SLACreated(bytes32 indexed slaId, address indexed operator, bytes32 deviceId, address sourceEmitter, uint256 requiredWindows, uint256 minimumUptimeBps, uint256 reward, uint256 collateral)',
];

/** The decoded `slas(bytes32)` storage tuple, indexed by SLA field. */
export interface SlaTuple {
  deviceId: string;
  operator: string;
  sourceEmitter: string;
  requiredWindows: bigint;
  minimumUptimeBps: bigint;
  reward: bigint;
  collateral: bigint;
  verifiedWindows: bigint;
  passedWindows: bigint;
  lastVerifiedWindow: bigint;
  settled: boolean;
}

export function decodeSla(r: ethers.Result): SlaTuple {
  return {
    deviceId: r[0] as string,
    operator: r[1] as string,
    sourceEmitter: r[2] as string,
    requiredWindows: r[3] as bigint,
    minimumUptimeBps: r[4] as bigint,
    reward: r[5] as bigint,
    collateral: r[6] as bigint,
    verifiedWindows: r[7] as bigint,
    passedWindows: r[8] as bigint,
    lastVerifiedWindow: r[9] as bigint,
    settled: r[10] as boolean,
  };
}
