import { ethers } from 'ethers';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === CONFIGURATION ===
const NETWORKS = {
  sepolia: {
    name: 'Sepolia',
    chainId: 11155111,
    rpcUrl: process.env.SEPOLIA_RPC_URL || 'https://sepolia.infura.io/v3/' + (process.env.INFURA_PROJECT_ID || ''),
    explorer: 'https://sepolia.etherscan.io',
    gasPrice: 1000000000,
    maxPriorityFee: 1500000000,
  },
  localhost: {
    name: 'Localhost',
    chainId: 31337,
    rpcUrl: 'http://localhost:8545',
    explorer: null,
    gasPrice: 1000000000,
    maxPriorityFee: 1000000000,
  }
};

const DEPLOYMENT_FILE = join(__dirname, '..', 'deployment.json');
const ARTIFACT_DIR = join(__dirname, '..', 'artifacts', 'contracts');
const SWARMVAULT_ARTIFACT = 'SwarmVault.json';

// === UTILITY FUNCTIONS ===
function loadArtifact(contractName) {
  const artifactPath = join(ARTIFACT_DIR, contractName);
  if (!existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath}. Run 'npm run build' first.`);
  }
  return JSON.parse(readFileSync(artifactPath, 'utf-8'));
}

function updateEnvFile(key, value) {
  const envPath = join(__dirname, '..', '.env');
  let envContent = '';
  
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, 'utf-8');
  }
  
  const lines = envContent.split('\n');
  const updatedLines = [];
  let found = false;
  
  for (const line of lines) {
    if (line.startsWith(key + '=')) {
      updatedLines.push(`${key}=${value}`);
      found = true;
    } else {
      updatedLines.push(line);
    }
  }
  
  if (!found) {
    updatedLines.push(`${key}=${value}`);
  }
  
  writeFileSync(envPath, updatedLines.join('\n'), 'utf-8');
}

function saveDeployment(network, contractAddress, deployer, txHash, timestamp) {
  const deploymentData = {
    network: network.name,
    chainId: network.chainId,
    contractAddress,
    deployer,
    txHash,
    timestamp,
    explorerUrl: network.explorer ? `${network.explorer}/address/${contractAddress}` : null
  };
  
  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deploymentData, null, 2), 'utf-8');
  console.log(`\n✅ Deployment saved to ${DEPLOYMENT_FILE}`);
  return deploymentData;
}

function loadExistingDeployment() {
  if (!existsSync(DEPLOYMENT_FILE)) {
    return null;
  }
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf-8'));
}

// === DEPLOYMENT LOGIC ===
async function deployContract(networkName = 'sepolia') {
  const network = NETWORKS[networkName];
  if (!network) {
    throw new Error(`Unknown network: ${networkName}`);
  }

  console.log(`\n🚀 Deploying SwarmVault to ${network.name}...`);
  console.log(`Chain ID: ${network.chainId}`);
  console.log(`RPC: ${network.rpcUrl}`);

  // Load provider and signer
  const provider = new ethers.JsonRpcProvider(network.rpcUrl);
  const privateKey = process.env.PRIVATE_KEY;
  
  if (!privateKey) {
    throw new Error('PRIVATE_KEY environment variable not set. Set it in .env file.');
  }

  const signer = new ethers.Wallet(privateKey, provider);
  const deployerAddress = await signer.getAddress();
  
  console.log(`\n👤 Deployer: ${deployerAddress}`);
  
  // Check balance
  const balance = await provider.getBalance(deployerAddress);
  const balanceEth = ethers.formatEther(balance);
  console.log(`💰 Balance: ${balanceEth} ${network.name} ETH`);
  
  if (parseFloat(balanceEth) < 0.01) {
    console.warn(`⚠️ Warning: Low balance. You may need Sepolia testnet ETH from: https://sepoliafaucet.com/`);
  }

  // Load artifact
  console.log('\n📦 Loading SwarmVault artifact...');
  const artifact = loadArtifact(SWARMVAULT_ARTIFACT);
  console.log(`   ABI entries: ${artifact.abi.length}`);
  console.log(`   Bytecode size: ${(artifact.bytecode.length / 2).toLocaleString()} bytes`);

  // Check if already deployed
  const existingDeployment = loadExistingDeployment();
  if (existingDeployment && existingDeployment.network === network.name) {
    console.log(`\n⚠️ Contract already deployed on ${network.name}: ${existingDeployment.contractAddress}`);
    console.log(`   Explorer: ${existingDeployment.explorerUrl}`);
    return existingDeployment;
  }

  // Deploy contract
  console.log('\n🔨 Deploying SwarmVault contract...');
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  
  const startTime = Date.now();
  const tx = await factory.deploy();
  console.log(`   Transaction sent: ${tx.hash}`);

  // Wait for confirmation
  console.log('   ⏳ Waiting for confirmation...');
  const receipt = await tx.wait();
  const endTime = Date.now();
  const gasUsed = receipt.gasUsed;
  const gasPrice = receipt.effectiveGasPrice;
  const totalGasCost = gasUsed * gasPrice;
  const totalGasCostEth = ethers.formatEther(totalGasCost);

  const contractAddress = await tx.getAddress();
  console.log(`\n✅ Contract deployed successfully!`);
  console.log(`   Address: ${contractAddress}`);
  console.log(`   Block: ${receipt.blockNumber}`);
  console.log(`   Gas Used: ${gasUsed.toLocaleString()}`);
  console.log(`   Gas Cost: ${totalGasCostEth} ETH`);
  console.log(`   Time: ${((endTime - startTime) / 1000).toFixed(2)}s`);

  // Save deployment
  const deploymentData = saveDeployment(
    network,
    contractAddress,
    deployerAddress,
    receipt.hash,
    new Date().toISOString()
  );

  // Update environment variables
  updateEnvFile('SWARMVAULT_ADDRESS', contractAddress);
  updateEnvFile('SWARMVAULT_CHAIN_ID', network.chainId.toString());
  updateEnvFile('SWARMVAULT_RPC_URL', network.rpcUrl);
  
  console.log('\n📝 Environment variables updated:');
  console.log(`   SWARMVAULT_ADDRESS=${contractAddress}`);
  console.log(`   SWARMVAULT_CHAIN_ID=${network.chainId}`);
  console.log(`   SWARMVAULT_RPC_URL=${network.rpcUrl}`);

  // Verify on explorer if available
  if (network.explorer) {
    console.log(`\n🔍 Explorer URL: ${deploymentData.explorerUrl}`);
    console.log(`   (Verification may take a few minutes)`);
  }

  return deploymentData;
}

// === CONFIGURATION FUNCTIONS ===
async function configureAgents(deploymentData) {
  console.log('\n⚙️  Configuring agents with deployment data...');
  
  const agentConfig = {
    swarmVaultAddress: deploymentData.contractAddress,
    chainId: deploymentData.chainId,
    rpcUrl: deploymentData.rpcUrl,
    deployerAddress: deploymentData.deployer,
    deploymentTxHash: deploymentData.txHash
  };

  const configPath = join(__dirname, '..', 'agent-config.json');
  writeFileSync(configPath, JSON.stringify(agentConfig, null, 2), 'utf-8');
  
  console.log(`   Agent configuration saved to ${configPath}`);
  return agentConfig;
}

async function verifyDeployment(deploymentData) {
  console.log('\n🔍 Verifying deployment...');
  
  const provider = new ethers.JsonRpcProvider(deploymentData.rpcUrl);
  const contract = new ethers.Contract(deploymentData.contractAddress, loadArtifact(SWARMVAULT_ARTIFACT).abi, provider);
  
  try {
    const owner = await contract.owner();
    const agentCount = await contract.agentCount();
    const minQuorum = await contract.MIN_QUORUM();
    
    console.log(`   Contract Owner: ${owner}`);
    console.log(`   Registered Agents: ${agentCount}`);
    console.log(`   Minimum Quorum: ${minQuorum}`);
    console.log(`   ✅ Contract is functional`);
    
    return true;
  } catch (error) {
    console.error(`   ❌ Verification failed: ${error.message}`);
    return false;
  }
}

// === MAIN EXECUTION ===
async function main() {
  try {
    const network = process.argv[2] || 'sepolia';
    
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         SWARMLock Deployment Protocol v1.0                ║');
    console.log('║         State-Weighted Agent Consensus                    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    
    // Deploy contract
    const deploymentData = await deployContract(network);
    
    // Configure agents
    await configureAgents(deploymentData);
    
    // Verify deployment
    const verified = await verifyDeployment(deploymentData);
    
    if (verified) {
      console.log('\n╔═══════════════════════════════════════════════════════════╗');
      console.log('║              DEPLOYMENT COMPLETE ✅                        ║');
      console.log('╚═══════════════════════════════════════════════════════════╝');
      console.log(`\n📊 Summary:`);
      console.log(`   Network: ${deploymentData.network}`);
      console.log(`   Chain ID: ${deploymentData.chainId}`);
      console.log(`   Contract: ${deploymentData.contractAddress}`);
      console.log(`   Deployer: ${deploymentData.deployer}`);
      console.log(`   Explorer: ${deploymentData.explorerUrl}`);
      console.log(`\n🚀 Next steps:`);
      console.log(`   1. Fund agents with testnet ETH`);
      console.log(`   2. Run 'npm run agent' to start agent nodes`);
      console.log(`   3. Visit dashboard at http://localhost:3000`);
      console.log(`   4. Register agents with 'npm run register-agent'`);
    }
    
  } catch (error) {
    console.error('\n❌ Deployment failed:');
    console.error(`   ${error.message}`);
    console.error(`\n💡 Troubleshooting:`);
    console.error(`   1. Check PRIVATE_KEY is set in .env`);
    console.error(`   2. Ensure you have Sepolia testnet ETH`);
    console.error(`   3. Verify RPC URL is accessible`);
    console.error(`   4. Run 'npm run build' to compile contracts`);
    process.exit(1);
  }
}

// Export for programmatic use
export { deployContract, configureAgents, verifyDeployment, loadArtifact, updateEnvFile };

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}