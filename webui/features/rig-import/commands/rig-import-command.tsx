// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CloudArrowUpIcon } from "@squidlab/phosphor-solid/cloud-arrow-up";
import { onMount, Show } from "solid-js";
import { useUiAction } from "../../../components/providers/command-registry";
import { hasDiskStorage } from "../../../lib/disk-storage";
import { runtimeCapabilities } from "../../../state/appStores";
import { openRigImportDialog } from "../model/rig-import-model";

/** Palette action id for opening the rig import dialog. */
export const IMPORT_RIG_ACTION_ID = "rig.import";

/** Registers the rig import dialog as a searchable command while it is mounted. */
function RigImportAction() {
  /** Adds the import command to the palette for this component's lifetime. */
  onMount(() => {
    useUiAction({
      id: IMPORT_RIG_ACTION_ID,
      name: "Import Rig from MVR",
      description:
        "Add the fixtures from an MVR file made in Vectorworks, Capture or another MVR tool",
      icon: CloudArrowUpIcon,
      execute: openRigImportDialog,
    });
  });
  return null;
}

/**
 * Makes rig import discoverable through the command palette when the backend can store files on
 * disk, which the engine needs to unpack the MVR file and its fixture types.
 */
export function RigImportCommand() {
  const capabilities = useStore(runtimeCapabilities);
  return (
    <Show when={hasDiskStorage(capabilities())}>
      <RigImportAction />
    </Show>
  );
}
