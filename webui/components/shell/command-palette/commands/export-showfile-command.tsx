// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { FileArrowDownIcon } from "@squidlab/phosphor-solid/file-arrow-down";
import { onMount, Show } from "solid-js";
import { hasDiskStorage } from "../../../../lib/disk-storage";
import { runtimeCapabilities } from "../../../../state/appStores";
import { useAppShell } from "../../../providers/app-shell";
import { useUiAction } from "../../../providers/command-registry";

/** Registers the shared export dialog as a searchable command while it is mounted. */
function ExportShowfileAction() {
  const { showShowfileExportModal } = useAppShell();
  /** Adds the export command to the palette for this component's lifetime. */
  onMount(() => {
    useUiAction({
      id: "showfile.export",
      name: "Export Showfile",
      description: "Export a copy of the current show with selected references",
      icon: FileArrowDownIcon,
      execute: showShowfileExportModal,
    });
  });
  return null;
}

/** Makes showfile export discoverable through the command palette when the backend can store shows on disk. */
export default function ExportShowfileCommand() {
  const capabilities = useStore(runtimeCapabilities);
  return (
    <Show when={hasDiskStorage(capabilities())}>
      <ExportShowfileAction />
    </Show>
  );
}
