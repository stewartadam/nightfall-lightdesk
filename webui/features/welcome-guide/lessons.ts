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
    }
  | { type: "details"; title: string; text: string }
  | { type: "stop-playback" };

export type GuidePrerequisite = Extract<GuideContent, { type: "prerequisite" }>;

/**
 * An area the card must leave uncovered in addition to the target: the target's whole panel
 * including its tab, just the panel's tab, its grid row, or the 3D Visualizer viewport.
 */
export type GuideFocusArea = "panel" | "tab" | "row" | "visualizer";

export interface GuideStep {
  persistenceUnavailable?: Pick<
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
  /** Targets a fixture's ID cell in Patch, or the Fixtures view tab while DMX I/O is showing. */
  targetPatchFixture?: { id: number };
  /** Targets a regular FX card or list row in FX List by its user-facing ID. */
  targetFx?: { id: number };
  /** Targets the sample timeline's card in the Timelines list. */
  targetSampleTimeline?: boolean;
  placement?: "above";
  /**
   * Areas the user needs to see during this step. When set, the card may cover the rest of the
   * target's panel; without it, the card only prefers to avoid that panel.
   */
  keepVisible?: GuideFocusArea[];
  focusTarget?: boolean;
  /**
   * Runs the step in the layout the user had before the lesson. Saving the show records which
   * layout is showing, so a save from the Lesson layout would reopen the show in it.
   */
  userLayout?: boolean;
  observe?: GuideObservation;
}
export interface GuideLesson {
  id: string;
  /** Library eyebrow placing the lesson in the learning path; defaults to a follow-on lesson. */
  label?: string;
  title: string;
  duration: string;
  introduction: string;
  steps: GuideStep[];
}
export const GUIDE_LESSONS: GuideLesson[] = [
  {
    id: "basics",
    label: "Module 1 · Orientation",
    title: "Welcome to Nightfall",
    duration: "6–8 min",
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
            text: "Lo-fi starts the RGB cycle (full) clip and the red waveform effect fx3.",
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
        target: '[aria-label="Play timeline"]',
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
            text: "RGB cycle (full) advances through colors; fx3 varies the red channel across the pixel strips.",
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
        persistenceUnavailable: {
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
        userLayout: true,
        title: "Keep a saved version of your show",
        target:
          '[data-component="DropdownMenuItem"]:has([data-guide-target="save-showfile"]), [aria-label="Menu"]:not([aria-expanded="true"])',
        content: [
          {
            type: "text",
            text: "Nightfall automatically saves your showfile changes to a draft. Save Showfile explicitly updates the saved version of the whole show. A draft lets you recover work made since that saved version.",
          },
          {
            type: "text",
            text: "A save also remembers which layout is showing, so the guide has switched back to your own layout for the rest of this lesson.",
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
          fixtureIds: [310, 311, 312, 313],
        },
        content: [
          {
            type: "text",
            text: "The demo pixel strips include fixtures 310–313. The > operator selects an inclusive range.",
          },
          {
            type: "prerequisite",
            panels: ["ProgrammerGrid", "Visualizer"],
          },
          {
            type: "action",
            title: "Type this command, then press Enter:",
            body: "Look for the four selected pixel strips in the Programmer.",
            command: "fix 310>313",
          },
        ],
      },
      {
        id: "intensity",
        title: "Bring up the lights",
        target: "#header-cmdline",
        observe: {
          type: "intensity",
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
        keepVisible: ["row"],
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
        target: '[aria-label="Add clip"]',
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
        target: '[data-control-go-index="6"]:not(:disabled)',
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
        target: '[data-control-go-index="6"]:not(:disabled)',
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
    title: "Patching fixtures",
    duration: "4 min",
    introduction:
      "Find a fixture in Patch, select it by ID, and see how the sample rig runs without DMX.",
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
            text: "Patch lists every fixture in the show with its ID, make, model, mode, and position.",
          },
          {
            type: "action",
            body: "Press {command-palette-shortcut}, search for 'Patch', and press Enter.",
          },
        ],
      },
      {
        id: "find-fixture",
        title: "Find pixel strip 310",
        targetPatchFixture: { id: 310 },
        observe: { type: "fixture-edit-selected", fixtureId: 310 },
        content: [
          {
            type: "text",
            text: "Each row is one fixture. Fixture 310 is a Generic RGBPixelTape 120ch in RGB mode: 40 pixels of red, green, and blue, using 120 DMX channels.",
          },
          { type: "prerequisite", panels: ["PatchEditor", "Visualizer"] },
          {
            type: "action",
            body: "In the Fixtures view, click fixture 310’s ID. The Visualizer highlights the strip you picked.",
          },
          {
            type: "details",
            title: "Learn more",
            text: "All 32 pixel strips (310–383) use this model and mode. Scroll down to find the moving heads (501–506), strobes (601–606), strobe bars, and wash beams.",
          },
        ],
      },
      {
        id: "select-fixture",
        title: "Select it by ID",
        target: "#header-cmdline",
        focusTarget: true,
        observe: { type: "selection", fixtureIds: [310] },
        content: [
          {
            type: "text",
            text: "The fixture ID is the number you type to select a light. It is not a DMX address.",
          },
          {
            type: "action",
            title: "Type this command, then press Enter:",
            body: "This selects pixel strip 310 so you can program it.",
            command: "fix 310",
          },
        ],
      },
      {
        id: "dmx-io",
        title: "Open the DMX I/O view",
        target:
          '[data-panel-kind="patch"] [role="tablist"][aria-label="Patch views"] [role="tab"][id$="-bindings"]',
        observe: { type: "patch-view", view: "bindings" },
        content: [
          {
            type: "text",
            text: "Bindings connect fixtures to DMX addresses. The DMX I/O view lists them.",
          },
          { type: "prerequisite", panels: ["PatchEditor"] },
          { type: "action", body: "Click DMX I/O at the top of Patch." },
        ],
      },
      {
        id: "disabled-bindings",
        title: "The sample needs no DMX",
        target:
          '[data-panel-kind="patch"] [data-grid-column-key="target"][data-grid-row-key^="disabled-"]',
        content: [
          {
            type: "text",
            text: "Every sample fixture has a Disabled output binding, so none has a DMX address. The Visualizer shows fixture values directly, so the sample works without DMX.",
          },
          { type: "prerequisite", panels: ["PatchEditor"] },
          {
            type: "action",
            body: "Look at the Target column: every row says Disabled.",
          },
          {
            type: "details",
            title: "Learn more",
            text: "On a real rig, Add fixture in Patch walks through a fixture definition, mode, quantity, and starting universe and address. A universe holds 512 channels. Importing fixture definitions from the fixture library requires the installed app.",
          },
        ],
      },
      {
        id: "deselect",
        title: "Clear your selection",
        target: "#header-cmdline",
        focusTarget: true,
        observe: { type: "selection", fixtureIds: [] },
        content: [
          {
            type: "action",
            title: "Type this command, then press Enter:",
            body: "This deselects fixture 310.",
            command: "clear",
          },
        ],
      },
    ],
  },
  {
    id: "transports",
    title: "Transports and output",
    duration: "3 min",
    introduction:
      "See where Nightfall can send DMX and why the sample rig doesn’t send any.",
    steps: [
      {
        id: "open-transports",
        title: "Open I/O Transports",
        target:
          '[data-dialog-kind="command-palette"] input, [aria-label="Open command palette"]',
        observe: { type: "panel", component: "IoTransports" },
        content: [
          {
            type: "text",
            text: "A transport carries DMX to real lights over the network or through a USB interface.",
          },
          {
            type: "action",
            body: "Press {command-palette-shortcut}, search for 'I/O Transports', and press Enter.",
          },
        ],
      },
      {
        id: "network-targets",
        title: "Network targets",
        target:
          '[data-component="IoTransportsPanel"] [data-slot="target-row"][data-target-id="sacn"]',
        content: [
          {
            type: "text",
            text: "Nightfall includes two network targets: sacn sends sACN by multicast, and artnet sends Art-Net by broadcast. Add a Unicast target to send to one device’s IP address.",
          },
          { type: "prerequisite", panels: ["IoTransports"] },
          {
            type: "action",
            body: "Find the sacn and artnet rows. Leave their settings unchanged.",
          },
          {
            type: "text",
            text: "If the Network output switch is dimmed and each Status shows Disabled, this runtime can’t send DMX. The browser demo drives only the Visualizer.",
          },
        ],
      },
      {
        id: "usb-target",
        title: "USB target",
        target:
          '[data-component="IoTransportsPanel"] [data-slot="usb-target-row"][data-target-id="udmx"]',
        content: [
          {
            type: "text",
            text: "udmx sends DMX through a USB interface. Its device is Auto, so it uses the first compatible uDMX interface it finds.",
          },
          { type: "prerequisite", panels: ["IoTransports"] },
          {
            type: "action",
            body: "Find the udmx row in the USB section.",
          },
        ],
      },
      {
        id: "open-console-dmx",
        title: "Open Console DMX",
        target:
          '[data-dialog-kind="command-palette"] input, [aria-label="Open command palette"]',
        observe: { type: "panel", component: "DmxUniverse" },
        content: [
          {
            type: "text",
            text: "Console DMX shows the universes Nightfall builds from patched fixtures, before a transport sends them.",
          },
          {
            type: "action",
            body: "Press {command-palette-shortcut}, search for 'Console DMX', and press Enter.",
          },
        ],
      },
      {
        id: "no-universes",
        title: "Nothing to send yet",
        target: '[data-component="DmxUniverse"][data-panel-id]',
        content: [
          {
            type: "text",
            text: "The sample fixtures’ output bindings are disabled, so they write to no universe and no transport has anything to send.",
          },
          { type: "prerequisite", panels: ["DmxUniverse"] },
          {
            type: "action",
            body: "Notice that Console DMX has no universe data.",
          },
          {
            type: "details",
            title: "Learn more",
            text: "On a real rig, patch fixtures to console universes, then send those universes to a transport, for example with the command patch console @ sacn. Your receiver must use the same protocol and universe.",
          },
        ],
      },
    ],
  },
  {
    id: "waveform",
    title: "Waveform effects",
    duration: "6 min",
    introduction:
      "Reshape fx3, the sample’s red sine wave, then play your version from its clip.",
    steps: [
      {
        id: "quiet",
        title: "Start from a quiet stage",
        observe: { type: "playback-idle" },
        content: [
          {
            type: "text",
            text: "fx3 changes only the red channel. Other running clips or timelines would mix their own colors into what you see.",
          },
          {
            type: "action",
            body: "Stop all playback. This step completes on its own if nothing is running.",
          },
          { type: "stop-playback" },
        ],
      },
      {
        id: "open-fx",
        title: "Open fx3",
        targetFx: { id: 3 },
        observe: { type: "panel", component: "FxEditor" },
        content: [
          {
            type: "text",
            text: "fx3 is a waveform effect: a repeating sine wave on the red channel of all 32 pixel strips. Each strip starts at a different point in the cycle, so the red appears to travel.",
          },
          { type: "prerequisite", panels: ["FxList", "Visualizer"] },
          {
            type: "action",
            body: "In FX List, click 3: fx3 to open it in the FX Editor. In list view, select the row and press Enter.",
          },
        ],
      },
      {
        id: "rate",
        title: "Slow the wave down",
        target: '[data-component="FxEditor"] input[aria-label="Rate"]',
        focusTarget: true,
        content: [
          {
            type: "text",
            text: "The FX Editor previews fx3 on the rig while it is open and updates as you edit. Rate is the length of one cycle; fx3 repeats every 4 seconds.",
          },
          { type: "prerequisite", panels: ["Visualizer"] },
          {
            type: "action",
            body: "Set Rate to 8 and watch the red wave slow to half speed.",
          },
        ],
      },
      {
        id: "shape",
        title: "Change the wave’s shape",
        target:
          '[data-component="FxEditor"] .waveform-editor button[title="Square"]',
        content: [
          {
            type: "text",
            text: "The shape sets how the value moves through each cycle. Sine glides between off and full red; Square jumps between them.",
          },
          {
            type: "action",
            body: "Choose Square and watch the strips snap between full red and off.",
          },
        ],
      },
      {
        id: "save",
        title: "Save your version of fx3",
        target: '[data-guide-target="fx-save"]',
        observe: { type: "fx-saved", fxId: 3 },
        content: [
          {
            type: "text",
            text: "Edits in the FX Editor are a preview until you save. Saving stores the new rate and shape in fx3, so clip 6 and the Lo-fi timeline use them the next time they start.",
          },
          { type: "action", body: "Click Save in the FX Editor toolbar." },
        ],
      },
      {
        id: "close-editor",
        title: "Close the FX Editor",
        target:
          '.dv-default-tab[aria-label^="FX 3: fx3"] .dv-default-tab-action',
        observe: { type: "panel-closed", component: "FxEditor" },
        content: [
          {
            type: "text",
            text: "The preview runs only while the FX Editor is open. Close it to hand the strips back to playback.",
          },
          { type: "action", body: "Click × on the FX 3: fx3 tab." },
        ],
      },
      {
        id: "play-clip",
        title: "Play your saved fx3",
        targetClip: { id: 6 },
        observe: { type: "clip-playing", clipId: 6 },
        content: [
          {
            type: "text",
            text: "Clip 6: fx3 plays the saved effect. The Lo-fi timeline launches this same clip.",
          },
          { type: "prerequisite", panels: ["ClipList", "Visualizer"] },
          {
            type: "action",
            body: "Click clip 6: fx3 and watch your slower, square red wave in the Visualizer.",
          },
        ],
      },
      {
        id: "stop-clip",
        title: "Stop fx3",
        targetClip: { id: 6 },
        observe: { type: "clip-stopped", clipId: 6 },
        content: [
          { type: "text", text: "Clicking a running clip again stops it." },
          { type: "action", body: "Click fx3 again to stop it." },
        ],
      },
    ],
  },
  {
    id: "step-fx",
    title: "Step FX designer",
    duration: "7 min",
    introduction:
      "Turn a new Step FX into an intensity chase across four pixel strips.",
    steps: [
      {
        id: "base",
        title: "Give the strips a red base",
        target: "#header-cmdline",
        focusTarget: true,
        observe: { type: "color", color: "Red" },
        content: [
          {
            type: "text",
            text: "An intensity chase only dims and brightens. The sample strips start with no color, so hold red on fixtures 310–313 in the Programmer first.",
          },
          { type: "prerequisite", panels: ["Visualizer"] },
          {
            type: "action",
            title: "Type this command, then press Enter:",
            body: "Watch the four strips turn red.",
            command: "fix 310>313 red @ 100 green @ 0 blue @ 0",
          },
        ],
      },
      {
        id: "create",
        title: "Create a Step FX",
        target:
          '[data-component="DropdownMenuItem"]:has([data-guide-target="add-step-fx"]), [aria-label="Add effect"]:not([aria-expanded="true"])',
        observe: { type: "panel", component: "StepFxEditor" },
        content: [
          {
            type: "text",
            text: "Step FX describes a repeating pattern as explicit values and durations. A new one starts as a two-step Intensity chase: 100%, then 0%, one beat each.",
          },
          { type: "prerequisite", panels: ["FxList"] },
          {
            type: "action",
            body: "In FX List, open Add effect and choose Step FX.",
          },
        ],
      },
      {
        id: "selection",
        title: "Point the chase at the strips",
        target:
          '[data-component="PropertiesInspector"] textarea[aria-label="Selection"]',
        observe: { type: "step-fx", selection: [310, 313] },
        content: [
          {
            type: "text",
            text: "The editor previews the chase live, but a new Step FX targets fixture 1. Its Selection decides which lights take part.",
          },
          {
            type: "prerequisite",
            panels: ["PropertiesInspector", "Visualizer"],
          },
          {
            type: "action",
            title:
              "In Properties, replace Selection with this text, then click Apply:",
            body: "The red strips start chasing on and off.",
            command: "Fixture 310>313",
          },
          {
            type: "text",
            text: "If Properties is empty, click the Step FX editor’s tab so Properties shows its settings.",
          },
        ],
      },
      {
        id: "together",
        title: "Flash the strips together",
        target:
          '[aria-label="Start position"]:not([aria-expanded="true"]), [role="radiogroup"][aria-label="Start position mode"]',
        observe: { type: "step-fx", phase: "together" },
        content: [
          {
            type: "text",
            text: "Start position sets where each strip begins in the cycle. The new chase uses Spread, which staggers the strips.",
          },
          {
            type: "action",
            body: "Open Start position and choose Together. All four strips now flash in unison.",
          },
        ],
      },
      {
        id: "spread",
        title: "Spread the chase again",
        target:
          '[aria-label="Start position"]:not([aria-expanded="true"]), [role="radiogroup"][aria-label="Start position mode"]',
        observe: { type: "step-fx", phase: "spread" },
        content: [
          {
            type: "text",
            text: "Spread staggers the strips across one cycle, so the lit step travels along them.",
          },
          {
            type: "action",
            body: "In Start position, choose Spread and watch the chase move across the strips.",
          },
        ],
      },
      {
        id: "speed",
        title: "Slow the chase",
        target:
          '[aria-label="Speed and scaling"]:not([aria-expanded="true"]), [aria-label="Step FX speed"]',
        observe: { type: "step-fx", beatSeconds: 1 },
        content: [
          {
            type: "text",
            text: "Speed sets the length of one beat, and each step here is one beat wide. The new chase runs at 120 BPM.",
          },
          {
            type: "action",
            body: "Open Speed and scaling, set Speed to 60, then press Enter. The chase slows to half speed.",
          },
        ],
      },
      {
        id: "stop-preview",
        title: "Stop the preview",
        target: '[aria-label="Stop preview"]',
        observe: { type: "step-fx-preview-stopped" },
        content: [
          {
            type: "text",
            text: "Step FX saves your edits automatically. The preview runs only while you test in the editor; to use the chase in a show, give it a clip.",
          },
          {
            type: "action",
            body: "Click Stop preview in the Step FX editor toolbar.",
          },
          {
            type: "details",
            title: "Learn more",
            text: "Rename the effect in Properties so it’s easy to find in FX List later.",
          },
        ],
      },
      {
        id: "clear",
        title: "Release the red base",
        target: '[aria-label="Clear programmer"]',
        observe: { type: "clear" },
        content: [
          {
            type: "text",
            text: "The red base is still held in the Programmer. Clear it so it doesn’t affect other lessons.",
          },
          {
            type: "action",
            title: "Click Clear twice",
            body: "The first click clears the selection; the second releases the Programmer’s values. You can also press {clear-shortcut} twice.",
          },
        ],
      },
    ],
  },
  {
    id: "timeline",
    title: "Timeline programming",
    duration: "5 min",
    introduction:
      "Move when Lo-fi starts the fx3 red wave, then rehearse the change.",
    steps: [
      {
        id: "open",
        title: "Open Lo-fi",
        observe: { type: "sample-panels" },
        content: [
          {
            type: "text",
            text: "Lo-fi has two tracks. Seq Track starts RGB cycle (full), advances it through its cues, and stops it at 3.6 seconds. FX Track starts the fx3 red wave at the same moment.",
          },
          {
            type: "prerequisite",
            panels: ["Visualizer"],
            sampleTimeline: true,
          },
          {
            type: "action",
            body: "Open Timeline 1: Lo-fi beside the 3D Visualizer.",
          },
        ],
      },
      {
        id: "select",
        title: "Select the fx3 action",
        targetTimelineAction: { trackId: "1", actionId: "1" },
        observe: {
          type: "timeline-action-selected",
          trackId: "1",
          actionId: "1",
        },
        content: [
          {
            type: "text",
            text: "Each chip on a track is an action. Exec 6: fx3 on FX Track starts clip 6, which plays the red waveform effect.",
          },
          {
            type: "prerequisite",
            panels: ["PropertiesInspector"],
            sampleTimeline: true,
          },
          {
            type: "action",
            body: "Click the Exec 6: fx3 chip on FX Track to select it.",
          },
        ],
      },
      {
        id: "timing",
        title: "Start the wave earlier",
        target: '[aria-label="Action position (ms)"]',
        focusTarget: true,
        observe: {
          type: "timeline-action-position",
          trackId: "1",
          actionId: "1",
          positionMs: 3000,
          toleranceMs: 50,
        },
        content: [
          {
            type: "text",
            text: "Properties shows the selected action. Its position, 3600 ms, sets when it fires.",
          },
          {
            type: "prerequisite",
            panels: ["PropertiesInspector"],
            sampleTimeline: true,
          },
          {
            type: "action",
            title: "Set Position (ms) to 3000",
            body: "Type 3000 in Position (ms), then press Enter.",
          },
          {
            type: "details",
            title: "Drag instead",
            text: "You can also drag the chip left along FX Track. At the default zoom, each pixel is 10 ms.",
          },
        ],
      },
      {
        id: "play",
        title: "Rehearse the change",
        target: '[aria-label="Play timeline"]',
        observe: { type: "timeline-playing" },
        content: [
          {
            type: "text",
            text: "fx3 now starts 0.6 seconds earlier, while the color cycle is still on its last cue.",
          },
          {
            type: "prerequisite",
            panels: ["Visualizer"],
            sampleTimeline: true,
          },
          {
            type: "action",
            body: "Press Play timeline and watch the red wave reach the pixel strips at 3 seconds.",
          },
        ],
      },
      {
        id: "stop",
        title: "Stop the rehearsal",
        placement: "above",
        target: '[aria-label="Stop timeline"]',
        observe: { type: "timeline-stopped" },
        content: [
          {
            type: "text",
            text: "Stopping Lo-fi returns it to the start and releases the clips it started.",
          },
          { type: "action", body: "Press Stop timeline." },
        ],
      },
    ],
  },
];
