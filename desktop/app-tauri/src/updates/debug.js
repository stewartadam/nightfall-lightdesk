// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Debug builds only: console helpers that put the update status into any state, so About and the
// update notices can be looked at in every configuration. See updates/debug.rs.
(() => {
  /** Calls a desktop shell command, once the Tauri bridge is available. */
  const invoke = (command, args) =>
    window.__TAURI_INTERNALS__.invoke(command, args);

  window.nightfallUpdates = {
    /** Lists the names `show` accepts. */
    presets: () => invoke("debug_update_presets"),
    /** Shows a ready-made state, such as "ready" or "check-only-available". */
    show: (name) => invoke("debug_update_preset", { name }),
    /**
     * Changes fields of the shown status, named as in DesktopUpdateState; `null` clears one.
     * For example `set({ canInstall: false })`.
     */
    set: (patch) => invoke("debug_update_state", { patch }),
    /** Shows the real update status again. */
    reset: () => invoke("debug_reset_update_state"),
  };
})();
