// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IBlockProver
/// @notice The subset of the Creditcoin Block Prover precompile that AttestOps uses:
///         batch verification of Attestcoin transaction proofs.
/// @dev Types mirror the official @gluwa/usc-sdk `block_prover.json` ABI exactly
///      (do not change these — the function selector must stay
///      verify(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))).
interface IBlockProver {
    struct MerkleProofEntry {
        bytes32 hash;
        bool isLeft;
    }

    struct MerkleProof {
        bytes32 root;
        MerkleProofEntry[] siblings;
    }

    struct ContinuityProof {
        bytes32 lowerEndpointDigest;
        bytes32[] roots;
    }

    function verify(
        uint64 chainKey,
        uint64[] memory heights,
        bytes[] memory encodedTransactions,
        MerkleProof[] memory merkleProofs,
        ContinuityProof memory sharedContinuityProof
    ) external view returns (bool);
}

/// @title SLASettlement
/// @notice Creditcoin contract enforcing cross-chain SLA settlement.
/// @dev Day 7: facts are no longer caller-supplied. `submitProvenBatch` first verifies
///      the Attestcoin batch proof against the Block Prover precompile, then decodes the
///      ServiceWindowClosed events out of the proven transactions, then runs the
///      deterministic SLA checks. The old trusted-facts entry point is gone.
contract SLASettlement {
    // ---- Addresses / constants ----

    /// @dev Creditcoin Block Prover precompile (official address, see @gluwa/usc-sdk).
    address public constant BLOCK_PROVER_PRECOMPILE = address(0x0000000000000000000000000000000000000FD2);

    /// @dev topic0 of ServiceRegistry.ServiceWindowClosed(bytes32,uint256,uint256,uint256).
    bytes32 internal constant SWC_TOPIC = keccak256("ServiceWindowClosed(bytes32,uint256,uint256,uint256)");

    // ---- Structs ----

    struct SLA {
        bytes32 deviceId;
        address operator;
        address sourceEmitter; // the ONE trusted source contract for this SLA
        uint256 requiredWindows;
        uint256 minimumUptimeBps;
        uint256 reward;
        uint256 collateral;
        uint256 verifiedWindows; // windows submitted so far
        uint256 passedWindows; // of those, how many met the threshold
        uint256 lastVerifiedWindow;
        bool settled;
    }

    /// @dev A single proven source-chain service checkpoint, decoded from the proven
    ///      transactions AFTER the Attestcoin batch proof verifies (Day 7).
    struct ServiceFact {
        bytes32 sourceTxHash; // keccak256(txBytes) — replay protection key
        bytes32 deviceId; // must equal SLA.deviceId
        address emitter; // must equal SLA.sourceEmitter
        uint256 windowId; // must be strictly sequential
        uint256 uptimeBps; // must be >= minimumUptimeBps to pass
    }

    /// @dev A receipt log, matching the V1 abiEncode schema `tuple(address,bytes32[],bytes)[]`.
    struct Log {
        address emitter;
        bytes32[] topics;
        bytes data;
    }

    enum Outcome {
        None,
        Full,
        Partial
    }

    // ---- State ----

    address public owner;

    // The ONE source chain this contract accepts proofs for (e.g. 1 = Sepolia).
    uint64 public sourceChainKey;

    // Only these source contracts may feed evidence into SLAs.
    mapping(address => bool) public registeredEmitters;

    // SLA storage keyed by slaId.
    mapping(bytes32 => SLA) public slas;

    // Settlement outcome per SLA (set by settle()).
    mapping(bytes32 => Outcome) public outcomes;

    // Replay guard: proven tx id -> consumed.
    mapping(bytes32 => bool) public consumedSourceTx;

    // ---- Events ----

    event SourceEmitterRegistered(address indexed emitter, address registeredBy);

    event SLACreated(
        bytes32 indexed slaId,
        address indexed operator,
        bytes32 deviceId,
        address sourceEmitter,
        uint256 requiredWindows,
        uint256 minimumUptimeBps,
        uint256 reward,
        uint256 collateral
    );

    event WindowVerified(bytes32 indexed slaId, uint256 windowId, uint256 uptimeBps, bool passed);

    event Settled(bytes32 indexed slaId, Outcome outcome);

    event Slashed(bytes32 indexed slaId, address seizedBy);

    // ---- Errors ----

    error OnlyOwner(address caller);
    error EmitterNotRegistered(address emitter);
    error SlaAlreadyExists(bytes32 slaId);
    error SlaNotFound(bytes32 slaId);
    error ZeroCollateral();
    error WrongFunding(uint256 sent, uint256 expected);
    error RequiredWindowsZero();
    error UptimeOutOfRange(uint256 uptimeBps);
    error EmptyBatch();
    error SlaAlreadySettled(bytes32 slaId);
    error SlaAlreadyComplete(bytes32 slaId);
    error WrongEmitter(bytes32 slaId, address emitter);
    error WrongDevice(bytes32 slaId, bytes32 deviceId);
    error OutOfOrder(bytes32 slaId, uint256 windowId, uint256 expected);
    error ReplayDetected(bytes32 slaId, bytes32 sourceTxHash);
    error IncompleteHistory(bytes32 slaId, uint256 verified, uint256 required);
    error WrongChainKey(uint64 chainKey);
    error LengthMismatch();
    error ProofVerificationFailed();
    error TxReverted();
    error NoServiceWindowClosed();
    error MultipleServiceWindows();
    error MalformedTxBytes();

    // ---- Modifiers ----

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        _;
    }

    // ---- Constructor ----

    constructor(uint64 _sourceChainKey) {
        owner = msg.sender;
        sourceChainKey = _sourceChainKey;
    }

    // ---- Emitter registry ----

    /// @dev The deployer (owner) whitelists the source-chain contract whose
    ///      `ServiceWindowClosed` events are accepted as evidence.
    function registerSourceEmitter(address emitter) external onlyOwner {
        registeredEmitters[emitter] = true;
        emit SourceEmitterRegistered(emitter, msg.sender);
    }

    // ---- SLA lifecycle ----

    /// @dev Operator escrows collateral + reward. The source emitter must be registered.
    ///      msg.value must exactly equal collateral + reward so the contract can
    ///      always honour the payout.
    function createSLA(
        bytes32 slaId,
        bytes32 deviceId,
        address sourceEmitter,
        uint256 requiredWindows,
        uint256 minimumUptimeBps,
        uint256 collateral,
        uint256 reward
    ) external payable returns (bytes32) {
        if (!registeredEmitters[sourceEmitter]) revert EmitterNotRegistered(sourceEmitter);
        if (slas[slaId].operator != address(0)) revert SlaAlreadyExists(slaId);
        if (collateral == 0) revert ZeroCollateral();
        if (msg.value != collateral + reward) revert WrongFunding(msg.value, collateral + reward);
        if (requiredWindows == 0) revert RequiredWindowsZero();
        if (minimumUptimeBps > 10_000) revert UptimeOutOfRange(minimumUptimeBps);

        slas[slaId] = SLA({
            deviceId: deviceId,
            operator: msg.sender,
            sourceEmitter: sourceEmitter,
            requiredWindows: requiredWindows,
            minimumUptimeBps: minimumUptimeBps,
            reward: reward,
            collateral: collateral,
            verifiedWindows: 0,
            passedWindows: 0,
            lastVerifiedWindow: 0,
            settled: false
        });

        emit SLACreated(
            slaId,
            msg.sender,
            deviceId,
            sourceEmitter,
            requiredWindows,
            minimumUptimeBps,
            reward,
            collateral
        );

        return slaId;
    }

    // ---- Proof-backed submission ----
    //
    // Day 7: the FIRST thing this function does is verify the Attestcoin batch proof
    // (verifyBatch on the Block Prover precompile) so that the facts we decode are
    // genuinely proven source-chain transactions. The deterministic checks below then
    // run on the decoded facts.

    /// @dev Submits an Attestcoin batch proof for this SLA. The contract verifies the
    ///      proof itself, decodes one ServiceWindowClosed event per proven transaction,
    ///      then applies the deterministic SLA checks. If the proof does not verify,
    ///      the whole submission is rejected and no state advances.
    function submitProvenBatch(
        bytes32 slaId,
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata txBytes,
        IBlockProver.MerkleProof[] calldata merkleProofs,
        IBlockProver.ContinuityProof calldata sharedContinuityProof
    ) external {
        SLA storage sla = slas[slaId];
        if (sla.operator == address(0)) revert SlaNotFound(slaId);
        if (sla.settled) revert SlaAlreadySettled(slaId);
        if (sla.verifiedWindows >= sla.requiredWindows) revert SlaAlreadyComplete(slaId);
        if (txBytes.length == 0) revert EmptyBatch();

        _verifyBatchProof(chainKey, heights, txBytes, merkleProofs, sharedContinuityProof);

        ServiceFact[] memory facts = new ServiceFact[](txBytes.length);
        for (uint256 i = 0; i < txBytes.length; ++i) {
            facts[i] = _decodeFact(txBytes[i]);
        }

        _applyFacts(slaId, facts);
    }

    /// @dev Gates submission on a verified Attestcoin batch proof. This is the trust
    ///      boundary: facts only enter the contract from transactions the precompile
    ///      cryptographically proves were included on the source chain.
    function _verifyBatchProof(
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata txBytes,
        IBlockProver.MerkleProof[] calldata merkleProofs,
        IBlockProver.ContinuityProof calldata sharedContinuityProof
    ) internal view {
        if (chainKey != sourceChainKey) revert WrongChainKey(chainKey);
        if (heights.length != txBytes.length || txBytes.length != merkleProofs.length) {
            revert LengthMismatch();
        }

        (bool ok, bytes memory ret) = BLOCK_PROVER_PRECOMPILE.staticcall(
            abi.encodeCall(
                IBlockProver.verify,
                (chainKey, heights, txBytes, merkleProofs, sharedContinuityProof)
            )
        );
        if (!ok) revert ProofVerificationFailed();

        bool verified = abi.decode(ret, (bool));
        if (!verified) revert ProofVerificationFailed();
    }

    /// @dev Decodes a ServiceFact from a proven transaction. `txBytes` follows the V1
    ///      abiEncode schema: `(uint8 txType, bytes[] chunks)` where the LAST chunk is
    ///      the receipt `(uint8 status, uint64 gasUsed, Log[] logs, bytes bloom)`.
    ///      The receipt rides inside the proven bytes, so `status == 1` (the tx
    ///      succeeded) is genuine — it cannot be forged.
    function _decodeFact(bytes calldata txBytes) internal pure returns (ServiceFact memory fact) {
        (, bytes[] memory chunks) = abi.decode(txBytes, (uint8, bytes[]));
        if (chunks.length == 0) revert MalformedTxBytes();

        (uint8 status, , Log[] memory logs, ) = abi.decode(
            chunks[chunks.length - 1],
            (uint8, uint64, Log[], bytes)
        );
        if (status != 1) revert TxReverted();

        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            // ServiceWindowClosed has exactly 3 topics: topic0 + indexed deviceId + indexed windowId.
            if (logs[i].topics.length != 3 || logs[i].topics[0] != SWC_TOPIC) continue;
            if (found) revert MultipleServiceWindows();

            found = true;
            fact.emitter = logs[i].emitter;
            fact.deviceId = logs[i].topics[1];
            fact.windowId = uint256(logs[i].topics[2]);
            (fact.uptimeBps, ) = abi.decode(logs[i].data, (uint256, uint256)); // (uptimeBps, rewardAmount)
            fact.sourceTxHash = keccak256(txBytes);
        }
        if (!found) revert NoServiceWindowClosed();
    }

    /// @dev Applies the deterministic SLA checks to a batch of decoded facts.
    ///      Every fact must pass: emitter match, device match, strict window ordering,
    ///      and no replay. Uptime below threshold is recorded as a FAILED window (it
    ///      still advances the sequence and affects the partial-settlement reward).
    function _applyFacts(bytes32 slaId, ServiceFact[] memory facts) internal {
        SLA storage sla = slas[slaId];

        for (uint256 i = 0; i < facts.length; ++i) {
            ServiceFact memory f = facts[i];

            // 1. Source identity — only the registered emitter is trusted.
            if (f.emitter != sla.sourceEmitter) revert WrongEmitter(slaId, f.emitter);

            // 2. Device binding — proven event must belong to this SLA's device.
            if (f.deviceId != sla.deviceId) revert WrongDevice(slaId, f.deviceId);

            // 3. Strict sequential ordering.
            uint256 expected = sla.verifiedWindows == 0 ? 0 : sla.lastVerifiedWindow + 1;
            if (f.windowId != expected) revert OutOfOrder(slaId, f.windowId, expected);

            // 4. No replay.
            if (consumedSourceTx[f.sourceTxHash]) revert ReplayDetected(slaId, f.sourceTxHash);
            consumedSourceTx[f.sourceTxHash] = true;

            // 5. Threshold — below-threshold windows count but do not pass.
            bool passed = f.uptimeBps >= sla.minimumUptimeBps;
            if (passed) sla.passedWindows++;

            sla.verifiedWindows++;
            sla.lastVerifiedWindow = f.windowId;

            emit WindowVerified(slaId, f.windowId, f.uptimeBps, passed);
        }
    }

    // ---- Settlement ----

    /// @dev Completes settlement once ALL required windows are verified.
    ///      Full pass -> full reward + full collateral returned.
    ///      Partial  -> reward and collateral scaled by passing windows.
    function settle(bytes32 slaId) external {
        SLA storage sla = slas[slaId];
        if (sla.operator == address(0)) revert SlaNotFound(slaId);
        if (sla.settled) revert SlaAlreadySettled(slaId);
        if (sla.verifiedWindows < sla.requiredWindows) {
            revert IncompleteHistory(slaId, sla.verifiedWindows, sla.requiredWindows);
        }

        sla.settled = true;

        uint256 payout;
        Outcome outcome;
        if (sla.passedWindows == sla.requiredWindows) {
            // FULL PASS
            payout = sla.reward + sla.collateral;
            outcome = Outcome.Full;
        } else {
            // PARTIAL FAILURE — reward and collateral proportional to passing windows.
            payout =
                (sla.reward * sla.passedWindows) / sla.requiredWindows
                + (sla.collateral * sla.passedWindows) / sla.requiredWindows;
            outcome = Outcome.Partial;
        }

        outcomes[slaId] = outcome;

        if (payout > 0) {
            (bool ok, ) = payable(sla.operator).call{value: payout}("");
            require(ok, "payout failed");
        }

        emit Settled(slaId, outcome);
    }

    /// @dev Owner-only: seize the escrowed funds of an SLA that was never
    ///      completed (abandoned by the operator). MVP governance tool.
    function slash(bytes32 slaId) external onlyOwner {
        SLA storage sla = slas[slaId];
        if (sla.operator == address(0)) revert SlaNotFound(slaId);
        if (sla.settled) revert SlaAlreadySettled(slaId);

        sla.settled = true;

        uint256 seized = sla.reward + sla.collateral;
        if (seized > 0) {
            (bool ok, ) = payable(owner).call{value: seized}("");
            require(ok, "slash transfer failed");
        }

        emit Slashed(slaId, owner);
    }

    // ---- Getters ----

    function getSLA(bytes32 slaId) external view returns (SLA memory) {
        return slas[slaId];
    }
}
