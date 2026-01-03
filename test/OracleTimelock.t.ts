// test/Oracle.t.ts

import { expect } from "chai";
import { ethers, network } from "hardhat";

const ONE_E18 = ethers.parseEther("1");
const ORACLE_TIMELOCK = 86_400; // must match ORACLE_TIMELOCK in NavVault

const setNextTs = async (ts: number) => {
  await network.provider.send("evm_setNextBlockTimestamp", [ts]);
  await network.provider.send("evm_mine", []);
};

const latestTs = async () =>
  (await ethers.provider.getBlock("latest"))!.timestamp;

// Local fixture for NavVault + NavOracle + TestERC20 (same pattern as NavVault.t.ts)
async function deployFixture() {
  const [admin, operator, guardian, reporter, user, other] =
    await ethers.getSigners();

  const Token = await ethers.getContractFactory("TestERC20");
  const usdc = await Token.deploy("Mock USDC", "USDC", 6);
  await usdc.waitForDeployment();

  const Oracle = await ethers.getContractFactory("NavOracle");
  // oracle staleness cap 3600s; we'll enforce vault staleness = 300s in vault
  const oracle = await Oracle.deploy(
    admin.address,
    reporter.address,
    guardian.address,
    3600,
    0,
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
    300, // initialMaxAllowedStaleness (vault)
    86_400, // epochSeconds (daily)
  );
  await vault.waitForDeployment();

  // seed balances
  await usdc.mint(user.address, 1_000_000_000); // 1,000 USDC (6 decimals)
  await usdc.mint(operator.address, 1_000_000_000); // operator liquidity

  // first PPS = 1.0
  const ts0 = (await latestTs()) + 5;
  await oracle.connect(reporter).reportNav(ONE_E18, ts0);

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

// Helper: deploy a second oracle instance to switch to
async function deploySecondOracle(
  admin: any,
  reporter: any,
  guardian: any,
) {
  const Oracle = await ethers.getContractFactory("NavOracle");
  const oracle2 = await Oracle.deploy(
    admin.address,
    reporter.address,
    guardian.address,
    3600,
    0,
  );
  await oracle2.waitForDeployment();

  // seed initial PPS for new oracle too (not strictly required, but nice sanity)
  const ts = (await latestTs()) + 5;
  await oracle2.connect(reporter).reportNav(ONE_E18, ts);

  return oracle2;
}

describe("NavVault - Oracle update timelock", function () {
  it("admin can queue oracle update", async () => {
    const { admin, oracle, guardian, reporter, vault } = await deployFixture();
    const oracle2 = await deploySecondOracle(admin, reporter, guardian);

    const newOracleAddr = oracle2.target;

    const tx = await vault.connect(admin).queueOracleUpdate(newOracleAddr);
    const rc = await tx.wait();

    const ev = rc!.logs.find(
      (l: any) => l.fragment?.name === "OracleChangeQueued",
    );
    expect(ev).to.not.be.undefined;
    expect(ev?.args?.newOracle).to.equal(newOracleAddr);

    // pendingOracle and timestamp should be set
    expect(await vault.pendingOracle()).to.equal(newOracleAddr);
    const queuedAt = await vault.pendingOracleSetAt();
    expect(queuedAt).to.be.gt(0n);
  });

  it("queueOracleUpdate reverts for non-admin", async () => {
    const { user, oracle, guardian, reporter, vault, admin } =
      await deployFixture();
    const oracle2 = await deploySecondOracle(admin, reporter, guardian);

    await expect(
      vault.connect(user).queueOracleUpdate(oracle2.target),
    ).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("queueOracleUpdate reverts with zero address", async () => {
    const { admin, vault } = await deployFixture();

    await expect(
      vault.connect(admin).queueOracleUpdate(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(vault, "BadAddress");
  });

  it("executeOracleUpdate reverts if nothing queued", async () => {
    const { admin, vault } = await deployFixture();

    await expect(
      vault.connect(admin).executeOracleUpdate(),
    ).to.be.revertedWithCustomError(vault, "BadAddress"); // pendingOracle == 0
  });

  it("executeOracleUpdate reverts before timelock has passed", async () => {
    const { admin, oracle, guardian, reporter, vault } = await deployFixture();
    const oracle2 = await deploySecondOracle(admin, reporter, guardian);

    const newOracleAddr = oracle2.target;

    // Queue the update
    await vault.connect(admin).queueOracleUpdate(newOracleAddr);

    // Get when it was queued
    const queuedAt = Number(await vault.pendingOracleSetAt());

    // Jump to just before timelock expiry
    await setNextTs(queuedAt + ORACLE_TIMELOCK - 2);

    await expect(
      vault.connect(admin).executeOracleUpdate(),
    ).to.be.revertedWith("Oracle update timelocked");
  });

  it("executeOracleUpdate after timelock updates oracle and clears pending", async () => {
    const { admin, oracle, guardian, reporter, vault } = await deployFixture();
    const oracle2 = await deploySecondOracle(admin, reporter, guardian);

    const oldOracleAddr = oracle.target;
    const newOracleAddr = oracle2.target;

    // Queue the update
    await vault.connect(admin).queueOracleUpdate(newOracleAddr);

    // Read queued timestamp
    const queuedAt = Number(await vault.pendingOracleSetAt());

    // Jump past timelock
    await setNextTs(queuedAt + ORACLE_TIMELOCK + 1);

    const tx = await vault.connect(admin).executeOracleUpdate();
    const rc = await tx.wait();

    const ev = rc!.logs.find(
      (l: any) => l.fragment?.name === "OracleChanged",
    );
    expect(ev).to.not.be.undefined;
    expect(ev?.args?.oldOracle).to.equal(oldOracleAddr);
    expect(ev?.args?.newOracle).to.equal(newOracleAddr);

    // navOracle is now the new oracle
    expect(await vault.navOracle()).to.equal(newOracleAddr);

    // pending state is cleared
    expect(await vault.pendingOracle()).to.equal(ethers.ZeroAddress);
    expect(await vault.pendingOracleSetAt()).to.equal(0n);
  });

  it("executeOracleUpdate is restricted to admin", async () => {
    const { admin, oracle, guardian, reporter, vault, user } =
      await deployFixture();
    const oracle2 = await deploySecondOracle(admin, reporter, guardian);

    await vault.connect(admin).queueOracleUpdate(oracle2.target);

    const queuedAt = Number(await vault.pendingOracleSetAt());
    await setNextTs(queuedAt + ORACLE_TIMELOCK + 1);

    await expect(
      vault.connect(user).executeOracleUpdate(),
    ).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount",
    );
  });
});
