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

// ─── Types ────────────────────────────────────────────────────────────────

interface Env {
  FLEET_KV: KVNamespace;
  VESSELS: R2Bucket;
  AGENT_HUB: DurableObjectNamespace;
  VERSION: string;
  FLEET_NAME: string;
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

  // Also store in R2 for durable log
  await env.VESSELS.put(`outgoing/${bottle.id}.json`, JSON.stringify(bottle, null, 2), {
    customMetadata: { target: bottle.target, action: bottle.action, status: bottle.status },
  });

  // Update target agent's inbox index
  const inboxKey = `inbox:${bottle.target}`;
  const existingRaw = await env.FLEET_KV.get(inboxKey);
  const existing: string[] = existingRaw ? JSON.parse(existingRaw) : [];
  existing.push(bottle.id);
  // Keep only last 100 bottles in inbox index
  const trimmed = existing.slice(-100);
  await env.FLEET_KV.put(inboxKey, JSON.stringify(trimmed), { expirationTtl: 86400 });

  // Update fleet metrics
  const metricsKey = `metrics:dispatch:${new Date().toISOString().split('T')[0]}`;
  const metricsRaw = await env.FLEET_KV.get(metricsKey);
  const metrics = metricsRaw ? JSON.parse(metricsRaw) : { count: 0, actions: {} };
  metrics.count++;
  metrics.actions[action] = (metrics.actions[action] || 0) + 1;
  await env.FLEET_KV.put(metricsKey, JSON.stringify(metrics), { expirationTtl: 604800 }); // 7 days

  return jsonResponse({
    ok: true,
    bottle: { id: bottle.id, target: bottle.target, action: bottle.action, status: bottle.status },
    dispatched_at: bottle.timestamp,
  }, headers);
}

// ─── Status Handler ───────────────────────────────────────────────────────

async function handleStatus(env: Env, headers: Record<string, string>): Promise<Response> {
  // Gather fleet metrics
  const today = new Date().toISOString().split('T')[0];
  const metricsKey = `metrics:dispatch:${today}`;
  const metricsRaw = await env.FLEET_KV.get(metricsKey);
  const metrics = metricsRaw ? JSON.parse(metricsRaw) : { count: 0, actions: {} };

  // Count pending bottles
  let pendingCount = 0;
  for (const agentName of Object.keys(AGENT_PORTS)) {
    const inboxKey = `inbox:${agentName}`;
    const inboxRaw = await env.FLEET_KV.get(inboxKey);
    if (inboxRaw) {
      const ids: string[] = JSON.parse(inboxRaw);
      pendingCount += ids.length;
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

  // Update R2 status
  await env.VESSELS.put(`outgoing/${bottleId}.json`, JSON.stringify(bottle, null, 2), {
    customMetadata: { target: bottle.target, action: bottle.action, status: bottle.status },
  });

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

// ─── Export ────────────────────────────────────────────────────────────────

export default {
  fetch: handleRequest,
};
