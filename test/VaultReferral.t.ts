// test/VaultReferral.t.ts
import { expect } from "chai";
import { ethers } from "hardhat";

const ONE_E18 = ethers.parseEther("1");

const latestTs = async () =>
  (await ethers.provider.getBlock("latest"))!.timestamp;

describe("NavVault — Referral flows", function () {
  async function deployFixture() {
    const [
      admin,
      operator,
      guardian,
      reporter,
      user,
      referrerA,
      referrerB,
      attacker,
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

    await usdc.mint(user.address, 10_000_000_000); // 10,000 USDC
    await usdc.connect(user).approve(vault.target, 10_000_000_000);

    await usdc.mint(attacker.address, 10_000_000); // 10 USDC
    await usdc.connect(attacker).approve(vault.target, 10_000_000);

    return {
      admin,
      operator,
      guardian,
      reporter,
      user,
      referrerA,
      referrerB,
      attacker,
      usdc,
      oracle,
      vault,
    };
  }

  it("binds referrer on first DEPOSIT when receiver == msg.sender; emits ReferrerSet & ReferredDeposit", async () => {
    const { vault, oracle, reporter, user, referrerA } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    const tx = await vault
      .connect(user).depositWithCheck(200_000_000, user.address, referrerA.address, 200_000_000);
    const rc = await tx.wait();

    expect(await vault.referrerOf(user.address)).to.equal(referrerA.address);

    const refSet = rc!.logs.find((l: any) => l.fragment?.name === "ReferrerSet");
    expect(refSet?.args?.user).to.equal(user.address);
    expect(refSet?.args?.referrer).to.equal(referrerA.address);

    const refDep = rc!.logs.find((l: any) => l.fragment?.name === "ReferredDeposit");
    expect(refDep?.args?.payer).to.equal(user.address);
    expect(refDep?.args?.receiver).to.equal(user.address);
    expect(refDep?.args?.referrer).to.equal(referrerA.address);
    expect(refDep?.args?.assetsIn).to.equal(200_000_000n);
    expect(refDep?.args?.sharesOut).to.equal(200_000_000n);
  });

  it("binds referrer on first MINT when receiver == msg.sender; emits ReferrerSet & ReferredMint", async () => {
    const { vault, oracle, reporter, user, referrerA } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    const tx = await vault
      .connect(user).mintWithCheck(100_000_000, user.address, referrerA.address, 100_000_000);
    const rc = await tx.wait();

    expect(await vault.referrerOf(user.address)).to.equal(referrerA.address);

    const refSet = rc!.logs.find((l: any) => l.fragment?.name === "ReferrerSet");
    expect(refSet?.args?.user).to.equal(user.address);
    expect(refSet?.args?.referrer).to.equal(referrerA.address);

    const refMint = rc!.logs.find((l: any) => l.fragment?.name === "ReferredMint");
    expect(refMint?.args?.payer).to.equal(user.address);
    expect(refMint?.args?.receiver).to.equal(user.address);
    expect(refMint?.args?.referrer).to.equal(referrerA.address);
    expect(refMint?.args?.sharesOut).to.equal(100_000_000n);
    expect(refMint?.args?.assetsIn).to.equal(100_000_000n);
  });

  it("blocks third-party from binding for someone else on DEPOSIT (consent guard)", async () => {
    const { vault, oracle, reporter, attacker, user, referrerA } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    await expect(
      vault.connect(attacker).depositWithCheck(1_000_000, user.address, referrerA.address, 1_000_000)
    ).to.be.revertedWithCustomError(vault, "InvalidReferrer");

    expect(await vault.referrerOf(user.address)).to.equal(ethers.ZeroAddress);
  });

  it("blocks third-party from binding for someone else on MINT (consent guard)", async () => {
    const { vault, oracle, reporter, attacker, user, referrerA } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    await expect(
      vault.connect(attacker).mintWithCheck(1_000_000, user.address, referrerA.address, 1_000_000)
    ).to.be.revertedWithCustomError(vault, "InvalidReferrer");

    expect(await vault.referrerOf(user.address)).to.equal(ethers.ZeroAddress);
  });

  it("self-referral is rejected for both deposit and mint", async () => {
    const { vault, oracle, reporter, user } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    await expect(
      vault.connect(user).depositWithCheck(1_000_000, user.address, user.address, 1_000_000)
    ).to.be.revertedWithCustomError(vault, "InvalidReferrer");

    await expect(
      vault.connect(user).mintWithCheck(1_000_000, user.address, user.address, 1_000_000)
    ).to.be.revertedWithCustomError(vault, "InvalidReferrer");

    expect(await vault.referrerOf(user.address)).to.equal(ethers.ZeroAddress);
  });

  it("zero-address referrer is ignored (no bind, no revert); later valid bind works", async () => {
    const { vault, oracle, reporter, user, referrerA } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    await expect(
      vault.connect(user).depositWithCheck(1_000_000, user.address, ethers.ZeroAddress, 1_000_000)
    ).to.not.be.reverted;

    expect(await vault.referrerOf(user.address)).to.equal(ethers.ZeroAddress);

    await expect(
      vault.connect(user).depositWithCheck(1_000_000, user.address, referrerA.address, 1_000_000)
    ).to.emit(vault, "ReferrerSet");

    expect(await vault.referrerOf(user.address)).to.equal(referrerA.address);
  });

  it("referrer is immutable: subsequent attempts to change are ignored; events use original referrer", async () => {
    const { vault, oracle, reporter, user, referrerA, referrerB } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    // bind A
    await vault.connect(user).depositWithCheck(2_000_000, user.address, referrerA.address, 2_000_000);
    expect(await vault.referrerOf(user.address)).to.equal(referrerA.address);

    // try to change to B — mapping should remain A; event uses A
    const tx = await vault.connect(user).depositWithCheck(3_000_000, user.address, referrerB.address, 3_000_000);
    const rc = await tx.wait();

    expect(await vault.referrerOf(user.address)).to.equal(referrerA.address);

    const refDep = rc!.logs.find((l: any) => l.fragment?.name === "ReferredDeposit");
    expect(refDep?.args?.referrer).to.equal(referrerA.address);
  });

  it("mint emits ReferredMint using previously bound referrer even if referrer param is zero", async () => {
    const { vault, oracle, reporter, user, referrerA } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    await vault.connect(user).depositWithCheck(2_000_000, user.address, referrerA.address, 2_000_000);
    expect(await vault.referrerOf(user.address)).to.equal(referrerA.address);

    const tx = await vault.connect(user).mintWithCheck(1_500_000, user.address, ethers.ZeroAddress, 1_500_000);
    const rc = await tx.wait();

    const refMint = rc!.logs.find((l: any) => l.fragment?.name === "ReferredMint");
    expect(refMint?.args?.referrer).to.equal(referrerA.address);
    expect(refMint?.args?.receiver).to.equal(user.address);
  });

  it("legacy ERC-4626 paths (deposit/mint) do not bind nor emit referral events", async () => {
    const { vault, oracle, reporter, user, referrerA } = await deployFixture();

    const ts1 = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ONE_E18, ts1);

    // legacy deposit
    const tx1 = await vault.connect(user)
      ["deposit(uint256,address)"](500_000, user.address);
    const rc1 = await tx1.wait();
    expect(rc1!.logs.find((l: any) => l.fragment?.name === "ReferrerSet")).to.be.undefined;
    expect(rc1!.logs.find((l: any) => l.fragment?.name === "ReferredDeposit")).to.be.undefined;
    expect(await vault.referrerOf(user.address)).to.equal(ethers.ZeroAddress);

    // now bind via referral-aware deposit
    await vault.connect(user).depositWithCheck(500_000, user.address, referrerA.address, 500_000);
    expect(await vault.referrerOf(user.address)).to.equal(referrerA.address);

    // legacy mint
    const tx3 = await vault.connect(user)
      ["mint(uint256,address)"](250_000, user.address);
    const rc3 = await tx3.wait();
    expect(rc3!.logs.find((l: any) => l.fragment?.name === "ReferredMint")).to.be.undefined;
  });
});
