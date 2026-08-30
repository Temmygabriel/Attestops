// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SLASettlement} from "../contracts/creditcoin/SLASettlement.sol";
import {SettlementTestBase} from "./SettlementTestBase.sol";

/// @dev SLA lifecycle tests (emitter registry + createSLA). Proof-path validation lives
///      in SettlementValidation.t.sol.
contract SLASettlementTest is SettlementTestBase {
    // ---- registerSourceEmitter ----

    function test_registerEmitter_byOwner() public {
        address newEmitter = address(0xCAFE);
        vm.expectEmit(true, true, false, true);
        emit SLASettlement.SourceEmitterRegistered(newEmitter, owner);
        settle.registerSourceEmitter(newEmitter);
        assertTrue(settle.registeredEmitters(newEmitter));
    }

    function test_registerEmitter_nonOwner_reverts() public {
        vm.prank(impostor);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.OnlyOwner.selector, impostor));
        settle.registerSourceEmitter(address(0xCAFE));
    }

    // ---- createSLA ----

    function test_createSLA_valid() public {
        _createSLA();

        SLASettlement.SLA memory sla = settle.getSLA(slaId);
        assertEq(sla.operator, operator);
        assertEq(sla.deviceId, deviceId);
        assertEq(sla.sourceEmitter, emitter);
        assertEq(sla.requiredWindows, 10);
        assertEq(sla.minimumUptimeBps, 9800);
        assertEq(sla.reward, reward);
        assertEq(sla.collateral, collateral);
        assertEq(sla.verifiedWindows, 0);
        assertEq(sla.lastVerifiedWindow, 0);
        assertFalse(sla.settled);
    }

    function test_createSLA_emitsEvent() public {
        vm.deal(operator, collateral + reward);
        vm.expectEmit(true, true, true, true);
        emit SLASettlement.SLACreated(
            slaId, operator, deviceId, emitter, 10, 9800, reward, collateral
        );
        vm.prank(operator);
        settle.createSLA{value: collateral + reward}(
            slaId, deviceId, emitter, 10, 9800, collateral, reward
        );
    }

    function test_createSLA_unregisteredEmitter_reverts() public {
        address badEmitter = address(0xBAD);
        vm.deal(operator, collateral + reward);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.EmitterNotRegistered.selector, badEmitter));
        vm.prank(operator);
        settle.createSLA{value: collateral + reward}(
            slaId, deviceId, badEmitter, 10, 9800, collateral, reward
        );
    }

    function test_createSLA_duplicate_reverts() public {
        _createSLA();
        vm.deal(operator, collateral + reward);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.SlaAlreadyExists.selector, slaId));
        vm.prank(operator);
        settle.createSLA{value: collateral + reward}(
            slaId, deviceId, emitter, 10, 9800, collateral, reward
        );
    }

    function test_createSLA_zeroCollateral_reverts() public {
        vm.deal(operator, reward);
        vm.expectRevert(SLASettlement.ZeroCollateral.selector);
        vm.prank(operator);
        settle.createSLA{value: reward}(slaId, deviceId, emitter, 10, 9800, 0, reward);
    }

    function test_createSLA_wrongFunding_reverts() public {
        vm.deal(operator, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.WrongFunding.selector, 1 ether, collateral + reward));
        vm.prank(operator);
        settle.createSLA{value: 1 ether}(slaId, deviceId, emitter, 10, 9800, collateral, reward);
    }

    function test_createSLA_zeroRequiredWindows_reverts() public {
        vm.deal(operator, collateral + reward);
        vm.expectRevert(SLASettlement.RequiredWindowsZero.selector);
        vm.prank(operator);
        settle.createSLA{value: collateral + reward}(slaId, deviceId, emitter, 0, 9800, collateral, reward);
    }

    function test_createSLA_badUptime_reverts() public {
        vm.deal(operator, collateral + reward);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.UptimeOutOfRange.selector, 10_001));
        vm.prank(operator);
        settle.createSLA{value: collateral + reward}(slaId, deviceId, emitter, 10, 10_001, collateral, reward);
    }

    function test_createSLA_contractHoldsFunds() public {
        _createSLA();
        assertEq(address(settle).balance, collateral + reward);
    }

    // ---- Proof gate smoke ----

    function test_provenWindow_advancesSLA() public {
        _createSLA(3);
        _submitWindow(0, 9900);
        assertEq(settle.getSLA(slaId).verifiedWindows, 1);
    }

    function test_unprovenSubmission_reverts() public {
        _createSLA(3);
        _setProver(PROVER_FALSE);
        vm.expectRevert(SLASettlement.ProofVerificationFailed.selector);
        _submitWindow(0, 9900);
    }
}
