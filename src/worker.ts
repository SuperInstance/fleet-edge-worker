/**
 * Fleet Edge Worker — Cloudflare Worker for SuperInstance fleet coordination
 *
 * Routes vessel bottles, dispatches actions to fleet agents,
 * and serves fleet status at the edge.
 *
 * Architecture:
 *   HTTP Request → Router → Action Handler → Bottle → KV/R2 → Agent notification
 *
 * Conservation law: every action in = exactly one bottle out (γ + η = C)
 */

// ─── Governor Import ────────────────────────────────────────────────────

import { handleGovernorStatus, handleGovernorTick, handleGovernorConfig } from './pid-governor';

// ─── Types ────────────────────────────────────────────────────────────────

interface Env {
  FLEET_KV: KVNamespace;
  VESSELS?: R2Bucket;
  AGENT_HUB?: DurableObjectNamespace;
  VECTOR_API_SERVICE?: Fetcher;
  VECTORIZE?: VectorizeIndex;
  AI?: any; // Workers AI
  VERSION: string;
  FLEET_NAME: string;
  VECTOR_API: string;
}

interface Bottle {
  id: string;
  timestamp: number;
  source: string;
  target: string;
  action: string;
  payload: Record<string, unknown>;
  status: 'outgoing' | 'delivered' | 'consumed' | 'error';
  ttl: number; // seconds until expiry
}

interface AgentPort {
  agent: string;
  port: number;
  host: string;
  capabilities: string[];
}

interface FleetAction {
  name: string;
  app: string;
  target: string;
  mapper: (payload: Record<string, unknown>) => Bottle;
}

// ─── Agent Registry ──────────────────────────────────────────────────────

const AGENT_PORTS: Record<string, AgentPort> = {
  'fleet-midi':      { agent: 'fleet-midi',      port: 8101, host: 'localhost', capabilities: ['chord', 'fx', 'melody', 'rhythm'] },
  'ghost-track':     { agent: 'ghost-track',     port: 8102, host: 'localhost', capabilities: ['accompaniment', 'variation'] },
  'persona-engine':  { agent: 'persona-engine',  port: 8103, host: 'localhost', capabilities: ['persona', 'voice'] },
  'fleet-conductor': { agent: 'fleet-conductor', port: 8104, host: 'localhost', capabilities: ['conduct', 'schedule', 'tempo'] },
  'forgemaster':     { agent: 'forgemaster',     port: 8105, host: 'localhost', capabilities: ['forge', 'build', 'compile'] },
  'oracle2':         { agent: 'oracle2',         port: 8106, host: 'oracle2.local', capabilities: ['infer', 'voice-to-midi'] },
  'construct':       { agent: 'construct',       port: 8107, host: 'localhost', capabilities: ['coordinate', 'dispatch'] },
};

// ─── Action Registry (mirrors i2iDispatcher) ────────────────────────────

const ACTION_REGISTRY: FleetAction[] = [
  { name: 'chord_request',     app: 'midi-editor',   target: 'fleet-midi/chord',     mapper: chordMapper },
  { name: 'fx_apply',          app: 'midi-editor',   target: 'fleet-midi/fx',        mapper: fxMapper },
  { name: 'generate_accomp',   app: 'arranger',      target: 'ghost-track',          mapper: accompanimentMapper },
  { name: 'set_persona',       app: 'settings',      target: 'persona-engine',       mapper: personaMapper },
  { name: 'conduct_session',   app: 'conductor',     target: 'fleet-conductor',      mapper: conductorMapper },
  { name: 'forge_build',       app: 'build-panel',   target: 'forgemaster',          mapper: forgeMapper },
  { name: 'voice_to_midi',     app: 'recorder',      target: 'oracle2',              mapper: voiceMidiMapper },
  { name: 'fleet_status',      app: 'dashboard',     target: 'construct',            mapper: statusMapper },
  { name: 'tempo_change',      app: 'transport',     target: 'fleet-conductor',      mapper: tempoMapper },
  { name: 'melody_gen',        app: 'midi-editor',   target: 'fleet-midi/melody',    mapper: melodyMapper },
  { name: 'rhythm_pattern',    app: 'drum-editor',   target: 'fleet-midi/rhythm',    mapper: rhythmMapper },
  { name: 'variation_request', app: 'arranger',      target: 'ghost-track',          mapper: variationMapper },
  { name: 'schedule_change',   app: 'calendar',      target: 'fleet-conductor',      mapper: scheduleMapper },
  { name: 'compile_target',    app: 'build-panel',   target: 'forgemaster',          mapper: compileMapper },
  { name: 'dispatch_custom',   app: 'terminal',      target: 'construct',            mapper: customMapper },
  { name: 'ping',              app: 'any',           target: 'construct',            mapper: pingMapper },
];

// ─── Mappers ──────────────────────────────────────────────────────────────

function makeBottle(source: string, target: string, action: string, payload: Record<string, unknown>): Bottle {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source,
    target,
    action,
    payload,
    status: 'outgoing',
    ttl: 3600, // 1 hour default
  };
}

function chordMapper(p: Record<string, unknown>)    { return makeBottle('edge', 'fleet-midi/chord',  'chord_request', p); }
function fxMapper(p: Record<string, unknown>)       { return makeBottle('edge', 'fleet-midi/fx',     'fx_apply', p); }
function accompanimentMapper(p: Record<string, unknown>) { return makeBottle('edge', 'ghost-track', 'generate_accomp', p); }
function personaMapper(p: Record<string, unknown>)  { return makeBottle('edge', 'persona-engine', 'set_persona', p); }
function conductorMapper(p: Record<string, unknown>){ return makeBottle('edge', 'fleet-conductor', 'conduct_session', p); }
function forgeMapper(p: Record<string, unknown>)    { return makeBottle('edge', 'forgemaster',     'forge_build', p); }
function voiceMidiMapper(p: Record<string, unknown>){ return makeBottle('edge', 'oracle2',         'voice_to_midi', p); }
function statusMapper(p: Record<string, unknown>)   { return makeBottle('edge', 'construct',       'fleet_status', p); }
function tempoMapper(p: Record<string, unknown>)    { return makeBottle('edge', 'fleet-conductor', 'tempo_change', p); }
function melodyMapper(p: Record<string, unknown>)   { return makeBottle('edge', 'fleet-midi/melody','melody_gen', p); }
function rhythmMapper(p: Record<string, unknown>)   { return makeBottle('edge', 'fleet-midi/rhythm','rhythm_pattern', p); }
function variationMapper(p: Record<string, unknown>){ return makeBottle('edge', 'ghost-track',     'variation_request', p); }
function scheduleMapper(p: Record<string, unknown>) { return makeBottle('edge', 'fleet-conductor', 'schedule_change', p); }
function compileMapper(p: Record<string, unknown>)  { return makeBottle('edge', 'forgemaster',     'compile_target', p); }
function customMapper(p: Record<string, unknown>)   { return makeBottle('edge', 'construct',       'dispatch_custom', p); }
function pingMapper(p: Record<string, unknown>)     { return makeBottle('edge', 'construct',       'ping', { ...p, pong: true }); }

// ─── Router ───────────────────────────────────────────────────────────────

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS headers for all responses
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Route dispatch
    if (path === '/dispatch' && request.method === 'POST') {
      return await handleDispatch(request, env, corsHeaders);
    }

    // Smart dispatch — vector-aware routing
    if (path === '/dispatch/smart' && request.method === 'POST') {
      return await handleSmartDispatch(request, env, corsHeaders);
    }

    // Context lookup — semantic search proxy
    if (path === '/context' && request.method === 'POST') {
      return await handleContext(request, env, corsHeaders);
    }

    // Fleet status
    if (path === '/status' && request.method === 'GET') {
      return await handleStatus(env, corsHeaders);
    }

    // List agents
    if (path === '/agents' && request.method === 'GET') {
      return jsonResponse({ agents: AGENT_PORTS }, corsHeaders);
    }

    // List actions
    if (path === '/actions' && request.method === 'GET') {
      const actions = ACTION_REGISTRY.map(a => ({ name: a.name, app: a.app, target: a.target }));
      return jsonResponse({ actions, count: actions.length }, corsHeaders);
    }

    // Bottle inbox (poll for bottles)
    if (path.startsWith('/bottles/') && request.method === 'GET') {
      const agent = path.split('/bottles/')[1];
      return await handleBottlePoll(agent, env, corsHeaders);
    }

    // Bottle delivery confirmation
    if (path.startsWith('/bottles/') && request.method === 'PUT') {
      const bottleId = path.split('/bottles/')[1];
      return await handleBottleConfirm(bottleId, request, env, corsHeaders);
    }

    // Baton bridge — Loom I2I protocol ingress
    if (path === '/baton' && request.method === 'POST') {
      const { handleBatonRequest } = await import('./baton-bridge');
      return await handleBatonRequest(request, env as any, corsHeaders);
    }

    // Baton response — return path for Loom delivery
    if (path === '/baton/response' && request.method === 'POST') {
      const { handleBatonResponse } = await import('./baton-bridge');
      return await handleBatonResponse(request, env as any, corsHeaders);
    }

    // PID Fleet Governor — status
    if (path === '/governor' && request.method === 'GET') {
      return await handleGovernorStatus(env, corsHeaders);
    }

    // PID Fleet Governor — run a tick (cron or manual)
    if (path === '/governor/tick' && request.method === 'POST') {
      return await handleGovernorTick(env, corsHeaders);
    }

    // PID Fleet Governor — update config
    if (path === '/governor/config' && request.method === 'POST') {
      return await handleGovernorConfig(request, env, corsHeaders);
    }

    // Health check
    if (path === '/health') {
      return jsonResponse({
        status: 'ok',
        version: env.VERSION,
        fleet: env.FLEET_NAME,
        timestamp: Date.now(),
        uptime: 'edge',
      }, corsHeaders);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

// ─── Dispatch Handler ─────────────────────────────────────────────────────

async function handleDispatch(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const body = await request.json() as { action: string; payload?: Record<string, unknown>; source?: string };
  const { action, payload = {}, source = 'http' } = body;

  // Find matching action
  const entry = ACTION_REGISTRY.find(a => a.name === action);
  if (!entry) {
    return jsonResponse({ error: `Unknown action: ${action}`, available: ACTION_REGISTRY.map(a => a.name) }, headers, 400);
  }

  // Create bottle via mapper
  const bottle = entry.mapper(payload);
  bottle.source = source;

  // Persist to KV (by target agent for polling)
  const kvKey = `bottle:${bottle.target}:${bottle.id}`;
  await env.FLEET_KV.put(kvKey, JSON.stringify(bottle), { expirationTtl: bottle.ttl });

  // Also store in R2 for durable log (if available)
  if (env.VESSELS) {
    await env.VESSELS.put(`outgoing/${bottle.id}.json`, JSON.stringify(bottle, null, 2), {
      customMetadata: { target: bottle.target, action: bottle.action, status: bottle.status },
    });
  }

  // Update target agent's inbox index
  const inboxKey = `inbox:${bottle.target}`;
  const existingRaw = await env.FLEET_KV.get(inboxKey);
  const existing: string[] = existingRaw ? JSON.parse(existingRaw) : [];
  existing.push(bottle.id);
  const trimmed = existing.slice(-100);
  await env.FLEET_KV.put(inboxKey, JSON.stringify(trimmed), { expirationTtl: 86400 });

  // Update fleet metrics
  const metricsKey = `metrics:dispatch:${new Date().toISOString().split('T')[0]}`;
  const metricsRaw = await env.FLEET_KV.get(metricsKey);
  const metrics = metricsRaw ? JSON.parse(metricsRaw) : { count: 0, actions: {} };
  metrics.count++;
  metrics.actions[action] = (metrics.actions[action] || 0) + 1;
  await env.FLEET_KV.put(metricsKey, JSON.stringify(metrics), { expirationTtl: 604800 });

  return jsonResponse({
    ok: true,
    bottle: { id: bottle.id, target: bottle.target, action: bottle.action, status: bottle.status },
    dispatched_at: bottle.timestamp,
  }, headers);
}

// ─── Status Handler ───────────────────────────────────────────────────────

async function handleStatus(env: Env, headers: Record<string, string>): Promise<Response> {
  // Gather fleet metrics + pending counts in parallel (single batch)
  const today = new Date().toISOString().split('T')[0];
  const metricsKey = `metrics:dispatch:${today}`;
  const inboxKeys = Object.keys(AGENT_PORTS).map(a => `inbox:${a}`);
  const allKeys = [metricsKey, ...inboxKeys];

  const results = await env.FLEET_KV.list({ prefix: 'metrics:dispatch:' });
  const metricsRaw = await env.FLEET_KV.get(metricsKey);
  const metrics = metricsRaw ? JSON.parse(metricsRaw) : { count: 0, actions: {} };

  // Batch-read all inboxes concurrently instead of sequential loop
  let pendingCount = 0;
  const inboxResults = await Promise.all(
    inboxKeys.map(k => env.FLEET_KV.get(k))
  );
  for (const raw of inboxResults) {
    if (raw) {
      try {
        const ids: string[] = JSON.parse(raw);
        pendingCount += ids.length;
      } catch { /* skip malformed */ }
    }
  }

  return jsonResponse({
    fleet: env.FLEET_NAME,
    version: env.VERSION,
    status: 'operational',
    agents: Object.keys(AGENT_PORTS).length,
    actions_registered: ACTION_REGISTRY.length,
    dispatches_today: metrics.count,
    pending_bottles: pendingCount,
    timestamp: Date.now(),
  }, headers);
}

// ─── Bottle Poll ──────────────────────────────────────────────────────────

async function handleBottlePoll(agent: string, env: Env, headers: Record<string, string>): Promise<Response> {
  // Validate agent
  if (!AGENT_PORTS[agent]) {
    // Check if it's a target path like fleet-midi/chord
    const matching = Object.keys(AGENT_PORTS).filter(a => agent.startsWith(a));
    if (matching.length === 0) {
      return jsonResponse({ error: `Unknown agent: ${agent}` }, headers, 404);
    }
  }

  const inboxKey = `inbox:${agent}`;
  const inboxRaw = await env.FLEET_KV.get(inboxKey);

  if (!inboxRaw) {
    return jsonResponse({ bottles: [], count: 0 }, headers);
  }

  const bottleIds: string[] = JSON.parse(inboxRaw);
  const bottles: Bottle[] = [];

  for (const id of bottleIds.slice(-20)) { // Last 20 bottles
    const kvKey = `bottle:${agent}:${id}`;
    const raw = await env.FLEET_KV.get(kvKey);
    if (raw) {
      bottles.push(JSON.parse(raw));
    }
  }

  return jsonResponse({ bottles, count: bottles.length }, headers);
}

// ─── Bottle Confirm ───────────────────────────────────────────────────────

async function handleBottleConfirm(bottleId: string, request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const body = await request.json() as { status: 'delivered' | 'consumed' | 'error'; agent: string };
  const kvKey = `bottle:${body.agent}:${bottleId}`;
  const raw = await env.FLEET_KV.get(kvKey);

  if (!raw) {
    return jsonResponse({ error: 'Bottle not found' }, headers, 404);
  }

  const bottle: Bottle = JSON.parse(raw);
  bottle.status = body.status;

  await env.FLEET_KV.put(kvKey, JSON.stringify(bottle), { expirationTtl: 3600 });

  // Update R2 status (if available)
  if (env.VESSELS) {
    await env.VESSELS.put(`outgoing/${bottleId}.json`, JSON.stringify(bottle, null, 2), {
      customMetadata: { target: bottle.target, action: bottle.action, status: bottle.status },
    });
  }

  return jsonResponse({ ok: true, bottle_id: bottleId, status: bottle.status }, headers);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// ─── Durable Object: AgentHub ─────────────────────────────────────────────

export class AgentHub implements DurableObject {
  private state: DurableObjectState;
  private sessions: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    // WebSocket upgrade for real-time agent notifications
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      this.sessions.add(server);
      server.accept();

      server.addEventListener('close', () => {
        this.sessions.delete(server);
      });

      // Broadcast to all connected agents
      server.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data as string);
          for (const session of this.sessions) {
            if (session !== server) {
              session.send(JSON.stringify(data));
            }
          }
          // Also persist to storage
          this.state.storage.put(`msg:${Date.now()}`, data);
        } catch {
          // Invalid JSON, ignore
        }
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response('Expected WebSocket upgrade', { status: 400 });
  }

  async alarm(): Promise<void> {
    // Periodic cleanup of expired sessions
    this.sessions.clear();
  }
}

// ─── Smart Dispatch (vector-aware routing) ────────────────────────────

interface VectorSearchResult {
  id: string;
  score: number;
  description?: string;
}

async function handleSmartDispatch(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const body = await request.json() as { query: string; payload?: Record<string, unknown>; topK?: number };
  const { query, payload = {}, topK = 3 } = body;

  if (!query) return jsonResponse({ error: 'Query required' }, headers, 400);

  // Step 1: Find semantically similar crates via direct Vectorize
  let searchResults: { results: VectorSearchResult[]; count: number } = { results: [], count: 0 };
  
  if (env.AI && env.VECTORIZE) {
    try {
      // Generate embedding with Workers AI
      const embedResp: any = await env.AI.run('@cf/baai/bge-small-en-v1.5', {
        text: [query],
      });
      const vector = embedResp.data[0];
      
      // Query Vectorize directly
      const vMatches: any = await env.VECTORIZE.query(vector, { topK: topK * 2, returnMetadata: 'all' });
      const vResults = Array.isArray(vMatches) ? vMatches : (vMatches.results || vMatches.matches || []);
      searchResults = {
        results: vResults.map((m: any) => ({
          id: m.id,
          score: m.score,
          description: m.metadata?.description,
        })),
        count: vResults.length,
      };
    } catch (e) {
      // Vectorize unavailable — fall back to direct routing
    }
  } else if (env.VECTOR_API_SERVICE) {
    try {
      const searchResp = await env.VECTOR_API_SERVICE.fetch(
        new Request('https://fleet-vector-api.casey-digennaro.workers.dev/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, topK: topK * 2 }),
        })
      );
      if (searchResp.ok) {
        searchResults = await searchResp.json() as { results: VectorSearchResult[]; count: number };
      }
    } catch (e) {
      // Service binding unavailable
    }
  }

  // Step 2: Score agents by semantic similarity to crate capabilities
  const agentScores: Record<string, number> = {};
  for (const result of searchResults.results || []) {
    const crateName = result.id;
    for (const [agentName, agentPort] of Object.entries(AGENT_PORTS)) {
      // Match by capability keywords
      for (const cap of agentPort.capabilities) {
        if (crateName.includes(cap) || crateName.includes(agentName.split('-')[0])) {
          agentScores[agentName] = (agentScores[agentName] || 0) + result.score;
        }
      }
      // Also match by crate name keywords to agent name
      const agentKeywords: Record<string, string[]> = {
        'fleet-midi': ['midi', 'music', 'chord', 'audio'],
        'ghost-track': ['ghost', 'track', 'session', 'memory', 'temporal'],
        'persona-engine': ['persona', 'identity', 'profile'],
        'fleet-conductor': ['conductor', 'orchestrat', 'schedule', 'fleet', 'dispatch'],
        'forgemaster': ['forge', 'build', 'generat', 'code'],
        'oracle2': ['oracle', 'predict', 'inference', 'weather'],
        'construct': ['construct', 'spatial', 'voxel', 'sheaf', 'cohomology', 'hodge', 'spectral', 'laplacian', 'constraint', 'ternary', 'conservation'],
      };
      const keywords = agentKeywords[agentName] || [];
      for (const kw of keywords) {
        if (crateName.includes(kw)) {
          agentScores[agentName] = (agentScores[agentName] || 0) + result.score * 0.5;
        }
      }
    }
  }

  // Step 3: Rank agents and pick the best
  const ranked = Object.entries(agentScores)
    .sort(([,a], [,b]) => b - a)
    .map(([agent, score]) => ({ agent, score }));

  if (ranked.length === 0) {
    ranked.push({ agent: 'construct', score: 0 });
  }

  const bestAgent = ranked[0].agent;
  const target = AGENT_PORTS[bestAgent] ? `${bestAgent}` : 'construct';

  // Step 4: Create and dispatch bottle
  const bottle: Bottle = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source: 'smart-dispatch',
    target,
    action: query,
    payload: { ...payload, _context: searchResults.results.slice(0, 5).map(r => r.id), _confidence: ranked[0].score },
    status: 'outgoing',
    ttl: 3600,
  };

  // Persist bottle + inbox + metrics concurrently
  const kvKey = `bottle:${target}:${bottle.id}`;
  const inboxKey = `inbox:${target}`;
  const existingRaw = await env.FLEET_KV.get(inboxKey);
  const existing: string[] = existingRaw ? JSON.parse(existingRaw) : [];
  existing.push(bottle.id);

  const metricsKey = `metrics:smart:${new Date().toISOString().split('T')[0]}`;
  const metricsRaw = await env.FLEET_KV.get(metricsKey);
  const metrics = metricsRaw ? JSON.parse(metricsRaw) : { count: 0, queries: {} };
  metrics.count++;
  metrics.queries[query.slice(0, 50)] = (metrics.queries[query.slice(0, 50)] || 0) + 1;

  await Promise.all([
    env.FLEET_KV.put(kvKey, JSON.stringify(bottle), { expirationTtl: bottle.ttl }),
    env.FLEET_KV.put(inboxKey, JSON.stringify(existing.slice(-100)), { expirationTtl: 86400 }),
    env.FLEET_KV.put(metricsKey, JSON.stringify(metrics), { expirationTtl: 604800 }),
  ]);

  return jsonResponse({
    ok: true,
    query,
    routed_to: target,
    confidence: ranked[0].score,
    context_crates: searchResults.results.slice(0, 5).map((r: any) => ({ name: r.id, score: r.score })),
    ranked_agents: ranked.slice(0, 5),
    bottle: { id: bottle.id, target, status: bottle.status },
  }, headers);
}

// ─── Context Lookup ──────────────────────────────────────────────────────

async function handleContext(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const { query, topK = 10 } = await request.json() as { query: string; topK?: number };
  if (!query) return jsonResponse({ error: 'Query required' }, headers, 400);

  // Direct Vectorize query
  if (env.AI && env.VECTORIZE) {
    try {
      const embedResp: any = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [query] });
      const vector = embedResp.data[0];
      const matches: any = await env.VECTORIZE.query(vector, { topK, returnMetadata: 'all' });
      const results = Array.isArray(matches) ? matches : (matches.results || matches.matches || []);
      return jsonResponse({
        query,
        results: results.map((m: any) => ({
          name: m.id,
          score: m.score,
          description: m.metadata?.description,
        })),
        count: results.length,
        powered_by: 'direct-vectorize',
      }, headers);
    } catch (e: any) {
      return jsonResponse({ error: `Vectorize error: ${e.message}` }, headers, 500);
    }
  }
  return jsonResponse({ error: 'Vectorize not configured' }, headers, 501);
}

// ─── Export ────────────────────────────────────────────────────────────────

export default {
  fetch: handleRequest,
};
