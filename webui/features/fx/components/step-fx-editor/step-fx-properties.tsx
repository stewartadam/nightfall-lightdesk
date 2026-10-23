// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import CrudLabelProperties from "../../../../components/widgets/crud/crud-label-properties";
import type * as types from "../../../../types";
import { SpatialSelectionField } from "../../../selection";

/** Renders the editor-owned label and spatial-selection fields in Properties. */
export function StepFxProperties(props: {
  stepFx: types.StepFx | undefined;
  onLabelCommit: (stepFx: types.StepFx, label: string) => void;
  onSelectionChange: (selection: types.SpatialSelection) => void;
}) {
  return (
    <div>
      <CrudLabelProperties
        entry={props.stepFx}
        entityName="Step FX"
        getId={(stepFx) => stepFx.identifiers.id}
        getLabel={(stepFx) => stepFx.identifiers.label}
        onLabelCommit={props.onLabelCommit}
      />
      <Show when={props.stepFx}>
        {(stepFx) => (
          <div class="border-t border-neutral-700 p-4">
            <div class="text-xs font-medium text-neutral-300">Selection</div>
            <SpatialSelectionField
              label="Selection"
              variant="expanded"
              selection={stepFx().selection}
              onChange={props.onSelectionChange}
              class="mt-1 space-y-2"
            />
          </div>
        )}
      </Show>
    </div>
  );
}
