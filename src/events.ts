import { EventEmitter } from 'node:events';

/**
 * Process-wide event bus for the gateway. Emits named events consumed by
 * the dashboard's SSE feed and any in-process subscribers.
 *
 * Event names (mirror the incumbent ccMesh web dashboard wire format):
 *  - 'log'            a request was completed/logged
 *  - 'stats'          provider statistics were updated
 */
export const gatewayEvents = new EventEmitter();
gatewayEvents.setMaxListeners(0);

export const EVENTS = {
  log: 'log',
  stats: 'stats',
} as const;