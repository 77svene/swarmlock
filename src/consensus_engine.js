import { createHash, createHmac, randomBytes, createSign, createVerify, createCipheriv, createDecipheriv } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { AgentState } from './agent.js';
import { ContractInterface } from './agent_state_service.js';

const CONSENSUS_VERSION = 'swarmlock-consensus-v1';
const SIGNATURE_VERSION = 'ecdsa-secp256k1';
const MIN_QUORUM_PERCENTAGE = 51;
const SIGNATURE_EXPIRY_MS = 300000;
const MAX_PENDING_CONSENSUS = 100;
const CONSENSUS_TIMEOUT_MS = 60000;
const STATE_SCORE_THRESHOLD = 500;
const SIGNATURE_BATCH_SIZE = 10;
const RATE_LIMIT_WINDOW_MS = 1000;
const MAX_RATE_LIMIT_CALLS = 50;
const EVENT_DRIVEN_POLL_INTERVAL = 100;
const MAX_SIGNATURE_CACHE_SIZE = 1000;
const CACHE_TTL_MS = 5000;
const MAX_SIGNATURES_PER_CONSENSUS = 100;

class RateLimiter {
  constructor(windowMs, maxCalls) {
    this.windowMs = windowMs;
    this.maxCalls = maxCalls;
    this.requests = new Map();
  }

  _getTimestampWindow() {
    return Math.floor(Date.now() / this.windowMs);
  }

  isAllowed(key) {
    const window = this._getTimestampWindow();
    const keyWithWindow = `${key}:${window}`;
    
    if (!this.requests.has(keyWithWindow)) {
      this.requests.set(keyWithWindow, 0);
    }
    
    const count = this.requests.get(keyWithWindow);
    if (count >= this.maxCalls) {
      return false;
    }
    
    this.requests.set(keyWithWindow, count + 1);
    return true;
  }

  cleanup() {
    const currentWindow = this._getTimestampWindow();
    for (const [key, count] of this.requests.entries()) {
      const [_, window] = key.split(':');
      if (parseInt(window) < currentWindow - 1) {
        this.requests.delete(key);
      }
    }
  }
}

class SignatureCache {
  constructor(maxSize, ttlMs) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.timestamps = new Map();
  }

  _isExpired(key) {
    const timestamp = this.timestamps.get(key);
    if (!timestamp) return true;
    return Date.now() - timestamp > this.ttlMs;
  }

  _evictExpired() {
    const now = Date.now();
    for (const [key, timestamp] of this.timestamps.entries()) {
      if (now - timestamp > this.ttlMs) {
        this.cache.delete(key);
        this.timestamps.delete(key);
      }
    }
  }

  _evictOldest() {
    if (this.cache.size >= this.maxSize) {
      let oldestKey = null;
      let oldestTimestamp = Infinity;
      for (const [key, timestamp] of this.timestamps.entries()) {
        if (timestamp < oldestTimestamp) {
          oldestTimestamp = timestamp;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.cache.delete(oldestKey);
        this.timestamps.delete(oldestKey);
      }
    }
  }

  set(key, value) {
    this._evictExpired();
    this._evictOldest();
    this.cache.set(key, value);
    this.timestamps.set(key, Date.now());
  }

  get(key) {
    if (this._isExpired(key)) {
      this.cache.delete(key);
      this.timestamps.delete(key);
      return null;
    }
    return this.cache.get(key);
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    this.cache.delete(key);
    this.timestamps.delete(key);
  }

  clear() {
    this.cache.clear();
    this.timestamps.clear();
  }

  size() {
    this._evictExpired();
    return this.cache.size;
  }
}

class ConsensusEngine {
  constructor(config) {
    this.config = this._validateConfig(config);
    this.pendingTransactions = new Map();
    this.collectedSignatures = new Map();
    this.consensusHistory = [];
    this.agentRegistry = new Map();
    this.rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, MAX_RATE_LIMIT_CALLS);
    this.signatureCache = new SignatureCache(MAX_SIGNATURE_CACHE_SIZE, CACHE_TTL_MS);
    this.eventListeners = new Map();
    this.isRunning = false;
    this.consensusListeners = new Set();
    this.errorListeners = new Set();
    this._cleanupInterval = null;
    this._eventPoller = null;
    this._signatureCollector = null;
  }

  _validateConfig(config) {
    const required = ['contractAddress', 'provider', 'privateKey', 'quorumPercentage'];
    for (const key of required) {
      if (!config[key]) {
        throw new Error(`Missing required config: ${key}`);
      }
    }
    return {
      ...config,
      quorumPercentage: Math.max(1, Math.min(100, config.quorumPercentage || MIN_QUORUM_PERCENTAGE)),
      stateScoreThreshold: config.stateScoreThreshold || STATE_SCORE_THRESHOLD,
      consensusTimeout: config.consensusTimeout || CONSENSUS_TIMEOUT_MS,
      maxPendingTransactions: config.maxPendingTransactions || MAX_PENDING_CONSENSUS,
    };
  }

  _computeTransactionHash(transaction) {
    const transactionString = JSON.stringify({
      to: transaction.to,
      value: transaction.value,
      data: transaction.data || '0x',
      nonce: transaction.nonce,
      chainId: transaction.chainId,
      timestamp: Date.now(),
    });
    return createHash('sha256').update(transactionString).digest('hex');
  }

  _computeStateHash(agentState) {
    const stateString = JSON.stringify({
      id: agentState.id,
      capabilities: agentState.capabilities,
      healthScore: agentState.healthScore,
      timestamp: agentState.stateTimestamp,
      nonce: agentState.nonce,
    });
    const hashInput = `${CONSENSUS_VERSION}:${stateString}`;
    return createHash('sha256').update(hashInput).digest('hex');
  }

  _signTransaction(transactionHash, privateKey) {
    const signer = createSign('SHA256');
    signer.update(transactionHash);
    return signer.sign(privateKey);
  }

  _verifySignature(transactionHash, signature, publicKey) {
    const verifier = createVerify('SHA256');
    verifier.update(transactionHash);
    return verifier.verify(publicKey, signature);
  }

  _computeQuorumThreshold(totalAgents) {
    return Math.ceil((totalAgents * this.config.quorumPercentage) / 100);
  }

  _validateSignatureFormat(signature) {
    if (!signature || typeof signature !== 'object') {
      return false;
    }
    const required = ['agentId', 'signature', 'timestamp', 'stateHash'];
    for (const key of required) {
      if (!(key in signature)) {
        return false;
      }
    }
    if (typeof signature.timestamp !== 'number' || signature.timestamp <= 0) {
      return false;
    }
    if (signature.signature.length !== 132) {
      return false;
    }
    return true;
  }

  _validateSignatureExpiry(signature) {
    const now = Date.now();
    const age = now - signature.timestamp;
    return age < SIGNATURE_EXPIRY_MS;
  }

  _validateStateScore(agentState) {
    const capabilityScore = agentState.capabilities?.score || 0;
    return capabilityScore >= this.config.stateScoreThreshold;
  }

  async _fetchAgentState(agentId) {
    const cached = this.signatureCache.get(`agent:${agentId}`);
    if (cached) {
      return cached;
    }

    try {
      const contractInterface = new ContractInterface(
        this.config.contractAbi,
        this.config.contractAddress,
        this.config.provider
      );
      
      const agentData = await contractInterface.getAgent(agentId);
      if (!agentData) {
        throw new Error(`Agent ${agentId} not found in registry`);
      }

      const agentState = new AgentState(agentId, agentData.capabilities, agentData.healthScore);
      agentState.stateHash = agentData.stateHash;
      agentState.stateTimestamp = agentData.lastStateTimestamp;
      
      this.signatureCache.set(`agent:${agentId}`, agentState);
      return agentState;
    } catch (error) {
      this._emitError('fetch_agent_state', error, { agentId });
      return null;
    }
  }

  async _collectSignatures(transactionHash, consensusId) {
    const signatures = new Map();
    const requiredQuorum = this._computeQuorumThreshold(this.agentRegistry.size);
    let collectedCount = 0;

    for (const [agentId, agentState] of this.agentRegistry.entries()) {
      if (!this._validateStateScore(agentState)) {
        continue;
      }

      const signature = await this._generateAgentSignature(transactionHash, agentId, agentState);
      if (signature) {
        signatures.set(agentId, signature);
        collectedCount++;
        
        if (collectedCount >= requiredQuorum) {
          break;
        }
      }
    }

    return { signatures, collectedCount, requiredQuorum };
  }

  async _generateAgentSignature(transactionHash, agentId, agentState) {
    const signatureData = {
      agentId,
      signature: null,
      timestamp: Date.now(),
      stateHash: this._computeStateHash(agentState),
      transactionHash,
    };

    try {
      const privateKey = this.config.privateKey;
      if (!privateKey) {
        throw new Error('Private key not configured');
      }

      const signature = this._signTransaction(transactionHash, privateKey);
      signatureData.signature = signature.toString('hex');

      return signatureData;
    } catch (error) {
      this._emitError('generate_signature', error, { agentId, transactionHash });
      return null;
    }
  }

  async _verifyConsensus(transactionHash, signatures) {
    const verificationResults = [];
    let validCount = 0;

    for (const [agentId, signature] of signatures.entries()) {
      if (!this._validateSignatureFormat(signature)) {
        verificationResults.push({ agentId, valid: false, reason: 'invalid_format' });
        continue;
      }

      if (!this._validateSignatureExpiry(signature)) {
        verificationResults.push({ agentId, valid: false, reason: 'expired' });
        continue;
      }

      const agentState = await this._fetchAgentState(agentId);
      if (!agentState) {
        verificationResults.push({ agentId, valid: false, reason: 'agent_not_found' });
        continue;
      }

      if (!this._validateStateScore(agentState)) {
        verificationResults.push({ agentId, valid: false, reason: 'insufficient_score' });
        continue;
      }

      const isValid = this._verifySignature(transactionHash, signature.signature, agentState.publicKey);
      verificationResults.push({ agentId, valid: isValid, reason: isValid ? 'verified' : 'invalid_signature' });
      
      if (isValid) {
        validCount++;
      }
    }

    const requiredQuorum = this._computeQuorumThreshold(this.agentRegistry.size);
    const consensusAchieved = validCount >= requiredQuorum;

    return {
      consensusAchieved,
      validCount,
      requiredQuorum,
      verificationResults,
    };
  }

  async _executeConsensus(transaction, consensusId) {
    const transactionHash = this._computeTransactionHash(transaction);
    
    const { signatures, collectedCount, requiredQuorum } = await this._collectSignatures(transactionHash, consensusId);
    
    const { consensusAchieved, validCount, verificationResults } = await this._verifyConsensus(transactionHash, signatures);

    const consensusResult = {
      consensusId,
      transactionHash,
      consensusAchieved,
      validCount,
      requiredQuorum,
      collectedCount,
      verificationResults,
      timestamp: Date.now(),
    };

    this.consensusHistory.push(consensusResult);
    this._emitConsensus(consensusResult);

    if (consensusAchieved) {
      await this._broadcastTransaction(transaction, signatures);
    }

    return consensusResult;
  }

  async _broadcastTransaction(transaction, signatures) {
    const contractInterface = new ContractInterface(
      this.config.contractAbi,
      this.config.contractAddress,
      this.config.provider
    );

    const signatureArray = Array.from(signatures.values()).map(sig => ({
      agentId: sig.agentId,
      signature: sig.signature,
      timestamp: sig.timestamp,
      stateHash: sig.stateHash,
    }));

    try {
      const txHash = await contractInterface.submitVote(transaction, signatureArray);
      return txHash;
    } catch (error) {
      this._emitError('broadcast_transaction', error, { transaction, signatures });
      throw error;
    }
  }

  async submitTransaction(transaction) {
    if (!this.rateLimiter.isAllowed('submit_transaction')) {
      throw new Error('Rate limit exceeded for transaction submission');
    }

    if (this.pendingTransactions.size >= this.config.maxPendingTransactions) {
      throw new Error('Maximum pending transactions reached');
    }

    const consensusId = uuidv4();
    const transactionHash = this._computeTransactionHash(transaction);

    if (this.signatureCache.has(`consensus:${consensusId}`)) {
      throw new Error('Consensus already in progress');
    }

    this.pendingTransactions.set(consensusId, {
      transaction,
      transactionHash,
      createdAt: Date.now(),
      status: 'pending',
    });

    try {
      const result = await this._executeConsensus(transaction, consensusId);
      this.pendingTransactions.delete(consensusId);
      return result;
    } catch (error) {
      this.pendingTransactions.delete(consensusId);
      throw error;
    }
  }

  async registerAgent(agentId, agentState) {
    if (!this.rateLimiter.isAllowed('register_agent')) {
      throw new Error('Rate limit exceeded for agent registration');
    }

    if (!this._validateStateScore(agentState)) {
      throw new Error('Agent state score below threshold');
    }

    this.agentRegistry.set(agentId, agentState);
    this.signatureCache.set(`agent:${agentId}`, agentState);
    
    return { agentId, registeredAt: Date.now(), status: 'active' };
  }

  async unregisterAgent(agentId) {
    this.agentRegistry.delete(agentId);
    this.signatureCache.delete(`agent:${agentId}`);
    return { agentId, unregisteredAt: Date.now(), status: 'removed' };
  }

  getPendingTransactions() {
    return Array.from(this.pendingTransactions.entries()).map(([id, data]) => ({
      consensusId: id,
      transactionHash: data.transactionHash,
      createdAt: data.createdAt,
      status: data.status,
    }));
  }

  getConsensusHistory(limit = 10) {
    return this.consensusHistory.slice(-limit);
  }

  getAgentRegistry() {
    return Array.from(this.agentRegistry.entries()).map(([id, state]) => ({
      agentId: id,
      healthScore: state.healthScore,
      capabilities: state.capabilities,
      stateHash: state.stateHash,
      isActive: state.isActive,
    }));
  }

  onConsensus(callback) {
    this.consensusListeners.add(callback);
    return () => this.consensusListeners.delete(callback);
  }

  onError(callback) {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }

  _emitConsensus(result) {
    for (const listener of this.consensusListeners) {
      try {
        listener(result);
      } catch (error) {
        this._emitError('consensus_listener', error, { result });
      }
    }
  }

  _emitError(type, error, context) {
    const errorData = {
      type,
      message: error.message,
      stack: error.stack,
      context,
      timestamp: Date.now(),
    };

    for (const listener of this.errorListeners) {
      try {
        listener(errorData);
      } catch (e) {
        console.error('Error listener failed:', e);
      }
    }
  }

  async start() {
    if (this.isRunning) {
      throw new Error('Consensus engine already running');
    }

    this.isRunning = true;
    this._cleanupInterval = setInterval(() => this._cleanup(), 60000);
    this._eventPoller = setInterval(() => this._pollForEvents(), EVENT_DRIVEN_POLL_INTERVAL);
    this._signatureCollector = setInterval(() => this._collectSignatures(), 5000);

    return { status: 'running', startedAt: Date.now() };
  }

  async stop() {
    this.isRunning = false;

    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }

    if (this._eventPoller) {
      clearInterval(this._eventPoller);
      this._eventPoller = null;
    }

    if (this._signatureCollector) {
      clearInterval(this._signatureCollector);
      this._signatureCollector = null;
    }

    return { status: 'stopped', stoppedAt: Date.now() };
  }

  _cleanup() {
    const now = Date.now();
    const expired = [];

    for (const [id, data] of this.pendingTransactions.entries()) {
      if (now - data.createdAt > this.config.consensusTimeout) {
        expired.push(id);
      }
    }

    for (const id of expired) {
      this.pendingTransactions.delete(id);
    }

    this.rateLimiter.cleanup();
    this.signatureCache._evictExpired();
  }

  async _pollForEvents() {
    if (!this.isRunning) return;

    try {
      const contractInterface = new ContractInterface(
        this.config.contractAbi,
        this.config.contractAddress,
        this.config.provider
      );

      const pendingTransactions = await contractInterface.getPendingTransactions();
      
      for (const tx of pendingTransactions) {
        if (!this.pendingTransactions.has(tx.consensusId)) {
          await this.submitTransaction(tx.transaction);
        }
      }
    } catch (error) {
      this._emitError('poll_events', error, {});
    }
  }

  async _collectSignatures() {
    if (!this.isRunning) return;

    try {
      for (const [id, data] of this.pendingTransactions.entries()) {
        if (data.status === 'pending') {
          const { signatures, collectedCount, requiredQuorum } = await this._collectSignatures(
            data.transactionHash,
            id
          );

          if (collectedCount >= requiredQuorum) {
            await this._executeConsensus(data.transaction, id);
          }
        }
      }
    } catch (error) {
      this._emitError('collect_signatures', error, {});
    }
  }

  getStats() {
    return {
      pendingTransactions: this.pendingTransactions.size,
      registeredAgents: this.agentRegistry.size,
      consensusHistoryLength: this.consensusHistory.length,
      signatureCacheSize: this.signatureCache.size(),
      rateLimitWindow: this.rateLimiter.windowMs,
      rateLimitMaxCalls: this.rateLimiter.maxCalls,
      isRunning: this.isRunning,
      quorumPercentage: this.config.quorumPercentage,
      stateScoreThreshold: this.config.stateScoreThreshold,
    };
  }
}

export { ConsensusEngine, RateLimiter, SignatureCache };