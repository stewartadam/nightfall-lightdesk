// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi } from "dockview";
import { activateStoredLayout } from "../../lib/layout-activation";
import { createNamedLayout } from "../../lib/layout-management";
import {
  getShowfilePanelLayouts,
  getStoredLayout,
} from "../../lib/layoutStorage";
import { activeLayoutId } from "../../state/layout-switcher";

/** Name of the shared layout every lesson starts from, kept apart from the user's own layouts. */
export const LESSON_LAYOUT_NAME = "Lesson";

/** Finds the visible Lesson layout, if this showfile already has one. */
export function findLessonLayoutId(): string | undefined {
  return getShowfilePanelLayouts().find(
    (layout) => layout.name === LESSON_LAYOUT_NAME && layout.shownInSwitcher,
  )?.id;
}

/**
 * Switches to the Lesson layout and rebuilds it in the default arrangement, creating it on first use.
 * The user's layout keeps its own arrangement and stays available in the layout switcher.
 * Returns the layout that was active before, or null when the switch failed.
 */
export async function enterLessonLayout(
  api: DockviewApi,
  resetLayout: () => boolean,
): Promise<{ previousLayoutId: string | null } | null> {
  const previousLayoutId = activeLayoutId.get();
  const lessonId =
    findLessonLayoutId() ??
    (await createNamedLayout(api, LESSON_LAYOUT_NAME, true))?.id;
  if (!lessonId) return null;
  if (!(await activateStoredLayout(api, lessonId, { reset: true })))
    return null;
  if (!resetLayout()) return null;
  return { previousLayoutId };
}

/** Switches back to the layout the user had before starting lessons, if it still exists. */
export async function leaveLessonLayout(
  api: DockviewApi,
  layoutId: string,
): Promise<boolean> {
  if (!getStoredLayout(layoutId)) return false;
  return activateStoredLayout(api, layoutId);
}

/** Resolves a layout's display name for the return button. */
export function layoutName(layoutId: string): string | undefined {
  return getStoredLayout(layoutId)?.name;
}
