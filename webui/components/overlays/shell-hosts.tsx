// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect } from "solid-js";
import { compactViewport } from "../../state/viewport";
import { useAppShell } from "../providers/app-shell";
import LayoutManager from "../shell/docking/layout-manager";
import GlobalContextMenuHost from "./context-menu";
import ShortcutsPopup from "./keyboard-shortcuts";

/** Mounts global overlay presentation outside state-only providers. */
export default function ShellOverlayHosts() {
  const { isLayoutManagerVisible, hideLayoutManager } = useAppShell();
  const compact = useStore(compactViewport);

  /**
   * Closes layout management when the window narrows into the compact shell,
   * whose one-panel view must never be stored as a named layout.
   */
  createEffect(() => {
    if (compact() && isLayoutManagerVisible()) hideLayoutManager();
  });

  return (
    <>
      <GlobalContextMenuHost />
      <ShortcutsPopup />
      <LayoutManager
        isOpen={isLayoutManagerVisible()}
        onClose={hideLayoutManager}
      />
    </>
  );
}
