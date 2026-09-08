import { ProxyAgent } from 'undici';
import type { LanesConfig } from '../config/types.js';
import { resolveEnvStr } from '../config/loader.js';

export interface LaneSelection {
  port: number;
  agent: ProxyAgent;
}

interface LaneHealth {
  consecutiveFailures: number;
  lastRotateTime: number;
  quarantined: boolean;
}

/**
 * Manages egress VPN lanes backed by the lane-egress sidecar (e.g. gost relays on ports 8001-8004)
 * and controls failure-driven rotation requests via the lane-ctl control plane (port 9100).
 */
export class LaneManager {
  private config?: LanesConfig;
  private agents = new Map<number, ProxyAgent>();
  private laneHealth = new Map<number, LaneHealth>();
  private ports: number[] = [];
  private rrIndex = 0;
  private minRotateIntervalMs = 30000; // 30-second cooldown per lane

  constructor(config?: LanesConfig) {
    this.updateConfig(config);
  }

  public updateConfig(config?: LanesConfig): void {
    this.config = config;
    this.close();

    if (!config || !config.enabled) {
      this.ports = [];
      return;
    }

    this.ports = Array.isArray(config.ports) ? [...config.ports] : [];
    const proxyBase = config.proxyBase.replace(/\/+$/, '');

    for (const port of this.ports) {
      const proxyUrl = `${proxyBase}:${port}`;
      const agent = new ProxyAgent(proxyUrl);
      this.agents.set(port, agent);

      if (!this.laneHealth.has(port)) {
        this.laneHealth.set(port, {
          consecutiveFailures: 0,
          lastRotateTime: 0,
          quarantined: false,
        });
      }
    }
  }

  public isEnabled(): boolean {
    return Boolean(this.config?.enabled && this.ports.length > 0);
  }

  /**
   * Round-robin selection of an active lane proxy agent.
   * Returns null if lanes are disabled or no ports are configured.
   */
  public pickLane(): LaneSelection | null {
    if (!this.isEnabled() || this.ports.length === 0) {
      return null;
    }

    const eligiblePorts = this.ports.filter((p) => {
      const h = this.laneHealth.get(p);
      return !h?.quarantined;
    });

    const activeList = eligiblePorts.length > 0 ? eligiblePorts : this.ports;
    const port = activeList[this.rrIndex % activeList.length]!;
    this.rrIndex++;

    const agent = this.agents.get(port);
    if (!agent) {
      return null;
    }

    return { port, agent };
  }

  /**
   * Evaluates upstream response status and automatically triggers
   * non-blocking lane rotation on transport failures or repeated 500s.
   */
  public reportOutcome(port: number, status: number, isTransportError = false): void {
    if (!this.config || !this.config.enabled) return;

    let health = this.laneHealth.get(port);
    if (!health) {
      health = { consecutiveFailures: 0, lastRotateTime: 0, quarantined: false };
      this.laneHealth.set(port, health);
    }

    // Success
    if (status >= 200 && status < 400) {
      health.consecutiveFailures = 0;
      return;
    }

    // Transport failure or HTTP 500 (burned exit IP signal)
    const shouldRotate = isTransportError || status === 500;
    if (shouldRotate) {
      health.consecutiveFailures++;
      const now = Date.now();
      const inCooldown = now - health.lastRotateTime < this.minRotateIntervalMs;

      if (!inCooldown && health.consecutiveFailures >= (isTransportError ? 1 : 2)) {
        health.lastRotateTime = now;
        this.triggerRotation(port);
      }
    }
  }

  /**
   * Dispatches asynchronous rotation request to lane-ctl on port 9100.
   */
  public triggerRotation(port: number): void {
    if (!this.config || !this.config.ctlUrl) return;

    const rawToken = this.config.token || '';
    const token = resolveEnvStr(rawToken) || rawToken;
    const url = `${this.config.ctlUrl.replace(/\/+$/, '')}/v1/rotate`;

    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(10000),
    })
      .then(async (res) => {
        if (res.ok) {
          console.log(`[LaneManager] Successfully triggered rotation for port ${port}`);
        } else {
          const errText = await res.text();
          console.warn(`[LaneManager] Rotation rejected for port ${port} (${res.status}): ${errText}`);
        }
      })
      .catch((err) => {
        console.warn(`[LaneManager] Failed to reach lane-ctl for port ${port}:`, err);
      });
  }

  /**
   * Fetches status for all lanes from the live lane-ctl control plane.
   */
  public async getStatus(): Promise<Record<string, unknown> | null> {
    if (!this.config || !this.config.ctlUrl) return null;

    const rawToken = this.config.token || '';
    const token = resolveEnvStr(rawToken) || rawToken;
    const url = `${this.config.ctlUrl.replace(/\/+$/, '')}/v1/status?port=all`;

    try {
      const res = await fetch(url, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        return (await res.json()) as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  public close(): void {
    for (const agent of this.agents.values()) {
      try {
        agent.close();
      } catch {
        // ignore close errors
      }
    }
    this.agents.clear();
  }
}
