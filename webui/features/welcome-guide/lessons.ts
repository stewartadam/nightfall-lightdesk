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
  action: string;
  panels?: PanelComponentName[];
  target?: string;
  hint?: string;
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
      "Take control of the Demo Wash lights, edit two looks, and play them with a fader and Go.",
    steps: [
      {
        id: "open-timeline",
        title: "Open the sample timeline",
        body: "Nightfall Demo starts the Nightfall Looks sequence and Nightfall Wave effect.",
        action:
          "In Timelines, open timeline 1: Nightfall Demo. Keep the 3D Visualizer visible beside it.",
        panels: ["TimelinesPanel", "Visualizer"],
        observe: { type: "panel", component: "Timeline" },
      },
      {
        id: "play-timeline",
        title: "Start the sample show",
        body: "A timeline turns individual looks and effects into a timed show.",
        action:
          "Press Play timeline on Nightfall Demo and watch the six washes in the Visualizer.",
        target: '[aria-label="Play timeline"]',
        hint: "Start Nightfall Demo.",
        observe: { type: "timeline-playing" },
      },
      {
        id: "watch",
        title: "Watch, then stop",
        body: "Nightfall Looks changes the colors; Nightfall Wave animates their intensity.",
        action:
          "Watch for a few seconds, then press Stop timeline before programming your own look.",
        target: '[aria-label="Stop timeline"]',
        hint: "Stop Nightfall Demo when you’re ready.",
        observe: { type: "timeline-stopped" },
      },
      {
        id: "navigate",
        title: "Find your way around",
        body: "The Command Palette opens panels. Properties follows the active panel and selected object.",
        action: "Click Search, type Open Fixtures, and press Enter.",
        target:
          '[data-dialog-kind="command-palette"] input, [aria-label="Open command palette"]',
        hint: "Search for Open Fixtures.",
        observe: { type: "panel", component: "FixtureGrid" },
        more: "Drag panel tabs to arrange the workspace. Open Properties from the same palette to inspect a selected object.",
      },
      {
        id: "select",
        title: "Select lights by number",
        body: "Demo Wash 1 through Demo Wash 6 have fixture IDs 1–6. The > operator selects an inclusive range.",
        action:
          "Enter fix 1>5 and press Enter. The first five lights become selected; Demo Wash 6 does not.",
        panels: ["FixtureGrid", "Visualizer"],
        target: "#header-cmdline",
        hint: "Type fix 1>5 and press Enter.",
        observe: { type: "selection" },
      },
      {
        id: "intensity",
        title: "Bring up the lights",
        body: "The Programmer holds live lighting instructions.",
        action:
          "Enter @ 100 to bring the five selected washes to full intensity.",
        panels: ["ProgrammerGrid"],
        target: "#header-cmdline",
        hint: "Type @ 100 and press Enter.",
        observe: { type: "intensity" },
      },
      {
        id: "red",
        title: "Make a red look",
        body: "These washes mix red, green, and blue to set their color.",
        action:
          "Enter fix 1>5 red @ 100 green @ 0 blue @ 0. Watch the five selected washes turn red.",
        target: "#header-cmdline",
        hint: "Set red to 100, green and blue to 0.",
        observe: { type: "color", color: "Red" },
      },
      {
        id: "cue-one",
        title: "Store the red cue",
        body: "Sequence 1, Nightfall Looks, already contains two cues. We’ll replace its first sample look.",
        action:
          "In Programmer, choose Store cue. Set Sequence ID to 1, Cue ID to 1, and Label to Guide Red. Confirm Store Cue, accepting replacement if prompted.",
        panels: ["ProgrammerGrid"],
        target: '[aria-label="Store cue"]',
        hint: "Store Guide Red as cue 1.1.",
        observe: { type: "cue", id: 1, label: "Guide Red" },
      },
      {
        id: "blue",
        title: "Make a blue look",
        body: "A contrasting second look makes the Go button’s effect easy to see.",
        action:
          "Enter fix 1>5 red @ 0 green @ 0 blue @ 100. Watch the same five washes turn blue.",
        target: "#header-cmdline",
        hint: "Set blue to 100, red and green to 0.",
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
        observe: { type: "cue", id: 2, label: "Guide Blue" },
      },
      {
        id: "clear",
        title: "Release the Programmer",
        body: "Stored cues and live Programmer values are separate. Clear the live instructions so playback can take over.",
        action:
          "Press Clear programmer twice: once to clear selection, then again to release values.",
        panels: ["ProgrammerGrid"],
        target: '[aria-label="Clear programmer"]',
        hint: "Clear selection, then values.",
        observe: { type: "clear" },
        more: "Setting intensity to zero leaves a live instruction. Clearing allows stored cues to control the lights.",
      },
      {
        id: "assign",
        title: "Put Nightfall Looks on control 1",
        body: "Clip 1 already points to sequence 1. A control slot gives it a fader and a Go button.",
        action:
          "Open Clips and drag clip 1: Nightfall Looks onto control 1’s Drop target. Expand Controls first if collapsed.",
        panels: ["ClipList"],
        target: '[data-clip-dropzone-index="1"]',
        hint: "Drop Nightfall Looks on control 1.",
        observe: { type: "assigned", clipId: 1, control: 1 },
      },
      {
        id: "go",
        title: "Start Nightfall Looks",
        body: "Go starts the sequence at its first cue: Guide Red.",
        action:
          "Raise control 1’s fader, then press its Go button. The five washes show your red look.",
        panels: ["Visualizer", "ClipList"],
        target: '[data-control-go-index="1"]:not(:disabled)',
        hint: "Press Go on control 1.",
        observe: { type: "clip-playing", clipId: 1 },
      },
      {
        id: "advance",
        title: "Advance to blue",
        body: "The next Go advances the running sequence to Guide Blue.",
        action:
          "Press Go on control 1 again and watch the washes change from red to blue.",
        target: '[data-control-go-index="1"]:not(:disabled)',
        hint: "Press Go again for Guide Blue.",
        observe: { type: "cue-playing", clipId: 1, position: 2 },
      },
      {
        id: "fader",
        title: "Control the level",
        body: "The fader scales intensity while keeping the programmed color.",
        action:
          "Move control 1’s fader down and up. Watch the blue washes dim and brighten. Continue when you’ve tried a few levels.",
        target:
          '[data-control-index="1"] .noUi-target:not([disabled]) [role="slider"]',
        hint: "Try a few levels on control 1.",
      },
      {
        id: "stop",
        title: "Stop your clip",
        body: "Lowering a fader is different from stopping playback.",
        action:
          "Enter clip 1 stop, or right-click Nightfall Looks and choose Stop Clip.",
        target: "#header-cmdline",
        hint: "Type clip 1 stop.",
        observe: { type: "clip-stopped", clipId: 1 },
      },
    ],
  },
  {
    id: "patch",
    title: "Patching fixtures",
    duration: "4 min",
    introduction:
      "Explore how the six Aurora Wash fixtures describe the demo rig.",
    steps: [
      {
        id: "open",
        title: "Open the sample patch",
        body: "All six demo washes use the same model and mode.",
        action: "Open Patch and find Demo Wash 1, fixture ID 1.",
        panels: ["PatchEditor"],
        observe: { type: "panel", component: "PatchEditor" },
      },
      {
        id: "inspect",
        title: "Inspect Demo Wash 1",
        body: "RGB + Position supplies intensity, red, green, blue, pan, and tilt.",
        action:
          "Inspect Demo Wash 1’s manufacturer, model, and mode. Compare it with Demo Wash 2.",
        panels: ["PatchEditor"],
      },
      {
        id: "address",
        title: "Understand the unassigned patch",
        body: "The sample has no DMX bindings. The washes can still run in the Visualizer; a physical rig also needs channel addresses and output routing.",
        action:
          "Switch Patch to DMX I/O and inspect the empty list. Fixture ID 1 is a selection number, not DMX address 1.",
        panels: ["PatchEditor"],
        more: "A universe contains 512 channels. In the real app, Add fixture walks through a library definition, mode, quantity, and console DMX address. This virtual sample does not need that setup.",
      },
      {
        id: "verify",
        title: "Select the patched fixture",
        body: "Selection uses the fixture ID regardless of whether a hardware route exists.",
        action:
          "Enter fix 1, then inspect Demo Wash 1 in Programmer and the Visualizer.",
        panels: ["ProgrammerGrid", "Visualizer"],
        target: "#header-cmdline",
        hint: "Type fix 1 and inspect Demo Wash 1.",
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
        body: "A binding maps attributes to channels; a transport carries those channels to hardware. The sample has target definitions but no fixture bindings.",
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
        body: "The Visualizer does not require a transport. The browser demo cannot send network or USB DMX.",
        action:
          "Open Console DMX and compare it with the unbound sample patch. There is no hardware route to test. Return to the creative lessons to work with the virtual washes.",
        panels: ["DmxUniverse", "PatchEditor"],
      },
    ],
  },
  {
    id: "waveform",
    title: "Waveform effects",
    duration: "5 min",
    introduction:
      "Play and reshape Nightfall Wave, the sample’s intensity effect.",
    steps: [
      {
        id: "play",
        title: "Start Nightfall Wave",
        body: "Clip 2 already plays the intensity wave across all six washes.",
        action: "Enter clip 2 start and watch the Visualizer.",
        panels: ["Visualizer"],
        target: "#header-cmdline",
        hint: "Type clip 2 start.",
        observe: { type: "clip-playing", clipId: 2 },
      },
      {
        id: "open",
        title: "Open Nightfall Wave",
        body: "This effect repeats a sine wave with different phases across the six lights.",
        action:
          "In FX List, select 1: Nightfall Wave and choose Edit selected effect.",
        panels: ["FxList"],
        target: '[aria-label="Edit selected effect"]:not(:disabled)',
        hint: "Edit Nightfall Wave.",
        observe: { type: "panel", component: "FxEditor" },
      },
      {
        id: "shape",
        title: "Explore the intensity wave",
        body: "Nightfall Wave uses Intensity, a four-second cycle, and a full cycle of phase spread.",
        action:
          "Change its cycle rate and phase range, save, and compare how the six washes move through the pattern.",
        panels: ["Visualizer"],
        more: "Try a slower cycle, then reduce the phase range to bring the lights closer together in the pattern.",
      },
      {
        id: "stop",
        title: "Stop Nightfall Wave",
        body: "Release the effect before trying another lesson.",
        action:
          "Enter clip 2 stop. If you also started an editor preview, stop that preview too.",
        target: "#header-cmdline",
        hint: "Type clip 2 stop.",
        observe: { type: "clip-stopped", clipId: 2 },
      },
    ],
  },
  {
    id: "step-fx",
    title: "Step FX designer",
    duration: "7 min",
    introduction: "Build a two-step intensity chase for the six demo washes.",
    steps: [
      {
        id: "create",
        title: "Open the Step FX designer",
        body: "Step FX describes a repeating pattern as explicit values and durations.",
        action: "In FX List, choose Add effect → Step FX to open a new effect.",
        panels: ["FxList"],
        target: '[aria-label="Add effect"]',
        hint: "Choose Step FX.",
        observe: { type: "panel", component: "StepFxEditor" },
      },
      {
        id: "selection",
        title: "Use the six demo washes",
        body: "The selection tells the chase which lights participate.",
        action:
          "Label the effect Demo Chase. Set Selection to fix 1>6 and choose the Intensity lane.",
        target: '[aria-label="Step FX attributes"]',
        hint: "Choose Intensity for the washes.",
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
        title: "Spread across the washes",
        body: "Different start positions make the lights alternate instead of flashing together.",
        action:
          "Preview Demo Chase and adjust Start position / Spread. Watch Demo Wash 1 through Demo Wash 6 move through the steps.",
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
    introduction: "Edit when Nightfall Demo starts the Nightfall Wave clip.",
    steps: [
      {
        id: "open",
        title: "Open Nightfall Demo",
        body: "Looks and Effects contains Start Looks, Sunrise Look, and Intensity Wave.",
        action: "Open timeline 1: Nightfall Demo from Timelines.",
        panels: ["TimelinesPanel"],
        observe: { type: "panel", component: "Timeline" },
      },
      {
        id: "inspect",
        title: "Inspect Intensity Wave",
        body: "Intensity Wave starts clip 2. Start Looks starts clip 1, and Sunrise Look advances its sequence.",
        action:
          "Select Intensity Wave and inspect its target and timing in Properties.",
        panels: ["PropertiesInspector"],
      },
      {
        id: "timing",
        title: "Move the wave earlier",
        body: "An action’s position determines when it happens.",
        action:
          "Move Intensity Wave from 2.5 seconds to 2 seconds by dragging it or editing its position in Properties.",
        panels: ["PropertiesInspector"],
        observe: { type: "timeline-action-moved" },
      },
      {
        id: "play",
        title: "Play your arrangement",
        body: "The intensity effect will begin half a second earlier.",
        action: "Press Play timeline and watch the Visualizer.",
        panels: ["Visualizer"],
        target: '[aria-label="Play timeline"]',
        hint: "Play the edited Nightfall Demo.",
        observe: { type: "timeline-playing" },
      },
      {
        id: "stop",
        title: "Finish the rehearsal",
        body: "Watch the color changes and earlier wave, then stop playback.",
        action:
          "Press Stop timeline. Check Status Display and stop any clips you started manually.",
        panels: ["StatusDisplay"],
        target: '[aria-label="Stop timeline"]',
        hint: "Stop Nightfall Demo.",
        observe: { type: "timeline-stopped" },
      },
    ],
  },
];
