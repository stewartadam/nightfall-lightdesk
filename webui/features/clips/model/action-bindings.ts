// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo } from "solid-js";
import { clips, controls } from "../../../state/appStores";
import { buildArgumentTargetChoices } from "../../action-mapping";
import { buildClipActionBindingChoices } from "./action-binding-choices";

/** Supplies persistent clip UID arguments for catalog consumers such as timeline insertion. */
export function createClipActionBindingChoices() {
  const $clips = useStore(clips);
  /** Rebuilds choices as clips are created, renamed, or removed. */
  return createMemo(() => buildClipActionBindingChoices($clips()));
}

/** Offers control-slot references that retain the slot when its clip or master is reassigned. */
export function createControlActionBindingChoices() {
  const $controls = useStore(controls);
  /** Rebuilds the available bank slots without binding to their current assignments. */
  return createMemo(() =>
    ["control.go", "control.set-external"].map((id) =>
      buildArgumentTargetChoices(
        id,
        "control_index",
        $controls().map((control) => ({
          label: `Control ${control.index}`,
          value: control.index,
        })),
      ),
    ),
  );
}
