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
  | { type: "details"; title: string; text: string };

export type GuidePrerequisite = Extract<GuideContent, { type: "prerequisite" }>;

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
  placement?: "above";
  focusTarget?: boolean;
  observe?: GuideObservation;
}
export interface GuideLesson {
  id: string;
  title: string;
  duration: string;
  introduction: string;
  steps: GuideStep[];
}
export const GUIDE_LESSONS: GuideLesson[] = [
  {
    id: "basics",
    title: "Welcome to Nightfall",
    duration: "6–8 min",
    introduction:
      "Explore playback and properties, find your way around, and personalize Nightfall.",
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
            body: "Open Timeline 1: Lo-Fi and keep the 3D Visualizer open beside it.",
          },
        ],
      },
      {
        id: "play-timeline",
        title: "Start the sample show",
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
          {
            type: "action",
            title: "Command alternative",
            body: "You can also stop the clip from the command input.",
            command: "clip 1 stop",
          },
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
        content: [
          {
            type: "text",
            text: "The command input lets you select fixtures, set values, and control playback by typing. It is separate from the Command Palette, which finds panels and app actions.",
          },
          {
            type: "action",
            body: "Find the command input at the top left. You’ll use it in Your first lights; leave it empty for now and continue.",
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
          {
            type: "action",
            body: "Find the layout switcher in the top toolbar. Keep the current layout for this introduction, then continue.",
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
            text: "The Command Palette searches for panels and app actions. You can open it from any workspace.",
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
            body: "Search for Open Settings in the Command Palette, then press Enter.",
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
            body: "Select Appearance in Settings, then choose an accent swatch. Try a few colors and keep your favorite. Close Settings when you’re happy to move on.",
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
            title: "Click twice to clear the programmer",
            body: "The first clears the active selection, the second releases programmer values.",
          },
          {
            type: "details",
            title: "Learn more",
            text: "Setting intensity to zero leaves a live instruction. Clearing allows stored cues to control the lights.",
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
        title: "Create your playback clip",
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
    introduction: "Explore how the sample fixtures describe the demo rig.",
    steps: [
      {
        id: "open",
        title: "Open the sample patch",
        observe: {
          type: "panel",
          component: "PatchEditor",
        },
        content: [
          {
            type: "text",
            text: "All four pixel strips use the same model and mode.",
          },
          {
            type: "prerequisite",
            panels: ["PatchEditor"],
          },
          {
            type: "action",
            body: "Open Patch and find pixel strip 310, model RGBPixelTape 120ch RGB.",
          },
        ],
      },
      {
        id: "inspect",
        title: "Inspect pixel strip 310",
        content: [
          {
            type: "text",
            text: "RGB mode supplies 40 RGB pixels, with virtual intensity for dimming.",
          },
          {
            type: "prerequisite",
            panels: ["PatchEditor"],
          },
          {
            type: "action",
            body: "Inspect pixel strip 310’s manufacturer, model, and mode. Compare it with pixel strip 311.",
          },
        ],
      },
      {
        id: "address",
        title: "Understand the disabled patch",
        content: [
          {
            type: "text",
            text: "The sample has disabled output bindings. The fixtures still run in the Visualizer; physical output needs enabled bindings and transport routing. Fixture ID 310 is a selection number, not a DMX address.",
          },
          {
            type: "prerequisite",
            panels: ["PatchEditor"],
          },
          {
            type: "action",
            body: "Switch Patch to DMX I/O and inspect the disabled bindings.",
          },
          {
            type: "details",
            title: "Learn more",
            text: "A universe contains 512 channels. In the real app, Add fixture walks through a library definition, mode, quantity, and console DMX address. This virtual sample does not need that setup.",
          },
        ],
      },
      {
        id: "verify",
        title: "Select the patched fixture",
        target: "#header-cmdline",
        content: [
          {
            type: "text",
            text: "Selection uses the fixture ID regardless of whether a hardware route exists.",
          },
          {
            type: "prerequisite",
            panels: ["ProgrammerGrid", "Visualizer"],
          },
          {
            type: "action",
            title: "Select pixel strip 310:",
            body: "Enter fix 310, then inspect pixel strip 310 in Programmer and the Visualizer.",
            command: "fix 310",
          },
        ],
      },
    ],
  },
  {
    id: "transports",
    title: "Transports and output",
    duration: "4 min",
    introduction:
      "Inspect the sample’s output targets and understand physical routing.",
    steps: [
      {
        id: "routing",
        title: "Open I/O Transports",
        observe: {
          type: "panel",
          component: "IoTransports",
        },
        content: [
          {
            type: "text",
            text: "A binding maps attributes to channels; a transport carries those channels to hardware. The sample’s fixture output bindings are disabled.",
          },
          {
            type: "prerequisite",
            panels: ["IoTransports"],
          },
          {
            type: "action",
            body: "Open I/O Transports and locate the network and USB output sections.",
          },
        ],
      },
      {
        id: "configure",
        title: "Inspect the sample targets",
        content: [
          {
            type: "text",
            text: "sacn uses sACN multicast, artnet uses Art-Net broadcast, and udmx names the default USB device.",
          },
          {
            type: "prerequisite",
            panels: ["IoTransports"],
          },
          {
            type: "action",
            body: "Inspect those three targets. Leave their settings unchanged for this walkthrough.",
          },
          {
            type: "details",
            title: "Learn more",
            text: "On a physical rig, configure your interface and map console universes to targets. The receiver must use the same universe and protocol.",
          },
        ],
      },
      {
        id: "test",
        title: "Separate output from visualization",
        content: [
          {
            type: "text",
            text: "The Visualizer does not require a transport. The browser demo cannot send network or USB DMX, so there is no hardware route to test.",
          },
          {
            type: "prerequisite",
            panels: ["DmxUniverse", "PatchEditor"],
          },
          {
            type: "action",
            body: "Compare Console DMX with the disabled sample patch. Return to the creative lessons to work with the virtual fixtures.",
          },
        ],
      },
    ],
  },
  {
    id: "waveform",
    title: "Waveform effects",
    duration: "5 min",
    introduction: "Play and reshape fx3, the sample’s red-channel effect.",
    steps: [
      {
        id: "play",
        title: "Start fx3",
        target: "#header-cmdline",
        observe: {
          type: "clip-playing",
          clipId: 6,
        },
        content: [
          {
            type: "text",
            text: "Clip 6 already plays the red-channel wave across all pixel strips.",
          },
          {
            type: "prerequisite",
            panels: ["Visualizer"],
          },
          {
            type: "action",
            title: "Type this command, then press Enter:",
            body: "Stop Lo-fi and any running clips, clear the Programmer, then enter clip 6 start and watch the Visualizer.",
            command: "clip 6 start",
          },
        ],
      },
      {
        id: "open",
        title: "Open fx3",
        target: '[aria-label="Edit selected effect"]:not(:disabled)',
        observe: {
          type: "panel",
          component: "FxEditor",
        },
        content: [
          {
            type: "text",
            text: "This effect repeats a sine wave with different phases across the pixel strips.",
          },
          {
            type: "prerequisite",
            panels: ["FxList"],
          },
          {
            type: "action",
            title: "Edit fx3.",
            body: "In FX List, select 3: fx3 and choose Edit selected effect.",
          },
        ],
      },
      {
        id: "shape",
        title: "Explore the red wave",
        content: [
          {
            type: "text",
            text: "fx3 uses Red, a four-second cycle, and a full cycle of phase spread.",
          },
          {
            type: "prerequisite",
            panels: ["Visualizer"],
          },
          {
            type: "action",
            body: "Change its cycle rate and phase range, save, and compare how the pixel strips move through the pattern.",
          },
          {
            type: "details",
            title: "Learn more",
            text: "Try a slower cycle, then reduce the phase range to bring the lights closer together in the pattern.",
          },
        ],
      },
      {
        id: "stop",
        title: "Stop fx3",
        target: "#header-cmdline",
        observe: {
          type: "clip-stopped",
          clipId: 6,
        },
        content: [
          {
            type: "text",
            text: "Release the effect before trying another lesson.",
          },
          {
            type: "action",
            title: "Type this command, then press Enter:",
            body: "Enter clip 6 stop. If you also started an editor preview, stop that preview too.",
            command: "clip 6 stop",
          },
        ],
      },
    ],
  },
  {
    id: "step-fx",
    title: "Step FX designer",
    duration: "7 min",
    introduction: "Build a two-step intensity chase for the four pixel strips.",
    steps: [
      {
        id: "create",
        title: "Open the Step FX designer",
        target: '[aria-label="Add effect"]',
        observe: {
          type: "panel",
          component: "StepFxEditor",
        },
        content: [
          {
            type: "text",
            text: "Step FX describes a repeating pattern as explicit values and durations.",
          },
          {
            type: "prerequisite",
            panels: ["FxList"],
          },
          {
            type: "action",
            title: "Choose Step FX.",
            body: "Stop Lo-fi and any running clips, then clear the Programmer. Enter fix 310>313 red @ 100 green @ 0 blue @ 0 to give the chase a red base. In FX List, choose Add effect → Step FX.",
          },
        ],
      },
      {
        id: "selection",
        title: "Use the four pixel strips",
        target: '[aria-label="Step FX attributes"]',
        content: [
          {
            type: "text",
            text: "The selection tells the chase which lights participate.",
          },
          {
            type: "action",
            title: "Choose Intensity for the pixel strips.",
            body: "Label the effect Demo Chase. Set Selection to fix 310>313 and choose the Intensity lane.",
          },
        ],
      },
      {
        id: "steps",
        title: "Make an on/off pattern",
        target: '[aria-label="Add step"]',
        content: [
          {
            type: "text",
            text: "An absolute intensity track supplies brightness values directly.",
          },
          {
            type: "action",
            title: "Add the off step after the on step.",
            body: "Use the absolute track. Set the first step to full intensity and add a second step at zero. Give both equal widths.",
          },
          {
            type: "details",
            title: "Learn more",
            text: "Equal widths give on and off equal time. Relative contributions modify another value; absolute intensity is easier to see for this chase.",
          },
        ],
      },
      {
        id: "spread",
        title: "Spread across the pixel strips",
        target: '[aria-label="Preview"], [aria-label="Stop preview"]',
        content: [
          {
            type: "text",
            text: "Different start positions make the lights alternate instead of flashing together.",
          },
          {
            type: "prerequisite",
            panels: ["Visualizer"],
          },
          {
            type: "action",
            title: "Preview Demo Chase while changing spread.",
            body: "Preview Demo Chase and adjust Start position / Spread. Watch fixtures 310 through 313 move through the steps.",
          },
        ],
      },
      {
        id: "timing",
        title: "Shape the chase rhythm",
        target: '[aria-label="Step FX speed"]',
        content: [
          {
            type: "text",
            text: "Speed changes the pace; step widths change the balance within a cycle.",
          },
          {
            type: "action",
            title: "Adjust Demo Chase’s pace.",
            body: "Adjust Demo Chase’s speed, then try unequal step widths. Stop preview and save the effect.",
          },
        ],
      },
    ],
  },
  {
    id: "timeline",
    title: "Timeline programming",
    duration: "5 min",
    introduction: "Edit when Lo-fi starts the fx3 clip.",
    steps: [
      {
        id: "open",
        title: "Open Lo-fi",
        observe: {
          type: "panel",
          component: "Timeline",
        },
        content: [
          {
            type: "text",
            text: "FX Track contains Exec 5 (fx3); Seq Track starts and advances RGB cycle (full).",
          },
          {
            type: "prerequisite",
            panels: ["TimelinesPanel"],
          },
          {
            type: "action",
            body: "Open timeline 1: Lo-fi from Timelines.",
          },
        ],
      },
      {
        id: "inspect",
        title: "Inspect Exec 5 (fx3)",
        content: [
          {
            type: "text",
            text: "Despite its older label, Exec 5 (fx3) starts clip 6: fx3. Seq Track starts and advances clip 1.",
          },
          {
            type: "prerequisite",
            panels: ["PropertiesInspector"],
          },
          {
            type: "action",
            body: "Select Exec 5 (fx3) and inspect its target and timing in Properties.",
          },
        ],
      },
      {
        id: "timing",
        title: "Move the wave earlier",
        observe: {
          type: "timeline-action-moved",
        },
        content: [
          {
            type: "text",
            text: "An action’s position determines when it happens.",
          },
          {
            type: "prerequisite",
            panels: ["PropertiesInspector"],
          },
          {
            type: "action",
            body: "Move Exec 5 (fx3) from 3.6 seconds to 3 seconds by dragging it or editing its position in Properties.",
          },
        ],
      },
      {
        id: "play",
        title: "Play your arrangement",
        target: '[aria-label="Play timeline"]',
        observe: {
          type: "timeline-playing",
        },
        content: [
          {
            type: "text",
            text: "The red waveform effect will begin 0.6 seconds earlier.",
          },
          {
            type: "prerequisite",
            panels: ["Visualizer"],
          },
          {
            type: "action",
            title: "Start the timeline",
            body: "Press Play timeline and watch the Visualizer.",
          },
        ],
      },
      {
        id: "stop",
        title: "Finish the rehearsal",
        target: '[aria-label="Stop timeline"]',
        observe: {
          type: "timeline-stopped",
        },
        content: [
          {
            type: "text",
            text: "Watch the color changes and earlier red wave, then stop playback.",
          },
          {
            type: "prerequisite",
            panels: ["StatusDisplay"],
          },
          {
            type: "action",
            title: "Stop the timeline",
            body: "Press Stop timeline. Check Status Display and stop any clips you started manually.",
          },
        ],
      },
    ],
  },
];
