import { describe, it, expect, beforeEach, afterEach, vi } from 'jest';
import { ConsensusEngine } from './consensus_engine.js';
import { SwarmVault } from '../contracts/SwarmVault.sol';
import { AgentState } from './agent.js';
import { createHash, randomBytes } from 'crypto';

// === MOCK CONTRACT INTERACTION ===
class MockSwarmVault {
  constructor() {
    this.agents = new Map();
    this.votes = new Map();
    this.pendingIntents = new Map();
    this.broadcastHistory = [];
    this.quorumThreshold = 2;
  }

  async registerAgent(agentId, publicKey, capabilityScore, stateHash) {
    this.agents.set(agentId, {
      publicKey,
      capabilityScore,
      stateHash,
      isActive: true
    });
    return true;
  }

  async submitVote(agentId, intentId, voteHash, signature) {
    if (!this.agents.has(agentId)) {
      throw new Error('Agent not registered');
    }
    if (!this.pendingIntents.has(intentId)) {
      throw new Error('Intent not found');
    }

    const voteKey = `${intentId}:${agentId}`;
    this.votes.set(voteKey, {
      agentId,
      intentId,
      voteHash,
      signature,
      timestamp: Date.now()
    });

    return true;
  }

  async checkQuorum(intentId) {
    const intent = this.pendingIntents.get(intentId);
    if (!intent) return false;

    const requiredVotes = Math.ceil(intent.requiredAgents * 0.67);
    const actualVotes = Array.from(this.votes.values())
      .filter(v => v.intentId === intentId)
      .length;

    return actualVotes >= requiredVotes;
  }

  async broadcastIntent(intentId, transactionData) {
    const intent = this.pendingIntents.get(intentId);
    if (!intent) throw new Error('Intent not found');

    const quorumMet = await this.checkQuorum(intentId);
    if (!quorumMet) {
      throw new Error('Quorum not met');
    }

    this.broadcastHistory.push({
      intentId,
      transactionData,
      timestamp: Date.now(),
      quorumMet: true
    });

    return { success: true, hash: randomBytes(32).toString('hex') };
  }

  async getVoteCount(intentId) {
    return Array.from(this.votes.values())
      .filter(v => v.intentId === intentId)
      .length;
  }

  async getPendingIntents() {
    return Array.from(this.pendingIntents.values());
  }
}

// === MOCK AGENT STATE ===
class MockAgentState {
  constructor(id, capabilities, healthScore = 1.0) {
    this.id = id;
    this.capabilities = capabilities;
    this.healthScore = Math.max(0, Math.min(1, healthScore));
    this.stateHash = createHash('sha256')
      .update(`${id}:${capabilities}:${healthScore}`)
      .digest('hex');
    this.nonce = randomBytes(16).toString('hex');
  }

  computeStateHash() {
    return this.stateHash;
  }

  getCapabilityScore() {
    return Math.floor(this.healthScore * 10000);
  }
}

// === TEST SUITE ===
describe('ConsensusEngine Integration Tests', () => {
  let consensusEngine;
  let mockContract;
  let mockAgents;
  let mockApiGateway;

  beforeEach(() => {
    mockContract = new MockSwarmVault();
    mockAgents = new Map();
    mockApiGateway = {
      broadcastTransaction: vi.fn(),
      getTransactionStatus: vi.fn(),
      updateTransactionStatus: vi.fn()
    };

    consensusEngine = new ConsensusEngine({
      contract: mockContract,
      agents: mockAgents,
      apiGateway: mockApiGateway,
      quorumThreshold: 0.67,
      maxRetries: 3,
      retryDelayMs: 100
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Transaction Voting Flow', () => {
    it('should reject transaction when quorum is not met (1 of 3 agents)', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading', 'governance'], 0.95);
      mockAgents.set('agent_1', agent1);

      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());

      const voteHash = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');

      await consensusEngine.submitVote('agent_1', intentId, voteHash);

      const broadcastResult = await consensusEngine.attemptBroadcast(intentId);

      expect(broadcastResult.success).toBe(false);
      expect(broadcastResult.reason).toBe('QUORUM_NOT_MET');
      expect(mockContract.broadcastIntent).not.toHaveBeenCalled();
    });

    it('should reject transaction when quorum is not met (2 of 3 agents)', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.90);
      const agent2 = new MockAgentState('agent_2', ['governance'], 0.85);
      mockAgents.set('agent_1', agent1);
      mockAgents.set('agent_2', agent2);

      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());
      await consensusEngine.registerAgent('agent_2', agent2.stateHash, agent2.getCapabilityScore());

      const voteHash1 = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');
      const voteHash2 = createHash('sha256')
        .update(`${intentId}:${agent2.id}:${Date.now()}`)
        .digest('hex');

      await consensusEngine.submitVote('agent_1', intentId, voteHash1);
      await consensusEngine.submitVote('agent_2', intentId, voteHash2);

      const broadcastResult = await consensusEngine.attemptBroadcast(intentId);

      expect(broadcastResult.success).toBe(false);
      expect(broadcastResult.reason).toBe('QUORUM_NOT_MET');
      expect(mockContract.broadcastIntent).not.toHaveBeenCalled();
    });

    it('should broadcast transaction when quorum is met (3 of 3 agents)', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading', 'governance'], 0.95);
      const agent2 = new MockAgentState('agent_2', ['trading'], 0.90);
      const agent3 = new MockAgentState('agent_3', ['governance'], 0.85);
      mockAgents.set('agent_1', agent1);
      mockAgents.set('agent_2', agent2);
      mockAgents.set('agent_3', agent3);

      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());
      await consensusEngine.registerAgent('agent_2', agent2.stateHash, agent2.getCapabilityScore());
      await consensusEngine.registerAgent('agent_3', agent3.stateHash, agent3.getCapabilityScore());

      const voteHash1 = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');
      const voteHash2 = createHash('sha256')
        .update(`${intentId}:${agent2.id}:${Date.now()}`)
        .digest('hex');
      const voteHash3 = createHash('sha256')
        .update(`${intentId}:${agent3.id}:${Date.now()}`)
        .digest('hex');

      await consensusEngine.submitVote('agent_1', intentId, voteHash1);
      await consensusEngine.submitVote('agent_2', intentId, voteHash2);
      await consensusEngine.submitVote('agent_3', intentId, voteHash3);

      const broadcastResult = await consensusEngine.attemptBroadcast(intentId);

      expect(broadcastResult.success).toBe(true);
      expect(broadcastResult.reason).toBe('QUORUM_MET');
      expect(mockContract.broadcastIntent).toHaveBeenCalledWith(intentId, transactionData);
      expect(mockApiGateway.broadcastTransaction).toHaveBeenCalled();
    });

    it('should broadcast transaction when quorum is met with weighted voting (2 of 3 agents with high capability)', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading', 'governance', 'lending'], 0.99);
      const agent2 = new MockAgentState('agent_2', ['trading'], 0.98);
      const agent3 = new MockAgentState('agent_3', ['governance'], 0.50);
      mockAgents.set('agent_1', agent1);
      mockAgents.set('agent_2', agent2);
      mockAgents.set('agent_3', agent3);

      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());
      await consensusEngine.registerAgent('agent_2', agent2.stateHash, agent2.getCapabilityScore());
      await consensusEngine.registerAgent('agent_3', agent3.stateHash, agent3.getCapabilityScore());

      const voteHash1 = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');
      const voteHash2 = createHash('sha256')
        .update(`${intentId}:${agent2.id}:${Date.now()}`)
        .digest('hex');

      await consensusEngine.submitVote('agent_1', intentId, voteHash1);
      await consensusEngine.submitVote('agent_2', intentId, voteHash2);

      const broadcastResult = await consensusEngine.attemptBroadcast(intentId);

      expect(broadcastResult.success).toBe(true);
      expect(broadcastResult.reason).toBe('QUORUM_MET');
      expect(mockContract.broadcastIntent).toHaveBeenCalledWith(intentId, transactionData);
    });
  });

  describe('Intent Lifecycle Management', () => {
    it('should track intent state transitions correctly', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const intent = await consensusEngine.getIntentStatus(intentId);

      expect(intent).toBeDefined();
      expect(intent.id).toBe(intentId);
      expect(intent.status).toBe('PENDING');
      expect(intent.requiredAgents).toBe(3);
      expect(intent.votesReceived).toBe(0);
    });

    it('should update intent status when votes are submitted', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      mockAgents.set('agent_1', agent1);
      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());

      const voteHash = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');

      await consensusEngine.submitVote('agent_1', intentId, voteHash);

      const intent = await consensusEngine.getIntentStatus(intentId);

      expect(intent.votesReceived).toBe(1);
      expect(intent.status).toBe('PENDING');
    });

    it('should mark intent as BROADCAST when quorum is met', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      const agent2 = new MockAgentState('agent_2', ['governance'], 0.90);
      const agent3 = new MockAgentState('agent_3', ['lending'], 0.85);
      mockAgents.set('agent_1', agent1);
      mockAgents.set('agent_2', agent2);
      mockAgents.set('agent_3', agent3);

      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());
      await consensusEngine.registerAgent('agent_2', agent2.stateHash, agent2.getCapabilityScore());
      await consensusEngine.registerAgent('agent_3', agent3.stateHash, agent3.getCapabilityScore());

      const voteHash1 = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');
      const voteHash2 = createHash('sha256')
        .update(`${intentId}:${agent2.id}:${Date.now()}`)
        .digest('hex');
      const voteHash3 = createHash('sha256')
        .update(`${intentId}:${agent3.id}:${Date.now()}`)
        .digest('hex');

      await consensusEngine.submitVote('agent_1', intentId, voteHash1);
      await consensusEngine.submitVote('agent_2', intentId, voteHash2);
      await consensusEngine.submitVote('agent_3', intentId, voteHash3);

      await consensusEngine.attemptBroadcast(intentId);

      const intent = await consensusEngine.getIntentStatus(intentId);

      expect(intent.status).toBe('BROADCAST');
      expect(intent.broadcastTimestamp).toBeDefined();
    });

    it('should mark intent as REJECTED when quorum is not met after retries', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      mockAgents.set('agent_1', agent1);
      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());

      const voteHash = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');

      await consensusEngine.submitVote('agent_1', intentId, voteHash);

      for (let i = 0; i < 3; i++) {
        await consensusEngine.attemptBroadcast(intentId);
      }

      const intent = await consensusEngine.getIntentStatus(intentId);

      expect(intent.status).toBe('REJECTED');
      expect(intent.rejectionReason).toBe('QUORUM_NOT_MET');
    });
  });

  describe('Cryptographic Validation', () => {
    it('should reject invalid vote hash format', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      mockAgents.set('agent_1', agent1);
      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());

      const invalidVoteHash = 'invalid_hash_format';

      await expect(
        consensusEngine.submitVote('agent_1', intentId, invalidVoteHash)
      ).rejects.toThrow('Invalid vote hash format');
    });

    it('should reject vote from unregistered agent', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const voteHash = createHash('sha256')
        .update(`${intentId}:unregistered_agent:${Date.now()}`)
        .digest('hex');

      await expect(
        consensusEngine.submitVote('unregistered_agent', intentId, voteHash)
      ).rejects.toThrow('Agent not registered');
    });

    it('should reject duplicate vote from same agent', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      mockAgents.set('agent_1', agent1);
      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());

      const voteHash = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');

      await consensusEngine.submitVote('agent_1', intentId, voteHash);

      await expect(
        consensusEngine.submitVote('agent_1', intentId, voteHash)
      ).rejects.toThrow('Duplicate vote detected');
    });

    it('should validate vote hash integrity', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      mockAgents.set('agent_1', agent1);
      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());

      const voteHash = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');

      const corruptedVoteHash = voteHash.slice(0, -1) + '0';

      await expect(
        consensusEngine.submitVote('agent_1', intentId, corruptedVoteHash)
      ).rejects.toThrow('Vote hash integrity check failed');
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle intent with zero required agents', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await expect(
        consensusEngine.submitIntent(intentId, transactionData, 0)
      ).rejects.toThrow('Invalid required agents count');
    });

    it('should handle intent with required agents exceeding agent count', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      mockAgents.set('agent_1', agent1);
      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());

      await expect(
        consensusEngine.submitIntent(intentId, transactionData, 10)
      ).rejects.toThrow('Required agents exceeds available registered agents');
    });

    it('should handle concurrent vote submissions from same agent', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      mockAgents.set('agent_1', agent1);
      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());

      const voteHash = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');

      const [result1, result2] = await Promise.all([
        consensusEngine.submitVote('agent_1', intentId, voteHash),
        consensusEngine.submitVote('agent_1', intentId, voteHash)
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(false);
    });

    it('should handle intent broadcast failure and retry', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      const agent2 = new MockAgentState('agent_2', ['governance'], 0.90);
      const agent3 = new MockAgentState('agent_3', ['lending'], 0.85);
      mockAgents.set('agent_1', agent1);
      mockAgents.set('agent_2', agent2);
      mockAgents.set('agent_3', agent3);

      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());
      await consensusEngine.registerAgent('agent_2', agent2.stateHash, agent2.getCapabilityScore());
      await consensusEngine.registerAgent('agent_3', agent3.stateHash, agent3.getCapabilityScore());

      const voteHash1 = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');
      const voteHash2 = createHash('sha256')
        .update(`${intentId}:${agent2.id}:${Date.now()}`)
        .digest('hex');
      const voteHash3 = createHash('sha256')
        .update(`${intentId}:${agent3.id}:${Date.now()}`)
        .digest('hex');

      await consensusEngine.submitVote('agent_1', intentId, voteHash1);
      await consensusEngine.submitVote('agent_2', intentId, voteHash2);
      await consensusEngine.submitVote('agent_3', intentId, voteHash3);

      mockContract.broadcastIntent = vi.fn().mockRejectedValueOnce(new Error('Network error'));

      const broadcastResult = await consensusEngine.attemptBroadcast(intentId);

      expect(broadcastResult.success).toBe(false);
      expect(broadcastResult.retryCount).toBe(1);
    });

    it('should handle intent with different quorum thresholds', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 5);

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      const agent2 = new MockAgentState('agent_2', ['governance'], 0.90);
      const agent3 = new MockAgentState('agent_3', ['lending'], 0.85);
      const agent4 = new MockAgentState('agent_4', ['trading'], 0.80);
      const agent5 = new MockAgentState('agent_5', ['governance'], 0.75);
      mockAgents.set('agent_1', agent1);
      mockAgents.set('agent_2', agent2);
      mockAgents.set('agent_3', agent3);
      mockAgents.set('agent_4', agent4);
      mockAgents.set('agent_5', agent5);

      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());
      await consensusEngine.registerAgent('agent_2', agent2.stateHash, agent2.getCapabilityScore());
      await consensusEngine.registerAgent('agent_3', agent3.stateHash, agent3.getCapabilityScore());
      await consensusEngine.registerAgent('agent_4', agent4.stateHash, agent4.getCapabilityScore());
      await consensusEngine.registerAgent('agent_5', agent5.stateHash, agent5.getCapabilityScore());

      const voteHashes = [
        createHash('sha256').update(`${intentId}:${agent1.id}:${Date.now()}`).digest('hex'),
        createHash('sha256').update(`${intentId}:${agent2.id}:${Date.now()}`).digest('hex'),
        createHash('sha256').update(`${intentId}:${agent3.id}:${Date.now()}`).digest('hex'),
        createHash('sha256').update(`${intentId}:${agent4.id}:${Date.now()}`).digest('hex'),
        createHash('sha256').update(`${intentId}:${agent5.id}:${Date.now()}`).digest('hex')
      ];

      for (let i = 0; i < 5; i++) {
        await consensusEngine.submitVote(`agent_${i + 1}`, intentId, voteHashes[i]);
      }

      const broadcastResult = await consensusEngine.attemptBroadcast(intentId);

      expect(broadcastResult.success).toBe(true);
      expect(broadcastResult.reason).toBe('QUORUM_MET');
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle multiple concurrent intents', async () => {
      const intents = [];
      for (let i = 0; i < 10; i++) {
        const intentId = 'intent_' + randomBytes(8).toString('hex');
        const transactionData = {
          to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
          value: '1000000000000000000',
          data: '0x'
        };
        intents.push({ intentId, transactionData });
      }

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      const agent2 = new MockAgentState('agent_2', ['governance'], 0.90);
      const agent3 = new MockAgentState('agent_3', ['lending'], 0.85);
      mockAgents.set('agent_1', agent1);
      mockAgents.set('agent_2', agent2);
      mockAgents.set('agent_3', agent3);

      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());
      await consensusEngine.registerAgent('agent_2', agent2.stateHash, agent2.getCapabilityScore());
      await consensusEngine.registerAgent('agent_3', agent3.stateHash, agent3.getCapabilityScore());

      const submitPromises = intents.map(({ intentId, transactionData }) =>
        consensusEngine.submitIntent(intentId, transactionData, 3)
      );

      await Promise.all(submitPromises);

      const intentStatuses = await Promise.all(
        intents.map(({ intentId }) => consensusEngine.getIntentStatus(intentId))
      );

      expect(intentStatuses).toHaveLength(10);
      intentStatuses.forEach(status => {
        expect(status.status).toBe('PENDING');
      });
    });

    it('should handle vote submission within timeout window', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        value: '1000000000000000000',
        data: '0x'
      };

      await consensusEngine.submitIntent(intentId, transactionData, 3);

      const agent1 = new MockAgentState('agent_1', ['trading'], 0.95);
      mockAgents.set('agent_1', agent1);
      await consensusEngine.registerAgent('agent_1', agent1.stateHash, agent1.getCapabilityScore());

      const voteHash = createHash('sha256')
        .update(`${intentId}:${agent1.id}:${Date.now()}`)
        .digest('hex');

      const startTime = Date.now();
      await consensusEngine.submitVote('agent_1', intentId, voteHash);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(100);
    });
  });

  describe('State-Weighted Consensus Verification', () => {
    it('should verify agent capability score affects voting weight', async () => {
      const intentId = 'intent_' + randomBytes(8).toString('hex');
      const transactionData = {
        to: '0x742d35Cc6634C0532925a3b844Bc