// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SLASettlement
/// @notice Creditcoin contract enforcing cross-chain SLA settlement.
/// @dev Day 4: deterministic validation (emitter, device, order, replay,
///      threshold, completion) + settle()/slash(). Proof verification is
///      wired in on Day 7 as a gate BEFORE the deterministic logic.
contract SLASettlement {
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

    /// @dev A single proven source-chain service checkpoint.
    ///      In the real flow (Day 7) these facts are decoded from the proven
    ///      transactions AFTER the Attestcoin batch proof verifies.
    struct ServiceFact {
        bytes32 sourceTxHash; // replay protection key
        bytes32 deviceId; // must equal SLA.deviceId
        address emitter; // must equal SLA.sourceEmitter
        uint256 windowId; // must be strictly sequential
        uint256 uptimeBps; // must be >= minimumUptimeBps to pass
    }

    enum Outcome {
        None,
        Full,
        Partial
    }

    // ---- State ----

    address public owner;

    // Only these source contracts may feed evidence into SLAs.
    mapping(address => bool) public registeredEmitters;

    // SLA storage keyed by slaId.
    mapping(bytes32 => SLA) public slas;

    // Settlement outcome per SLA (set by settle()).
    mapping(bytes32 => Outcome) public outcomes;

    // Replay guard: source tx hash -> consumed.
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

    // ---- Modifiers ----

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        _;
    }

    // ---- Constructor ----

    constructor() {
        owner = msg.sender;
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
    // NOTE (Day 7): the FIRST thing this function does in production is verify
    // the Attestcoin batch proof (verifyBatch) so that `facts` are genuinely
    // proven source-chain transactions. The deterministic checks below run on
    // the decoded facts either way — that is exactly why we build them now and
    // can unit-test them without proof plumbing.

    /// @dev Applies a batch of proven service facts to the SLA.
    ///      Every fact must pass: emitter match, device match, strict window
    ///      ordering, and no replay. Uptime below threshold is recorded as a
    ///      FAILED window (it still advances the sequence and affects the
    ///      partial-settlement reward).
    function submitVerifiedBatch(bytes32 slaId, ServiceFact[] calldata facts) external {
        SLA storage sla = slas[slaId];
        if (sla.operator == address(0)) revert SlaNotFound(slaId);
        if (sla.settled) revert SlaAlreadySettled(slaId);
        if (sla.verifiedWindows >= sla.requiredWindows) revert SlaAlreadyComplete(slaId);
        if (facts.length == 0) revert EmptyBatch();

        for (uint256 i = 0; i < facts.length; ++i) {
            ServiceFact calldata f = facts[i];

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
