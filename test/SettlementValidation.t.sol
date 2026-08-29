// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {SLASettlement} from "../contracts/creditcoin/SLASettlement.sol";

/// @dev Day 4: deterministic validation acceptance tests (brief §26).
contract SettlementValidationTest is Test {
    SLASettlement internal settle;
    address internal owner = address(this);
    address internal operator = address(0xA11CE);
    address internal emitter = address(0x5EED);
    address internal wrongEmitter = address(0xBEEF);

    bytes32 internal slaId = keccak256("SLA-014");
    bytes32 internal deviceId = keccak256("NODE-014");
    bytes32 internal otherDevice = keccak256("NODE-999");

    uint256 internal collateral = 100 ether;
    uint256 internal reward = 40 ether;
    uint256 internal minUptime = 9800; // 98.00%

    function setUp() public {
        settle = new SLASettlement();
        settle.registerSourceEmitter(emitter);
        vm.deal(operator, 10_000 ether);
    }

    // ---- helpers ----

    function _createSLA(uint256 requiredWindows) internal {
        vm.prank(operator);
        settle.createSLA{value: collateral + reward}(
            slaId, deviceId, emitter, requiredWindows, minUptime, collateral, reward
        );
    }

    function _fact(
        uint256 windowId,
        uint256 uptimeBps,
        bytes32 txHash,
        bytes32 _deviceId,
        address _emitter
    ) internal pure returns (SLASettlement.ServiceFact memory) {
        return SLASettlement.ServiceFact({
            sourceTxHash: txHash,
            deviceId: _deviceId,
            emitter: _emitter,
            windowId: windowId,
            uptimeBps: uptimeBps
        });
    }

    function _submitSingle(uint256 windowId, uint256 uptimeBps, uint256 txNonce) internal {
        SLASettlement.ServiceFact[] memory facts = new SLASettlement.ServiceFact[](1);
        facts[0] = _fact(
            windowId, uptimeBps, keccak256(abi.encodePacked("tx", txNonce)), deviceId, emitter
        );
        settle.submitVerifiedBatch(slaId, facts);
    }

    // ---- Emitter match (brief §26) ----

    function test_emitter_registered_accepted() public {
        _createSLA(3);
        _submitSingle(0, 9900, 1);
        assertEq(settle.getSLA(slaId).verifiedWindows, 1);
    }

    function test_emitter_unknown_reverts() public {
        _createSLA(3);
        SLASettlement.ServiceFact[] memory facts = new SLASettlement.ServiceFact[](1);
        facts[0] = _fact(0, 9900, keccak256("tx1"), deviceId, wrongEmitter);

        vm.expectRevert(abi.encodeWithSelector(SLASettlement.WrongEmitter.selector, slaId, wrongEmitter));
        settle.submitVerifiedBatch(slaId, facts);
    }

    // ---- Device binding (brief §26) ----

    function test_device_match_accepted() public {
        _createSLA(3);
        _submitSingle(0, 9900, 1);
        assertEq(settle.getSLA(slaId).verifiedWindows, 1);
    }

    function test_device_mismatch_reverts() public {
        _createSLA(3);
        SLASettlement.ServiceFact[] memory facts = new SLASettlement.ServiceFact[](1);
        facts[0] = _fact(0, 9900, keccak256("tx1"), otherDevice, emitter);

        vm.expectRevert(abi.encodeWithSelector(SLASettlement.WrongDevice.selector, slaId, otherDevice));
        settle.submitVerifiedBatch(slaId, facts);
    }

    // ---- Ordering (brief §26) ----

    function test_order_1_2_3_accepted() public {
        _createSLA(3);
        _submitSingle(0, 9900, 1);
        _submitSingle(1, 9900, 2);
        _submitSingle(2, 9900, 3);
        assertEq(settle.getSLA(slaId).verifiedWindows, 3);
    }

    function test_order_1_3_reverts() public {
        _createSLA(3);
        _submitSingle(0, 9900, 1);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.OutOfOrder.selector, slaId, 2, 1));
        _submitSingle(2, 9900, 2);
    }

    function test_order_3_2_reverts() public {
        _createSLA(3);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.OutOfOrder.selector, slaId, 2, 0));
        _submitSingle(2, 9900, 1); // first fact must be window 0
    }

    // ---- Replay (brief §26) ----

    function test_replay_sameTxTwice_reverts() public {
        _createSLA(3);
        SLASettlement.ServiceFact[] memory f1 = new SLASettlement.ServiceFact[](1);
        f1[0] = _fact(0, 9900, keccak256("txReplay"), deviceId, emitter);
        settle.submitVerifiedBatch(slaId, f1);

        // Same tx hash again -> replay.
        SLASettlement.ServiceFact[] memory f2 = new SLASettlement.ServiceFact[](1);
        f2[0] = _fact(1, 9900, keccak256("txReplay"), deviceId, emitter);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.ReplayDetected.selector, slaId, keccak256("txReplay")));
        settle.submitVerifiedBatch(slaId, f2);
    }

    // ---- Threshold (brief §26) ----

    function test_threshold_exact_pass() public {
        _createSLA(3);
        _submitSingle(0, 9800, 1); // 9800 >= 9800 -> pass
        assertEq(settle.getSLA(slaId).passedWindows, 1);
    }

    function test_threshold_below_failsButCounts() public {
        _createSLA(3);
        _submitSingle(0, 9799, 1); // 9799 < 9800 -> counts but fails
        assertEq(settle.getSLA(slaId).verifiedWindows, 1);
        assertEq(settle.getSLA(slaId).passedWindows, 0);
    }

    // ---- Completion (brief §26) ----

    function test_completion_9of10_cannotSettle() public {
        _createSLA(10);
        for (uint256 i = 0; i < 9; ++i) {
            _submitSingle(i, 9900, i + 1);
        }
        vm.expectRevert(
            abi.encodeWithSelector(SLASettlement.IncompleteHistory.selector, slaId, 9, 10)
        );
        settle.settle(slaId);
    }

    function test_completion_10of10_canSettle() public {
        _createSLA(10);
        for (uint256 i = 0; i < 10; ++i) {
            _submitSingle(i, 9900, i + 1);
        }
        settle.settle(slaId);
        assertEq(settle.getSLA(slaId).settled, true);
        assertEq(uint256(settle.outcomes(slaId)), uint256(SLASettlement.Outcome.Full));
    }

    // ---- Settle: full pass ----

    function test_settle_full_paysRewardPlusCollateral() public {
        _createSLA(10);
        for (uint256 i = 0; i < 10; ++i) {
            _submitSingle(i, 9900, i + 1);
        }

        uint256 operatorBefore = operator.balance;
        settle.settle(slaId);

        assertEq(operator.balance - operatorBefore, reward + collateral);
        assertEq(settle.getSLA(slaId).settled, true);
        assertEq(uint256(settle.outcomes(slaId)), uint256(SLASettlement.Outcome.Full));
    }

    // ---- Settle: partial ----

    function test_settle_partial_scalesPayout() public {
        _createSLA(10);
        // 8 pass, 2 fail (window 5 and 8 below threshold)
        for (uint256 i = 0; i < 10; ++i) {
            _submitSingle(i, i == 5 || i == 8 ? 5000 : 9900, i + 1);
        }

        uint256 operatorBefore = operator.balance;
        settle.settle(slaId);

        uint256 expectedPayout = (reward * 8) / 10 + (collateral * 8) / 10;
        assertEq(operator.balance - operatorBefore, expectedPayout);
        assertEq(uint256(settle.outcomes(slaId)), uint256(SLASettlement.Outcome.Partial));
    }

    // ---- Post-settlement ----

    function test_submitAfterSettle_reverts() public {
        _createSLA(3);
        for (uint256 i = 0; i < 3; ++i) {
            _submitSingle(i, 9900, i + 1);
        }
        settle.settle(slaId);

        vm.expectRevert(abi.encodeWithSelector(SLASettlement.SlaAlreadySettled.selector, slaId));
        _submitSingle(3, 9900, 99);
    }

    function test_settleTwice_reverts() public {
        _createSLA(3);
        for (uint256 i = 0; i < 3; ++i) {
            _submitSingle(i, 9900, i + 1);
        }
        settle.settle(slaId);

        vm.expectRevert(abi.encodeWithSelector(SLASettlement.SlaAlreadySettled.selector, slaId));
        settle.settle(slaId);
    }

    // ---- Empty batch ----

    function test_emptyBatch_reverts() public {
        _createSLA(3);
        SLASettlement.ServiceFact[] memory facts = new SLASettlement.ServiceFact[](0);
        vm.expectRevert(SLASettlement.EmptyBatch.selector);
        settle.submitVerifiedBatch(slaId, facts);
    }

    // ---- Batch submission ----

    function test_batch_multiFact_accepted() public {
        _createSLA(3);
        SLASettlement.ServiceFact[] memory facts = new SLASettlement.ServiceFact[](3);
        facts[0] = _fact(0, 9900, keccak256("b1"), deviceId, emitter);
        facts[1] = _fact(1, 9900, keccak256("b2"), deviceId, emitter);
        facts[2] = _fact(2, 9900, keccak256("b3"), deviceId, emitter);
        settle.submitVerifiedBatch(slaId, facts);

        assertEq(settle.getSLA(slaId).verifiedWindows, 3);
    }

    // ---- Slash (owner governance) ----

    function test_slash_ownerSeizesUnfinishedSLA() public {
        _createSLA(10);
        _submitSingle(0, 9900, 1); // never completes

        uint256 ownerBefore = owner.balance;
        settle.slash(slaId);

        assertEq(owner.balance - ownerBefore, reward + collateral);
        assertEq(settle.getSLA(slaId).settled, true);
    }

    function test_slash_nonOwner_reverts() public {
        _createSLA(10);
        vm.prank(impostor());
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.OnlyOwner.selector, impostor()));
        settle.slash(slaId);
    }

    function impostor() internal pure returns (address) {
        return address(0xBEEF);
    }

    // Allow the test contract (owner) to receive seized slash funds.
    receive() external payable {}
}
