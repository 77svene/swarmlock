import { ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';
import { createHash, randomBytes } from 'crypto';

const QUORUM_THRESHOLD = 0.67; // 67% of total voting power required
const MAX_VOTE_AGE_MS = 300000; // 5 minutes
const INTENT_EXPIRY_MS = 60000; // 1 minute

class ConsensusEngine {
  constructor(config = {}) {
    this.config = {
      quorumThreshold: config.quorumThreshold ?? QUORUM_THRESHOLD,
      maxVoteAgeMs: config.maxVoteAgeMs ?? MAX_VOTE_AGE_MS,
      intentExpiryMs: config.intentExpiryMs ?? INTENT_EXPIRY_MS,
      providerUrl: config.providerUrl ?? 'http://localhost:8545',
      contractAddress: config.contractAddress ?? '0x0000000000000000000000000000000000000000',
      ...config
    };
    
    this.agents = new Map();
    this.votes = new Map();
    this.pendingIntents = new Map();
    this.executedIntents = new Set();
    this.broadcastCallback = null;
    this.state = 'IDLE';
    this.consensusHistory = [];
  }

  registerAgent(agentId, agentData) {
    const agent = {
      id: agentId,
      publicKey: agentData.publicKey || randomBytes(32).toString('hex'),
      capabilityScore: agentData.capabilityScore ?? 1000,
      stateHash: agentData.stateHash ?? createHash('sha256').update(agentId).digest('hex'),
      isActive: true,
      registeredAt: Date.now(),
      lastVoteAt: null,
      votesCast: 0
    };
    
    this.agents.set(agentId, agent);
    return agent;
  }

  unregisterAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.isActive = false;
      this.agents.set(agentId, agent);
    }
    return agent;
  }

  calculateVotingPower(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent || !agent.isActive) return 0;
    return agent.capabilityScore;
  }

  getTotalVotingPower() {
    let total = 0;
    for (const agent of this.agents.values()) {
      if (agent.isActive) {
        total += agent.capabilityScore;
      }
    }
    return total;
  }

  submitVote(agentId, intentId, voteData) {
    const agent = this.agents.get(agentId);
    if (!agent || !agent.isActive) {
      throw new Error(`Agent ${agentId} not found or inactive`);
    }

    if (!this.pendingIntents.has(intentId)) {
      throw new Error(`Intent ${intentId} not found`);
    }

    const intent = this.pendingIntents.get(intentId);
    if (intent.status !== 'PENDING') {
      throw new Error(`Intent ${intentId} is not pending`);
    }

    const vote = {
      id: uuidv4(),
      agentId,
      intentId,
      voteData,
      timestamp: Date.now(),
      signature: this._generateVoteSignature(agentId, intentId, voteData)
    };

    this.votes.set(vote.id, vote);
    agent.lastVoteAt = Date.now();
    agent.votesCast++;

    this._checkConsensus(intentId);
    return vote;
  }

  _generateVoteSignature(agentId, intentId, voteData) {
    const message = `${agentId}:${intentId}:${JSON.stringify(voteData)}:${Date.now()}`;
    return createHash('sha256').update(message).digest('hex');
  }

  createIntent(intentData) {
    const intentId = uuidv4();
    const intent = {
      id: intentId,
      data: intentData,
      status: 'PENDING',
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.intentExpiryMs,
      votes: [],
      totalVotingPower: 0,
      requiredVotingPower: 0
    };

    this.pendingIntents.set(intentId, intent);
    this._calculateIntentRequirements(intent);
    return intent;
  }

  _calculateIntentRequirements(intent) {
    const totalPower = this.getTotalVotingPower();
    intent.totalVotingPower = totalPower;
    intent.requiredVotingPower = Math.ceil(totalPower * this.config.quorumThreshold);
  }

  _checkConsensus(intentId) {
    const intent = this.pendingIntents.get(intentId);
    if (!intent || intent.status !== 'PENDING') return;

    const now = Date.now();
    const validVotes = [];
    let currentVotingPower = 0;

    for (const vote of this.votes.values()) {
      if (vote.intentId !== intentId) continue;
      if (now - vote.timestamp > this.config.maxVoteAgeMs) continue;
      
      const agent = this.agents.get(vote.agentId);
      if (!agent || !agent.isActive) continue;

      validVotes.push(vote);
      currentVotingPower += this.calculateVotingPower(vote.agentId);
    }

    intent.votes = validVotes;
    intent.currentVotingPower = currentVotingPower;

    if (currentVotingPower >= intent.requiredVotingPower) {
      this._executeIntent(intentId);
    }
  }

  _executeIntent(intentId) {
    const intent = this.pendingIntents.get(intentId);
    if (!intent || intent.status !== 'PENDING') return;

    intent.status = 'EXECUTED';
    intent.executedAt = Date.now();
    this.executedIntents.add(intentId);

    const consensusRecord = {
      intentId,
      executedAt: intent.executedAt,
      votingPower: intent.currentVotingPower,
      requiredVotingPower: intent.requiredVotingPower,
      voteCount: intent.votes.length,
      agents: intent.votes.map(v => v.agentId)
    };

    this.consensusHistory.push(consensusRecord);

    if (this.broadcastCallback) {
      this.broadcastCallback(intent);
    }

    this.state = 'CONSENSUS_REACHED';
  }

  setBroadcastCallback(callback) {
    this.broadcastCallback = callback;
  }

  getConsensusStatus(intentId) {
    const intent = this.pendingIntents.get(intentId);
    if (!intent) return null;

    return {
      status: intent.status,
      currentVotingPower: intent.currentVotingPower || 0,
      requiredVotingPower: intent.requiredVotingPower,
      voteCount: intent.votes.length,
      totalVotingPower: intent.totalVotingPower,
      quorumMet: (intent.currentVotingPower || 0) >= intent.requiredVotingPower
    };
  }

  getAgentStats(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    return {
      id: agent.id,
      capabilityScore: agent.capabilityScore,
      isActive: agent.isActive,
      votesCast: agent.votesCast,
      lastVoteAt: agent.lastVoteAt,
      votingPower: this.calculateVotingPower(agentId)
    };
  }

  getConsensusHistory() {
    return [...this.consensusHistory];
  }

  reset() {
    this.agents.clear();
    this.votes.clear();
    this.pendingIntents.clear();
    this.executedIntents.clear();
    this.consensusHistory = [];
    this.state = 'IDLE';
  }
}

export default ConsensusEngine;