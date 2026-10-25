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
  | {
      type: "details";
      title: string;
      text: string;
      /**
       * User guide page that covers the topic in depth, as a path inside the guide such as
       * `user-guide/dmx-patching.html`; linked for the running app version.
       */
      guidePage?: string;
    }
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

/** One part of a multi-part step: where the user acts, and the state that finishes the part. */
export interface GuideStepPart {
  target: string;
  until?: GuideObservation;
}

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
  /**
   * Targets a fixture's cell in Patch, in its ID column unless `column` names another, or the
   * Fixtures view tab while DMX Routes is showing. Patch scrolls the fixture into view.
   */
  targetPatchFixture?: { id: number; column?: string };
  /**
   * Selects these fixtures in Patch and scrolls to them whenever its Fixtures view shows during
   * the step, so a toolbar action can act on them straight away.
   */
  selectPatchFixtures?: readonly number[];
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
  /**
   * Splits the step's action into ordered parts with their own targets. The highlight starts on
   * the first part and moves on once that part's `until` holds; a finished part stays finished
   * until the step is entered again. `observe` still decides when the whole step is done.
   * Overrides `target`.
   */
  parts?: readonly GuideStepPart[];
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
/** Built-in library model the Patch lesson adds, available in every runtime. */
const PRACTICE_FIXTURE_MODEL = "12-segment RGBW Bar";
/** IDs the Patch lesson gives its practice fixtures, unused in the sample show. */
const PRACTICE_FIXTURES = [701, 702, 703, 704];
/** Height that moves the practice fixtures out of the sample riser to the top of the stage. */
const PRACTICE_FIXTURE_Y = 3;
/** The Patch panel's Fixtures view tab. */
const PATCH_FIXTURES_TAB =
  '[data-panel-kind="patch"] [role="tablist"][aria-label="Patch views"] [role="tab"][id$="-fixtures"]';
/** The Add fixture wizard's Next button, highlighted once a wizard step's choices are made. */
const PATCH_WIZARD_NEXT = '[data-guide-target="patch-wizard-next"]';
/** Pos X fan that spreads the practice fixtures evenly across the stage, typed as `-2>2`. */
const PRACTICE_FIXTURE_X_FAN = [-2, 2];
/** Mode the practice bars are patched in: one RGBW channel group per segment. */
const PRACTICE_FIXTURE_MODE = "Segments";
/** The practice bar's other mode, which drives the whole bar as one segment. */
const PRACTICE_FIXTURE_SINGLE_MODE = "Single";
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
  {
    id: "patch",
    label: "Module 3",
    title: "Patching fixtures",
    duration: "6–8 min",
    introduction:
      "Add four LED bars to the show with the Add fixture wizard, see where their DMX goes, and light them up.",
    steps: [
      {
        id: "open-patch",
        title: "Open Patch",
        target:
          '[data-dialog-kind="command-palette"] input, [aria-label="Open command palette"]',
        observe: { type: "panel", component: "PatchEditor" },
        content: [
          {
            type: "text",
            text: "Patching tells Nightfall which lights are in your rig and where to reach them. The Patch panel lists every fixture in the show.",
          },
          {
            type: "action",
            body: "Press {command-palette-shortcut}, search for 'Patch', and press Enter.",
          },
        ],
      },
      {
        id: "select-row",
        title: "Select a patched fixture",
        placement: "above",
        keepVisible: ["row", "visualizer"],
        targetPatchFixture: { id: 310 },
        observe: { type: "fixture-edit-selected", fixtureId: 310 },
        content: [
          {
            type: "text",
            text: "Each row is one fixture in the rig and also includes the fixture's position and orientation for the 3D visualizer.",
          },
          { type: "prerequisite", panels: ["PatchEditor", "Visualizer"] },
          {
            type: "action",
            body: "Click the row for fixture 310 to highlight it in the Visualizer.",
          },
          {
            type: "text",
            text: "Selecting rows in the patch doesn’t select them in the Programmer, so your commands won’t change it.",
          },
        ],
      },
      {
        id: "add-fixture",
        title: "Add fixtures",
        target: `${PATCH_FIXTURES_TAB}[aria-selected="false"], [data-panel-kind="patch"] [aria-label="Add fixture"]`,
        observe: { type: "patch-wizard", step: "fixture-selection" },
        content: [
          {
            type: "text",
            text: "The Add fixture wizard patches new lights: you pick a fixture, its DMX channel mapping (mode), and where to send its channel values (DMX address).",
          },
          { type: "prerequisite", panels: ["PatchEditor"] },
          {
            type: "action",
            body: "Click Add fixture (+) to add new lights.",
          },
        ],
      },
      {
        id: "pick-definition",
        title: "Pick a fixture definition",
        target: `[aria-label="Patch Wizard"] [data-grid-row-key^='["Generic","${PRACTICE_FIXTURE_MODEL}",'][data-grid-column-key="model"]`,
        parts: [
          {
            target: `[aria-label="Patch Wizard"] [data-grid-row-key^='["Generic","${PRACTICE_FIXTURE_MODEL}",'][data-grid-column-key="model"]`,
            until: {
              type: "patch-wizard",
              step: "fixture-selection",
              model: PRACTICE_FIXTURE_MODEL,
            },
          },
          { target: PATCH_WIZARD_NEXT },
        ],
        observe: {
          type: "patch-wizard",
          step: "mode-selection",
          model: PRACTICE_FIXTURE_MODEL,
        },
        content: [
          {
            type: "text",
            text: "A fixture definition describes a lighting fixture: its 3D parts, its attributes the console can set, and the DMX channels mapping for each of its modes.",
          },
          {
            type: "action",
            body: `Click Generic ${PRACTICE_FIXTURE_MODEL}, then click Next.`,
          },
        ],
      },
      {
        id: "pick-mode",
        title: "Pick a mode",
        parts: [
          {
            target: `[aria-label="Patch Wizard"] [data-mode="${PRACTICE_FIXTURE_MODE}"]`,
            until: {
              type: "patch-wizard",
              step: "mode-selection",
              mode: PRACTICE_FIXTURE_MODE,
            },
          },
          { target: PATCH_WIZARD_NEXT },
        ],
        observe: {
          type: "patch-wizard",
          step: "configure",
          mode: PRACTICE_FIXTURE_MODE,
        },
        content: [
          {
            type: "text",
            text: `A mode sets which DMX channels a fixture uses and in what order.`,
          },
          {
            type: "text",
            text: `This bar can run in two modes: ${PRACTICE_FIXTURE_MODE} controls each of its 12 RGBW segments individually using a 48 DMX channels, whereas ${PRACTICE_FIXTURE_SINGLE_MODE} uses only 4 DMX channels but is limited by having all 12 segments show the same color.`,
          },
          {
            type: "action",
            body: `Choose ${PRACTICE_FIXTURE_MODE}, so each segment can have its own color, and click Next.`,
          },
          {
            type: "text",
            text: `You will need to pick the mode the physical light is set to, or else the DMX channels sent by the console won't line up.`,
          },
        ],
      },
      {
        id: "configure",
        title: "Choose quantity and IDs",
        parts: [
          {
            target: '[aria-label="Patch Wizard"] input[id$="-quantity"]',
            until: {
              type: "patch-wizard",
              step: "configure",
              quantity: PRACTICE_FIXTURES.length,
            },
          },
          { target: '[aria-label="Patch Wizard"] input[id$="-first-id"]' },
        ],
        observe: {
          type: "patch-wizard",
          step: "configure",
          quantity: PRACTICE_FIXTURES.length,
          firstFixtureId: PRACTICE_FIXTURES[0],
        },
        content: [
          {
            type: "text",
            text: "Fixture IDs are the numbers you type to select lights. They don’t depend on where a fixture’s DMX goes, so pick numbers that are easy to remember.",
          },
          {
            type: "action",
            title: "Add four bars as 701–704",
            body: "Set Quantity to 4 and First fixture ID to 701.",
          },
        ],
      },
      {
        id: "address",
        title: "Choose their DMX address",
        target: '[aria-label="Patch Wizard"] input[aria-label="Universe"]',
        parts: [
          {
            target: '[aria-label="Patch Wizard"] input[aria-label="Universe"]',
            until: { type: "patch-wizard", step: "configure", universeId: 21 },
          },
          {
            target:
              '[aria-label="Patch Wizard"] input[aria-label="Start address"]',
            until: {
              type: "patch-wizard",
              step: "configure",
              universeId: 21,
              startAddress: 1,
            },
          },
          { target: PATCH_WIZARD_NEXT },
        ],
        observe: {
          type: "patch-wizard",
          step: "review",
          quantity: PRACTICE_FIXTURES.length,
          firstFixtureId: PRACTICE_FIXTURES[0],
          universeId: 21,
          startAddress: 1,
        },
        content: [
          {
            type: "text",
            text: "Choose the DMX address of the first bar. The DMX addresses the subsequent bars are configured sequentially.",
          },
          {
            type: "action",
            title: "Patch them to 21.1",
            body: "Give the RGB bars a universe of their own: set the universe to 21 and address to 1, then click Next.",
          },
          {
            type: "details",
            title: "Learn more",
            text: "A DMX universe holds 512 channels, which are sent down a DMX cable to control your physical lights. You can create as many universes as you need for your lights.",
            guidePage: "user-guide/dmx-patching.html",
          },
        ],
      },
      {
        id: "finish",
        title: "Add them to the show",
        placement: "side",
        target: '[data-guide-target="patch-wizard-finish"]',
        observe: {
          type: "fixtures-patched",
          fixtureIds: PRACTICE_FIXTURES,
          model: PRACTICE_FIXTURE_MODEL,
        },
        content: [
          {
            type: "text",
            text: "Review summarizes the definition, the fixture IDs, and the console DMX range the bars will use.",
          },
          {
            type: "action",
            body: "Check the summary, then click Finish.",
          },
        ],
      },
      {
        id: "place",
        title: "Place them on stage",
        placement: "above",
        keepVisible: ["visualizer"],
        target:
          '[data-panel-kind="patch"] [data-grid-header-id="tanstack-header-pos_x"]',
        parts: [
          {
            target:
              '[data-panel-kind="patch"] [data-grid-header-id="tanstack-header-pos_x"]',
            until: {
              type: "fixtures-placed",
              fixtureIds: PRACTICE_FIXTURES,
              x: PRACTICE_FIXTURE_X_FAN,
            },
          },
          {
            target:
              '[data-panel-kind="patch"] [data-grid-header-id="tanstack-header-pos_y"]',
          },
        ],
        observe: {
          type: "fixtures-placed",
          fixtureIds: PRACTICE_FIXTURES,
          x: PRACTICE_FIXTURE_X_FAN,
          y: PRACTICE_FIXTURE_Y,
        },
        content: [
          {
            type: "text",
            text: "New fixtures start at the center of the stage, stacked diagonally.",
          },
          { type: "prerequisite", panels: ["PatchEditor", "Visualizer"] },
          {
            type: "action",
            title: `Set 3D coordinates for fixtures 701 - 704`,
            body: `Select the Pos X cells for 701-704 and type -2>2 to distribute them. Set Pos Y to ${PRACTICE_FIXTURE_Y} on each of them to raise them above the front of the stage.`,
          },
        ],
      },
      {
        id: "dmx-routes",
        title: "Switch to the DMX Routes view",
        target:
          '[data-panel-kind="patch"] [role="tablist"][aria-label="Patch views"] [role="tab"][id$="-routes"]',
        observe: { type: "patch-view", view: "routes" },
        content: [
          {
            type: "text",
            text: "Routes send fixture output to hardware. The wizard gave each new bar a route to console universe 21, at addresses 1, 49, 97, and 145.",
          },
          { type: "prerequisite", panels: ["PatchEditor"] },
          {
            type: "action",
            body: "Switch to the DMX Routes view. The routes for fixtures 701–704 are at the end of the list, with targets Console 21.1, 21.49, 21.97, and 21.145.",
          },
        ],
      },
      {
        id: "try-fixtures",
        title: "Light up your new bars",
        keepVisible: ["visualizer"],
        target: "#header-cmdline",
        focusTarget: true,
        observe: { type: "intensity", fixtureIds: PRACTICE_FIXTURES },
        content: [
          {
            type: "text",
            text: "New fixtures work like any other light as soon as they’re patched.",
          },
          { type: "prerequisite", panels: ["Visualizer"] },
          {
            type: "action",
            title: "Type this command, then press Enter:",
            body: "Watch the four bars light up white in the Visualizer.",
            command: "fix 701>704 @ 100 white @ 100",
          },
        ],
      },
      {
        id: "clear",
        title: "Clear the Programmer",
        target: '[aria-label="Clear programmer"]',
        observe: { type: "clear" },
        content: [
          {
            type: "text",
            text: "Clear the live values you just set, so the bars go dark again.",
          },
          {
            type: "action",
            title: "Click Clear twice",
            body: "The first click clears the selection; the second releases the Programmer’s values. You can also press {clear-shortcut} twice.",
          },
        ],
      },
      {
        id: "remove-fixtures",
        title: "Remove the practice bars (optional)",
        keepVisible: ["panel"],
        parts: [
          {
            target: PATCH_FIXTURES_TAB,
            until: { type: "patch-view", view: "fixtures" },
          },
          {
            target:
              '[data-panel-kind="patch"] [aria-label="Delete selected fixtures"]',
          },
        ],
        selectPatchFixtures: PRACTICE_FIXTURES,
        observe: { type: "fixtures-removed", fixtureIds: PRACTICE_FIXTURES },
        content: [
          {
            type: "text",
            text: "Keep the bars if you want to practice with them, or remove them from the show now.",
          },
          { type: "prerequisite", panels: ["PatchEditor"] },
          {
            type: "action",
            body: "Switch to the Fixtures view, where the four bars are selected, then click Delete selected fixtures. Undo brings them back. To keep them, skip this step.",
          },
        ],
      },
    ],
  },
];
