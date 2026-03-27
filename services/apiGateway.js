import { createServer, createSecureServer } from 'https';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream } from 'fs';
import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === CONFIGURATION CONSTANTS ===
const API_VERSION = 'v1';
const API_KEY_PREFIX = 'sk_live_';
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 100;
const RATE_LIMIT_BURST = 20;
const REQUEST_TIMEOUT_MS = 30000;
const SIGNATURE_VALIDITY_SECONDS = 300;
const API_KEY_HASH_SALT = 'swarmlock-api-key-derivation-salt-v1';
const RATE_LIMIT_STORAGE_KEY_PREFIX = 'ratelimit:';
const API_KEY_STORAGE_KEY = 'api_keys.json';
const STATE_STORAGE_KEY = 'api_state.json';
const DATA_DIR = join(__dirname, '..', 'data');
const CERTS_DIR = join(__dirname, '..', 'certs');

// === CRYPTOGRAPHIC PRIMITIVES ===
const CRYPTO_ALGORITHMS = {
  hash: 'sha256',
  hmac: 'sha256',
  encryption: 'aes-256-gcm'
};

// === PERSISTENT STORAGE LAYER ===
class PersistentStorage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.ensureDataDir();
    this.apiKeys = this.loadOrInit(API_KEY_STORAGE_KEY, []);
    this.state = this.loadOrInit(STATE_STORAGE_KEY, {
      intents: {},
      votes: {},
      agentStates: {},
      rateLimits: {}
    });
  }

  ensureDataDir() {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  loadOrInit(filename, defaultValue) {
    const filePath = join(this.dataDir, filename);
    try {
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error(`Storage load error for ${filename}:`, error.message);
    }
    return defaultValue;
  }

  save(filename, data) {
    const filePath = join(this.dataDir, filename);
    try {
      writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error(`Storage save error for ${filename}:`, error.message);
      throw new Error(`Failed to persist ${filename}`);
    }
  }

  // === API KEY MANAGEMENT ===
  generateApiKey(secret) {
    const keyId = uuidv4();
    const keyHash = createHash(CRYPTO_ALGORITHMS.hash)
      .update(`${API_KEY_PREFIX}${keyId}:${secret}:${API_KEY_HASH_SALT}`)
      .digest('hex');
    
    const apiKey = `${API_KEY_PREFIX}${keyId}`;
    const apiSecret = secret;
    
    this.apiKeys.push({
      id: keyId,
      hash: keyHash,
      secret: apiSecret,
      createdAt: Date.now(),
      lastUsed: null,
      permissions: ['read', 'write', 'admin'],
      isActive: true
    });
    
    this.save(API_KEY_STORAGE_KEY, this.apiKeys);
    return { apiKey, apiSecret };
  }

  verifyApiKey(apiKey, secret) {
    const keyId = apiKey.replace(API_KEY_PREFIX, '');
    const key = this.apiKeys.find(k => k.id === keyId && k.isActive);
    
    if (!key) return null;
    
    const expectedHash = createHash(CRYPTO_ALGORITHMS.hash)
      .update(`${API_KEY_PREFIX}${keyId}:${secret}:${API_KEY_HASH_SALT}`)
      .digest('hex');
    
    if (key.hash !== expectedHash) return null;
    
    key.lastUsed = Date.now();
    this.save(API_KEY_STORAGE_KEY, this.apiKeys);
    return key;
  }

  // === RATE LIMITING ===
  checkRateLimit(clientId) {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    
    if (!this.state.rateLimits[clientId]) {
      this.state.rateLimits[clientId] = { requests: [], burstTokens: RATE_LIMIT_BURST };
    }
    
    const client = this.state.rateLimits[clientId];
    client.requests = client.requests.filter(ts => ts > windowStart);
    
    if (client.requests.length >= RATE_LIMIT_MAX_REQUESTS) {
      return { allowed: false, retryAfter: Math.ceil((client.requests[0] - windowStart) / 1000) };
    }
    
    if (client.burstTokens <= 0) {
      return { allowed: false, retryAfter: 1 };
    }
    
    client.requests.push(now);
    client.burstTokens--;
    this.save(STATE_STORAGE_KEY, this.state);
    
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - client.requests.length };
  }

  // === STATE MANAGEMENT ===
  storeIntent(intentId, intentData) {
    this.state.intents[intentId] = {
      ...intentData,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.save(STATE_STORAGE_KEY, this.state);
  }

  getIntent(intentId) {
    return this.state.intents[intentId] || null;
  }

  storeVote(voteId, voteData) {
    this.state.votes[voteId] = {
      ...voteData,
      createdAt: Date.now()
    };
    this.save(STATE_STORAGE_KEY, this.state);
  }

  getVote(voteId) {
    return this.state.votes[voteId] || null;
  }

  storeAgentState(agentId, stateData) {
    this.state.agentStates[agentId] = {
      ...stateData,
      updatedAt: Date.now()
    };
    this.save(STATE_STORAGE_KEY, this.state);
  }

  getAgentState(agentId) {
    return this.state.agentStates[agentId] || null;
  }

  getAllAgentStates() {
    return this.state.agentStates;
  }
}

// === REQUEST VALIDATION ===
class RequestValidator {
  constructor() {
    this.signatureHeader = 'X-SwarmLock-Signature';
    this.timestampHeader = 'X-SwarmLock-Timestamp';
  }

  validateSignature(request, secret) {
    const timestamp = request.headers[this.timestampHeader];
    const signature = request.headers[this.signatureHeader];
    
    if (!timestamp || !signature) return false;
    
    const timestampNum = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    
    if (Math.abs(now - timestampNum) > SIGNATURE_VALIDITY_SECONDS) {
      return false;
    }
    
    const body = JSON.stringify(request.body || {});
    const message = `${timestamp}:${body}`;
    const expectedSignature = createHmac(CRYPTO_ALGORITHMS.hmac, secret)
      .update(message)
      .digest('hex');
    
    return signature === expectedSignature;
  }

  validateBody(request, schema) {
    const errors = [];
    
    for (const [field, rules] of Object.entries(schema)) {
      const value = request.body[field];
      
      if (rules.required && (value === undefined || value === null)) {
        errors.push(`${field} is required`);
        continue;
      }
      
      if (value !== undefined && rules.type) {
        const actualType = typeof value;
        if (rules.type === 'array' && !Array.isArray(value)) {
          errors.push(`${field} must be an array`);
        } else if (rules.type === 'object' && typeof value !== 'object') {
          errors.push(`${field} must be an object`);
        } else if (rules.type === 'string' && typeof value !== 'string') {
          errors.push(`${field} must be a string`);
        } else if (rules.type === 'number' && typeof value !== 'number') {
          errors.push(`${field} must be a number`);
        }
      }
      
      if (value !== undefined && rules.minLength && typeof value === 'string') {
        if (value.length < rules.minLength) {
          errors.push(`${field} must be at least ${rules.minLength} characters`);
        }
      }
      
      if (value !== undefined && rules.maxLength && typeof value === 'string') {
        if (value.length > rules.maxLength) {
          errors.push(`${field} must be at most ${rules.maxLength} characters`);
        }
      }
    }
    
    return { valid: errors.length === 0, errors };
  }
}

// === API GATEWAY ===
class ApiGateway {
  constructor() {
    this.storage = new PersistentStorage(DATA_DIR);
    this.validator = new RequestValidator();
    this.server = null;
    this.wss = null;
    this.routes = new Map();
    this.middlewares = [];
    this.setupRoutes();
  }

  setupRoutes() {
    // Health check
    this.routes.set('GET /health', this.handleHealth.bind(this));
    
    // API Key management
    this.routes.set('POST /api/v1/keys', this.handleCreateApiKey.bind(this));
    this.routes.set('GET /api/v1/keys', this.handleListKeys.bind(this));
    this.routes.set('DELETE /api/v1/keys/:id', this.handleDeleteApiKey.bind(this));
    
    // Intent management
    this.routes.set('POST /api/v1/intents', this.handleCreateIntent.bind(this));
    this.routes.set('GET /api/v1/intents/:id', this.handleGetIntent.bind(this));
    this.routes.set('GET /api/v1/intents', this.handleListIntents.bind(this));
    
    // Consensus status
    this.routes.set('GET /api/v1/consensus/:intentId', this.handleGetConsensusStatus.bind(this));
    this.routes.set('POST /api/v1/consensus/:intentId/vote', this.handleSubmitVote.bind(this));
    
    // Agent state
    this.routes.set('GET /api/v1/agents', this.handleListAgents.bind(this));
    this.routes.set('GET /api/v1/agents/:id', this.handleGetAgent.bind(this));
    this.routes.set('POST /api/v1/agents/:id/state', this.handleUpdateAgentState.bind(this));
    
    // WebSocket endpoint
    this.routes.set('WS /ws', this.handleWebSocket.bind(this));
  }

  addMiddleware(middleware) {
    this.middlewares.push(middleware);
  }

  async handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const method = request.method;
    const path = url.pathname;
    const fullRoute = `${method} ${path}`;
    
    // Rate limiting
    const clientId = request.socket.remoteAddress || 'unknown';
    const rateLimit = this.storage.checkRateLimit(clientId);
    
    if (!rateLimit.allowed) {
      response.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': rateLimit.retryAfter.toString()
      });
      response.end(JSON.stringify({
        error: 'rate_limit_exceeded',
        message: 'Too many requests. Please retry after some time.',
        retryAfter: rateLimit.retryAfter
      }));
      return;
    }
    
    // Find matching route
    let routeHandler = null;
    for (const [route, handler] of this.routes) {
      const [routeMethod, routePath] = route.split(' ');
      if (routeMethod !== method) continue;
      
      if (routePath === path) {
        routeHandler = handler;
        break;
      }
      
      // Handle dynamic routes
      const routePattern = routePath.replace(/:(\w+)/g, '([^/]+)');
      const match = path.match(new RegExp(`^${routePattern}$`));
      if (match) {
        routeHandler = handler;
        break;
      }
    }
    
    if (!routeHandler) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found', message: 'Endpoint not found' }));
      return;
    }
    
    // Apply middlewares
    for (const middleware of this.middlewares) {
      const result = await middleware(request, response);
      if (result === false) return;
    }
    
    // Read request body
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      body = await this.readRequestBody(request);
    }
    
    request.body = body;
    
    // Execute route handler
    try {
      await routeHandler(request, response, url);
    } catch (error) {
      console.error('Route handler error:', error);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        error: 'internal_server_error',
        message: error.message || 'An unexpected error occurred'
      }));
    }
  }

  async readRequestBody(request) {
    return new Promise((resolve, reject) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          resolve({});
        }
      });
      request.on('error', reject);
    });
  }

  sendJson(response, statusCode, data) {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-SwarmLock-Signature, X-SwarmLock-Timestamp, Authorization'
    });
    response.end(JSON.stringify(data));
  }

  // === ROUTE HANDLERS ===
  async handleHealth(request, response) {
    this.sendJson(response, 200, {
      status: 'healthy',
      version: API_VERSION,
      timestamp: Date.now(),
      uptime: process.uptime()
    });
  }

  async handleCreateApiKey(request, response) {
    const validation = this.validator.validateBody(request, {
      name: { required: true, type: 'string', minLength: 1, maxLength: 100 },
      permissions: { type: 'array' }
    });
    
    if (!validation.valid) {
      this.sendJson(response, 400, { error: 'validation_error', errors: validation.errors });
      return;
    }
    
    const secret = randomBytes(32).toString('hex');
    const { apiKey, apiSecret } = this.storage.generateApiKey(secret);
    
    this.sendJson(response, 201, {
      message: 'API key created successfully',
      apiKey,
      apiSecret,
      warning: 'Store apiSecret securely. It will not be shown again.'
    });
  }

  async handleListKeys(request, response) {
    const keys = this.storage.apiKeys.map(k => ({
      id: k.id,
      createdAt: k.createdAt,
      lastUsed: k.lastUsed,
      permissions: k.permissions,
      isActive: k.isActive
    }));
    
    this.sendJson(response, 200, { keys });
  }

  async handleDeleteApiKey(request, response, url) {
    const keyId = url.pathname.split('/').pop();
    const key = this.storage.apiKeys.find(k => k.id === keyId);
    
    if (!key) {
      this.sendJson(response, 404, { error: 'not_found', message: 'API key not found' });
      return;
    }
    
    key.isActive = false;
    this.storage.save(API_KEY_STORAGE_KEY, this.storage.apiKeys);
    
    this.sendJson(response, 200, { message: 'API key revoked successfully' });
  }

  async handleCreateIntent(request, response) {
    const validation = this.validator.validateBody(request, {
      description: { required: true, type: 'string', minLength: 1, maxLength: 1000 },
      action: { required: true, type: 'object' },
      requiredQuorum: { required: true, type: 'number', minLength: 1 },
      deadline: { type: 'number' }
    });
    
    if (!validation.valid) {
      this.sendJson(response, 400, { error: 'validation_error', errors: validation.errors });
      return;
    }
    
    const intentId = uuidv4();
    const intentData = {
      ...request.body,
      status: 'pending',
      votes: [],
      requiredQuorum: request.body.requiredQuorum,
      deadline: request.body.deadline || Date.now() + 3600000
    };
    
    this.storage.storeIntent(intentId, intentData);
    
    this.sendJson(response, 201, {
      message: 'Intent created successfully',
      intentId,
      status: intentData.status
    });
  }

  async handleGetIntent(request, response, url) {
    const intentId = url.pathname.split('/').pop();
    const intent = this.storage.getIntent(intentId);
    
    if (!intent) {
      this.sendJson(response, 404, { error: 'not_found', message: 'Intent not found' });
      return;
    }
    
    this.sendJson(response, 200, { intent });
  }

  async handleListIntents(request, response) {
    const intents = Object.values(this.storage.state.intents);
    this.sendJson(response, 200, { intents, count: intents.length });
  }

  async handleGetConsensusStatus(request, response, url) {
    const intentId = url.pathname.split('/').pop();
    const intent = this.storage.getIntent(intentId);
    
    if (!intent) {
      this.sendJson(response, 404, { error: 'not_found', message: 'Intent not found' });
      return;
    }
    
    const agentStates = this.storage.getAllAgentStates();
    const totalWeight = Object.values(agentStates).reduce((sum, state) => 
      sum + (state.capabilityScore || 0), 0);
    
    const currentWeight = intent.votes.reduce((sum, vote) => 
      sum + (vote.agentWeight || 0), 0);
    
    this.sendJson(response, 200, {
      intentId,
      status: intent.status,
      votes: intent.votes.length,
      requiredQuorum: intent.requiredQuorum,
      currentWeight,
      totalWeight,
      progress: totalWeight > 0 ? (currentWeight / totalWeight) * 100 : 0,
      deadline: intent.deadline
    });
  }

  async handleSubmitVote(request, response, url) {
    const intentId = url.pathname.split('/').pop();
    const intent = this.storage.getIntent(intentId);
    
    if (!intent) {
      this.sendJson(response, 404, { error: 'not_found', message: 'Intent not found' });
      return;
    }
    
    const validation = this.validator.validateBody(request, {
      agentId: { required: true, type: 'string' },
      vote: { required: true, type: 'string' },
      signature: { required: true, type: 'string' },
      stateHash: { required: true, type: 'string' }
    });
    
    if (!validation.valid) {
      this.sendJson(response, 400, { error: 'validation_error', errors: validation.errors });
      return;
    }
    
    const voteId = uuidv4();
    const voteData = {
      ...request.body,
      intentId,
      voteId,
      timestamp: Date.now()
    };
    
    this.storage.storeVote(voteId, voteData);
    intent.votes.push(voteData);
    this.storage.storeIntent(intentId, intent);
    
    this.sendJson(response, 200, {
      message: 'Vote submitted successfully',
      voteId,
      status: 'recorded'
    });
  }

  async handleListAgents(request, response) {
    const agents = Object.values(this.storage.getAllAgentStates());
    this.sendJson(response, 200, { agents, count: agents.length });
  }

  async handleGetAgent(request, response, url) {
    const agentId = url.pathname.split('/').pop();
    const agent = this.storage.getAgentState(agentId);
    
    if (!agent) {
      this.sendJson(response, 404, { error: 'not_found', message: 'Agent not found' });
      return;
    }
    
    this.sendJson(response, 200, { agent });
  }

  async handleUpdateAgentState(request, response, url) {
    const agentId = url.pathname.split('/').pop();
    
    const validation = this.validator.validateBody(request, {
      capabilityScore: { required: true, type: 'number', minLength: 0, maxLength: 10000 },
      stateHash: { required: true, type: 'string' },
      healthScore: { required: true, type: 'number', minLength: 0, maxLength: 1 }
    });
    
    if (!validation.valid) {
      this.sendJson(response, 400, { error: 'validation_error', errors: validation.errors });
      return;
    }
    
    const stateData = {
      ...request.body,
      agentId,
      lastUpdated: Date.now()
    };
    
    this.storage.storeAgentState(agentId, stateData);
    
    this.sendJson(response, 200, {
      message: 'Agent state updated successfully',
      agentId,
      capabilityScore: request.body.capabilityScore
    });
  }

  async handleWebSocket(request, response, url) {
    const wss = new WebSocketServer({ server: this.server, path: '/ws' });
    
    wss.on('connection', (ws) => {
      console.log('WebSocket client connected');
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          console.log('Received WebSocket message:', message);
          
          if (message.type === 'subscribe') {
            ws.send(JSON.stringify({
              type: 'subscribed',
              channels: message.channels || ['consensus', 'agent-state']
            }));
          } else if (message.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      });
      
      ws.on('close', () => {
        console.log('WebSocket client disconnected');
      });
      
      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });
    
    this.wss = wss;
  }

  async startServer(port, options = {}) {
    const { useTLS = false, certPath, keyPath } = options;
    
    const serverOptions = useTLS ? {
      key: readFileSync(keyPath || join(CERTS_DIR, 'server.key'), 'utf8'),
      cert: readFileSync(certPath || join(CERTS_DIR, 'server.crt'), 'utf8')
    } : {};
    
    this.server = createSecureServer(serverOptions, (req, res) => {
      this.handleRequest(req, res);
    });
    
    this.server.listen(port, () => {
      console.log(`API Gateway listening on port ${port}`);
      console.log(`TLS enabled: ${useTLS}`);
      console.log(`API Version: ${API_VERSION}`);
    });
    
    this.server.on('error', (error) => {
      console.error('Server error:', error);
    });
    
    return this.server;
  }

  async stopServer() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}

// === EXPORT ===
export const apiGateway = new ApiGateway();
export { PersistentStorage, RequestValidator };