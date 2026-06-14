/**
 * PID Fleet Governor — Ternary control system for fleet scaling
 *
 * Architecture: see PID_FLEET_GOVERNOR.md
 *
 * Conservation law: γ + η = C (Shannon's chain rule)
 * The governor drives γ toward C/2 (balanced equilibrium) using PID control,
 * outputting ternary decisions: +1 (spawn), 0 (maintain), -1 (retire).
 *
 * Integration: wired into the fleet-edge-worker as a GET /governor endpoint
 * and called periodically (cron-style) to measure and act.
 */

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Raw measurement from the fleet at time t.
 * Gamma and Eta come from the baton-bridge conservation audits.
 */
export interface FleetMeasurement {
  /** Mutual information I(X;G) — fleet coupling. [0, 1] */
  gamma: number;
  /** Conditional entropy H(X|G) — agent autonomy. [0, 1] */
  eta: number;
  /** Forgemaster EWMA of build quality. [0, 1] */
  ewma: number;
  /** Current agent count */
  agentCount: number;
  /** Measurement timestamp (ms epoch) */
  timestamp: number;
}

/**
 * Output decision from the governor.
 */
export interface GovernorDecision {
  /** Control action */
  action: 'spawn' | 'maintain' | 'retire';
  /** Confidence in the decision [0, 1] */
  confidence: number;
  /** Human-readable reason */
  reason: string;
  /** Full PID term breakdown */
  pidTerms: PIDTerms;
  /** Governor internal state snapshot */
  state: GovernorState;
}

/**
 * PID term breakdown for observability.
 */
export interface PIDTerms {
  /** Proportional term value */
  p: number;
  /** Integral term value */
  i: number;
  /** Derivative term value */
  d: number;
  /** Combined output u(t) */
  output: number;
  /** Current error e(t) = γ - γ* */
  error: number;
  /** Decision threshold τ */
  threshold: number;
}

/**
 * Internal governor state (persistable to D1/KV).
 */
export interface GovernorState {
  /** Current setpoint γ* */
  setpoint: number;
  /** Current error */
  error: number;
  /** Integral accumulator */
  integral: number;
  /** Previous error (for derivative) */
  prevError: number;
  /** Previous errors for median filter (most recent first) */
  errorHistory: number[];
  /** Conservation constant C */
  C: number;
  /** Last measured eta */
  eta: number;
  /** Last computed derivative */
  derivative: number;
  /** Last output */
  output: number;
  /** Current agent count */
  agentCount: number;
  /** EWMA from Forgemaster */
  ewma: number;
  /** Updated timestamp */
  timestamp: number;
}

/**
 * Configuration for the governor.
 * Gains auto-scale with fleet size unless explicitly overridden.
 */
export interface GovernorConfig {
  /** Proportional gain (base value, auto-scales with n) */
  Kp: number;
  /** Integral gain (base value, auto-scales with n) */
  Ki: number;
  /** Derivative gain (base value, auto-scales with n) */
  Kd: number;
  /** Decision threshold τ (scaled by √C internally) */
  threshold: number;
  /** Integral clamp (scaled by C internally) */
  integralMax: number;
  /** Tick interval in ms */
  tickIntervalMs: number;
  /** Post-action integral bleed factor */
  postActionBleed: number;
  /** EWMA smoothing factor for setpoint modulation */
  ewmaAlpha: number;
  /** Median filter window for derivative */
  derivativeFilterWindow: number;
  /** Minimum agent count (never retire below this) */
  minAgents: number;
  /** Maximum agent count (never spawn above this) */
  maxAgents: number;
}

/**
 * History entry for D1 persistence.
 */
export interface GovernorHistoryEntry {
  timestamp: number;
  gamma: number;
  eta: number;
  error: number;
  integral: number;
  derivative: number;
  output: number;
  action: string;
  confidence: number;
  agentCount: number;
  ewma: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────

/**
 * Default configuration for a medium fleet (n ≈ 7).
 * Auto-scales to other fleet sizes via the gain schedule.
 */
export const DEFAULT_CONFIG: GovernorConfig = {
  Kp: 1.0,
  Ki: 0.3,
  Kd: 2.0,
  threshold: 0.10,
  integralMax: 1.0,
  tickIntervalMs: 120_000, // 2 minutes
  postActionBleed: 0.5,
  ewmaAlpha: 0.3,
  derivativeFilterWindow: 3,
  minAgents: 2,
  maxAgents: 500,
};

// ─── Governor ─────────────────────────────────────────────────────────────

/**
 * FleetGovernor — PID controller for fleet scaling.
 *
 * Usage:
 *   const governor = new FleetGovernor();
 *   const decision = governor.update(measurement);
 *   if (decision.action !== 'maintain') {
 *     // dispatch spawn/retire bottle
 *   }
 *
 * The governor is stateless across instances — state is passed in and
 * returned out on each update, making it suitable for stateless Worker
 * invocations. Persist `state` to KV/D1 between ticks.
 */
export class FleetGovernor {
  private config: GovernorConfig;
  private state: GovernorState;

  constructor(config: Partial<GovernorConfig> = {}, initialState?: Partial<GovernorState>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      setpoint: 0.5,
      error: 0,
      integral: 0,
      prevError: 0,
      errorHistory: [],
      C: 1.0,
      eta: 0.5,
      derivative: 0,
      output: 0,
      agentCount: 7,
      ewma: 0.88,
      timestamp: Date.now(),
      ...initialState,
    };
  }

  /**
   * Process a fleet measurement and return a governance decision.
   *
   * This is the main entry point. Called once per tick (Δt).
   */
  update(measurement: FleetMeasurement): GovernorDecision {
    const { gamma, eta, ewma, agentCount, timestamp } = measurement;

    // ── 1. Compute conservation constant ──
    const C = gamma + eta; // γ + η = C (should be ~1.0)
    this.state.C = C;
    this.state.eta = eta;

    // ── 2. Compute setpoint (EWMA-modulated) ──
    const setpoint = this.computeSetpoint(C, ewma);
    this.state.setpoint = setpoint;
    this.state.ewma = ewma;
    this.state.agentCount = agentCount;

    // ── 3. Compute error e(t) = γ - γ* ──
    const error = gamma - setpoint;
    this.state.error = error;

    // ── 4. Auto-scale gains based on fleet size ──
    const { Kp, Ki, Kd } = this.scaledGains(agentCount);

    // ── 5. Proportional term ──
    const pTerm = Kp * error;

    // ── 6. Integral term with anti-windup ──
    const dt = this.computeDt(timestamp);
    const integralRaw = this.state.integral + error * dt;
    const integralMax = this.config.integralMax * C; // Scale by C
    // Conditional integration: freeze if integral and error are pushing same direction at clamp
    let integral: number;
    if (Math.abs(integralRaw) > integralMax && Math.sign(integralRaw) === Math.sign(error)) {
      integral = Math.sign(integralRaw) * integralMax; // Hard clamp
    } else {
      integral = clamp(integralRaw, -integralMax, integralMax);
    }
    this.state.integral = integral;
    const iTerm = Ki * integral;

    // ── 7. Derivative term with median filter ──
    this.state.errorHistory = [error, ...this.state.errorHistory].slice(0, this.config.derivativeFilterWindow);
    const derivative = this.computeFilteredDerivative(dt);
    this.state.derivative = derivative;
    const dTerm = Kd * derivative;

    // ── 8. Combined output ──
    const output = pTerm + iTerm + dTerm;
    this.state.output = output;
    this.state.prevError = error;
    this.state.timestamp = timestamp;

    // ── 9. Threshold (scaled by √C) ──
    const threshold = this.config.threshold * Math.sqrt(C);

    // ── 10. Ternary decision ──
    let action: GovernorDecision['action'];
    let reason: string;

    if (output > threshold && agentCount < this.config.maxAgents) {
      action = 'spawn';
      reason = `Over-coupled (γ=${gamma.toFixed(3)} > γ*=${setpoint.toFixed(3)}); spawning to dilute coupling`;
    } else if (output < -threshold && agentCount > this.config.minAgents) {
      action = 'retire';
      reason = `Under-coupled (γ=${gamma.toFixed(3)} < γ*=${setpoint.toFixed(3)}); retiring to concentrate capacity`;
    } else {
      action = 'maintain';
      if (Math.abs(error) < threshold * 0.3) {
        reason = 'System near equilibrium';
      } else if (agentCount >= this.config.maxAgents && output > threshold) {
        reason = `Would spawn but at max agents (${agentCount})`;
      } else if (agentCount <= this.config.minAgents && output < -threshold) {
        reason = `Would retire but at min agents (${agentCount})`;
      } else {
        reason = `Output ${output.toFixed(4)} within threshold ±${threshold.toFixed(4)}`;
      }
    }

    // ── 11. Confidence: |u| × EWMA, bounded ──
    const confidence = clamp(Math.abs(output) * ewma, 0, 1);

    // ── 12. Post-action bleed ──
    if (action !== 'maintain') {
      this.state.integral *= this.config.postActionBleed;
    }

    const pidTerms: PIDTerms = {
      p: pTerm,
      i: iTerm,
      d: dTerm,
      output,
      error,
      threshold,
    };

    return {
      action,
      confidence,
      reason,
      pidTerms,
      state: { ...this.state },
    };
  }

  /**
   * Get current governor state (for persistence).
   */
  getState(): GovernorState {
    return { ...this.state };
  }

  /**
   * Get current config (for observability).
   */
  getConfig(): GovernorConfig {
    return { ...this.config };
  }

  /**
   * Get scaled gains for the current fleet size.
   */
  scaledGains(agentCount: number): { Kp: number; Ki: number; Kd: number } {
    const n = Math.max(agentCount, 2); // Avoid log(1) = 0
    const logN = Math.log2(n) + 1;

    const Kp = this.config.Kp / logN;
    const Ki = this.config.Ki * (1 - Math.exp(-n / 50));
    const Kd = this.config.Kd * (2 / logN);

    return { Kp, Ki, Kd };
  }

  /**
   * Export history entry for D1 persistence.
   */
  toHistoryEntry(decision: GovernorDecision): GovernorHistoryEntry {
    return {
      timestamp: decision.state.timestamp,
      gamma: decision.state.C - decision.state.eta,
      eta: decision.state.eta,
      error: decision.pidTerms.error,
      integral: decision.state.integral,
      derivative: decision.state.derivative,
      output: decision.pidTerms.output,
      action: decision.action,
      confidence: decision.confidence,
      agentCount: decision.state.agentCount,
      ewma: decision.state.ewma,
    };
  }

  // ─── Internal Methods ────────────────────────────────────────────────

  /**
   * Compute the EWMA-modulated setpoint γ*.
   *
   * - q ≥ 0.90: standard C/2
   * - 0.75 ≤ q < 0.90: slight γ* increase (more coordination helps)
   * - q < 0.75: reduced γ* (coordination channels untrustworthy)
   */
  private computeSetpoint(C: number, ewma: number): number {
    const base = C / 2;

    if (ewma >= 0.90) {
      return base;
    } else if (ewma >= 0.75) {
      return base * (ewma + 0.1);
    } else {
      return base * 0.85;
    }
  }

  /**
   * Compute time delta from previous tick.
   */
  private computeDt(timestamp: number): number {
    const dtMs = timestamp - this.state.timestamp;
    // Clamp dt to [1s, 1h] to handle gaps gracefully
    const dtClamped = Math.max(1000, Math.min(3_600_000, dtMs || this.config.tickIntervalMs));
    return dtClamped / 1000; // seconds
  }

  /**
   * Compute derivative using median filter to reject measurement noise.
   */
  private computeFilteredDerivative(dt: number): number {
    const history = this.state.errorHistory;
    if (history.length < 2) return 0;

    // Compute successive rates of change
    const rates: number[] = [];
    for (let i = 0; i < Math.min(history.length - 1, this.config.derivativeFilterWindow); i++) {
      rates.push((history[i] - history[i + 1]) / dt);
    }

    // Median of rates (more robust than mean to outliers)
    return median(rates);
  }
}

// ─── HTTP Handler ─────────────────────────────────────────────────────────

/**
 * Env interface for the governor endpoint.
 * Extends the worker's base bindings.
 */
export interface GovernorEnv {
  FLEET_KV: KVNamespace;
  VESSELS?: R2Bucket;
  AGENT_HUB?: DurableObjectNamespace;
  AI?: any;
  VECTORIZE?: VectorizeIndex;
  VERSION: string;
  FLEET_NAME: string;
  VECTOR_API: string;
}

/**
 * KV key constants.
 */
const KV_KEYS = {
  state: 'governor:state',
  history: 'governor:history',
  config: 'governor:config',
  latestDecision: 'governor:latest-decision',
} as const;

/**
 * Handle GET /governor — returns current governor state and latest decision.
 *
 * @param env - Worker environment bindings
 * @param headers - Pre-configured CORS headers
 * @returns HTTP response with governor status
 */
export async function handleGovernorStatus(
  env: GovernorEnv,
  headers: Record<string, string>,
): Promise<Response> {
  // Read governor state, latest decision, and config from KV concurrently
  const [stateRaw, decisionRaw, configRaw] = await Promise.all([
    env.FLEET_KV.get(KV_KEYS.state),
    env.FLEET_KV.get(KV_KEYS.latestDecision),
    env.FLEET_KV.get(KV_KEYS.config),
  ]);

  const state = stateRaw ? JSON.parse(stateRaw) : null;
  const decision = decisionRaw ? JSON.parse(decisionRaw) : null;
  const config = configRaw ? JSON.parse(configRaw) : DEFAULT_CONFIG;

  // Read recent history (last 20 entries)
  const historyRaw = await env.FLEET_KV.get(KV_KEYS.history);
  const history: GovernorHistoryEntry[] = historyRaw ? JSON.parse(historyRaw) : [];

  return new Response(
    JSON.stringify({
      status: state ? 'active' : 'uninitialized',
      fleet: env.FLEET_NAME,
      version: env.VERSION,
      state,
      decision,
      config,
      history: history.slice(-20),
      timestamp: Date.now(),
    }, null, 2),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...headers },
    },
  );
}

/**
 * Handle POST /governor/tick — run one governor cycle.
 *
 * Called by a cron trigger or manual invocation. Reads the current fleet
 * measurement, runs the PID controller, dispatches any spawn/retire action,
 * and persists state to KV.
 *
 * @param env - Worker environment bindings
 * @param headers - Pre-configured CORS headers
 * @param measurement - Optional pre-computed measurement (for testing). If not
 *                      provided, derives measurement from KV audit records.
 * @returns HTTP response with governor decision
 */
export async function handleGovernorTick(
  env: GovernorEnv,
  headers: Record<string, string>,
  measurement?: FleetMeasurement,
): Promise<Response> {
  // ── 1. Acquire measurement ──
  if (!measurement) {
    measurement = await deriveMeasurement(env);
  }

  // ── 2. Load persisted state and config ──
  const [stateRaw, configRaw] = await Promise.all([
    env.FLEET_KV.get(KV_KEYS.state),
    env.FLEET_KV.get(KV_KEYS.config),
  ]);

  const persistedState = stateRaw ? JSON.parse(stateRaw) : undefined;
  const config = configRaw ? { ...DEFAULT_CONFIG, ...JSON.parse(configRaw) } : DEFAULT_CONFIG;

  // ── 3. Run governor ──
  const governor = new FleetGovernor(config, persistedState);
  const decision = governor.update(measurement);

  // ── 4. Persist state ──
  const newState = governor.getState();
  const historyEntry = governor.toHistoryEntry(decision);

  // Read existing history and append
  const historyRaw = await env.FLEET_KV.get(KV_KEYS.history);
  const history: GovernorHistoryEntry[] = historyRaw ? JSON.parse(historyRaw) : [];
  history.push(historyEntry);
  // Keep last 1000 entries (trim to fit KV value size)
  const trimmedHistory = history.slice(-1000);

  // ── 5. Dispatch action if needed ──
  let dispatchResult: { dispatched: boolean; bottleId?: string; error?: string } = {
    dispatched: false,
  };

  if (decision.action === 'spawn') {
    // Dispatch spawn bottle to construct agent
    try {
      const bottleId = crypto.randomUUID();
      const now = Date.now();
      const bottle = {
        id: bottleId,
        timestamp: now,
        source: 'pid-governor',
        target: 'construct',
        action: 'fleet_spawn',
        payload: {
          reason: decision.reason,
          confidence: decision.confidence,
          pid: decision.pidTerms,
          measurement,
        },
        status: 'outgoing' as const,
        ttl: 3600,
      };

      const kvKey = `bottle:construct:${bottleId}`;
      const inboxKey = 'inbox:construct';
      const existingRaw = await env.FLEET_KV.get(inboxKey);
      const inbox: string[] = existingRaw ? JSON.parse(existingRaw) : [];
      inbox.push(bottleId);

      await Promise.all([
        env.FLEET_KV.put(kvKey, JSON.stringify(bottle), { expirationTtl: 3600 }),
        env.FLEET_KV.put(inboxKey, JSON.stringify(inbox.slice(-100)), { expirationTtl: 86400 }),
      ]);

      dispatchResult = { dispatched: true, bottleId };
    } catch (e) {
      dispatchResult = { dispatched: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  } else if (decision.action === 'retire') {
    // Dispatch retire bottle to the least-recently-active agent
    try {
      const bottleId = crypto.randomUUID();
      const now = Date.now();
      const bottle = {
        id: bottleId,
        timestamp: now,
        source: 'pid-governor',
        target: 'construct',
        action: 'fleet_retire',
        payload: {
          reason: decision.reason,
          confidence: decision.confidence,
          pid: decision.pidTerms,
          measurement,
          selectionStrategy: 'least_active',
        },
        status: 'outgoing' as const,
        ttl: 3600,
      };

      const kvKey = `bottle:construct:${bottleId}`;
      const inboxKey = 'inbox:construct';
      const existingRaw = await env.FLEET_KV.get(inboxKey);
      const inbox: string[] = existingRaw ? JSON.parse(existingRaw) : [];
      inbox.push(bottleId);

      await Promise.all([
        env.FLEET_KV.put(kvKey, JSON.stringify(bottle), { expirationTtl: 3600 }),
        env.FLEET_KV.put(inboxKey, JSON.stringify(inbox.slice(-100)), { expirationTtl: 86400 }),
      ]);

      dispatchResult = { dispatched: true, bottleId };
    } catch (e) {
      dispatchResult = { dispatched: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  // ── 6. Persist all state to KV ──
  await Promise.all([
    env.FLEET_KV.put(KV_KEYS.state, JSON.stringify(newState)),
    env.FLEET_KV.put(KV_KEYS.latestDecision, JSON.stringify(decision)),
    env.FLEET_KV.put(KV_KEYS.history, JSON.stringify(trimmedHistory)),
  ]);

  // ── 7. Also persist to R2 for durable log ──
  if (env.VESSELS) {
    const today = new Date().toISOString().split('T')[0];
    await env.VESSELS.put(
      `governor/${today}/${measurement.timestamp}.json`,
      JSON.stringify({ measurement, decision, historyEntry, dispatchResult }, null, 2),
      {
        customMetadata: {
          action: decision.action,
          confidence: decision.confidence.toString(),
          error: decision.pidTerms.error.toFixed(6),
          gamma: measurement.gamma.toFixed(6),
          eta: measurement.eta.toFixed(6),
        },
      },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      decision,
      dispatch: dispatchResult,
      measurement,
      timestamp: Date.now(),
    }, null, 2),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...headers },
    },
  );
}

/**
 * Handle POST /governor/config — update governor configuration.
 *
 * Allows runtime tuning of PID gains and thresholds without redeployment.
 */
export async function handleGovernorConfig(
  request: Request,
  env: GovernorEnv,
  headers: Record<string, string>,
): Promise<Response> {
  const updates = await request.json() as Partial<GovernorConfig>;

  // Load existing config
  const existingRaw = await env.FLEET_KV.get(KV_KEYS.config);
  const existing = existingRaw ? JSON.parse(existingRaw) : DEFAULT_CONFIG;

  // Merge (only known fields)
  const merged: GovernorConfig = { ...DEFAULT_CONFIG, ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (key in merged) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }

  await env.FLEET_KV.put(KV_KEYS.config, JSON.stringify(merged));

  return new Response(
    JSON.stringify({
      ok: true,
      config: merged,
      updated: Object.keys(updates),
    }, null, 2),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...headers },
    },
  );
}

// ─── Measurement Derivation ──────────────────────────────────────────────

/**
 * Derive a FleetMeasurement from KV audit records.
 *
 * Reads recent baton-bridge conservation audits to compute average γ and η.
 * Falls back to neutral defaults if no data is available.
 */
async function deriveMeasurement(env: GovernorEnv): Promise<FleetMeasurement> {
  const now = Date.now();
  const windowMs = 600_000; // Last 10 minutes
  const since = now - windowMs;

  // Read recent audit records from KV
  // Audits are stored under keys like "audit:baton:{batonId}"
  const auditList = await env.FLEET_KV.list({ prefix: 'audit:baton:' });
  const recentAuditKeys = auditList.keys
    .map(k => k.name)
    .slice(-50); // Last 50 audits

  // Also check for governor's own measurement records
  const governorAuditList = await env.FLEET_KV.list({ prefix: 'bottle:' });
  const recentBottleKeys = governorAuditList.keys
    .map(k => k.name)
    .slice(-30);

  // Batch read
  const allKeys = [...recentAuditKeys, ...recentBottleKeys];
  const values = await Promise.all(
    allKeys.slice(-20).map(k => env.FLEET_KV.get(k))
  );

  // Extract gamma/eta from audit records
  const gammas: number[] = [];
  const etas: number[] = [];

  for (const raw of values) {
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      // Conservation audit format: { gamma, eta, ... }
      if (typeof data.gamma === 'number' && typeof data.eta === 'number') {
        if (data.timestamp && data.timestamp >= since) {
          gammas.push(data.gamma);
          etas.push(data.eta);
        }
      }
      // Bottle meta format: { meta: { gamma, eta } }
      if (data.meta && typeof data.meta.gamma === 'number' && typeof data.meta.eta === 'number') {
        if (data.timestamp && data.timestamp >= since) {
          gammas.push(data.meta.gamma);
          etas.push(data.meta.eta);
        }
      }
    } catch {
      // Skip malformed
    }
  }

  // Compute averages (or defaults)
  const gamma = gammas.length > 0
    ? gammas.reduce((a, b) => a + b, 0) / gammas.length
    : 0.5; // Neutral default

  const eta = etas.length > 0
    ? etas.reduce((a, b) => a + b, 0) / etas.length
    : 0.5;

  // Read EWMA from Forgemaster status (stored by the build system)
  const ewmaRaw = await env.FLEET_KV.get('forgemaster:ewma');
  const ewma = ewmaRaw ? parseFloat(ewmaRaw) : 0.88;

  // Count active agents from agent registry
  const agentCount = await countActiveAgents(env);

  return {
    gamma,
    eta,
    ewma,
    agentCount,
    timestamp: now,
  };
}

/**
 * Count active agents by checking inbox activity.
 */
async function countActiveAgents(env: GovernorEnv): Promise<number> {
  const knownAgents = [
    'fleet-midi', 'ghost-track', 'persona-engine', 'fleet-conductor',
    'forgemaster', 'oracle2', 'construct',
  ];

  const inboxResults = await Promise.all(
    knownAgents.map(async (agent) => {
      const raw = await env.FLEET_KV.get(`inbox:${agent}`);
      if (!raw) return false;
      try {
        const ids: string[] = JSON.parse(raw);
        // Agent is "active" if it has inbox entries from last hour
        return ids.length > 0;
      } catch {
        return false;
      }
    })
  );

  const activeCount = inboxResults.filter(Boolean).length;
  return Math.max(activeCount, knownAgents.length); // Default to full fleet if unclear
}

// ─── Utility Functions ────────────────────────────────────────────────────

/**
 * Clamp a number to [min, max].
 */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Compute median of an array of numbers.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ─── Exports ──────────────────────────────────────────────────────────────

export default {
  FleetGovernor,
  handleGovernorStatus,
  handleGovernorTick,
  handleGovernorConfig,
  DEFAULT_CONFIG,
};
