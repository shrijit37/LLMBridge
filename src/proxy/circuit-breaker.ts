export type BreakerState = 'closed' | 'open' | 'half_open';

interface BreakerRecord {
  state: BreakerState;
  consecutiveFailures: number;
  lastFailureTime: number;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number; // default: 5
  cooldownMs?: number; // default: 30000 (30s)
}

/**
 * Per-provider Circuit Breaker to fast-fail dead providers
 * without incurring upstream network connection timeouts.
 */
export class CircuitBreaker {
  private failureThreshold: number;
  private cooldownMs: number;
  private records = new Map<string, BreakerRecord>();

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.cooldownMs = options?.cooldownMs ?? 30000;
  }

  private getRecord(id: string): BreakerRecord {
    let rec = this.records.get(id);
    if (!rec) {
      rec = {
        state: 'closed',
        consecutiveFailures: 0,
        lastFailureTime: 0,
      };
      this.records.set(id, rec);
    }
    return rec;
  }

  public canAttempt(id: string): boolean {
    const rec = this.getRecord(id);
    const now = Date.now();

    if (rec.state === 'closed') {
      return true;
    }

    if (rec.state === 'open') {
      // Check if cooldown period has elapsed
      if (now - rec.lastFailureTime >= this.cooldownMs) {
        rec.state = 'half_open';
        return true;
      }
      return false;
    }

    // HalfOpen allows 1 probe request
    return true;
  }

  public recordSuccess(id: string): void {
    const rec = this.getRecord(id);
    rec.state = 'closed';
    rec.consecutiveFailures = 0;
    rec.lastFailureTime = 0;
  }

  public recordFailure(id: string): void {
    const rec = this.getRecord(id);
    rec.consecutiveFailures++;
    rec.lastFailureTime = Date.now();

    if (rec.state === 'half_open' || rec.consecutiveFailures >= this.failureThreshold) {
      rec.state = 'open';
    }
  }

  public getState(id: string): BreakerState {
    const rec = this.getRecord(id);
    if (rec.state === 'open' && Date.now() - rec.lastFailureTime >= this.cooldownMs) {
      rec.state = 'half_open';
    }
    return rec.state;
  }

  public reset(id?: string): void {
    if (id) {
      this.records.delete(id);
    } else {
      this.records.clear();
    }
  }
}
