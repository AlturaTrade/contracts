import { expect } from "chai";
import { ethers, network } from "hardhat";

const ONE_E18 = ethers.parseEther("1");

const setNextTs = async (ts: number) => {
  await network.provider.send("evm_setNextBlockTimestamp", [ts]);
  await network.provider.send("evm_mine", []);
};

const latestTs = async () =>
  (await ethers.provider.getBlock("latest"))!.timestamp;

describe("NavVault (ERC4626 + claim-style)", function () {
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

  it("constructor guards and admin functions", async () => {
    const [admin, operator, guardian, reporter] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("TestERC20");
    const usdc = await Token.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();

    const Oracle = await ethers.getContractFactory("NavOracle");
    const oracle = await Oracle.deploy(
      admin.address,
      reporter.address,
      guardian.address,
      3600,
      0,
    );
    await oracle.waitForDeployment();

    const Vault = await ethers.getContractFactory("NavVault");

    // For constructor custom-error matching, pass the factory that DEFINES the error
    await expect(
      Vault.deploy(
        usdc.target,
        "NAV Vault",
        "NAV",
        ethers.ZeroAddress, // bad oracle -> BadAddress
        admin.address,
        operator.address,
        guardian.address,
        300,
        86_400,
      ),
    ).to.be.revertedWithCustomError(Vault, "BadAddress");

    const vault = await Vault.deploy(
      usdc.target,
      "NAV Vault",
      "NAV",
      oracle.target,
      admin.address,
      operator.address,
      guardian.address,
      300,
      86_400,
    );
    await vault.waitForDeployment();

    await expect(
      vault.connect(admin).setEpochSeconds(0),
    ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.connect(admin).setEpochSeconds(43_200))
      .to.emit(vault, "EpochSecondsUpdated")
      .withArgs(43_200);
  });

  it("PPS math with 6 decimals", async () => {
    const { usdc, oracle, reporter, vault } = await deployFixture();

    // 1.0 PPS -> 1 asset/share
    expect(await vault.convertToShares(1_000_000)).to.equal(1_000_000n);
    expect(await vault.convertToAssets(1_000_000)).to.equal(1_000_000n);

    // Update PPS to 1.5
    const ts = (await latestTs()) + 10;
    await oracle.connect(reporter).reportNav(ethers.parseEther("1.5"), ts);

    expect(await vault.convertToAssets(1_000_000)).to.equal(1_500_000n);
    expect(await vault.convertToShares(1_500_000)).to.equal(1_000_000n);
  });

  it("deposit, mint, withdraw, redeem update flow counters", async () => {
    const { user, usdc, vault } = await deployFixture();

    await usdc.connect(user).approve(vault.target, 1_000_000_000);

    await expect(
      vault.connect(user).deposit(100_000_000, user.address),
    ).to.emit(vault, "FlowCountersUpdated");

    await expect(vault.connect(user).mint(50_000_000, user.address)).to.emit(
      vault,
      "FlowCountersUpdated",
    );

    await expect(
      vault.connect(user).withdraw(25_000_000, user.address, user.address),
    ).to.emit(vault, "FlowCountersUpdated");

    await expect(
      vault.connect(user).redeem(10_000_000, user.address, user.address),
    ).to.emit(vault, "FlowCountersUpdated");
  });

  it("staleness and validity checks block operations (deterministic via reads)", async () => {
    const { vault, oracle, reporter, guardian, operator } =
      await deployFixture();

    // Tighten the vault window to 0s (any drift => stale)
    await vault.connect(operator).setMaxAllowedStaleness(1);

    // Post a fresh oracle update we control
    const baseTs = (await latestTs()) + 5;
    await oracle.connect(reporter).reportNav(ethers.parseEther("1"), baseTs);

    // Mine the next block at baseTs + 1 so it's strictly stale
    await ethers.provider.send("evm_setNextBlockTimestamp", [baseTs + 2]);
    await ethers.provider.send("evm_mine", []); // ensure block.timestamp = baseTs + 1

    // Pure READ path uses _readPps1e18 -> should deterministically revert OracleStale
    await expect(
      vault.convertToShares(1), // view call (no mining)
    ).to.be.revertedWithCustomError(vault, "OracleStale");

    // Refresh oracle (no longer stale)
    const freshTs = (await latestTs()) + 2;
    await oracle.connect(reporter).reportNav(ethers.parseEther("1"), freshTs);

    // Pause oracle -> validity fails (still via read path)
    await oracle.connect(guardian).pause();
    await expect(vault.convertToShares(1)).to.be.revertedWithCustomError(
      vault,
      "OracleInvalid",
    );
  });

  it("mint reverts with OracleStale when beyond window", async () => {
    const [admin, operator, guardian, reporter, user] =
      await ethers.getSigners();

    // fresh deploys
    const Token = await ethers.getContractFactory("TestERC20");
    const usdc = await Token.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();

    const Oracle = await ethers.getContractFactory("NavOracle");
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
      300, // start with a normal window
      86_400,
    );
    await vault.waitForDeployment();

    // fund + approve user
    await usdc.mint(user.address, 2_000_000_000n);
    await usdc.connect(user).approve(vault.target, 2_000_000_000n);

    vault.connect(user).mint(10_000_000, user.address);

    // tighten vault staleness to 0 so ANY drift is stale
    await vault.connect(operator).setMaxAllowedStaleness(1);

    // post a fresh oracle NAV at baseTs
    const baseTs = (await ethers.provider.getBlock("latest"))!.timestamp + 5;
    await oracle.connect(reporter).reportNav(ethers.parseEther("1"), baseTs);

    // next tx (mint) mines at baseTs+1 => block.timestamp > ts + 0
    await ethers.provider.send("evm_setNextBlockTimestamp", [baseTs + 2]);

    await expect(
      vault.connect(user).mint(10_000_000, user.address), // 10 shares at 1.0 PPS
    ).to.be.revertedWithCustomError(vault, "OracleStale");
  });

  it("mint reverts with OracleInvalid when oracle is paused but NOT stale", async () => {
    const [admin, operator, guardian, reporter, user] =
      await ethers.getSigners();

    // fresh deploys
    const Token = await ethers.getContractFactory("TestERC20");
    const usdc = await Token.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();

    const Oracle = await ethers.getContractFactory("NavOracle");
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
      300, // keep NON-zero so we can be "not stale"
      86_400,
    );
    await vault.waitForDeployment();

    // fund + approve user
    await usdc.mint(user.address, 2_000_000_000n);
    await usdc.connect(user).approve(vault.target, 2_000_000_000n);
    vault.connect(user).mint(10_000_000, user.address);

    // IMPORTANT: ensure the vault is NOT paused (guard against prior tests’ side-effects)
    try {
      await vault.connect(guardian).unpause();
    } catch {}

    // 1) fresh oracle timestamp we control
    const baseTs = (await ethers.provider.getBlock("latest"))!.timestamp + 5;
    await oracle.connect(reporter).reportNav(ethers.parseEther("1"), baseTs);

    // 2) move within the window (e.g., baseTs+1) and PAUSE THE ORACLE
    await ethers.provider.send("evm_setNextBlockTimestamp", [baseTs + 1]);
    await oracle.connect(guardian).pause(); // mines at baseTs+1 (still within 300s window)

    // 3) mine the mint at baseTs+2 (still ≪ 300s), so NOT stale, but oracle invalid
    await ethers.provider.send("evm_setNextBlockTimestamp", [baseTs + 2]);

    await expect(
      vault.connect(user).mint(10_000_000, user.address),
    ).to.be.revertedWithCustomError(vault, "OracleInvalid");
  });

  it("queue + claim withdrawal happy path", async () => {
    const { user, admin, operator, usdc, vault, oracle, reporter } =
      await deployFixture();

    // User deposits & approves vault to escrow shares
    await usdc.connect(user).approve(vault.target, 1_000_000_000);
    await vault.connect(user).deposit(200_000_000, user.address);
    await vault.connect(user).approve(vault.target, 200_000_000);

    // Queue withdrawal
    const tx = await vault
      .connect(user)
      .queueWithdrawal(200_000_000, user.address);
    const rc = await tx.wait();
    const ev = rc!.logs.find(
      (l: any) => l.fragment?.name === "WithdrawalQueued",
    );
    const id = ev?.args?.id;

    // Ensure ample liquidity: move out some, then fund more
    await vault.connect(admin).setLiquidityRecipient(operator.address);
    await vault.connect(operator).moveAssets(150_000_000);
    await usdc.connect(operator).approve(vault.target, 1_000_000_000);
    await vault.connect(operator).fundLiquidity(300_000_000);

    // Jump past epoch boundary
    const claimableAt = ev?.args?.claimableAt as bigint;
    await setNextTs(Number(claimableAt) + 1);

    // Refresh oracle so it isn't stale at claim time
    const ts2 = (await latestTs()) + 1;
    await oracle.connect(reporter).reportNav(ONE_E18, ts2);

    await expect(vault.connect(user).claimWithdrawal(id))
      .to.emit(vault, "WithdrawalClaimed")
      .withArgs(
        id,
        user.address,
        user.address,
        200_000_000n,
        200_000_000n,
        true,
      );
  });

  it("queue withdrawal: insufficient liquidity then revert", async () => {
    const { user, vault, usdc, admin, operator, oracle, reporter } =
      await deployFixture();

    await usdc.connect(user).approve(vault.target, 1_000_000_000);
    await vault.connect(user).deposit(100_000_000, user.address);
    await vault.connect(user).approve(vault.target, 100_000_000);

    const tx = await vault
      .connect(user)
      .queueWithdrawal(100_000_000, user.address);
    const rc = await tx.wait();
    const ev = rc!.logs.find(
      (l: any) => l.fragment?.name === "WithdrawalQueued",
    );
    const id = ev?.args?.id as bigint;
    const claimableAt = ev?.args?.claimableAt as bigint;

    // Drain all liquidity via AUTHORIZED operator
    const bal = await usdc.balanceOf(vault.target);
    await vault.connect(admin).setLiquidityRecipient(operator.address);
    await vault.connect(operator).moveAssets(bal);

    // Jump past epoch boundary
    await setNextTs(Number(claimableAt) + 1);

    // Refresh oracle so staleness doesn't mask the insufficiency revert
    const ts2 = (await latestTs()) + 1;
    await oracle.connect(reporter).reportNav(ONE_E18, ts2);

    await expect(
      vault.connect(user).claimWithdrawal(id),
    ).to.be.revertedWithCustomError(vault, "InsufficientLiquidity");
  });

  it("reverts mint and redeem when paused", async () => {
    const { admin, operator, guardian, reporter, user, usdc, oracle, vault } =
      await (async () => {
        const [a, op, g, rep, u] = await ethers.getSigners();

        // Local inline deploy to avoid interfering with other tests' state
        const Token = await ethers.getContractFactory("TestERC20");
        const usdcLocal = await Token.deploy("Mock USDC", "USDC", 6);
        await usdcLocal.waitForDeployment();

        const Oracle = await ethers.getContractFactory("NavOracle");
        const oracleLocal = await Oracle.deploy(
          a.address,
          rep.address,
          g.address,
          3600,
          0,
        );
        await oracleLocal.waitForDeployment();

        // Seed PPS = 1.0
        const ts0 = (await latestTs()) + 5;
        await oracleLocal.connect(rep).reportNav(ONE_E18, ts0);

        const Vault = await ethers.getContractFactory("NavVault");
        const vaultLocal = await Vault.deploy(
          usdcLocal.target,
          "NAV Vault",
          "NAV",
          oracleLocal.target,
          a.address,
          op.address,
          g.address,
          300,
          86_400,
        );
        await vaultLocal.waitForDeployment();

        // Seed user & approve
        await usdcLocal.mint(u.address, 1_000_000_000);
        await usdcLocal.connect(u).approve(vaultLocal.target, 1_000_000_000);

        // Refresh oracle so we are not stale
        const ts1 = (await latestTs()) + 10;
        await oracleLocal.connect(rep).reportNav(ONE_E18, ts1);

        // Get some shares before pausing (so redeem path can be tested)
        await vaultLocal.connect(u).deposit(200_000_000, u.address);

        // Pause the vault
        await vaultLocal.connect(g).pause();

        // Mint should revert due to pause
        await expect(
          vaultLocal.connect(u).mint(10_000_000, u.address),
        ).to.be.revertedWithCustomError(vaultLocal, "EnforcedPause");

        // Redeem should also revert due to pause
        await expect(
          vaultLocal.connect(u).redeem(50_000_000, u.address, u.address),
        ).to.be.revertedWithCustomError(vaultLocal, "EnforcedPause");

        return {
          admin: a,
          operator: op,
          guardian: g,
          reporter: rep,
          user: u,
          usdc: usdcLocal,
          oracle: oracleLocal,
          vault: vaultLocal,
        };
      })();

    // (No extra assertions needed; main checks are above)
  });

  it("shares & assets calculations track PPS and 6-decimals accurately", async () => {
    const { usdc, oracle, reporter, vault, user } = await (async () => {
      const [admin, operator, guardian, rep, u] = await ethers.getSigners();

      const Token = await ethers.getContractFactory("TestERC20");
      const usdcLocal = await Token.deploy("Mock USDC", "USDC", 6);
      await usdcLocal.waitForDeployment();

      const Oracle = await ethers.getContractFactory("NavOracle");
      const oracleLocal = await Oracle.deploy(
        admin.address,
        rep.address,
        guardian.address,
        3600,
        0,
      );
      await oracleLocal.waitForDeployment();

      // PPS = 1.0
      const ts0 = (await latestTs()) + 5;
      await oracleLocal.connect(rep).reportNav(ONE_E18, ts0);

      const Vault = await ethers.getContractFactory("NavVault");
      const vaultLocal = await Vault.deploy(
        usdcLocal.target,
        "NAV Vault",
        "NAV",
        oracleLocal.target,
        admin.address,
        operator.address,
        guardian.address,
        300,
        86_400,
      );
      await vaultLocal.waitForDeployment();

      // Seed user
      await usdcLocal.mint(u.address, 10_000_000_000); // 10,000 USDC
      await usdcLocal.connect(u).approve(vaultLocal.target, 10_000_000_000);

      return {
        usdc: usdcLocal,
        oracle: oracleLocal,
        reporter: rep,
        vault: vaultLocal,
        user: u,
      };
    })();

    // --- PPS = 1.0 ---
    // 1 USDC == 1 share at 6 decimals → 1_000_000
    expect(await vault.convertToShares(1_000_000)).to.equal(1_000_000n);
    expect(await vault.convertToAssets(1_000_000)).to.equal(1_000_000n);

    // Deposit 100 USDC → mint ~100 shares; totalAssets == 100 USDC
    await vault.connect(user).deposit(100_000_000, user.address); // 100 USDC
    const supply1 = await vault.totalSupply();
    expect(supply1).to.equal(100_000_000n);
    expect(await vault.totalAssets()).to.equal(100_000_000n);

    // --- Raise PPS to 1.5 ---
    {
      const ts = (await latestTs()) + 10;
      await oracle.connect(reporter).reportNav(ethers.parseEther("1.5"), ts);
    }

    // Now 1 share -> 1.5 USDC, and 1.5 USDC -> 1 share
    expect(await vault.convertToAssets(1_000_000)).to.equal(1_500_000n); // 1 share -> 1.5 USDC
    expect(await vault.convertToShares(1_500_000)).to.equal(1_000_000n); // 1.5 USDC -> 1 share

    // totalAssets should scale with PPS: supply * pps / 10^decimals
    // supply = 100_000_000 shares; pps(6-dec) = 1.5e6; scale = 1e6
    // totalAssets = 100_000_000 * 1_500_000 / 1_000_000 = 150_000_000 (150 USDC)
    expect(await vault.totalAssets()).to.equal(150_000_000n);

    // --- Raise PPS to 2.0 and check again ---
    {
      const ts = (await latestTs()) + 10;
      await oracle.connect(reporter).reportNav(ethers.parseEther("2.0"), ts);
    }
    // 1 share -> 2 USDC; 2 USDC -> 1 share
    expect(await vault.convertToAssets(1_000_000)).to.equal(2_000_000n);
    expect(await vault.convertToShares(2_000_000)).to.equal(1_000_000n);

    // totalAssets = 100_000_000 * 2_000_000 / 1_000_000 = 200_000_000 (200 USDC)
    expect(await vault.totalAssets()).to.equal(200_000_000n);

    // --- Round-trip sanity on a bigger number at PPS=2.0 ---
    // 250 USDC -> shares -> assets: expect 250 USDC back
    const assetsIn = 250_000_000n;
    const sharesOut = await vault.convertToShares(assetsIn);
    const assetsBack = await vault.convertToAssets(sharesOut);
    expect(assetsBack).to.equal(assetsIn);
  });

  it("role-gated functions enforced", async () => {
    const { other, vault } = await deployFixture();
    await expect(vault.connect(other).unpause()).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount",
    );
    await expect(
      vault.connect(other).setMaxAllowedStaleness(10),
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    await expect(
      vault.connect(other).moveAssets(1),
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
  });

  it("rescueToken cannot rescue primary asset", async () => {
    const { admin, vault, usdc } = await deployFixture();
    await expect(
      vault.connect(admin).rescueToken(usdc.target, admin.address, 1),
    ).to.be.reverted;
  });
});
