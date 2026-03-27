import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { AgentState } from './agent.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const STATE_HASH_VERSION = 'swarmlock-v1';
const STATE_HASH_SALT = 'agent-state-weighted-consensus';
const HEALTH_CHECK_INTERVAL = 5000;
const STATE_UPDATE_INTERVAL = 10000;
const MIN_CAPABILITY_SCORE = 100;
const MAX_CAPABILITY_SCORE = 10000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const STATE_VERIFICATION_TIMEOUT = 30000;
const RPC_TIMEOUT_MS = 10000;

class ContractInterface {
  constructor(abi, contractAddress, provider) {
    this.abi = abi;
    this.contractAddress = contractAddress;
    this.provider = provider;
    this._cache = new Map();
    this._cacheTTL = 5000;
    this._pendingRequests = new Map();
  }

  async _fetchWithRetry(method, params, retries = 0) {
    const requestId = uuidv4();
    const timeoutId = setTimeout(() => {
      this._pendingRequests.delete(requestId);
    }, RPC_TIMEOUT_MS);

    try {
      const response = await fetch(this.provider, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params
        }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`RPC error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`RPC error: ${data.error.code} ${data.error.message}`);
      }

      return data.result;
    } catch (error) {
      if (retries < MAX_RETRY_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (retries + 1)));
        return this._fetchWithRetry(method, params, retries + 1);
      }
      throw error;
    }
  }

  async call(method, params) {
    const cacheKey = `${method}:${JSON.stringify(params)}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this._cacheTTL) {
      return cached.value;
    }

    const result = await this._fetchWithRetry(method, params);
    this._cache.set(cacheKey, { value: result, timestamp: Date.now() });
    return result;
  }

  async getAgentState(agentAddress) {
    const result = await this.call('eth_call', [{
      to: this.contractAddress,
      data: `0x${this._encodeFunctionData('agent', [agentAddress])}`
    }]);
    return this._decodeAgentState(result);
  }

  async updateAgentState(agentAddress, stateHash, capabilityScore) {
    const txHash = await this.call('eth_sendTransaction', [{
      to: this.contractAddress,
      data: this._encodeFunctionData('updateAgentState', [agentAddress, stateHash, capabilityScore]),
      from: agentAddress
    }]);
    return txHash;
  }

  async getEventLogs(eventFilter) {
    const result = await this.call('eth_getLogs', [eventFilter]);
    return result.map(log => this._parseLog(log));
  }

  _encodeFunctionData(functionName, args) {
    const functionAbi = this.abi.find(item => item.type === 'function' && item.name === functionName);
    if (!functionAbi) {
      throw new Error(`Function ${functionName} not found in ABI`);
    }

    const selector = createHash('sha256')
      .update(`${functionName}(${functionAbi.inputs.map(i => i.type).join(',')})`)
      .digest('hex')
      .slice(0, 8);

    let encoded = `0x${selector}`;
    let offset = 32;

    for (let i = 0; i < functionAbi.inputs.length; i++) {
      const input = functionAbi.inputs[i];
      const value = args[i];

      if (input.type === 'address') {
        encoded += value.slice(2).padStart(64, '0');
      } else if (input.type === 'uint256') {
        encoded += BigInt(value).toString(16).padStart(64, '0');
      } else if (input.type === 'bytes32') {
        encoded += value.slice(2).padStart(64, '0');
      } else {
        encoded += value.slice(2).padStart(64, '0');
      }
    }

    return encoded;
  }

  _decodeAgentState(data) {
    const publicKey = `0x${data.slice(2, 66)}`;
    const capabilityScore = BigInt(data.slice(66, 130)).toString();
    const stateHash = `0x${data.slice(130, 194)}`;
    const lastStateTimestamp = BigInt(data.slice(194, 258)).toString();
    const isActive = data.slice(258, 260) !== '00';

    return {
      publicKey,
      capabilityScore: Number(capabilityScore),
      stateHash,
      lastStateTimestamp: Number(lastStateTimestamp),
      isActive
    };
  }

  _parseLog(log) {
    return {
      address: log.address,
      data: log.data,
      topics: log.topics,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex
    };
  }
}

class HealthMonitor {
  constructor(agent) {
    this.agent = agent;
    this.metrics = {
      uptime: 1.0,
      errorRate: 0.0,
      requestLatency: 0.0,
      memoryUsage: 0.0,
      cpuUsage: 0.0
    };
    this.startTime = Date.now();
    this.errorCount = 0;
    this.requestCount = 0;
    this.totalLatency = 0;
  }

  recordRequest(latency) {
    this.requestCount++;
    this.totalLatency += latency;
    this.metrics.requestLatency = this.totalLatency / this.requestCount;
  }

  recordError() {
    this.errorCount++;
    this.metrics.errorRate = this.errorCount / Math.max(1, this.requestCount);
  }

  calculateHealthScore() {
    const uptime = (Date.now() - this.startTime) / 1000 / 3600;
    this.metrics.uptime = Math.min(1.0, uptime / 24);

    const errorPenalty = this.metrics.errorRate * 0.5;
    const latencyPenalty = Math.min(0.3, this.metrics.requestLatency / 1000);
    const baseScore = 1.0 - errorPenalty - latencyPenalty;

    return Math.max(0, Math.min(1, baseScore));
  }

  getHealthMetrics() {
    return {
      ...this.metrics,
      healthScore: this.calculateHealthScore(),
      uptime: this.metrics.uptime
    };
  }
}

class StateUpdateListener {
  constructor(contractInterface, agentAddress) {
    this.contractInterface = contractInterface;
    this.agentAddress = agentAddress;
    this.listeners = new Map();
    this.running = false;
    this.pollInterval = 5000;
  }

  addListener(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  removeListener(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.set(event, this.listeners.get(event).filter(cb => cb !== callback));
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this._poll();
  }

  async stop() {
    this.running = false;
  }

  async _poll() {
    if (!this.running) return;

    try {
      const filter = {
        fromBlock: 'latest',
        toBlock: 'latest',
        address: this.contractInterface.contractAddress,
        topics: [this._getEventSignature('StateUpdate')]
      };

      const logs = await this.contractInterface.getEventLogs(filter);
      logs.forEach(log => this._handleLog(log));
    } catch (error) {
      console.error('StateUpdateListener poll error:', error.message);
    }

    setTimeout(() => this._poll(), this.pollInterval);
  }

  _getEventSignature(eventName) {
    const eventAbi = this.contractInterface.abi.find(item => item.type === 'event' && item.name === eventName);
    if (!eventAbi) {
      throw new Error(`Event ${eventName} not found in ABI`);
    }

    const signature = createHash('sha256')
      .update(`${eventName}(${eventAbi.inputs.map(i => i.type).join(',')})`)
      .digest('hex');

    return `0x${signature}`;
  }

  _handleLog(log) {
    const eventAbi = this.contractInterface.abi.find(item => item.type === 'event' && item.name === 'StateUpdate');
    if (!eventAbi) return;

    const topics = log.topics;
    const values = [];
    let offset = 32;

    for (let i = 0; i < eventAbi.inputs.length; i++) {
      const input = eventAbi.inputs[i];
      if (input.indexed) {
        values.push(topics[i + 1]);
      } else {
        values.push(`0x${log.data.slice(offset, offset + 64)}`);
        offset += 64;
      }
    }

    const parsed = {
      agentAddress: values[0],
      stateHash: values[1],
      capabilityScore: values[2],
      timestamp: values[3],
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash
    };

    this.listeners.get('StateUpdate')?.forEach(callback => {
      try {
        callback(parsed);
      } catch (error) {
        console.error('StateUpdate listener error:', error.message);
      }
    });
  }
}

class AgentStateService {
  constructor(config) {
    this.config = config;
    this.agent = new AgentState(config.agentId, config.capabilities);
    this.contractInterface = new ContractInterface(
      config.abi,
      config.contractAddress,
      config.provider
    );
    this.healthMonitor = new HealthMonitor(this.agent);
    this.stateUpdateListener = new StateUpdateListener(
      this.contractInterface,
      config.agentAddress
    );
    this.running = false;
    this.updateInterval = null;
    this.healthCheckInterval = null;
  }

  async initialize() {
    try {
      const agentState = await this.contractInterface.getAgentState(this.config.agentAddress);
      this.agent.capabilityScore = agentState.capabilityScore;
      this.agent.stateTimestamp = agentState.lastStateTimestamp;
      this.agent.lastStateHash = agentState.stateHash;

      this.stateUpdateListener.addListener('StateUpdate', this._handleStateUpdate.bind(this));
      await this.stateUpdateListener.start();

      this._startPeriodicUpdates();
      this.running = true;
      console.log(`AgentStateService initialized for agent ${this.config.agentId}`);
    } catch (error) {
      console.error('AgentStateService initialization failed:', error.message);
      throw error;
    }
  }

  async _handleStateUpdate(event) {
    if (event.agentAddress.toLowerCase() !== this.config.agentAddress.toLowerCase()) {
      return;
    }

    try {
      const stateHash = event.stateHash;
      const capabilityScore = Number(event.capabilityScore);

      if (stateHash !== this.agent.lastStateHash) {
        this.agent.lastStateHash = stateHash;
        this.agent.capabilityScore = capabilityScore;
        this.agent.stateTimestamp = Number(event.timestamp);

        console.log(`StateUpdate received: capabilityScore=${capabilityScore}`);
      }
    } catch (error) {
      console.error('Error handling StateUpdate:', error.message);
    }
  }

  _startPeriodicUpdates() {
    this.healthCheckInterval = setInterval(() => {
      this._performHealthCheck();
    }, HEALTH_CHECK_INTERVAL);

    this.updateInterval = setInterval(() => {
      this._performStateUpdate();
    }, STATE_UPDATE_INTERVAL);
  }

  async _performHealthCheck() {
    try {
      const start = Date.now();
      const metrics = this.healthMonitor.getHealthMetrics();
      const healthScore = metrics.healthScore;

      this.healthMonitor.recordRequest(Date.now() - start);

      if (healthScore < 0.5) {
        this.healthMonitor.recordError();
      }

      const newCapabilityScore = Math.floor(healthScore * MAX_CAPABILITY_SCORE);
      const adjustedScore = Math.max(MIN_CAPABILITY_SCORE, Math.min(MAX_CAPABILITY_SCORE, newCapabilityScore));

      if (adjustedScore !== this.agent.capabilityScore) {
        this.agent.capabilityScore = adjustedScore;
        this.agent.updateHealth(healthScore);
      }
    } catch (error) {
      console.error('Health check failed:', error.message);
      this.healthMonitor.recordError();
    }
  }

  async _performStateUpdate() {
    try {
      const stateHash = this.agent.computeStateHash();
      const capabilityScore = this.agent.capabilityScore;

      const txHash = await this.contractInterface.updateAgentState(
        this.config.agentAddress,
        stateHash,
        capabilityScore
      );

      console.log(`StateUpdate transaction sent: ${txHash}`);
      this.agent.stateTimestamp = Date.now();
      this.agent.lastStateHash = stateHash;
    } catch (error) {
      console.error('StateUpdate transaction failed:', error.message);
    }
  }

  getAgentState() {
    return {
      id: this.agent.id,
      capabilities: this.agent.capabilities,
      healthScore: this.agent.healthScore,
      capabilityScore: this.agent.capabilityScore,
      lastStateHash: this.agent.lastStateHash,
      stateTimestamp: this.agent.stateTimestamp,
      nonce: this.agent.nonce
    };
  }

  async updateCapabilities(newCapabilities) {
    this.agent.updateCapabilities(newCapabilities);
    await this._performStateUpdate();
  }

  async updateHealth(healthScore) {
    this.agent.updateHealth(healthScore);
    await this._performStateUpdate();
  }

  async stop() {
    this.running = false;
    this.stateUpdateListener.stop();
    clearInterval(this.healthCheckInterval);
    clearInterval(this.updateInterval);
    console.log(`AgentStateService stopped for agent ${this.config.agentId}`);
  }

  async getCapabilityScore() {
    return this.agent.capabilityScore;
  }

  async verifyStateIntegrity() {
    const localHash = this.agent.computeStateHash();
    const onChainState = await this.contractInterface.getAgentState(this.config.agentAddress);

    return {
      localHash,
      onChainHash: onChainState.stateHash,
      match: localHash === onChainState.stateHash.slice(2),
      capabilityScore: onChainState.capabilityScore
    };
  }
}

export { AgentStateService, ContractInterface, HealthMonitor, StateUpdateListener };