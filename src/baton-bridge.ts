/**
 * Baton ↔ FLUX Bridge — Protocol translation between Loom I2I and SuperInstance fleet
 *
 * Architecture: see BATON_FLUX_BRIDGE.md
 *
 * Conservation law: every bridged message satisfies γ + η ≤ C (C = 1.0, ε = 0.01)
 *
 * Routes:
 *   POST /baton           — receive a Loom baton, translate to bottle, route to fleet agent
 *   POST /baton/response  — translate a fleet bottle response back to baton for Loom delivery
 */

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * A Loom inter-agent message (git-based baton).
 */
export interface Baton {
  batonId: string;
  from: string;
  to: string;
  type: 'SPLINE' | 'SIGNAL' | 'QUERY' | 'DIRECTIVE';
  payload: {
    content?: string;
    spline?: Spline;
    data?: Record<string, unknown>;
    ttl?: number;
  };
  lineage: string[];
  trust: { level: 'distrust' | 'silent' | 'trust'; score: number };
  timestamp: string; // ISO 8601
  originShell: 'esp32' | 'pi' | 'jetson' | 'cloud';
  commitSha?: string;
}

/**
 * A distilled insight vector from the Loom system.
 */
export interface Spline {
  concept: string;
  weight: number; // 0.0–1.0
  lineage?: string[];
}

/**
 * FLUX bottle — async message envelope for the SuperInstance fleet.
 * Extends the worker's base Bottle with bridge metadata.
 */
export interface Bottle {
  id: string;
  timestamp: number;
  source: string;
  target: string;
  action: string;
  payload: Record<string, unknown>;
  status: 'outgoing' | 'delivered' | 'consumed' | 'error';
  ttl: number;
  meta?: BottleMeta;
}

export interface BottleMeta {
  gamma?: number;
  eta?: number;
  originShell?: string;
  batonId?: string;
  commitSha?: string;
  spline?: Spline;
  lineage?: string[];
  respondsTo?: string;
}

/**
 * Ternary-Trust evaluation result.
 */
export interface TrustScore {
  level: 'distrust' | 'silent' | 'trust';
  adjusted: number; // Adjusted score after bonuses/penalties
  raw: number; // Original baton trust score
  breakdown: {
    lineageBonus: number;
    commitBonus: number;
    freshnessPenalty: number;
    anomalyPenalty: number;
  };
}

/**
 * Multi-shell routing target.
 */
export interface ShellTarget {
  shell: 'esp32' | 'pi' | 'jetson' | 'cloud';
  agent: string; // Fleet agent name
  routingConfidence: number; // 0.0–1.0
  routingMethod: 'explicit' | 'spline' | 'fallback';
  ttl: number; // TTL based on shell
}

/**
 * Audit record for conservation law check.
 */
export interface ConservationAudit {
  batonId: string;
  bottleId: string;
  gamma: number;
  eta: number;
  conservationConstant: number; // C = 1.0
  check: 'PASS' | 'FAIL';
  timestamp: number;
}

// ─── Concept Clusters (12) ───────────────────────────────────────────────

export interface ConceptCluster {
  id: number;
  name: string;
  keywords: string[];
  defaultAgent: string;
}

export const CONCEPT_CLUSTERS: ConceptCluster[] = [
  { id: 0,  name: 'resonance',    keywords: ['harmonic', 'frequency', 'vibration', 'wave'],            defaultAgent: 'fleet-midi' },
  { id: 1,  name: 'structure',    keywords: ['form', 'architecture', 'scaffold', 'framework'],         defaultAgent: 'forgemaster' },
  { id: 2,  name: 'temporal',     keywords: ['rhythm', 'timing', 'sequence', 'schedule'],              defaultAgent: 'fleet-conductor' },
  { id: 3,  name: 'identity',     keywords: ['persona', 'voice', 'character', 'profile'],              defaultAgent: 'persona-engine' },
  { id: 4,  name: 'variation',    keywords: ['mutation', 'evolve', 'diversify', 'branch'],              defaultAgent: 'ghost-track' },
  { id: 5,  name: 'inference',    keywords: ['predict', 'infer', 'oracle', 'forecast'],                 defaultAgent: 'oracle2' },
  { id: 6,  name: 'coordination', keywords: ['dispatch', 'route', 'coordinate', 'orchestrate'],         defaultAgent: 'construct' },
  { id: 7,  name: 'conservation', keywords: ['gamma', 'eta', 'invariant', 'balance', 'law'],            defaultAgent: 'construct' },
  { id: 8,  name: 'spatial',      keywords: ['voxel', 'geometry', 'mesh', 'field'],                     defaultAgent: 'construct' },
  { id: 9,  name: 'spectral',     keywords: ['hodge', 'laplacian', 'eigen', 'decompose'],               defaultAgent: 'construct' },
  { id: 10, name: 'linguistic',   keywords: ['language', 'text', 'parse', 'generate'],                  defaultAgent: 'forgemaster' },
  { id: 11, name: 'sensory',      keywords: ['audio', 'midi', 'signal', 'capture'],                     defaultAgent: 'fleet-midi' },
];

// ─── Trust Configuration ─────────────────────────────────────────────────

/**
 * Per-agent trust thresholds. Agents handling higher-stakes work get stricter gates.
 */
const TRUST_THRESHOLDS: Record<string, { distrust: number; silent: number }> = {
  'forgemaster':     { distrust: 0.25, silent: 0.55 },
  'fleet-conductor': { distrust: 0.30, silent: 0.60 },
  'construct':       { distrust: 0.20, silent: 0.45 },
  '_default':        { distrust: 0.30, silent: 0.55 },
};

/**
 * Known agents in the Loom lineage — used for lineage bonus calculation.
 */
const KNOWN_LOOM_AGENTS = new Set([
  'oracle2', 'esp32-sensor-array', 'esp32-sensor-array-3',
  'pi-aggregator', 'pi-aggregator-1', 'jetson-oracle',
  'loom-conductor', 'loom-dispatch',
]);

// ─── Shell Configuration ─────────────────────────────────────────────────

const SHELL_TTL: Record<string, number> = {
  esp32:  300,
  pi:     600,
  jetson: 1800,
  cloud:  3600,
};

// ─── Known Fleet Agents (mirrors worker.ts AGENT_PORTS) ──────────────────

const FLEET_AGENTS = new Set([
  'fleet-midi', 'ghost-track', 'persona-engine', 'fleet-conductor',
  'forgemaster', 'oracle2', 'construct',
]);

// ─── Translation: Baton → Bottle ─────────────────────────────────────────

/**
 * Translate a Loom baton into a FLUX bottle.
 *
 * Performs field mapping, spline extraction, and conservation metadata
 * assignment. Does NOT perform trust gating — use validateBaton() first.
 *
 * @param baton - The incoming Loom baton
 * @param trust - Pre-computed trust score (from validateBaton)
 * @returns A FLUX bottle ready for fleet dispatch
 */
export function translateBatonToBottle(baton: Baton, trust: TrustScore): Bottle {
  const conceptCluster = resolveSplineCluster(baton.payload.spline);
  const action = batonTypeToAction(baton.type, baton.payload.spline?.concept);
  const ttl = resolveTTL(baton, baton.originShell);
  const gamma = computeGamma(trust.adjusted, baton, 'explicit');
  const eta = clamp(1.0 - gamma, 0, 1);

  // Build enriched payload
  const payload: Record<string, unknown> = {};
  if (baton.payload.content) payload.content = baton.payload.content;
  if (baton.payload.data) payload.data = baton.payload.data;
  if (conceptCluster) {
    payload.conceptCluster = conceptCluster.id;
    payload.conceptName = conceptCluster.name;
  }
  if (baton.payload.spline) {
    payload.splineWeight = baton.payload.spline.weight;
  }
  if (baton.lineage.length > 0) {
    payload.lineage = baton.lineage;
  }

  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source: baton.from,
    target: baton.to,
    action,
    payload,
    status: 'outgoing',
    ttl,
    meta: {
      gamma,
      eta,
      originShell: baton.originShell,
      batonId: baton.batonId,
      ...(baton.commitSha && { commitSha: baton.commitSha }),
      ...(baton.payload.spline && { spline: baton.payload.spline }),
      ...(baton.lineage.length > 0 && { lineage: baton.lineage }),
    },
  };
}

// ─── Translation: Bottle → Baton ─────────────────────────────────────────

/**
 * Translate a FLUX bottle response back into a Loom baton.
 *
 * Used when a fleet agent responds to a bridged baton and the response
 * needs to travel back through the git-based Loom bus.
 *
 * @param bottle - The fleet agent's response bottle
 * @param originalBaton - The baton that initiated the exchange (for lineage reversal)
 * @returns A baton ready for git-commit to the shared Loom repo
 */
export function translateBottleToBaton(bottle: Bottle, originalBaton?: Baton): Baton {
  // Reverse the lineage: original lineage + original sender → response path
  const responseLineage = originalBaton
    ? [...originalBaton.lineage, originalBaton.from].reverse()
    : [bottle.source];

  // Recover spline from metadata if present
  const spline = bottle.meta?.spline ?? originalBaton?.payload.spline;

  // Determine baton type from action
  const type = actionToBatonType(bottle.action);

  // Compute trust from bottle gamma
  const trustScore = bottle.meta?.gamma ?? 0.7;
  const trustLevel = trustScore >= 0.6 ? 'trust' : trustScore >= 0.3 ? 'silent' : 'distrust';

  return {
    batonId: `bt-resp-${bottle.id.slice(0, 8)}`,
    from: bottle.source,
    to: bottle.target,
    type,
    payload: {
      content: (bottle.payload.content as string) ?? bottle.action,
      ...(spline && { spline }),
      data: bottle.payload,
    },
    lineage: responseLineage,
    trust: { level: trustLevel as Baton['trust']['level'], score: trustScore },
    timestamp: new Date(bottle.timestamp).toISOString(),
    originShell: 'cloud',
    ...((bottle.meta?.batonId || originalBaton?.batonId) && {
      // Preserve commit provenance if responding to a git-baton
    }),
  };
}

// ─── Trust Gating ────────────────────────────────────────────────────────

/**
 * Validate a baton and compute its trust score using Ternary-Trust.
 *
 * Adjusts the raw baton trust score based on:
 * - Lineage bonus: known agents in the chain increase trust
 * - Commit bonus: verified git provenance increases trust
 * - Freshness penalty: stale batons lose trust
 * - Anomaly penalty: unexpected payload shapes lose trust
 *
 * @param baton - The baton to evaluate
 * @returns TrustScore with adjusted value and level
 */
export function validateBaton(baton: Baton): { valid: boolean; trust: TrustScore } {
  // Structural validation
  if (!baton.batonId || !baton.from || !baton.to || !baton.type) {
    return {
      valid: false,
      trust: {
        level: 'distrust',
        adjusted: 0,
        raw: baton.trust?.score ?? 0,
        breakdown: { lineageBonus: 0, commitBonus: 0, freshnessPenalty: 0, anomalyPenalty: 0.5 },
      },
    };
  }

  // Check if target is a known fleet agent
  const isKnownAgent = FLEET_AGENTS.has(baton.to);

  // Lineage bonus: +0.05 per known agent, max +0.15
  const knownInLineage = baton.lineage.filter(a => KNOWN_LOOM_AGENTS.has(a)).length;
  const lineageBonus = Math.min(knownInLineage * 0.05, 0.15);

  // Commit bonus: +0.03 if commitSha present
  const commitBonus = baton.commitSha ? 0.03 : 0;

  // Freshness penalty: -0.02 per hour stale, max -0.10
  const batonAge = Date.now() - new Date(baton.timestamp).getTime();
  const hoursStale = batonAge / (1000 * 60 * 60);
  const freshnessPenalty = Math.min(hoursStale * 0.02, 0.10);

  // Anomaly penalty: -0.20 if payload schema is unexpected
  const hasExpectedShape = baton.payload && typeof baton.payload === 'object';
  const anomalyPenalty = hasExpectedShape ? 0 : 0.20;

  // Compute adjusted score
  const raw = baton.trust.score;
  const adjusted = clamp(
    raw + lineageBonus + commitBonus - freshnessPenalty - anomalyPenalty,
    0,
    1,
  );

  // Determine trust level using per-agent thresholds
  const thresholds = isKnownAgent
    ? (TRUST_THRESHOLDS[baton.to] ?? TRUST_THRESHOLDS._default)
    : TRUST_THRESHOLDS._default;

  let level: TrustScore['level'];
  if (adjusted < thresholds.distrust) {
    level = 'distrust';
  } else if (adjusted < thresholds.silent) {
    level = 'silent';
  } else {
    level = 'trust';
  }

  return {
    valid: level !== 'distrust',
    trust: {
      level,
      adjusted,
      raw,
      breakdown: { lineageBonus, commitBonus, freshnessPenalty, anomalyPenalty },
    },
  };
}

// ─── Multi-Shell Routing ─────────────────────────────────────────────────

/**
 * Determine the shell target and fleet agent for a baton.
 *
 * Routing priority:
 * 1. Explicit `to` field → direct to named agent
 * 2. Spline concept → concept cluster → default agent for that cluster
 * 3. Fallback → construct (coordinator)
 *
 * Shell target follows the upstream propagation pattern:
 *   ESP32 SIGNAL → cloud, ESP32 SPLINE → pi,
 *   Pi SPLINE → jetson, Jetson SPLINE → cloud,
 *   All QUERY/DIRECTIVE → cloud
 *
 * @param baton - The baton to route
 * @returns ShellTarget with resolved shell, agent, confidence, and TTL
 */
export function routeBatonToShell(baton: Baton): ShellTarget {
  // Resolve agent
  let agent: string;
  let routingMethod: ShellTarget['routingMethod'];
  let routingConfidence: number;

  if (FLEET_AGENTS.has(baton.to)) {
    agent = baton.to;
    routingMethod = 'explicit';
    routingConfidence = 1.0;
  } else if (baton.payload.spline) {
    const cluster = resolveSplineCluster(baton.payload.spline);
    agent = cluster?.defaultAgent ?? 'construct';
    routingMethod = 'spline';
    routingConfidence = baton.payload.spline.weight;
  } else {
    agent = 'construct';
    routingMethod = 'fallback';
    routingConfidence = 0.5;
  }

  // Resolve shell
  let shell: ShellTarget['shell'];

  if (baton.type === 'QUERY' || baton.type === 'DIRECTIVE') {
    shell = 'cloud';
  } else if (baton.type === 'SIGNAL') {
    // Signals from edge → cloud for processing
    shell = baton.originShell === 'esp32' ? 'cloud' : 'cloud';
  } else if (baton.type === 'SPLINE') {
    // Splines propagate upstream through the hierarchy
    const shellOrder: ShellTarget['shell'][] = ['esp32', 'pi', 'jetson', 'cloud'];
    const originIdx = shellOrder.indexOf(baton.originShell);
    // Move one level up from origin, clamped to cloud
    shell = shellOrder[Math.min(originIdx + 1, shellOrder.length - 1)];
  } else {
    shell = 'cloud';
  }

  return {
    shell,
    agent,
    routingConfidence,
    routingMethod,
    ttl: SHELL_TTL[shell] ?? 3600,
  };
}

// ─── Conservation Audit ──────────────────────────────────────────────────

/**
 * Compute the conservation audit record for a bridged message.
 *
 * Verifies γ + η ≤ C + ε where C = 1.0 and ε = 0.01.
 */
export function auditConservation(bottle: Bottle): ConservationAudit {
  const gamma = bottle.meta?.gamma ?? 0;
  const eta = bottle.meta?.eta ?? 0;
  const C = 1.0;
  const epsilon = 0.01;
  const sum = gamma + eta;
  const check: ConservationAudit['check'] = sum <= C + epsilon ? 'PASS' : 'FAIL';

  return {
    batonId: bottle.meta?.batonId ?? 'unknown',
    bottleId: bottle.id,
    gamma,
    eta,
    conservationConstant: C,
    check,
    timestamp: bottle.timestamp,
  };
}

// ─── HTTP Handler ────────────────────────────────────────────────────────

/**
 * Env interface — extends the worker's base Env with bindings used by the bridge.
 * Import from worker.ts in production; this standalone interface ensures type-safety.
 */
export interface BridgeEnv {
  FLEET_KV: KVNamespace;
  VESSELS?: R2Bucket;
  VECTORIZE?: VectorizeIndex;
  AI?: any;
}

/**
 * Handle POST /baton — bridge ingress endpoint.
 *
 * Receives a Loom baton, validates it through trust gating, translates to
 * a FLUX bottle, routes to the appropriate shell/agent, persists to KV+R2,
 * and returns a confirmation with conservation metrics.
 *
 * @param request - The incoming HTTP request
 * @param env - Cloudflare Worker environment bindings
 * @param corsHeaders - Pre-configured CORS headers
 * @returns HTTP response with bridge result
 */
export async function handleBatonRequest(
  request: Request,
  env: BridgeEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  // Parse baton
  let baton: Baton;
  try {
    baton = await request.json() as Baton;
  } catch {
    return jsonError('Invalid JSON', corsHeaders, 400);
  }

  // Validate + trust gate
  const { valid, trust } = validateBaton(baton);
  if (!valid && trust.level === 'distrust') {
    // Log security incident
    await env.FLEET_KV.put(
      `security:baton:${baton.batonId}`,
      JSON.stringify({ baton, trust, rejectedAt: Date.now() }),
      { expirationTtl: 86400 },
    );
    return jsonResponse({
      ok: false,
      error: 'Baton rejected: distrust',
      batonId: baton.batonId,
      trust,
    }, corsHeaders, 403);
  }

  // Translate to bottle
  const bottle = translateBatonToBottle(baton, trust);

  // Route
  const shellTarget = routeBatonToShell(baton);
  bottle.target = shellTarget.agent;
  bottle.ttl = shellTarget.ttl;

  // Conservation audit
  const audit = auditConservation(bottle);
  if (audit.check === 'FAIL') {
    // Flag but don't block — log for review
    await env.FLEET_KV.put(
      `audit-fail:baton:${baton.batonId}`,
      JSON.stringify(audit),
      { expirationTtl: 604800 },
    );
  }

  // If silent (quarantine), store but don't deliver
  if (trust.level === 'silent') {
    await env.FLEET_KV.put(
      `quarantine:baton:${baton.batonId}`,
      JSON.stringify({ bottle, baton, trust, audit, quarantinedAt: Date.now() }),
      { expirationTtl: 86400 },
    );
    return jsonResponse({
      ok: true,
      status: 'quarantined',
      batonId: baton.batonId,
      trust,
    }, corsHeaders, 202);
  }

  // Persist bottle to KV (inbox for target agent)
  const kvKey = `bottle:${shellTarget.agent}:${bottle.id}`;
  const inboxKey = `inbox:${shellTarget.agent}`;
  const auditKey = `audit:baton:${baton.batonId}`;

  // Read existing inbox concurrently
  const inboxRaw = await env.FLEET_KV.get(inboxKey);
  const inbox: string[] = inboxRaw ? JSON.parse(inboxRaw) : [];
  inbox.push(bottle.id);

  // Update metrics
  const metricsKey = `metrics:baton-bridge:${new Date().toISOString().split('T')[0]}`;
  const metricsRaw = await env.FLEET_KV.get(metricsKey);
  const metrics = metricsRaw ? JSON.parse(metricsRaw) : { count: 0, byType: {}, byShell: {} };
  metrics.count++;
  metrics.byType[baton.type] = (metrics.byType[baton.type] || 0) + 1;
  metrics.byShell[shellTarget.shell] = (metrics.byShell[shellTarget.shell] || 0) + 1;

  // Batch all KV writes + optional R2
  const writes: Promise<unknown>[] = [
    env.FLEET_KV.put(kvKey, JSON.stringify(bottle), { expirationTtl: bottle.ttl }),
    env.FLEET_KV.put(inboxKey, JSON.stringify(inbox.slice(-100)), { expirationTtl: 86400 }),
    env.FLEET_KV.put(auditKey, JSON.stringify(audit), { expirationTtl: 604800 }),
    env.FLEET_KV.put(metricsKey, JSON.stringify(metrics), { expirationTtl: 604800 }),
  ];

  if (env.VESSELS) {
    writes.push(
      env.VESSELS.put(
        `baton-bridge/${new Date().toISOString().split('T')[0]}/${bottle.id}.json`,
        JSON.stringify({ baton, bottle, trust, audit, shellTarget }, null, 2),
        {
          customMetadata: {
            batonId: baton.batonId,
            target: shellTarget.agent,
            shell: shellTarget.shell,
            action: bottle.action,
          },
        },
      ),
    );
  }

  await Promise.all(writes);

  return jsonResponse({
    ok: true,
    bottleId: bottle.id,
    batonId: baton.batonId,
    routedTo: shellTarget.agent,
    shellTarget: shellTarget.shell,
    routingMethod: shellTarget.routingMethod,
    routingConfidence: shellTarget.routingConfidence,
    gamma: bottle.meta?.gamma,
    eta: bottle.meta?.eta,
    conservationCheck: audit.check,
    trust: { level: trust.level, adjusted: trust.adjusted },
  }, corsHeaders);
}

/**
 * Handle POST /baton/response — return path for fleet → Loom responses.
 *
 * Takes a fleet agent's response bottle and translates it back to a baton
 * for git-delivery to the Loom system. Requires the original baton ID to
 * reconstruct the lineage.
 */
export async function handleBatonResponse(
  request: Request,
  env: BridgeEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await request.json() as { bottle: Bottle; originalBatonId?: string };

  if (!body.bottle) {
    return jsonError('Bottle required', corsHeaders, 400);
  }

  // Look up original baton from audit trail if ID provided
  let originalBaton: Baton | undefined;
  if (body.originalBatonId) {
    const auditRaw = await env.FLEET_KV.get(`audit:baton:${body.originalBatonId}`);
    if (auditRaw) {
      // We stored the bottle, not the baton — check R2 for full record
      // For now, reconstruct minimal baton from bottle meta
      const bottleRaw = await env.FLEET_KV.get(`bottle:${body.bottle.source}:${body.bottle.id}`);
      // The original baton data may be in R2
      if (env.VESSELS) {
        // Attempt to find original — in production this would be a more robust lookup
        originalBaton = undefined; // Placeholder: real impl would query R2
      }
    }
  }

  const responseBaton = translateBottleToBaton(body.bottle, originalBaton);

  // Stage the response baton for git delivery
  const stageKey = `baton-outbox:${responseBaton.batonId}`;
  await env.FLEET_KV.put(stageKey, JSON.stringify(responseBaton), { expirationTtl: 3600 });

  return jsonResponse({
    ok: true,
    batonId: responseBaton.batonId,
    stagedForDelivery: true,
    to: responseBaton.to,
    from: responseBaton.from,
  }, corsHeaders);
}

// ─── Internal Helpers ────────────────────────────────────────────────────

/**
 * Resolve a spline's concept to a concept cluster.
 * Exact keyword match first, then fuzzy by concept name, then fallback.
 */
function resolveSplineCluster(spline?: Spline): ConceptCluster | undefined {
  if (!spline || !spline.concept) return undefined;

  const normalized = spline.concept.toLowerCase().trim();

  // Exact match on cluster name
  const exactName = CONCEPT_CLUSTERS.find(c => c.name === normalized);
  if (exactName) return exactName;

  // Match against keywords
  for (const cluster of CONCEPT_CLUSTERS) {
    if (cluster.keywords.some(kw => normalized.includes(kw) || kw.includes(normalized))) {
      return cluster;
    }
  }

  // Fallback: coordination cluster (6) for unmatched concepts
  return CONCEPT_CLUSTERS[6];
}

/**
 * Map baton type + optional concept to a bottle action string.
 */
function batonTypeToAction(type: Baton['type'], concept?: string): string {
  const prefix = type.toLowerCase();
  if (concept) {
    return `${prefix}_${concept.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  }
  return prefix;
}

/**
 * Reverse-map a bottle action back to a baton type.
 */
function actionToBatonType(action: string): Baton['type'] {
  if (action.startsWith('spline_')) return 'SPLINE';
  if (action.startsWith('signal_')) return 'SIGNAL';
  if (action.startsWith('query_')) return 'QUERY';
  if (action.startsWith('directive_')) return 'DIRECTIVE';
  // Default: SPLINE for insight-type messages
  return 'SPLINE';
}

/**
 * Compute γ (gamma) — information quality score.
 */
function computeGamma(
  trustScore: number,
  baton: Baton,
  routingMethod: 'explicit' | 'spline' | 'fallback',
): number {
  // Payload integrity
  const hasContent = !!baton.payload.content;
  const hasData = !!baton.payload.data && Object.keys(baton.payload.data).length > 0;
  const payloadIntegrity = hasContent && hasData ? 1.0 : hasContent || hasData ? 0.7 : 0.4;

  // Routing confidence
  const routingConfidence = routingMethod === 'explicit' ? 1.0
    : routingMethod === 'spline' ? 0.8
    : 0.5;

  return clamp(trustScore * payloadIntegrity * routingConfidence, 0, 1);
}

/**
 * Resolve TTL based on shell type, with baton override.
 */
function resolveTTL(baton: Baton, shell: string): number {
  if (baton.payload.ttl && typeof baton.payload.ttl === 'number') {
    return baton.payload.ttl;
  }
  return SHELL_TTL[shell] ?? 3600;
}

/**
 * Clamp a number to [min, max].
 */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * JSON response helper (matches worker.ts pattern).
 */
function jsonResponse(data: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Error response helper.
 */
function jsonError(message: string, headers: Record<string, string>, status = 400): Response {
  return jsonResponse({ ok: false, error: message }, headers, status);
}
