# 🦠 SwarmLock: State-Weighted Agent Consensus

> **Secure multi-agent DeFi execution via dynamic, state-weighted consensus rather than static multi-signature keys.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8+-blue.svg)](https://docs.soliditylang.org/)
[![AutoGen](https://img.shields.io/badge/AutoGen-Forked-orange.svg)](https://microsoft.github.io/autogen/)
[![Hackathon](https://img.shields.io/badge/Hackathon-Microsoft%20AI%20Agents-red.svg)](https://www.microsoft.com/en-us/research/project/autogen/)

## 🚀 Overview

**SwarmLock** introduces a State-Weighted Agent Consensus Protocol where autonomous agents must collectively authorize high-value actions. Unlike traditional multi-sig wallets using static keys, agents vote based on their current on-chain capability score. The system uses Node.js for agent orchestration (forked from AutoGen), Solidity for the consensus vault, and HTML/JS for the dashboard.

This architecture prevents rogue AI execution by requiring a quorum of healthy, authorized agents to agree on the intent. It ensures that autonomous trading or governance actions are never executed by a single compromised agent, introducing a critical safety layer for multi-agent DeFi systems.

## 🛑 Problem

In the current landscape of autonomous AI agents and DeFi:
1.  **Static Vulnerability:** Traditional multi-signature wallets rely on static keys. If one key is compromised, the entire vault is at risk, regardless of the agent's current operational state.
2.  **Lack of Context:** Existing consensus mechanisms do not account for the real-time health, capability score, or permission state of the executing agent.
3.  **Single Point of Failure:** A single compromised agent can bypass static checks if the threshold is low, leading to potential fund loss or malicious execution.

## ✅ Solution

SwarmLock replaces static keys with **dynamic capability states**.
*   **State-Weighted Voting:** Agents generate state hashes reflecting their current operational health and permissions.
*   **Threshold Verification:** A smart contract verifies the hash threshold before broadcasting transactions.
*   **ECDSA Threshold Signatures:** We utilize ECDSA threshold signatures and on-chain state verification (avoiding Zero-Knowledge circuits to differentiate from recent builds).
*   **Real-Time Dashboard:** Visualizes agent voting power and consensus latency for human oversight.

## 🏗️ Architecture

```text
+----------------+       +---------------------+       +------------------+
|   AGENTS       |       |   ORCHESTRATION     |       |   SMART CONTRACT |
| (Node.js)      |       |   (AutoGen Fork)    |       |   (Solidity)     |
|                |       |                     |       |                  |
| [Agent A]      |<----->| [Consensus Engine]  |<----->| [SwarmVault.sol] |
| [Agent B]      |       | [API Gateway]       |       |                  |
| [Agent C]      |       |                     |       |                  |
|                |       |                     |       |                  |
| State Hashes   |       | Vote Aggregation    |       | Verify Threshold |
| Capability     |       | ECDSA Signatures    |       | Broadcast Tx     |
+-------+--------+       +----------+----------+       +--------+---------+
        |                          |                            |
        v                          v                            v
+----------------+       +---------------------+       +------------------+
|   DASHBOARD    |       |   STATE SERVICE     |       |   BLOCKCHAIN     |
| (HTML/JS)      |       | (On-Chain Health)   |       | (Ethereum/L2)    |
|                |       |                     |       |                  |
| Visualize      |       | Update Capability   |       | Store State Hash |
| Voting Power   |       | Scores              |       | Execute Logic    |
+----------------+       +---------------------+       +------------------+
```

## 🛠️ Tech Stack

*   **Orchestration:** Node.js (Custom AutoGen Fork)
*   **Smart Contracts:** Solidity 0.8.x
*   **Consensus Logic:** ECDSA Threshold Signatures
*   **Frontend:** Vanilla HTML/JavaScript
*   **Testing:** Jest (Unit Tests for Consensus Engine)

## 📦 Setup Instructions

### Prerequisites
*   Node.js v18+
*   npm or yarn
*   MetaMask or compatible Web3 wallet
*   Local or Testnet RPC Node (e.g., Alchemy, Infura)

### Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/77svene/swarmlock
    cd swarmlock
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Configure Environment**
    Create a `.env` file in the root directory with the following variables:
    ```env
    # Blockchain Configuration
    RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
    PRIVATE_KEY=YOUR_WALLET_PRIVATE_KEY
    CONTRACT_ADDRESS=0x... # Deployed SwarmVault Address

    # Agent Configuration
    AGENT_COUNT=3
    CONSENSUS_THRESHOLD=2
    STATE_HASH_SECRET=YOUR_SECRET_KEY
    ```

4.  **Deploy Smart Contract**
    ```bash
    npx hardhat run scripts/deploy.js --network localhost
    ```

5.  **Start the System**
    ```bash
    npm start
    ```

## 🔌 API Endpoints

The `services/apiGateway.js` exposes the following endpoints for agent interaction and dashboard monitoring:

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/consensus/init` | Initialize a new transaction proposal requiring consensus. |
| `POST` | `/consensus/vote` | Submit a vote from an agent with their current state hash. |
| `GET` | `/consensus/status` | Retrieve the current voting status and threshold progress. |
| `GET` | `/agent/state` | Fetch the real-time capability score and health hash of an agent. |
| `POST` | `/agent/register` | Register a new autonomous agent into the swarm. |
| `GET` | `/dashboard/stats` | Aggregate data for the frontend visualization (latency, power). |

## 📸 Demo

### Dashboard Visualization
![SwarmLock Dashboard](./public/dashboard.png)
*Real-time visualization of agent voting power and consensus latency.*

### Consensus Flow
![Consensus Flow](./public/consensus_flow.png)
*Step-by-step state hash verification and threshold signing process.*

## 👥 Team

**Built by VARAKH BUILDER — autonomous AI agent**

*   **Core Logic:** AutoGen Integration & Consensus Engine
*   **Smart Contracts:** SwarmVault Solidity Implementation
*   **Orchestration:** Node.js Agent State Management

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please fork the repository and submit a pull request. Ensure all unit tests pass (`npm test`) before submitting.

---
*SwarmLock: Securing the Future of Autonomous DeFi.*