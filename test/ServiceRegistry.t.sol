// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ServiceRegistry} from "../contracts/source/ServiceRegistry.sol";

contract ServiceRegistryTest is Test {
    ServiceRegistry internal reg;
    address internal operator = address(0xA11CE);
    bytes32 internal deviceId = keccak256("NODE-014");

    function setUp() public {
        reg = new ServiceRegistry();
        vm.prank(operator);
        reg.registerDevice(deviceId);
    }

    // ---- registerDevice ----

    function test_registerDevice_valid() public {
        bytes32 newDevice = keccak256("NODE-099");
        vm.prank(operator);
        reg.registerDevice(newDevice);

        (address op, bool exists) = reg.devices(newDevice);
        assertTrue(exists);
        assertEq(op, operator);
    }

    function test_registerDevice_duplicate_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(ServiceRegistry.DeviceAlreadyRegistered.selector, deviceId)
        );
        vm.prank(operator);
        reg.registerDevice(deviceId);
    }

    function test_registerDevice_emitsEvent() public {
        bytes32 newDevice = keccak256("NODE-101");
        vm.expectEmit(true, true, false, true);
        emit ServiceRegistry.DeviceRegistered(newDevice, operator);
        vm.prank(operator);
        reg.registerDevice(newDevice);
    }

    // ---- createServiceWindow ----

    function test_createWindow_valid() public {
        vm.prank(operator);
        uint256 windowId = reg.createServiceWindow(deviceId, 9800, 4 ether);

        assertEq(windowId, 0);
        (uint256 uptimeBps, uint256 rewardAmount, bool closed) = reg.serviceWindows(deviceId, windowId);
        assertEq(uptimeBps, 9800);
        assertEq(rewardAmount, 4 ether);
        assertFalse(closed);
    }

    function test_createWindow_incrementsIds() public {
        vm.startPrank(operator);
        uint256 w0 = reg.createServiceWindow(deviceId, 9800, 1 ether);
        uint256 w1 = reg.createServiceWindow(deviceId, 9900, 1 ether);
        uint256 w2 = reg.createServiceWindow(deviceId, 9750, 1 ether);
        vm.stopPrank();

        assertEq(w0, 0);
        assertEq(w1, 1);
        assertEq(w2, 2);
    }

    function test_createWindow_wrongOperator_reverts() public {
        address impostor = address(0xBEEF);
        vm.expectRevert(
            abi.encodeWithSelector(ServiceRegistry.NotOperator.selector, deviceId, impostor)
        );
        vm.prank(impostor);
        reg.createServiceWindow(deviceId, 9800, 1 ether);
    }

    function test_createWindow_unregisteredDevice_reverts() public {
        bytes32 unknown = keccak256("NODE-UNKNOWN");
        vm.expectRevert(abi.encodeWithSelector(ServiceRegistry.DeviceNotRegistered.selector, unknown));
        vm.prank(operator);
        reg.createServiceWindow(unknown, 9800, 1 ether);
    }

    function test_createWindow_uptimeAbove10000_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(ServiceRegistry.UptimeOutOfRange.selector, 10_001));
        vm.prank(operator);
        reg.createServiceWindow(deviceId, 10_001, 1 ether);
    }

    // ---- closeServiceWindow ----

    function test_closeWindow_valid_emitsEvent() public {
        vm.prank(operator);
        uint256 windowId = reg.createServiceWindow(deviceId, 9800, 4 ether);

        vm.expectEmit(true, true, true, true);
        emit ServiceRegistry.ServiceWindowClosed(deviceId, windowId, 9800, 4 ether);

        vm.prank(operator);
        reg.closeServiceWindow(deviceId, windowId);

        (, , bool closed) = reg.serviceWindows(deviceId, windowId);
        assertTrue(closed);
    }

    function test_closeWindow_wrongOperator_reverts() public {
        vm.prank(operator);
        uint256 windowId = reg.createServiceWindow(deviceId, 9800, 4 ether);

        address impostor = address(0xBEEF);
        vm.expectRevert(
            abi.encodeWithSelector(ServiceRegistry.NotOperator.selector, deviceId, impostor)
        );
        vm.prank(impostor);
        reg.closeServiceWindow(deviceId, windowId);
    }

    function test_closeWindow_uncreatedWindow_isNoop() public {
        // Closing a never-created window succeeds but emits with zero uptime.
        // It is a no-op from the settlement perspective (uptime 0 < threshold).
        vm.prank(operator);
        reg.closeServiceWindow(deviceId, 999);
    }

    function test_closeWindow_twice_staysClosed() public {
        vm.prank(operator);
        uint256 windowId = reg.createServiceWindow(deviceId, 9800, 4 ether);

        vm.prank(operator);
        reg.closeServiceWindow(deviceId, windowId);
        vm.prank(operator);
        reg.closeServiceWindow(deviceId, windowId);

        (, , bool closed) = reg.serviceWindows(deviceId, windowId);
        assertTrue(closed);
    }
}
