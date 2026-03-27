import { randomBytes, createHash, createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const STATE_HASH_VERSION = 'swarmlock-v1';
const STATE_HASH_SALT = 'agent-state-weighted-consensus';

class AgentState {
  constructor(id, capabilities, healthScore = 1.0) {
    this.id = id;
    this.capabilities = capabilities;
    this.healthScore = Math.max(0, Math.min(1, healthScore));
    this.lastStateHash = null;
    this.stateTimestamp = Date.now();
    this.nonce = randomBytes(16).toString('hex');
  }

  computeStateHash() {
    const stateString = JSON.stringify({
      id: this.id,
      capabilities: this.capabilities,
      healthScore: this.healthScore,
      timestamp: this.stateTimestamp,
      nonce: this.nonce
    });
    
    const hashInput = `${STATE_HASH_VERSION}:${STATE_HASH_SALT}:${stateString}`;
    return createHash('sha256').update(hashInput).digest('hex');
  }

  updateHealth(healthScore) {
    this.healthScore = Math.max(0, Math.min(1, healthScore));
    this.stateTimestamp = Date.now();
    this.nonce = randomBytes(16).toString('hex');
    this.lastStateHash = this.computeStateHash();
    return this.lastStateHash;
  }

  updateCapabilities(newCapabilities) {
    this.capabilities = { ...this.capabilities, ...newCapabilities };
    this.stateTimestamp = Date.now();
    this.nonce = randomBytes(16).toString('hex');
    this.lastStateHash = this.computeStateHash();
    return this.lastStateHash;
  }

  verifyStateHash(providedHash) {
    const currentHash = this.computeStateHash();
    return createHash('sha256').update(providedHash).digest('hex') === 
           createHash('sha256').update(currentHash).digest('hex');
  }

  getWeightedVotePower() {
    const capabilityWeight = Object.values(this.capabilities).reduce((sum, val) => sum + (val || 0), 0);
    return this.healthScore * (1 + capabilityWeight * 0.1);
  }
}

class Agent {
  constructor(config = {}) {
    this.id = config.id || `agent-${uuidv4().slice(0, 8)}`;
    this.role = config.role || 'general';
    this.state = new AgentState(this.id, config.capabilities || {}, config.healthScore || 1.0);
    this.consensusThreshold = config.consensusThreshold || 0.67;
    this.connectedPeers = new Set();
    this.messageQueue = [];
    this.stateHistory = [];
    this.maxHistory = 100;
    this.isRunning = false;
    this.onStateChange = config.onStateChange || null;
    this.onConsensus = config.onConsensus || null;
  }

  getStateHash() {
    return this.state.computeStateHash();
  }

  getWeightedVotePower() {
    return this.state.getWeightedVotePower();
  }

  async broadcastState() {
    const stateHash = this.getStateHash();
    const message = {
      type: 'STATE_UPDATE',
      agentId: this.id,
      stateHash,
      votePower: this.getWeightedVotePower(),
      timestamp: Date.now(),
      nonce: this.state.nonce
    };
    
    for (const peerId of this.connectedPeers) {
      await this.sendMessage(peerId, message);
    }
    
    this.stateHistory.push({ hash: stateHash, timestamp: Date.now() });
    if (this.stateHistory.length > this.maxHistory) {
      this.stateHistory.shift();
    }
    
    if (this.onStateChange) {
      await this.onStateChange(message);
    }
    
    return message;
  }

  async sendMessage(targetId, message) {
    this.messageQueue.push({ targetId, message, timestamp: Date.now() });
    return true;
  }

  async receiveMessage(senderId, message) {
    if (message.type === 'STATE_UPDATE') {
      await this.handleStateUpdate(senderId, message);
    } else if (message.type === 'CONSENSUS_REQUEST') {
      await this.handleConsensusRequest(senderId, message);
    } else if (message.type === 'CONSENSUS_VOTE') {
      await this.handleConsensusVote(senderId, message);
    }
    return true;
  }

  async handleStateUpdate(senderId, message) {
    if (!this.connectedPeers.has(senderId)) {
      this.connectedPeers.add(senderId);
    }
    
    const stateVerification = {
      senderId,
      stateHash: message.stateHash,
      votePower: message.votePower,
      timestamp: message.timestamp,
      verified: true
    };
    
    this.stateHistory.push(stateVerification);
    if (this.stateHistory.length > this.maxHistory) {
      this.stateHistory.shift();
    }
    
    return stateVerification;
  }

  async requestConsensus(action, requiredWeight = 0.67) {
    const consensusRequest = {
      type: 'CONSENSUS_REQUEST',
      actionId: uuidv4(),
      action,
      requiredWeight,
      initiatorId: this.id,
      timestamp: Date.now(),
      nonce: randomBytes(16).toString('hex')
    };
    
    for (const peerId of this.connectedPeers) {
      await this.sendMessage(peerId, consensusRequest);
    }
    
    return consensusRequest.actionId;
  }

  async voteOnConsensus(actionId, vote, signature) {
    const consensusVote = {
      type: 'CONSENSUS_VOTE',
      actionId,
      agentId: this.id,
      vote,
      votePower: this.getWeightedVotePower(),
      signature,
      timestamp: Date.now(),
      nonce: randomBytes(16).toString('hex')
    };
    
    for (const peerId of this.connectedPeers) {
      await this.sendMessage(peerId, consensusVote);
    }
    
    return consensusVote;
  }

  async handleConsensusRequest(senderId, message) {
    const vote = await this.evaluateAction(message.action);
    const signature = this.signConsensusVote(message.actionId, vote);
    
    await this.voteOnConsensus(message.actionId, vote, signature);
    
    return { actionId: message.actionId, voted: true };
  }

  async handleConsensusVote(senderId, message) {
    const voteRecord = {
      actionId: message.actionId,
      agentId: message.agentId,
      vote: message.vote,
      votePower: message.votePower,
      timestamp: message.timestamp
    };
    
    this.stateHistory.push(voteRecord);
    if (this.stateHistory.length > this.maxHistory) {
      this.stateHistory.shift();
    }
    
    if (this.onConsensus) {
      await this.onConsensus(voteRecord);
    }
    
    return voteRecord;
  }

  async evaluateAction(action) {
    const capabilityCheck = this.checkCapabilities(action);
    const healthCheck = this.state.healthScore >= 0.5;
    const timestampCheck = Date.now() - action.timestamp < 30000;
    
    return capabilityCheck && healthCheck && timestampCheck;
  }

  checkCapabilities(action) {
    if (!action.requiredCapabilities) return true;
    
    for (const cap of action.requiredCapabilities) {
      if (!this.state.capabilities[cap]) return false;
    }
    
    return true;
  }

  signConsensusVote(actionId, vote) {
    const signatureData = `${actionId}:${vote}:${this.id}:${this.state.nonce}`;
    return createHmac('sha256', this.id).update(signatureData).digest('hex');
  }

  async connect(peerAgent) {
    this.connectedPeers.add(peerAgent.id);
    peerAgent.connectedPeers.add(this.id);
    
    await this.broadcastState();
    await peerAgent.broadcastState();
    
    return true;
  }

  async disconnect(peerAgent) {
    this.connectedPeers.delete(peerAgent.id);
    peerAgent.connectedPeers.delete(this.id);
    return true;
  }

  async start() {
    this.isRunning = true;
    await this.broadcastState();
    return true;
  }

  async stop() {
    this.isRunning = false;
    return true;
  }

  async updateHealth(healthScore) {
    return this.state.updateHealth(healthScore);
  }

  async updateCapabilities(newCapabilities) {
    return this.state.updateCapabilities(newCapabilities);
  }

  getConsensusState() {
    return {
      id: this.id,
      role: this.role,
      stateHash: this.getStateHash(),
      votePower: this.getWeightedVotePower(),
      connectedPeers: Array.from(this.connectedPeers),
      isRunning: this.isRunning,
      healthScore: this.state.healthScore,
      capabilities: this.state.capabilities
    };
  }
}

export { Agent, AgentState };