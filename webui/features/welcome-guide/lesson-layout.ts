// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi } from "dockview";
import { bestEffortPersistentAtom } from "../../lib/best-effort-persistent-atom";
import { activateStoredLayout } from "../../lib/layout-activation";
import { createNamedLayout } from "../../lib/layout-management";
import {
  getShowfilePanelLayouts,
  getStoredLayout,
} from "../../lib/layoutStorage";
import { activeLayoutId } from "../../state/layout-switcher";

/** Name of the shared layout every lesson starts from, kept apart from the user's own layouts. */
export const LESSON_LAYOUT_NAME = "Lesson";

/**
 * Remembers which layout the guide created, so a user's own layout that happens to share
 * the name is never rebuilt.
 */
const lessonLayoutId = bestEffortPersistentAtom<string | null>(
  "nightfall.guide.v1.lessonLayoutId",
  null,
  { encode: (value) => value ?? undefined, decode: (value) => value || null },
);

/** Finds the visible layout the guide created for lessons, if this showfile still has it. */
export function findLessonLayoutId(): string | undefined {
  const id = lessonLayoutId.get();
  return id && getStoredLayout(id)?.shownInSwitcher ? id : undefined;
}

/** Picks a layout name for lessons that doesn't collide with an existing layout. */
function availableLessonLayoutName(): string {
  const names = new Set(getShowfilePanelLayouts().map((layout) => layout.name));
  let name = LESSON_LAYOUT_NAME;
  for (let index = 2; names.has(name); index += 1)
    name = `${LESSON_LAYOUT_NAME} ${index}`;
  return name;
}

/** Creates the layout lessons run in and remembers it as the guide's own. */
async function createLessonLayout(api: DockviewApi): Promise<string | null> {
  const layout = await createNamedLayout(
    api,
    availableLessonLayoutName(),
    true,
  );
  if (!layout) return null;
  lessonLayoutId.set(layout.id);
  return layout.id;
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
  const lessonId = findLessonLayoutId() ?? (await createLessonLayout(api));
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
