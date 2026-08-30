// Resilient attestation wait.
//
// The SDK's ProofBuilder.waitUntilHeightAttested polls the prover API but does NOT retry
// transient HTTP errors (a slow 10s axios response aborts the whole wait — we hit this on
// the prover service on 2026-08-30). This helper:
//   1. Fast-paths: if the block is already attested on-chain, just do the consistency delay.
//   2. Retries the SDK wait with backoff on transient errors.
//   3. Uses a larger axios timeout on the ProofBuilder so slow responses survive.
import { proofProvider, chainInfo } from '@gluwa/usc-sdk';

export interface WaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  extraDelayMs?: number;
}

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 20 * 60_000; // 20 minutes
const DEFAULT_EXTRA_DELAY_MS = 5_000;
const RETRY_BACKOFF_MS = 10_000;
const AXIOS_TIMEOUT_MS = 30_000; // ProofBuilder axios timeout (SDK default is only 10s)

/** Build a ProofBuilder with a generous axios timeout. */
export function makeProofBuilder(chainKey: number, builderUrl: string): proofProvider.service.ProofBuilder {
  return new proofProvider.service.ProofBuilder(chainKey, builderUrl, AXIOS_TIMEOUT_MS);
}

/**
 * Wait until `targetHeight` is attested AND available in the proof builder cache.
 * Resolves once ready; throws if `timeoutMs` elapses.
 */
export async function waitForAttestationResilient(
  proofBuilder: proofProvider.service.ProofBuilder,
  info: chainInfo.PrecompileChainInfoProvider,
  chainKey: number,
  targetHeight: number,
  opts: WaitOptions = {}
): Promise<void> {
  const { pollIntervalMs = DEFAULT_POLL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, extraDelayMs = DEFAULT_EXTRA_DELAY_MS } = opts;
  const start = Date.now();

  // Fast path: already attested on-chain -> just wait for prover-cache consistency.
  let latest: number;
  try {
    latest = (await info.getLatestAttestedHeightAndHash(chainKey)).height;
  } catch (e: any) {
    console.warn(`Could not read latest attested height on-chain (${e.message}). Proceeding to SDK wait.`);
    latest = -1;
  }

  if (latest >= targetHeight) {
    console.log(
      `[wait] Block ${targetHeight} already attested on-chain (latest ${latest}) — consistency delay ${extraDelayMs}ms, then go`
    );
    await new Promise((r) => setTimeout(r, extraDelayMs));
    return;
  }

  console.log(`[wait] Latest attested ${latest}. Waiting for block ${targetHeight} attestation...`);

  while (Date.now() - start < timeoutMs) {
    const remaining = Math.max(30_000, timeoutMs - (Date.now() - start));
    try {
      await proofBuilder.waitUntilHeightAttested(chainKey, targetHeight, pollIntervalMs, remaining, extraDelayMs);
      return;
    } catch (e: any) {
      console.warn(`[wait] Prover API error (${e.message}). Retrying in ${RETRY_BACKOFF_MS}ms...`);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }

  throw new Error(`Timeout waiting for block ${targetHeight} attestation on chain key ${chainKey}`);
}
