// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { setStoreAction } from "../lib/nanostore-action";
import type * as types from "../types";
import {
  type ActiveInstancesMap,
  activeInstances,
  type ControlState,
  controls,
  type EngineMetrics,
  engineMetrics,
  type UndoState,
  undoState,
} from "./appStores";

/** Converts instance snapshots into the existing instance-id keyed store shape. */
export function instanceArrayToMap(
  instances: types.InstanceInfo[],
): ActiveInstancesMap {
  const instancesMap: ActiveInstancesMap = {};
  for (const instance of instances) {
    instancesMap[instance.instance_id] = instance;
  }
  return instancesMap;
}

/** Converts an undo snapshot into the UI store shape used by controls. */
export function undoStateMessageToStoreValue(
  state: types.UndoStateMessage,
): UndoState {
  return {
    can_undo: state.can_undo,
    can_redo: state.can_redo,
    undo_description: state.undo_description ?? null,
    redo_description: state.redo_description ?? null,
    undo_depth: state.undo_depth,
    redo_depth: state.redo_depth,
    undo_stack: state.undo_stack,
    redo_stack: state.redo_stack,
  };
}

/** Applies the latest backend engine metrics snapshot to the metrics store. */
export function applyMetricsSnapshot(metrics: EngineMetrics): void {
  setStoreAction(engineMetrics, "Receive Metrics", metrics);
}

/** Applies active instance snapshots using the UI instance-id keyed map shape. */
export function applyActiveInstancesSnapshot(
  instances: types.InstanceInfo[],
): void {
  setStoreAction(
    activeInstances,
    "Receive ActiveInstances",
    instanceArrayToMap(instances),
  );
}

/** Applies the latest control snapshot list to the control store. */
export function applyControlsSnapshot(snapshot: ControlState[]): void {
  setStoreAction(controls, "Receive Controls", snapshot);
}

/** Applies an undo snapshot using the nullable description shape expected by UI stores. */
export function applyUndoStateSnapshot(state: types.UndoStateMessage): void {
  setStoreAction(
    undoState,
    "Receive UndoState",
    undoStateMessageToStoreValue(state),
  );
}
