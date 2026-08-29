# AttestOps — Competitive Build Brief
## BUIDL CTC 2026 Fall / Creditcoin + Attestcoin Protocol

> **Mission:** Build a DePIN-focused cross-chain SLA settlement protocol where infrastructure operators earn rewards only after their service history is cryptographically proven on Creditcoin through Attestcoin.
>
> **Primary objective:** Maximize the probability of finishing a credible, technically deep, memorable solo hackathon submission in ~12–14 focused days.
>
> **Product rule:** No AI inside the product. AI may be used privately as a coding assistant only.

---

# 1. Executive Decision

## Build this

### **AttestOps**
**Track:** DePIN

**One-line pitch:**

> Cross-chain infrastructure SLA settlement: operators lock collateral on Creditcoin, service records are emitted on another chain, Attestcoin batch-proves those records, and deterministic Creditcoin contracts release, withhold, or slash rewards.

The core flow is:

```text
Source-chain service records
        |
        v
10+ service transactions / checkpoints
        |
        v
Attestcoin proof builder
        |
        v
Batch proof
        |
        v
Creditcoin on-chain verification
        |
        v
Deterministic SLA state machine
        |
        +--> RELEASE
        +--> PARTIAL RELEASE
        +--> SLASH / BLOCK
```

## Do NOT build

Do not turn this into:

- another lending/borrowing dApp
- another credit-score dashboard
- another invoice-financing app
- another generic bridge
- an AI agent
- a general-purpose oracle
- a large DePIN marketplace
- a DAO/tokenomics system
- a backend-heavy analytics product
- a “proof demo” with no business logic

The Attestcoin integration must be the reason the product works, not a feature added after the fact.

---

# 2. Hackathon Strategy

The competition has an unusual structure:

- one overall prize pool
- only three winning teams overall
- five tracks
- the top three receive the CEIP fast-track opportunity

Therefore, optimize for **judge recall + technical credibility + protocol necessity**, not breadth.

The project should make the judge remember one sentence:

> **“They proved an entire cross-chain service history and used those proofs to enforce an infrastructure payment.”**

The project should make the judge believe a second sentence:

> **“This would not work in the same trust-minimized way without Attestcoin.”**

---

# 3. Current Research / Verified Baseline

## 3.1 Hackathon facts

The supplied BUIDL CTC 2026 Fall brief states:

- submissions open: August 13, 2026
- deadline: September 13, 2026 at 23:59 ET (extended)
- winner announcement: September 20, 2026
- total prize pool: $15,000
- Grand Prize: $10,000
- 2nd: $3,000
- 3rd: $2,000
- top three teams advance through the CEIP fast-track process
- every submission must meaningfully integrate the Attestcoin Protocol

Official event/docs:
- https://buidl.creditcoin.org/
- https://docs.attestcoin.org/

### Important competition-count caveat

The live DoraHacks submission count could not be independently extracted from the public crawler during research. Do **not** encode “33 submissions” as a verified fact in project materials unless a human checks the live DoraHacks event page immediately before submission.

---

# 4. What the Official Attestcoin Examples Already Teach

Official repository:

- https://github.com/gluwa/attestcoin-protocol-examples

The repository's README explicitly lists four tutorials:

1. Hello Bridge
2. Custom Contracts Bridging
3. Bridge Offchain Worker
4. Loan Flow

The repository describes them as:

### Hello Bridge
Uses pre-existing contracts on Sepolia and Creditcoin to demonstrate end-user interaction with the Creditcoin decentralized oracle.

### Custom Contracts Bridging
Shows how a DApp builder creates custom trustless cross-chain bridging logic using their own contracts.

### Bridge Offchain Worker
Shows how an off-chain worker can automate/simplify bridge transactions.

### Loan Flow
Demonstrates a more advanced cross-chain credit application with:

- ERC20 on Sepolia
- loan manager contract on Creditcoin
- auxiliary loan contract
- funding
- repayment
- source-chain event proving
- off-chain worker coordination
- cross-chain loan state tracking

The Loan Flow is therefore directly in the danger zone for a hackathon project based on “cross-chain lending/credit.”

**Decision:** Avoid loan/credit-limit clones.

---

# 5. Current SDK / Protocol Capabilities Relevant to AttestOps

The current public SDK/repository is centered around `@gluwa/usc-sdk`.

Official/current public example patterns include:

```ts
import {
  chainInfo,
  blockProver,
  proofProvider,
  utils
} from '@gluwa/usc-sdk';
```

## 5.1 Creditcoin chain-info provider

```ts
const creditcoinProvider =
  new JsonRpcProvider(CREDITCOIN_RPC_URL);

const chainInfoProvider =
  new chainInfo.PrecompileChainInfoProvider(
    creditcoinProvider
  );
```

## 5.2 Wait for source block attestation

```ts
await chainInfoProvider.waitUntilHeightAttested(
  chainKey,
  txHeight
);
```

This is important for the worker:

```text
source transaction exists
        |
        v
wait until source height is attested
        |
        v
request proof
```

## 5.3 Proof builder

```ts
const apiProvider =
  new proofProvider.service.ProofBuilder(
    chainKey,
    proofBuilderUrl
  );
```

Single proof:

```ts
const proofResult =
  await apiProvider.getProof(txHash);
```

Batch proof:

```ts
const proofResult =
  await apiProvider.getBatchProof([
    tx1,
    tx2,
    tx3,
    tx4,
    tx5
  ]);
```

## 5.4 On-chain verifier

```ts
const prover =
  new blockProver.PrecompileBlockProver(
    creditcoinProvider
  );
```

Single verification:

```ts
await prover.verifySingle(
  proofData.chainKey,
  proofData.headerNumber,
  proofData.txBytes,
  proofData.merkleProof,
  proofData.continuityProof,
);
```

Batch verification:

```ts
await prover.verifyBatch(
  proofData.chainKey,
  headers,
  txBytes,
  merkleProofs,
  proofData.continuityProof,
);
```

## 5.5 Why batch proofs matter here

Batch proofs allow AttestOps to say:

> “This SLA consists of a set of source-chain service checkpoints, and we prove the relevant history together.”

That is a stronger product story than:

```text
verify one transaction
credit one account
```

It also gives a concrete place to demonstrate depth of Attestcoin usage.

---

# 6. Relevant Current Competitive Signals

Public work discovered during research includes projects around:

- cross-chain credit history and batch verification
- invoice settlement / credit advance
- cross-chain escrow
- source-chain payments used to gate Creditcoin actions
- transaction-ordering / sandwich-defense logic using Attestcoin proofs

Examples:
- CrossCredit
- AttestDesk
- VeriSettle
- Spark
- Index41

Representative public repos:
- https://github.com/OoJae/crosscredit
- https://github.com/Qidianyan/attestdesk
- https://github.com/anhquan075/verisettle
- https://github.com/thesithunyein/spark
- https://github.com/edycutjong/index41

## Competitive implication

Do NOT attempt to win merely by claiming:

> “We use batch proofs.”

Other builders already do technically serious Attestcoin work.

The winning differentiation should instead be:

1. a problem with a clear real-world story
2. Attestcoin as the trust boundary
3. deterministic business logic after verification
4. a visually obvious adversarial demo
5. minimal architecture with high technical density

---

# 7. Why DePIN Is the Recommended Track

The five hackathon tracks are:

- DeFi
- RWA
- DePIN
- Gaming
- AI

AttestOps is deliberately placed in **DePIN** because the underlying business object is infrastructure service.

The protocol does not merely verify an arbitrary transaction.

It verifies **service checkpoints associated with an infrastructure SLA**.

This creates a clean semantic chain:

```text
physical/digital infrastructure
        |
        v
service measurement
        |
        v
source-chain service record
        |
        v
Attestcoin proof
        |
        v
Creditcoin enforcement
        |
        v
economic settlement
```

That is a better fit than forcing the system into DeFi.

---

# 8. Product Definition

## 8.1 Example user story

Alice operates a connectivity/compute/sensor node.

She enters an SLA:

```text
Device:        NODE-014
Operator:      Alice
Required SLA:  98% uptime
Windows:       10
Collateral:    100 test CTC
Reward:        40 test CTC
```

A service window closes every interval.

The source chain records:

```solidity
event ServiceWindowClosed(
    bytes32 indexed deviceId,
    uint256 indexed windowId,
    uint256 uptimeBps,
    uint256 rewardAmount
);
```

At the end of the SLA period:

1. the worker collects the relevant source-chain transactions
2. waits until their blocks are attested
3. requests one batch proof
4. calls the Creditcoin proof verifier
5. obtains deterministic proof-backed facts
6. Creditcoin SLA logic evaluates:
   - device identity
   - emitter identity
   - event ordering
   - no duplicate windows
   - uptime threshold
   - complete required sequence
7. settlement is executed

---

# 9. Product Principle: Prove a Sequence, Not a Single Event

This is the core conceptual distinction.

Weak design:

```text
Did event X happen?
yes -> pay
```

Recommended design:

```text
Did the required service sequence happen?

window 1
window 2
window 3
...
window 10

and:

- correct device
- correct emitter
- correct ordering
- correct source chain
- no replay
- source transaction succeeded
- each measurement meets SLA threshold
- all required windows present

only then -> settle
```

This makes Attestcoin an input to a **state machine**, rather than just a boolean oracle.

---

# 10. Minimal Architecture

## Contract A — Source Chain

### `ServiceRegistry.sol`

Responsibilities:

```solidity
registerDevice(...)
createServiceWindow(...)
closeServiceWindow(...)
```

Suggested state:

```solidity
mapping(bytes32 => Device) public devices;
mapping(bytes32 => mapping(uint256 => ServiceWindow))
    public serviceWindows;
```

Suggested events:

```solidity
event DeviceRegistered(
    bytes32 indexed deviceId,
    address indexed operator
);

event ServiceWindowClosed(
    bytes32 indexed deviceId,
    uint256 indexed windowId,
    uint256 uptimeBps,
    uint256 rewardAmount
);
```

This contract exists primarily to create source-chain facts that can be proven.

### Important

Do not overbuild this contract.

It is not a complete DePIN network.

It is a deterministic test environment representing infrastructure service records.

---

## Contract B — Creditcoin

### `SLASettlement.sol`

Responsibilities:

```solidity
createSLA(...)
submitVerifiedBatch(...)
settle(...)
slash(...)
```

Suggested state:

```solidity
struct SLA {
    bytes32 deviceId;
    address operator;
    address sourceEmitter;
    uint256 requiredWindows;
    uint256 minimumUptimeBps;
    uint256 reward;
    uint256 collateral;
    uint256 verifiedWindows;
    uint256 lastVerifiedWindow;
    bool settled;
}
```

The contract should maintain:

```text
lastVerifiedWindow
verifiedWindows
settled
```

and reject invalid progress.

---

# 11. Proof Flow

```text
                  SOURCE CHAIN
                       |
              ServiceWindowClosed
                       |
                       v
             source transaction IDs
                       |
                       v
              Attestcoin proof builder
                       |
                       v
                batch proof data
                       |
                       v
                 CREDITCOIN
                       |
        +--------------+--------------+
        |                             |
        v                             v
 proof verifier                 SLA validator
 verifyBatch(...)               deterministic checks
        |                             |
        +--------------+--------------+
                       |
                       v
                   settlement
```

---

# 12. Worker Design

The worker is deliberately thin.

It should:

1. watch/read source-chain service events
2. maintain a list of candidate transaction hashes for an SLA
3. ensure relevant blocks are attested
4. ask the proof builder for a batch proof
5. submit the proof material into the Creditcoin settlement contract
6. log the exact outcome

It should NOT:

- own protocol truth
- decide whether an SLA was satisfied
- maintain a shadow database of balances
- calculate settlement off-chain
- provide a centralized “approval”
- perform AI reasoning
- host a production API

The worker is a **transport and orchestration layer**, not a trusted oracle.

---

# 13. Proof Validation Strategy

The product should validate multiple dimensions.

## 13.1 Source identity

Only the registered `ServiceRegistry` emitter is trusted.

Reject:

```text
same event schema
different contract
```

Reason:

A malicious contract could emit a fake `ServiceWindowClosed` event otherwise.

---

## 13.2 Transaction success

A transaction that reverted must not count as a completed service action.

---

## 13.3 Device binding

The proven event's `deviceId` must match the SLA.

---

## 13.4 Sequential windows

Require:

```text
windowId == lastVerifiedWindow + 1
```

or support an explicit bitmap if gaps must be tolerated.

For the MVP, strict sequential ordering is easier to reason about.

---

## 13.5 No replay

A transaction hash should not be accepted twice for the same SLA.

Suggested structure:

```solidity
mapping(bytes32 => bool) public consumedSourceTx;
```

where key = source transaction hash represented in the relevant decoded form.

---

## 13.6 Threshold

For example:

```solidity
uptimeBps >= minimumUptimeBps
```

Example:

```text
98.00% = 9800 bps
```

---

## 13.7 Completeness

The settlement contract should refuse final payout until:

```text
verifiedWindows == requiredWindows
```

---

# 14. Settlement Modes

Implement three possible outcomes.

## FULL PASS

All required windows pass.

```text
reward = 100%
collateral = returned
status = SETTLED
```

## PARTIAL FAILURE

One or more windows do not satisfy the SLA.

MVP-friendly option:

```text
reward = proportional to passing windows
collateral = partially slashed
status = PARTIAL
```

## INVALID PROOF

Bad emitter, wrong device, replay, malformed sequence, or failed source transaction.

```text
settlement = rejected
```

Keep the MVP slashing formula simple.

Avoid complex financial mathematics.

---

# 15. Frontend

The UI should exist only to make the protocol legible.

Recommended screen:

```text
ATTESTOPS

SLA #014
--------------------------------
DEVICE        NODE-014
OPERATOR      Alice

COLLATERAL    100 CTC
REWARD        40 CTC
REQUIRED      98% uptime

SERVICE WINDOWS

01   98.2%     VERIFIED
02   97.9%     FAIL
03   99.1%     VERIFIED
04   98.7%     VERIFIED
...
10   99.2%     VERIFIED

ATTESTCOIN
10 SOURCE TXS
1 BATCH PROOF

CREDITCOIN
VERIFICATION: SUCCESS

RESULT
PARTIAL SETTLEMENT
```

Buttons:

```text
Create SLA
Generate Service History
Verify Batch
Settle
Inject Invalid Event
Replay Transaction
Wrong Emitter Test
```

The UI should expose the underlying transaction hashes and explorer links somewhere, but the main flow should remain visually clean.

---

# 16. The Demo Must Include an Attack

The strongest demo is not “happy path only.”

Use at least four adversarial checks.

## A. Tampered measurement

Change:

```text
Window 6:
98.0%
```

to:

```text
42.0%
```

Result:

```text
SLA NOT SATISFIED
reward blocked / reduced
```

## B. Wrong emitter

Emit the same event shape from an unauthorized contract.

Result:

```text
SOURCE EMITTER REJECTED
```

## C. Replay

Submit a previously consumed source transaction again.

Result:

```text
REPLAY REJECTED
```

## D. Out-of-order checkpoint

Attempt:

```text
window 7
```

before:

```text
window 6
```

Result:

```text
INVALID SEQUENCE
```

These tests demonstrate actual protocol understanding.

---

# 17. Why This Beats a Generic Hackathon Project

The project has a strong dependency chain:

```text
Without source-chain records:
    no service history

Without Attestcoin:
    no trust-minimized proof of that history

Without Creditcoin:
    no deterministic cross-chain settlement

Without the SLA state machine:
    proof has no business consequence
```

Each piece has a purpose.

That is the design standard to preserve.

---

# 18. Implementation Scope

## MUST HAVE

### Contracts

- [ ] Source `ServiceRegistry.sol`
- [ ] Creditcoin `SLASettlement.sol`

### Proof

- [ ] Attestcoin SDK integration
- [ ] `getBatchProof(...)`
- [ ] `verifyBatch(...)`
- [ ] source block attestation waiting
- [ ] proof-backed settlement

### Security

- [ ] registered source emitter
- [ ] device binding
- [ ] transaction-success check
- [ ] strict window ordering
- [ ] replay protection
- [ ] minimum uptime threshold
- [ ] completion requirement

### UI

- [ ] create SLA
- [ ] generate service history
- [ ] show service checkpoints
- [ ] batch verification status
- [ ] settlement result
- [ ] attack/demo controls

### Documentation

- [ ] architecture
- [ ] threat model
- [ ] protocol flow
- [ ] Attestcoin integration details
- [ ] deployment instructions
- [ ] test instructions
- [ ] demo instructions
- [ ] limitations

---

# 19. MUST NOT HAVE

Do not build:

- user accounts
- email login
- production authentication
- paid monitoring systems
- production data APIs
- real hardware integrations
- custom token
- DAO voting
- multi-marketplace
- mobile app
- complicated tokenomics
- custom bridge infrastructure
- AI agent
- AI-generated decisions
- expensive hosted database

These are scope traps.

---

# 20. Technology Stack

Use the smallest stack that gives reliable testnet execution.

## Smart contracts

- Solidity
- Foundry
- official/current Attestcoin/USC contract dependencies as required by the environment

## Worker

- TypeScript / Node.js
- `ethers`
- `@gluwa/usc-sdk`

## Frontend

Use whichever existing frontend stack is fastest for the builder.

Preferred:

- React
- Vite
- lightweight CSS
- ethers/wallet connection

Avoid introducing additional frameworks unless already familiar.

## Infrastructure

Free testnet-only resources.

No paid RPC required.

Use environment variables for:

```text
CREDITCOIN_RPC_URL
SOURCE_CHAIN_RPC_URL
CREDITCOIN_PROOF_BUILDER_URL
CREDITCOIN_WALLET_PRIVATE_KEY
SOURCE_CHAIN_KEY
...
```

Do not commit secrets.

---

# 21. Environment / Reproducibility

The repository must allow a judge to reproduce the core flow.

Provide:

```text
.env.example
```

with placeholders only.

README should contain:

```text
1. install dependencies
2. configure RPC/testnet variables
3. deploy source contract
4. deploy Creditcoin contract
5. register source emitter
6. create sample SLA
7. generate service events
8. wait for attestation
9. generate batch proof
10. submit/verify proof
11. settle
12. run adversarial tests
```

---

# 22. Repository Structure

Recommended:

```text
attestops/
├── contracts/
│   ├── source/
│   │   └── ServiceRegistry.sol
│   ├── creditcoin/
│   │   └── SLASettlement.sol
│   └── interfaces/
│
├── script/
│   ├── DeploySource.s.sol
│   ├── DeployCreditcoin.s.sol
│   └── DemoSetup.s.sol
│
├── worker/
│   ├── src/
│   │   ├── config.ts
│   │   ├── sourceReader.ts
│   │   ├── attestation.ts
│   │   ├── proofBuilder.ts
│   │   ├── batchSubmitter.ts
│   │   └── index.ts
│   └── package.json
│
├── web/
│   ├── src/
│   └── package.json
│
├── test/
│   ├── ServiceRegistry.t.sol
│   ├── SLASettlement.t.sol
│   ├── Replay.t.sol
│   ├── Ordering.t.sol
│   └── EmitterValidation.t.sol
│
├── docs/
│   ├── architecture.md
│   ├── threat-model.md
│   └── demo.md
│
├── .env.example
├── README.md
└── foundry.toml
```

---

# 23. Development Plan — 14 Focused Days

## Day 1 — Freeze the concept

Deliverables:

- [ ] repo initialized
- [ ] architecture written
- [ ] exact contracts/interfaces decided
- [ ] source event schema finalized
- [ ] SLA state machine specified
- [ ] no new product features allowed after this point without strong justification

Goal:

> Remove ambiguity before coding.

---

## Day 2 — Source contract

Build:

```solidity
ServiceRegistry.sol
```

Implement:

- device registration
- service-window creation/closure
- events
- basic validation

Tests:

- register
- duplicate device
- close valid window
- invalid operator

---

## Day 3 — Creditcoin contract skeleton

Build:

```solidity
SLASettlement.sol
```

Implement:

- SLA creation
- collateral accounting
- reward parameters
- source emitter registration
- state tracking

Do NOT integrate proof verification yet.

---

## Day 4 — Deterministic validation logic

Implement:

- device match
- emitter match
- sequential window check
- threshold
- replay protection
- completion logic

Write unit tests first.

---

## Day 5 — Attestcoin proof plumbing

Get the official SDK flow working independently:

```text
transaction hash
      ↓
waitUntilHeightAttested(...)
      ↓
ProofBuilder
      ↓
getProof(...)
      ↓
verifySingle(...)
```

Goal:

> Prove that one source transaction can be verified end-to-end.

---

## Day 6 — Batch proof

Upgrade to:

```text
getBatchProof(...)
      ↓
verifyBatch(...)
```

Start with 3 service transactions.

Then 5.

Then 10.

Goal:

> Stable batch proof path.

---

## Day 7 — Contract integration

Connect:

```text
batch verification
      ↓
SLASettlement
```

The result must update Creditcoin state only through deterministic contract logic.

Goal:

> End-to-end happy path.

---

## Day 8 — Worker

Build the simplest possible worker:

```text
read events
collect tx hashes
wait for attestation
generate batch proof
submit
```

Keep logs explicit.

Example:

```text
[1] Found 10 service checkpoints
[2] Waiting for source-chain attestation
[3] Generating batch proof
[4] Proof generated
[5] Verifying on Creditcoin
[6] SLA state updated
```

---

## Day 9 — Adversarial security tests

Implement and test:

- [ ] wrong emitter
- [ ] replay
- [ ] wrong device
- [ ] duplicate window
- [ ] out-of-order window
- [ ] below-threshold uptime
- [ ] incomplete history
- [ ] reverted source transaction

Goal:

> No happy-path demo should survive without these tests.

---

## Day 10 — Frontend

Build only the demo-critical UI.

No design rabbit hole.

Need:

- SLA card
- checkpoint table
- proof status
- settlement status
- attack toggles
- transaction links

---

## Day 11 — Real testnet deployment

Deploy everything on the target testnet.

Record:

- contract addresses
- source-chain transaction hashes
- Creditcoin transaction hashes
- proof verification transactions where applicable

Run the full flow from a clean environment.

---

## Day 12 — Reliability day

This day is not for features.

Fix:

- RPC flakiness
- proof-builder errors
- timing assumptions
- gas issues
- frontend wallet state
- block attestation waits
- deployment scripts
- README reproduction instructions

Goal:

> Another developer should be able to reproduce the demo.

---

## Day 13 — Demo + docs

Create:

- 2–3 minute demo
- architecture diagram
- threat model
- Attestcoin integration explanation
- screenshots
- project deck/whitepaper content

Practice the spoken pitch repeatedly.

---

## Day 14 — Submission hardening

Do not add meaningful new functionality.

Do:

- run every test
- run fresh deployment
- validate README
- validate demo links
- verify GitHub repo
- record final video
- check event submission fields
- check project sector = DePIN
- confirm Attestcoin integration is visibly demonstrated

---

# 24. 2–3 Minute Demo Script

## 0:00–0:20

> “AttestOps is a cross-chain SLA settlement protocol for infrastructure operators. The operator locks collateral on Creditcoin. Service evidence lives on another chain. Attestcoin proves that evidence before Creditcoin releases the money.”

Show one SLA.

---

## 0:20–0:45

Create:

```text
NODE-014
10 service windows
98% minimum uptime
100 CTC collateral
40 CTC reward
```

Show collateral locked.

---

## 0:45–1:10

Generate 10 source-chain service events.

Show:

```text
01 ✓ 98.2%
02 ✓ 97.9%
...
10 ✓ 99.2%
```

Say:

> “These records are on another chain. Creditcoin does not simply trust my frontend.”

---

## 1:10–1:35

Click:

```text
VERIFY SERVICE HISTORY
```

Show:

```text
10 source transactions
       ↓
1 Attestcoin batch proof
       ↓
Creditcoin verification
       ↓
10 verified checkpoints
```

Say:

> “The proof is generated from the source transactions and verified on-chain through the Attestcoin infrastructure.”

---

## 1:35–1:55

Click:

```text
SETTLE
```

Show:

```text
SLA COMPLETE
40 CTC RELEASED
100 CTC COLLATERAL RETURNED
```

---

## 1:55–2:20

Run tamper case:

```text
Window 06
98.0%
↓
42.0%
```

Try settlement.

Show:

```text
SETTLEMENT REJECTED
```

Then optionally demonstrate wrong emitter or replay.

---

## 2:20–2:40

Say:

> “The important part is that the frontend doesn't decide whether the provider earned the reward. The source-chain evidence is proven through Attestcoin, and Creditcoin's contract deterministically enforces the SLA.”

End.

---

# 25. Demo Anti-Patterns

Do NOT spend 60 seconds explaining:

- project setup
- React
- wallet connection
- testnet faucets
- file structure
- CSS
- generic blockchain background

Do NOT say:

> “Attestcoin acts as an oracle.”

Prefer:

> “Attestcoin lets the Creditcoin-side application verify source-chain facts and use those proofs to enforce cross-chain business logic.”

Do NOT call the worker a trusted oracle.

Call it:

> “a transaction/proof orchestration worker.”

---

# 26. Smart Contract Acceptance Tests

The minimum serious test suite should prove:

### Device

```text
registerDevice(valid) = pass
registerDevice(duplicate) = revert
```

### Emitter

```text
registered emitter = accepted
unknown emitter = revert
```

### Source transaction

```text
successful tx = accepted
reverted tx = rejected
```

### Device binding

```text
expected device = accepted
wrong device = rejected
```

### Ordering

```text
1 -> 2 -> 3 = accepted
1 -> 3 = rejected
3 -> 2 = rejected
```

### Replay

```text
same source tx twice = rejected
```

### Threshold

```text
9800 >= 9800 = pass
9799 >= 9800 = fail
```

### Completion

```text
9 / 10 = cannot settle
10 / 10 = can settle
```

### Batch verification

```text
valid batch = accepted
malformed batch = rejected
```

---

# 27. Threat Model

Document these explicitly.

## Threat: fake event emitter

Attacker deploys a malicious contract that emits the expected event.

Mitigation:

```text
registered source emitter
```

## Threat: replay

Attacker resubmits an old valid event.

Mitigation:

```text
consumed transaction tracking
```

## Threat: wrong device

Attacker proves another device's history.

Mitigation:

```text
deviceId binding
```

## Threat: order manipulation

Attacker sends later checkpoint first.

Mitigation:

```text
lastVerifiedWindow
```

## Threat: insufficient performance

Attacker submits a low-quality service record.

Mitigation:

```text
uptimeBps threshold
```

## Threat: incomplete history

Attacker submits only favorable windows.

Mitigation:

```text
requiredWindows == verifiedWindows
```

## Threat: frontend manipulation

Attacker changes the UI.

Mitigation:

> Settlement is determined on-chain.

---

# 28. Important Product Honesty

AttestOps does NOT prove that a physical machine is intrinsically truthful.

It proves that:

1. the source-chain transaction existed
2. it was successful/valid under the proof model
3. the event came from the recognized source contract
4. the recorded service data is the data being evaluated

The underlying measurement system still determines what was written to the source chain.

Do not claim:

> “Attestcoin proves the real-world sensor is honest.”

Claim:

> “Attestcoin removes the need for Creditcoin to trust a centralized intermediary when importing the recorded cross-chain service evidence.”

This distinction increases technical credibility.

---

# 29. Free/No-Paid-Infrastructure Rule

Everything must work with:

- Creditcoin testnet
- Sepolia or the currently supported public source testnet
- free RPC/testnet access
- official proof-builder infrastructure as available to developers
- local Node/Foundry environment

Do not depend on:

- paid Alchemy/Infura tiers
- AWS
- paid databases
- paid monitoring
- production secret keys
- paid AI APIs
- proprietary enterprise APIs

The project should still be demoable from one laptop.

---

# 30. Failure Handling

The worker must distinguish:

```text
WAITING_FOR_ATTESTATION
PROOF_BUILDING
PROOF_READY
PROOF_FAILED
VERIFICATION_FAILED
SETTLEMENT_REJECTED
SETTLED
```

Do not collapse all errors into:

```text
Something went wrong.
```

Useful logs are part of the judge-facing technical proof.

---

# 31. What “Done” Means

The project is done when a fresh evaluator can see:

```text
Source chain
   |
   | service events
   v
10+ source transactions
   |
   | batch proof
   v
Attestcoin
   |
   | verifyBatch
   v
Creditcoin
   |
   | deterministic SLA rules
   v
settlement
```

and then intentionally break one assumption and observe that settlement fails.

That is the minimum bar.

---

# 32. Competitive Positioning Statement

Use this internally:

> **We are not building another application that merely verifies a cross-chain transaction. We are building a deterministic cross-chain settlement machine where a multi-event service history is cryptographically proven before economic consequences are allowed.**

This should guide every engineering decision.

---

# 33. What Could Still Make This Lose

Be realistic.

## 1. Another project may have deeper protocol work

Public competitors already demonstrate serious Attestcoin usage.

A technically stronger cryptography/protocol submission can beat this.

Counter:

- make the product exceptionally clear
- show adversarial behavior
- document the threat model
- prove real testnet behavior

## 2. DePIN may look simulated

The MVP will likely use simulated service records.

Counter:

- be explicit about this
- focus the innovation on trustless cross-chain settlement of the service evidence
- make the protocol abstraction useful for future real sensor/device integrations

## 3. The proof path could be flaky

Current testnet/proof infrastructure can introduce timing and integration risk.

Counter:

- build proof flow early
- keep a known-good set of transaction hashes
- cache no protocol truth, but preserve a reproducible demo fixture
- write a fallback demo script using already-attested transactions

## 4. Scope creep

The biggest solo-builder risk.

Counter:

> two contracts, one worker, one screen, one story.

## 5. Poor presentation

A technically good project can lose if judges cannot understand the result quickly.

Counter:

- 20-second problem statement
- 60-second Attestcoin moment
- 20-second attack
- 20-second conclusion

---

# 34. Winning Heuristic

When deciding whether to add a feature, ask:

### Does it make the Attestcoin contribution clearer?

If no:

> Do not build it.

### Does it reduce demo risk?

If no:

> Probably do not build it.

### Does it make the deterministic cross-chain settlement more compelling?

If no:

> Cut it.

This keeps the project strategically focused.

---

# 35. Suggested Project Names

Primary:

## AttestOps

Alternatives:

- SLAProof
- ProofSLA
- InfraAttest
- ProofOps
- AttestGrid
- VerifiOps
- CrossSLA

Preferred:

> **AttestOps**

Reason: short, memorable, operations-oriented, and does not over-commit the product to one physical hardware category.

---

# 36. Suggested 256-Character Description

Draft:

> AttestOps makes cross-chain infrastructure SLAs enforceable. Operators lock collateral on Creditcoin, while service checkpoints live on another chain. Attestcoin batch-proves the history, and deterministic contracts release or slash rewards.

Before final submission, count characters and trim to the exact DoraHacks field limit if needed.

---

# 37. Suggested README Opening

```md
# AttestOps

### Trustless cross-chain SLA settlement for infrastructure

AttestOps lets infrastructure operators earn rewards only after their
cross-chain service history is cryptographically proven.

Service records are emitted on a source chain. Attestcoin generates and
verifies a batch proof of those transactions. Creditcoin then evaluates a
deterministic SLA state machine and releases, withholds, or slashes the
operator's settlement.

The Attestcoin Protocol is not an optional integration here — it is the
trust boundary between service evidence and economic settlement.
```

---

# 38. Technical References

## Official Attestcoin documentation

https://docs.attestcoin.org/

Pay particular attention to:

- Attestcoin Protocol architecture
- chains and environments
- SDK
- DApp builder infrastructure
- readability subsystems
- guided tutorials

## Official examples

https://github.com/gluwa/attestcoin-protocol-examples

## Public proof SDK example

https://github.com/gluwa/cc-next-query-builder

Relevant current examples include:

- end-to-end single-proof verification
- batch-proof generation
- batch-proof verification

## Competition

https://buidl.creditcoin.org/

## Competitive public projects found during research

- https://github.com/OoJae/crosscredit
- https://github.com/Qidianyan/attestdesk
- https://github.com/anhquan075/verisettle
- https://github.com/thesithunyein/spark
- https://github.com/edycutjong/index41

---

# 39. Final Engineering Directive to the Coding Assistant

You are assisting a solo hackathon builder.

Optimize for:

```text
RELIABILITY > FEATURE COUNT
CLARITY > COMPLEXITY
PROTOCOL DEPTH > MARKETING
DEMO PROOF > DASHBOARD POLISH
DETERMINISTIC LOGIC > OFF-CHAIN TRUST
```

Do not invent Attestcoin SDK APIs.

Before using an SDK function:

1. confirm it exists in the current official/current public repository or docs
2. use the exact signature
3. keep the integration isolated behind a small adapter where practical

Do not invent a protocol behavior because it would be convenient.

If current docs differ from this brief, the current official docs win.

Do not silently change the core product from DePIN/SLA settlement into lending, AI, or generic bridging.

Build the smallest complete version first.

---

# 40. Build Order Summary

```text
1. Source ServiceRegistry
2. Creditcoin SLASettlement
3. Unit tests
4. Single Attestcoin proof
5. Batch Attestcoin proof
6. Proof -> settlement integration
7. Worker
8. Adversarial tests
9. Minimal frontend
10. Testnet deployment
11. Demo
12. Documentation
13. Submission hardening
```

The project should feel like:

> **a small protocol with a real economic consequence**

not:

> **a large hackathon website with blockchain attached.**
