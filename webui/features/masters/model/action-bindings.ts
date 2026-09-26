// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo } from "solid-js";
import { normalizeFixtureUid } from "../../../lib/binding-utils";
import { masters } from "../../../state/appStores";
import { buildArgumentTargetChoices } from "../../action-mapping";

/** Offers direct master bindings using persistent UIDs, independent of panel lifetime. */
export function createMasterActionBindingChoices() {
  const $masters = useStore(masters);
  /** Refreshes labels and availability while preserving stored UID references. */
  return createMemo(() => [
    buildArgumentTargetChoices(
      "master.set-level",
      "master_uid",
      Object.values($masters())
        .sort((a, b) => a.identifiers.id - b.identifiers.id)
        .map((master) => ({
          label: `${master.identifiers.id}: ${master.identifiers.label} (${master.kind ?? "Intensity"})`,
          value: normalizeFixtureUid(master.identifiers.uid),
        })),
      (value) =>
        typeof value === "string" ? normalizeFixtureUid(value) : value,
    ),
  ]);
}
