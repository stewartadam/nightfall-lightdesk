// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getLogger } from "../../../lib/logger";
import { isTauriRuntime } from "../../../lib/tauri";

const log = getLogger(import.meta.url);

/** Query parameter that selects which app window a page renders. */
const WINDOW_PARAM = "window";

/** Value of the window parameter that renders the fixture editor. */
const FIXTURE_EDITOR_WINDOW = "fixture-editor";

/** Browser window name, so reopening the editor reuses its tab or window. */
const BROWSER_WINDOW_NAME = "nightfall-fixture-editor";

/** Editor window this page opened in the browser, kept so a second open only focuses it. */
let browserWindow: Window | null = null;

/** Returns whether this page is the fixture editor window rather than the main workspace. */
export function isFixtureEditorWindow(): boolean {
  if (typeof window === "undefined") return false;
  return (
    new URLSearchParams(window.location.search).get(WINDOW_PARAM) ===
    FIXTURE_EDITOR_WINDOW
  );
}

/**
 * Builds the editor page address from the current one. Other query parameters,
 * such as feature flags, carry over so the editor runs with the same settings.
 */
export function fixtureEditorUrl(current: string): string {
  const url = new URL(current);
  url.searchParams.set(WINDOW_PARAM, FIXTURE_EDITOR_WINDOW);
  url.hash = "";
  return url.href;
}

/**
 * Opens the fixture editor in its own window, or focuses it when it is already
 * open. The desktop app opens a native window; a browser opens a new window or
 * tab, which pop-up blockers allow because this runs from a click or shortcut.
 */
export async function openFixtureEditorWindow(): Promise<void> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_fixture_editor");
    return;
  }

  if (browserWindow && !browserWindow.closed) {
    browserWindow.focus();
    return;
  }
  browserWindow = window.open(
    fixtureEditorUrl(window.location.href),
    BROWSER_WINDOW_NAME,
  );
  if (!browserWindow) {
    log.warn("The browser blocked the fixture editor window");
    throw new Error(
      "The browser blocked the fixture editor window. Allow pop-ups for this page and try again.",
    );
  }
}
