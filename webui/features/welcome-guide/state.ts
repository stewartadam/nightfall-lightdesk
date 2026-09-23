// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SPDX-License-Identifier: MPL-2.0

import { atom, type WritableAtom } from "nanostores";
import { bestEffortPersistentAtom } from "../../lib/best-effort-persistent-atom";
import { GUIDE_LESSONS } from "./lessons";

/** Keeps invitation dismissal separate from lesson progress and show data. */
export const guideDismissed = bestEffortPersistentAtom<boolean>(
  "nightfall.guide.v1.dismissed",
  false,
  { encode: JSON.stringify, decode: (value) => value === "true" },
);
type GuideSession = {
  open: WritableAtom<boolean>;
  lessonId: WritableAtom<string | null>;
  stepIndex: WritableAtom<number>;
};

const hotData = import.meta.hot?.data as
  | { guideSession?: GuideSession }
  | undefined;
const session = hotData?.guideSession ?? {
  open: atom(false),
  lessonId: atom<string | null>(null),
  stepIndex: atom(0),
};
// Preserve store identity when lesson edits re-evaluate this module and its importers.
if (hotData) hotData.guideSession = session;

export const guideOpen = session.open;
export const guideLessonId = session.lessonId;
export const guideStepIndex = session.stepIndex;
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

/** Starts directly at the first instruction without changing engine state. */
export function startGuideLesson(id: string): void {
  guideLessonId.set(id);
  guideStepIndex.set(0);
}
