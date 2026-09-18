// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Context provider for optimistic flow state updates.
 *
 * Manages local UI state separately from backend state to prevent jitter
 * when backend ACKs arrive for stale versions. Owns delta sending to track
 * which version each update was committed at, enabling precise ACK matching.
 *
 * Two usage patterns:
 * 1. Use FlowContextProvider to wrap components that need useFlowContext()
 * 2. Use createFlowContextValue() directly and pass the value via props
 */

import {
  type Accessor,
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js";
import { applyFlowDelta } from "../../../lib/flow-service";
import { getLogger } from "../../../lib/logger";
import { flows } from "../../../state/appStores";
import type {
  FlowDelta,
  FlowNodeId,
  FlowPortId,
  FlowValue,
  FlowVersion,
} from "../../../types/index";

const log = getLogger(import.meta.url);

const DEBOUNCE_MS = 150;

/** Timeout before snapping back to backend state if no ACK received */
const ACK_TIMEOUT_MS = 500;

type PortKey = `${FlowNodeId}:${FlowPortId}`;

type PendingUpdate = {
  value: FlowValue;
  /** The flow version at which this update was committed (sent to backend) */
  committedAtVersion: FlowVersion | null;
  /** Debounce timer for sending the update */
  debounceTimer: number;
  /** Timeout timer for snapping back if no ACK */
  ackTimeoutTimer: number;
};

export type FlowContextType = {
  /**
   * Get the current display value for a port.
   * Returns the optimistic local value if one exists, otherwise the backend value.
   */
  getDisplayValue: (
    nodeId: FlowNodeId,
    portId: FlowPortId,
    backendValue: FlowValue | null | undefined,
  ) => FlowValue | null | undefined;

  /**
   * Update a port value optimistically.
   * Updates local state immediately and debounces backend commit.
   */
  updateValue: (
    nodeId: FlowNodeId,
    portId: FlowPortId,
    value: FlowValue,
    immediate?: boolean,
  ) => void;

  /**
   * Force commit any pending updates immediately.
   */
  flushPending: (nodeId: FlowNodeId, portId: FlowPortId) => void;
};

const FlowContext = createContext<FlowContextType>();

export type FlowContextValueOptions = {
  flowUid: string;
  /** Accessor for the current flow version (reactive) */
  flowVersion: Accessor<FlowVersion>;
  /** Optional callback when a port value is updated (for updating local node state) */
  onPortValueUpdate?: (
    nodeId: FlowNodeId,
    portId: FlowPortId,
    value: FlowValue,
  ) => void;
};

export type FlowContextProviderProps = ParentProps<
  | {
      /** Pre-created context value to use (for sharing between multiple consumers) */
      value: FlowContextType;
    }
  | {
      flowUid: string;
      flowVersion: FlowVersion;
      /** Optional callback when a port value is updated (for updating local node state) */
      onPortValueUpdate?: (
        nodeId: FlowNodeId,
        portId: FlowPortId,
        value: FlowValue,
      ) => void;
    }
>;

/**
 * Creates the flow context value with optimistic update handling.
 * Can be used directly without the Provider component.
 *
 * Must be called within a reactive context (component or createRoot) for
 * cleanup to work properly.
 */
export function createFlowContextValue(
  options: FlowContextValueOptions,
): FlowContextType {
  const { flowUid, flowVersion, onPortValueUpdate } = options;

  // Track pending optimistic updates
  // Key: "nodeId:portId", Value: { value, committedAtVersion, debounceTimer, ackTimeoutTimer }
  const [pending, setPending] = createSignal<Map<PortKey, PendingUpdate>>(
    new Map(),
  );

  // Track the last backend version we've seen
  let lastSeenBackendVersion = flowVersion();

  // Watch for flow version changes (ACKs from backend)
  createEffect(() => {
    const newVersion = flowVersion();
    if (newVersion <= lastSeenBackendVersion) {
      return;
    }

    lastSeenBackendVersion = newVersion;

    // Only clear pending updates that were committed at or before this version
    setPending((prev) => {
      if (prev.size === 0) return prev;

      const next = new Map<PortKey, PendingUpdate>();
      for (const [key, update] of prev) {
        if (
          update.committedAtVersion !== null &&
          update.committedAtVersion <= newVersion
        ) {
          // This update has been ACK'd - clear timers and remove
          window.clearTimeout(update.debounceTimer);
          window.clearTimeout(update.ackTimeoutTimer);
        } else {
          // Keep updates that haven't been committed yet or are waiting for a later ACK
          next.set(key, update);
        }
      }
      return next;
    });
  });

  onCleanup(() => {
    // Clear all pending timers
    for (const update of pending().values()) {
      window.clearTimeout(update.debounceTimer);
      window.clearTimeout(update.ackTimeoutTimer);
    }
  });

  const makeKey = (nodeId: FlowNodeId, portId: FlowPortId): PortKey =>
    `${nodeId}:${portId}`;

  const getDisplayValue = (
    nodeId: FlowNodeId,
    portId: FlowPortId,
    backendValue: FlowValue | null | undefined,
  ): FlowValue | null | undefined => {
    const key = makeKey(nodeId, portId);
    const pendingUpdate = pending().get(key);

    if (pendingUpdate) {
      // We have a pending optimistic update - use it
      return pendingUpdate.value;
    }

    // No pending update - use backend value
    return backendValue;
  };

  const sendDelta = (
    nodeId: FlowNodeId,
    portId: FlowPortId,
    value: FlowValue,
  ) => {
    const key = makeKey(nodeId, portId);

    // Read current version from store at send time, not from accessor
    // (accessor may be stale if multiple sends happen in quick succession)
    const flowMap = flows.get();
    const currentFlow = flowMap[flowUid];
    if (!currentFlow) {
      return;
    }
    const currentVersion = currentFlow.flow_version;
    const currentFlowId = currentFlow.identifiers.id;

    // The version we're committing at is the current flow version + 1
    // (applyFlowDelta will increment it)
    const committingAtVersion = currentVersion + 1;

    const delta: FlowDelta = {
      flow_id: currentFlowId,
      base_version: currentVersion,
      ops: [
        {
          type: "UpdatePortConfig",
          data: {
            node_id: nodeId,
            port_id: portId,
            default_value: value,
          },
        },
      ],
    };

    applyFlowDelta(flowUid, delta);

    // Notify parent to update local node state
    onPortValueUpdate?.(nodeId, portId, value);

    // Update pending entry with committed version and start ACK timeout
    setPending((prev) => {
      const existing = prev.get(key);
      if (!existing) return prev;

      const next = new Map(prev);

      // Clear any existing ACK timeout
      window.clearTimeout(existing.ackTimeoutTimer);

      // Start timeout - if no ACK arrives, snap back to backend state
      const ackTimeoutTimer = window.setTimeout(() => {
        setPending((current) => {
          const entry = current.get(key);
          // Only snap back if this is still the same pending update
          // and user hasn't made subsequent changes (no new uncommitted value)
          if (entry && entry.committedAtVersion === committingAtVersion) {
            const updated = new Map(current);
            updated.delete(key);
            return updated;
          }
          return current;
        });
      }, ACK_TIMEOUT_MS);

      next.set(key, {
        ...existing,
        committedAtVersion: committingAtVersion,
        ackTimeoutTimer,
      });
      return next;
    });
  };

  const updateValue = (
    nodeId: FlowNodeId,
    portId: FlowPortId,
    value: FlowValue,
    immediate = false,
  ) => {
    const key = makeKey(nodeId, portId);

    setPending((prev) => {
      const next = new Map(prev);
      const existing = next.get(key);

      // Clear existing debounce timer if any
      if (existing) {
        window.clearTimeout(existing.debounceTimer);
      }

      if (immediate) {
        // Commit immediately
        // We'll update committedAtVersion in sendDelta
        next.set(key, {
          value,
          committedAtVersion: existing?.committedAtVersion ?? null,
          debounceTimer: 0,
          ackTimeoutTimer: existing?.ackTimeoutTimer ?? 0,
        });

        // Send outside of setPending to avoid issues
        queueMicrotask(() => sendDelta(nodeId, portId, value));
      } else {
        // Debounced commit
        const debounceTimer = window.setTimeout(() => {
          sendDelta(nodeId, portId, value);
        }, DEBOUNCE_MS);

        next.set(key, {
          value,
          // Keep existing committedAtVersion if we have a prior commit in flight
          committedAtVersion: existing?.committedAtVersion ?? null,
          debounceTimer,
          ackTimeoutTimer: existing?.ackTimeoutTimer ?? 0,
        });
      }

      return next;
    });
  };

  const flushPending = (nodeId: FlowNodeId, portId: FlowPortId) => {
    const key = makeKey(nodeId, portId);
    const update = pending().get(key);

    if (!update) return;

    // Clear debounce timer and send immediately
    window.clearTimeout(update.debounceTimer);
    sendDelta(nodeId, portId, update.value);
  };

  return {
    getDisplayValue,
    updateValue,
    flushPending,
  };
}

/**
 * Provider component that wraps children with FlowContext.
 * Use this when children need to access the context via useFlowContext().
 *
 * Can accept either:
 * - A pre-created context value via `value` prop (for sharing between multiple consumers)
 * - Individual props (flowUid, flowVersion) to create a new context value
 */
export function FlowContextProvider(props: FlowContextProviderProps) {
  log.trace("mounting");
  onCleanup(() => log.trace("unmounting"));

  const contextValue =
    "value" in props
      ? props.value
      : createFlowContextValue({
          flowUid: props.flowUid,
          flowVersion: () => props.flowVersion,
          onPortValueUpdate: props.onPortValueUpdate,
        });

  return (
    <FlowContext.Provider value={contextValue}>
      {props.children}
    </FlowContext.Provider>
  );
}

/** @lintignore */
export function useFlowContext(): FlowContextType {
  const context = useContext(FlowContext);
  if (!context) {
    throw new Error("useFlowContext must be used within a FlowContextProvider");
  }
  return context;
}

/**
 * Hook for components that may or may not be within the provider.
 * Returns undefined if not within provider context.
 */
export function useFlowContextOptional(): FlowContextType | undefined {
  return useContext(FlowContext);
}
