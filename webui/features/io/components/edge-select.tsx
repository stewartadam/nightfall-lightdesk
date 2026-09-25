// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { JSX } from "solid-js";
import { NativeSelect } from "../../../components/ui/form-controls";
import * as types from "../../../types";

/** Chooses whether a new mapping fires on the control's press or its release. */
export function EdgeSelect(props: {
  /** Currently selected edge. */
  value: types.SourceEdge;
  /** Receives the newly selected edge. */
  onChange: (edge: types.SourceEdge) => void;
}): JSX.Element {
  return (
    <NativeSelect
      density="compact"
      aria-label="Fires on"
      value={props.value}
      onChange={(event) =>
        props.onChange(event.currentTarget.value as types.SourceEdge)
      }
    >
      <option value={types.SourceEdge.Press}>On press</option>
      <option value={types.SourceEdge.Release}>On release</option>
    </NativeSelect>
  );
}
