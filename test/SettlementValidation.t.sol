// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SLASettlement, IBlockProver} from "../contracts/creditcoin/SLASettlement.sol";
import {SettlementTestBase} from "./SettlementTestBase.sol";

/// @dev Day 7: proof-gated validation acceptance tests (brief §26). Every fact is decoded
///      from a proven txBytes, so these exercise the full path: proof verify → decode →
///      deterministic checks. A mock Block Prover precompile at 0x0FD2 stands in for the
///      real Creditcoin precompile.
contract SettlementValidationTest is SettlementTestBase {
    // ---- Proof gate (Day 7) ----

    function test_verifiedProof_accepted() public {
        _createSLA(3);
        _submitWindow(0, 9900);
        assertEq(settle.getSLA(slaId).verifiedWindows, 1);
    }

    function test_invalidProof_reverts() public {
        _createSLA(3);
        _setProver(PROVER_FALSE);
        vm.expectRevert(SLASettlement.ProofVerificationFailed.selector);
        _submitWindow(0, 9900);
    }

    function test_precompileRevert_reverts() public {
        _createSLA(3);
        _setProver(PROVER_REVERT);
        vm.expectRevert(SLASettlement.ProofVerificationFailed.selector);
        _submitWindow(0, 9900);
    }

    function test_wrongChainKey_reverts() public {
        _createSLA(3);
        bytes memory tb = _buildTxBytes(emitter, deviceId, 0, 9900, 1);
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.WrongChainKey.selector, uint64(2)));
        settle.submitProvenBatch(slaId, 2, _heightsFor(1), txs, _proofsFor(1), _continuity());
    }

    function test_lengthMismatch_reverts() public {
        _createSLA(3);
        bytes memory tb = _buildTxBytes(emitter, deviceId, 0, 9900, 1);
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        vm.expectRevert(SLASettlement.LengthMismatch.selector);
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(2), txs, _proofsFor(1), _continuity());
    }

    // ---- Decode layer (Day 7) ----

    function test_revertedSourceTx_reverts() public {
        _createSLA(3);
        bytes memory tb = _buildTxBytes(emitter, deviceId, 0, 9900, 0); // receipt status 0
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        vm.expectRevert(SLASettlement.TxReverted.selector);
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(1), txs, _proofsFor(1), _continuity());
    }

    function test_noServiceWindowClosed_reverts() public {
        _createSLA(3);
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = keccak256("SomeOtherEvent()");
        SLASettlement.Log[] memory logs = new SLASettlement.Log[](1);
        logs[0] = SLASettlement.Log({emitter: emitter, topics: topics, data: bytes("")});
        bytes memory tb = _buildTxBytesWithLogs(logs, 1);
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        vm.expectRevert(SLASettlement.NoServiceWindowClosed.selector);
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(1), txs, _proofsFor(1), _continuity());
    }

    function test_multipleServiceWindows_reverts() public {
        _createSLA(3);
        SLASettlement.Log[] memory logs = new SLASettlement.Log[](2);
        logs[0] = _swcLog(emitter, deviceId, 0, 9900);
        logs[1] = _swcLog(emitter, deviceId, 1, 9900);
        bytes memory tb = _buildTxBytesWithLogs(logs, 1);
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        vm.expectRevert(SLASettlement.MultipleServiceWindows.selector);
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(1), txs, _proofsFor(1), _continuity());
    }

    function test_malformedTxBytes_reverts() public {
        _createSLA(3);
        bytes[] memory txs = new bytes[](1);
        txs[0] = abi.encode(uint8(2), new bytes[](0)); // valid ABI but zero chunks
        vm.expectRevert(SLASettlement.MalformedTxBytes.selector);
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(1), txs, _proofsFor(1), _continuity());
    }

    // ---- Emitter match (brief §26) ----

    function test_emitter_registered_accepted() public {
        _createSLA(3);
        _submitWindow(0, 9900);
        assertEq(settle.getSLA(slaId).verifiedWindows, 1);
    }

    function test_emitter_unknown_reverts() public {
        _createSLA(3);
        bytes memory tb = _buildTxBytes(wrongEmitter, deviceId, 0, 9900, 1);
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.WrongEmitter.selector, slaId, wrongEmitter));
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(1), txs, _proofsFor(1), _continuity());
    }

    // ---- Device binding (brief §26) ----

    function test_device_match_accepted() public {
        _createSLA(3);
        _submitWindow(0, 9900);
        assertEq(settle.getSLA(slaId).verifiedWindows, 1);
    }

    function test_device_mismatch_reverts() public {
        _createSLA(3);
        bytes memory tb = _buildTxBytes(emitter, otherDevice, 0, 9900, 1);
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.WrongDevice.selector, slaId, otherDevice));
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(1), txs, _proofsFor(1), _continuity());
    }

    // ---- Ordering (brief §26) ----

    function test_order_1_2_3_accepted() public {
        _createSLA(3);
        _submitWindow(0, 9900);
        _submitWindow(1, 9900);
        _submitWindow(2, 9900);
        assertEq(settle.getSLA(slaId).verifiedWindows, 3);
    }

    function test_order_1_3_reverts() public {
        _createSLA(3);
        _submitWindow(0, 9900);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.OutOfOrder.selector, slaId, 2, 1));
        _submitWindow(2, 9900);
    }

    function test_order_3_2_reverts() public {
        _createSLA(3);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.OutOfOrder.selector, slaId, 2, 0));
        _submitWindow(2, 9900); // first fact must be window 0
    }

    function test_outOfOrder_insideBatch_reverts() public {
        _createSLA(3);
        bytes[] memory txs = new bytes[](2);
        txs[0] = _buildTxBytes(emitter, deviceId, 0, 9900, 1);
        txs[1] = _buildTxBytes(emitter, deviceId, 2, 9900, 1); // window 2 while 1 expected
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.OutOfOrder.selector, slaId, 2, 1));
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(2), txs, _proofsFor(2), _continuity());
    }

    // ---- Replay protection (brief §26) ----

    /// @dev Re-submitting a consumed tx is rejected. Under strict ordering the duplicate
    ///      tx decodes to the already-applied window, so it is caught by the ordering
    ///      rule (defense in depth for future gap-tolerant ordering).
    function test_resubmitConsumedTx_reverts() public {
        _createSLA(3);
        _submitWindow(0, 9900);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.OutOfOrder.selector, slaId, 0, 1));
        _submitWindow(0, 9900);
    }

    /// @dev The same proven window cannot be double-counted across two SLAs on the same
    ///      device — the consumed-tx map rejects it (ReplayDetected).
    function test_replay_acrossSlas_reverts() public {
        _createSLA(3); // SLA-014 for NODE-014
        _submitWindow(0, 9900); // consumes the window-0 tx

        bytes32 slaId2 = keccak256("SLA-999");
        vm.deal(operator, collateral + reward);
        vm.prank(operator);
        settle.createSLA{value: collateral + reward}(
            slaId2, deviceId, emitter, 3, minUptime, collateral, reward
        );

        bytes memory tb = _buildTxBytes(emitter, deviceId, 0, 9900, 1);
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.ReplayDetected.selector, slaId2, keccak256(tb)));
        settle.submitProvenBatch(slaId2, CHAIN_KEY, _heightsFor(1), txs, _proofsFor(1), _continuity());
    }

    // ---- Threshold (brief §26) ----

    function test_threshold_exact_pass() public {
        _createSLA(3);
        _submitWindow(0, 9800); // 9800 >= 9800 -> pass
        assertEq(settle.getSLA(slaId).passedWindows, 1);
    }

    function test_threshold_below_failsButCounts() public {
        _createSLA(3);
        _submitWindow(0, 9799); // 9799 < 9800 -> counts but fails
        assertEq(settle.getSLA(slaId).verifiedWindows, 1);
        assertEq(settle.getSLA(slaId).passedWindows, 0);
    }

    // ---- Completion (brief §26) ----

    function test_completion_9of10_cannotSettle() public {
        _createSLA(10);
        for (uint256 i = 0; i < 9; ++i) {
            _submitWindow(i, 9900);
        }
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.IncompleteHistory.selector, slaId, 9, 10));
        settle.settle(slaId);
    }

    function test_completion_10of10_canSettle() public {
        _createSLA(10);
        for (uint256 i = 0; i < 10; ++i) {
            _submitWindow(i, 9900);
        }
        settle.settle(slaId);
        assertEq(settle.getSLA(slaId).settled, true);
        assertEq(uint256(settle.outcomes(slaId)), uint256(SLASettlement.Outcome.Full));
    }

    // ---- Settle: full pass ----

    function test_settle_full_paysRewardPlusCollateral() public {
        _createSLA(10);
        for (uint256 i = 0; i < 10; ++i) {
            _submitWindow(i, 9900);
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
            _submitWindow(i, i == 5 || i == 8 ? 5000 : 9900);
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
            _submitWindow(i, 9900);
        }
        settle.settle(slaId);

        vm.expectRevert(abi.encodeWithSelector(SLASettlement.SlaAlreadySettled.selector, slaId));
        _submitWindow(3, 9900);
    }

    function test_settleTwice_reverts() public {
        _createSLA(3);
        for (uint256 i = 0; i < 3; ++i) {
            _submitWindow(i, 9900);
        }
        settle.settle(slaId);

        vm.expectRevert(abi.encodeWithSelector(SLASettlement.SlaAlreadySettled.selector, slaId));
        settle.settle(slaId);
    }

    // ---- Empty batch ----

    function test_emptyBatch_reverts() public {
        _createSLA(3);
        bytes[] memory txs = new bytes[](0);
        vm.expectRevert(SLASettlement.EmptyBatch.selector);
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(0), txs, _proofsFor(0), _continuity());
    }

    // ---- Batch submission ----

    function test_batch_multiFact_accepted() public {
        _createSLA(3);
        uint256[] memory ups = new uint256[](3);
        ups[0] = 9900;
        ups[1] = 9900;
        ups[2] = 9900;
        _submitBatch(3, ups);
        assertEq(settle.getSLA(slaId).verifiedWindows, 3);
    }

    // ---- Slash (owner governance) ----

    function test_slash_ownerSeizesUnfinishedSLA() public {
        _createSLA(10);
        _submitWindow(0, 9900); // never completes

        uint256 ownerBefore = owner.balance;
        settle.slash(slaId);

        assertEq(owner.balance - ownerBefore, reward + collateral);
        assertEq(settle.getSLA(slaId).settled, true);
    }

    function test_slash_nonOwner_reverts() public {
        _createSLA(10);
        vm.prank(impostor);
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.OnlyOwner.selector, impostor));
        settle.slash(slaId);
    }

    // ---- Adversarial hardening (Day 9) ----

    /// @dev The whole batch is atomic: if ANY fact fails, NO state advances.
    function test_batch_atomic_noPartialApplication() public {
        _createSLA(3);
        bytes[] memory txs = new bytes[](2);
        txs[0] = _buildTxBytes(emitter, deviceId, 0, 9900, 1); // would pass on its own
        txs[1] = _buildTxBytes(emitter, otherDevice, 1, 9900, 1); // wrong device — fails
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.WrongDevice.selector, slaId, otherDevice));
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(2), txs, _proofsFor(2), _continuity());
        // No partial application of window 0.
        assertEq(settle.getSLA(slaId).verifiedWindows, 0);
        assertEq(settle.getSLA(slaId).passedWindows, 0);
    }

    /// @dev Two facts in one batch claiming the same window (different uptimes, so the
    ///      txBytes differ) — the second is out of order.
    function test_duplicateWindow_insideBatch_reverts() public {
        _createSLA(3);
        bytes[] memory txs = new bytes[](2);
        txs[0] = _buildTxBytes(emitter, deviceId, 0, 9900, 1);
        txs[1] = _buildTxBytes(emitter, deviceId, 0, 5000, 1); // duplicate window 0
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.OutOfOrder.selector, slaId, 0, 1));
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(2), txs, _proofsFor(2), _continuity());
    }

    /// @dev Identical txBytes twice in one batch is rejected (ordering catches it before
    ///      the replay map — defense in depth).
    function test_identicalTxBytes_twiceInBatch_reverts() public {
        _createSLA(3);
        bytes memory tb = _buildTxBytes(emitter, deviceId, 0, 9900, 1);
        bytes[] memory txs = new bytes[](2);
        txs[0] = tb;
        txs[1] = tb;
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.OutOfOrder.selector, slaId, 0, 1));
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(2), txs, _proofsFor(2), _continuity());
    }

    /// @dev All windows below threshold -> zero payout, Partial outcome, SLA closed.
    function test_settle_zeroPass_scalesToZero() public {
        _createSLA(3);
        for (uint256 i = 0; i < 3; ++i) {
            _submitWindow(i, 1000); // all far below the 9800 minimum
        }
        uint256 operatorBefore = operator.balance;
        settle.settle(slaId);
        assertEq(operator.balance - operatorBefore, 0);
        assertEq(uint256(settle.outcomes(slaId)), uint256(SLASettlement.Outcome.Partial));
        assertEq(settle.getSLA(slaId).settled, true);
    }

    /// @dev A proven SWC log whose data is not (uint256,uint256) aborts the decode — no
    ///      malformed facts can be smuggled in even with a valid-looking proof.
    function test_malformedLogData_reverts() public {
        _createSLA(3);
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = keccak256("ServiceWindowClosed(bytes32,uint256,uint256,uint256)");
        topics[1] = deviceId;
        topics[2] = bytes32(uint256(0));
        SLASettlement.Log[] memory logs = new SLASettlement.Log[](1);
        logs[0] = SLASettlement.Log({emitter: emitter, topics: topics, data: hex"deadbeef"});
        bytes memory tb = _buildTxBytesWithLogs(logs, 1);
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        vm.expectRevert(); // abi.decode panics — no way to inject a malformed fact
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(1), txs, _proofsFor(1), _continuity());
        assertEq(settle.getSLA(slaId).verifiedWindows, 0);
    }

    /// @dev Submitting to an unknown SLA id is rejected up front.
    function test_submitUnknownSla_reverts() public {
        bytes memory tb = _buildTxBytes(emitter, deviceId, 0, 9900, 1);
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        bytes32 unknown = keccak256("NOPE");
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.SlaNotFound.selector, unknown));
        settle.submitProvenBatch(unknown, CHAIN_KEY, _heightsFor(1), txs, _proofsFor(1), _continuity());
    }

    /// @dev Submitting once the SLA is already complete is rejected.
    function test_submitAfterComplete_reverts() public {
        _createSLA(1);
        _submitWindow(0, 9900);
        bytes memory tb = _buildTxBytes(emitter, deviceId, 1, 9900, 1);
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        vm.expectRevert(abi.encodeWithSelector(SLASettlement.SlaAlreadyComplete.selector, slaId));
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(1), txs, _proofsFor(1), _continuity());
    }
}
