import { expect } from "chai";
import { ethers } from "hardhat";

/* -------------------------------- Helpers -------------------------------- */

const e18 = (n: string) => ethers.parseUnits(n, 18);
const nowTs = async () => (await ethers.provider.getBlock("latest"))!.timestamp;

async function deployOracle(maxBps: number, stalenessSecs = 3600) {
  const [admin, reporter, guardian] = await ethers.getSigners();
  const Oracle = await ethers.getContractFactory("NavOracle");
  const oracle = await Oracle.deploy(
    admin.address,
    reporter.address,
    guardian.address,
    stalenessSecs,
    maxBps
  );
  await oracle.waitForDeployment();
  return { oracle, admin, reporter, guardian };
}

async function report(oracle: any, reporter: any, ppsWei: bigint, tsOffsetSec = 1) {
  const ts = (await nowTs()) + tsOffsetSec;
  return oracle.connect(reporter).reportNav(ppsWei, ts);
}

/** Integer boundary: floor(prev * bps / 10000) */
function deltaFor(prev: bigint, bps: bigint) {
  return (prev * bps) / 10000n;
}

/**
 * NOTE: Oracle reverts if: diff * 10000 > prev * maxBps
 *  - Equality at the boundary is allowed.
 *  - Make the “just over” jump in a single step from the *current* prev.
 */

/* --------------------------------- Tests --------------------------------- */

describe("NavOracle (NAV-only)", function () {
  it("deploys and sets roles, config", async () => {
    const [admin, reporter, guardian, other] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("NavOracle");
    const oracle = await Oracle.deploy(admin.address, reporter.address, guardian.address, 3600, 0);
    await oracle.waitForDeployment();

    // isValid true when not paused
    expect(await oracle.isValid()).to.equal(true);
    expect(await oracle.maxOracleStaleness()).to.equal(3600n);

    // non-reporter cannot report
    await expect(
      oracle.connect(other).reportNav(1n, (await ethers.provider.getBlock("latest"))!.timestamp + 1)
    ).to.be.revertedWithCustomError(oracle, "AccessControlUnauthorizedAccount");

    // reporter can report
    const ts = (await ethers.provider.getBlock("latest"))!.timestamp + 10;
    await expect(oracle.connect(reporter).reportNav(ethers.parseEther("1"), ts)).to.emit(oracle, "NavReported");

    const [pps, last] = await oracle.pricePerShare();
    expect(pps).to.equal(ethers.parseEther("1"));
    expect(last).to.equal(BigInt(ts));
  });

  it("pausing invalidates oracle & blocks report", async () => {
    const [admin, reporter, guardian] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("NavOracle");
    const oracle = await Oracle.deploy(admin.address, reporter.address, guardian.address, 3600, 0);
    await oracle.waitForDeployment();

    await expect(oracle.connect(guardian).pause()).to.emit(oracle, "OraclePaused");
    expect(await oracle.isValid()).to.equal(false);
    await expect(
      oracle.connect(reporter).reportNav(ethers.parseEther("1"), (await ethers.provider.getBlock("latest"))!.timestamp + 1)
    ).to.be.revertedWithCustomError(oracle, "EnforcedPause");
    await expect(oracle.connect(guardian).unpause()).to.emit(oracle, "OracleUnpaused");
  });

  it("staleness and zero checks", async () => {
    const [admin, reporter, guardian] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("NavOracle");
    const oracle = await Oracle.deploy(admin.address, reporter.address, guardian.address, 10, 0);
    await oracle.waitForDeployment();

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await expect(oracle.connect(reporter).reportNav(0, now)).to.be.revertedWithCustomError(oracle, "ZeroValue");
    await expect(oracle.connect(reporter).reportNav(1, 0)).to.be.revertedWithCustomError(oracle, "ZeroValue");
    await expect(oracle.connect(reporter).reportNav(1, now - 11)).to.be.revertedWithCustomError(oracle, "StaleTimestamp");
  });

  /* ------------------- Fixed boundary / jump tests (strict) ------------------- */

  it("maxPpsMoveBps sanity guard: +boundary allowed; +boundary+1 wei reverts", async () => {
    const { oracle, reporter } = await deployOracle(100); // 1%
    const base = e18("100");
    await report(oracle, reporter, base); // prev = 100e18

    const bps = 100n; // 1%
    const delta = deltaFor(base, bps); // 1e18
    const allowed = base + delta; // 101e18
    const tooHigh = allowed + 1n; // base + delta + 1 wei (still compared vs prev=100e18)

    // exact boundary allowed (100 -> 101)
    await expect(report(oracle, reporter, allowed)).to.emit(oracle, "NavReported");

    // For the "just over" case, we must reset prev to base again (fresh oracle),
    // otherwise prev would be 101e18 and +1 wei would be tiny.
    const { oracle: oracle2, reporter: reporter2 } = await deployOracle(100);
    await report(oracle2, reporter2, base); // prev = 100e18
    await expect(report(oracle2, reporter2, tooHigh)).to.be.revertedWithCustomError(oracle2, "TooLargeMove");
  });

  it("downward boundary: -boundary allowed; -(boundary+1 wei) reverts", async () => {
    const { oracle, reporter } = await deployOracle(100); // 1%
    const base = e18("100");
    await report(oracle, reporter, base); // prev = 100e18

    const bps = 100n; // 1%
    const delta = deltaFor(base, bps); // 1e18
    const allowedDown = base - delta; // 99e18
    const tooLow = allowedDown - 1n;  // base - delta - 1 wei

    // exact boundary allowed (100 -> 99)
    await expect(report(oracle, reporter, allowedDown)).to.emit(oracle, "NavReported");

    // Fresh oracle to make a direct over-boundary move from the same base
    const { oracle: oracle2, reporter: reporter2 } = await deployOracle(100);
    await report(oracle2, reporter2, base); // prev = 100e18
    await expect(report(oracle2, reporter2, tooLow)).to.be.revertedWithCustomError(oracle2, "TooLargeMove");
  });

  it("boundary equality holds for non-integer bps too (e.g., 0.37%) — upward", async () => {
    const { oracle, reporter } = await deployOracle(37); // 0.37%
    const base = e18("10000");
    await report(oracle, reporter, base); // prev = 10000e18

    const bps = 37n; // 0.37%
    const delta = deltaFor(base, bps); // 37e18 exactly (clean integer)
    const allowedUp = base + delta;    // 10037e18
    const tooHigh = allowedUp + 1n;    // base + delta + 1 wei

    // exact boundary allowed
    await expect(report(oracle, reporter, allowedUp)).to.emit(oracle, "NavReported");

    // Fresh oracle to compare “just over” directly from same base
    const { oracle: oracle2, reporter: reporter2 } = await deployOracle(37);
    await report(oracle2, reporter2, base); // prev = 10000e18
    await expect(report(oracle2, reporter2, tooHigh)).to.be.revertedWithCustomError(oracle2, "TooLargeMove");
  });

  it("first report is exempt from max move checks", async () => {
    const { oracle, reporter } = await deployOracle(100); // 1%
    await expect(report(oracle, reporter, e18("10000"))).to.emit(oracle, "NavReported");
  });

  it("multiple sequential moves within boundary are allowed (both directions)", async () => {
    const { oracle, reporter } = await deployOracle(100); // 1%
    await report(oracle, reporter, e18("100"));

    await expect(report(oracle, reporter, e18("100.5"))).to.emit(oracle, "NavReported"); // +0.5%
    await expect(report(oracle, reporter, e18("100.9"))).to.emit(oracle, "NavReported"); // ~+0.4%
    await expect(report(oracle, reporter, e18("100.1"))).to.emit(oracle, "NavReported"); // ~-0.8%
  });

  it("large jumps beyond boundary revert (up and down)", async () => {
    const { oracle, reporter } = await deployOracle(100); // 1%
    await report(oracle, reporter, e18("200"));

    await expect(report(oracle, reporter, e18("204"))).to.be.revertedWithCustomError(oracle, "TooLargeMove"); // ~+2%

    const { oracle: oracle2, reporter: reporter2 } = await deployOracle(100);
    await report(oracle2, reporter2, e18("150"));
    await expect(report(oracle2, reporter2, e18("147"))).to.be.revertedWithCustomError(oracle2, "TooLargeMove"); // ~-2%
  });

  it("changing config: setting maxPpsMoveBps to 0 disables guard", async () => {
    const { oracle, reporter, admin } = await deployOracle(100);
    await report(oracle, reporter, e18("100"));

    await expect(report(oracle, reporter, e18("105"))).to.be.revertedWithCustomError(oracle, "TooLargeMove");
    await expect(oracle.connect(admin).setConfig(3600, 0)).to.emit(oracle, "OracleConfigured");
    await expect(report(oracle, reporter, e18("105"))).to.emit(oracle, "NavReported");
    await expect(report(oracle, reporter, e18("250"))).to.emit(oracle, "NavReported");
  });
});
