// test/VaultSlippage.t.ts
import { expect } from "chai";
import { ethers } from "hardhat";

const ONE_E18 = ethers.parseEther("1");

const latestTs = async () =>
  (await ethers.provider.getBlock("latest"))!.timestamp;

describe("NavVault — Slippage guards", function () {
  async function deployFixture() {
    const [
      admin,
      operator,
      guardian,
      reporter,
      user,
      other,
    ] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("TestERC20");
    const usdc = await Token.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();

    const Oracle = await ethers.getContractFactory("NavOracle");
    const oracle = await Oracle.deploy(
      admin.address,
      reporter.address,
      guardian.address,
      3600, // oracle staleness cap
      0
    );
    await oracle.waitForDeployment();

    const Vault = await ethers.getContractFactory("NavVault");
    const vault = await Vault.deploy(
      usdc.target,
      "NAV Vault",
      "NAV",
      oracle.target,
      admin.address,
      operator.address,
      guardian.address,
      300,     // vault staleness window
      86_400   // epochSeconds
    );
    await vault.waitForDeployment();

    // Seed initial PPS = 1.0 and balances/approvals
    const ts0 = (await latestTs()) + 5;
    await oracle.connect(reporter).reportNav(ONE_E18, ts0);

    // 10,000 USDC (6 decimals)
    await usdc.mint(user.address, 10_000_000_000n);
    await usdc.connect(user).approve(vault.target, 10_000_000_000n);

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
    };
  }

  /* ------------------------------------------------------------------
   * depositWithCheck
   * ------------------------------------------------------------------ */

  it("depositWithCheck: succeeds when minShares <= previewDeposit", async () => {
    const { vault, oracle, reporter, user } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    const assetsIn = 200_000_000n; // 200 USDC
    const preview = await vault.previewDeposit(assetsIn);

    const tx = await vault
      .connect(user)
      .depositWithCheck(assetsIn, user.address, ethers.ZeroAddress, preview);
    await tx.wait();

    const sharesOut = await vault.balanceOf(user.address);
    expect(sharesOut).to.equal(preview);
  });

  it("depositWithCheck: reverts with SlippageTooHigh when minShares > previewDeposit", async () => {
    const { vault, oracle, reporter, user } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    const assetsIn = 200_000_000n;
    const preview = await vault.previewDeposit(assetsIn);
    const minShares = preview + 1n;

    await expect(
      vault
        .connect(user)
        .depositWithCheck(assetsIn, user.address, ethers.ZeroAddress, minShares)
    ).to.be.revertedWithCustomError(vault, "SlippageTooHigh");
  });

  /* ------------------------------------------------------------------
   * mintWithCheck
   * ------------------------------------------------------------------ */

  it("mintWithCheck: succeeds when maxAssets >= previewMint", async () => {
    const { vault, oracle, reporter, user } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    const sharesToMint = 100_000_000n; // 100 shares
    const previewAssets = await vault.previewMint(sharesToMint);

    const tx = await vault
      .connect(user)
      .mintWithCheck(
        sharesToMint,
        user.address,
        ethers.ZeroAddress,
        previewAssets
      );
    await tx.wait();

    const shareBal = await vault.balanceOf(user.address);
    expect(shareBal).to.equal(sharesToMint);
  });

  it("mintWithCheck: reverts with SlippageTooHigh when maxAssets < previewMint", async () => {
    const { vault, oracle, reporter, user } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    const sharesToMint = 100_000_000n;
    const previewAssets = await vault.previewMint(sharesToMint);
    const maxAssets = previewAssets - 1n;

    await expect(
      vault
        .connect(user)
        .mintWithCheck(
          sharesToMint,
          user.address,
          ethers.ZeroAddress,
          maxAssets
        )
    ).to.be.revertedWithCustomError(vault, "SlippageTooHigh");
  });

  /* ------------------------------------------------------------------
   * helper: seed a plain ERC-4626 deposit
   * ------------------------------------------------------------------ */

  async function seedDeposit(
    vault: any,
    user: any,
    usdc: any,
    amount: bigint
  ) {
    // deposit(uint256,address)
    const tx = await vault
      .connect(user)
      ["deposit(uint256,address)"](amount, user.address);
    await tx.wait();
  }

  /* ------------------------------------------------------------------
   * withdrawWithCheck
   * ------------------------------------------------------------------ */

  it("withdrawWithCheck: succeeds when maxShares >= previewWithdraw", async () => {
    const { vault, oracle, reporter, user, usdc } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    // user deposits 500 USDC
    await seedDeposit(vault, user, usdc, 500_000_000n);

    const withdrawAssets = 200_000_000n; // 200 USDC
    const previewShares = await vault.previewWithdraw(withdrawAssets);
    const maxShares = previewShares;

    const prevShares = await vault.balanceOf(user.address);
    const prevUsdc = await usdc.balanceOf(user.address);

    const tx = await vault
      .connect(user)
      .withdrawWithCheck(withdrawAssets, user.address, user.address, maxShares);
    await tx.wait();

    const newShares = await vault.balanceOf(user.address);
    const newUsdc = await usdc.balanceOf(user.address);

    expect(prevShares - newShares).to.equal(previewShares);
    expect(newUsdc - prevUsdc).to.equal(withdrawAssets);
  });

  it("withdrawWithCheck: reverts with SlippageTooHigh when maxShares < previewWithdraw", async () => {
    const { vault, oracle, reporter, user, usdc } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    await seedDeposit(vault, user, usdc, 500_000_000n);

    const withdrawAssets = 200_000_000n;
    const previewShares = await vault.previewWithdraw(withdrawAssets);
    const maxShares = previewShares - 1n;

    await expect(
      vault
        .connect(user)
        .withdrawWithCheck(
          withdrawAssets,
          user.address,
          user.address,
          maxShares
        )
    ).to.be.revertedWithCustomError(vault, "SlippageTooHigh");
  });

  /* ------------------------------------------------------------------
   * redeemWithCheck
   * ------------------------------------------------------------------ */

  it("redeemWithCheck: succeeds when minAssets <= previewRedeem", async () => {
    const { vault, oracle, reporter, user, usdc } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    await seedDeposit(vault, user, usdc, 500_000_000n); // 500 USDC
    const totalShares = await vault.balanceOf(user.address);
    const redeemShares = totalShares / 2n;

    const previewAssets = await vault.previewRedeem(redeemShares);
    const minAssets = previewAssets;

    const prevShares = await vault.balanceOf(user.address);
    const prevUsdc = await usdc.balanceOf(user.address);

    const tx = await vault
      .connect(user)
      .redeemWithCheck(redeemShares, user.address, user.address, minAssets);
    await tx.wait();

    const newShares = await vault.balanceOf(user.address);
    const newUsdc = await usdc.balanceOf(user.address);

    expect(prevShares - newShares).to.equal(redeemShares);
    expect(newUsdc - prevUsdc).to.equal(previewAssets);
  });

  it("redeemWithCheck: reverts with SlippageTooHigh when minAssets > previewRedeem", async () => {
    const { vault, oracle, reporter, user, usdc } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    await seedDeposit(vault, user, usdc, 500_000_000n);
    const totalShares = await vault.balanceOf(user.address);
    const redeemShares = totalShares / 2n;

    const previewAssets = await vault.previewRedeem(redeemShares);
    const minAssets = previewAssets + 1n;

    await expect(
      vault
        .connect(user)
        .redeemWithCheck(redeemShares, user.address, user.address, minAssets)
    ).to.be.revertedWithCustomError(vault, "SlippageTooHigh");
  });
});
