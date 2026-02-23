// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVault is IERC20 {
    function asset() external view returns (address);

    function queueWithdrawal(uint256 shares, address receiver) external returns (uint256 id);
    function claimWithdrawal(uint256 id) external;
    function cancelWithdrawal(uint256 id) external;
}

contract WithdrawalWrapper is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    IVault public immutable vault;
    IERC20 public immutable shares;
    IERC20 public immutable asset;

    enum Status { NONE, QUEUED, CLAIMED, CANCELLED }

    struct Request {
        address receiver;
        uint128 sharesQueued;
        Status status;
    }

    mapping(uint256 => Request) public requests;

    event Queued(uint256 indexed id, address indexed receiver, uint256 shares);
    event Claimed(uint256 indexed id, address indexed receiver, uint256 assetsSent);
    event Cancelled(uint256 indexed id, address indexed receiver, uint256 sharesReturned);

    error ZeroAmount();
    error BadAddress();
    error NotFound();
    error BadStatus();
    error CancelSharesMismatch();

    constructor(address vault_, address admin, address relayer) {
        require(vault_ != address(0) && admin != address(0) && relayer != address(0), "zero");
        vault = IVault(vault_);
        shares = IERC20(vault_);
        asset = IERC20(IVault(vault_).asset());

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELAYER_ROLE, relayer);
    }

    function queue(uint256 sharesAmount, address receiver)
        external
        onlyRole(RELAYER_ROLE)
        nonReentrant
        returns (uint256 id)
    {
        if (sharesAmount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert BadAddress();

        shares.safeTransferFrom(msg.sender, address(this), sharesAmount);

        shares.forceApprove(address(vault), sharesAmount);

        id = vault.queueWithdrawal(sharesAmount, address(this));

        requests[id] = Request({
            receiver: receiver,
            sharesQueued: uint128(sharesAmount),
            status: Status.QUEUED
        });

        emit Queued(id, receiver, sharesAmount);
    }

    function claim(uint256 id) external onlyRole(RELAYER_ROLE) nonReentrant {
        Request storage r = requests[id];
        if (r.receiver == address(0)) revert NotFound();
        if (r.status != Status.QUEUED) revert BadStatus();

        uint256 beforeBal = asset.balanceOf(address(this));

        vault.claimWithdrawal(id);

        uint256 gained = asset.balanceOf(address(this)) - beforeBal;

        r.status = Status.CLAIMED;

        if (gained > 0) asset.safeTransfer(r.receiver, gained);

        emit Claimed(id, r.receiver, gained);
    }

    function cancel(uint256 id) external onlyRole(RELAYER_ROLE) nonReentrant {
        Request storage r = requests[id];
        if (r.receiver == address(0)) revert NotFound();
        if (r.status != Status.QUEUED) revert BadStatus();

        uint256 beforeShares = shares.balanceOf(address(this));

        vault.cancelWithdrawal(id);

        uint256 gained = shares.balanceOf(address(this)) - beforeShares;

        if (gained != uint256(r.sharesQueued)) revert CancelSharesMismatch();

        r.status = Status.CANCELLED;

        shares.safeTransfer(r.receiver, gained);

        emit Cancelled(id, r.receiver, gained);
    }

    /* Admin */
    function setRelayer(address relayer, bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(relayer != address(0), "zero");
        if (enabled) _grantRole(RELAYER_ROLE, relayer);
        else _revokeRole(RELAYER_ROLE, relayer);
    }

    function rescue(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(to != address(0), "zero");
        IERC20(token).safeTransfer(to, amount);
    }
}
