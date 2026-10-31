// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  handleTauriMenuAction,
  TAURI_MENU_ACTIONS,
  toTauriAccelerator,
} from "./tauri-menu";

/** Export opens its own dialog without invoking the current show's save action. */
test("native Export Showfile dispatches independently of Save", () => {
  const calls: string[] = [];
  handleTauriMenuAction(TAURI_MENU_ACTIONS.exportShowfile, {
    exportShowfile: () => calls.push("export"),
    saveShowfile: () => calls.push("save"),
  });
  assert.deepEqual(calls, ["export"]);
});

/** The native Help menu's Welcome Guide item opens the guide. */
test("handleTauriMenuAction opens the welcome guide", () => {
  const calls: string[] = [];

  handleTauriMenuAction(TAURI_MENU_ACTIONS.welcomeGuide, {
    openAbout: () => calls.push("about"),
    openWelcomeGuide: () => calls.push("welcome-guide"),
  });

  assert.deepEqual(calls, ["welcome-guide"]);
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

/** Web-defined menu ids reach the web menu handler; unknown native ids reach nothing. */
test("handleTauriMenuAction routes web menu ids to the web menu handler", () => {
  const calls: string[] = [];
  const handlers = { webMenuAction: (id: string) => calls.push(id) };
  handleTauriMenuAction("web.layout.main", handlers);
  handleTauriMenuAction("app.unknown", handlers);
  assert.deepEqual(calls, ["web.layout.main"]);
});

/** Shortcuts with a command-style modifier become native accelerators in Tauri syntax. */
test("toTauriAccelerator converts modified letter, digit and function keys", () => {
  assert.equal(toTauriAccelerator("$mod+Shift+p"), "CmdOrCtrl+Shift+P");
  assert.equal(toTauriAccelerator("$mod+p"), "CmdOrCtrl+P");
  assert.equal(toTauriAccelerator("Control+KeyG"), "Ctrl+G");
  assert.equal(toTauriAccelerator("Alt+Digit1"), "Alt+1");
  assert.equal(toTauriAccelerator("$mod+F5"), "CmdOrCtrl+F5");
});

/** Keys a native menu would swallow from text fields, or cannot express, stay web-only. */
test("toTauriAccelerator leaves unsafe or unsupported shortcuts web-only", () => {
  assert.equal(toTauriAccelerator("Shift+?"), undefined);
  assert.equal(toTauriAccelerator("Shift+`"), undefined);
  assert.equal(toTauriAccelerator("n"), undefined);
  assert.equal(toTauriAccelerator("$mod+k w"), undefined);
  assert.equal(toTauriAccelerator("$mod+,"), undefined);
  assert.equal(toTauriAccelerator("$mod+Hyper+p"), undefined);
});
