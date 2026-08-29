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

> **Track:** DePIN · **BUIDL CTC 2026 Fall / Creditcoin + Attestcoin Protocol**

---

## Status

Early scaffold. Full build plan in `AttestOps_Build_Brief.md` (read first).

## Repo layout

```
contracts/
  source/        ServiceRegistry.sol (source-chain service records)
  creditcoin/    SLASettlement.sol (deterministic settlement)
script/          Foundry deploy/demo scripts
worker/          Thin TS orchestration worker (@gluwa/usc-sdk)
web/             Minimal frontend (SLA card + proof status + attack toggles)
test/            Foundry tests (ordering, replay, emitter, thresholds)
docs/            architecture, threat model, demo
```

## Reproduction (to be filled in)

1. install dependencies
2. configure RPC/testnet variables (see `.env.example`)
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
