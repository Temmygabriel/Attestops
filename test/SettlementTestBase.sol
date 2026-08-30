// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SLASettlement, IBlockProver} from "../contracts/creditcoin/SLASettlement.sol";

/// @dev Shared harness for SLASettlement tests.
///      Deploys the contract pinned to sourceChainKey 1, etches a mock Block Prover
///      precompile at the official 0x0FD2 address, and builds well-formed V1 txBytes
///      that carry ServiceWindowClosed events in their receipts.
abstract contract SettlementTestBase is Test {
    SLASettlement internal settle;
    address internal owner = address(this);
    address internal operator = address(0xA11CE);
    address internal emitter = address(0x5EED);
    address internal wrongEmitter = address(0xBEEF);
    address internal impostor = address(0xBEEF);

    bytes32 internal slaId = keccak256("SLA-014");
    bytes32 internal deviceId = keccak256("NODE-014");
    bytes32 internal otherDevice = keccak256("NODE-999");

    uint256 internal collateral = 100 ether;
    uint256 internal reward = 40 ether;
    uint256 internal minUptime = 9800; // 98.00%

    uint64 internal constant CHAIN_KEY = 1;

    // Mock Block Prover runtimes etched at the precompile address.
    bytes internal constant PROVER_TRUE = hex"600160005260206000f3"; // returns true
    bytes internal constant PROVER_FALSE = hex"600060005260206000f3"; // returns false
    bytes internal constant PROVER_REVERT = hex"60006000fd"; // reverts

    function setUp() public virtual {
        settle = new SLASettlement(CHAIN_KEY);
        settle.registerSourceEmitter(emitter);
        vm.deal(operator, 10_000 ether);
        _setProver(PROVER_TRUE);
    }

    function _setProver(bytes memory runtime) internal {
        vm.etch(settle.BLOCK_PROVER_PRECOMPILE(), runtime);
    }

    function _createSLA() internal {
        _createSLA(10);
    }

    function _createSLA(uint256 requiredWindows) internal {
        vm.prank(operator);
        settle.createSLA{value: collateral + reward}(
            slaId, deviceId, emitter, requiredWindows, minUptime, collateral, reward
        );
    }

    // ---- txBytes builder ----

    /// @dev Builds a well-formed V1 abiEncode payload (txType 2) whose receipt carries
    ///      one ServiceWindowClosed event. `status` is the receipt status (1 = success).
    function _buildTxBytes(
        address _emitter,
        bytes32 _deviceId,
        uint256 windowId,
        uint256 uptimeBps,
        uint8 status
    ) internal pure returns (bytes memory) {
        SLASettlement.Log[] memory logs = new SLASettlement.Log[](1);
        logs[0] = _swcLog(_emitter, _deviceId, windowId, uptimeBps);
        return _buildTxBytesWithLogs(logs, status);
    }

    /// @dev A single ServiceWindowClosed log with topic0 + indexed deviceId + indexed windowId.
    function _swcLog(address _emitter, bytes32 _deviceId, uint256 windowId, uint256 uptimeBps)
        internal
        pure
        returns (SLASettlement.Log memory)
    {
        bytes32 topic0 = keccak256("ServiceWindowClosed(bytes32,uint256,uint256,uint256)");
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = topic0;
        topics[1] = _deviceId;
        topics[2] = bytes32(windowId);
        return SLASettlement.Log({
            emitter: _emitter,
            topics: topics,
            data: abi.encode(uptimeBps, uint256(0)) // (uptimeBps, rewardAmount)
        });
    }

    /// @dev Wraps arbitrary logs into a V1 txBytes payload. Receipt is the LAST chunk.
    function _buildTxBytesWithLogs(SLASettlement.Log[] memory logs, uint8 status)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory receipt = abi.encode(status, uint64(0), logs, bytes("")); // (status, gasUsed, logs, bloom)

        bytes[] memory chunks = new bytes[](3);
        chunks[0] = abi.encode(uint64(0), uint64(0), address(0), false, address(0), uint256(0), bytes(""));
        chunks[1] = abi.encode(
            uint64(1), uint128(0), uint128(0), new address[](0), uint8(0), bytes32(0), bytes32(0)
        );
        chunks[2] = receipt;

        return abi.encode(uint8(2), chunks); // txType 2 (EIP-1559)
    }

    // ---- proof material helpers ----

    function _heightsFor(uint256 n) internal pure returns (uint64[] memory) {
        uint64[] memory h = new uint64[](n);
        for (uint256 i = 0; i < n; ++i) h[i] = uint64(11_599_000 + i);
        return h;
    }

    function _proofsFor(uint256 n) internal pure returns (IBlockProver.MerkleProof[] memory) {
        IBlockProver.MerkleProof[] memory p = new IBlockProver.MerkleProof[](n);
        for (uint256 i = 0; i < n; ++i) {
            p[i] = IBlockProver.MerkleProof({
                root: bytes32(uint256(i + 1)),
                siblings: new IBlockProver.MerkleProofEntry[](0)
            });
        }
        return p;
    }

    function _continuity() internal pure returns (IBlockProver.ContinuityProof memory) {
        return IBlockProver.ContinuityProof({lowerEndpointDigest: bytes32(0), roots: new bytes32[](0)});
    }

    /// @dev Submits one proven window (windowId = i, strict order) via the mock prover.
    function _submitWindow(uint256 windowId, uint256 uptimeBps) internal {
        bytes memory tb = _buildTxBytes(emitter, deviceId, windowId, uptimeBps, 1);
        bytes[] memory txs = new bytes[](1);
        txs[0] = tb;
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(1), txs, _proofsFor(1), _continuity());
    }

    /// @dev Submits `count` windows in ONE batch (windows 0..count-1, strict order).
    function _submitBatch(uint256 count, uint256[] memory uptimes) internal {
        bytes[] memory txs = new bytes[](count);
        for (uint256 i = 0; i < count; ++i) {
            txs[i] = _buildTxBytes(emitter, deviceId, i, uptimes[i], 1);
        }
        settle.submitProvenBatch(slaId, CHAIN_KEY, _heightsFor(count), txs, _proofsFor(count), _continuity());
    }

    // Allow the test contract (owner) to receive seized slash funds.
    receive() external payable {}
}
