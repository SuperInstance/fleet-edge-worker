var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.ts
var AGENT_PORTS = {
  "fleet-midi": { agent: "fleet-midi", port: 8101, host: "localhost", capabilities: ["chord", "fx", "melody", "rhythm"] },
  "ghost-track": { agent: "ghost-track", port: 8102, host: "localhost", capabilities: ["accompaniment", "variation"] },
  "persona-engine": { agent: "persona-engine", port: 8103, host: "localhost", capabilities: ["persona", "voice"] },
  "fleet-conductor": { agent: "fleet-conductor", port: 8104, host: "localhost", capabilities: ["conduct", "schedule", "tempo"] },
  "forgemaster": { agent: "forgemaster", port: 8105, host: "localhost", capabilities: ["forge", "build", "compile"] },
  "oracle2": { agent: "oracle2", port: 8106, host: "oracle2.local", capabilities: ["infer", "voice-to-midi"] },
  "construct": { agent: "construct", port: 8107, host: "localhost", capabilities: ["coordinate", "dispatch"] }
};
var ACTION_REGISTRY = [
  { name: "chord_request", app: "midi-editor", target: "fleet-midi/chord", mapper: chordMapper },
  { name: "fx_apply", app: "midi-editor", target: "fleet-midi/fx", mapper: fxMapper },
  { name: "generate_accomp", app: "arranger", target: "ghost-track", mapper: accompanimentMapper },
  { name: "set_persona", app: "settings", target: "persona-engine", mapper: personaMapper },
  { name: "conduct_session", app: "conductor", target: "fleet-conductor", mapper: conductorMapper },
  { name: "forge_build", app: "build-panel", target: "forgemaster", mapper: forgeMapper },
  { name: "voice_to_midi", app: "recorder", target: "oracle2", mapper: voiceMidiMapper },
  { name: "fleet_status", app: "dashboard", target: "construct", mapper: statusMapper },
  { name: "tempo_change", app: "transport", target: "fleet-conductor", mapper: tempoMapper },
  { name: "melody_gen", app: "midi-editor", target: "fleet-midi/melody", mapper: melodyMapper },
  { name: "rhythm_pattern", app: "drum-editor", target: "fleet-midi/rhythm", mapper: rhythmMapper },
  { name: "variation_request", app: "arranger", target: "ghost-track", mapper: variationMapper },
  { name: "schedule_change", app: "calendar", target: "fleet-conductor", mapper: scheduleMapper },
  { name: "compile_target", app: "build-panel", target: "forgemaster", mapper: compileMapper },
  { name: "dispatch_custom", app: "terminal", target: "construct", mapper: customMapper },
  { name: "ping", app: "any", target: "construct", mapper: pingMapper }
];
function makeBottle(source, target, action, payload) {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source,
    target,
    action,
    payload,
    status: "outgoing",
    ttl: 3600
    // 1 hour default
  };
}
__name(makeBottle, "makeBottle");
function chordMapper(p) {
  return makeBottle("edge", "fleet-midi/chord", "chord_request", p);
}
__name(chordMapper, "chordMapper");
function fxMapper(p) {
  return makeBottle("edge", "fleet-midi/fx", "fx_apply", p);
}
__name(fxMapper, "fxMapper");
function accompanimentMapper(p) {
  return makeBottle("edge", "ghost-track", "generate_accomp", p);
}
__name(accompanimentMapper, "accompanimentMapper");
function personaMapper(p) {
  return makeBottle("edge", "persona-engine", "set_persona", p);
}
__name(personaMapper, "personaMapper");
function conductorMapper(p) {
  return makeBottle("edge", "fleet-conductor", "conduct_session", p);
}
__name(conductorMapper, "conductorMapper");
function forgeMapper(p) {
  return makeBottle("edge", "forgemaster", "forge_build", p);
}
__name(forgeMapper, "forgeMapper");
function voiceMidiMapper(p) {
  return makeBottle("edge", "oracle2", "voice_to_midi", p);
}
__name(voiceMidiMapper, "voiceMidiMapper");
function statusMapper(p) {
  return makeBottle("edge", "construct", "fleet_status", p);
}
__name(statusMapper, "statusMapper");
function tempoMapper(p) {
  return makeBottle("edge", "fleet-conductor", "tempo_change", p);
}
__name(tempoMapper, "tempoMapper");
function melodyMapper(p) {
  return makeBottle("edge", "fleet-midi/melody", "melody_gen", p);
}
__name(melodyMapper, "melodyMapper");
function rhythmMapper(p) {
  return makeBottle("edge", "fleet-midi/rhythm", "rhythm_pattern", p);
}
__name(rhythmMapper, "rhythmMapper");
function variationMapper(p) {
  return makeBottle("edge", "ghost-track", "variation_request", p);
}
__name(variationMapper, "variationMapper");
function scheduleMapper(p) {
  return makeBottle("edge", "fleet-conductor", "schedule_change", p);
}
__name(scheduleMapper, "scheduleMapper");
function compileMapper(p) {
  return makeBottle("edge", "forgemaster", "compile_target", p);
}
__name(compileMapper, "compileMapper");
function customMapper(p) {
  return makeBottle("edge", "construct", "dispatch_custom", p);
}
__name(customMapper, "customMapper");
function pingMapper(p) {
  return makeBottle("edge", "construct", "ping", { ...p, pong: true });
}
__name(pingMapper, "pingMapper");
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    if (path === "/dispatch" && request.method === "POST") {
      return await handleDispatch(request, env, corsHeaders);
    }
    if (path === "/dispatch/smart" && request.method === "POST") {
      return await handleSmartDispatch(request, env, corsHeaders);
    }
    if (path === "/context" && request.method === "POST") {
      return await handleContext(request, env, corsHeaders);
    }
    if (path === "/status" && request.method === "GET") {
      return await handleStatus(env, corsHeaders);
    }
    if (path === "/agents" && request.method === "GET") {
      return jsonResponse({ agents: AGENT_PORTS }, corsHeaders);
    }
    if (path === "/actions" && request.method === "GET") {
      const actions = ACTION_REGISTRY.map((a) => ({ name: a.name, app: a.app, target: a.target }));
      return jsonResponse({ actions, count: actions.length }, corsHeaders);
    }
    if (path.startsWith("/bottles/") && request.method === "GET") {
      const agent = path.split("/bottles/")[1];
      return await handleBottlePoll(agent, env, corsHeaders);
    }
    if (path.startsWith("/bottles/") && request.method === "PUT") {
      const bottleId = path.split("/bottles/")[1];
      return await handleBottleConfirm(bottleId, request, env, corsHeaders);
    }
    if (path === "/health") {
      return jsonResponse({
        status: "ok",
        version: env.VERSION,
        fleet: env.FLEET_NAME,
        timestamp: Date.now(),
        uptime: "edge"
      }, corsHeaders);
    }
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal Server Error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}
__name(handleRequest, "handleRequest");
async function handleDispatch(request, env, headers) {
  const body = await request.json();
  const { action, payload = {}, source = "http" } = body;
  const entry = ACTION_REGISTRY.find((a) => a.name === action);
  if (!entry) {
    return jsonResponse({ error: `Unknown action: ${action}`, available: ACTION_REGISTRY.map((a) => a.name) }, headers, 400);
  }
  const bottle = entry.mapper(payload);
  bottle.source = source;
  const kvKey = `bottle:${bottle.target}:${bottle.id}`;
  await env.FLEET_KV.put(kvKey, JSON.stringify(bottle), { expirationTtl: bottle.ttl });
  if (env.VESSELS) {
    await env.VESSELS.put(`outgoing/${bottle.id}.json`, JSON.stringify(bottle, null, 2), {
      customMetadata: { target: bottle.target, action: bottle.action, status: bottle.status }
    });
  }
  const inboxKey = `inbox:${bottle.target}`;
  const existingRaw = await env.FLEET_KV.get(inboxKey);
  const existing = existingRaw ? JSON.parse(existingRaw) : [];
  existing.push(bottle.id);
  const trimmed = existing.slice(-100);
  await env.FLEET_KV.put(inboxKey, JSON.stringify(trimmed), { expirationTtl: 86400 });
  const metricsKey = `metrics:dispatch:${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}`;
  const metricsRaw = await env.FLEET_KV.get(metricsKey);
  const metrics = metricsRaw ? JSON.parse(metricsRaw) : { count: 0, actions: {} };
  metrics.count++;
  metrics.actions[action] = (metrics.actions[action] || 0) + 1;
  await env.FLEET_KV.put(metricsKey, JSON.stringify(metrics), { expirationTtl: 604800 });
  return jsonResponse({
    ok: true,
    bottle: { id: bottle.id, target: bottle.target, action: bottle.action, status: bottle.status },
    dispatched_at: bottle.timestamp
  }, headers);
}
__name(handleDispatch, "handleDispatch");
async function handleStatus(env, headers) {
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  const metricsKey = `metrics:dispatch:${today}`;
  const metricsRaw = await env.FLEET_KV.get(metricsKey);
  const metrics = metricsRaw ? JSON.parse(metricsRaw) : { count: 0, actions: {} };
  let pendingCount = 0;
  for (const agentName of Object.keys(AGENT_PORTS)) {
    const inboxKey = `inbox:${agentName}`;
    const inboxRaw = await env.FLEET_KV.get(inboxKey);
    if (inboxRaw) {
      const ids = JSON.parse(inboxRaw);
      pendingCount += ids.length;
    }
  }
  return jsonResponse({
    fleet: env.FLEET_NAME,
    version: env.VERSION,
    status: "operational",
    agents: Object.keys(AGENT_PORTS).length,
    actions_registered: ACTION_REGISTRY.length,
    dispatches_today: metrics.count,
    pending_bottles: pendingCount,
    timestamp: Date.now()
  }, headers);
}
__name(handleStatus, "handleStatus");
async function handleBottlePoll(agent, env, headers) {
  if (!AGENT_PORTS[agent]) {
    const matching = Object.keys(AGENT_PORTS).filter((a) => agent.startsWith(a));
    if (matching.length === 0) {
      return jsonResponse({ error: `Unknown agent: ${agent}` }, headers, 404);
    }
  }
  const inboxKey = `inbox:${agent}`;
  const inboxRaw = await env.FLEET_KV.get(inboxKey);
  if (!inboxRaw) {
    return jsonResponse({ bottles: [], count: 0 }, headers);
  }
  const bottleIds = JSON.parse(inboxRaw);
  const bottles = [];
  for (const id of bottleIds.slice(-20)) {
    const kvKey = `bottle:${agent}:${id}`;
    const raw = await env.FLEET_KV.get(kvKey);
    if (raw) {
      bottles.push(JSON.parse(raw));
    }
  }
  return jsonResponse({ bottles, count: bottles.length }, headers);
}
__name(handleBottlePoll, "handleBottlePoll");
async function handleBottleConfirm(bottleId, request, env, headers) {
  const body = await request.json();
  const kvKey = `bottle:${body.agent}:${bottleId}`;
  const raw = await env.FLEET_KV.get(kvKey);
  if (!raw) {
    return jsonResponse({ error: "Bottle not found" }, headers, 404);
  }
  const bottle = JSON.parse(raw);
  bottle.status = body.status;
  await env.FLEET_KV.put(kvKey, JSON.stringify(bottle), { expirationTtl: 3600 });
  if (env.VESSELS) {
    await env.VESSELS.put(`outgoing/${bottleId}.json`, JSON.stringify(bottle, null, 2), {
      customMetadata: { target: bottle.target, action: bottle.action, status: bottle.status }
    });
  }
  return jsonResponse({ ok: true, bottle_id: bottleId, status: bottle.status }, headers);
}
__name(handleBottleConfirm, "handleBottleConfirm");
function jsonResponse(data, headers, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}
__name(jsonResponse, "jsonResponse");
var AgentHub = class {
  state;
  sessions = /* @__PURE__ */ new Set();
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader && upgradeHeader === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.sessions.add(server);
      server.accept();
      server.addEventListener("close", () => {
        this.sessions.delete(server);
      });
      server.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          for (const session of this.sessions) {
            if (session !== server) {
              session.send(JSON.stringify(data));
            }
          }
          this.state.storage.put(`msg:${Date.now()}`, data);
        } catch {
        }
      });
      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }
    return new Response("Expected WebSocket upgrade", { status: 400 });
  }
  async alarm() {
    this.sessions.clear();
  }
};
__name(AgentHub, "AgentHub");
async function handleSmartDispatch(request, env, headers) {
  const body = await request.json();
  const { query, payload = {}, topK = 3 } = body;
  if (!query)
    return jsonResponse({ error: "Query required" }, headers, 400);
  let searchResults = { results: [], count: 0 };
  if (env.AI && env.VECTORIZE) {
    try {
      const embedResp = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
        text: [query]
      });
      const vector = embedResp.data[0];
      const vMatches = await env.VECTORIZE.query(vector, { topK: topK * 2, returnMetadata: "all" });
      const vResults = Array.isArray(vMatches) ? vMatches : vMatches.results || vMatches.matches || [];
      searchResults = {
        results: vResults.map((m) => ({
          id: m.id,
          score: m.score,
          description: m.metadata?.description
        })),
        count: vResults.length
      };
    } catch (e) {
    }
  } else if (env.VECTOR_API_SERVICE) {
    try {
      const searchResp = await env.VECTOR_API_SERVICE.fetch(
        new Request("https://fleet-vector-api.casey-digennaro.workers.dev/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, topK: topK * 2 })
        })
      );
      if (searchResp.ok) {
        searchResults = await searchResp.json();
      }
    } catch (e) {
    }
  }
  const agentScores = {};
  for (const result of searchResults.results || []) {
    const crateName = result.id;
    for (const [agentName, agentPort] of Object.entries(AGENT_PORTS)) {
      for (const cap of agentPort.capabilities) {
        if (crateName.includes(cap) || crateName.includes(agentName.split("-")[0])) {
          agentScores[agentName] = (agentScores[agentName] || 0) + result.score;
        }
      }
      const agentKeywords = {
        "fleet-midi": ["midi", "music", "chord", "audio"],
        "ghost-track": ["ghost", "track", "session", "memory", "temporal"],
        "persona-engine": ["persona", "identity", "profile"],
        "fleet-conductor": ["conductor", "orchestrat", "schedule", "fleet", "dispatch"],
        "forgemaster": ["forge", "build", "generat", "code"],
        "oracle2": ["oracle", "predict", "inference", "weather"],
        "construct": ["construct", "spatial", "voxel", "sheaf", "cohomology", "hodge", "spectral", "laplacian", "constraint", "ternary", "conservation"]
      };
      const keywords = agentKeywords[agentName] || [];
      for (const kw of keywords) {
        if (crateName.includes(kw)) {
          agentScores[agentName] = (agentScores[agentName] || 0) + result.score * 0.5;
        }
      }
    }
  }
  const ranked = Object.entries(agentScores).sort(([, a], [, b]) => b - a).map(([agent, score]) => ({ agent, score }));
  if (ranked.length === 0) {
    ranked.push({ agent: "construct", score: 0 });
  }
  const bestAgent = ranked[0].agent;
  const target = AGENT_PORTS[bestAgent] ? `${bestAgent}` : "construct";
  const bottle = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source: "smart-dispatch",
    target,
    action: query,
    payload: { ...payload, _context: searchResults.results.slice(0, 5).map((r) => r.id), _confidence: ranked[0].score },
    status: "outgoing",
    ttl: 3600
  };
  const kvKey = `bottle:${target}:${bottle.id}`;
  await env.FLEET_KV.put(kvKey, JSON.stringify(bottle), { expirationTtl: bottle.ttl });
  const inboxKey = `inbox:${target}`;
  const existingRaw = await env.FLEET_KV.get(inboxKey);
  const existing = existingRaw ? JSON.parse(existingRaw) : [];
  existing.push(bottle.id);
  await env.FLEET_KV.put(inboxKey, JSON.stringify(existing.slice(-100)), { expirationTtl: 86400 });
  const metricsKey = `metrics:smart:${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}`;
  const metricsRaw = await env.FLEET_KV.get(metricsKey);
  const metrics = metricsRaw ? JSON.parse(metricsRaw) : { count: 0, queries: {} };
  metrics.count++;
  metrics.queries[query.slice(0, 50)] = (metrics.queries[query.slice(0, 50)] || 0) + 1;
  await env.FLEET_KV.put(metricsKey, JSON.stringify(metrics), { expirationTtl: 604800 });
  return jsonResponse({
    ok: true,
    query,
    routed_to: target,
    confidence: ranked[0].score,
    context_crates: searchResults.results.slice(0, 5).map((r) => ({ name: r.id, score: r.score })),
    ranked_agents: ranked.slice(0, 5),
    bottle: { id: bottle.id, target, status: bottle.status }
  }, headers);
}
__name(handleSmartDispatch, "handleSmartDispatch");
async function handleContext(request, env, headers) {
  const { query, topK = 10 } = await request.json();
  if (!query)
    return jsonResponse({ error: "Query required" }, headers, 400);
  if (env.AI && env.VECTORIZE) {
    try {
      const embedResp = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [query] });
      const vector = embedResp.data[0];
      const matches = await env.VECTORIZE.query(vector, { topK, returnMetadata: "all" });
      const results = Array.isArray(matches) ? matches : matches.results || matches.matches || [];
      return jsonResponse({
        query,
        results: results.map((m) => ({
          name: m.id,
          score: m.score,
          description: m.metadata?.description
        })),
        count: results.length,
        powered_by: "direct-vectorize"
      }, headers);
    } catch (e) {
      return jsonResponse({ error: `Vectorize error: ${e.message}` }, headers, 500);
    }
  }
  return jsonResponse({ error: "Vectorize not configured" }, headers, 501);
}
__name(handleContext, "handleContext");
var worker_default = {
  fetch: handleRequest
};
export {
  AgentHub,
  worker_default as default
};
//# sourceMappingURL=worker.js.map
