// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PanelComponentName } from "../../lib/panel-definitions";
import type { GuideObservation } from "./progress";

export interface GuideStep {
  id: string;
  title: string;
  body: string;
  context?: string;
  action: string;
  panels?: PanelComponentName[];
  sampleTimeline?: boolean;
  highlightClipId?: number;
  target?: string;
  hint?: string;
  command?: string;
  focusTarget?: boolean;
  more?: string;
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
    id: "welcome",
    title: "Your first lights",
    duration: "8–10 min",
    introduction:
      "Take control of the pixel strips, edit two looks, and play them with a fader and Go.",
    steps: [
      {
        id: "open-timeline",
        title: "Open the sample timeline",
        body: "Lo-fi starts the RGB cycle (full) clip and the red waveform effect fx3.",
        action:
          "Open Timeline 1: Lo-Fi and keep the 3D Visualizer open beside it.",
        sampleTimeline: true,
        panels: ["Visualizer"],
        observe: { type: "sample-panels" },
      },
      {
        id: "play-timeline",
        title: "Start the sample show",
        body: "A timeline turns individual looks and effects into a timed show.",
        action:
          "Press Play timeline on Lo-fi and watch the pixel strips in the Visualizer.",
        target: '[aria-label="Play timeline"]',
        hint: "Start the timeline",
        observe: { type: "timeline-playing" },
      },
      {
        id: "watch",
        title: "Watch, then stop",
        body: "RGB cycle (full) advances through colors; fx3 varies the red channel across the pixel strips.",
        action:
          "Watch for a few seconds, then press Stop timeline before programming your own look.",
        target: '[aria-label="Stop timeline"]',
        hint: "Stop the timeline",
        observe: { type: "timeline-stopped" },
      },
      {
        id: "navigate-palette",
        title: "Find your way around",
        body: "The Command Palette opens panels or dialogs.",
        action: "Click here or press {command-palette-shortcut} to open it.",
        target:
          '[data-dialog-kind="command-palette"] input, [aria-label="Open command palette"]',
        observe: { type: "command-palette" },
      },
      {
        id: "navigate-programmer",
        title: "Open the Programmer",
        body: "You can use the Command Palette to open new panels.",
        action: "Search for 'Programmer' and press Enter.",
        target:
          '[data-dialog-kind="command-palette"] input, [aria-label="Open command palette"]',
        observe: { type: "panel", component: "ProgrammerGrid" },
      },
      {
        id: "select",
        title: "Select lights by number",
        body: "The sample’s pixel strips include fixtures 310–313. The > operator selects an inclusive range.",
        action:
          "Enter the command below and press Enter. Look for the four selected pixel strips in the Programmer.",
        panels: ["ProgrammerGrid", "Visualizer"],
        target: "#header-cmdline",
        hint: "Type this command, then press Enter:",
        command: "fix 310>313",
        focusTarget: true,
        observe: { type: "selection" },
      },
      {
        id: "intensity",
        title: "Bring up the lights",
        body: "The Programmer holds live lighting instructions.",
        context:
          "The @ command sets the selected strips’ intensity. At 100, they reach full brightness.",
        action:
          "Check the values in the Programmer and watch the Visualizer after entering the command.",
        panels: ["ProgrammerGrid"],
        target: "#header-cmdline",
        hint: "Type this command, then press Enter:",
        command: "@ 100",
        observe: { type: "intensity" },
      },
      {
        id: "red",
        title: "Make a red look",
        body: "These pixel strips mix red, green, and blue to set their color. Full red with green and blue at zero produces a red look.",
        action:
          "Enter the command below. Watch the four selected pixel strips turn red.",
        target: "#header-cmdline",
        hint: "Type this command, then press Enter:",
        command: "red @ 100 green @ 0 blue @ 0",
        observe: { type: "color", color: "Red" },
      },
      {
        id: "cue-one",
        title: "Store the red cue",
        body: "Sequence 1 (abs 255) contains four cues and is played by clip 1: RGB cycle (full). We’ll replace its first two looks.",
        action:
          "In Programmer, choose Store cue. Set Sequence ID to 1, Cue ID to 1, and Label to Guide Red. Confirm Store Cue, accepting replacement if prompted.",
        panels: ["ProgrammerGrid"],
        target: '[aria-label="Store cue"]',
        hint: "Store Guide Red as cue 1.1.",
        observe: { type: "cue", sequenceId: 1, id: 1 },
      },
      {
        id: "blue",
        title: "Make a blue look",
        body: "A contrasting second look makes the Go button’s effect easy to see. Full blue with red and green at zero produces a blue look.",
        action:
          "Enter the command below. Watch the same four pixel strips turn blue.",
        target: "#header-cmdline",
        hint: "Type this command, then press Enter:",
        command: "red @ 0 green @ 0 blue @ 100",
        observe: { type: "color", color: "Blue" },
      },
      {
        id: "cue-two",
        title: "Store the blue cue",
        body: "The sample cues use Manual triggers, so Go advances them.",
        action:
          "Choose Store cue again. Set Sequence ID to 1, Cue ID to 2, and Label to Guide Blue, then confirm Store Cue.",
        panels: ["ProgrammerGrid"],
        target: '[aria-label="Store cue"]',
        hint: "Store Guide Blue as cue 1.2.",
        observe: { type: "cue", sequenceId: 1, id: 2 },
      },
      {
        id: "clear",
        title: "Release the Programmer",
        body: "Stored cues and live Programmer values are separate. Clear the live instructions so playback can take over.",
        action:
          "Press Clear programmer twice: once to clear selection, then again to release values.",
        panels: ["ProgrammerGrid"],
        target: '[aria-label="Clear programmer"]',
        hint: "Click twice to clear the programmer",
        observe: { type: "clear" },
        more: "Setting intensity to zero leaves a live instruction. Clearing allows stored cues to control the lights.",
      },
      {
        id: "assign",
        title: "Put RGB cycle (full) on control 6",
        body: "Clip 1 already points to sequence 1. A control slot gives it a fader and a Go button.",
        action:
          "Open Clips and drag clip 1: RGB cycle (full) onto control 6’s Drop target. Expand Controls first if collapsed.",
        panels: ["ClipList"],
        target: '[data-clip-dropzone-index="6"]',
        highlightClipId: 1,
        hint: "Drop RGB cycle (full) on control 6.",
        observe: { type: "assigned", clipId: 1, control: 6 },
      },
      {
        id: "go",
        title: "Start RGB cycle (full)",
        body: "Go starts the sequence at its first cue: Guide Red. The four pixel strips will show your red look.",
        action: "Raise control 6’s fader, then press its Go button.",
        panels: ["Visualizer", "ClipList"],
        target: '[data-control-go-index="6"]:not(:disabled)',
        hint: "Press Go on control 6.",
        observe: { type: "clip-playing", clipId: 1 },
      },
      {
        id: "advance",
        title: "Advance to blue",
        body: "The next Go advances the running sequence to Guide Blue.",
        action:
          "Press Go on control 6 again and watch the pixel strips change from red to blue.",
        target: '[data-control-go-index="6"]:not(:disabled)',
        hint: "Press Go again for Guide Blue.",
        observe: { type: "cue-playing", clipId: 1, position: 2 },
      },
      {
        id: "fader",
        title: "Control the level",
        body: "The fader scales intensity while keeping the programmed color.",
        action:
          "Move control 6’s fader down and up. Watch the blue pixel strips dim and brighten. Continue when you’ve tried a few levels.",
        target:
          '[data-control-index="6"] .noUi-target:not([disabled]) [role="slider"]',
        hint: "Try a few levels on control 6.",
      },
      {
        id: "stop",
        title: "Stop your clip",
        body: "Lowering a fader is different from stopping playback.",
        action:
          "Enter clip 1 stop, or right-click RGB cycle (full) and choose Stop Clip.",
        target: "#header-cmdline",
        hint: "Type this command, then press Enter:",
        command: "clip 1 stop",
        observe: { type: "clip-stopped", clipId: 1 },
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
        body: "All four pixel strips use the same model and mode.",
        action:
          "Open Patch and find pixel strip 310, model RGBPixelTape 120ch RGB.",
        panels: ["PatchEditor"],
        observe: { type: "panel", component: "PatchEditor" },
      },
      {
        id: "inspect",
        title: "Inspect pixel strip 310",
        body: "RGB mode supplies 40 RGB pixels, with virtual intensity for dimming.",
        action:
          "Inspect pixel strip 310’s manufacturer, model, and mode. Compare it with pixel strip 311.",
        panels: ["PatchEditor"],
      },
      {
        id: "address",
        title: "Understand the disabled patch",
        body: "The sample has disabled output bindings. The fixtures still run in the Visualizer; physical output needs enabled bindings and transport routing. Fixture ID 310 is a selection number, not a DMX address.",
        action: "Switch Patch to DMX I/O and inspect the disabled bindings.",
        panels: ["PatchEditor"],
        more: "A universe contains 512 channels. In the real app, Add fixture walks through a library definition, mode, quantity, and console DMX address. This virtual sample does not need that setup.",
      },
      {
        id: "verify",
        title: "Select the patched fixture",
        body: "Selection uses the fixture ID regardless of whether a hardware route exists.",
        action:
          "Enter fix 310, then inspect pixel strip 310 in Programmer and the Visualizer.",
        panels: ["ProgrammerGrid", "Visualizer"],
        target: "#header-cmdline",
        hint: "Select pixel strip 310:",
        command: "fix 310",
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
        body: "A binding maps attributes to channels; a transport carries those channels to hardware. The sample’s fixture output bindings are disabled.",
        action:
          "Open I/O Transports and locate the network and USB output sections.",
        panels: ["IoTransports"],
        observe: { type: "panel", component: "IoTransports" },
      },
      {
        id: "configure",
        title: "Inspect the sample targets",
        body: "sacn uses sACN multicast, artnet uses Art-Net broadcast, and udmx names the default USB device.",
        action:
          "Inspect those three targets. Leave their settings unchanged for this walkthrough.",
        panels: ["IoTransports"],
        more: "On a physical rig, configure your interface and map console universes to targets. The receiver must use the same universe and protocol.",
      },
      {
        id: "test",
        title: "Separate output from visualization",
        body: "The Visualizer does not require a transport. The browser demo cannot send network or USB DMX, so there is no hardware route to test.",
        action:
          "Compare Console DMX with the disabled sample patch. Return to the creative lessons to work with the virtual fixtures.",
        panels: ["DmxUniverse", "PatchEditor"],
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
        body: "Clip 6 already plays the red-channel wave across all pixel strips.",
        action:
          "Stop Lo-fi and any running clips, clear the Programmer, then enter clip 6 start and watch the Visualizer.",
        panels: ["Visualizer"],
        target: "#header-cmdline",
        hint: "Type this command, then press Enter:",
        command: "clip 6 start",
        observe: { type: "clip-playing", clipId: 6 },
      },
      {
        id: "open",
        title: "Open fx3",
        body: "This effect repeats a sine wave with different phases across the pixel strips.",
        action: "In FX List, select 3: fx3 and choose Edit selected effect.",
        panels: ["FxList"],
        target: '[aria-label="Edit selected effect"]:not(:disabled)',
        hint: "Edit fx3.",
        observe: { type: "panel", component: "FxEditor" },
      },
      {
        id: "shape",
        title: "Explore the red wave",
        body: "fx3 uses Red, a four-second cycle, and a full cycle of phase spread.",
        action:
          "Change its cycle rate and phase range, save, and compare how the pixel strips move through the pattern.",
        panels: ["Visualizer"],
        more: "Try a slower cycle, then reduce the phase range to bring the lights closer together in the pattern.",
      },
      {
        id: "stop",
        title: "Stop fx3",
        body: "Release the effect before trying another lesson.",
        action:
          "Enter clip 6 stop. If you also started an editor preview, stop that preview too.",
        target: "#header-cmdline",
        hint: "Type this command, then press Enter:",
        command: "clip 6 stop",
        observe: { type: "clip-stopped", clipId: 6 },
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
        body: "Step FX describes a repeating pattern as explicit values and durations.",
        action:
          "Stop Lo-fi and any running clips, then clear the Programmer. Enter fix 310>313 red @ 100 green @ 0 blue @ 0 to give the chase a red base. In FX List, choose Add effect → Step FX.",
        panels: ["FxList"],
        target: '[aria-label="Add effect"]',
        hint: "Choose Step FX.",
        observe: { type: "panel", component: "StepFxEditor" },
      },
      {
        id: "selection",
        title: "Use the four pixel strips",
        body: "The selection tells the chase which lights participate.",
        action:
          "Label the effect Demo Chase. Set Selection to fix 310>313 and choose the Intensity lane.",
        target: '[aria-label="Step FX attributes"]',
        hint: "Choose Intensity for the pixel strips.",
      },
      {
        id: "steps",
        title: "Make an on/off pattern",
        body: "An absolute intensity track supplies brightness values directly.",
        action:
          "Use the absolute track. Set the first step to full intensity and add a second step at zero. Give both equal widths.",
        target: '[aria-label="Add step"]',
        hint: "Add the off step after the on step.",
        more: "Equal widths give on and off equal time. Relative contributions modify another value; absolute intensity is easier to see for this chase.",
      },
      {
        id: "spread",
        title: "Spread across the pixel strips",
        body: "Different start positions make the lights alternate instead of flashing together.",
        action:
          "Preview Demo Chase and adjust Start position / Spread. Watch fixtures 310 through 313 move through the steps.",
        panels: ["Visualizer"],
        target: '[aria-label="Preview"], [aria-label="Stop preview"]',
        hint: "Preview Demo Chase while changing spread.",
      },
      {
        id: "timing",
        title: "Shape the chase rhythm",
        body: "Speed changes the pace; step widths change the balance within a cycle.",
        action:
          "Adjust Demo Chase’s speed, then try unequal step widths. Stop preview and save the effect.",
        target: '[aria-label="Step FX speed"]',
        hint: "Adjust Demo Chase’s pace.",
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
        body: "FX Track contains Exec 5 (fx3); Seq Track starts and advances RGB cycle (full).",
        action: "Open timeline 1: Lo-fi from Timelines.",
        panels: ["TimelinesPanel"],
        observe: { type: "panel", component: "Timeline" },
      },
      {
        id: "inspect",
        title: "Inspect Exec 5 (fx3)",
        body: "Despite its older label, Exec 5 (fx3) starts clip 6: fx3. Seq Track starts and advances clip 1.",
        action:
          "Select Exec 5 (fx3) and inspect its target and timing in Properties.",
        panels: ["PropertiesInspector"],
      },
      {
        id: "timing",
        title: "Move the wave earlier",
        body: "An action’s position determines when it happens.",
        action:
          "Move Exec 5 (fx3) from 3.6 seconds to 3 seconds by dragging it or editing its position in Properties.",
        panels: ["PropertiesInspector"],
        observe: { type: "timeline-action-moved" },
      },
      {
        id: "play",
        title: "Play your arrangement",
        body: "The red waveform effect will begin 0.6 seconds earlier.",
        action: "Press Play timeline and watch the Visualizer.",
        panels: ["Visualizer"],
        target: '[aria-label="Play timeline"]',
        hint: "Start the timeline",
        observe: { type: "timeline-playing" },
      },
      {
        id: "stop",
        title: "Finish the rehearsal",
        body: "Watch the color changes and earlier red wave, then stop playback.",
        action:
          "Press Stop timeline. Check Status Display and stop any clips you started manually.",
        panels: ["StatusDisplay"],
        target: '[aria-label="Stop timeline"]',
        hint: "Stop the timeline",
        observe: { type: "timeline-stopped" },
      },
    ],
  },
];
