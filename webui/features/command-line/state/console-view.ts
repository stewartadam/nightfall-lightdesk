// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createRoot, createSignal } from "solid-js";

/** Views of the Console panel: the command scrollback with its input, or the session history. */
export type ConsoleView = "console" | "session";

/**
 * The Console panel's selected view, shared so that opening the Console for its input or queued
 * commands always shows the scrollback.
 */
export const [consoleView, setConsoleView] = createRoot(() =>
  createSignal<ConsoleView>("console"),
);
