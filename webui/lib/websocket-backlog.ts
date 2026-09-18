// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export interface WebsocketBacklogSnapshot {
  lastDeliveryLagMs: number;
  avgDeliveryLagMs: number;
  maxDeliveryLagMs: number;
  sampleCount: number;
  lastSampleAtMs: number | null;
  lastLaggingAtMs: number | null;
  lagging: boolean;
}

export interface WebsocketBacklogThresholds {
  lagWarningMs: number;
  idleRecoveryMs: number;
  emaAlpha: number;
}

export interface WebsocketBacklogUpdate {
  snapshot: WebsocketBacklogSnapshot;
  shouldWarn: boolean;
}

export const DEFAULT_WEBSOCKET_BACKLOG_THRESHOLDS: WebsocketBacklogThresholds =
  {
    lagWarningMs: 50,
    idleRecoveryMs: 2000,
    emaAlpha: 0.2,
  };

/** Creates the initial worker-to-main websocket delivery lag snapshot. */
export function createInitialWebsocketBacklogSnapshot(): WebsocketBacklogSnapshot {
  return {
    lastDeliveryLagMs: 0,
    avgDeliveryLagMs: 0,
    maxDeliveryLagMs: 0,
    sampleCount: 0,
    lastSampleAtMs: null,
    lastLaggingAtMs: null,
    lagging: false,
  };
}

/** Clamps a lag sample to a finite non-negative millisecond value. */
export function normalizeDeliveryLag(sampleMs: number): number {
  if (!Number.isFinite(sampleMs)) return 0;
  return Math.max(0, sampleMs);
}

/** Incorporates one worker-to-main delivery lag sample into backlog stats. */
export function updateWebsocketBacklogSnapshot(
  current: WebsocketBacklogSnapshot,
  sampleMs: number,
  nowMs: number,
  thresholds: WebsocketBacklogThresholds = DEFAULT_WEBSOCKET_BACKLOG_THRESHOLDS,
): WebsocketBacklogUpdate {
  const lagMs = normalizeDeliveryLag(sampleMs);
  const avgDeliveryLagMs =
    current.sampleCount === 0
      ? lagMs
      : thresholds.emaAlpha * lagMs +
        (1 - thresholds.emaAlpha) * current.avgDeliveryLagMs;
  const maxDeliveryLagMs = Math.max(current.maxDeliveryLagMs, lagMs);
  const lagging = lagMs > thresholds.lagWarningMs;
  const shouldWarn = lagging && !current.lagging;

  return {
    snapshot: {
      lastDeliveryLagMs: lagMs,
      avgDeliveryLagMs,
      maxDeliveryLagMs,
      sampleCount: current.sampleCount + 1,
      lastSampleAtMs: nowMs,
      lastLaggingAtMs: lagging ? nowMs : current.lastLaggingAtMs,
      lagging,
    },
    shouldWarn,
  };
}

/** Clears a stale lagging state when no delayed messages have arrived recently. */
export function refreshWebsocketBacklogSnapshot(
  current: WebsocketBacklogSnapshot,
  nowMs: number,
  thresholds: WebsocketBacklogThresholds = DEFAULT_WEBSOCKET_BACKLOG_THRESHOLDS,
): WebsocketBacklogSnapshot {
  if (!current.lagging || current.lastLaggingAtMs === null) {
    return current;
  }

  if (nowMs - current.lastLaggingAtMs < thresholds.idleRecoveryMs) {
    return current;
  }

  return {
    ...current,
    lagging: false,
  };
}
