// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ServiceRegistry
/// @notice Source-chain contract that records DePIN service history.
/// @dev Deterministic test environment representing infrastructure service records.
///      This contract's `ServiceWindowClosed` events are the facts Attestcoin proves.
contract ServiceRegistry {
    // ---- Structs ----

    struct Device {
        address operator;
        bool exists;
    }

    struct ServiceWindow {
        uint256 uptimeBps; // uptime in basis points (10000 = 100.00%)
        uint256 rewardAmount;
        bool closed;
    }

    // ---- State ----

    mapping(bytes32 => Device) public devices;
    mapping(bytes32 => mapping(uint256 => ServiceWindow)) public serviceWindows;

    // Next window id per device (strictly increasing, no gaps)
    mapping(bytes32 => uint256) internal _nextWindowId;

    // ---- Events ----

    event DeviceRegistered(bytes32 indexed deviceId, address indexed operator);

    /// @notice Emitted when a service window closes. This is the event Attestcoin proofs target.
    event ServiceWindowClosed(
        bytes32 indexed deviceId,
        uint256 indexed windowId,
        uint256 uptimeBps,
        uint256 rewardAmount
    );

    // ---- Errors ----

    error DeviceAlreadyRegistered(bytes32 deviceId);
    error DeviceNotRegistered(bytes32 deviceId);
    error NotOperator(bytes32 deviceId, address caller);
    error UptimeOutOfRange(uint256 uptimeBps);

    // ---- Device registration ----

    /// @dev Only the first caller owns a deviceId.
    function registerDevice(bytes32 deviceId) external {
        if (devices[deviceId].exists) revert DeviceAlreadyRegistered(deviceId);
        devices[deviceId] = Device({operator: msg.sender, exists: true});
        emit DeviceRegistered(deviceId, msg.sender);
    }

    // ---- Service windows ----

    /// @dev Only the device operator may create a window. Window ids auto-increment from 0.
    function createServiceWindow(
        bytes32 deviceId,
        uint256 uptimeBps,
        uint256 rewardAmount
    ) external returns (uint256 windowId) {
        _onlyOperator(deviceId);
        if (uptimeBps > 10_000) revert UptimeOutOfRange(uptimeBps);

        windowId = _nextWindowId[deviceId];
        serviceWindows[deviceId][windowId] = ServiceWindow({
            uptimeBps: uptimeBps,
            rewardAmount: rewardAmount,
            closed: false
        });
        _nextWindowId[deviceId] = windowId + 1;
    }

    /// @dev Only the device operator may close a window. Closing emits the provable event.
    function closeServiceWindow(bytes32 deviceId, uint256 windowId) external {
        _onlyOperator(deviceId);
        ServiceWindow storage w = serviceWindows[deviceId][windowId];
        w.closed = true;

        emit ServiceWindowClosed(deviceId, windowId, w.uptimeBps, w.rewardAmount);
    }

    // ---- Helpers ----

    function _onlyOperator(bytes32 deviceId) internal view {
        Device storage d = devices[deviceId];
        if (!d.exists) revert DeviceNotRegistered(deviceId);
        if (d.operator != msg.sender) revert NotOperator(deviceId, msg.sender);
    }
}
