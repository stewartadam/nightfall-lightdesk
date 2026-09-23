// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SPDX-License-Identifier: MPL-2.0

import { atom } from "nanostores";
import { bestEffortPersistentAtom } from "../../lib/best-effort-persistent-atom";
import { GUIDE_LESSONS } from "./lessons";

/** Keeps invitation dismissal separate from lesson progress and show data. */
export const guideDismissed = bestEffortPersistentAtom<boolean>(
  "nightfall.guide.v1.dismissed",
  false,
  { encode: JSON.stringify, decode: (value) => value === "true" },
);
export const guideOpen = atom(false);
export const guideLessonId = atom<string | null>(null);
export const guideStepIndex = atom(0);
export const guideCompleted = bestEffortPersistentAtom<string[]>(
  "nightfall.guide.v1.completed",
  [],
  {
    encode: JSON.stringify,
    /** Discards malformed or obsolete lesson progress without breaking startup. */
    decode: (value) => {
      try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed)
          ? parsed.filter((id): id is string =>
              GUIDE_LESSONS.some((lesson) => lesson.id === id),
            )
          : [];
      } catch {
        return [];
      }
    },
  },
);

/** Opens the guide without changing the show or losing the current lesson. */
export function openWelcomeGuide(): void {
  guideDismissed.set(true);
  guideOpen.set(true);
}

/** Hides the guide while preserving its current session position. */
export function closeWelcomeGuide(): void {
  guideDismissed.set(true);
  guideOpen.set(false);
}

/** Starts a lesson at its introduction; starting never changes engine state. */
export function startGuideLesson(id: string): void {
  guideLessonId.set(id);
  guideStepIndex.set(-1);
}
