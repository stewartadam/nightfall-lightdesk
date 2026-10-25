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
export const GUIDE_LESSONS: GuideLesson[] = [
  {
    id: "basics",
    label: "Module 1 · Orientation",
    title: "Welcome to Nightfall",
    duration: "6–8 min",
    leavesShowUnchanged: true,
    introduction:
      "Get oriented: play the sample show, inspect properties, find your way around, and personalize Nightfall.",
    steps: [
      {
        id: "visualizer",
        title: "Meet your sample rig",
        target: '[data-component="Visualizer"][data-panel-id]',
        content: [
          {
            type: "text",
            text: "The 3D Visualizer shows the sample rig responding to live lighting instructions. Watch it as you explore playback.",
          },
          { type: "prerequisite", panels: ["Visualizer"] },
          {
            type: "action",
            body: "Find the pixel strips, moving heads, and strobes in the Visualizer, then continue.",
          },
        ],
      },
      {
        id: "open-timeline",
        title: "Open the sample timeline",
        targetSampleTimeline: true,
        keepVisible: ["tab"],
        observe: {
          type: "sample-panels",
        },
        content: [
          {
            type: "text",
            text: "Lo-fi layers a pastel rainbow on the pixel strips with white flashes on the snare and on the music’s breaks.",
          },
          {
            type: "prerequisite",
            panels: ["Visualizer"],
            sampleTimeline: true,
          },
          {
            type: "action",
            body: "Open Timeline 1: Lo-fi and keep the 3D Visualizer open beside it.",
          },
        ],
      },
      {
        id: "play-timeline",
        title: "Start the sample show",
        keepVisible: ["panel"],
        // Play relabels itself Pause when pressed; matching both keeps the card anchored meanwhile.
        target: '[aria-label="Play timeline"], [aria-label="Pause timeline"]',
        observe: {
          type: "timeline-playing",
        },
        content: [
          {
            type: "text",
            text: "A timeline turns individual looks and effects into a timed show.",
          },
          {
            type: "prerequisite",
            panels: ["Visualizer"],
            sampleTimeline: true,
          },
          {
            type: "action",
            body: "Press Play timeline on Lo-fi and watch the pixel strips in the Visualizer.",
          },
        ],
      },
      {
        id: "watch",
        title: "Stop playback",
        placement: "above",
        target: '[aria-label="Stop timeline"]',
        observe: {
          type: "timeline-stopped",
        },
        content: [
          {
            type: "text",
            text: "Each chip on the timeline starts or stops a clip in time with the music: the rainbow pulse, the strobe snaps, and the flashes.",
          },
          {
            type: "action",
            body: "Watch for a few seconds, then press Stop timeline before programming your own look.",
          },
        ],
      },

      {
        id: "start-clip",
        title: "Launch a clip",
        keepVisible: ["visualizer"],
        targetClip: { id: 1 },
        observe: { type: "clip-playing", clipId: 1 },
        content: [
          {
            type: "text",
            text: "A clip plays a sequence or effect. The timeline launched clips for you; you can also launch them directly.",
          },
          { type: "prerequisite", panels: ["ClipList", "Visualizer"] },
          {
            type: "action",
            body: "Click clip 1: RGB cycle (full) to start it, and watch the Visualizer.",
          },
        ],
      },
      {
        id: "stop-clip",
        title: "Stop a clip",
        targetClip: { id: 1 },
        observe: { type: "clip-stopped", clipId: 1 },
        content: [
          {
            type: "text",
            text: "Clicking a running clip again stops its playback.",
          },
          { type: "action", body: "Click RGB cycle (full) again to stop it." },
        ],
      },
      {
        id: "properties",
        title: "Explore clip properties",
        targetClip: { id: 1, gear: true },
        observe: { type: "panel", component: "PropertiesInspector" },
        content: [
          {
            type: "text",
            text: "Properties shows settings for the object you inspect. A clip’s Source tells you which sequence or effect it plays.",
          },
          { type: "prerequisite", panels: ["ClipList"] },
          {
            type: "action",
            body: "Click the gear on RGB cycle (full) to open its Properties. Look for Source and the linked sequence.",
          },
        ],
      },
      {
        id: "ready",
        title: "Properties follows your focus",
        target: '[data-component="PropertiesInspector"][data-panel-id]',
        content: [
          {
            type: "text",
            text: "Properties changes with the panel you focus. It currently shows the clip you inspected; focusing the timeline reveals its settings instead.",
          },
          {
            type: "prerequisite",
            panels: ["PropertiesInspector"],
            sampleTimeline: true,
          },
          {
            type: "action",
            body: "Click the Timeline 1: Lo-fi tab to focus it. Watch Properties switch from clip settings to timeline settings, then continue.",
          },
        ],
      },
      {
        id: "command-input",
        title: "A shortcut for lighting instructions",
        target: "#header-cmdline",
        focusTarget: true,
        observe: {
          type: "command-submitted",
          command: "fix 601>606 green @ 100; sleep 2; clear",
        },
        content: [
          {
            type: "text",
            text: "The command input lets you select fixtures, set values, and control playback by typing. It is separate from the Command Palette, which finds panels and app actions.",
          },
          {
            type: "action",
            title: "Try this command",
            body: "It will set the LED strobes to green for 2 seconds.",
            command: "fix 601>606 green @ 100; sleep 2; clear",
          },
        ],
      },
      {
        id: "layouts",
        title: "Arrange your workspace",
        target: '[aria-label="Layout switcher"]',
        content: [
          {
            type: "text",
            text: "Layouts save arrangements of panels, so you can keep different workspaces for programming and playback. The layout switcher shows your current layout and lets you choose another.",
          },
        ],
      },
      {
        id: "command-palette",
        title: "Find panels and app actions",
        target:
          '[data-dialog-kind="command-palette"] input, [aria-label="Open command palette"]',
        observe: { type: "command-palette" },
        content: [
          {
            type: "text",
            text: "The Command Palette searches for panels and app actions. It is available any time.",
          },
          {
            type: "action",
            body: "Click Search or press {command-palette-shortcut} to open the Command Palette.",
          },
        ],
      },
      {
        id: "open-settings",
        title: "Open Settings",
        target:
          '[data-dialog-kind="command-palette"] input, [aria-label="Open command palette"]',
        observe: { type: "settings" },
        content: [
          {
            type: "text",
            text: "Settings includes appearance preferences and application behavior. Let’s personalize the accent color.",
          },
          {
            type: "action",
            body: "Search for Settings in the Command Palette, then press Enter.",
          },
        ],
      },
      {
        id: "accent",
        observe: { type: "accent-settings-closed" },
        onAdvance: [{ type: "close", surface: "settings" }],
        title: "Choose your accent color",
        target:
          '[aria-label="Settings"] .nf-accent-picker, [aria-label="Settings"]:not(:has(.nf-accent-picker)) [role="tab"][id$="-appearance"]',
        content: [
          {
            type: "text",
            text: "Appearance settings change how Nightfall looks. The accent color marks active controls and highlights throughout the app.",
          },
          {
            type: "action",
            body: "Open the Appearance tab in Settings, then choose an accent swatch. Try a few colors and keep your favorite. Close Settings when you’re happy to move on.",
          },
        ],
      },
      {
        id: "undo-redo",
        title: "Edits apply as you work",
        target: '[data-guide-target="undo-redo"]',
        placement: "above",
        content: [
          {
            type: "text",
            text: "Changes to lighting objects apply automatically as you edit them. Use Undo to reverse an edit.",
          },
          {
            type: "action",
            body: "Mouse over the undo or redo buttons to preview the action; the arrow beside them opens the undo history. You don’t need to undo anything now—continue when you’re ready.",
          },
        ],
      },
      {
        id: "save-showfile",
        diskStorageUnavailable: {
          title: "Demo edits are temporary",
          target: '[aria-label="Menu"]',
          observe: undefined,
          content: [
            {
              type: "text",
              text: "This browser demo keeps your edits only for the current session. Automatic draft recovery and Save Showfile are unavailable here.",
            },
            {
              type: "text",
              text: "In the installed app, changes are saved automatically to a draft. Menu → Save Showfile updates the saved version of your whole show.",
            },
            {
              type: "action",
              body: "Continue to explore the keyboard shortcut reference. You don’t need to save anything in this demo.",
            },
          ],
        },
        observe: { type: "save-showfile" },
        title: "Keep a saved version of your show",
        target:
          '[data-component="DropdownMenuItem"]:has([data-guide-target="save-showfile"]), [aria-label="Menu"]:not([aria-expanded="true"])',
        content: [
          {
            type: "text",
            text: "Nightfall automatically saves your showfile changes to a draft. Save Showfile explicitly updates the saved version of the whole show. A draft lets you recover work made since that saved version.",
          },
          {
            type: "action",
            body: "Open Menu at the bottom left and choose Save Showfile to save the sample show’s current state.",
          },
        ],
      },
      {
        id: "keyboard-shortcuts",
        observe: { type: "shortcuts-closed" },
        title: "Discover keyboard shortcuts",
        onAdvance: [{ type: "close", surface: "keyboard-shortcuts" }],
        target:
          '[data-dialog-kind="shortcuts"] [aria-label="Keyboard shortcuts"], [data-component="DropdownMenuItem"]:has([data-guide-target="keyboard-shortcuts"]), [aria-label="Menu"]:not([aria-expanded="true"])',
        content: [
          {
            type: "text",
            text: "The keyboard shortcut reference lists bindings for navigation, editing, and playback. You can return to it whenever you want to learn a faster way to work.",
          },
          {
            type: "action",
            body: "Open Menu at the bottom left, then choose Keyboard Shortcuts. Browse the reference, then close it to finish the introduction.",
          },
        ],
      },
    ],
  },
];
