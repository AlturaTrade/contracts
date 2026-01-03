// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

error BadAddress();
error ZeroAmount();
error ClaimNotStarted();
error ClaimStarted();
error NotAllowedToken();
error NoNativeToken();
error VaultNotSet();
error InsufficientShares();
error WithdrawWindowOver();

contract PreAVLT is ERC20, Ownable {
    constructor()
        ERC20("Pre Altura Vault Token", "preAVLT")
        Ownable(msg.sender)
    {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}

contract PreDeposit is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    IERC4626 public vault;

    address public pendingVault;
    uint256 public vaultActivationTime;

    PreAVLT public immutable preToken;
    uint256 public claimStart;

    event PreDeposited(address indexed user, uint256 assetAmount, uint256 preAvltMinted);
    event Claimed(address indexed user, uint256 preAvltBurned, uint256 vaultSharesTransferred);
    event ClaimStartUpdated(uint256 newClaimStart);
    event VaultSet(address indexed vault);
    event VaultActivationScheduled(address indexed pendingVault, uint256 activationTime);
    event DepositedToVault(uint256 assets, uint256 shares);
    event PreDepositWithdrawn(address indexed user, uint256 preBurned, uint256 assetsReturned);

    constructor(address _asset, uint256 _claimStart)
        Ownable(msg.sender)
    {
        if (_asset == address(0)) revert BadAddress();
        asset = IERC20(_asset);
        claimStart = _claimStart;
        PreAVLT _preToken = new PreAVLT();
        preToken = _preToken;
    }

    receive() external payable {
        revert NoNativeToken();
    }

    fallback() external payable {
        revert NoNativeToken();
    }

    function claimableShares(address user) external view returns (uint256) {
        return preToken.balanceOf(user);
    }

    function vaultShareBalance() external view returns (uint256) {
        if (address(vault) == address(0)) return 0;
        return IERC20(address(vault)).balanceOf(address(this));
    }

    function assetAddress() external view returns (address) {
        return address(asset);
    }

    function vaultAddress() external view returns (address) {
        return address(vault);
    }

    function pendingVaultAddress() external view returns (address) {
        return pendingVault;
    }

    function setVault(address _vault) external onlyOwner {
        if (_vault == address(0)) revert BadAddress();

        pendingVault = _vault;
        vaultActivationTime = block.timestamp + 2 days;

        if(vaultActivationTime >= claimStart) {
            claimStart = vaultActivationTime;
        }

        emit VaultActivationScheduled(_vault, vaultActivationTime);
    }

    function activateVault() external onlyOwner {
        if (pendingVault == address(0)) revert VaultNotSet();
        if (block.timestamp < vaultActivationTime) revert ClaimNotStarted();

        vault = IERC4626(pendingVault);
        pendingVault = address(0);

        emit VaultSet(address(vault));
    }

    function setClaimStart(uint256 ts) external onlyOwner {
        claimStart = ts;
        emit ClaimStartUpdated(ts);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function preDeposit(uint256 assetAmount)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 preAvltMinted)
    {
        if (block.timestamp >= claimStart) revert ClaimStarted();
        if (assetAmount == 0) revert ZeroAmount();
        asset.safeTransferFrom(msg.sender, address(this), assetAmount);
        preAvltMinted = assetAmount;
        preToken.mint(msg.sender, preAvltMinted);
        emit PreDeposited(msg.sender, assetAmount, preAvltMinted);
    }

    function withdrawPreDeposit(uint256 preAmount)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 assetsOut)
    {
        if (preAmount == 0) revert ZeroAmount();

        if (
            pendingVault == address(0) ||
            block.timestamp >= vaultActivationTime ||
            address(vault) != address(0)
        ) revert WithdrawWindowOver();

        preToken.burn(msg.sender, preAmount);

        uint256 bal = asset.balanceOf(address(this));
        if (preAmount > bal) revert InsufficientShares();

        assetsOut = preAmount;
        asset.safeTransfer(msg.sender, assetsOut);

        emit PreDepositWithdrawn(msg.sender, preAmount, assetsOut);
    }

    function depositAllToVault()
        external
        onlyOwner
        nonReentrant
        returns (uint256 sharesOut)
    {
        if (address(vault) == address(0)) revert VaultNotSet();

        uint256 balance = asset.balanceOf(address(this));
        if (balance == 0) revert ZeroAmount();

        asset.safeIncreaseAllowance(address(vault), balance);
        sharesOut = vault.deposit(balance, address(this));

        emit DepositedToVault(balance, sharesOut);
    }

    function claim(uint256 preAmount)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 sharesOut)
    {
        if (block.timestamp < claimStart) revert ClaimNotStarted();
        if (preAmount == 0) revert ZeroAmount();
        if (address(vault) == address(0)) revert VaultNotSet();

        preToken.burn(msg.sender, preAmount);
        sharesOut = preAmount;

        uint256 balance = IERC20(address(vault)).balanceOf(address(this));
        if (sharesOut > balance) revert InsufficientShares();

        IERC20(address(vault)).safeTransfer(msg.sender, sharesOut);
        emit Claimed(msg.sender, preAmount, sharesOut);
    }

    function rescueTokens(address token, address to, uint256 amount)
        external
        onlyOwner
    {
        if (to == address(0)) revert BadAddress();
        if (
            token == address(asset) ||
            token == address(preToken) ||
            (address(vault) != address(0) && token == address(vault))
        ) revert NotAllowedToken();

        IERC20(token).safeTransfer(to, amount);
    }
}