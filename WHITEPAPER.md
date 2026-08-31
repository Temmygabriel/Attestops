# AttestOps

**Cross-Chain SLA Settlement for DePIN — where device promises become on-chain obligations, and every claim is an Attestcoin proof.**

*Two contracts · one thin worker · one screen · one story.*

---

## 1. Abstract

AttestOps lets a DePIN operator make a **verifiable uptime commitment** on one chain and have it
**proven and settled** on another. Service facts — "my device held 98% uptime this window" — are
emitted on **Sepolia**. A thin worker waits for **Attestcoin** to attest the source block, builds a
**single batch proof**, and submits it to a settlement contract on **Creditcoin**. The contract
verifies the proof itself against Creditcoin's **Block Prover precompile**, decodes the proven
transactions, and applies **deterministic SLA checks** — all on-chain, with no trusted third party.

The demo runs entirely on live testnets. Every hash below is a real transaction you can open in an
explorer. The brief's canonical scenario — **10 service windows, 98% minimum uptime, 100 CTC
collateral, 40 CTC reward** — is settled in full, verified on-chain.

---

## 2. Problem

DePIN networks promise performance — uptime, bandwidth, compute — but today those promises are
enforced by **off-chain reputation** or **centralized dashboards**. When an operator underperforms:

- Claims are unverifiable: uptime numbers come from the operator's own server or a middleman's DB.
- Cross-chain reality is ignored: a device may serve on chain A while its economic agreement lives
  on chain B, so enforcement can't reach the money.
- Settlement is non-deterministic: who decides what "good enough" means, and who gets paid what?

The result: **performance commitments are not assets.** They can't be escrowed, audited, or settled
on their own terms.

## 3. Solution

AttestOps turns a performance commitment into a **self-settling on-chain obligation**:

1. A device commits to a target uptime across N service windows, escrowing **collateral + reward**.
2. Each window's uptime is recorded as a `ServiceWindowClosed` event on the **source chain**.
3. **Attestcoin** cryptographically attests the source block.
4. A thin worker submits **one batch proof** covering all windows to the settlement contract.
5. The contract **verifies the proof itself** (Block Prover precompile), **decodes the proven
   transactions**, and runs the SLA checks — atomically.
6. Settlement is deterministic: full pass pays full reward + collateral; partial pass pays in
   proportion to passing windows; attacks are rejected wholesale.

No oracle. No trusted relayer. The proof **is** the data.

---

## 4. System Architecture

```
┌───────────────────────────┐        ┌──────────────────────────────┐
│  Sepolia (source chain)   │        │  Creditcoin CC3 (settle)     │
│                           │        │                              │
│  ServiceRegistry.sol      │        │  SLASettlement.sol           │
│  · registerDevice         │        │  · createSLA (escrow)        │
│  · createServiceWindow    │        │  · submitProvenBatch         │
│  · closeServiceWindow ────┼───────▶│  · settle / slash            │
│  emits ServiceWindowClosed│        │  verifies proof via          │
└─────────────┬─────────────┘        │  Block Prover precompile 0x0FD2
              │                      └──────────────▲───────────────┘
              │  10 facts                             │
              ▼                                       │ ONE batch proof
      ┌───────────────┐                        ┌──────┴────────┐
      │   Attestcoin   │  attests the block    │  Thin worker  │
      │  (attestation  │──────────────────────▶│ read → attest │
      │   + prover)    │                       │ → prove →     │
      └───────────────┘                        │   submit → log│
                                               └───────────────┘
```

**Components**

- **ServiceRegistry.sol** (Sepolia) — the source of facts. Registers devices, creates windows,
  closes them with the operator's self-reported uptime. Emits `ServiceWindowClosed`.
- **SLASettlement.sol** (Creditcoin) — the economic agreement. Escrows collateral + reward, verifies
  Attestcoin batch proofs, applies deterministic checks, settles deterministically.
- **Thin worker** (`worker/`) — the only moving part. Reads the SLA and source facts, waits for
  Attestcoin attestation, builds the batch proof, submits it, logs the outcome. No trust needed —
  the contract re-verifies everything the worker did.
- **Console** (`web/`, one self-contained screen) — reads the live on-chain state and renders the
  whole story: commitment, proof chain, checkpoints, settlement — with a threat lab that shows what
  the contract rejects.

---

## 5. How the Proof Chain Uses Attestcoin — In Depth

The depth of Attestcoin utilization is the core of the design. Four distinct capabilities are used,
end to end:

| Capability | Where | What it does |
|---|---|---|
| **Attestation** | `chainInfo.PrecompileChainInfoProvider` | Reads the latest attested height + hash from the `getLatestAttestedHeightAndHash` precompile — the source chain's finalized state. |
| **Wait** | `waitUntilHeightAttested` (resilient variant) | Blocks until the target block is attested, so proofs are only built against finalized facts. |
| **Batch proof** | `ProofBuilder.getBatchProof(txs[])` | Collapses **N transaction facts into one proof** with a shared continuity proof — the key to cheap cross-chain verification. |
| **On-chain verification** | Block Prover precompile `0x0FD2` | The settlement contract itself calls `verify(...)` via `staticcall`. Facts only enter the contract from transactions the precompile cryptographically proves were included on the source chain. |

**Why this is deep, not decorative:** the contract does not receive "uptime numbers." It receives
**raw proven transaction bytes** and decodes the `ServiceWindowClosed` event itself. Because the
receipt — including `status == 1` (tx succeeded) and its logs — rides inside the proven bytes, a
failed transaction, a forged log, or a reordered window cannot survive verification. The trust
boundary is cryptographic, not procedural.

---

## 6. Contract Design

### ServiceRegistry.sol (source chain)

```solidity
registerDevice(bytes32 deviceId)
createServiceWindow(bytes32 deviceId, uint256 uptimeBps, uint256 rewardAmount) → uint256 windowId
closeServiceWindow(bytes32 deviceId, uint256 windowId)
```

- Auto-incrementing window ids, uptime clamped to `≤ 10000 bps`.
- Emits `ServiceWindowClosed(bytes32 indexed deviceId, uint256 indexed windowId, uint256 uptimeBps, uint256 rewardAmount)`.

### SLASettlement.sol (settlement chain)

```solidity
registerSourceEmitter(address emitter)              // owner whitelist
createSLA(bytes32 slaId, bytes32 deviceId, address sourceEmitter,
          uint256 requiredWindows, uint256 minimumUptimeBps,
          uint256 collateral, uint256 reward) payable  // msg.value == collateral + reward
submitProvenBatch(bytes32 slaId, uint64 chainKey, uint64[] heights, bytes[] txBytes,
                  MerkleProof[] merkleProofs, ContinuityProof sharedContinuityProof)
settle(bytes32 slaId)
slash(bytes32 slaId)                                 // owner governance for abandoned SLAs
```

**Deterministic ids** keep everything reproducible:
- `deviceId = keccak256(deviceName)`
- `slaId = keccak256(deviceId ‖ keccak256("attestops-sla-v1"))`

**One SLA per commitment period:** a source window transaction can be proven for **exactly one**
SLA (replay protection). Starting a new commitment means registering a new device — enforced by
design.

---

## 7. The Deterministic SLA Checks

On every `submitProvenBatch`, the contract verifies the proof first, then applies **five checks per
fact**, atomically across the batch:

1. **Proof gate** — the batch must verify against the Block Prover precompile, or the whole
   submission reverts (`ProofVerificationFailed`).
2. **Source identity** — the proven event's emitter must be the registered source emitter.
3. **Device binding** — the proven event must belong to this SLA's device.
4. **Strict sequential ordering** — windows must arrive in order; a gap or repeat is rejected.
5. **Replay** — each proven transaction may be consumed once, ever (`ReplayDetected`).

**Threshold (not a rejection, an outcome):** a window below `minimumUptimeBps` still counts as a
verified checkpoint but does **not** pass — which feeds deterministic settlement (below).

Additional gates: correct chain key, length consistency, non-empty batches, no submission after
settlement or completion, and reverted/forged transactions can't slip through the decode.

---

## 8. Settlement Economics

| Outcome | Condition | Payout |
|---|---|---|
| **FULL** | all required windows pass | full reward + full collateral returned |
| **PARTIAL** | some windows pass | reward and collateral scaled by `passed / required` |
| **NONE** | abandoned / never completed | owner `slash` can seize the escrow (governance) |

The escrow (`collateral + reward`) is locked at `createSLA`. Settlement returns it on-chain — no
multi-sig, no operator, no waitlist.

---

## 9. Security & Threat Model

The design assumes **no party is trusted**. Attacks and the exact revert that stops each:

| Attack | Defense |
|---|---|
| Operator claims uptime it didn't achieve | Facts are proven source-chain receipts; `status == 1` and logs are inside the proof, so they can't be forged |
| Replaying a good proof on a second SLA | `consumedSourceTx` — one tx, one SLA, ever (`ReplayDetected`) |
| Submitting an out-of-order history | strict sequential ordering (`OutOfOrder`) |
| Emitting facts from the wrong contract | emitter whitelist + per-fact match (`WrongEmitter`) |
| Binding another device's windows | per-fact device match (`WrongDevice`) |
| Below-threshold windows hiding a miss | threshold check — recorded as failed, settles partial |
| A poisoned fact sneaking into a good batch | **batch atomicity** — one bad fact reverts the entire batch's state |
| Trusting a batch that doesn't verify | proof gate first, revert (`ProofVerificationFailed`) |

This is enforced by a **63-test adversarial suite** (`test/`), including batch atomicity, replay,
wrong emitter/device, ordering, below-threshold, incomplete history, reverted txs, and forged
txBytes.

---

## 10. Real On-Chain Record (all on live testnets)

Every entry below is real and settled. Source facts on Sepolia, proofs verified on Creditcoin's
Block Prover precompile, settlement on the SLASettlement contract.

**Contracts** — both deployed by the same operator wallet at the same CREATE address:
`0xB6daA5aDeeB208EBFf91FB2636E86B9dc3aEbE45` (Sepolia **ServiceRegistry**, CC3 testnet
**SLASettlement**, chain key `1`, chain id `102031`).

### NODE-010 — the canonical demo (brief §8.1 / §24) · settled FULL

10 windows · 98% min uptime · **100 CTC collateral + 40 CTC reward** · ONE batch proof.

| Step | Tx hash | Gas |
|---|---|---|
| Create SLA (escrow 140 CTC) | `0x06e27d67…` | 193,201 |
| **One batch proof → 10 WindowVerified** | `0xecb9973f…` | **673,145** |
| Settle → FULL, 140 CTC returned | `0xbfcc3362…` | 115,052 |

- Source facts: Sepolia blocks **11602226–11602245**, uptimes 9850–9950 (all ≥ 9800).
- SLA id `0x978ccb4f…` · device `NODE-010` (`0x4346f6bc…`).
- Contract state confirms `verified=10, passed=10, outcome=FULL`.

### NODE-015 · 2 windows · settled FULL

- Submit `0xd38f7eec…` (gas 245,858) → settle `0xd25fe8fe…` · SLA `0xe20e839b…`

### NODE-014 · 4 windows · settled FULL

- Submit `0x002e22c6…` (gas 408,701) → settle `0x2941017d…` · SLA `0x832b3756…`

*Explorer links to every hash are baked into the console's footer.*

---

## 11. The Console — One Screen, One Story

The deployed console (`attestops.vercel.app`) renders the whole mechanism on one screen, in the
Notary Ledger design language (aged paper, ruled ledger, rubber-stamp verdicts):

- **Commitment** — device, target uptime, windows, escrow, reward.
- **Proof chain** — the four hops *Source → Attest → Prove → Settle*, each stamped VERIFIED.
- **Checkpoints** — one ruled ledger row per window: id, uptime bar, passed/failed pill.
- **Settlement** — the rotated FULL PASS (or PARTIAL) seal, payout math, escrow release.
- **Threat lab** — overlays the live state with what the contract rejects: replay, below-target,
  proof-fails — the exact revert reasons the test suite asserts.

The site is **read-only and static** (zero secrets, public RPCs only) with an embedded verified
snapshot fallback, so it renders faithfully even if live RPC reads are unavailable.

---

## 12. Testing & Engineering

- **63 unit tests** across three suites: ServiceRegistry, SLASettlement, SettlementValidation
  (adversarial). Run with Foundry (`forge test`).
- **Real end-to-end runs** on live testnets for single, batch, and 10-window histories — recorded
  above.
- Worker is replay-safe: it computes `keccak256(txBytes)` replay keys from the proof and drops
  already-consumed transactions before paying gas.

## 13. Deployment & Operations

- `vercel.json` (`framework: null`, `outputDirectory: web`) → the site deploys as **static HTML**,
  no build, no environment variables.
- Secrets (testnet wallet key) exist **only** in local `.env` (gitignored) for the operator fixture
  tooling; the deployed surface carries none.

## 14. Roadmap

- Multi-chain sources (any attested chain) and per-SLA source selection.
- Programmatic rewards: payouts in protocol tokens, staking on top of escrow.
- Event-driven worker (listener) instead of polling; multi-SLA batching.
- Partial-failure clawbacks and dispute windows.
- Mainnet readiness: audited contracts, gas-optimized decode paths.

## 15. Links

- Console: **attestops.vercel.app** · Repo: **github.com/Temmygabriel/attestops**
- Proof chain precompile: Block Prover `0x0000000000000000000000000000000000000FD2`
- Explorers: Sepolia (source) · Creditcoin CC3 Blockscout (settle)
