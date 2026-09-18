// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FileArrowDownIcon } from "@squidlab/phosphor-solid/file-arrow-down";
import { onMount } from "solid-js";
import { useAppShell } from "../../../providers/app-shell";
import { useCommand } from "../../../providers/command-registry";

/** Makes showfile export discoverable through the command palette in desktop and browser runtimes. */
export default function ExportShowfileCommand() {
  const { showShowfileExportModal } = useAppShell();
  /** Registers the shared export dialog as a searchable command. */
  onMount(() => {
    useCommand({
      id: "showfile.export",
      name: "Export Showfile",
      description: "Export a copy of the current show with selected references",
      icon: FileArrowDownIcon,
      execute: showShowfileExportModal,
    });
  });
  return null;
}
