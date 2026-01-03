import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const Token = await ethers.getContractFactory("TestERC20");
  const usdc = await Token.deploy("Mock USDC", "USDC", 6);
  await usdc.waitForDeployment();

  const Oracle = await ethers.getContractFactory("NavOracle");
  const oracle = await Oracle.deploy(deployer.address, deployer.address, deployer.address, 3600, 100);
  await oracle.waitForDeployment();

  const Vault = await ethers.getContractFactory("NavVault");
  const vault = await Vault.deploy(usdc.target, "NAV Vault", "NAV", oracle.target, deployer.address, deployer.address, deployer.address, 300, 86400);
  await vault.waitForDeployment();

  console.log("USDC:", usdc.target);
  console.log("Oracle:", oracle.target);
  console.log("Vault:", vault.target);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
