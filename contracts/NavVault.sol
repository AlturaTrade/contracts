// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {IERC20, ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface INavOracle {
    function pricePerShare() external view returns (uint256 pps1e18, uint256 lastUpdatedAt);
    function isValid() external view returns (bool);
    function maxOracleStaleness() external view returns (uint256);
}

contract NavVault is ERC4626, Pausable, ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;

    // ===== Roles =====
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ===== Oracle / Timing =====
    INavOracle public navOracle;
    uint256 public maxAllowedStaleness;
    uint256 public epochSeconds;

    event EpochSecondsUpdated(uint256 epochSeconds);

    // ===== Oracle Timelock =====
    uint256 public constant ORACLE_TIMELOCK = 1 days;

    address public pendingOracle;
    uint256 public pendingOracleSetAt;

    event OracleChangeQueued(address indexed newOracle, uint256 queuedAt);
    event OracleChanged(address indexed oldOracle, address indexed newOracle);

    // ===== Liquidity Recipient =====
    address public liquidityRecipient;

    event LiquidityRecipientUpdated(address indexed newRecipient);

    // ===== Withdrawal Queue =====
    struct WithdrawalRequest {
        address owner;
        address receiver;
        uint128 sharesEscrow;
        uint64 requestedAt;
        uint64 claimableAt;
        bool closed;
    }

    uint256 public nextRequestId;
    mapping(uint256 => WithdrawalRequest) public requests;
    mapping(address => uint256[]) private _userRequests;

    // ===== Referrals =====
    mapping(address => address) public referrerOf;

    event WithdrawalQueued(
        uint256 indexed id,
        address indexed owner,
        address indexed receiver,
        uint256 sharesEscrow,
        uint64 claimableAt
    );
    event WithdrawalClaimed(
        uint256 indexed id,
        address indexed owner,
        address indexed receiver,
        uint256 sharesBurned,
        uint256 assetsPaid,
        bool fullyClosed
    );
    event WithdrawalCancelled(uint256 indexed id, address indexed owner, uint256 sharesReturned);

    event ReferrerSet(address indexed user, address indexed referrer);
    event ReferredDeposit(
        address indexed payer,
        address indexed receiver,
        address indexed referrer,
        uint256 assetsIn,
        uint256 sharesOut
    );
    event ReferredMint(
        address indexed payer,
        address indexed receiver,
        address indexed referrer,
        uint256 assetsIn,
        uint256 sharesOut
    );

    // ===== Flow Counters =====
    uint256 public cumulativeDeposits;
    uint256 public cumulativeWithdrawals;
    event FlowCountersUpdated(uint256 cumulativeDeposits, uint256 cumulativeWithdrawals);

    // ===== Exit Fee (instant only) =====
    uint256 public constant FEE_BPS_DENOM = 10_000;
    uint16 public exitFeeBps;
    uint256 public accruedExitFeesAssets;

    event ExitFeeBpsUpdated(uint256 feeBps);
    event ExitFeesAccrued(uint256 feeAssets, uint256 newAccruedTotal);
    event ExitFeesSwept(address indexed to, uint256 amountAssets);

    // ===== Errors =====
    error OracleInvalid();
    error OracleStale();
    error ZeroAmount();
    error BadAddress();
    error NotOwner();
    error RequestNotClaimable();
    error RequestClosed();
    error InsufficientApproval();
    error InsufficientLiquidity();
    error ReferrerAlreadySet();
    error InvalidReferrer();
    error MinHoldNotReached();
    error SlippageTooHigh();

    constructor(
        IERC20Metadata asset_,
        string memory name_,
        string memory symbol_,
        INavOracle oracle_,
        address admin_,
        address operator_,
        address guardian_,
        uint256 initialMaxAllowedStaleness,
        uint256 epochSeconds_
    ) ERC20(name_, symbol_) ERC4626(asset_) {
        if (
            address(oracle_) == address(0) ||
            admin_ == address(0) ||
            operator_ == address(0) ||
            guardian_ == address(0) ||
            epochSeconds_ == 0
        ) revert BadAddress();

        uint256 cap = oracle_.maxOracleStaleness();
        require(initialMaxAllowedStaleness > 0 && initialMaxAllowedStaleness <= cap, "stale:init");

        navOracle = oracle_;
        maxAllowedStaleness = initialMaxAllowedStaleness;
        epochSeconds = epochSeconds_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(OPERATOR_ROLE, operator_);
        _grantRole(GUARDIAN_ROLE, guardian_);

        exitFeeBps = 1;
    }

    // ===== Admin / Ops =====
    function queueOracleUpdate(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newOracle == address(0)) revert BadAddress();
        pendingOracle = newOracle;
        pendingOracleSetAt = block.timestamp;
        emit OracleChangeQueued(newOracle, block.timestamp);
    }

    function executeOracleUpdate() external onlyRole(DEFAULT_ADMIN_ROLE) {
        address newOracle = pendingOracle;
        if (newOracle == address(0)) revert BadAddress();
        if (block.timestamp < pendingOracleSetAt + ORACLE_TIMELOCK) revert("Oracle update timelocked");

        address old = address(navOracle);
        navOracle = INavOracle(newOracle);

        pendingOracle = address(0);
        pendingOracleSetAt = 0;

        emit OracleChanged(old, newOracle);
    }

    function setMaxAllowedStaleness(uint256 secs) external onlyRole(OPERATOR_ROLE) {
        if (secs == 0) revert ZeroAmount();
        uint256 oracleCap = navOracle.maxOracleStaleness();
        if (secs > oracleCap) revert OracleStale();
        maxAllowedStaleness = secs;
    }

    function setEpochSeconds(uint256 secs) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (secs == 0) revert ZeroAmount();
        epochSeconds = secs;
        emit EpochSecondsUpdated(secs);
    }

    function setExitFeeBps(uint16 bps) external onlyRole(OPERATOR_ROLE) {
        require(bps <= 200, "fee:too_high");
        exitFeeBps = bps;
        emit ExitFeeBpsUpdated(bps);
    }

    function sweepExitFees(address to, uint256 amountAssets) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert BadAddress();

        uint256 available = accruedExitFeesAssets;
        if (amountAssets == 0) amountAssets = available;
        require(amountAssets <= available, "fees:exceeds_accrued");

        IERC20 a = IERC20(address(asset()));
        if (a.balanceOf(address(this)) < amountAssets) revert InsufficientLiquidity();

        accruedExitFeesAssets = available - amountAssets;
        a.safeTransfer(to, amountAssets);

        emit ExitFeesSwept(to, amountAssets);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    // ===== Oracle Reading =====
    function _readPps1e18() internal view returns (uint256 pps1e18) {
        (uint256 pps, uint256 ts) = navOracle.pricePerShare();
        if (pps == 0) revert OracleInvalid();
        if (block.timestamp > ts + maxAllowedStaleness) revert OracleStale();
        if (!navOracle.isValid()) revert OracleInvalid();
        return pps;
    }

    function _oraclePpsScaled() internal view returns (uint256 pps, uint256 scale) {
        uint8 aDec = IERC20Metadata(address(asset())).decimals();
        uint256 pps1e18 = _readPps1e18();
        scale = 10 ** aDec;

        if (aDec == 18) return (pps1e18, scale);
        if (aDec < 18) return (pps1e18 / (10 ** (18 - aDec)), scale);
        return (pps1e18 * (10 ** (aDec - 18)), scale);
    }

    // ===== Fee Helpers =====
    function _feeOnNet(uint256 netAssets) internal view returns (uint256 fee) {
        uint16 bps = exitFeeBps;
        if (bps == 0) return 0;
        uint256 denomMinus = uint256(FEE_BPS_DENOM) - uint256(bps);
        fee = Math.mulDiv(netAssets, uint256(bps), denomMinus, Math.Rounding.Ceil);
    }

    function _feeOnGross(uint256 grossAssets) internal view returns (uint256 fee) {
        uint16 bps = exitFeeBps;
        if (bps == 0) return 0;
        fee = Math.mulDiv(grossAssets, uint256(bps), FEE_BPS_DENOM, Math.Rounding.Ceil);
    }

    // ===== ERC4626 Views (backed by Oracle NAV) =====
    function totalAssets() public view override returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        (uint256 pps, uint256 scale) = _oraclePpsScaled();
        return (supply * pps) / scale;
    }

    function convertToShares(uint256 assets) public view override returns (uint256) {
        return _convertToShares(assets, Math.Rounding.Floor);
    }

    function convertToAssets(uint256 shares) public view override returns (uint256) {
        return _convertToAssets(shares, Math.Rounding.Floor);
    }

    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        if (assets == 0) return 0;
        (uint256 pps, uint256 scale) = _oraclePpsScaled();
        return Math.mulDiv(assets, scale, pps, rounding);
    }

    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        if (shares == 0) return 0;
        (uint256 pps, uint256 scale) = _oraclePpsScaled();
        return Math.mulDiv(shares, pps, scale, rounding);
    }

    function previewDeposit(uint256 assets) public view override returns (uint256) {
        _readPps1e18();
        return super.previewDeposit(assets);
    }

    function previewMint(uint256 shares) public view override returns (uint256) {
        _readPps1e18();
        return super.previewMint(shares);
    }

    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        _readPps1e18();
        uint256 fee = _feeOnNet(assets);
        return super.previewWithdraw(assets + fee);
    }

    function previewRedeem(uint256 shares) public view override returns (uint256) {
        _readPps1e18();
        uint256 gross = super.previewRedeem(shares);
        uint256 fee = _feeOnGross(gross);
        return gross - fee;
    }

    // ===== Referral =====
    function _bindReferrerOnce(address user, address referrer) internal {
        if (referrerOf[user] != address(0)) revert ReferrerAlreadySet();
        if (referrer == address(0) || referrer == user) revert InvalidReferrer();
        referrerOf[user] = referrer;
        emit ReferrerSet(user, referrer);
    }

    function mintWithCheck(uint256 shares, address receiver, address referrer, uint256 maxAssets)
        public
        whenNotPaused
        nonReentrant
        returns (uint256 assetsRequired)
    {
        if (referrer != address(0)) {
            if (referrer == receiver) revert InvalidReferrer();
            if (referrerOf[receiver] == address(0)) {
                if (msg.sender != receiver) revert InvalidReferrer();
                _bindReferrerOnce(receiver, referrer);
            }
        }

        assetsRequired = super.mint(shares, receiver);
        if (assetsRequired > maxAssets) revert SlippageTooHigh();

        cumulativeDeposits += assetsRequired;
        emit FlowCountersUpdated(cumulativeDeposits, cumulativeWithdrawals);

        address r = referrerOf[receiver];
        if (r != address(0)) emit ReferredMint(msg.sender, receiver, r, assetsRequired, shares);

        return assetsRequired;
    }

    function depositWithCheck(uint256 assets, address receiver, address referrer, uint256 minShares)
        public
        whenNotPaused
        nonReentrant
        returns (uint256 shares)
    {
        if (referrer != address(0)) {
            if (referrer == receiver) revert InvalidReferrer();
            if (referrerOf[receiver] == address(0)) {
                if (msg.sender != receiver) revert InvalidReferrer();
                _bindReferrerOnce(receiver, referrer);
            }
        }

        shares = super.deposit(assets, receiver);
        if (shares < minShares) revert SlippageTooHigh();

        cumulativeDeposits += assets;
        emit FlowCountersUpdated(cumulativeDeposits, cumulativeWithdrawals);

        address r = referrerOf[receiver];
        if (r != address(0)) emit ReferredDeposit(msg.sender, receiver, r, assets, shares);

        return shares;
    }

    // ===== Mutating ERC4626 (standard) =====
    function deposit(uint256 assets, address receiver)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256 shares)
    {
        shares = super.deposit(assets, receiver);

        cumulativeDeposits += assets;
        emit FlowCountersUpdated(cumulativeDeposits, cumulativeWithdrawals);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256 assetsRequired)
    {
        assetsRequired = super.mint(shares, receiver);

        cumulativeDeposits += assetsRequired;
        emit FlowCountersUpdated(cumulativeDeposits, cumulativeWithdrawals);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256 sharesBurned)
    {
        if (assets == 0) revert ZeroAmount();

        uint256 fee = _feeOnNet(assets);
        uint256 grossAssets = assets + fee;

        sharesBurned = super.previewWithdraw(grossAssets);
        _withdraw(msg.sender, address(this), owner, grossAssets, sharesBurned);

        IERC20(address(asset())).safeTransfer(receiver, assets);

        if (fee > 0) {
            accruedExitFeesAssets += fee;
            emit ExitFeesAccrued(fee, accruedExitFeesAssets);
        }

        cumulativeWithdrawals += grossAssets;
        emit FlowCountersUpdated(cumulativeDeposits, cumulativeWithdrawals);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256 assetsPaid)
    {
        if (shares == 0) revert ZeroAmount();

        uint256 grossAssets = super.previewRedeem(shares);
        if (grossAssets == 0) revert ZeroAmount();

        _withdraw(msg.sender, address(this), owner, grossAssets, shares);

        uint256 fee = _feeOnGross(grossAssets);
        uint256 netAssets = grossAssets - fee;

        IERC20(address(asset())).safeTransfer(receiver, netAssets);

        if (fee > 0) {
            accruedExitFeesAssets += fee;
            emit ExitFeesAccrued(fee, accruedExitFeesAssets);
        }

        cumulativeWithdrawals += grossAssets;
        emit FlowCountersUpdated(cumulativeDeposits, cumulativeWithdrawals);

        return netAssets;
    }

    // ===== Withdraw / Redeem with slippage =====
    function withdrawWithCheck(uint256 assets, address receiver, address owner, uint256 maxShares)
        public
        whenNotPaused
        nonReentrant
        returns (uint256 sharesBurned)
    {
        if (assets == 0) revert ZeroAmount();

        uint256 fee = _feeOnNet(assets);
        uint256 grossAssets = assets + fee;

        sharesBurned = super.previewWithdraw(grossAssets);
        _withdraw(msg.sender, address(this), owner, grossAssets, sharesBurned);
        if (sharesBurned > maxShares) revert SlippageTooHigh();

        IERC20(address(asset())).safeTransfer(receiver, assets);

        if (fee > 0) {
            accruedExitFeesAssets += fee;
            emit ExitFeesAccrued(fee, accruedExitFeesAssets);
        }

        cumulativeWithdrawals += grossAssets;
        emit FlowCountersUpdated(cumulativeDeposits, cumulativeWithdrawals);
    }

    function redeemWithCheck(uint256 shares, address receiver, address owner, uint256 minAssets)
        public
        whenNotPaused
        nonReentrant
        returns (uint256 assetsPaid)
    {
        if (shares == 0) revert ZeroAmount();

        uint256 grossAssets = super.previewRedeem(shares);
        if (grossAssets == 0) revert ZeroAmount();

        _withdraw(msg.sender, address(this), owner, grossAssets, shares);

        uint256 fee = _feeOnGross(grossAssets);
        uint256 netAssets = grossAssets - fee;

        if (netAssets < minAssets) revert SlippageTooHigh();

        IERC20(address(asset())).safeTransfer(receiver, netAssets);

        if (fee > 0) {
            accruedExitFeesAssets += fee;
            emit ExitFeesAccrued(fee, accruedExitFeesAssets);
        }

        cumulativeWithdrawals += grossAssets;
        emit FlowCountersUpdated(cumulativeDeposits, cumulativeWithdrawals);

        return netAssets;
    }

    // ===== Epoch / Queue =====
    function _nextEpoch(uint256 t) internal view returns (uint64) {
        uint256 e = epochSeconds;
        return uint64(((t / e) * e) + e);
    }

    function queueWithdrawal(uint256 shares, address receiver)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 id)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) receiver = msg.sender;

        uint256 allowance_ = allowance(msg.sender, address(this));
        if (allowance_ < shares) revert InsufficientApproval();

        unchecked {
            _approve(msg.sender, address(this), allowance_ - shares);
        }

        _transfer(msg.sender, address(this), shares);

        uint64 nowTs = uint64(block.timestamp);
        uint64 claimableAt = _nextEpoch(nowTs);

        id = nextRequestId++;
        requests[id] = WithdrawalRequest({
            owner: msg.sender,
            receiver: receiver,
            sharesEscrow: uint128(shares),
            requestedAt: nowTs,
            claimableAt: claimableAt,
            closed: false
        });
        _userRequests[msg.sender].push(id);

        emit WithdrawalQueued(id, msg.sender, receiver, shares, claimableAt);
    }

    function claimWithdrawal(uint256 id) external whenNotPaused nonReentrant {
        WithdrawalRequest storage r = requests[id];
        if (r.owner == address(0)) revert BadAddress();
        if (r.owner != msg.sender) revert NotOwner();
        if (r.closed || r.sharesEscrow == 0) revert RequestClosed();
        if (block.timestamp < r.claimableAt) revert RequestNotClaimable();

        IERC20 a = IERC20(address(asset()));
        uint256 liquid = a.balanceOf(address(this));
        uint256 sharesEscrow = uint256(r.sharesEscrow);

        uint256 fullAssets = convertToAssets(sharesEscrow);
        if (fullAssets == 0) revert ZeroAmount();
        if (liquid < fullAssets) revert InsufficientLiquidity();

        _burn(address(this), sharesEscrow);
        a.safeTransfer(r.receiver, fullAssets);

        cumulativeWithdrawals += fullAssets;
        emit FlowCountersUpdated(cumulativeDeposits, cumulativeWithdrawals);

        r.sharesEscrow = 0;
        r.closed = true;

        emit WithdrawalClaimed(id, r.owner, r.receiver, sharesEscrow, fullAssets, true);
    }

    function cancelWithdrawal(uint256 id) external whenNotPaused nonReentrant {
        WithdrawalRequest storage r = requests[id];
        if (r.owner != msg.sender) revert NotOwner();
        if (r.closed) revert RequestClosed();

        uint256 sharesLeft = r.sharesEscrow;
        r.sharesEscrow = 0;
        r.closed = true;

        _transfer(address(this), r.owner, sharesLeft);
        emit WithdrawalCancelled(id, r.owner, sharesLeft);
    }

    // ===== Liquidity Ops =====
    function setLiquidityRecipient(address newRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRecipient == address(0)) revert BadAddress();
        liquidityRecipient = newRecipient;
        emit LiquidityRecipientUpdated(newRecipient);
    }

    function moveAssets(uint256 assets_) external whenNotPaused onlyRole(OPERATOR_ROLE) nonReentrant {
        if (assets_ == 0) revert ZeroAmount();

        address to = liquidityRecipient;
        if (to == address(0)) revert BadAddress();

        IERC20 a = IERC20(address(asset()));
        uint256 bal = a.balanceOf(address(this));
        if (bal < assets_ + accruedExitFeesAssets) revert InsufficientLiquidity();

        a.safeTransfer(to, assets_);
    }

    function fundLiquidity(uint256 assets_) external whenNotPaused nonReentrant {
        if (assets_ == 0) revert ZeroAmount();
        IERC20(address(asset())).safeTransferFrom(msg.sender, address(this), assets_);
    }

    function availableLiquidity() external view returns (uint256) {
        return IERC20(address(asset())).balanceOf(address(this));
    }

    function allRequestsOf(address owner) external view returns (uint256[] memory ids) {
        ids = _userRequests[owner];
    }

    // ===== Rescue =====
    function rescueToken(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (token == address(asset())) revert();
        if (to == address(0)) revert BadAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
