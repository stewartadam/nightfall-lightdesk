// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleTauriMenuAction, TAURI_MENU_ACTIONS } from "./tauri-menu";

/** Export opens its own dialog without invoking the current show's save action. */
test("native Export Showfile dispatches independently of Save", () => {
  const calls: string[] = [];
  handleTauriMenuAction(TAURI_MENU_ACTIONS.exportShowfile, {
    exportShowfile: () => calls.push("export"),
    saveShowfile: () => calls.push("save"),
  });
  assert.deepEqual(calls, ["export"]);
});

/** Native menu actions reach the matching shell handler. */
test("handleTauriMenuAction dispatches supported menu actions", () => {
  const calls: string[] = [];

  handleTauriMenuAction(TAURI_MENU_ACTIONS.about, {
    openDiagnostics: () => calls.push("diagnostics"),
    openAbout: () => calls.push("about"),
    openSettings: () => calls.push("settings"),
    newShowfile: () => calls.push("new-showfile"),
    openShowfile: () => calls.push("open-showfile"),
    saveShowfile: () => calls.push("save-showfile"),
    showCommandPalette: () => calls.push("palette"),
    showKeyboardShortcuts: () => calls.push("shortcuts"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  });

  handleTauriMenuAction(TAURI_MENU_ACTIONS.settings, {
    openDiagnostics: () => calls.push("diagnostics"),
    openAbout: () => calls.push("about"),
    openSettings: () => calls.push("settings"),
    newShowfile: () => calls.push("new-showfile"),
    openShowfile: () => calls.push("open-showfile"),
    saveShowfile: () => calls.push("save-showfile"),
    showCommandPalette: () => calls.push("palette"),
    showKeyboardShortcuts: () => calls.push("shortcuts"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  });

  handleTauriMenuAction(TAURI_MENU_ACTIONS.newShowfile, {
    openDiagnostics: () => calls.push("diagnostics"),
    openAbout: () => calls.push("about"),
    openSettings: () => calls.push("settings"),
    newShowfile: () => calls.push("new-showfile"),
    openShowfile: () => calls.push("open-showfile"),
    saveShowfile: () => calls.push("save-showfile"),
    showCommandPalette: () => calls.push("palette"),
    showKeyboardShortcuts: () => calls.push("shortcuts"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  });

  handleTauriMenuAction(TAURI_MENU_ACTIONS.loadShowfile, {
    openDiagnostics: () => calls.push("diagnostics"),
    openAbout: () => calls.push("about"),
    openSettings: () => calls.push("settings"),
    newShowfile: () => calls.push("new-showfile"),
    openShowfile: () => calls.push("open-showfile"),
    saveShowfile: () => calls.push("save-showfile"),
    showCommandPalette: () => calls.push("palette"),
    showKeyboardShortcuts: () => calls.push("shortcuts"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  });

  handleTauriMenuAction(TAURI_MENU_ACTIONS.saveShowfile, {
    openDiagnostics: () => calls.push("diagnostics"),
    openAbout: () => calls.push("about"),
    openSettings: () => calls.push("settings"),
    newShowfile: () => calls.push("new-showfile"),
    openShowfile: () => calls.push("open-showfile"),
    saveShowfile: () => calls.push("save-showfile"),
    showCommandPalette: () => calls.push("palette"),
    showKeyboardShortcuts: () => calls.push("shortcuts"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  });

  handleTauriMenuAction(TAURI_MENU_ACTIONS.commandPalette, {
    openDiagnostics: () => calls.push("diagnostics"),
    openAbout: () => calls.push("about"),
    openSettings: () => calls.push("settings"),
    newShowfile: () => calls.push("new-showfile"),
    openShowfile: () => calls.push("open-showfile"),
    saveShowfile: () => calls.push("save-showfile"),
    showCommandPalette: () => calls.push("palette"),
    showKeyboardShortcuts: () => calls.push("shortcuts"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  });

  handleTauriMenuAction(TAURI_MENU_ACTIONS.keyboardShortcuts, {
    openDiagnostics: () => calls.push("diagnostics"),
    openAbout: () => calls.push("about"),
    openSettings: () => calls.push("settings"),
    newShowfile: () => calls.push("new-showfile"),
    openShowfile: () => calls.push("open-showfile"),
    saveShowfile: () => calls.push("save-showfile"),
    showCommandPalette: () => calls.push("palette"),
    showKeyboardShortcuts: () => calls.push("shortcuts"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  });

  handleTauriMenuAction(TAURI_MENU_ACTIONS.undo, {
    openDiagnostics: () => calls.push("diagnostics"),
    openAbout: () => calls.push("about"),
    openSettings: () => calls.push("settings"),
    newShowfile: () => calls.push("new-showfile"),
    openShowfile: () => calls.push("open-showfile"),
    saveShowfile: () => calls.push("save-showfile"),
    showCommandPalette: () => calls.push("palette"),
    showKeyboardShortcuts: () => calls.push("shortcuts"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  });

  handleTauriMenuAction(TAURI_MENU_ACTIONS.redo, {
    openDiagnostics: () => calls.push("diagnostics"),
    openAbout: () => calls.push("about"),
    openSettings: () => calls.push("settings"),
    newShowfile: () => calls.push("new-showfile"),
    openShowfile: () => calls.push("open-showfile"),
    saveShowfile: () => calls.push("save-showfile"),
    showCommandPalette: () => calls.push("palette"),
    showKeyboardShortcuts: () => calls.push("shortcuts"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  });

  handleTauriMenuAction(TAURI_MENU_ACTIONS.diagnostics, {
    openDiagnostics: () => calls.push("diagnostics"),
    openAbout: () => calls.push("about"),
    openSettings: () => calls.push("settings"),
    newShowfile: () => calls.push("new-showfile"),
    openShowfile: () => calls.push("open-showfile"),
    saveShowfile: () => calls.push("save-showfile"),
    showCommandPalette: () => calls.push("palette"),
    showKeyboardShortcuts: () => calls.push("shortcuts"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  });

  assert.deepEqual(calls, [
    "about",
    "settings",
    "new-showfile",
    "open-showfile",
    "save-showfile",
    "palette",
    "shortcuts",
    "undo",
    "redo",
    "diagnostics",
  ]);
});

/** Unknown native actions leave all shell handlers untouched. */
test("handleTauriMenuAction ignores unknown menu actions", () => {
  let called = false;

  handleTauriMenuAction("not-a-real-action", {
    openDiagnostics: () => {
      called = true;
    },
    openAbout: () => {
      called = true;
    },
    openSettings: () => {
      called = true;
    },
    newShowfile: () => {
      called = true;
    },
    openShowfile: () => {
      called = true;
    },
    saveShowfile: () => {
      called = true;
    },
    showCommandPalette: () => {
      called = true;
    },
    showKeyboardShortcuts: () => {
      called = true;
    },
    undo: () => {
      called = true;
    },
    redo: () => {
      called = true;
    },
  });

  assert.equal(called, false);
});

/** Native bug reporting opens the issue form independently of diagnostic collection. */
test("native Report a Bug opens the issue form", () => {
  let calls = 0;
  handleTauriMenuAction(TAURI_MENU_ACTIONS.reportBug, {
    reportBug: () => {
      calls++;
    },
  });
  assert.equal(calls, 1);
});
