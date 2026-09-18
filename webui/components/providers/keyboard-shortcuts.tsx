// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { type JSX, onCleanup, onMount } from "solid-js";
import {
  initKeyboardShortcuts,
  setDockApiGetter,
} from "../../lib/keyboardShortcuts";
import { getLogger } from "../../lib/logger";
import { dockApi } from "../../state/appStores";

const log = getLogger(import.meta.url);

/**
 * Provider component that initializes and manages keyboard shortcuts
 * This should be added near the top of your component tree
 */
export default function KeyboardShortcutsProvider(props: {
  children: JSX.Element;
}) {
  const $dockApi = useStore(dockApi);

  onMount(() => {
    log.trace("mounting");
    // Set up DockView API getter for focus fallback detection
    setDockApiGetter(() => $dockApi() ?? null);

    // Initialize keyboard shortcuts system
    const unregister = initKeyboardShortcuts();

    // Clean up when component unmounts
    onCleanup(() => {
      log.trace("unmounting");
      if (unregister) {
        unregister();
      }
    });
  });

  // Return children plus the shortcuts popup
  return <>{props.children}</>;
}
