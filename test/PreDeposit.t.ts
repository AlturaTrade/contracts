// test/PreDeposit.t.ts
import { expect } from "chai";
import { ethers, network } from "hardhat";

const ONE_E18 = ethers.parseEther("1");
const TWO_DAYS = 2 * 24 * 60 * 60;

const setNextTs = async (ts: number) => {
  await network.provider.send("evm_setNextBlockTimestamp", [ts]);
  await network.provider.send("evm_mine", []);
};

const latestTs = async () =>
  (await ethers.provider.getBlock("latest"))!.timestamp;

// Helper: ensure we never go backwards in time
const advanceToAtLeast = async (ts: number) => {
  const now = Number(await latestTs());
  const target = Math.max(now + 1, ts);
  await setNextTs(target);
};

describe("PreDeposit (pre-deposit wrapper for NavVault)", function () {
  async function deployFixture() {
    const [admin, operator, guardian, reporter, user, other] =
      await ethers.getSigners();

    // ---- Underlying asset (USDC-style, 6 decimals) ----
    const Token = await ethers.getContractFactory("TestERC20");
    const usdc = await Token.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();

    // ---- Oracle ----
    const Oracle = await ethers.getContractFactory("NavOracle");
    const oracle = await Oracle.deploy(
      admin.address,
      reporter.address,
      guardian.address,
      3600001, // oracle staleness cap
      0
    );
    await oracle.waitForDeployment();

    // ---- NavVault (ERC4626) ----
    const Vault = await ethers.getContractFactory("NavVault");
    const vault = await Vault.deploy(
      usdc.target,
      "NAV Vault",
      "NAV",
      oracle.target,
      admin.address,
      operator.address,
      guardian.address,
      300000, // initialMaxAllowedStaleness (vault)
      86_400 // epochSeconds (daily)
    );
    await vault.waitForDeployment();

    // Seed PPS = 1.0
    const ts0 = (Number(await latestTs()) + 5);
    await oracle.connect(reporter).reportNav(ONE_E18, ts0);

    // Seed balances
    await usdc.mint(user.address, 1_000_000_000); // 1,000 USDC
    await usdc.mint(other.address, 500_000_000); // 500 USDC
    await usdc.mint(operator.address, 1_000_000_000); // operator liquidity

    // ---- PreDeposit (note: takes asset, not vault) ----
    const PreDeposit = await ethers.getContractFactory("PreDeposit");
    const claimStart = ts0 + 3600; // 1h after initial report
    const preDeposit = await PreDeposit.deploy(usdc.target, claimStart);
    await preDeposit.waitForDeployment();

    // Attach PreAVLT
    const preTokenAddr = await preDeposit.preToken();
    const PreAVLT = await ethers.getContractFactory("PreAVLT");
    const preToken = PreAVLT.attach(preTokenAddr);

    return {
      admin,
      operator,
      guardian,
      reporter,
      user,
      other,
      usdc,
      oracle,
      vault,
      preDeposit,
      preToken,
      claimStart,
    };
  }

  it("constructor wiring, preToken ownership and guards", async () => {
    const { usdc, vault, preDeposit, preToken, claimStart } =
      await deployFixture();

    // Correct wiring
    expect(await preDeposit.assetAddress()).to.equal(usdc.target);
    expect(await preDeposit.vaultAddress()).to.equal(ethers.ZeroAddress);
    expect(await preDeposit.claimStart()).to.equal(BigInt(claimStart));

    // preToken config
    expect(await preToken.name()).to.equal("Pre Altura Vault Token");
    expect(await preToken.symbol()).to.equal("preAVLT");
    expect(await preToken.decimals()).to.equal(6);
    // PreDeposit is owner of preToken
    expect(await preToken.owner()).to.equal(preDeposit.target);

    // Constructor guard: zero asset address
    const PreDeposit = await ethers.getContractFactory("PreDeposit");
    await expect(
      PreDeposit.deploy(ethers.ZeroAddress, claimStart),
    ).to.be.revertedWithCustomError(PreDeposit, "BadAddress");

    // Sanity: vault is wired to same asset
    expect(await vault.asset()).to.equal(usdc.target);
  });

  it("setVault schedules a pending vault and enforces single scheduling; activateVault sets the active vault", async () => {
    const { admin, vault, preDeposit } = await deployFixture();

    // Initially zero
    expect(await preDeposit.vaultAddress()).to.equal(ethers.ZeroAddress);
    expect(await preDeposit.pendingVault()).to.equal(ethers.ZeroAddress);
    expect(await preDeposit.vaultActivationTime()).to.equal(0n);

    const now = Number(await latestTs());

    await preDeposit.connect(admin).setVault(vault.target);

    const pending = await preDeposit.pendingVault();
    const activationTime = await preDeposit.vaultActivationTime();

    expect(pending).to.equal(vault.target);
    expect(activationTime).to.be.gt(0n);

    const diff = activationTime - BigInt(now);
    // allow for +/- 1s drift
    expect(diff === BigInt(TWO_DAYS) || diff === BigInt(TWO_DAYS + 1)).to.be
      .true;

    // Cannot activate before activationTime
    await expect(
      preDeposit.connect(admin).activateVault(),
    ).to.be.revertedWithCustomError(preDeposit, "ClaimNotStarted"); // reused error

    // Warp beyond activationTime and activate
    await advanceToAtLeast(Number(activationTime) + 1);
    await expect(preDeposit.connect(admin).activateVault())
      .to.emit(preDeposit, "VaultSet")
      .withArgs(vault.target);

    expect(await preDeposit.vaultAddress()).to.equal(vault.target);
    expect(await preDeposit.pendingVault()).to.equal(ethers.ZeroAddress);
  });

  it("preDeposit stores assets and mints preAVLT 1:1 with assets, only before claimStart", async () => {
    const { user, usdc, preDeposit, preToken, claimStart } =
      await deployFixture();

    const depositAmount = 200_000_000n; // 200 USDC (6 decimals)

    await usdc.connect(user).approve(preDeposit.target, depositAmount);

    const userBalBefore = await usdc.balanceOf(user.address);
    const contractAssetBefore = await usdc.balanceOf(preDeposit.target);
    const preTokenSupplyBefore = await preToken.totalSupply();

    await expect(preDeposit.connect(user).preDeposit(depositAmount))
      .to.emit(preDeposit, "PreDeposited")
      .withArgs(user.address, depositAmount, depositAmount);

    const userBalAfter = await usdc.balanceOf(user.address);
    const contractAssetAfter = await usdc.balanceOf(preDeposit.target);
    const preTokenSupplyAfter = await preToken.totalSupply();

    // User USDC debited
    expect(userBalBefore - userBalAfter).to.equal(depositAmount);

    // Contract holds those assets
    expect(contractAssetAfter - contractAssetBefore).to.equal(depositAmount);

    // preToken 1:1 with assets
    expect(await preToken.balanceOf(user.address)).to.equal(depositAmount);
    expect(preTokenSupplyAfter - preTokenSupplyBefore).to.equal(depositAmount);

    // claimableShares view
    expect(await preDeposit.claimableShares(user.address)).to.equal(
      depositAmount,
    );

    // No vault set yet -> vaultShareBalance is zero
    expect(await preDeposit.vaultShareBalance()).to.equal(0n);

    // After claimStart, preDeposit must revert with ClaimStarted
    await advanceToAtLeast(claimStart + 1);

    await expect(
      preDeposit.connect(user).preDeposit(1),
    ).to.be.revertedWithCustomError(preDeposit, "ClaimStarted");
  });

  it("preDeposit reverts on zero amount and when paused", async () => {
    const { admin, user, usdc, preDeposit } = await deployFixture();

    await usdc.connect(user).approve(preDeposit.target, 1_000_000_000);

    // Zero amount
    await expect(
      preDeposit.connect(user).preDeposit(0),
    ).to.be.revertedWithCustomError(preDeposit, "ZeroAmount");

    // Pause by owner
    await preDeposit.connect(admin).pause();

    await expect(
      preDeposit.connect(user).preDeposit(100_000_000),
    ).to.be.revertedWithCustomError(preDeposit, "EnforcedPause");

    // Unpause and ensure works again
    await preDeposit.connect(admin).unpause();
    await preDeposit.connect(user).preDeposit(100_000_000);
  });

  it("claim reverts before claimStart and on zero amount", async () => {
    const { user, usdc, preDeposit, preToken, claimStart } =
      await deployFixture();

    const assetsIn = 100_000_000n; // 100 USDC
    await usdc.connect(user).approve(preDeposit.target, assetsIn);
    await preDeposit.connect(user).preDeposit(assetsIn);

    const preBal = await preToken.balanceOf(user.address);
    expect(preBal).to.be.gt(0n);

    // Before claimStart -> ClaimNotStarted
    await expect(
      preDeposit.connect(user).claim(preBal),
    ).to.be.revertedWithCustomError(preDeposit, "ClaimNotStarted");

    // Move time beyond claimStart so we can hit ZeroAmount check
    await advanceToAtLeast(claimStart + 10);

    await expect(
      preDeposit.connect(user).claim(0),
    ).to.be.revertedWithCustomError(preDeposit, "ZeroAmount");
  });

  it("claim reverts if vault is not active (VaultNotSet) even after claimStart", async () => {
    const { user, usdc, preDeposit, preToken, claimStart } =
      await deployFixture();

    const assetsIn = 80_000_000n;
    await usdc.connect(user).approve(preDeposit.target, assetsIn);
    await preDeposit.connect(user).preDeposit(assetsIn);

    const preBal = await preToken.balanceOf(user.address);

    // Advance past claimStart
    await advanceToAtLeast(claimStart + 1);

    await expect(
      preDeposit.connect(user).claim(preBal),
    ).to.be.revertedWithCustomError(preDeposit, "VaultNotSet");

    // Balance unchanged on revert
    expect(await preToken.balanceOf(user.address)).to.equal(preBal);
  });

  it("allows users to withdraw pre-deposits during the 2-day pending vault window", async () => {
    const { admin, user, usdc, vault, preDeposit, preToken } =
      await deployFixture();

    const assetsIn = 200_000_000n;
    await usdc.connect(user).approve(preDeposit.target, assetsIn);
    await preDeposit.connect(user).preDeposit(assetsIn);

    const userPre = await preToken.balanceOf(user.address);
    expect(userPre).to.equal(assetsIn);

    // Schedule vault
    await preDeposit.connect(admin).setVault(vault.target);

    const activationTime = await preDeposit.vaultActivationTime();

    // Withdraw during window
    const userUsdcBefore = await usdc.balanceOf(user.address);
    const contractUsdcBefore = await usdc.balanceOf(preDeposit.target);

    await expect(
      preDeposit.connect(user).withdrawPreDeposit(userPre),
    )
      .to.emit(preDeposit, "PreDepositWithdrawn")
      .withArgs(user.address, userPre, userPre);

    const userUsdcAfter = await usdc.balanceOf(user.address);
    const contractUsdcAfter = await usdc.balanceOf(preDeposit.target);

    expect(userUsdcAfter - userUsdcBefore).to.equal(userPre);
    expect(contractUsdcBefore - contractUsdcAfter).to.equal(userPre);
    expect(await preToken.balanceOf(user.address)).to.equal(0n);

    // After activation window ends and vault activated, withdrawPreDeposit should revert
    await advanceToAtLeast(Number(activationTime) + 1);
    await preDeposit.connect(admin).activateVault();

    await expect(
      preDeposit.connect(user).withdrawPreDeposit(1),
    ).to.be.revertedWithCustomError(preDeposit, "WithdrawWindowOver");
  });

  it("happy path: activate vault, depositAllToVault after pre-deposits, then claim burns preAVLT and transfers vault shares 1:1", async () => {
    const {
      admin,
      user,
      usdc,
      vault,
      preDeposit,
      preToken,
      claimStart,
    } = await deployFixture();

    const assetsIn = 250_000_000n; // 250 USDC

    // User pre-deposits
    await usdc.connect(user).approve(preDeposit.target, assetsIn);
    await preDeposit.connect(user).preDeposit(assetsIn);

    const userPre = await preToken.balanceOf(user.address);
    expect(userPre).to.equal(assetsIn);

    const contractAssetBefore = await usdc.balanceOf(preDeposit.target);
    expect(contractAssetBefore).to.equal(assetsIn);

    // Schedule vault
    await preDeposit.connect(admin).setVault(vault.target);
    const activationTime = await preDeposit.vaultActivationTime();
    await advanceToAtLeast(Number(activationTime) + 1);
    await preDeposit.connect(admin).activateVault();

    const sharesExpected =
      await vault.convertToShares(contractAssetBefore);

    // Move all assets sitting on PreDeposit into the vault
    await expect(
      preDeposit.connect(admin).depositAllToVault(),
    )
      .to.emit(preDeposit, "DepositedToVault")
      .withArgs(contractAssetBefore, sharesExpected);

    expect(await usdc.balanceOf(preDeposit.target)).to.equal(0n);
    expect(await vault.balanceOf(preDeposit.target)).to.equal(
      sharesExpected,
    );

    const preSupplyBefore = await preToken.totalSupply();
    const preDepositVaultBefore = await vault.balanceOf(preDeposit.target);
    const userVaultBefore = await vault.balanceOf(user.address);

    // Move time beyond claimStart (but never backwards)
    await advanceToAtLeast(claimStart + 5);

    // Claim full preAVLT
    const claimAmount = userPre;

    await expect(
      preDeposit.connect(user).claim(claimAmount),
    )
      .to.emit(preDeposit, "Claimed")
      .withArgs(user.address, claimAmount, claimAmount);

    // preAVLT burned
    expect(await preToken.balanceOf(user.address)).to.equal(0n);
    expect(await preToken.totalSupply()).to.equal(
      preSupplyBefore - claimAmount,
    );

    // Vault shares moved from PreDeposit to user (1:1 with preAVLT)
    expect(await vault.balanceOf(preDeposit.target)).to.equal(
      preDepositVaultBefore - claimAmount,
    );
    expect(await vault.balanceOf(user.address)).to.equal(
      userVaultBefore + claimAmount,
    );
  });

  it("partial claims work and remaining preAVLT/shares stay consistent", async () => {
    const {
      admin,
      user,
      usdc,
      vault,
      preDeposit,
      preToken,
      claimStart,
    } = await deployFixture();

    const assetsIn = 400_000_000n; // 400 USDC
    await usdc.connect(user).approve(preDeposit.target, assetsIn);
    await preDeposit.connect(user).preDeposit(assetsIn);

    const fullPre = await preToken.balanceOf(user.address);
    const halfPre = fullPre / 2n;

    // Schedule vault and move all underlying into vault as shares
    await preDeposit.connect(admin).setVault(vault.target);
    const activationTime = await preDeposit.vaultActivationTime();
    await advanceToAtLeast(Number(activationTime) + 1);
    await preDeposit.connect(admin).activateVault();

    const contractAsset = await usdc.balanceOf(preDeposit.target);
    expect(contractAsset).to.equal(assetsIn);

    await preDeposit.connect(admin).depositAllToVault();

    expect(await usdc.balanceOf(preDeposit.target)).to.equal(0n);
    expect(await vault.balanceOf(preDeposit.target)).to.equal(fullPre); // PPS=1 ⇒ shares == assets

    // Move time beyond claimStart
    await advanceToAtLeast(claimStart + 1);

    // First half claim
    await preDeposit.connect(user).claim(halfPre);

    expect(await preToken.balanceOf(user.address)).to.equal(fullPre - halfPre);
    expect(await vault.balanceOf(user.address)).to.equal(halfPre);

    // Second half claim
    await preDeposit.connect(user).claim(fullPre - halfPre);

    expect(await preToken.balanceOf(user.address)).to.equal(0n);
    expect(await vault.balanceOf(user.address)).to.equal(fullPre);
  });

  it("claim reverts when paused and passes again after unpause", async () => {
    const {
      admin,
      user,
      usdc,
      vault,
      preDeposit,
      preToken,
      claimStart,
    } = await deployFixture();

    const assetsIn = 150_000_000n;
    await usdc.connect(user).approve(preDeposit.target, assetsIn);
    await preDeposit.connect(user).preDeposit(assetsIn);

    const preBal = await preToken.balanceOf(user.address);

    // Schedule vault & move assets into vault
    await preDeposit.connect(admin).setVault(vault.target);
    const activationTime = await preDeposit.vaultActivationTime();
    await advanceToAtLeast(Number(activationTime) + 1);
    await preDeposit.connect(admin).activateVault();
    await preDeposit.connect(admin).depositAllToVault();

    // Move time so claim is allowed
    await advanceToAtLeast(claimStart + 2);

    // Pause
    await preDeposit.connect(admin).pause();

    await expect(
      preDeposit.connect(user).claim(preBal),
    ).to.be.revertedWithCustomError(preDeposit, "EnforcedPause");

    await preDeposit.connect(admin).unpause();
    await preDeposit.connect(user).claim(preBal);

    expect(await preToken.balanceOf(user.address)).to.equal(0n);
  });

  it("setClaimStart updates timestamp and emits event", async () => {
    const { admin, preDeposit } = await deployFixture();

    const newTs = Number(await latestTs()) + 9999;

    await expect(preDeposit.connect(admin).setClaimStart(newTs))
      .to.emit(preDeposit, "ClaimStartUpdated")
      .withArgs(newTs);

    expect(await preDeposit.claimStart()).to.equal(BigInt(newTs));
  });

  it("depositAllToVault works and enforces guards", async () => {
    const { admin, usdc, vault, preDeposit } = await deployFixture();

    // 1) Revert if vault not active
    await expect(
      preDeposit.connect(admin).depositAllToVault(),
    ).to.be.revertedWithCustomError(preDeposit, "VaultNotSet");

    // Schedule vault
    await preDeposit.connect(admin).setVault(vault.target);

    // Still not active => VaultNotSet
    await expect(
      preDeposit.connect(admin).depositAllToVault(),
    ).to.be.revertedWithCustomError(preDeposit, "VaultNotSet");

    // Activate vault
    const activationTime = await preDeposit.vaultActivationTime();
    await advanceToAtLeast(Number(activationTime) + 1);
    await preDeposit.connect(admin).activateVault();

    // 2) Revert if no assets on contract
    await expect(
      preDeposit.connect(admin).depositAllToVault(),
    ).to.be.revertedWithCustomError(preDeposit, "ZeroAmount");

    // 3) Happy path
    const amount = 120_000_000n;
    await usdc.mint(preDeposit.target, amount);

    const contractAssetBefore = await usdc.balanceOf(preDeposit.target);
    expect(contractAssetBefore).to.equal(amount);

    const expectedShares = await vault.convertToShares(contractAssetBefore);

    await expect(
      preDeposit.connect(admin).depositAllToVault(),
    )
      .to.emit(preDeposit, "DepositedToVault")
      .withArgs(contractAssetBefore, expectedShares);

    expect(await usdc.balanceOf(preDeposit.target)).to.equal(0n);
    expect(await vault.balanceOf(preDeposit.target)).to.equal(
      expectedShares,
    );
  });

  it("rescueTokens cannot rescue asset, vault shares or preAVLT, but can rescue arbitrary tokens", async () => {
    const { admin, usdc, vault, preDeposit, preToken } =
      await deployFixture();

    // Schedule & activate vault
    await preDeposit.connect(admin).setVault(vault.target);
    const activationTime = await preDeposit.vaultActivationTime();
    await advanceToAtLeast(Number(activationTime) + 1);
    await preDeposit.connect(admin).activateVault();

    // Deploy an unrelated ERC20 token
    const Token = await ethers.getContractFactory("TestERC20");
    const misc = await Token.deploy("Misc Token", "MISC", 18);
    await misc.waitForDeployment();

    // Send some misc tokens to PreDeposit
    await misc.mint(preDeposit.target, ethers.parseEther("10"));

    // Core tokens cannot be rescued
    await expect(
      preDeposit
        .connect(admin)
        .rescueTokens(usdc.target, admin.address, 1),
    ).to.be.revertedWithCustomError(preDeposit, "NotAllowedToken");

    await expect(
      preDeposit
        .connect(admin)
        .rescueTokens(vault.target, admin.address, 1),
    ).to.be.revertedWithCustomError(preDeposit, "NotAllowedToken");

    await expect(
      preDeposit
        .connect(admin)
        .rescueTokens(preToken.target, admin.address, 1),
    ).to.be.revertedWithCustomError(preDeposit, "NotAllowedToken");

    // Bad recipient
    await expect(
      preDeposit
        .connect(admin)
        .rescueTokens(misc.target, ethers.ZeroAddress, 1),
    ).to.be.revertedWithCustomError(preDeposit, "BadAddress");

    // Successful rescue of misc token
    const adminMiscBefore = await misc.balanceOf(admin.address);
    await preDeposit
      .connect(admin)
      .rescueTokens(misc.target, admin.address, ethers.parseEther("3"));
    const adminMiscAfter = await misc.balanceOf(admin.address);

    expect(adminMiscAfter - adminMiscBefore).to.equal(
      ethers.parseEther("3"),
    );
  });

  it("rejects native ETH via receive and fallback", async () => {
    const { user, preDeposit } = await deployFixture();

    // receive()
    await expect(
      user.sendTransaction({
        to: preDeposit.target,
        value: 1n,
      }),
    ).to.be.revertedWithCustomError(preDeposit, "NoNativeToken");

    // fallback()
    await expect(
      user.sendTransaction({
        to: preDeposit.target,
        value: 1n,
        data: "0x1234",
      }),
    ).to.be.revertedWithCustomError(preDeposit, "NoNativeToken");
  });

  it("preToken mint/burn are only callable by PreDeposit owner", async () => {
    const { admin, user, preDeposit, preToken } = await deployFixture();

    // Non-owner cannot mint/burn
    await expect(
      preToken.connect(user).mint(user.address, 1_000_000),
    ).to.be.revertedWithCustomError(preToken, "OwnableUnauthorizedAccount");

    await expect(
      preToken.connect(user).burn(user.address, 1_000_000),
    ).to.be.revertedWithCustomError(preToken, "OwnableUnauthorizedAccount");

    // Owner (PreDeposit) can mint/burn, but must be called via PreDeposit.
    await expect(
      preToken.connect(admin).mint(user.address, 1_000_000),
    ).to.be.revertedWithCustomError(preToken, "OwnableUnauthorizedAccount");
  });

  it("claim fails when user tries to burn more preAVLT than they own", async () => {
    const { admin, user, other, usdc, vault, preDeposit, preToken, claimStart } =
      await deployFixture();

    const assetsIn = 100_000_000n;
    await usdc.connect(user).approve(preDeposit.target, assetsIn);
    await preDeposit.connect(user).preDeposit(assetsIn);

    const userPre = await preToken.balanceOf(user.address);
    expect(userPre).to.be.gt(0n);

    // Schedule vault and give contract some shares so InsufficientShares is not the issue
    await preDeposit.connect(admin).setVault(vault.target);
    const activationTime = await preDeposit.vaultActivationTime();
    await advanceToAtLeast(Number(activationTime) + 1);
    await preDeposit.connect(admin).activateVault();

    await usdc.mint(admin.address, 200_000_000n);
    await usdc.connect(admin).approve(vault.target, 200_000_000n);
    await vault.connect(admin).deposit(200_000_000n, preDeposit.target);

    // Move time beyond claimStart
    await advanceToAtLeast(claimStart + 1);

    // Other has zero preAVLT -> burning non-existent preAVLT will revert in ERC20
    await expect(
      preDeposit.connect(other).claim(1_000_000),
    ).to.be.reverted; // generic ERC20 burn revert
  });
});
