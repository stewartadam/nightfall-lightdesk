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
/** The four pixel strips Your first lights selects, colors and stores in its sequence. */
const FIRST_LIGHTS_FIXTURES = [370, 371, 372, 373];
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
  {
    id: "welcome",
    label: "Module 2",
    title: "Your first lights",
    duration: "8–10 min",
    introduction:
      "Take control of four pixel strips, create your own Red and Blue sequence, and play it with a fader and Go.",
    steps: [
      {
        id: "navigate-palette",
        title: "Find your way around",
        target:
          '[data-dialog-kind="command-palette"] input, [aria-label="Open command palette"]',
        observe: {
          type: "command-palette",
        },
        content: [
          {
            type: "text",
            text: "The Command Palette opens panels or dialogs.",
          },
          {
            type: "action",
            body: "Click here or press {command-palette-shortcut} to open it.",
          },
        ],
      },
      {
        id: "navigate-programmer",
        title: "Open the Programmer",
        target:
          '[data-dialog-kind="command-palette"] input, [aria-label="Open command palette"]',
        observe: {
          type: "panel",
          component: "ProgrammerGrid",
        },
        content: [
          {
            type: "text",
            text: "You can use the Command Palette to open new panels.",
          },
          {
            type: "action",
            body: "Search for 'Programmer' and press Enter.",
          },
        ],
      },
      {
        id: "select",
        title: "Select lights",
        target: "#header-cmdline",
        focusTarget: true,
        observe: {
          type: "selection",
          fixtureIds: FIRST_LIGHTS_FIXTURES,
        },
        content: [
          {
            type: "text",
            text: "The demo pixel strips include fixtures 370–373. The > operator selects an inclusive range.",
          },
          {
            type: "prerequisite",
            panels: ["ProgrammerGrid", "Visualizer"],
          },
          {
            type: "action",
            title: "Type this command, then press Enter:",
            body: "Look for the four selected pixel strips in the Programmer.",
            command: "fix 370>373",
          },
        ],
      },
      {
        id: "intensity",
        title: "Bring up the lights",
        target: "#header-cmdline",
        observe: {
          type: "intensity",
          fixtureIds: FIRST_LIGHTS_FIXTURES,
        },
        content: [
          {
            type: "text",
            text: "The Programmer holds live lighting instructions.",
          },
          {
            type: "prerequisite",
            panels: ["ProgrammerGrid", "Visualizer"],
          },
          {
            type: "text",
            text: "The @ command sets the selected strips’ intensity as a percentage. We will set them to full brightness.",
          },
          {
            type: "action",
            title: "Type this command, then press Enter:",
            body: "",
            command: "@ 100",
          },
          {
            type: "text",
            text: "These fixture values will be held in the Programmer until cleared.",
          },
        ],
      },
      {
        id: "red",
        title: "Make a red look",
        keepVisible: ["visualizer"],
        target: "#header-cmdline",
        observe: {
          type: "color",
          color: "Red",
          fixtureIds: FIRST_LIGHTS_FIXTURES,
        },
        content: [
          {
            type: "text",
            text: "The fixtures have not changed because we did not yet specify a color. These pixel strips mix red, green, and blue to set their color.",
          },
          {
            type: "prerequisite",
            panels: ["ProgrammerGrid", "Visualizer"],
          },
          {
            type: "action",
            title: "Type this command, then press Enter:",
            body: "Watch the four selected pixel strips turn red in the visualizer.",
            command: "red @ 100 green @ 0 blue @ 0",
          },
        ],
      },
      {
        id: "cue-one",
        title: "Store the red cue",
        target: '[aria-label="Store cue"]',
        observe: {
          type: "cue",
          sequenceId: 50,
          id: 1,
        },
        content: [
          {
            type: "text",
            text: "Let’s build a sequence of our own. Sequence 50 is unused in the sample, so its cues will contain only the four strips we selected.",
          },
          {
            type: "prerequisite",
            panels: ["ProgrammerGrid"],
          },
          {
            type: "action",
            title: "Store cue 50.1",
            body: "In Programmer, choose Store cue. Enter Sequence ID 50, Cue ID 1, and Label Red, then confirm. This creates sequence 50.",
          },
        ],
      },
      {
        id: "blue",
        title: "Make a blue look",
        keepVisible: ["visualizer"],
        target: "#header-cmdline",
        observe: {
          type: "color",
          color: "Blue",
          fixtureIds: FIRST_LIGHTS_FIXTURES,
        },
        content: [
          {
            type: "text",
            text: "Let's turn the same fixtures blue. We need to update the programmer with new color values.",
          },
          {
            type: "prerequisite",
            panels: ["ProgrammerGrid", "Visualizer"],
          },
          {
            type: "action",
            title: "Type this command, then press Enter:",
            body: "Watch the same four pixel strips turn blue.",
            command: "red @ 0 green @ 0 blue @ 100",
          },
        ],
      },
      {
        id: "cue-two",
        title: "Store the blue cue",
        target: '[aria-label="Store cue"]',
        observe: {
          type: "cue",
          sequenceId: 50,
          id: 2,
        },
        content: [
          {
            type: "text",
            text: "Keep the same four fixtures selected. Our second cue stores their blue look in the same sequence; Go will advance between the two cues.",
          },
          {
            type: "prerequisite",
            panels: ["ProgrammerGrid"],
          },
          {
            type: "action",
            title: "Store cue 50.2",
            body: "Choose Store cue again. Enter Sequence ID 50, Cue ID 2, and Label Blue, then confirm.",
          },
        ],
      },
      {
        id: "clear",
        title: "Clear the Programmer",
        target: '[aria-label="Clear programmer"]',
        observe: {
          type: "clear",
        },
        content: [
          {
            type: "text",
            text: "Stored cues and live Programmer values are separate. Clear the live instructions so playback can take over.",
          },
          {
            type: "prerequisite",
            panels: ["ProgrammerGrid"],
          },
          {
            type: "action",
            title: "Click Clear twice",
            body: "The first click clears the selection; the second releases the Programmer’s values. You can also press {clear-shortcut} twice.",
          },
        ],
      },
      {
        id: "open-sequence",
        title: "Edit your new sequence",
        targetSequence: { id: 50 },
        observe: { type: "sequence-editor", sequenceId: 50 },
        content: [
          {
            type: "text",
            text: "Your Red and Blue looks are stored in sequence 50. Open it to choose how playback advances between them.",
          },
          { type: "prerequisite", panels: ["SequenceList"] },
          {
            type: "action",
            title: "Open sequence 50",
            body: "In Sequences, open sequence 50 to edit your new sequence.",
          },
        ],
      },
      {
        id: "manual-blue",
        title: "Let Go advance to Blue",
        // Sits just right of the Trigger cell, clear of the panel title and the cue's ID and label.
        keepVisible: ["tab", "row-start"],
        placement: "side",
        targetSequence: { id: 50, cueId: 2 },
        observe: { type: "cue-manual", sequenceId: 50, id: 2 },
        content: [
          {
            type: "text",
            text: "Follow Previous advances to Blue automatically when Red finishes its transition. Manual keeps Red playing until you press Go again.",
          },
          {
            type: "action",
            title: "Set cue 50.2 to Manual",
            body: "In the Blue cue’s row, double-click the highlighted Trigger cell and choose Manual.",
          },
        ],
      },
      {
        id: "create-clip",
        title: "Create a clip to play your sequence",
        // Points at Add clip, then the dialog's ID field until it reads 50, then its Label field.
        target:
          '[aria-label="Add clip"], [role="dialog"] [data-entity-field="id"]:not([data-value="50"]), [role="dialog"] [data-entity-field="label"]',
        focusTarget: true,
        observe: { type: "clip-created", clipId: 50 },
        content: [
          {
            type: "text",
            text: "A clip connects a stored sequence to playback controls. We’ll give our two-cue sequence its own clip.",
          },
          { type: "prerequisite", panels: ["ClipList"] },
          {
            type: "action",
            title: "Create clip 50: First Lights",
            body: "In Clips, click Add clip. Set ID to 50 and Label to First Lights, then click Create.",
          },
        ],
      },
      {
        id: "link-clip",
        title: "Choose your clip’s sequence",
        targetClip: { id: 50, gear: true },
        observe: { type: "clip-sequence", clipId: 50, sequenceId: 50 },
        content: [
          {
            type: "text",
            text: "A clip’s Source is the sequence or effect it plays. Link First Lights to the sequence you just made.",
          },
          { type: "prerequisite", panels: ["ClipList"] },
          {
            type: "action",
            title: "Choose sequence 50 in Properties",
            body: "Click the gear on First Lights. In Properties, under Source, choose Sequence, then find and select sequence 50.",
          },
          {
            type: "action",
            title: "Command alternative",
            body: "You can also set the same source from the command input.",
            command: "set clip 50 target=sequence 50",
          },
        ],
      },
      {
        id: "collapse-properties",
        title: "Make room for the Visualizer",
        target: '[role="tab"][aria-label="Properties"]',
        observe: { type: "panel-hidden", component: "PropertiesInspector" },
        content: [
          {
            type: "text",
            text: "Your clip is linked to sequence 50. Collapse Properties to reveal more of the Visualizer before trying playback.",
          },
          {
            type: "action",
            body: "Click the active Properties tab on the right edge to collapse its panel.",
          },
        ],
      },
      {
        id: "assign",
        title: "Put First Lights on control 6",
        target: '[data-clip-dropzone-index="6"]',
        highlightClipId: 50,
        observe: {
          type: "assigned",
          clipId: 50,
          control: 6,
        },
        content: [
          {
            type: "text",
            text: "Clip 50 starts playback of your new sequence. A control slot gives it a fader and a Go button.",
          },
          {
            type: "prerequisite",
            panels: ["ClipList"],
          },
          {
            type: "action",
            title: "Drop First Lights on control 6.",
            body: "Drag clip 50: First Lights onto control 6’s Drop target. You might need to scroll right, depending on your screen size.",
          },
        ],
      },
      {
        id: "go",
        title: "Start First Lights",
        keepVisible: ["visualizer"],
        target: '[data-control-button-index="6"]:not(:disabled)',
        observe: {
          type: "clip-playing",
          clipId: 50,
        },
        content: [
          {
            type: "text",
            text: "Go starts the sequence at its first cue: Red. The four pixel strips will show your red look.",
          },
          {
            type: "prerequisite",
            panels: ["Visualizer", "ClipList"],
          },
          {
            type: "action",
            body: "Raise control 6’s fader or press its Go button to start the clip.",
          },
        ],
      },
      {
        id: "advance",
        title: "Advance to blue",
        keepVisible: ["visualizer"],
        target: '[data-control-button-index="6"]:not(:disabled)',
        observe: {
          type: "cue-playing",
          clipId: 50,
          position: 2,
        },
        content: [
          {
            type: "text",
            text: "The next Go advances the running sequence to Blue.",
          },
          {
            type: "action",
            body: "Press Go again and watch the pixel strips change from red to blue.",
          },
        ],
      },
      {
        id: "fader",
        title: "Control the level",
        keepVisible: ["visualizer"],
        target:
          '[data-control-index="6"] .noUi-target:not([disabled]) [role="slider"]',
        content: [
          {
            type: "text",
            text: "The fader scales intensity while keeping the programmed color.",
          },
          {
            type: "action",
            title: "Try a few levels on control 6.",
            body: "Move control 6’s fader down and up. Watch the blue pixel strips dim and brighten. Reducing it to zero stops the clip, so it will re-start at cue 1, Red.",
          },
        ],
      },
      {
        id: "stop",
        title: "Stop your clip",
        targetClip: { id: 50 },
        observe: {
          type: "clip-stopped",
          clipId: 50,
        },
        content: [
          {
            type: "text",
            text: "Stopping the clip will stop the sequence and allow the fixtures to be controlled by other active clips, if any.",
          },
          { type: "prerequisite", panels: ["ClipList"] },
          {
            type: "action",
            title: "Click First Lights again",
            body: "Click the running First Lights tile to stop its playback.",
          },
          {
            type: "action",
            title: "Command alternative",
            body: "You can also stop a clip via the command input.",
            command: "clip 50 stop",
          },
        ],
      },
    ],
  },
];
