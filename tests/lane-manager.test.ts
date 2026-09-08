import { describe, it, expect, vi } from 'vitest';
import { LaneManager } from '../src/proxy/lane-manager.js';
import type { LanesConfig } from '../src/config/types.js';

describe('LaneManager', () => {
  it('returns null when lanes are disabled or empty', () => {
    const mgrDisabled = new LaneManager({
      enabled: false,
      proxyBase: 'http://lane-egress',
      ports: [8001, 8002],
      ctlUrl: 'http://lane-egress:9100',
    });
    expect(mgrDisabled.isEnabled()).toBe(false);
    expect(mgrDisabled.pickLane()).toBeNull();

    const mgrEmpty = new LaneManager({
      enabled: true,
      proxyBase: 'http://lane-egress',
      ports: [],
      ctlUrl: 'http://lane-egress:9100',
    });
    expect(mgrEmpty.isEnabled()).toBe(false);
    expect(mgrEmpty.pickLane()).toBeNull();
  });

  it('cycles through active lane ports in round-robin order', () => {
    const config: LanesConfig = {
      enabled: true,
      proxyBase: 'http://lane-egress',
      ports: [8001, 8002, 8003],
      ctlUrl: 'http://lane-egress:9100',
    };
    const mgr = new LaneManager(config);
    expect(mgr.isEnabled()).toBe(true);

    const lane1 = mgr.pickLane();
    const lane2 = mgr.pickLane();
    const lane3 = mgr.pickLane();
    const lane4 = mgr.pickLane();

    expect(lane1?.port).toBe(8001);
    expect(lane1?.agent).toBeDefined();
    expect(lane2?.port).toBe(8002);
    expect(lane3?.port).toBe(8003);
    expect(lane4?.port).toBe(8001); // Cycles back

    mgr.close();
  });

  it('triggers rotation on transport error and respects rotation cooldown', () => {
    vi.useFakeTimers();
    try {
      const config: LanesConfig = {
        enabled: true,
        proxyBase: 'http://lane-egress',
        ports: [8001],
        ctlUrl: 'http://lane-egress:9100',
        token: 'test-token',
      };
      const mgr = new LaneManager(config);
      const triggerSpy = vi.spyOn(mgr, 'triggerRotation').mockImplementation(() => {});

      // Transport error -> triggers rotation immediately
      mgr.reportOutcome(8001, 0, true);
      expect(triggerSpy).toHaveBeenCalledTimes(1);
      expect(triggerSpy).toHaveBeenCalledWith(8001);

      // Immediate second failure within 30s cooldown -> should NOT trigger duplicate rotation
      mgr.reportOutcome(8001, 0, true);
      expect(triggerSpy).toHaveBeenCalledTimes(1);

      // Advance past 30s cooldown
      vi.advanceTimersByTime(31000);
      mgr.reportOutcome(8001, 0, true);
      expect(triggerSpy).toHaveBeenCalledTimes(2);

      mgr.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('triggers rotation on consecutive HTTP 500s', () => {
    const config: LanesConfig = {
      enabled: true,
      proxyBase: 'http://lane-egress',
      ports: [8001],
      ctlUrl: 'http://lane-egress:9100',
    };
    const mgr = new LaneManager(config);
    const triggerSpy = vi.spyOn(mgr, 'triggerRotation').mockImplementation(() => {});

    // First 500: records failure, does not rotate yet
    mgr.reportOutcome(8001, 500, false);
    expect(triggerSpy).not.toHaveBeenCalled();

    // Second consecutive 500: triggers rotation
    mgr.reportOutcome(8001, 500, false);
    expect(triggerSpy).toHaveBeenCalledTimes(1);
    expect(triggerSpy).toHaveBeenCalledWith(8001);

    mgr.close();
  });
});
