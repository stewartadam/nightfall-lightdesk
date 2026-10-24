// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PanelComponentName } from "../../lib/panel-definitions";
import type { GuideObservation } from "./progress";

/** Ordered lesson blocks; an unmet prerequisite hides all following items. */
export type GuideContent =
  | { type: "text"; text: string }
  | { type: "action"; title?: string; body: string; command?: string }
  | {
      type: "prerequisite";
      panels?: PanelComponentName[];
      sampleTimeline?: boolean;
      /**
       * Opens a panel as a tab beside another panel when that panel is open, instead of in the
       * focused group. `sampleTimeline` opens beside the Timelines list unless set here.
       */
      openBeside?: Partial<
        Record<PanelComponentName | "sampleTimeline", PanelComponentName>
      >;
    }
  | { type: "details"; title: string; text: string }
  | { type: "stop-playback" };

export type GuidePrerequisite = Extract<GuideContent, { type: "prerequisite" }>;

/** Where a step prefers its card relative to the target. */
export type GuidePlacement = "above" | "side";

/** Tidies up after a step when the user moves on with Continue or Skip, as Close or Escape would. */
export type GuideAdvanceAction = {
  type: "close";
  surface: "settings" | "keyboard-shortcuts";
};

/**
 * An area the card must leave uncovered in addition to the target: the target's whole panel
 * including its tab, just the panel's tab, its grid row, the cells of its row before the target
 * (such as a row's ID and label), or the 3D Visualizer viewport.
 */
export type GuideFocusArea =
  | "panel"
  | "tab"
  | "row"
  | "row-start"
  | "visualizer";

export interface GuideStep {
  diskStorageUnavailable?: Pick<
    GuideStep,
    "title" | "content" | "target" | "observe"
  >;
  id: string;
  title: string;
  content: GuideContent[];
  highlightClipId?: number;
  target?: string;
  targetSequence?: { id: number; cueId?: number };
  targetClip?: { id: number; gear?: boolean };
  /** Targets an action chip in the sample timeline editor by track and action ID. */
  targetTimelineAction?: { trackId: string; actionId: string };
  /** Targets a fixture's ID cell in Patch, or the Fixtures view tab while DMX Routes is showing. */
  targetPatchFixture?: { id: number };
  /** Targets a regular FX card or list row in FX List by its user-facing ID. */
  targetFx?: { id: number };
  /** Targets the sample timeline's card in the Timelines list. */
  targetSampleTimeline?: boolean;
  /**
   * Preferred card position: above the target, or beside it (left or right) so menus that open
   * below the target never push the card away.
   */
  placement?: GuidePlacement;
  /**
   * Areas the user needs to see during this step. When set, the card may cover the rest of the
   * target's panel; without it, the card only prefers to avoid that panel.
   */
  keepVisible?: GuideFocusArea[];
  /**
   * Focuses the target once when it appears, and again whenever the step's target moves to another
   * element. Steps that target the command input focus it by default, so users can type the
   * suggested command straight away.
   */
  focusTarget?: boolean;
  observe?: GuideObservation;
  /** Runs when the user moves past this step with Continue or Skip. */
  onAdvance?: GuideAdvanceAction[];
}
export interface GuideLesson {
  id: string;
  /** Library eyebrow placing the lesson in the learning path; defaults to a follow-on lesson. */
  label?: string;
  title: string;
  duration: string;
  introduction: string;
  /** Marks a lesson that only looks around, so its ending doesn't suggest saving changes. */
  leavesShowUnchanged?: boolean;
  steps: GuideStep[];
}
/** Lessons offered in the library, in learning-path order. */
export const GUIDE_LESSONS: GuideLesson[] = [];
