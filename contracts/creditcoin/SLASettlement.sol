// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SLASettlement
/// @notice Creditcoin contract enforcing cross-chain SLA settlement.
/// @dev Day 3 skeleton: SLA creation, collateral accounting, reward params,
///      source-emitter registration, state tracking. Proof verification and
///      deterministic validation are wired in on later days.
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
        uint256 verifiedWindows;
        uint256 lastVerifiedWindow;
        bool settled;
    }

    // ---- State ----

    address public owner;

    // Only these source contracts may feed evidence into SLAs.
    mapping(address => bool) public registeredEmitters;

    // SLA storage keyed by slaId.
    mapping(bytes32 => SLA) public slas;

    // Replay guard: source tx hash -> consumed (populated once verification lands).
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

    // ---- Errors ----

    error OnlyOwner(address caller);
    error EmitterNotRegistered(address emitter);
    error SlaAlreadyExists(bytes32 slaId);
    error ZeroCollateral();
    error RequiredWindowsZero();
    error UptimeOutOfRange(uint256 uptimeBps);

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

    /// @dev Operator locks collateral (msg.value), sets SLA parameters.
    ///      The source emitter must already be registered.
    function createSLA(
        bytes32 slaId,
        bytes32 deviceId,
        address sourceEmitter,
        uint256 requiredWindows,
        uint256 minimumUptimeBps,
        uint256 reward
    ) external payable returns (bytes32) {
        if (!registeredEmitters[sourceEmitter]) revert EmitterNotRegistered(sourceEmitter);
        if (slas[slaId].operator != address(0)) revert SlaAlreadyExists(slaId);
        if (msg.value == 0) revert ZeroCollateral();
        if (requiredWindows == 0) revert RequiredWindowsZero();
        if (minimumUptimeBps > 10_000) revert UptimeOutOfRange(minimumUptimeBps);

        slas[slaId] = SLA({
            deviceId: deviceId,
            operator: msg.sender,
            sourceEmitter: sourceEmitter,
            requiredWindows: requiredWindows,
            minimumUptimeBps: minimumUptimeBps,
            reward: reward,
            collateral: msg.value,
            verifiedWindows: 0,
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
            msg.value
        );

        return slaId;
    }

    // ---- Getters ----

    function getSLA(bytes32 slaId) external view returns (SLA memory) {
        return slas[slaId];
    }

    // NOTE (Day 4+): submitVerifiedBatch(...), settle(...), slash(...) and the
    // deterministic validation checks (emitter match, device match, sequential
    // windows, replay, threshold, completion) are added next.
}
