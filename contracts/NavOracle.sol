// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface INavOracle {
    function pricePerShare() external view returns (uint256 pps1e18, uint256 lastUpdatedAt);
    function isValid() external view returns (bool);
    function maxOracleStaleness() external view returns (uint256);
}

contract NavOracle is INavOracle, AccessControl, Pausable {
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 private _maxOracleStaleness;
    uint256 public maxPpsMoveBps;

    struct NavSnapshot {
        uint256 pps1e18;
        uint64  updatedAt;
    }
    NavSnapshot public lastNav;

    event OracleConfigured(uint256 maxStaleness, uint256 maxPpsMoveBps);
    event NavReported(uint256 pps1e18, uint256 timestamp);
    event OraclePaused(address indexed by);
    event OracleUnpaused(address indexed by);

    error StaleTimestamp();
    error ZeroValue();
    error TooLargeMove();

    constructor(
        address admin,
        address reporter,
        address guardian,
        uint256 maxStalenessSeconds,
        uint256 maxPpsMoveBps_
    ) {
        require(admin != address(0) && reporter != address(0) && guardian != address(0), "bad addrs");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REPORTER_ROLE, reporter);
        _grantRole(GUARDIAN_ROLE, guardian);

        _setConfig(maxStalenessSeconds, maxPpsMoveBps_);

        lastNav = NavSnapshot({ pps1e18: 0, updatedAt: uint64(block.timestamp) });
    }

    function setConfig(uint256 maxStalenessSeconds, uint256 maxPpsMoveBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setConfig(maxStalenessSeconds, maxPpsMoveBps_);
    }

    function _setConfig(uint256 maxStalenessSeconds, uint256 maxPpsMoveBps_) internal {
        require(maxStalenessSeconds > 0, "staleness");
        _maxOracleStaleness = maxStalenessSeconds;
        maxPpsMoveBps = maxPpsMoveBps_;
        emit OracleConfigured(maxStalenessSeconds, maxPpsMoveBps_);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
        emit OraclePaused(msg.sender);
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
        emit OracleUnpaused(msg.sender);
    }

    function pricePerShare() external view override returns (uint256 pps1e18, uint256 lastUpdatedAt) {
        NavSnapshot memory s = lastNav;
        return (s.pps1e18, uint256(s.updatedAt));
    }

    function isValid() external view override returns (bool) {
        return !paused();
    }

    function maxOracleStaleness() external view override returns (uint256) {
        return _maxOracleStaleness;
    }

    function getNav() external view returns (NavSnapshot memory) {
        return lastNav;
    }

    function reportNav(uint256 pps1e18, uint256 ts) external onlyRole(REPORTER_ROLE) whenNotPaused {
        if (pps1e18 == 0 || ts == 0) revert ZeroValue();
        if (ts < block.timestamp - _maxOracleStaleness) revert StaleTimestamp();

        if (maxPpsMoveBps > 0) {
            uint256 prev = lastNav.pps1e18;
            if (prev > 0) {
                uint256 diff = prev > pps1e18 ? prev - pps1e18 : pps1e18 - prev;
                if (diff * 10_000 > prev * maxPpsMoveBps) revert TooLargeMove();
            }
        }

        lastNav = NavSnapshot({ pps1e18: pps1e18, updatedAt: uint64(ts) });
        emit NavReported(pps1e18, ts);
    }
}
